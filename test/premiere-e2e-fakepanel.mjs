// An in-process fake Premiere panel for the e2e dry run (premiere-e2e-dryrun.test.mjs): the REAL panel core
// (src/premiere-uxp/core/bridge.js) and the real typed commands, polling a temp bridge dir, over the fake
// premierepro model from premiere-fakeppro.mjs extended to several open projects.
//
// What the extension adds to the fake model, to behave like Premiere 26.5.2 did in the capability spike:
//   - several projects (create, open, close, active), each with its own bin tree and a \\?\ long-path `path`;
//   - Project.lockedAccess / executeTransaction applying actions in order; save/saveAs write the .prproj;
//   - imported media gets a frame rate from its file name (29.97, 23.976, audio-only .wav);
//   - createSequenceFromMedia places the clips (as Premiere does); placements land on the sequence's frame grid;
//   - track-item in/out actions are edge trims (setIn moves the head, setOut the tail);
//   - removing with MediaType.ANY takes the linked partner; ripple closes the gap;
//   - transitions are listed by getTrackItems(TRANSITION); frame export writes the file;
//   - ProjectSettings scratch disks and ProjectConverter for the guarded-ppro checks.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { makeFake, TPS } from "./premiere-fakeppro.mjs";
import { makeStorage } from "./premiere-core-fakes.mjs";

const require = createRequire(import.meta.url);
const { createBridge } = require("../src/premiere-uxp/core/bridge.js");
const realCommands = require("../src/premiere-uxp/commands/index.js");
const { normalize } = require("../src/premiere-uxp/lib/pathPolicy.js");

const longPath = (p) => (process.platform === "win32" && !p.startsWith("\\\\?\\") ? "\\\\?\\" + p : p);
const T = (x) => BigInt(x.ticks);

function mediaInfo(file) {
  const name = path.basename(file).toLowerCase();
  if (name.endsWith(".wav")) return { mediaPath: file, hasVideo: false, hasAudio: true, outT: TPS * 6n };
  if (name.includes("23976")) return { mediaPath: file, fps: 23.976, fpsNum: 24000, fpsDen: 1001, frames: 96 };
  return { mediaPath: file, fps: 29.97, fpsNum: 30000, fpsDen: 1001, frames: 119 };
}

/**
 * startFakePanel({ bridgeDir, tempDir, userProjectPath, harness = true, failCommands = [], tickMs = 10 })
 * Returns { bridge, ppro, storage, user, openProjects(), isOpen(p), logs, undoMarker(seq, name), stop() }.
 */
export function startFakePanel(opts) {
  const { bridgeDir, tempDir, userProjectPath } = opts;
  const fake = makeFake({ projectPath: userProjectPath });
  const { ppro, Item, TrackItem, Track } = fake;
  const ProjectClass = fake.project.constructor;
  const open = [];
  const known = new Map();
  let active = null;
  let guidSeq = 0;

  // A .prproj carries its GUID, and Save As copies it (live, 26.5.2): reopening the original next to its copy
  // gives two open projects with one GUID.
  const fileGuids = new Map();
  function initProject(p) {
    p.root = new Item("root", 3);
    p.sequences = [];
    const key = normalize(p.path);
    const g = fileGuids.get(key) || "pg-" + ++guidSeq;
    fileGuids.set(key, g);
    p.guid = { toString: () => g };
    p.transactions = [];
    p.saveCount = 0;
    return p;
  }
  function activate(p) {
    if (!open.includes(p)) open.push(p);
    active = p;
    known.set(normalize(p.path), p);
    return p;
  }

  const user = activate(initProject(fake.project));

  // ---- Project instances ----
  const P = ProjectClass.prototype;
  P.lockedAccess = function (cb) {
    fake.state.inLock = true;
    try {
      cb();
    } finally {
      fake.state.inLock = false;
    }
  };
  P.executeTransaction = function (cb, undoString) {
    if (!fake.state.inLock) throw new Error("executeTransaction outside lockedAccess");
    const actions = [];
    cb({
      addAction(a) {
        if (!a || !a.__action) throw new TypeError("not a host Action");
        actions.push(a);
        return true;
      },
    });
    for (const a of actions) a.apply();
    this.transactions.push({ undoString, kinds: actions.map((a) => a.kind) });
    return true;
  };
  P.save = async function () {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, "fake prproj: " + this.name);
    this.saveCount++;
    return true;
  };
  P.saveAs = async function (p) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "fake prproj copy");
    fileGuids.set(normalize(p), String(this.guid));
    known.delete(normalize(this.path));
    this.path = longPath(p);
    this.name = path.basename(p);
    activate(this);
    return true;
  };
  P.close = async function () {
    const i = open.indexOf(this);
    if (i >= 0) open.splice(i, 1);
    if (active === this) active = open[open.length - 1] || null;
    return true;
  };
  P.importFiles = async function (paths, suppress, bin) {
    for (const p of paths) {
      const info = mediaInfo(p);
      const item = bin.add(new Item(path.basename(p), 1, info));
      item.fpsNum = info.fpsNum;
      item.fpsDen = info.fpsDen;
    }
    return true;
  };
  P.createSequenceFromMedia = async function (name, clips, bin) {
    const first = clips[0];
    const tpf = first && first.fpsNum ? String((TPS * BigInt(first.fpsDen)) / BigInt(first.fpsNum)) : undefined;
    const seq = this.addSequence(name, tpf ? { tpf } : {}, bin || this.root);
    let t = 0n;
    for (const c of clips) {
      const dur = c.outT - c.inT;
      const o = { start: t, end: t + dur, inT: c.inT, outT: c.outT, projectItem: c };
      if (c.hasVideo) seq.track("video", 0).items.push(new TrackItem({ kind: "video", ...o }));
      if (c.hasAudio) seq.track("audio", 0).items.push(new TrackItem({ kind: "audio", ...o }));
      t += dur;
    }
    return seq;
  };

  // ---- ppro statics ----
  ppro.Project = {
    async getActiveProject() {
      return active;
    },
    getProject(guid) {
      return open.find((p) => String(p.guid) === String(guid)) || null;
    },
    async open(p) {
      let proj = known.get(normalize(p));
      if (proj && open.includes(proj)) return activate(proj);
      if (!proj) {
        if (!fs.existsSync(p)) throw new Error("No project file at " + p);
        proj = initProject(new ProjectClass(longPath(p)));
      }
      return activate(proj);
    },
    async createProject(p) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "new fake prproj");
      return activate(initProject(new ProjectClass(longPath(p))));
    },
  };
  ppro.ProjectUtils = {
    async getProjectViewIds() {
      return open.map((p) => ({ view: p }));
    },
    async getProjectFromViewId(id) {
      return id.view;
    },
  };
  ppro.CloseProjectOptions = class {
    setPromptIfDirty(v) { this.promptIfDirty = v; return this; }
    setShowCancelButton() { return this; }
  };
  ppro.Constants = {
    ...ppro.Constants,
    ScratchDiskFolderType: { VIDEO_PREVIEW: 1, AUDIO_PREVIEW: 2, AUTO_SAVE: 3 },
    ScratchDiskFolder: { SAME_AS_PROJECT: "SameAsProject", MY_DOCUMENTS: "MyDocuments" },
  };
  const scratch = new WeakMap();
  ppro.ProjectSettings = {
    async getScratchDiskSettings(project) {
      let v = scratch.get(project);
      if (!v) {
        v = { 1: "SameAsProject", 2: "SameAsProject", 3: "SameAsProject" };
        scratch.set(project, v);
      }
      return {
        getScratchDiskPath: (t) => v[t],
        setScratchDiskPath: (t, value) => { v[t] = value; return true; },
      };
    },
  };
  ppro.ProjectConverter = {
    async exportAsOpenTimelineIO(seq, out) {
      fs.writeFileSync(out, "otio");
      return true;
    },
  };
  ppro.Exporter = {
    async exportSequenceFrame(seq, time, name, dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), "fake png");
      return true;
    },
  };

  // ---- editing behaviour ----
  const origEditor = ppro.SequenceEditor.getEditor;
  ppro.SequenceEditor = {
    getEditor(seq) {
      const ed = origEditor(seq);
      const tracks = () => [...seq.video, ...seq.audio];
      const snapToFrames = (a) => {
        const inner = a.apply;
        a.apply = () => {
          inner();
          const tpf = BigInt(seq.tpf);
          for (const tr of tracks()) {
            for (const x of tr.items) {
              const frames = (x.end - x.start + tpf / 2n) / tpf;
              x.end = x.start + frames * tpf;
            }
          }
        };
        return a;
      };
      const overwrite = ed.createOverwriteItemAction;
      const insert = ed.createInsertProjectItemAction;
      ed.createOverwriteItemAction = (...args) => snapToFrames(overwrite(...args));
      ed.createInsertProjectItemAction = (...args) => snapToFrames(insert(...args));
      const remove = ed.createRemoveItemsAction;
      ed.createRemoveItemsAction = (sel, ripple, mt, shift) => {
        const a = remove(sel, ripple, mt, shift);
        a.apply = () => {
          const victims = new Set(sel.items);
          if (mt === ppro.Constants.MediaType.ANY) {
            for (const ti of sel.items) {
              for (const tr of tracks()) {
                for (const x of tr.items) {
                  if (x.kind !== ti.kind && x.projectItem === ti.projectItem && x.start === ti.start && x.end === ti.end) victims.add(x);
                }
              }
            }
          }
          for (const tr of tracks()) {
            const removed = tr.items.filter((x) => victims.has(x));
            tr.items = tr.items.filter((x) => !victims.has(x));
            if (!ripple) continue;
            for (const r of removed) {
              const d = r.end - r.start;
              for (const x of tr.items) {
                if (x.start >= r.end) {
                  x.start -= d;
                  x.end -= d;
                }
              }
            }
          }
        };
        return a;
      };
      return ed;
    },
  };
  const TI = TrackItem.prototype;
  const setIn = TI.createSetInPointAction;
  const setOut = TI.createSetOutPointAction;
  TI.createSetInPointAction = function (t) {
    const a = setIn.call(this, t);
    a.apply = () => {
      this.start += T(t) - this.inT;
      this.inT = T(t);
    };
    return a;
  };
  TI.createSetOutPointAction = function (t) {
    const a = setOut.call(this, t);
    a.apply = () => {
      this.end += T(t) - this.outT;
      this.outT = T(t);
    };
    return a;
  };
  const getTrackItems = Track.prototype.getTrackItems;
  Track.prototype.getTrackItems = function (type, inc) {
    if (type !== ppro.Constants.TrackItemType.TRANSITION) return getTrackItems.call(this, type, inc);
    const out = [];
    for (const it of this.items) {
      for (const { tr, o } of it.transitions || []) {
        const d = T(o.duration);
        const start = o.applyToStart ? it.start : it.end - d;
        out.push({
          getName: async () => "Cross Dissolve",
          getMatchName: async () => tr.matchName,
          getStartTime: async () => fake.tt(start),
          getEndTime: async () => fake.tt(start + d),
        });
      }
    }
    return out;
  };

  // Like UXP's premierepro module on 26.5.2: the module is frozen and its classes' statics are locked, so a
  // membrane that proxies the real objects hands them back raw (the createProject / exportSequence breach).
  for (const k of ["Project", "EncoderManager", "Exporter", "ProjectConverter", "ProjectSettings"]) if (ppro[k]) Object.freeze(ppro[k]);
  Object.freeze(ppro);

  // ---- the bridge ----
  const failing = new Set(opts.failCommands || []);
  const commands = realCommands.map((m) => (failing.has(m.name) ? { ...m, precheck: undefined, run: async () => { throw new Error("injected failure (dry run)"); } } : m));
  const tickMs = opts.tickMs || 10;
  const unref = (h) => {
    if (h && typeof h.unref === "function") h.unref();
    return h;
  };
  const clock = {
    now: () => Date.now(),
    setInterval: (f) => unref(setInterval(f, tickMs)),
    clearInterval: (h) => clearInterval(h),
    setTimeout: (f, ms) => unref(setTimeout(f, ms)),
    clearTimeout: (h) => clearTimeout(h),
  };
  const storage = makeStorage();
  const logs = [];
  const bridge = createBridge({
    fs: fsp,
    ppro,
    storage,
    clock,
    bridgeDir,
    tempDir,
    commands,
    uxp: { host: { version: "26.5.2" }, storage: { types: {} } },
    os: { platform: () => "win32" },
    hostVersion: "26.5.2",
    log: (m) => logs.push(m),
  });
  bridge.setHarness(opts.harness !== false);
  bridge.start();

  return {
    bridge,
    ppro,
    storage,
    user,
    logs,
    openProjects: () => open.slice(),
    isOpen: (p) => open.some((x) => normalize(x.path) === normalize(p)),
    // Simulates the user's Ctrl+Z for the interactive Undo case: drops the named marker from the sequence.
    undoMarker(seqName, markerName) {
      for (const p of open) {
        for (const s of p.sequences) {
          if (s.name !== seqName || !s.markers) continue;
          const i = s.markers.list.findIndex((m) => m.name === markerName);
          if (i >= 0) s.markers.list.splice(i, 1);
        }
      }
    },
    stop: () => bridge.stop(),
  };
}
