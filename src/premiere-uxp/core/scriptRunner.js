"use strict";
// runScript / runScriptFile (spec section 6, bridge-protocol "runScriptFile" steps). Order:
// NO_FOLDER / FOLDER_MISSING -> (file: OUTSIDE_FOLDER / FILE_NOT_FOUND) -> BLOCKED_CALL scan -> archive
// -> save + rolling backup (SAVE_FAILED stops) -> compile (SYNTAX_ERROR) -> run as an async body with
// guarded ppro/fs/require -> audit -> run-log line. A watchdog logs "possible-modal" after 60 s.
const { isInside, scanCode, normalize } = require("../lib/pathPolicy.js");
const {
  archiveStamp, safeScriptName, cleanString, mcpError, refusal, baseName, joinPath, resolveInFolder, toJsonSafe, samePath,
  projectPathOf,
} = require("./util.js");
const { scriptsDir, saveAndBackup } = require("./backup.js");
const { createGuards } = require("./guards.js");
const { runTransaction } = require("./transaction.js");

const PARAMS = ["ppro", "project", "sandbox", "fs", "require", "time"];
const WATCHDOG_MS = 60000;

function compile(code) {
  return new Function(...PARAMS, "return (async () => {\n" + code + "\n})();");
}

function stackLine(e) {
  const m = e && typeof e.stack === "string" ? /<anonymous>:(\d+):\d+/.exec(e.stack) : null;
  return m ? parseInt(m[1], 10) : null;
}

// How many lines the engine reports above the script's own first line, measured once at runtime.
let lineOffsetPromise = null;
function lineOffset() {
  if (!lineOffsetPromise) {
    lineOffsetPromise = (async () => {
      try {
        await compile("throw new Error('line probe');")();
      } catch (e) {
        const l = stackLine(e);
        return l === null ? null : l - 1;
      }
      return null;
    })();
  }
  return lineOffsetPromise;
}

async function scriptErrorLine(e) {
  const l = stackLine(e);
  const off = await lineOffset();
  if (l === null || off === null) return null;
  return Math.max(1, l - off);
}

function runLogLine(name, outcome, durationMs, message, nowMs) {
  return new Date(nowMs).toISOString() + "\t" + name + "\t" + outcome + "\t" + durationMs + "\t" +
    String(message || "").replace(/[\t\r\n]+/g, " ") + "\n";
}

async function appendRunLog(env, folder, line) {
  try {
    await env.fsx.mkdirp(scriptsDir(folder));
    await env.fsx.appendText(joinPath(scriptsDir(folder), "run-log.txt"), line);
  } catch (e) {
    if (env.log) env.log("Could not write run-log: " + e);
  }
}

// env: { fsx, rawFs, ppro, uxp, os, project, folder, settings, registry, now, clock, log, loadTime }
async function runScriptCommand(env, command, args) {
  const { fsx, project, folder, now } = env;
  args = args || {};
  if (!folder) {
    return refusal("NO_FOLDER", "No writable folder is set for this project. Ask the user to choose one with Browse... in the MCP Bridge panel in Premiere.");
  }
  if (!(await fsx.isDir(folder))) {
    return refusal("FOLDER_MISSING", "The writable folder no longer exists: " + folder + ". Ask the user to choose it again in the MCP Bridge panel.");
  }

  let code;
  let name;
  let archivedAs = null;
  if (command === "runScriptFile") {
    if (!args.file || typeof args.file !== "string") return { status: "error", code: "BAD_ARGS", message: "runScriptFile needs a 'file' argument." };
    const scriptPath = resolveInFolder(folder, args.file);
    if (!isInside(scriptPath, folder)) {
      return refusal("OUTSIDE_FOLDER", "Script file is outside the writable folder (" + folder + "): " + scriptPath);
    }
    if (!(await fsx.isFile(scriptPath))) return { status: "error", code: "FILE_NOT_FOUND", message: "Script file not found: " + scriptPath };
    try {
      code = await fsx.readText(scriptPath);
    } catch (e) {
      return { status: "error", code: "FILE_NOT_FOUND", message: "Could not read script file: " + scriptPath };
    }
    name = safeScriptName(baseName(scriptPath).replace(/\.(jsx?|mjs|cjs)$/i, ""));
  } else {
    if (typeof args.code !== "string") return { status: "error", code: "BAD_ARGS", message: "runScript needs a 'code' string argument." };
    code = args.code;
    name = safeScriptName(args.name);
  }

  const blockedReason = scanCode(code);
  if (blockedReason) return refusal("BLOCKED_CALL", "Blocked: " + blockedReason + ".");

  if (command === "runScript") {
    try {
      await fsx.mkdirp(scriptsDir(folder));
      archivedAs = joinPath(scriptsDir(folder), archiveStamp(new Date(now())) + "_" + name + ".js");
      await fsx.writeText(archivedAs, code);
    } catch (e) {
      return { status: "error", code: "ARCHIVE_FAILED", message: "Could not write archive file: " + archivedAs };
    }
  }

  let backup;
  try {
    backup = await saveAndBackup({ project, folder, fsx, now, log: env.log });
  } catch (e) {
    const r = { status: "error", code: e.mcpCode || "SAVE_FAILED", message: cleanString(e.message), line: null };
    if (archivedAs) r.archivedAs = archivedAs;
    return r;
  }

  const startPath = projectPathOf(project);
  const counters = { undoSteps: 0 };
  const logs = [];
  const guards = createGuards({
    ppro: env.ppro,
    rawFs: env.rawFs,
    uxp: env.uxp,
    os: env.os,
    getFolder: () => folder,
    getProjectPath: () => projectPathOf(project),
    isDefaultRoot: (p) => env.settings.isDefaultRoot(p),
    onSaveAs: (savedProject, path) => afterSaveAs(savedProject, path),
    onTransaction: () => { counters.undoSteps++; },
  });

  function afterSaveAs(savedProject, requestedPath) {
    const newPath = projectPathOf(savedProject) || requestedPath;
    env.settings.inheritFolder(newPath, folder);
    if (env.registry && savedProject) env.registry.remember(savedProject);
  }

  function checkInside(p, what) {
    return guards.checkWrite(p, what);
  }

  const sandbox = Object.freeze({
    folder,
    path: (rel) => resolveInFolder(folder, rel),
    async saveAs(p, overwrite) {
      const abs = resolveInFolder(folder, p);
      checkInside(abs, "save as");
      if (!overwrite && !samePath(abs, projectPathOf(project)) && (await fsx.exists(abs))) {
        throw mcpError("FILE_EXISTS", "File already exists: " + abs + " (pass overwrite=true)");
      }
      const ok = await project.saveAs(abs);
      if (ok === false) throw new Error("Project.saveAs returned false for " + abs);
      afterSaveAs(project, abs);
      return projectPathOf(project) || abs;
    },
    // fn(compound, project) runs synchronously inside lockedAccess + executeTransaction; no awaits.
    transaction(undoName, fn) {
      const { value } = runTransaction(project, undoName || name,
        (compound) => guards.membrane.unwrap(fn)(compound, project), counters);
      return guards.membrane.wrap(value);
    },
    // export(sequence, output, preset, { mode: "direct" | "queue-ame", full = true })
    async export(sequence, output, preset, opts) {
      opts = opts || {};
      const abs = resolveInFolder(folder, output);
      checkInside(abs, "export output");
      const ppro = env.ppro;
      const types = (ppro.Constants && ppro.Constants.ExportType) || {};
      const type = opts.mode === "queue-ame" ? types.QUEUE_TO_AME : types.IMMEDIATELY;
      const manager = ppro.EncoderManager.getManager();
      const ok = await manager.exportSequence(guards.membrane.unwrap(sequence), type, abs, preset, opts.full !== false);
      return { ok: ok !== false, output: abs };
    },
    log(msg) {
      const s = cleanString(msg);
      logs.push(s);
      if (env.log) env.log("[script " + name + "] " + s);
    },
  });

  let timeModule;
  try {
    timeModule = env.loadTime ? env.loadTime() : undefined;
  } catch (e) {
    timeModule = undefined;
  }

  let fn = null;
  let runError = null;
  let returnValue;
  const startMs = now();
  try {
    fn = compile(code);
  } catch (syntaxError) {
    runError = syntaxError;
  }

  if (fn) {
    const clock = env.clock || {};
    let watchdog = null;
    if (clock.setTimeout) {
      watchdog = clock.setTimeout(() => {
        appendRunLog(env, folder, runLogLine(name, "possible-modal", WATCHDOG_MS,
          "still running after " + WATCHDOG_MS / 1000 + " s; a Premiere dialog may be waiting", now()));
        if (env.log) env.log("Script " + name + " still running after 60 s: a Premiere dialog may be waiting.");
      }, WATCHDOG_MS);
    }
    try {
      returnValue = await fn(guards.wrappedPpro, guards.membrane.wrap(project), sandbox, guards.guardedFs,
        guards.guardedRequire, timeModule);
    } catch (e) {
      runError = e;
    } finally {
      if (watchdog !== null && clock.clearTimeout) clock.clearTimeout(watchdog);
    }
  }
  const durationMs = now() - startMs;

  const violations = [];
  const endPath = projectPathOf(project);
  if (endPath && normalize(endPath) !== normalize(startPath) && !isInside(endPath, folder)) {
    violations.push("Project file moved outside the writable folder: " + endPath);
  }

  let result;
  if (runError) {
    const isError = runError instanceof Error;
    const message = cleanString(isError ? runError.toString() : String(runError));
    result = { status: "error", message, line: fn && isError ? await scriptErrorLine(runError) : null };
    if (!fn) result.code = "SYNTAX_ERROR";
    else result.code = isError && runError.mcpCode ? runError.mcpCode : "SCRIPT_ERROR";
    if (archivedAs) result.archivedAs = archivedAs;
    if (violations.length) result.sandboxViolations = violations;
    await appendRunLog(env, folder, runLogLine(name, "error", durationMs, message, now()));
  } else {
    result = {
      status: "success",
      returnValue: toJsonSafe(returnValue, 0),
      durationMs,
      archivedAs,
      sandboxViolations: violations,
    };
    await appendRunLog(env, folder, runLogLine(name, "success", durationMs, violations.join("; "), now()));
  }
  result.durationMs = durationMs;
  result.undoSteps = counters.undoSteps;
  result.backupPath = backup.backupPath;
  if (backup.backupWarning) result.backupWarning = backup.backupWarning;
  if (logs.length) result.logs = logs;
  return result;
}

module.exports = { runScriptCommand, compile, WATCHDOG_MS };
