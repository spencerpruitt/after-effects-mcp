// Helpers shared by the typed command modules. Not a command itself (commands/index.js does not list it).
// Rules every command follows (Premiere 26.3+ docs, "Action creation in locks" + ESLint rules):
//  - all async reads happen BEFORE ctx.transaction;
//  - the transaction callback is synchronous: it creates the actions (create*Action, TickTime, selections)
//    and adds them to the compound action. No await inside it.
"use strict";

const refs = require("../lib/refs.js");
const { TICKS_PER_SECOND } = require("../lib/time.js");

function badArgs(ctx, msg, extra) {
  return ctx.fail("BAD_ARGS", msg, extra);
}

function requireString(ctx, v, name) {
  if (typeof v !== "string" || !v.trim()) throw badArgs(ctx, `${name} must be a non-empty string`);
  return v.trim();
}

function optBool(ctx, v, name, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw badArgs(ctx, `${name} must be true or false`);
  return v;
}

function oneOf(ctx, v, name, allowed, dflt) {
  if (v === undefined || v === null) return dflt;
  if (!allowed.includes(v)) throw badArgs(ctx, `${name} must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}; got ${JSON.stringify(v)}`);
  return v;
}

function extOf(p) {
  const m = /\.([^./\\]+)$/.exec(String(p));
  return m ? m[1].toLowerCase() : "";
}

function isAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) || p.startsWith("/");
}

// ---- time ----

function ticksOf(tt) {
  if (tt == null) return null;
  if (typeof tt === "bigint") return tt;
  if (typeof tt.ticks === "string" && /^-?\d+$/.test(tt.ticks)) return BigInt(tt.ticks);
  if (typeof tt.ticksNumber === "number") return BigInt(Math.round(tt.ticksNumber));
  if (typeof tt.seconds === "number") return BigInt(Math.round(tt.seconds * TICKS_PER_SECOND));
  throw new Error("Cannot read ticks from a TickTime");
}

function tick(ctx, ticks) {
  return ctx.ppro.TickTime.createWithTicks(String(ticks));
}

// Drop-frame from a VideoDisplayFormatType code: true (FPS_29_97), false (FPS_29_97_NON_DROP), or null when the
// code is missing or says nothing about drop-frame (FRAMES, feet+frames, ...).
// SPIKE: verify that 59.94 sequences report the same two codes for DF/NDF.
function dropFrameFromDisplay(ctx, disp) {
  const VDF = ctx.ppro.Constants && ctx.ppro.Constants.VideoDisplayFormatType;
  if (!disp || !VDF) return null;
  if (VDF.FPS_29_97 !== undefined && disp.type === VDF.FPS_29_97) return true;
  if (VDF.FPS_29_97_NON_DROP !== undefined && disp.type === VDF.FPS_29_97_NON_DROP) return false;
  return null;
}

// tb with drop-frame known (true/false) or unknown (null). Unknown at 29.97/59.94 means non-drop, marked with a
// non-enumerable dropFrameUnknown so parseTicks still reads a ";" timecode as drop-frame.
function withDropFrame(ctx, tb, df) {
  if (df === null && !tb.dropFrame && ctx.time.canDrop(tb)) Object.defineProperty(tb, "dropFrameUnknown", { value: true });
  return tb;
}

// Sequence.getTimebase() resolves to ticks-per-frame as a string (live, 26.5.2: "8475667200" at 29.97).
// Drop-frame comes from SequenceSettings.getVideoDisplayFormat(); if that can't be read, non-drop is assumed.
async function sequenceTimebase(ctx, seq) {
  const tpf = await seq.getTimebase();
  let df = null;
  try {
    const settings = await seq.getSettings();
    df = dropFrameFromDisplay(ctx, settings && (await settings.getVideoDisplayFormat()));
  } catch (e) {
    df = null;
  }
  return withDropFrame(ctx, ctx.time.timebaseFromTicksPerFrame(String(tpf), df === true), df);
}

// SPIKE: the 26.5 docs give clips no drop-frame flag (FootageInterpretation only has getFrameRate()). These
// optional probes pick one up if Premiere exposes it (isDropFrame() or a display format like the sequence's);
// otherwise drop-frame is unknown, the clip reads as non-drop, and a ";" timecode is still read as drop-frame.
async function clipDropFrame(ctx, fi) {
  try {
    if (typeof fi.isDropFrame === "function") {
      const v = await fi.isDropFrame();
      if (typeof v === "boolean") return v;
    }
    if (typeof fi.getVideoDisplayFormat === "function") return dropFrameFromDisplay(ctx, await fi.getVideoDisplayFormat());
  } catch (e) {
    /* unknown */
  }
  return null;
}

// The clip's own frame rate (spec 7.1: project-item in/out use it). Falls back to `fallback` for audio-only
// media or when the rate is not readable.
// FootageInterpretation.getFrameRate() returns frames per second as a float (live: 29.97 for 30000/1001 media);
// an audio-only clip gave no usable rate (0, or the sample rate: anything over 1000 fps counts as none).
async function clipTimebase(ctx, clip, fallback) {
  try {
    const fi = await clip.getFootageInterpretation();
    const fps = fi && fi.getFrameRate();
    if (typeof fps === "number" && fps > 0 && fps <= 1000) {
      const df = await clipDropFrame(ctx, fi);
      return withDropFrame(ctx, ctx.time.timebaseFromFps(fps, df === true), df);
    }
  } catch (e) {
    /* fall through */
  }
  if (fallback) return fallback;
  throw ctx.fail("BAD_TIME", "This item has no video frame rate; give times on a sequence instead");
}

function fmt(ctx, ticks, tb) {
  if (ticks == null) return null;
  const f = ctx.time.ticksToFrames(ticks, tb);
  return f >= 0 ? ctx.time.formatTime(f, tb) : { frames: f, timecode: null, seconds: Number(ticks) / TICKS_PER_SECOND };
}

// SPIKE: when drop-frame detection failed (tb.dropFrameUnknown, 29.97/59.94 only), a ";" timecode is taken as
// drop-frame; the frame count is the same in either timebase, only the label differs.
function timebaseForSpec(tb, spec) {
  if (tb && tb.dropFrameUnknown && spec && typeof spec.timecode === "string" && spec.timecode.includes(";")) {
    return Object.assign({}, tb, { dropFrame: true });
  }
  return tb;
}

function parseTicks(ctx, spec, tb, name, opts) {
  try {
    return ctx.time.framesToTicks(ctx.time.parseTime(spec, timebaseForSpec(tb, spec), opts), tb);
  } catch (e) {
    if (e && e.code === "BAD_TIME") throw ctx.fail("BAD_TIME", `${name}: ${e.message}`);
    throw e;
  }
}

// ---- tracks / track items ----

function mediaTypes(ctx) {
  return ctx.ppro.Constants.MediaType;
}

// Returns { type, index0, label, track (or null if it does not exist yet), count }.
async function getTrack(ctx, seq, ref, opts) {
  const o = opts || {};
  const t = refs.parseTrackRef(ctx, ref);
  if (o.expect && t.type !== o.expect) throw badArgs(ctx, `${o.name || "track"} must be a${o.expect === "audio" ? "n audio (A1, A2...)" : " video (V1, V2...)"} track, got ${t.label}`);
  const count = t.type === "video" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
  if (t.index0 >= count) {
    if (o.allowNew && t.index0 === count) return Object.assign(t, { track: null, count });
    throw badArgs(ctx, `Track ${t.label} does not exist (the sequence has ${count} ${t.type} track${count === 1 ? "" : "s"})`);
  }
  const track = t.type === "video" ? await seq.getVideoTrack(t.index0) : await seq.getAudioTrack(t.index0);
  return Object.assign(t, { track, count });
}

// Clip track items on a track, sorted by start: [{ ti, start, end, index }] (ticks as BigInt).
// getTrackItems is not sorted by start, and its lists can hold nulls (live: always for non-CLIP types), so
// nulls are skipped.
async function clipItems(ctx, track) {
  if (!track) return [];
  const raw = track.getTrackItems(ctx.ppro.Constants.TrackItemType.CLIP, false) || [];
  const list = [];
  for (const ti of Array.from(raw)) {
    if (!ti) continue;
    list.push({ ti, start: ticksOf(await ti.getStartTime()), end: ticksOf(await ti.getEndTime()) });
  }
  list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  list.forEach((e, i) => (e.index = i));
  return list;
}

// Picks a clip item by { index } (0-based, as getSequence reports) or { at } (sequence time inside the clip).
function pickItem(ctx, items, sel, tb, label) {
  if (sel.index !== undefined && sel.index !== null) {
    if (!Number.isInteger(sel.index) || sel.index < 0) throw badArgs(ctx, `index must be a 0-based integer, got ${JSON.stringify(sel.index)}`);
    const hit = items[sel.index];
    if (!hit) throw ctx.fail("ITEM_NOT_FOUND", `${label} has no clip at index ${sel.index} (it has ${items.length})`);
    return hit;
  }
  if (sel.at !== undefined) {
    const at = parseTicks(ctx, sel.at, tb, "at");
    const hit = items.find((e) => e.start <= at && at < e.end);
    if (!hit) throw ctx.fail("ITEM_NOT_FOUND", `${label} has no clip at ${JSON.stringify(sel.at)}`);
    return hit;
  }
  throw badArgs(ctx, "Give the clip as index (0-based) or at (a time)");
}

async function projectItemIdOf(ti) {
  try {
    const pi = await ti.getProjectItem();
    return pi ? refs.itemId(pi) : null;
  } catch (e) {
    return null;
  }
}

// UXP exposes no link information. "Partners" of a track item are guessed as clip items on tracks of the other
// media type that start and end at the same tick and use the same project item (what a linked A/V pair looks
// like after placing it). Live (26.5.2): an action on one linked item never touches its partner. Moving or
// trimming the video leaves the audio where it was, and a remove with MediaType.ANY removes only the selected
// item. So partner edits are explicit.
const EXPLICIT_PARTNER_EDITS = true;

async function findPartners(ctx, seq, entry, ownType) {
  const otherVideo = ownType === "audio";
  const n = otherVideo ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
  const pid = await projectItemIdOf(entry.ti);
  const out = [];
  for (let i = 0; i < n; i++) {
    const tr = otherVideo ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i);
    for (const e of await clipItems(ctx, tr)) {
      if (e.start === entry.start && e.end === entry.end && (await projectItemIdOf(e.ti)) === pid) {
        out.push(Object.assign(e, { trackLabel: (otherVideo ? "V" : "A") + (i + 1), type: otherVideo ? "video" : "audio" }));
      }
    }
  }
  return out;
}

// Inside a transaction callback only: adds a remove action for the given track items.
function addRemoveAction(ctx, compound, editor, trackItems, ripple, mediaType) {
  const ok = ctx.ppro.TrackItemSelection.createEmptySelection((sel) => {
    for (const ti of trackItems) sel.addItem(ti, true);
    compound.addAction(editor.createRemoveItemsAction(sel, ripple, mediaType, false));
  });
  if (ok === false) throw new Error("Premiere could not create a track item selection");
}

// ---- project item marks ----

// Live (26.5.2): a project item with no in/out marks reports -400000 s (-101606400000000000 ticks) for both.
// Negative or absurdly large values (over a year) are treated as "unset".
const UNSET_LIMIT = BigInt(TICKS_PER_SECOND) * 86400n * 366n;
function isUnsetTicks(t) {
  return t === null || t === undefined || t < 0n || t >= UNSET_LIMIT;
}

// Project item in/out marks (ticks), video first, then audio (audio-only media). Returns { in, out } with null
// for an unset mark, or null when neither media type can be read.
async function readInOut(ctx, clip) {
  const MT = mediaTypes(ctx);
  for (const mt of [MT.VIDEO, MT.AUDIO]) {
    try {
      const i = await clip.getInPoint(mt);
      const o = await clip.getOutPoint(mt);
      if (i != null && o != null) {
        const it = ticksOf(i);
        const ot = ticksOf(o);
        return { in: isUnsetTicks(it) ? null : it, out: isUnsetTicks(ot) ? null : ot };
      }
    } catch (e) {
      /* try the next media type */
    }
  }
  return null;
}

// Media duration in ticks (ClipProjectItem.getMedia().getDuration()), or null.
async function mediaDuration(clip) {
  try {
    const media = typeof clip.getMedia === "function" ? await clip.getMedia() : null;
    const d = media && typeof media.getDuration === "function" ? ticksOf(await media.getDuration()) : null;
    return d !== null && d > 0n && !isUnsetTicks(d) ? d : null;
  } catch (e) {
    return null;
  }
}

// Spacing used when nothing tells how long a clip will land (no marks, no media duration): one hour.
const UNKNOWN_LENGTH = BigInt(TICKS_PER_SECOND) * 3600n;

// Prepares a placement: resolves the requested in/out (clip's own timebase, media time from the media start) and
// estimates how long the clip lands when placed untrimmed. Returns { entry, inT, outT, estFull, estDur }, where
// inT/outT are null when not requested (the placed clip keeps what Premiere gives it).
async function preparePlacement(ctx, ref, inSpec, outSpec, seqTb) {
  const entry = await refs.resolveItem(ctx, ref, { kinds: ["clip", "sequence"] });
  const marks = (await readInOut(ctx, entry.clip)) || { in: null, out: null };
  const marked = marks.in !== null && marks.out !== null && marks.out > marks.in;
  const mediaDur = await mediaDuration(entry.clip);
  const needTb = inSpec !== undefined || outSpec !== undefined;
  const ctb = needTb ? await clipTimebase(ctx, entry.clip, seqTb) : null;
  const inT = inSpec !== undefined && inSpec !== null ? parseTicks(ctx, inSpec, ctb, "in") : null;
  const outT = outSpec !== undefined && outSpec !== null ? parseTicks(ctx, outSpec, ctb, "out") : null;
  const baseIn = marked ? marks.in : 0n;
  const baseOut = marked ? marks.out : mediaDur;
  const effIn = inT !== null ? inT : baseIn;
  const effOut = outT !== null ? outT : baseOut;
  if (effOut !== null && effOut <= effIn) throw ctx.fail("BAD_TIME", `out must be after in for "${entry.path}"`);
  if (mediaDur !== null && effOut !== null && effOut > mediaDur) {
    throw ctx.fail("BAD_TIME", `out is past the end of the media for "${entry.path}" (${fmt(ctx, mediaDur, ctb || seqTb).timecode || mediaDur + " ticks"})`);
  }
  const estFull = marked ? marks.out - marks.in : mediaDur !== null ? mediaDur : UNKNOWN_LENGTH;
  const estDur = effOut !== null ? effOut - effIn : estFull;
  return { entry, inT, outT, estFull, estDur };
}

function alignToFrame(ctx, ticks, tb) {
  return ctx.time.framesToTicks(ctx.time.ticksToFrames(ticks, tb), tb);
}

async function readTimes(ti) {
  return {
    start: ticksOf(await ti.getStartTime()),
    end: ticksOf(await ti.getEndTime()),
    in: ticksOf(await ti.getInPoint()),
    out: ticksOf(await ti.getOutPoint()),
  };
}

function fmtTimes(ctx, t, tb) {
  return t ? { start: fmt(ctx, t.start, tb), end: fmt(ctx, t.end, tb), in: fmt(ctx, t.in, tb), out: fmt(ctx, t.out, tb) } : null;
}

async function itemStartingAt(ctx, track, start) {
  const items = await clipItems(ctx, track);
  const hit = items.find((e) => e.start === start);
  return hit ? hit.ti : null;
}

// Places clips by overwrite and trims them on the timeline. Live (26.5.2): an overwrite/insert places the project
// item full length (or between its marks); setting the project item's in/out in the same compound action does
// not change that. So:
//   1. one transaction: o.before actions (e.g. clearing a track), then every clip overwritten full length, parked
//      past the sequence end and past every target, spaced so nothing overlaps;
//   2. one transaction: track-item edge trims (createSetInPointAction moves the head: start and in together;
//      createSetOutPointAction moves the tail), the unwanted half removed (keepVideo/keepAudio false), and the
//      move to the target start (createMoveAction is relative);
//   3. only when needed: the moves Premiere refuses to create in step 2. It rejects a move whose result would
//      start before 0, judged against the clip as it is when the action is created (before the head trim), so
//      a clip whose target is earlier than its head trim moves in a transaction of its own.
// Linked audio is trimmed and moved explicitly: actions on one linked item never touch its partner.
// o: { name, placements: [prepared], vIdx, aIdx, keepVideo, keepAudio, layout(durs) -> target starts, before(compound)? }
// Returns { placed: [{ p, target, dur, times }], mismatches }.
async function placeAndTrim(ctx, seq, tb, o) {
  const editor = ctx.ppro.SequenceEditor.getEditor(seq);
  const ps = o.placements;
  const margin = alignToFrame(ctx, BigInt(TICKS_PER_SECOND), tb);
  const estTargets = o.layout(ps.map((p) => alignToFrame(ctx, p.estDur, tb)));
  let park = ticksOf(await seq.getEndTime()) || 0n;
  ps.forEach((p, k) => {
    const end = estTargets[k] + p.estDur;
    if (end > park) park = end;
  });
  park = alignToFrame(ctx, park + margin, tb);
  for (const p of ps) {
    p.park = park;
    park = alignToFrame(ctx, park + p.estFull + margin, tb);
  }

  await ctx.transaction(`${o.name} (place ${ps.length} clip${ps.length === 1 ? "" : "s"})`, (compound) => {
    if (o.before) o.before(compound);
    // Every action is created before any is added, so a refused creation leaves nothing half applied.
    const acts = ps.map((p) => editor.createOverwriteItemAction(p.entry.item, tick(ctx, p.park), o.vIdx, o.aIdx));
    for (const a of acts) compound.addAction(a);
  });

  const vTrack = o.vIdx < (await seq.getVideoTrackCount()) ? await seq.getVideoTrack(o.vIdx) : null;
  const aTrack = o.aIdx < (await seq.getAudioTrackCount()) ? await seq.getAudioTrack(o.aIdx) : null;
  const mismatches = [];
  for (const p of ps) {
    p.v = vTrack ? await itemStartingAt(ctx, vTrack, p.park) : null;
    p.a = aTrack ? await itemStartingAt(ctx, aTrack, p.park) : null;
    const primary = (o.keepVideo && p.v) || (o.keepAudio && p.a) || p.v || p.a;
    if (!primary) {
      mismatches.push({ item: p.entry.path, problem: "Premiere did not place the clip" });
      continue;
    }
    const t = await readTimes(primary);
    p.in0 = t.in;
    p.out0 = t.out;
    p.in = p.inT !== null ? p.inT : t.in;
    p.out = p.outT !== null ? p.outT : t.out;
    p.dur = ctx.time.framesToTicks(ctx.time.ticksToFrames(p.out - p.in, tb), tb);
  }
  if (mismatches.length) return { placed: [], mismatches };
  const targets = o.layout(ps.map((p) => p.dur));
  ps.forEach((p, k) => (p.target = targets[k]));

  const deferred = [];
  const drop = [];
  const trims = [];
  for (const p of ps) {
    const subjects = [];
    if (p.v) (o.keepVideo ? subjects : drop).push(p.v);
    if (p.a) (o.keepAudio ? subjects : drop).push(p.a);
    const delta = p.target - (p.park + (p.in - p.in0));
    for (const ti of subjects) {
      trims.push({ ti, in: p.in !== p.in0 ? p.in : null, out: p.out !== p.out0 ? p.out : null, delta: delta !== 0n && p.park + delta >= 0n ? delta : null });
      if (delta !== 0n && p.park + delta < 0n) deferred.push({ ti, delta });
    }
  }
  if (trims.some((t) => t.in !== null || t.out !== null || t.delta !== null) || drop.length) {
    await ctx.transaction(`${o.name} (trim and move)`, (compound) => {
      const acts = [];
      for (const t of trims) {
        if (t.in !== null) acts.push(t.ti.createSetInPointAction(tick(ctx, t.in)));
        if (t.out !== null) acts.push(t.ti.createSetOutPointAction(tick(ctx, t.out)));
        if (t.delta !== null) acts.push(t.ti.createMoveAction(tick(ctx, t.delta)));
      }
      for (const a of acts) compound.addAction(a);
      if (drop.length) addRemoveAction(ctx, compound, editor, drop, false, mediaTypes(ctx).ANY);
    });
  }
  if (deferred.length) {
    await ctx.transaction(`${o.name} (move into place)`, (compound) => {
      const acts = deferred.map((d) => d.ti.createMoveAction(tick(ctx, d.delta)));
      for (const a of acts) compound.addAction(a);
    });
  }

  const placed = [];
  for (const p of ps) {
    const expected = { start: p.target, end: p.target + p.dur, in: p.in, out: p.out };
    const kept = [];
    if (o.keepVideo && p.v) kept.push(["video", p.v]);
    if (o.keepAudio && p.a) kept.push(["audio", p.a]);
    let times = null;
    for (const [media, ti] of kept) {
      const t = await readTimes(ti);
      if (!times) times = t;
      if (t.start !== expected.start || t.end !== expected.end || t.in !== expected.in || t.out !== expected.out) {
        mismatches.push({ item: p.entry.path, media, expected: fmtTimes(ctx, expected, tb), actual: fmtTimes(ctx, t, tb) });
      }
    }
    placed.push({ p, target: p.target, dur: p.dur, times: times || expected });
  }
  return { placed, mismatches };
}

module.exports = {
  readInOut,
  preparePlacement,
  isUnsetTicks,
  mediaDuration,
  placeAndTrim,
  readTimes,
  fmtTimes,
  alignToFrame,
  refs,
  badArgs,
  requireString,
  optBool,
  oneOf,
  extOf,
  isAbsolute,
  ticksOf,
  tick,
  sequenceTimebase,
  clipTimebase,
  fmt,
  parseTicks,
  mediaTypes,
  getTrack,
  clipItems,
  pickItem,
  projectItemIdOf,
  findPartners,
  addRemoveAction,
  EXPLICIT_PARTNER_EDITS,
};
