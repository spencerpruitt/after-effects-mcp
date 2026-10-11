// Tests for the sidecar's ExtendScript host (src/premiere-cep/host/host.jsx). ExtendScript can't run in
// Node, so: (1) the pure ES3 blocks between BEGIN/END markers are evaluated directly, as
// test/pathPolicy.test.mjs does for the AE panel; (2) a lint keeps the file ES3; (3) the whole file runs
// against a small fake of Premiere's DOM and QE DOM to check the call sequence and read-backs. The fake
// models the documented and reported behaviour, not Premiere itself: live verification is still needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostFile = path.join(here, "..", "src", "premiere-cep", "host", "host.jsx");
const source = fs.readFileSync(hostFile, "utf8");

function block(name, global) {
  const m = new RegExp(`// === BEGIN ${name} ===([\\s\\S]*?)// === END ${name} ===`).exec(source);
  if (!m) throw new Error(`${name} markers not found in host.jsx`);
  return new Function(m[1] + `\nreturn ${global};`)();
}

const Paths = block("PATH POLICY", "MCPPathPolicy");
const Pure = block("SIDECAR PURE", "MCPSidecarPure");
const SJSON = block("SIDECAR JSON", "MCPSidecarJSON");

// ---------------- ES3 lint ----------------

test("host.jsx stays ES3", () => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/).map((l) => l.replace(/(^|[^:"'\\])\/\/.*$/, "$1")).join("\n");
  const banned = [
    [/\b(let|const)\s/, "let/const"],
    [/=>/, "arrow function"],
    [/`/, "template literal"],
    [/\.(forEach|map|filter|reduce|some|every|find|includes)\s*\(/, "ES5+ array method"],
    [/\.indexOf\s*\(/, "indexOf (Array.prototype.indexOf is ES5)"],
    [/\.trim\s*\(/, "String.prototype.trim"],
    [/Object\.(keys|assign|create|defineProperty)/, "ES5 Object API"],
    [/Array\.isArray/, "Array.isArray"],
    [/\bJSON\.(parse|stringify)/, "native JSON (Premiere 26 ExtendScript has none)"],
    [/\bclass\s+\w/, "class"],
    [/\.\.\.\w/, "spread"],
  ];
  for (const [re, what] of banned) assert.ok(!re.test(code), `host.jsx uses ${what}: ${(re.exec(code) || [])[0]}`);
});

// ---------------- pure blocks ----------------

test("path policy: \\\\?\\ prefix, UNC prefix, case and separators", () => {
  assert.equal(Paths.normalize("\\\\?\\D:\\Projects\\MyFilm\\Edit.prproj"), "d:/projects/myfilm/edit.prproj");
  assert.equal(Paths.normalize("\\\\?\\UNC\\nas\\share\\E.prproj"), "//nas/share/e.prproj");
  assert.equal(Paths.stripLongPathPrefix("\\\\?\\D:\\x"), "D:\\x");
  assert.ok(Paths.samePath("\\\\?\\D:\\Projects\\Edit.prproj", "d:/PROJECTS/edit.prproj"));
  assert.ok(!Paths.samePath(null, null));
  assert.equal(Paths.normalize("D:\\a\\..\\..\\x"), null);
});

test("JSON polyfill: strict, ASCII-only output that JSON.parse reads back", () => {
  const v = { a: "q\"b\\c\n\u00e9\u2028", n: [1, 2.5, null, true], nan: NaN, skip: undefined, f() {}, nested: { d: [{ e: "x" }] } };
  const s = SJSON.stringify(v);
  assert.ok(/^[\x20-\x7e]*$/.test(s));
  assert.deepEqual(JSON.parse(s), { a: "q\"b\\c\n\u00e9\u2028", n: [1, 2.5, null, true], nan: null, nested: { d: [{ e: "x" }] } });
});

test("parseTrackRef, splitItemPath, nameKey", () => {
  assert.deepEqual(Pure.parseTrackRef("a2"), { type: "audio", index0: 1, label: "A2" });
  assert.deepEqual(Pure.parseTrackRef(" V1 "), { type: "video", index0: 0, label: "V1" });
  for (const bad of ["V0", "X1", "", null, 3]) assert.equal(Pure.parseTrackRef(bad), null, String(bad));
  assert.deepEqual(Pure.splitItemPath(" Edits / Main\\Cut "), ["Edits", "Main", "Cut"]);
  assert.equal(Pure.nameKey("  Main CUT "), "main cut");
});

test("orderByStart: by start ticks, ties keep DOM order (index matches UXP getSequence)", () => {
  const entries = [{ start: 300 }, { start: 100 }, { start: 200 }, { start: 100 }];
  assert.deepEqual(Pure.orderByStart(entries), [1, 3, 2, 0]);
  assert.deepEqual(Pure.orderByStart([]), []);
});

test("nominalFps and framesToTimecode (QE addTransition duration form)", () => {
  assert.equal(Pure.nominalFps("10594584000"), 24); // 23.976
  assert.equal(Pure.nominalFps("10160640000"), 25);
  assert.equal(Pure.nominalFps("8475667200"), 30); // 29.97
  assert.equal(Pure.nominalFps("4237833600"), 60); // 59.94
  assert.equal(Pure.nominalFps("0"), null);
  assert.equal(Pure.framesToTimecode(12, 25), "00:00:00:12");
  assert.equal(Pure.framesToTimecode(25, 25), "00:00:01:00");
  assert.equal(Pure.framesToTimecode(24 * 3661 + 5, 24), "01:01:01:05");
});

test("argument validators", () => {
  assert.deepEqual(Pure.speedArgs({ percent: 50 }), { ratio: 0.5, reverse: false, ripple: true, maintainPitch: true });
  assert.deepEqual(Pure.speedArgs({ percent: 200, reverse: true, ripple: false, maintainPitch: false }), { ratio: 2, reverse: true, ripple: false, maintainPitch: false });
  assert.match(Pure.speedArgs({ percent: 0 }).error, /percent/);
  assert.match(Pure.speedArgs({ percent: 50, ripple: "yes" }).error, /ripple/);
  assert.deepEqual(Pure.transitionArgs({ edge: "both", durationFrames: 12 }), { edges: [true, false], type: "Constant Power", durationFrames: 12 });
  assert.deepEqual(Pure.transitionArgs({ edge: "end", durationFrames: 6, type: " Exponential Fade " }), { edges: [false], type: "Exponential Fade", durationFrames: 6 });
  assert.equal(Pure.transitionArgs({ edge: "start", durationFrames: 0 }).code, "BAD_TIME");
  assert.match(Pure.transitionArgs({ edge: "mid", durationFrames: 3 }).error, /edge/);
  assert.deepEqual(Pure.linkArgs({ items: [{ track: "v1", index: 0 }, { track: "A1", index: 0 }] }), { items: [{ track: "V1", index: 0 }, { track: "A1", index: 0 }] });
  assert.match(Pure.linkArgs({ items: [{ track: "V1", index: 0 }, { track: "v1", index: 0 }] }).error, /repeats/);
  assert.match(Pure.linkArgs({ items: [] }).error, /non-empty/);
});

// ---------------- the whole host against a fake Premiere ----------------

const TB25 = 10160640000; // ticks per frame at 25 fps

// A live DOM collection: c[i] and c.numItems (or numTracks / numSequences / numProjects) track `items`.
function coll(items, countName = "numItems") {
  const counts = { [countName]: null };
  return new Proxy({ _items: items }, {
    get(target, key) {
      if (key in counts && counts[key] !== undefined) return counts[key] === null ? items.length : counts[key];
      if (typeof key === "string" && /^\d+$/.test(key)) return items[Number(key)];
      return target[key];
    },
    defineProperty(target, key, desc) {
      if (key in counts && desc.get) { counts[key] = desc.get(); return true; }
      return Reflect.defineProperty(target, key, desc);
    },
  });
}

// keepDuration: "empty" = setSpeed(ratio, "") changes the speed but not the clip's duration (live, 26.5.2: the
// e2e P34 clip read speed 0.5 with its 119 frames unchanged); "always" = no call shape changes the duration.
function makeFake({ activeIsTarget = true, rejectEmptyDuration = false, transitionsNoop = false, keepDuration = null } = {}) {
  const calls = [];
  const time = (t) => ({ ticks: String(t), seconds: t / 254016000000 });
  function makeClip(name, startF, endF) {
    const clip = {
      name, _start: startF * TB25, _end: endF * TB25, _speed: 1, _reversed: false, _selected: false, _links: [],
      get start() { return time(clip._start); },
      get end() { return time(clip._end); },
      getSpeed() { return clip._speed; },
      isSpeedReversed() { return clip._reversed; },
      setSelected(state) { calls.push(["setSelected", name, !!state]); clip._selected = !!state; },
      getLinkedItems() { return coll(clip._links); },
    };
    return clip;
  }
  // V1: two clips out of start order in the DOM collection; A1: the linked audio of the first.
  const v1a = makeClip("SH010", 0, 50);
  const v1b = makeClip("SH020", 50, 100);
  const a1a = makeClip("SH010", 0, 50);
  v1a._links = [a1a];
  a1a._links = [v1a];
  const vTrack = { clips: coll([v1b, v1a]), transitions: coll([]) };
  const aTrack = { clips: coll([a1a]), transitions: coll([]) };
  const seq = {
    name: "Main", sequenceID: "seq-guid-1", timebase: String(TB25),
    projectItem: { nodeId: "n-seq" },
    videoTracks: coll([vTrack], "numTracks"),
    audioTracks: coll([aTrack], "numTracks"),
    getSelection() { return [v1a, v1b, a1a].filter((c) => c._selected); },
    linkSelection() { calls.push(["linkSelection", this.getSelection().map((c) => c.name)]); },
    unlinkSelection() {
      const sel = this.getSelection();
      calls.push(["unlinkSelection", sel.map((c) => c.name)]);
      for (const c of sel) c._links = [];
    },
  };
  const other = { name: "Other", sequenceID: "seq-guid-2", projectItem: { nodeId: "n-other" } };
  const edits = { name: "Edits", nodeId: "n-bin", type: 2, children: coll([{ name: "Main", nodeId: "n-seq", type: 1 }]) };
  const project = {
    name: "Edit.prproj", path: "\\\\?\\D:\\Projects\\MyFilm\\edit\\Edit.prproj",
    rootItem: { children: coll([edits, { name: "Other", nodeId: "n-other", type: 1 }]) },
    sequences: coll([seq, other], "numSequences"),
    activeSequence: other,
    save() { calls.push(["save"]); return true; },
  };
  const otherProject = { name: "B.prproj", path: "D:\\Projects\\B.prproj", sequences: coll([], "numSequences") };
  const app = {
    version: "26.5.2", build: "1",
    projects: coll([project, otherProject], "numProjects"),
    project: activeIsTarget ? project : otherProject,
    enableQE() { calls.push(["enableQE"]); },
    setExtensionPersistent(id, v) { calls.push(["persistent", id, v]); },
  };
  // QE: track items include gaps ("Empty") and are matched to DOM clips by start ticks.
  function qeItem(clip) {
    return {
      type: "Clip",
      get start() { return time(clip._start); },
      get reverse() { throw new Error("reading qeClip.reverse is fatal on 26.3.2"); },
      setSpeed(ratio, dur, reverse, pitch, ripple) {
        calls.push(["setSpeed", clip.name, ratio, dur, reverse, pitch, ripple]);
        if (rejectEmptyDuration && dur === "") throw new Error("Illegal Parameter type");
        if (project.activeSequence !== seq) throw new Error("QE acted on the wrong sequence");
        const len = (clip._end - clip._start) * clip._speed;
        clip._speed = ratio;
        clip._reversed = reverse;
        if (keepDuration === "always" || (keepDuration === "empty" && dur === "")) return;
        // The second argument, when given, is the new duration: ticks, or HH:MM:SS:FF at 25 fps.
        if (/^\d+$/.test(dur)) clip._end = clip._start + Number(dur);
        else if (/^\d\d:\d\d:\d\d:\d\d$/.test(dur)) {
          const [h, m, s, fr] = dur.split(":").map(Number);
          clip._end = clip._start + ((h * 3600 + m * 60 + s) * 25 + fr) * TB25;
        } else clip._end = clip._start + Math.round(len / ratio);
      },
      addTransition(tr, atStart, dur, offset, align, single, last) {
        calls.push(["addTransition", clip.name, tr.name, atStart, dur, offset, align, single, last]);
        if (transitionsNoop) return;
        const f = Number(dur.split(":")[3]);
        const at = atStart ? clip._start : clip._end;
        const track = aTrack.clips._items.includes(clip) ? aTrack : vTrack;
        track.transitions._items.push({ start: time(at - (f * TB25) / 2), end: time(at + (f * TB25) / 2) });
      },
    };
  }
  const gap = { type: "Empty", get start() { return time(100 * TB25); } };
  const qeSeq = {
    getVideoTrackAt: (i) => (i === 0 ? { numItems: 3, getItemAt: (k) => [qeItem(v1a), qeItem(v1b), gap][k] } : null),
    getAudioTrackAt: (i) => (i === 0 ? { numItems: 2, getItemAt: (k) => [qeItem(a1a), gap][k] } : null),
  };
  const qe = {
    project: {
      getActiveSequence: () => (project.activeSequence === seq ? qeSeq : null),
      getAudioTransitionByName: (n) => (["Constant Power", "Constant Gain", "Exponential Fade"].includes(n) ? { name: n } : null),
    },
  };
  const $ = { global: {} };
  new Function("app", "qe", "$", source)(app, qe, $);
  const call = (name, args) => JSON.parse($.global.__mcpSidecar_call(name, args));
  return { call, calls, app, project, seq, other, v1a, v1b, a1a, vTrack, aTrack };
}

const TARGET = "D:\\Projects\\MyFilm\\edit\\Edit.prproj";

test("host: listProjects strips \\\\?\\ and flags the active project; init sets persistence", () => {
  const f = makeFake();
  assert.deepEqual(f.call("listProjects", {}).projects, [
    { path: TARGET, name: "Edit.prproj", isActive: true },
    { path: "D:\\Projects\\B.prproj", name: "B.prproj", isActive: false },
  ]);
  const r = f.call("init", { extensionId: "com.mcp.premiere.sidecar.panel" });
  assert.equal(r.persistent, true);
  assert.deepEqual(f.calls.find((c) => c[0] === "persistent"), ["persistent", "com.mcp.premiere.sidecar.panel", 1]);
  assert.equal(f.call("nope", {}).code, "UNKNOWN_COMMAND");
});

test("host: saveProject saves the target by path", () => {
  const f = makeFake();
  assert.equal(f.call("saveProject", { projectPath: TARGET.toLowerCase() }).status, "success");
  assert.deepEqual(f.calls, [["save"]]);
  assert.equal(f.call("saveProject", { projectPath: "D:\\Nope.prproj" }).code, "PROJECT_NOT_OPEN");
});

test("host: setSpeed uses QE setSpeed(ratio, \"\", reverse, maintainPitch, ripple) on the clip matched by start", () => {
  const f = makeFake();
  const r = f.call("setSpeed", { projectPath: TARGET, sequence: "Edits/Main", track: "V1", index: 0, percent: 50, reverse: true, ripple: true, maintainPitch: false });
  assert.equal(r.status, "success", JSON.stringify(r));
  assert.deepEqual(f.calls.find((c) => c[0] === "setSpeed"), ["setSpeed", "SH010", 0.5, "", true, false, true]);
  assert.equal(r.speed, 0.5);
  assert.equal(r.reversed, true);
  assert.equal(r.before.speed, 1);
  assert.equal(r.after.durationTicks, String(100 * TB25));
  assert.equal(r.undoSteps, 1);
  assert.equal(f.project.activeSequence, f.other, "the previously active sequence is restored");
});

test("host: setSpeed falls back to a tick-string duration when \"\" throws", () => {
  const f = makeFake({ rejectEmptyDuration: true });
  const r = f.call("setSpeed", { projectPath: TARGET, sequence: { id: "seq-guid-1" }, track: "V1", index: 1, percent: 200 });
  assert.equal(r.status, "success", JSON.stringify(r));
  const tries = f.calls.filter((c) => c[0] === "setSpeed");
  assert.deepEqual(tries.map((c) => c[3]), ["", String(25 * TB25)], "\"\" first, then the new duration in ticks");
  assert.equal(r.hostCall, `setSpeed(ratio, "${25 * TB25}", reverse, maintainPitch, ripple)`);
  assert.equal(r.rippled, undefined, "last clip: nothing to ripple");
});

test("host: refusals: not active, unknown sequence, ambiguous, bad track, bad index", () => {
  let f = makeFake({ activeIsTarget: false });
  let r = f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: 50 });
  assert.equal(r.code, "TARGET_NOT_ACTIVE");
  assert.equal(r.activeProject, "D:\\Projects\\B.prproj");
  f = makeFake();
  assert.equal(f.call("setSpeed", { projectPath: TARGET, sequence: "Nope", track: "V1", index: 0, percent: 50 }).code, "SEQUENCE_NOT_FOUND");
  assert.equal(f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V9", index: 0, percent: 50 }).code, "BAD_ARGS");
  assert.equal(f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 5, percent: 50 }).code, "ITEM_NOT_FOUND");
  assert.equal(f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: -2 }).code, "BAD_ARGS");
  f.other.name = "main";
  r = f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: 50 });
  assert.equal(r.code, "AMBIGUOUS_ITEM");
  assert.equal(r.candidates.length, 2);
  assert.ok(!f.calls.some((c) => c[0] === "setSpeed"), "nothing changed");
});

test("host: setSpeed read-back mismatch is an error, not a success", () => {
  const f = makeFake();
  f.v1a.getSpeed = () => 1;
  const r = f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: 50 });
  assert.equal(r.code, "SPEED_NOT_APPLIED");
  assert.ok(r.hostCall.startsWith("setSpeed(ratio"));
});

test("host: setSpeed whose duration didn't follow the speed is not a success; the next call shape is tried", () => {
  const f = makeFake({ keepDuration: "empty" });
  const r = f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: 50, ripple: true });
  assert.equal(r.status, "success", JSON.stringify(r));
  assert.deepEqual(f.calls.filter((c) => c[0] === "setSpeed").map((c) => c[3]), ["", String(100 * TB25)]);
  assert.equal(r.after.durationTicks, String(100 * TB25), "half speed doubles the duration");
  assert.equal(r.hostCall, `setSpeed(ratio, "${100 * TB25}", reverse, maintainPitch, ripple)`);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].result, "duration-unchanged");
});

test("host: setSpeed with no call shape that changes the duration is SPEED_NOT_APPLIED, with evidence, and reverted", () => {
  const f = makeFake({ keepDuration: "always" });
  const r = f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: 50, ripple: true });
  assert.equal(r.status, "error");
  assert.equal(r.code, "SPEED_NOT_APPLIED");
  assert.match(r.message, /duration/);
  assert.equal(r.attempts.length, 3, "\"\", ticks and a timecode were tried");
  assert.ok(r.attempts.every((a) => a.result === "duration-unchanged"), JSON.stringify(r.attempts));
  assert.equal(r.reverted, true, "the speed was put back");
  assert.equal(f.v1a._speed, 1);
});

test("host: setSpeed without ripple may be clamped by the next clip (a warning, not a failure)", () => {
  // SH010 (0-50) butts against SH020 (50-100): without ripple its end stays at 50 while its speed changes.
  const f = makeFake({ keepDuration: "always" });
  const r = f.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, percent: 50, ripple: false });
  assert.equal(r.status, "success", JSON.stringify(r));
  assert.match(r.warning, /next clip/);
  assert.equal(f.calls.filter((c) => c[0] === "setSpeed").length, 1);
  // The last clip has room, so an unchanged duration there is a failure even without ripple.
  const g = makeFake({ keepDuration: "always" });
  const r2 = g.call("setSpeed", { projectPath: TARGET, sequence: "Main", track: "V1", index: 1, percent: 50, ripple: false });
  assert.equal(r2.code, "SPEED_NOT_APPLIED");
});

test("host: addAudioTransition uses getAudioTransitionByName and QE addTransition with an HH:MM:SS:FF duration", () => {
  const f = makeFake();
  const r = f.call("addAudioTransition", { projectPath: TARGET, sequence: "Main", track: "A1", index: 0, edge: "both", durationFrames: 12 });
  assert.equal(r.status, "success", JSON.stringify(r));
  const adds = f.calls.filter((c) => c[0] === "addTransition");
  assert.deepEqual(adds, [
    ["addTransition", "SH010", "Constant Power", true, "00:00:00:12", "0", 0.5, false, true],
    ["addTransition", "SH010", "Constant Power", false, "00:00:00:12", "0", 0.5, false, true],
  ]);
  assert.equal(r.added.length, 2);
  assert.equal(r.undoSteps, 2);
  assert.equal(r.durationTimecode, "00:00:00:12");
  assert.equal(f.project.activeSequence, f.other);
});

test("host: addAudioTransition refusals", () => {
  const f = makeFake();
  assert.equal(f.call("addAudioTransition", { projectPath: TARGET, sequence: "Main", track: "V1", index: 0, edge: "end", durationFrames: 12 }).code, "BAD_ARGS");
  assert.match(f.call("addAudioTransition", { projectPath: TARGET, sequence: "Main", track: "A1", index: 0, edge: "end", durationFrames: 12, type: "Wobble" }).message, /Constant Power/);
  assert.equal(f.call("addAudioTransition", { projectPath: TARGET, sequence: "Main", track: "A1", index: 0, edge: "end", durationFrames: 51 }).code, "BAD_TIME");
  const noop = makeFake({ transitionsNoop: true });
  const r = noop.call("addAudioTransition", { projectPath: TARGET, sequence: "Main", track: "A1", index: 0, edge: "end", durationFrames: 12 });
  assert.equal(r.code, "TRANSITION_NOT_APPLIED");
});

test("host: unlink selects exactly the items, unlinks, restores the user's selection and reads links back", () => {
  const f = makeFake();
  f.v1b._selected = true; // the user's own selection
  const r = f.call("unlink", { projectPath: TARGET, sequence: "Main", items: [{ track: "V1", index: 0 }, { track: "A1", index: 0 }] });
  assert.equal(r.status, "success", JSON.stringify(r));
  assert.deepEqual(f.calls.find((c) => c[0] === "unlinkSelection"), ["unlinkSelection", ["SH010", "SH010"]]);
  assert.deepEqual(r.items, [
    { track: "V1", index: 0, name: "SH010", linkedItems: 0 },
    { track: "A1", index: 0, name: "SH010", linkedItems: 0 },
  ]);
  assert.equal(f.v1b._selected, true, "user selection restored");
  assert.equal(f.v1a._selected, false);
  assert.equal(r.linked, false);
  const l = f.call("link", { projectPath: TARGET, sequence: "Main", items: [{ track: "V1", index: 0 }, { track: "A1", index: 0 }] });
  assert.equal(l.linked, true);
  assert.ok(f.calls.some((c) => c[0] === "linkSelection"));
});
