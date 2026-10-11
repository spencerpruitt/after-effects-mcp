// In-memory fakes for the Premiere panel core tests: premierepro, localStorage and clock.
// The file system is a real temp folder through Node's fs.promises, which has the same promise
// shape as UXP's require('fs'); `spyFs` records the calls.
import * as fsp from "fs/promises";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";

export const require = createRequire(import.meta.url);
export const { createBridge } = require("../src/premiere-uxp/core/bridge.js");

let guidCounter = 0;

export function makePpro() {
  const hostProjects = new Set();
  const state = { active: null, open: [], calls: [], viewIdsWork: true };

  class FakeProject {
    constructor(p) {
      this.path = p;
      this.name = path.basename(p);
      const g = "guid-" + ++guidCounter;
      this.guid = { toString: () => g };
      this.saveCount = 0;
      this.saveBehaviour = "ok";
      this.transactions = [];
      this.inLock = false;
      this.rootItems = [];
      hostProjects.add(this);
    }
    async save() {
      this.saveCount++;
      if (this.saveBehaviour === "throw") throw new Error("disk full");
      if (this.saveBehaviour === "false") return false;
      return true;
    }
    async saveAs(p) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "prproj copy");
      this.path = p;
      this.name = path.basename(p);
      return true;
    }
    lockedAccess(cb) {
      this.inLock = true;
      try { cb(); } finally { this.inLock = false; }
    }
    executeTransaction(cb, undoString) {
      if (!this.inLock) throw new Error("executeTransaction outside lockedAccess");
      const actions = [];
      const compound = {
        addAction(a) {
          if (a && typeof a === "object" && !hostActions.has(a)) throw new TypeError("not a host Action");
          actions.push(a);
          return true;
        },
        get empty() { return actions.length === 0; },
      };
      cb(compound);
      this.transactions.push({ undoString, actions });
      return true;
    }
    createRenameAction(n) {
      if (!this.inLock) throw new Error("create*Action outside lockedAccess");
      const a = { isHostAction: true, rename: n };
      hostActions.add(a);
      return a;
    }
    async getRootItem() {
      return makeFolder(this.rootItems);
    }
    async close() {
      state.open = state.open.filter((p) => p !== this);
      if (state.active === this) state.active = state.open[0] || null;
      return true;
    }
  }
  const hostActions = new Set();

  function makeFolder(children) {
    return { isFolder: true, async getItems() { return children; } };
  }

  const ppro = {
    Project: {
      async getActiveProject() { return state.active; },
      getProject(guid) {
        const s = String(guid);
        return state.open.find((p) => String(p.guid) === s) || null;
      },
      async open(p) {
        const proj = new FakeProject(p);
        state.open.push(proj);
        state.active = proj;
        return proj;
      },
      async createProject(p) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "new prproj");
        const proj = new FakeProject(p);
        state.open.push(proj);
        state.active = proj;
        return proj;
      },
    },
    ProjectUtils: {
      async getProjectViewIds() {
        if (!state.viewIdsWork) throw new Error("no views");
        return state.open.map((p) => ({ viewOf: p }));
      },
      async getProjectFromViewId(id) { return id.viewOf; },
    },
    FolderItem: {
      cast(item) { return item && item.isFolder ? item : null; },
    },
    EncoderManager: {
      getManager() {
        return {
          async exportSequence(seq, type, out, preset, full) {
            if (seq && seq.isHostSequence !== true) throw new TypeError("not a host Sequence");
            state.calls.push(["exportSequence", out, type, preset, full]);
            return true;
          },
          async encodeFile(src, out) { state.calls.push(["encodeFile", out]); return true; },
        };
      },
    },
    Exporter: {
      async exportSequenceFrame(seq, time, filename, filepath) { state.calls.push(["frame", filename, filepath]); return true; },
    },
    ProjectConverter: {
      async exportAsOpenTimelineIO(seq, out) { state.calls.push(["otio", out]); return true; },
    },
    Transcript: { async exportToJSON() { return "{}"; } },
    ProjectSettings: {
      async getScratchDiskSettings(project) {
        if (!hostProjects.has(project)) throw new TypeError("not a host Project");
        const values = { 1: "C:\\Previews\\Video", 2: "C:\\Previews\\Audio", 3: "SameAsProject" };
        return {
          getScratchDiskPath(t) { return values[t]; },
          setScratchDiskPath(t, v) { values[t] = v; state.calls.push(["scratch", t, v]); return true; },
        };
      },
    },
    Constants: {
      ScratchDiskFolderType: { VIDEO_PREVIEW: 1, AUDIO_PREVIEW: 2, AUTO_SAVE: 3 },
      ScratchDiskFolder: { SAME_AS_PROJECT: "SameAsProject", MY_DOCUMENTS: "MyDocuments" },
      ExportType: { IMMEDIATELY: 0, QUEUE_TO_AME: 1 },
    },
    OpenProjectOptions: class {
      setShowConvertProjectDialog() { return this; }
      setShowLocateFileDialog() { return this; }
      setShowWarningDialog() { return this; }
      setAddToMRUList() { return this; }
    },
    CloseProjectOptions: class {
      setPromptIfDirty(v) { this.promptIfDirty = v; return this; }
      setShowCancelButton() { return this; }
    },
  };

  // Opens a project at an existing (or new) path and optionally makes it active.
  function openProject(p, { active = true, writeFile = true } = {}) {
    if (writeFile) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, "prproj " + path.basename(p));
    }
    const proj = new FakeProject(p);
    state.open.push(proj);
    if (active || !state.active) state.active = proj;
    return proj;
  }

  return { ppro, state, openProject, hostProjects, hostActions, FakeProject };
}

export function makeStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

export function makeClock(start = Date.parse("2026-10-07T12:00:00.000Z")) {
  const timers = [];
  const clock = {
    t: start,
    now: () => clock.t,
    advance(ms) { clock.t += ms; },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout(fn, ms) { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeout(h) { if (h) h.cleared = true; },
    timers,
  };
  return clock;
}

export function spyFs(target = fsp) {
  const calls = [];
  const spy = {};
  for (const name of ["readFile", "writeFile", "lstat", "rename", "copyFile", "unlink", "mkdir", "readdir", "rmdir", "open"]) {
    spy[name] = (...args) => {
      calls.push([name, ...args.filter((a) => typeof a === "string")]);
      return target[name](...args);
    };
  }
  return { fs: spy, calls };
}

const madeRoots = [];
process.on("exit", () => { for (const r of madeRoots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { /* ignore */ } } });

export function tempRoot(label) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "pr-core-" + label + "-"));
  madeRoots.push(r);
  return r;
}

// A bridge over a fresh temp tree: <root>/bridge, <root>/edit (sandbox) with Edit.prproj open.
export function setup({ commands = [], label = "t", withFolder = true, fsImpl } = {}) {
  const root = tempRoot(label);
  const bridgeDir = path.join(root, "bridge");
  fs.mkdirSync(bridgeDir, { recursive: true });
  const edit = path.join(root, "edit");
  fs.mkdirSync(edit, { recursive: true });
  const fake = makePpro();
  const project = fake.openProject(path.join(edit, "Edit.prproj"));
  const storage = makeStorage();
  const clock = makeClock();
  const logs = [];
  const spied = spyFs();
  const bridge = createBridge({
    fs: fsImpl || spied.fs,
    ppro: fake.ppro,
    storage,
    clock,
    bridgeDir,
    tempDir: root,
    commands,
    uxp: { host: { version: "26.5.2" }, storage: { localFileSystem: { secret: true }, types: {} }, shell: { openPath() {} } },
    os: { platform: () => "win32" },
    hostVersion: "26.5.2",
    log: (m) => logs.push(m),
  });
  if (withFolder) bridge.settings.setFolder(project.path, edit);
  const ctxObj = { root, bridgeDir, edit, fake, project, storage, clock, logs, bridge, spied };
  ctxObj.send = (command, args = {}, extra = {}) => sendCommand(ctxObj, command, args, extra);
  ctxObj.readResult = () => JSON.parse(fs.readFileSync(path.join(bridgeDir, "pr_mcp_result.json"), "utf8"));
  ctxObj.readCommand = () => JSON.parse(fs.readFileSync(path.join(bridgeDir, "pr_command.json"), "utf8"));
  return ctxObj;
}

let idCounter = 0;
export function writeCommand(t, command, args = {}, extra = {}) {
  const id = extra.id || "cmd-" + ++idCounter;
  const data = Object.assign({
    id,
    command,
    args,
    timestamp: new Date(t.clock.now()).toISOString(),
    status: "pending",
    expectedProject: t.project.path,
  }, extra);
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  fs.writeFileSync(path.join(t.bridgeDir, "pr_command.json"), JSON.stringify(data));
  return id;
}

export async function sendCommand(t, command, args, extra) {
  const id = writeCommand(t, command, args, extra);
  const ran = await t.bridge.tick();
  if (!ran) throw new Error("command " + command + " was not processed");
  const r = t.readResult();
  if (r._commandId !== id) throw new Error("result id mismatch");
  return r;
}

export { fs, path, os };
