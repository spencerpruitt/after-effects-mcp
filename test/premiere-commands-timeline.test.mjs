// Command-module tests for timeline commands against the fake ppro object model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { cmd, makeCtx, standardProject, rejects, FOLDER, TPS, UNSET } from "./premiere-fakeppro.mjs";

const F24 = 10584000000n; // ticks per frame at 24 fps
const fr = (n) => BigInt(n) * F24;

async function built(o = {}) {
  const f = standardProject(o);
  const ctx = makeCtx(f);
  await cmd("buildSequence").run(ctx, {
    sequence: "Edit",
    mode: "append",
    clips: [{ item: "Renders/v003/SH010_v003", in: { frames: 10 }, out: { frames: 34 } }, { item: { id: "sh20" }, gapBefore: { frames: 12 } }],
  });
  ctx.txns.length = 0;
  return { f, ctx };
}

// ---------------- buildSequence ----------------

const span = (it) => [it.start, it.end, it.inT, it.outT];
const sorted = (items) => items.slice().sort((a, b) => (a.start < b.start ? -1 : 1));

test("buildSequence: clips land full length, then are trimmed on the timeline and moved into place (video and audio)", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const r = await cmd("buildSequence").run(ctx, {
    sequence: "Edit",
    mode: "append",
    track: "V1",
    withAudio: true,
    clips: [{ item: "Renders/v003/SH010_v003", in: { frames: 10 }, out: { timecode: "00:00:01:10" } }, { item: { id: "sh20" }, gapBefore: { frames: 12 } }],
  });
  // 1: place full length (parked past every target). 2: trims + the moves Premiere accepts. 3: SH010's move,
  // refused in 2 because its target (0) is earlier than its head trim (10 frames).
  assert.deepEqual(ctx.txns.map((t) => t.actions.map((a) => a.kind)), [
    ["overwrite", "overwrite"],
    ["setIn", "setOut", "setIn", "setOut", "move", "move"],
    ["move", "move"],
  ]);
  assert.equal(ctx.undoSteps, 3);
  assert.ok(ctx.txns[0].actions.every((a) => a.at >= fr(84)), "parked past the last target");
  assert.deepEqual(sorted(f.seq.video[0].items).map(span), [[0n, fr(24), fr(10), fr(34)], [fr(36), fr(84), 0n, fr(48)]]);
  assert.deepEqual(sorted(f.seq.audio[0].items).map(span), [[0n, fr(24), fr(10), fr(34)], [fr(36), fr(84), 0n, fr(48)]]);
  assert.equal(f.sh10.inT, UNSET, "project item marks are not touched");
  assert.equal(r.verified, true);
  assert.deepEqual(r.placed.map((p) => [p.start.frames, p.end.frames, p.index]), [[0, 24, 0], [36, 84, 1]]);
  assert.equal(r.trackEnd.frames, 84);
});

test("buildSequence: two transactions when every move is accepted at once; untrimmed clips keep their length", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  await cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh20" } }, { item: { id: "sh10" }, in: { frames: 4 } }] });
  assert.equal(ctx.txns.length, 2);
  assert.deepEqual(sorted(f.seq.video[0].items).map(span), [[0n, fr(48), 0n, fr(48)], [fr(48), fr(144), fr(4), fr(100)]]);
});

test("buildSequence: append starts at the track end; replace clears the track and its linked audio first", async () => {
  const { f, ctx } = await built();
  await cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh20" } }] });
  assert.deepEqual(sorted(f.seq.video[0].items).map((i) => i.start), [0n, fr(36), fr(84)]);
  ctx.txns.length = 0;
  const r = await cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "replace", clips: [{ item: { id: "sh20" } }] });
  assert.equal(ctx.txns[0].actions[0].kind, "remove");
  assert.equal(ctx.txns[0].actions[0].mt, "any");
  assert.equal(ctx.txns[0].actions[0].count, 6, "3 video clips and their 3 audio partners");
  assert.deepEqual(f.seq.video[0].items.map((i) => [i.start, i.end]), [[0n, fr(48)]]);
  assert.deepEqual(f.seq.audio[0].items.map((i) => [i.start, i.end]), [[0n, fr(48)]]);
  assert.equal(r.verified, true);
});

test("buildSequence: withAudio=false removes the placed audio in the trim transaction", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const r = await cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", withAudio: false, clips: [{ item: { id: "sh20" } }] });
  assert.equal(ctx.txns.length, 2);
  assert.deepEqual(ctx.txns[1].actions.map((a) => [a.kind, a.mt]), [["move", undefined], ["remove", "any"]]);
  assert.equal(f.seq.audio[0].items.length, 0);
  assert.deepEqual(f.seq.video[0].items.map((i) => [i.start, i.end]), [[0n, fr(48)]]);
  assert.equal(r.audioRemoved, 1);
});

test("buildSequence: a placement Premiere does not honour is VERIFY_FAILED with mismatches, not success", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  // Model a Premiere that ignores out-point trims.
  const orig = f.TrackItem.prototype.createSetOutPointAction;
  f.TrackItem.prototype.createSetOutPointAction = function () { return orig.call(this, { ticks: String(this.outT) }); };
  await assert.rejects(cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh10" }, out: { frames: 30 } }] }), (e) => {
    assert.equal(e.code, "VERIFY_FAILED");
    assert.deepEqual(e.extra.mismatches.map((m) => m.media), ["video", "audio"]);
    assert.equal(e.extra.mismatches[0].expected.end.frames, 30);
    assert.equal(e.extra.mismatches[0].actual.end.frames, 100);
    return true;
  });
  assert.equal(ctx.undoSteps, 2, "the undo steps taken are still counted");
});

test("buildSequence: project item marks decide the untrimmed length; out past the media end is BAD_TIME", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  f.sh10.inT = fr(20);
  f.sh10.outT = fr(50);
  await cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh10" } }] });
  assert.deepEqual(f.seq.video[0].items.map(span), [[0n, fr(30), fr(20), fr(50)]]);
  await rejects(cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh20" }, out: { frames: 49 } }] }), "BAD_TIME");
});

test("buildSequence: argument and reference errors", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const c = cmd("buildSequence");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "insert", clips: [{ item: { id: "sh20" } }] }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "append", clips: [] }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Nope", mode: "append", clips: [{ item: { id: "sh20" } }] }), "SEQUENCE_NOT_FOUND");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "append", track: "A1", clips: [{ item: { id: "sh20" } }] }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "append", track: "V3", clips: [{ item: { id: "sh20" } }] }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh20" }, in: { frames: 1.5 } }] }), "BAD_TIME");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: { id: "sh20" }, in: { frames: 20 }, out: { frames: 10 } }] }), "BAD_TIME");
  await rejects(c.run(ctx, { sequence: "Edit", mode: "append", clips: [{ item: "Renders/v003/none" }] }), "ITEM_NOT_FOUND");
  assert.equal(ctx.txns.length, 0); // validation happens before any transaction
});

test("buildSequence: V2 that does not exist yet is allowed (next new track)", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  await cmd("buildSequence").run(ctx, { sequence: "Edit", mode: "append", track: "V2", clips: [{ item: { id: "sh20" } }] });
  assert.equal(f.seq.video[1].items.length, 1);
});

// ---------------- getSequence ----------------

test("getSequence: settings, tracks, items with times, pagination", async () => {
  const { ctx } = await built();
  const r = await cmd("getSequence").run(ctx, { sequence: "Edit" });
  assert.deepEqual(r.settings.timebase, { fpsNum: 24, fpsDen: 1, dropFrame: false });
  assert.deepEqual(r.settings.frameSize, { width: 1920, height: 1080 });
  assert.deepEqual(r.tracks.map((t) => [t.track, t.clipCount]), [["V1", 2], ["A1", 2]]);
  assert.equal(r.total, 4);
  const first = r.items[0];
  assert.equal(first.track, "V1");
  assert.equal(first.index, 0);
  assert.deepEqual(first.start, { frames: 0, timecode: "00:00:00:00", seconds: 0 });
  assert.equal(first.end.frames, 24);
  assert.equal(first.in.frames, 10);
  assert.equal(first.out.frames, 34);
  assert.equal(first.speed, 1);
  assert.equal(first.enabled, true);
  assert.deepEqual(first.effects, ["Volume"]);
  assert.equal(first.item.id, "sh10");
  const page = await cmd("getSequence").run(ctx, { sequence: "Edit", tracks: ["A1"], offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].track, "A1");
  assert.equal(page.items[0].index, 1);
  assert.equal(page.hasMore, false);
  const p0 = await cmd("getSequence").run(ctx, { sequence: "Edit", limit: 3 });
  assert.equal(p0.hasMore, true);
  assert.equal(p0.nextOffset, 3);
  await rejects(cmd("getSequence").run(ctx, { sequence: "Edit", tracks: ["Q1"] }), "BAD_ARGS");
});

test("getSequence: transitions come back as nulls (live) without crashing; readable ones are listed", async () => {
  const { f, ctx } = await built();
  await cmd("addTransition").run(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "end", type: "Cross Dissolve", durationFrames: 6 });
  const r = await cmd("getSequence").run(ctx, { sequence: "Edit" });
  assert.deepEqual(r.tracks.map((t) => t.transitions), [[], []]);
  assert.match(r.transitionsNote, /does not return transition objects/);
  assert.equal(r.total, 4);
  // A release that returns transition objects: listed with start/end/match name; nulls still skipped.
  const tr = { getStartTime: async () => ({ ticks: String(fr(21)) }), getEndTime: async () => ({ ticks: String(fr(27)) }), getMatchName: async () => "AE.ADBE Cross Dissolve New", getName: async () => { throw new Error("no name"); } };
  f.seq.video[0].getTrackItems = function (type) { return type === 2 ? [null, tr] : this.items.slice(); };
  const r2 = await cmd("getSequence").run(ctx, { sequence: "Edit" });
  assert.deepEqual(r2.tracks[0].transitions, [{ name: null, matchName: "AE.ADBE Cross Dissolve New", start: { frames: 21, timecode: "00:00:00:21", seconds: 0.875 }, end: { frames: 27, timecode: "00:00:01:03", seconds: 1.125 } }]);
});

test("getSequence: 29.97 drop-frame sequence reports DF timecodes", async () => {
  const f = standardProject();
  const seq = f.project.addSequence("DF", { tpf: "8475667200", displayType: 102 });
  seq.video[0].items.push(new f.TrackItem({ kind: "video", start: 1800n * 8475667200n, end: 1830n * 8475667200n, inT: 0n, outT: 0n, projectItem: f.sh10 }));
  const r = await cmd("getSequence").run(makeCtx(f), { sequence: "DF" });
  assert.equal(r.settings.timebase.dropFrame, true);
  assert.equal(r.items[0].start.timecode, "00:01:00;02");
  const nd = f.project.addSequence("NDF", { tpf: "8475667200", displayType: 103 });
  assert.equal((await cmd("getSequence").run(makeCtx(f), { sequence: "NDF" })).settings.timebase.dropFrame, false);
});

// ---------------- editItems ----------------

test("editItems: several clips in ONE transaction, removes last; remove 'both' takes the linked audio explicitly", async () => {
  const { f, ctx } = await built();
  const r = await cmd("editItems").run(ctx, {
    sequence: "Edit",
    edits: [
      { track: "V1", index: 1, op: "remove", mediaType: "both" },
      { track: "V1", at: { frames: 5 }, op: "trim", end: { frames: 20 }, mediaType: "video" },
      { track: "V1", index: 0, op: "disable", mediaType: "video" },
    ],
  });
  assert.equal(ctx.txns.length, 1);
  assert.deepEqual(ctx.txns[0].actions.map((a) => a.kind), ["setEnd", "setDisabled", "remove"]);
  assert.deepEqual([ctx.txns[0].actions.at(-1).mt, ctx.txns[0].actions.at(-1).ripple, ctx.txns[0].actions.at(-1).count], ["any", false, 2]);
  const v1 = f.seq.video[0].items;
  assert.deepEqual(v1.map(span), [[0n, fr(20), fr(10), fr(30)]], "setEnd is a tail trim: end and out move together");
  assert.equal(v1[0].disabled, true);
  assert.deepEqual(sorted(f.seq.audio[0].items).map(span), [[0n, fr(24), fr(10), fr(34)]], "video-only edits leave the audio");
  assert.equal(r.applied.length, 3);
  assert.equal(r.applied[0].partners, 1);
  assert.deepEqual([r.applied[1].after.end.frames, r.applied[1].after.out.frames], [20, 30]);
});

test("editItems: trims are edge trims (in/start move the head, out/end the tail), partners trimmed too, result read back", async () => {
  const { f, ctx } = await built();
  let r = await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 1, op: "trim", in: { frames: 6 }, out: { frames: 40 } }] });
  assert.deepEqual(ctx.txns[0].actions.map((a) => [a.kind, a.media]), [["setIn", "video"], ["setOut", "video"], ["setIn", "audio"], ["setOut", "audio"]]);
  assert.deepEqual(span(sorted(f.seq.video[0].items)[1]), [fr(42), fr(76), fr(6), fr(40)]);
  assert.deepEqual(span(sorted(f.seq.audio[0].items)[1]), [fr(42), fr(76), fr(6), fr(40)]);
  assert.deepEqual([r.applied[0].after.start.frames, r.applied[0].after.end.frames, r.applied[0].after.in.frames, r.applied[0].after.out.frames], [42, 76, 6, 40]);
  r = await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 1, op: "trim", start: { frames: 40 }, end: { frames: 70 } }] });
  assert.deepEqual([r.applied[0].after.start.frames, r.applied[0].after.end.frames, r.applied[0].after.in.frames, r.applied[0].after.out.frames], [40, 70, 4, 34]);
});

test("editItems: slip keeps start/end and shifts the media, ordered so neighbours are never overlapped", async () => {
  const { f, ctx } = await built();
  // d < 0: tail trim, move right, head extend.
  await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 0, op: "slip", delta: { frames: -4 } }] });
  assert.equal(ctx.txns.length, 1);
  assert.deepEqual(ctx.txns[0].actions.map((a) => a.kind), ["setOut", "move", "setIn", "setOut", "move", "setIn"]);
  assert.deepEqual(span(sorted(f.seq.video[0].items)[0]), [0n, fr(24), fr(6), fr(30)]);
  assert.deepEqual(span(sorted(f.seq.audio[0].items)[0]), [0n, fr(24), fr(6), fr(30)]);
  // d > 0 on a clip that starts less than d from 0: Premiere won't create the move before the head trim, so
  // the move and the tail extend follow in a second transaction.
  ctx.txns.length = 0;
  await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 0, op: "slip", delta: { frames: 3 } }] });
  assert.deepEqual(ctx.txns.map((t) => t.actions.map((a) => a.kind)), [["setIn", "setIn"], ["move", "setOut", "move", "setOut"]]);
  assert.deepEqual(span(sorted(f.seq.video[0].items)[0]), [0n, fr(24), fr(9), fr(33)]);
  // d > 0 with room: one transaction, head trim, move left, tail extend.
  ctx.txns.length = 0;
  f.seq.video[0].items.forEach((it) => { if (it.start === 0n) { it.start += fr(5); it.end += fr(5); } });
  await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 0, op: "slip", delta: { frames: 2 }, mediaType: "video" }] });
  assert.deepEqual(ctx.txns.map((t) => t.actions.map((a) => a.kind)), [["setIn", "move", "setOut"]]);
  assert.deepEqual(span(sorted(f.seq.video[0].items)[0]), [fr(5), fr(29), fr(11), fr(35)]);
});

test("editItems: mediaType both edits the linked audio partner too; move by to", async () => {
  const { f, ctx } = await built();
  await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 1, op: "move", to: { frames: 100 } }] });
  assert.equal(f.seq.video[0].items[1].start, fr(100));
  assert.equal(f.seq.audio[0].items[1].start, fr(100));
  assert.deepEqual(ctx.txns[0].actions.map((a) => [a.kind, a.delta]), [["move", fr(64)], ["move", fr(64)]]);
});

test("editItems: ripple remove of audio only", async () => {
  const { f, ctx } = await built();
  await cmd("editItems").run(ctx, { sequence: "Edit", ripple: true, edits: [{ track: "A1", index: 0, op: "remove", mediaType: "audio" }] });
  const a = ctx.txns[0].actions[0];
  assert.deepEqual([a.kind, a.ripple, a.mt, a.count], ["remove", true, "audio", 1]);
  assert.equal(f.seq.audio[0].items.length, 1);
});

test("editItems: the top-level ripple governs removes; a per-edit ripple is ignored", async () => {
  const { ctx } = await built();
  await cmd("editItems").run(ctx, { sequence: "Edit", edits: [{ track: "A1", index: 0, op: "remove", mediaType: "audio", ripple: true }] });
  assert.equal(ctx.txns[0].actions[0].ripple, false);
  const r = await cmd("editItems").run(ctx, { sequence: "Edit", ripple: true, edits: [{ track: "V1", index: 0, op: "trim", end: { frames: 20 }, mediaType: "video", ripple: false }, { track: "V1", index: 1, op: "remove", ripple: false }] });
  assert.equal(ctx.txns[1].actions.at(-1).ripple, true);
  assert.equal(r.applied[1].ripple, true);
});

test("editItems: validation errors, nothing committed", async () => {
  const { ctx } = await built();
  const c = cmd("editItems");
  const bad = async (edit, code, extra = {}) => rejects(c.run(ctx, { sequence: "Edit", edits: [edit], ...extra }), code);
  await bad({ track: "V1", index: 9, op: "remove" }, "ITEM_NOT_FOUND");
  await bad({ track: "V1", at: { frames: 30 }, op: "remove" }, "ITEM_NOT_FOUND"); // in the gap
  await bad({ track: "V1", index: 0, op: "explode" }, "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "move" }, "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "move", to: { frames: 1 }, delta: { frames: 1 } }, "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "move", delta: { frames: -1 } }, "BAD_TIME");
  await bad({ track: "V1", index: 0, op: "move", at: { frames: 50 } }, "BAD_ARGS"); // `at` is not a destination
  await bad({ track: "V1", index: 0, op: "trim" }, "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "trim", start: { frames: 30 }, end: { frames: 20 } }, "BAD_TIME");
  // UXP's createMoveAction only shifts the item; it has no ripple option, so ripple moves are refused.
  await bad({ track: "V1", index: 0, op: "move", delta: { frames: 1 } }, "BAD_ARGS", { ripple: true });
  await bad({ track: "V1", index: 0, op: "slip", delta: { frames: -20 } }, "BAD_TIME");
  await bad({ track: "V1", index: 1, op: "slip", delta: { frames: 1 } }, "BAD_TIME"); // SH020 is used to its last frame
  await bad({ track: "V1", index: 0, op: "trim", start: { frames: 2 }, in: { frames: 12 } }, "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "trim", end: { frames: 20 }, out: { frames: 30 } }, "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "trim", out: { frames: 101 } }, "BAD_TIME");
  await bad({ track: "V1", index: 0, op: "trim", in: { frames: 2 } }, "BAD_TIME"); // head would go before 0
  await rejects(c.run(ctx, { sequence: "Edit", edits: [{ track: "V1", index: 0, op: "move", delta: { frames: 1 } }, { track: "V1", index: 0, op: "trim", end: { frames: 20 } }] }), "BAD_ARGS");
  await bad({ track: "V1", index: 0, op: "disable", mediaType: "audio" }, "BAD_ARGS");
  await bad({ track: "V9", index: 0, op: "disable" }, "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", edits: [] }), "BAD_ARGS");
  assert.equal(ctx.txns.length, 0);
});

// ---------------- placeAudio ----------------

test("placeAudio: overwrite lands full length, then is trimmed and moved to `at`; insert takes no trims", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const r = await cmd("placeAudio").run(ctx, { sequence: "Edit", item: "Music/song", track: "A2", at: { timecode: "00:00:02:00" }, in: { frames: 24 }, out: { frames: 72 } });
  assert.deepEqual(ctx.txns.map((t) => t.actions.map((a) => a.kind)), [["overwrite"], ["setIn", "setOut", "move"]]);
  assert.equal(ctx.txns[0].actions[0].a, 1);
  assert.deepEqual(span(f.seq.audio[1].items[0]), [fr(48), fr(96), fr(24), fr(72)]);
  assert.equal(f.song.outT, UNSET, "project item marks are not touched");
  assert.equal(r.verified, true);
  assert.equal(r.end.frames, 96);
  // Media with video: the video that lands on V1 is removed.
  await cmd("placeAudio").run(ctx, { sequence: "Edit", item: { id: "sh20" }, track: "A3", at: { frames: 0 } });
  assert.equal(f.seq.video[0].items.length, 0);
  assert.deepEqual(span(f.seq.audio[2].items[0]), [0n, fr(48), 0n, fr(48)]);
  ctx.txns.length = 0;
  await cmd("placeAudio").run(ctx, { sequence: "Edit", item: "Music/song", at: { frames: 0 }, mode: "insert" });
  assert.deepEqual(ctx.txns.map((t) => t.actions.map((a) => a.kind)), [["insert"]]);
  await rejects(cmd("placeAudio").run(ctx, { sequence: "Edit", item: "Music/song", at: { frames: 0 }, mode: "insert", out: { frames: 10 } }), "BAD_ARGS");
  await rejects(cmd("placeAudio").run(ctx, { sequence: "Edit", item: "Music/song", track: "V1", at: { frames: 0 } }), "BAD_ARGS");
  await rejects(cmd("placeAudio").run(ctx, { sequence: "Edit", item: "Music/song", at: { frames: 0 }, mode: "x" }), "BAD_ARGS");
  await rejects(cmd("placeAudio").run(ctx, { sequence: "Edit", item: "Music/song" }), "BAD_ARGS");
});

// ---------------- setAudio ----------------

test("setAudio: plain level sets a static value (dB encoded), clears keyframes", async () => {
  const { f, ctx } = await built();
  const level = f.seq.audio[0].items[0].chain.level;
  level.varying = true;
  const r = await cmd("setAudio").run(ctx, { sequence: "Edit", track: "A1", index: 0, levelDb: -6 });
  assert.equal(ctx.txns.length, 1);
  assert.deepEqual(ctx.txns[0].actions.map((a) => a.kind), ["setTimeVarying", "setValue"]);
  assert.ok(Math.abs(level.value - Math.pow(10, -21 / 20)) < 1e-12);
  assert.equal(r.clearedKeyframes, true);
});

test("setAudio: fades and keyframes become keyframes in clip time, one transaction", async () => {
  const { f, ctx } = await built();
  const r = await cmd("setAudio").run(ctx, { sequence: "Edit", track: "A1", index: 0, levelDb: 0, fades: { inFrames: 6, outFrames: 6 } });
  const acts = ctx.txns[0].actions;
  assert.deepEqual(acts.map((a) => a.kind), ["setTimeVarying", "addKeyframe", "addKeyframe", "addKeyframe", "addKeyframe"]);
  // clip starts at 0 with in point 10 frames: keyframes at in+0, in+6, in+18, in+24
  assert.deepEqual(acts.slice(1).map((a) => a.at), [fr(10), fr(16), fr(28), fr(34)]);
  assert.deepEqual(acts.slice(1).map((a) => a.value === 0), [true, false, false, true]);
  assert.deepEqual(r.keyframes.map((k) => k.at.frames), [0, 6, 18, 24]);
  ctx.txns.length = 0;
  await cmd("setAudio").run(ctx, { sequence: "Edit", track: "A1", index: 1, keyframes: [{ at: { frames: 40 }, db: -3 }] });
  assert.deepEqual(ctx.txns[0].actions.map((a) => a.kind), ["setTimeVarying", "addKeyframe"]);
  assert.equal(ctx.txns[0].actions[1].at, fr(4)); // 40 - start 36 + in 0
  const c = cmd("setAudio");
  await rejects(c.run(ctx, { sequence: "Edit", track: "A1", index: 0 }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, levelDb: 0 }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", track: "A1", index: 0, levelDb: 20 }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", track: "A1", index: 0, fades: { inFrames: 1.5 } }), "BAD_TIME");
  await rejects(c.run(ctx, { sequence: "Edit", track: "A1", index: 0, fades: { inFrames: 20, outFrames: 20 } }), "BAD_TIME");
  await rejects(c.run(ctx, { sequence: "Edit", track: "A1", index: 0, keyframes: [{ at: { frames: 30 }, db: 0 }] }), "BAD_TIME");
});

// ---------------- addTransition ----------------

test("addTransition: video, both edges in one transaction, display-name alias", async () => {
  const { ctx } = await built();
  const r = await cmd("addTransition").run(ctx, { sequence: "Edit", track: "V1", index: 1, edge: "both", type: "Cross Dissolve", durationFrames: 12 });
  assert.equal(r.matchName, "ADBE Cross Dissolve New");
  assert.equal(ctx.txns.length, 1);
  assert.deepEqual(ctx.txns[0].actions.map((a) => [a.kind, a.applyToStart, a.duration]), [["addTransition", true, fr(12)], ["addTransition", false, fr(12)]]);
  await cmd("addTransition").run(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "end", type: "push", durationFrames: 6 });
  assert.equal(ctx.txns[1].actions[0].matchName, "ADBE Push");
});

test("addTransition: errors; audio needs the sidecar", async () => {
  const { ctx } = await built();
  const c = cmd("addTransition");
  await rejects(c.run(ctx, { sequence: "Edit", track: "A1", index: 0, edge: "start", durationFrames: 12 }), "NEEDS_SIDECAR_UNAVAILABLE");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "start", type: "Wobble", durationFrames: 12 }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "middle", durationFrames: 12 }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "start", durationFrames: 0 }), "BAD_TIME");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "start", durationFrames: 500 }), "BAD_TIME");
  assert.equal(ctx.txns.length, 0);
});

// ---------------- setSpeed ----------------

test("setSpeed: validates, resolves, then NEEDS_SIDECAR_UNAVAILABLE without touching anything", async () => {
  const { ctx } = await built();
  const c = cmd("setSpeed");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, percent: -5 }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 7, percent: 50 }), "ITEM_NOT_FOUND");
  await assert.rejects(c.run(ctx, { sequence: "Edit", track: "V1", index: 0, percent: 50 }), (e) => e.code === "NEEDS_SIDECAR_UNAVAILABLE" && e.extra.currentSpeed === 1);
  assert.equal(ctx.txns.length, 0);
});

test("setSpeed and audio addTransition refuse in precheck, so core never saves or backs up for them", async () => {
  const { ctx } = await built();
  assert.equal(typeof cmd("setSpeed").precheck, "function");
  assert.equal(typeof cmd("addTransition").precheck, "function");
  await rejects(cmd("setSpeed").precheck(ctx, { sequence: "Edit", track: "V1", index: 0, percent: 50 }), "NEEDS_SIDECAR_UNAVAILABLE");
  await rejects(cmd("setSpeed").precheck(ctx, { sequence: "Edit", track: "V1", index: 0, percent: 0 }), "BAD_ARGS");
  await rejects(cmd("addTransition").precheck(ctx, { sequence: "Edit", track: "A1", index: 0, edge: "start", durationFrames: 12 }), "NEEDS_SIDECAR_UNAVAILABLE");
  await cmd("addTransition").precheck(ctx, { sequence: "Edit", track: "V1", index: 0, edge: "start", durationFrames: 12 });
  assert.equal(ctx.txns.length, 0);
});

// ---------------- addMarkers ----------------

test("addMarkers: sequence markers in one transaction; colours as a second", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const r = await cmd("addMarkers").run(ctx, {
    target: { sequence: "Edit" },
    markers: [
      { at: { frames: 24 }, name: "A", comment: "note" },
      { at: { timecode: "00:00:02:00" }, duration: { frames: 12 }, name: "B", type: "chapter", color: "red" },
      { at: { frames: 72 }, name: "C", color: 5 },
    ],
  });
  assert.equal(r.added, 3);
  assert.equal(ctx.txns.length, 2);
  assert.deepEqual(ctx.txns[0].actions.map((a) => [a.name, a.type, a.start]), [["A", "Comment", fr(24)], ["B", "Chapter", fr(48)], ["C", "Comment", fr(72)]]);
  assert.deepEqual(f.seq.markers.list.map((m) => m.color), [null, 1, 5]);
});

test("addMarkers: clip markers use the clip timebase; errors", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  await cmd("addMarkers").run(ctx, { target: { item: { id: "sh10" } }, markers: [{ at: { frames: 12 }, name: "x" }] });
  assert.equal(ctx.txns.length, 1);
  assert.equal(f.sh10.markers.list[0].start, fr(12));
  const c = cmd("addMarkers");
  await rejects(c.run(ctx, { target: { item: "Music/song" }, markers: [{ at: { frames: 1 }, name: "x" }] }), "BAD_TIME"); // audio has no frame rate
  await rejects(c.run(ctx, { target: {}, markers: [{ at: { frames: 1 }, name: "x" }] }), "BAD_ARGS");
  await rejects(c.run(ctx, { target: { sequence: "Edit" }, markers: [{ at: { frames: 1 }, name: "x", color: "puce" }] }), "BAD_ARGS");
  await rejects(c.run(ctx, { target: { sequence: "Edit" }, markers: [{ at: { frames: 1 }, name: "x", type: "Cue" }] }), "BAD_ARGS");
  await rejects(c.run(ctx, { target: { sequence: "Edit" }, markers: [{ at: { frames: 0.5 }, name: "x" }] }), "BAD_TIME");
  await rejects(c.run(ctx, { target: { sequence: "Nope" }, markers: [{ at: { frames: 1 }, name: "x" }] }), "SEQUENCE_NOT_FOUND");
});

// ---------------- exportSequence ----------------

test("exportSequence: assertWritable runs before anything else; outside folder refused", async () => {
  const f = standardProject();
  const preset = "D:\\Presets\\H264.epr";
  const ctx = makeCtx(f, { files: [preset] });
  const c = cmd("exportSequence");
  await rejects(c.run(ctx, { sequence: "Nope", preset, output: "C:\\Outside\\x.mp4" }), "OUTSIDE_FOLDER");
  assert.ok(!f.state.log.some((l) => l.startsWith("export")));
  const r = await c.run(ctx, { sequence: "Edit", preset, output: FOLDER + "\\renders\\cut.mp4", mode: "direct", range: "full" });
  assert.equal(r.kind, "video");
  const iw = f.state.log.indexOf("assertWritable:" + FOLDER + "\\renders\\cut.mp4");
  const ie = f.state.log.findIndex((l) => l.startsWith("exportSequence:now:"));
  assert.ok(iw >= 0 && iw < ie);
  assert.ok(f.state.log.includes(`exportSequence:now:${FOLDER}\\renders\\cut.mp4:true`));
  await c.run(ctx, { sequence: "Edit", preset, output: FOLDER + "\\renders\\q", mode: "queue-ame", range: "workarea" });
  assert.ok(f.state.log.includes(`exportSequence:ame:${FOLDER}\\renders\\q.mp4:false`));
  await rejects(c.run(ctx, { sequence: "Edit", preset: "D:\\none.epr", output: FOLDER + "\\a.mp4" }), "FILE_NOT_FOUND");
  await rejects(c.run(ctx, { sequence: "Edit", preset: "D:\\x.txt", output: FOLDER + "\\a.mp4" }), "BAD_ARGS");
  await rejects(c.run(ctx, { sequence: "Edit", output: FOLDER + "\\a.mp4" }), "BAD_ARGS");
  const noAme = standardProject({ ame: false });
  await rejects(cmd("exportSequence").run(makeCtx(noAme, { files: [preset] }), { sequence: "Edit", preset, output: FOLDER + "\\a.mp4", mode: "queue-ame" }), "UNSUPPORTED");
});

test("exportSequence: frame export with format, time conversion and frame size", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const r = await cmd("exportSequence").run(ctx, { sequence: "Edit", output: FOLDER + "\\stills\\f0048", frame: { timecode: "00:00:02:00" }, format: "png" });
  assert.equal(r.output, FOLDER + "\\stills\\f0048.png");
  assert.ok(f.state.log.includes(`exportFrame:f0048.png:${FOLDER}\\stills\\:${fr(48)}:1920x1080`));
  await rejects(cmd("exportSequence").run(ctx, { sequence: "Edit", output: FOLDER + "\\a.png", frame: { frames: 1 }, format: "jpg" }), "BAD_ARGS");
  await rejects(cmd("exportSequence").run(ctx, { sequence: "Edit", output: FOLDER + "\\a.webp", frame: { frames: 1 } }), "BAD_ARGS");
  await rejects(cmd("exportSequence").run(ctx, { sequence: "Edit", output: "C:\\x\\a.png", frame: { frames: 1 } }), "OUTSIDE_FOLDER");
});

// ---------------- drop-frame detection ----------------

const shared = createRequire(import.meta.url)("../src/premiere-uxp/commands/_shared.js");
const F2997 = 8475667200n; // ticks per frame at 29.97
const badTime = (e) => e.code === "BAD_TIME";

test("drop-frame: an unreadable display format means non-drop, but a ';' timecode is still read as drop-frame", async () => {
  const f = standardProject();
  const seq = f.project.addSequence("U", { tpf: String(F2997) });
  seq.getSettings = async () => { throw new Error("not readable"); };
  const ctx = makeCtx(f);
  const tb = await shared.sequenceTimebase(ctx, seq);
  assert.deepEqual({ ...tb }, { fpsNum: 30000, fpsDen: 1001, dropFrame: false });
  assert.equal(shared.parseTicks(ctx, { timecode: "00:01:00:00" }, tb, "t"), 1800n * F2997);
  assert.equal(shared.parseTicks(ctx, { timecode: "00:01:00;02" }, tb, "t"), 1800n * F2997);
  // A display format Premiere reports as non-drop is known: ';' stays an error there.
  const nd = f.project.addSequence("ND", { tpf: String(F2997), displayType: 103 });
  const ndTb = await shared.sequenceTimebase(ctx, nd);
  assert.equal(ndTb.dropFrame, false);
  assert.throws(() => shared.parseTicks(ctx, { timecode: "00:01:00;02" }, ndTb, "t"), badTime);
  // FPS_29_97 is drop-frame.
  assert.equal((await shared.sequenceTimebase(ctx, f.project.addSequence("DF", { tpf: String(F2997), displayType: 102 }))).dropFrame, true);
});

test("drop-frame: clipTimebase detects drop-frame where the clip exposes it, else accepts ';' at 29.97/59.94", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  f.sh10.getFootageInterpretation = async () => ({ getFrameRate: () => 30000 / 1001, getVideoDisplayFormat: async () => ({ type: 102 }) });
  assert.equal((await shared.clipTimebase(ctx, f.sh10, null)).dropFrame, true);
  f.sh10.getFootageInterpretation = async () => ({ getFrameRate: () => 60000 / 1001 });
  const tb = await shared.clipTimebase(ctx, f.sh10, null);
  assert.deepEqual({ ...tb }, { fpsNum: 60000, fpsDen: 1001, dropFrame: false });
  assert.equal(shared.parseTicks(ctx, { timecode: "00:01:00;04" }, tb, "in"), 3600n * (F2997 / 2n));
  // A 24 fps clip never takes ';'.
  const tb24 = await shared.clipTimebase(ctx, f.sh20, null);
  assert.throws(() => shared.parseTicks(ctx, { timecode: "00:00:01;00" }, tb24, "in"), badTime);
});
