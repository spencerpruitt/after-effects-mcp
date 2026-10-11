"use strict";
// Runtime guards for run-script (spec section 6). Best-effort, like the AE guards: determined code
// in a fullAccess plugin can get around them. The static scan, targeting and pre-run backup matter more.
//
// - guarded fs: reads pass through; every write/rename/unlink/mkdir/copy target must be inside the folder.
// - guarded require: premierepro (wrapped), fs (guarded), uxp (host/versions/storage constants only), os.
// - wrapped premierepro: a membrane. Every object or function reached through it is a Proxy; proxies
//   passed back into Premiere are unwrapped, so native calls get real host objects. Calls that write to
//   an output path are checked by method name before they run, whether the method is a static
//   (ppro.Project.createProject) or reached through an instance (EncoderManager.getManager().exportSequence).
const { normalize, isInside } = require("../lib/pathPolicy.js");
const { mcpError, joinPath, toWindowsPath } = require("./util.js");

function isObj(v) {
  return v !== null && (typeof v === "object" || typeof v === "function");
}

// Built-ins with internal slots break when proxied; they carry no Premiere state, so pass them raw.
function hasInternalSlots(v) {
  return v instanceof Promise || v instanceof Date || v instanceof Map || v instanceof Set ||
    v instanceof WeakMap || v instanceof WeakSet || v instanceof RegExp || v instanceof Error ||
    v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

// The proxy's own target is a blank "shadow", never the host object. Premiere's premierepro module exposes its
// classes, and their statics, as non-writable non-configurable properties. A Proxy over the real object must
// return such a property's exact value (a Proxy invariant), so ppro.Project.createProject and
// ppro.EncoderManager came back raw and unguarded (live e2e on 26.5.2: a script created a project outside the
// folder). Invariants are checked against the shadow, which never holds locked properties, so every value can
// be wrapped. A bound function is callable and constructible and has no non-configurable own properties.
function shadowFor(v) {
  if (typeof v === "function") return function () {}.bind(null);
  return Array.isArray(v) ? [] : {};
}

// guards: { [methodName]: { before(rawArgs, rawThis) -> undefined | replacement args, after(result, rawArgs, rawThis) } }.
// fallback(name, rawArgs): runs for methods with no entry in guards (defence in depth for output-like names).
function createMembrane(guards, fallback) {
  const toProxy = new WeakMap();
  const toTarget = new WeakMap();
  const fnNames = new WeakMap();
  const callbacks = new WeakMap();

  function wrap(v) {
    if (!isObj(v)) return v;
    if (toTarget.has(v)) return v;
    if (v instanceof Promise) return v.then(wrap);
    if (hasInternalSlots(v)) return v;
    const cached = toProxy.get(v);
    if (cached) return cached;
    const p = new Proxy(shadowFor(v), makeHandler(v));
    toProxy.set(v, p);
    toTarget.set(p, v);
    return p;
  }

  // Script values going into Premiere: proxies become their targets, arrays are unwrapped element-wise,
  // and script callbacks are wrapped so they receive proxies (e.g. executeTransaction's CompoundAction).
  function unwrap(v) {
    if (!isObj(v)) return v;
    if (toTarget.has(v)) return toTarget.get(v);
    if (Array.isArray(v)) return v.map(unwrap);
    if (typeof v === "function") {
      let cb = callbacks.get(v);
      if (!cb) {
        cb = function () {
          const r = v.apply(wrap(this), Array.from(arguments, wrap));
          return r instanceof Promise ? r.then(unwrap) : unwrap(r);
        };
        callbacks.set(v, cb);
      }
      return cb;
    }
    return v;
  }

  function unwrapThis(t) {
    return isObj(t) && toTarget.has(t) ? toTarget.get(t) : t;
  }

  function wrapDescriptor(d) {
    const out = { enumerable: !!d.enumerable, configurable: true };
    if ("value" in d) {
      out.value = wrap(d.value);
      out.writable = !!d.writable;
    } else {
      out.get = wrap(d.get);
      out.set = wrap(d.set);
    }
    return out;
  }

  function makeHandler(real) {
    return {
      get(shadow, prop) {
        const value = Reflect.get(real, prop, real);
        if (typeof value === "function" && typeof prop === "string" && !fnNames.has(value)) fnNames.set(value, prop);
        return wrap(value);
      },
      set(shadow, prop, v) {
        return Reflect.set(real, prop, unwrap(v), real);
      },
      has(shadow, prop) {
        return Reflect.has(real, prop);
      },
      ownKeys(shadow) {
        const keys = Reflect.ownKeys(real);
        // A shadow array's own `length` is non-configurable, so it must be listed (the real array has it too).
        for (const k of Reflect.ownKeys(shadow)) {
          const d = Reflect.getOwnPropertyDescriptor(shadow, k);
          if (d && !d.configurable && keys.indexOf(k) < 0) keys.push(k);
        }
        return keys;
      },
      getOwnPropertyDescriptor(shadow, prop) {
        const d = Reflect.getOwnPropertyDescriptor(real, prop);
        const sd = Reflect.getOwnPropertyDescriptor(shadow, prop);
        if (sd && !sd.configurable) {
          // Only an array shadow's `length`: report the real value with the shadow's (writable) attributes.
          return { value: d && "value" in d ? d.value : sd.value, writable: sd.writable, enumerable: sd.enumerable, configurable: false };
        }
        return d ? wrapDescriptor(d) : undefined;
      },
      defineProperty(shadow, prop, desc) {
        if (desc.configurable === false) return false;
        const d = Object.assign({}, desc);
        if ("value" in d) d.value = unwrap(d.value);
        return Reflect.defineProperty(real, prop, d);
      },
      deleteProperty(shadow, prop) {
        return Reflect.deleteProperty(real, prop);
      },
      getPrototypeOf() {
        return wrap(Reflect.getPrototypeOf(real));
      },
      setPrototypeOf() {
        return false;
      },
      preventExtensions() {
        return false;
      },
      apply(shadow, thisArg, args) {
        const name = fnNames.get(real) || real.name;
        const rawThis = unwrapThis(thisArg);
        let rawArgs = args.map(unwrap);
        const g = typeof name === "string" && Object.prototype.hasOwnProperty.call(guards, name) ? guards[name] : null;
        if (g && g.before) {
          const replaced = g.before(rawArgs, rawThis);
          if (Array.isArray(replaced)) rawArgs = replaced;
        } else if (!g && fallback) {
          fallback(name, rawArgs);
        }
        let r = Reflect.apply(real, rawThis, rawArgs);
        if (g && g.after) {
          if (r instanceof Promise) r = r.then((v) => { g.after(v, rawArgs, rawThis); return v; });
          else g.after(r, rawArgs, rawThis);
        }
        return wrap(r);
      },
      construct(shadow, args) {
        return wrap(Reflect.construct(real, args.map(unwrap)));
      },
    };
  }

  return { wrap, unwrap, isProxy: (v) => isObj(v) && toTarget.has(v), targetOf: (v) => toTarget.get(v) };
}

// ctx: { ppro, rawFs, uxp, os, getFolder, getProjectPath, isDefaultRoot(path), onSaveAs(rawProject, path), onTransaction() }
function createGuards(ctx) {
  const { ppro } = ctx;

  function checkWrite(p, what) {
    const folder = ctx.getFolder();
    if (!folder) throw mcpError("NO_FOLDER", "Blocked: " + what + ": no writable folder is set for this project.");
    if (typeof p !== "string" || !isInside(p, folder)) {
      throw mcpError("OUTSIDE_FOLDER", "Blocked: " + what + " outside the writable folder (" + folder + "): " + String(p));
    }
    return p;
  }

  function constantValues(group) {
    const C = (ppro && ppro.Constants && ppro.Constants[group]) || {};
    const out = [];
    for (const k of Object.keys(C)) out.push(C[k]);
    return out;
  }

  // A scratch-disk location: a path, or a ScratchDiskFolder constant (getScratchDiskPath reads them back as the
  // strings "SameAsProject" / "MyDocuments" on 26.5.2, so the literal strings count too).
  function checkScratch(value) {
    const C = (ppro && ppro.Constants && ppro.Constants.ScratchDiskFolder) || {};
    const same = (C.SAME_AS_PROJECT !== undefined && value === C.SAME_AS_PROJECT) || value === "SameAsProject";
    const docs = (C.MY_DOCUMENTS !== undefined && value === C.MY_DOCUMENTS) || value === "MyDocuments";
    if (same) {
      checkWrite(ctx.getProjectPath(), "scratch disk 'Same as Project' (the project file is)");
      return;
    }
    if (docs) {
      throw mcpError("OUTSIDE_FOLDER", "Blocked: moving a scratch disk to My Documents is outside the writable folder.");
    }
    checkWrite(typeof value === "string" ? value : String(value), "scratch disk location");
  }

  // ScratchDiskSettings setters: every argument that isn't a ScratchDiskFolderType is a location to check, so the
  // guard holds whatever the argument order (the call shape isn't documented) and whatever the value type.
  function checkScratchArgs(name, args) {
    const types = constantValues("ScratchDiskFolderType");
    const values = args.filter((a) => types.indexOf(a) < 0 && a !== undefined);
    if (values.length === 0) {
      throw mcpError("OUTSIDE_FOLDER", "Blocked: " + name + ": no scratch-disk location the guard can check.");
    }
    for (const v of values) checkScratch(v);
  }

  // Every absolute path among the arguments must be inside the folder (for APIs whose path argument isn't pinned).
  function checkPathArgs(what, args) {
    for (const a of args) {
      if (typeof a === "string" && normalize(a) !== null) checkWrite(a, what);
    }
  }

  const pproGuards = {
    saveAs: {
      before: (a) => { checkWrite(a[0], "Project.saveAs"); },
      after: (r, a, self) => { if (r !== false && ctx.onSaveAs) ctx.onSaveAs(self, a[0]); },
    },
    createProject: {
      before: (a) => {
        checkWrite(a[0], "Project.createProject");
        // Same rule as the typed premiere-create-project: only inside a remembered default root.
        if (!ctx.isDefaultRoot || !ctx.isDefaultRoot(a[0])) {
          throw mcpError("NOT_IN_DEFAULT_ROOT", "Blocked: Project.createProject: new projects can only be created inside a remembered default root (pick one with Browse... in the MCP Bridge panel): " + String(a[0]));
        }
        return [toWindowsPath(a[0])].concat(a.slice(1));
      },
    },
    exportSequence: {
      before: (a) => {
        if (!a[2]) throw mcpError("OUTSIDE_FOLDER", "Blocked: EncoderManager.exportSequence needs an explicit output file inside the writable folder.");
        checkWrite(a[2], "EncoderManager.exportSequence output");
      },
    },
    encodeFile: { before: (a) => { checkWrite(a[1], "EncoderManager.encodeFile output"); } },
    encodeProjectItem: { before: (a) => { checkWrite(a[1], "EncoderManager.encodeProjectItem output"); } },
    exportSequenceFrame: {
      before: (a) => {
        const filename = a[2];
        const dir = a[3];
        if (normalize(filename) !== null) checkWrite(filename, "Exporter.exportSequenceFrame");
        if (dir || normalize(filename) === null) checkWrite(dir, "Exporter.exportSequenceFrame folder");
        if (dir && filename && normalize(filename) === null) checkWrite(joinPath(dir, filename), "Exporter.exportSequenceFrame");
      },
    },
    exportAAF: { before: (a) => { checkWrite(a[1], "ProjectConverter.exportAAF"); } },
    exportAsFinalCutProXML: { before: (a) => { checkWrite(a[1], "ProjectConverter.exportAsFinalCutProXML"); } },
    exportAsOpenTimelineIO: { before: (a) => { checkWrite(a[1], "ProjectConverter.exportAsOpenTimelineIO"); } },
    exportToJSON: { before: (a) => { checkPathArgs("Transcript.exportToJSON", a); } },
    setScratchDiskPath: { before: (a) => { checkScratchArgs("ScratchDiskSettings.setScratchDiskPath", a); } },
    executeTransaction: { after: (r) => { if (r !== false && ctx.onTransaction) ctx.onTransaction(); } },
  };

  // Unlisted methods whose names say they write somewhere (another ProjectConverter.export*, a future encoder or
  // scratch-disk setter): any absolute path among their arguments must be inside the folder.
  function fallback(name, args) {
    if (typeof name !== "string") return;
    if (/^set\w*scratch/i.test(name)) return checkScratchArgs(name, args);
    if (/^(export|encode|saveAs|createProject)/i.test(name)) checkPathArgs(name, args);
  }

  const membrane = createMembrane(pproGuards, fallback);
  const wrappedPpro = membrane.wrap(ppro);

  const rawFs = ctx.rawFs;
  const fsWriteArgs = {
    writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0],
    rename: [0, 1], renameSync: [0, 1], copyFile: [1], copyFileSync: [1],
    unlink: [0], unlinkSync: [0], mkdir: [0], mkdirSync: [0], rmdir: [0], rmdirSync: [0], rm: [0], rmSync: [0],
  };
  const fsPassThrough = ["readFile", "readFileSync", "lstat", "lstatSync", "stat", "statSync", "readdir", "readdirSync",
    "read", "readSync", "write", "writeSync", "close", "closeSync", "exists", "existsSync", "access", "accessSync"];
  // A fixed allow-list: host modules may not enumerate their functions, and anything unlisted is absent.
  const guardedFs = {};
  if (rawFs) {
    for (const name of Object.keys(fsWriteArgs).concat(["open", "openSync"], fsPassThrough)) {
      const fn = rawFs[name];
      if (typeof fn !== "function") continue;
      if (fsWriteArgs[name]) {
        guardedFs[name] = function () {
          for (const i of fsWriteArgs[name]) checkWrite(arguments[i], "fs." + name);
          return fn.apply(rawFs, arguments);
        };
      } else if (name === "open" || name === "openSync") {
        guardedFs[name] = function (p, flag) {
          const f = typeof flag === "string" || typeof flag === "number" ? String(flag) : "r";
          if (/[wa+x]/.test(f) || /^\d+$/.test(f)) checkWrite(p, "fs." + name + "(\"" + f + "\")");
          return fn.apply(rawFs, arguments);
        };
      } else {
        guardedFs[name] = function () { return fn.apply(rawFs, arguments); };
      }
    }
  }
  Object.freeze(guardedFs);

  const uxp = ctx.uxp || {};
  const st = uxp.storage || {};
  const safeUxp = Object.freeze({
    host: uxp.host,
    versions: uxp.versions,
    storage: Object.freeze({ types: st.types, formats: st.formats, domains: st.domains, fileTypes: st.fileTypes }),
  });

  function guardedRequire(name) {
    switch (String(name)) {
      case "premierepro": return wrappedPpro;
      case "fs": return guardedFs;
      case "uxp": return safeUxp;
      case "os": return ctx.os;
      default:
        throw mcpError("BLOCKED_CALL", "Blocked: require('" + String(name) + "') is not available in MCP scripts (allowed: premierepro, fs, uxp, os).");
    }
  }

  return { checkWrite, checkScratch, membrane, wrappedPpro, guardedFs, guardedRequire, safeUxp };
}

// The guarded fs alone, for typed commands (ctx.fs): writes must stay inside the folder.
function createGuardedFs(rawFs, getFolder) {
  return createGuards({ ppro: {}, rawFs, getFolder, getProjectPath: () => "" }).guardedFs;
}

module.exports = { createGuards, createGuardedFs, createMembrane };
