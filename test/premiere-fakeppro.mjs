// A small fake of the `premierepro` UXP object model, plus a fake panel ctx, shared by the command-module tests
// and the e2e dry run (premiere-e2e-fakepanel.mjs).
// It enforces the documented transaction rules: create*Action only inside lockedAccess (ctx.transaction), and a
// synchronous transaction callback. Actions are applied in order when the transaction commits.
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
export const time = require("../src/premiere-uxp/lib/time.js");
export const commands = require("../src/premiere-uxp/commands/index.js");
export const TPS = 254016000000n;
// Live (Premiere 26.5.2): a project item with no in/out marks reports -400000 s for both.
export const UNSET = -400000n * TPS;

export function cmd(name) {
  const c = commands.find((m) => m.name === name);
  if (!c) throw new Error("no command " + name);
  return c;
}

const Constants = {
  MediaType: { ANY: "any", DATA: "data", VIDEO: "video", AUDIO: "audio" },
  TrackItemType: { EMPTY: 0, CLIP: 1, TRANSITION: 2, PREVIEW: 3, FEEDBACK: 4 },
  VideoDisplayFormatType: { FPS_23_976: 100, FPS_25: 101, FPS_29_97: 102, FPS_29_97_NON_DROP: 103, FRAMES: 104 },
  ExportType: { QUEUE_TO_AME: "ame", QUEUE_TO_APP: "app", IMMEDIATELY: "now" },
  MarkerColor: { GREEN: 0, RED: 1, MAGNETA: 2, MAGENTA: 2, ORANGE: 3, YELLOW: 4, BLUE: 6, CYAN: 7 },
  TransitionPosition: { START: 0, END: 1 },
};

export function makeFake(opts = {}) {
  const state = { inLock: false, log: [], idSeq: 1 };
  const log = (s) => state.log.push(s);

  function action(kind, apply, info) {
    if (!state.inLock) throw new Error(`${kind} action created outside lockedAccess`);
    return { __action: true, kind, apply, info };
  }
  const tt = (t) => ({ ticks: String(t), ticksNumber: Number(t), seconds: Number(t) / Number(TPS) });
  const T = (x) => BigInt(x.ticks);

  class Item {
    constructor(name, type, o = {}) {
      this.name = name;
      this.type = type; // 1 clip, 2 bin, 3 root
      this.id = String(o.id || "i" + state.idSeq++);
      this.children = [];
      this.mediaPath = o.mediaPath || null;
      // mediaT: the media duration. inT/outT: the project item marks, UNSET unless given (as live).
      this.mediaT = o.mediaT ?? (o.fps ? BigInt(o.frames ?? 100) * (TPS * BigInt(o.fpsDen ?? 1)) / BigInt(o.fpsNum ?? o.fps) : 0n);
      this.inT = o.inT ?? UNSET;
      this.outT = o.outT ?? UNSET;
      this.fps = o.fps ?? null;
      this.hasAudio = o.hasAudio ?? true;
      this.hasVideo = o.hasVideo ?? true;
      this.seq = o.seq || null;
      this.parent = null;
      this.markers = null;
      this.canChange = o.canChange ?? true;
    }
    getId() { return this.id; }
    async getItems() { return this.children.slice(); }
    add(child) { child.parent = this; this.children.push(child); return child; }
    getParentBin() { return this.parent; }
    createBinAction(name, makeUnique) { return action("createBin", () => this.add(new Item(name, 2)), { name, makeUnique }); }
    createMoveItemAction(item, newParent) {
      return action("moveItem", () => {
        item.parent.children = item.parent.children.filter((c) => c !== item);
        newParent.add(item);
      });
    }
    createSetNameAction(n) { return action("setName", () => (this.name = n), { name: n }); }
    async isSequence() { return !!this.seq; }
    async getSequence() { return this.seq; }
    async getMediaFilePath() { return this.mediaPath; }
    async getInPoint(mt) { if (mt === "video" && !this.hasVideo) throw new Error("no video"); return tt(this.inT); }
    async getOutPoint(mt) { if (mt === "video" && !this.hasVideo) throw new Error("no video"); return tt(this.outT); }
    createSetInOutPointsAction(i, o) { return action("setItemInOut", () => { this.inT = T(i); this.outT = T(o); }, { item: this.name, in: T(i), out: T(o) }); }
    async getFootageInterpretation() { const f = this.fps; return { getFrameRate: () => f || 0 }; }
    async getMedia() { const d = this.mediaT; return { getDuration: () => tt(d) }; }
    marked() { return this.inT >= 0n && this.outT > this.inT; }
    async isOffline() { return false; }
    async canChangeMediaPath() { return this.canChange; }
    async changeMediaFilePath(p) { log("changeMediaFilePath"); this.mediaPath = p; if (opts.relinkResetsTrims) { this.inT = UNSET; this.outT = UNSET; } return true; }
  }

  class TrackItem {
    constructor(o) { Object.assign(this, { disabled: false, speed: 1, reversed: false, transitions: [] }, o); this.chain = this.chain || makeChain(); }
    async getStartTime() { return tt(this.start); }
    async getEndTime() { return tt(this.end); }
    async getInPoint() { return tt(this.inT); }
    async getOutPoint() { return tt(this.outT); }
    async getName() { return this.projectItem.name; }
    async getProjectItem() { return this.projectItem; }
    async getSpeed() { return this.speed; }
    async isSpeedReversed() { return this.reversed ? 1 : 0; }
    async isDisabled() { return this.disabled; }
    async getComponentChain() { return this.chain; }
    // Live semantics (Premiere 26.5.2): these are edge trims. setIn/setStart move the head (start and in move
    // together), setOut/setEnd move the tail (end and out move together). A move is a relative shift. Premiere
    // refuses to create a move whose result would start before 0 ("Invalid parameter."), judged against the item
    // as it is when the action is created, and silently skips one that would land before 0 when it runs.
    createMoveAction(t) {
      const d = T(t);
      if (!state.inLock) throw new Error("move action created outside lockedAccess");
      if (this.start + d < 0n) throw new Error("Invalid parameter.");
      return action("move", () => { if (this.start + d >= 0n) { this.start += d; this.end += d; } }, { delta: d, media: this.kind });
    }
    createSetStartAction(t) { return action("setStart", () => { const d = T(t) - this.start; this.start += d; this.inT += d; }, { t: T(t), media: this.kind }); }
    createSetEndAction(t) { return action("setEnd", () => { const d = T(t) - this.end; this.end += d; this.outT += d; }, { t: T(t), media: this.kind }); }
    createSetInPointAction(t) { return action("setIn", () => { const d = T(t) - this.inT; this.start += d; this.inT += d; }, { t: T(t), media: this.kind }); }
    createSetOutPointAction(t) { return action("setOut", () => { const d = T(t) - this.outT; this.end += d; this.outT += d; }, { t: T(t), media: this.kind }); }
    createSetDisabledAction(d) { return action("setDisabled", () => (this.disabled = d), { d }); }
    createAddVideoTransitionAction(tr, o) {
      if (this.kind !== "video") throw new Error("video only");
      return action("addTransition", () => this.transitions.push({ tr, o }), { matchName: tr.matchName, applyToStart: o.applyToStart, duration: T(o.duration) });
    }
  }

  function makeChain() {
    const kfs = [];
    const level = {
      displayName: "Level",
      varying: false,
      value: 0.1778,
      kfs,
      isTimeVarying() { return this.varying; },
      async getValueAtTime() { return this.value; },
      createKeyframe(v) { return { value: v, position: null }; },
      createSetTimeVaryingAction(b) { return action("setTimeVarying", () => { level.varying = b; if (!b) kfs.length = 0; }, { b }); },
      createAddKeyframeAction(k) { return action("addKeyframe", () => kfs.push(k), { value: k.value, at: T(k.position) }); },
      createSetValueAction(k) { return action("setValue", () => (level.value = k.value), { value: k.value }); },
    };
    const comps = [
      { async getDisplayName() { return "Volume"; }, async getMatchName() { return "audio volume"; }, getParamCount: () => 2, getParam: (i) => (i === 0 ? { displayName: "Bypass" } : level) },
    ];
    return { level, getComponentCount: () => comps.length, getComponentAtIndex: (i) => comps[i] };
  }

  class Track {
    constructor(kind, name) { this.kind = kind; this.name = name; this.items = []; }
    // Live: only CLIP items come back as objects; the TRANSITION/EMPTY/... lists hold nulls.
    getTrackItems(type) { return type === 1 ? this.items.slice() : [null]; }
    async isMuted() { return false; }
  }

  class Sequence {
    constructor(name, o = {}) {
      this.name = name;
      this.guid = { toString: () => o.guid || "guid-" + name };
      this.tpf = o.tpf || "10584000000";
      this.displayType = o.displayType ?? Constants.VideoDisplayFormatType.FRAMES;
      this.video = [new Track("video", "Video 1")];
      this.audio = [new Track("audio", "Audio 1")];
      this.projectItem = null;
      this.markers = null;
      this.width = 1920;
      this.height = 1080;
    }
    async getTimebase() { return this.tpf; }
    async getSettings() { const t = this.displayType; return { getVideoDisplayFormat: async () => ({ type: t }) }; }
    async getFrameSize() { return { width: this.width, height: this.height }; }
    async getVideoTrackCount() { return this.video.length; }
    async getAudioTrackCount() { return this.audio.length; }
    async getVideoTrack(i) { return this.video[i]; }
    async getAudioTrack(i) { return this.audio[i]; }
    async getEndTime() { let e = 0n; for (const tr of [...this.video, ...this.audio]) for (const it of tr.items) if (it.end > e) e = it.end; return tt(e); }
    async getProjectItem() { return this.projectItem; }
    track(kind, i) {
      const arr = kind === "video" ? this.video : this.audio;
      while (arr.length <= i) arr.push(new Track(kind, `${kind} ${arr.length + 1}`));
      return arr[i];
    }
  }

  // Live: an overwrite/insert places the project item full length, or between its marks when it has them. Marks
  // set by an earlier action in the same compound do NOT apply (modelled: they are read when the action is created).
  function placeSpan(pi) {
    return pi.marked() ? [pi.inT, pi.outT] : [0n, pi.mediaT];
  }
  function place(seq, pi, t, v, a, span) {
    const [i, o] = span;
    const start = T(t);
    if (pi.hasVideo) seq.track("video", v).items.push(new TrackItem({ kind: "video", start, end: start + (o - i), inT: i, outT: o, projectItem: pi }));
    if (pi.hasAudio && a >= 0) seq.track("audio", a).items.push(new TrackItem({ kind: "audio", start, end: start + (o - i), inT: i, outT: o, projectItem: pi }));
  }
  function insertAt(seq, pi, t, v, a, span) {
    const d = span[1] - span[0];
    for (const tr of [...seq.video, ...seq.audio]) for (const it of tr.items) if (it.start >= T(t)) { it.start += d; it.end += d; }
    place(seq, pi, t, v, a, span);
  }

  const root = new Item("root", 3);
  class Project {
    constructor(path) {
      this.path = path;
      this.name = path.split(/[\\/]/).pop();
      this.guid = { toString: () => "pguid-" + this.name };
      this.root = root;
      this.sequences = [];
    }
    async getRootItem() { return this.root; }
    async getSequences() { return this.sequences.slice(); }
    async importFiles(paths, suppress, bin, numbered) {
      log(`importFiles:${paths.length}:${suppress}`);
      for (const p of paths) bin.add(new Item(p.split(/[\\/]/).pop(), 1, { mediaPath: p, fps: 24 }));
      return true;
    }
    // Dynamic Link import of After Effects comps (Project.importAEComps / importAllAEComps, Promise<boolean>).
    async importAEComps(aep, names, bin) {
      log(`importAEComps:${aep}:${names.join("|")}`);
      if (opts.aeImport === false) return false;
      if (opts.aeImport !== "nothing") for (const n of names) bin.add(new Item(n, 1, { mediaPath: aep, fps: 24 }));
      return true;
    }
    async importAllAEComps(aep, bin) {
      log(`importAllAEComps:${aep}`);
      if (opts.aeImport === false) return false;
      if (opts.aeImport !== "nothing") for (const n of ["Main Comp", "Lower Third"]) bin.add(new Item(n, 1, { mediaPath: aep, fps: 24 }));
      return true;
    }
    addSequence(name, o = {}, bin = this.root) {
      const s = new Sequence(name, o);
      const it = new Item(name, 1, { seq: s, hasAudio: false });
      s.projectItem = it;
      bin.add(it);
      this.sequences.push(s);
      return s;
    }
    async createSequence(name, preset) { log(`createSequence:${preset ?? ""}`); return this.addSequence(name); }
    async createSequenceWithPresetPath(name, preset) { log(`createSequenceWithPresetPath:${preset}`); return this.addSequence(name); }
    async createSequenceFromMedia(name, clips, bin) { log(`createSequenceFromMedia:${clips.length}`); return this.addSequence(name, {}, bin); }
    async save() { log("save"); return opts.saveOk ?? true; }
    async saveAs(p) { log("saveAs:" + p); this.path = p; return true; }
  }
  const project = new Project(opts.projectPath || "D:\\Projects\\MyFilm\\edit\\Edit.prproj");

  const ppro = {
    Constants,
    TickTime: { createWithTicks: (s) => tt(BigInt(s)) },
    FolderItem: { cast: (x) => x },
    ClipProjectItem: { cast: (x) => x },
    ProjectItem: { cast: (x) => x },
    Project: {
      createProject: async (p) => { log("createProject:" + p); return new Project(p); },
      open: async (p, o) => { log("open:" + p); ppro.lastOpenOptions = o; return new Project(p); },
      getActiveProject: async () => project,
    },
    ProjectUtils: { getProjectViewIds: async () => ["v1"], getProjectFromViewId: async () => project },
    OpenProjectOptions: class {
      setShowConvertProjectDialog(b) { this.convert = b; return this; }
      setShowLocateFileDialog(b) { this.locate = b; return this; }
      setShowWarningDialog(b) { this.warning = b; return this; }
      setAddToMRUList(b) { this.mru = b; return this; }
    },
    SequenceEditor: {
      getEditor: (seq) => ({
        createOverwriteItemAction: (pi, t, v, a) => { const span = placeSpan(pi); return action("overwrite", () => place(seq, pi, t, v, a, span), { item: pi.name, at: T(t), v, a }); },
        createInsertProjectItemAction: (pi, t, v, a, ls) => { const span = placeSpan(pi); return action("insert", () => insertAt(seq, pi, t, v, a, span), { item: pi.name, at: T(t), v, a }); },
        createRemoveItemsAction: (sel, ripple, mt, shift) =>
          action("remove", () => {
            for (const tr of [...seq.video, ...seq.audio]) tr.items = tr.items.filter((x) => !sel.items.includes(x));
          }, { count: sel.items.length, ripple, mt }),
      }),
    },
    TrackItemSelection: {
      createEmptySelection(cb) { const sel = { items: [], addItem(x) { this.items.push(x); return true; } }; cb(sel); return true; },
    },
    Markers: {
      getMarkers: async (owner) => {
        if (!owner.markers) {
          const list = [];
          owner.markers = {
            list,
            createAddMarkerAction: (name, type, start, dur, comments) =>
              action("addMarker", () => list.push({ name, type, start: T(start), dur: T(dur), comments, color: null, getName: () => name, getStart: () => start, createSetColorByIndexAction(c) { const m = this; return action("markerColor", () => (m.color = c), { c }); } }), { name, type, start: T(start) }),
            getMarkers: () => list.slice(),
          };
        }
        return owner.markers;
      },
    },
    TransitionFactory: {
      getVideoTransitionMatchNames: async () => ["ADBE Cross Dissolve New", "ADBE Dip To Black", "ADBE Film Dissolve", "ADBE Push"],
      createVideoTransition: (m) => { if (!state.inLock) throw new Error("transition outside lock"); return { matchName: m }; },
    },
    AddTransitionOptions: class {
      setApplyToStart(b) { this.applyToStart = b; return this; }
      setDuration(t) { this.duration = t; return this; }
      setForceSingleSided(b) { this.forceSingleSided = b; return this; }
      setTransitionAlignment(n) { this.alignment = n; return this; }
    },
    EncoderManager: {
      getManager: () => ({
        isAMEInstalled: opts.ame ?? true,
        exportSequence: async (seq, type, out, preset, full) => { log(`exportSequence:${type}:${out}:${full}`); return true; },
      }),
      getExportFileExtension: async () => "mp4",
    },
    Exporter: {
      exportSequenceFrame: async (seq, t, name, dir, w, h) => { log(`exportFrame:${name}:${dir}:${T(t)}:${w}x${h}`); return true; },
    },
  };

  return { ppro, project, root, state, log, Item, Sequence, Track, TrackItem, tt };
}

export const FOLDER = "D:\\Projects\\MyFilm\\edit";

export function makeCtx(fake, o = {}) {
  const files = new Set((o.files || []).map((f) => f.toLowerCase()));
  const txns = [];
  const ctx = {
    ppro: fake.ppro,
    project: o.targetless ? null : fake.project,
    projectPath: fake.project.path,
    folder: FOLDER,
    time,
    log() {},
    txns,
    targets: [],
    undoSteps: 0, // what core reports as undoSteps: committed transactions plus noteUndoStep() calls
    noteUndoStep() { ctx.undoSteps++; },
    fail(code, message, extra) { return Object.assign(new Error(message), { code, extra }); },
    assertWritable(p) {
      fake.log("assertWritable:" + p);
      if (!p.toLowerCase().replace(/\//g, "\\").startsWith(FOLDER.toLowerCase() + "\\")) throw ctx.fail("OUTSIDE_FOLDER", "outside " + p);
    },
    isDefaultRoot(p) { return p.toLowerCase().startsWith("d:\\projects\\"); },
    async setTargetProject(p) { ctx.targets.push(p.path); },
    async pathExists(p) { return files.has(p.toLowerCase()); },
    async openProjects() { return [{ path: fake.project.path, name: fake.project.name, project: fake.project }]; },
    async transaction(name, fn) {
      const compound = { actions: [], addAction(a) { if (!a || !a.__action) throw new Error("not an action"); this.actions.push(a); return true; } };
      fake.state.inLock = true;
      let r;
      try { r = fn(compound); } finally { fake.state.inLock = false; }
      if (r && typeof r.then === "function") throw new Error("transaction callback must be synchronous");
      for (const a of compound.actions) a.apply();
      txns.push({ name, actions: compound.actions.map((a) => ({ kind: a.kind, ...a.info })) });
      ctx.undoSteps++;
      return true;
    },
  };
  return ctx;
}

export async function rejects(p, code) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

// Standard project: Renders/v003/SH010_v003 (24 fps, 100 frames), Renders/v003/SH020_v003, Music/song (audio only),
// sequence "Edit" (24 fps) in Sequences.
export function standardProject(o = {}) {
  const fake = makeFake(o);
  const { root, Item } = fake;
  const renders = root.add(new Item("Renders", 2));
  const v3 = renders.add(new Item("v003", 2));
  const sh10 = v3.add(new Item("SH010_v003", 1, { id: "sh10", mediaPath: "D:\\Projects\\MyFilm\\shots\\SH010\\SH010_v003.mov", fps: 24, frames: 100 }));
  const sh20 = v3.add(new Item("SH020_v003", 1, { id: "sh20", mediaPath: "D:\\Projects\\MyFilm\\shots\\SH020\\SH020_v003.mov", fps: 24, frames: 48 }));
  const music = root.add(new Item("Music", 2));
  const song = music.add(new Item("song", 1, { id: "song", mediaPath: "D:\\Audio\\song.wav", hasVideo: false, mediaT: TPS * 60n }));
  const seqBin = root.add(new Item("Sequences", 2));
  const seq = fake.project.addSequence("Edit", {}, seqBin);
  return Object.assign(fake, { sh10, sh20, song, seq, renders, v3, seqBin });
}

