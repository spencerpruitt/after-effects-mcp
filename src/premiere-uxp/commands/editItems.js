"use strict";
const shared = require("./_shared.js");

// Track-item action semantics, measured live (Premiere 26.5.2, 30000/1001 sequence):
//  - createSetInPointAction(t) / createSetStartAction(t) are HEAD trims: start and in move together, the end
//    stays. From {start 90, end 209, in 0, out 119}: setIn(15) -> start 105, in 15; setStart(100) on
//    {start 105, in 15} -> start 100, in 10.
//  - createSetOutPointAction(t) / createSetEndAction(t) are TAIL trims: end and out move together, the start
//    stays. setOut(100) -> end 190, out 100; setEnd(160) -> end 160, out 70.
//  - createMoveAction(t) shifts by t (relative). Premiere refuses to CREATE a move whose result would start
//    before 0, judged against the item as it is at creation (before earlier actions in the same compound run),
//    and silently skips one that lands before 0 when it runs.
//  - An action on one linked item never touches its partner (moves, trims, removes with MediaType.ANY), so
//    mediaType "both" edits the partner explicitly.
// All actions of a transaction are created before any is added, so a refused creation leaves nothing applied.

const OPS = ["move", "trim", "slip", "remove", "enable", "disable"];
const TIMING = new Set(["move", "trim", "slip"]);
const MEDIA = ["video", "audio", "both"];

function given(v) {
  return v !== undefined && v !== null;
}

module.exports = {
  name: "editItems",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    if (!Array.isArray(a.edits) || !a.edits.length) throw shared.badArgs(ctx, "edits must be a non-empty array");
    const ripple = shared.optBool(ctx, a.ripple, "ripple", false);
    const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
    const tb = await shared.sequenceTimebase(ctx, seq);
    const MT = shared.mediaTypes(ctx);
    const trackCache = new Map();
    const timed = new Set(); // track items that already have a move/trim/slip in this call

    // ---- resolve everything first (async), build plain edit plans ----
    const plans = [];
    for (let i = 0; i < a.edits.length; i++) {
      const ed = a.edits[i];
      const where = `edits[${i}]`;
      if (!ed || typeof ed !== "object") throw shared.badArgs(ctx, `${where} must be an object`);
      const op = shared.oneOf(ctx, ed.op, `${where}.op`, OPS, undefined);
      if (!op) throw shared.badArgs(ctx, `${where}.op is required (${OPS.join(", ")})`);
      const mediaType = shared.oneOf(ctx, ed.mediaType, `${where}.mediaType`, MEDIA, "both");
      // TrackItem.createMoveAction(tickTime) only shifts the item; it has no ripple/shift option, so a ripple
      // move can't be done in UXP. Only removes ripple (createRemoveItemsAction's ripple flag).
      if (ripple && op === "move") throw shared.badArgs(ctx, `${where}: ripple is not available for move (UXP's move action cannot ripple); send the move without ripple`);
      const trackKey = shared.refs.parseTrackRef(ctx, ed.track).label;
      if (!trackCache.has(trackKey)) {
        const t = await shared.getTrack(ctx, seq, ed.track);
        trackCache.set(trackKey, { t, items: await shared.clipItems(ctx, t.track) });
      }
      const { t, items } = trackCache.get(trackKey);
      const target = shared.pickItem(ctx, items, ed, tb, t.label);
      const plan = { op, where, mediaType, track: t.label, type: t.type, target, ripple };
      if (mediaType !== "both" && mediaType !== t.type) {
        throw shared.badArgs(ctx, `${where}: mediaType "${mediaType}" does not match track ${t.label}; address the ${mediaType} item on its own track`);
      }
      // The addressed item plus (for "both") its linked partners.
      plan.subjects = [target];
      if (mediaType === "both" && shared.EXPLICIT_PARTNER_EDITS) plan.subjects.push(...(await shared.findPartners(ctx, seq, target, t.type)));
      if (TIMING.has(op)) {
        if (timed.has(target.ti)) throw shared.badArgs(ctx, `${where}: this clip already has a move, trim or slip in this call; send one timing edit per clip per call`);
        timed.add(target.ti);
      }

      if (op === "move") {
        if (given(ed.to) === given(ed.delta)) throw shared.badArgs(ctx, `${where}: move needs exactly one of to (a time) or delta (signed {frames})`);
        plan.delta = given(ed.to) ? shared.parseTicks(ctx, ed.to, tb, `${where}.to`) - target.start : shared.parseTicks(ctx, ed.delta, tb, `${where}.delta`, { allowNegative: true });
        if (target.start + plan.delta < 0n) throw ctx.fail("BAD_TIME", `${where}: the move would put the clip before the sequence start`);
      } else if (op === "trim") {
        const pi = await target.ti.getProjectItem();
        const ctb = pi ? await shared.clipTimebase(ctx, shared.refs.asClip(ctx, pi), tb) : tb;
        const f = {};
        if (given(ed.start)) f.start = shared.parseTicks(ctx, ed.start, tb, `${where}.start`);
        if (given(ed.end)) f.end = shared.parseTicks(ctx, ed.end, tb, `${where}.end`);
        if (given(ed.in)) f.in = shared.parseTicks(ctx, ed.in, ctb, `${where}.in`);
        if (given(ed.out)) f.out = shared.parseTicks(ctx, ed.out, ctb, `${where}.out`);
        if (!Object.keys(f).length) throw shared.badArgs(ctx, `${where}: trim needs at least one of start, end, in, out`);
        if (f.start !== undefined && f.in !== undefined) throw shared.badArgs(ctx, `${where}: start and in both trim the head (start and in move together); give one`);
        if (f.end !== undefined && f.out !== undefined) throw shared.badArgs(ctx, `${where}: end and out both trim the tail (end and out move together); give one`);
        const cur = await shared.readTimes(target.ti);
        const head = f.start !== undefined ? f.start - cur.start : f.in !== undefined ? f.in - cur.in : 0n;
        const tail = f.end !== undefined ? f.end - cur.end : f.out !== undefined ? f.out - cur.out : 0n;
        const exp = { start: cur.start + head, end: cur.end + tail, in: cur.in + head, out: cur.out + tail };
        if (exp.end <= exp.start) throw ctx.fail("BAD_TIME", `${where}: end must be after start`);
        if (exp.start < 0n) throw ctx.fail("BAD_TIME", `${where}: the trim would put the clip before the sequence start`);
        if (exp.in < 0n) throw ctx.fail("BAD_TIME", `${where}: the trim would move the in point before the media start`);
        const dur = pi ? await shared.mediaDuration(shared.refs.asClip(ctx, pi)) : null;
        if (dur !== null && exp.out > dur) throw ctx.fail("BAD_TIME", `${where}: the trim would move the out point past the media end`);
        plan.fields = f;
      } else if (op === "slip") {
        if (!given(ed.delta)) throw shared.badArgs(ctx, `${where}: slip needs delta (signed {frames})`);
        const pi = await target.ti.getProjectItem();
        const clip = pi ? shared.refs.asClip(ctx, pi) : null;
        const ctb = clip ? await shared.clipTimebase(ctx, clip, tb) : tb;
        plan.delta = shared.parseTicks(ctx, ed.delta, ctb, `${where}.delta`, { allowNegative: true });
        const dur = clip ? await shared.mediaDuration(clip) : null;
        plan.inOut = [];
        for (const s of plan.subjects) {
          const cur = await shared.readTimes(s.ti);
          if (cur.in + plan.delta < 0n) throw ctx.fail("BAD_TIME", `${where}: slip would move the in point before the media start`);
          if (dur !== null && cur.out + plan.delta > dur) throw ctx.fail("BAD_TIME", `${where}: slip would move the out point past the media end`);
          plan.inOut.push({ ti: s.ti, start: cur.start, in: cur.in + plan.delta, out: cur.out + plan.delta });
        }
      }
      plans.push(plan);
    }

    // ---- one transaction, synchronous: create every action inside the lock, then add them ----
    // A slip keeps start and end and shifts the media: setIn(in+d), setOut(out+d) and move(-d), ordered so the
    // clip never overlaps a neighbour on the way (d > 0: head trim, move left, tail extend; d < 0: tail trim,
    // move right, head extend). A slip with d > 0 of a clip starting less than d from 0 can't create its move
    // until the head trim has happened, so its move and tail extend go in a second transaction.
    const editor = ctx.ppro.SequenceEditor.getEditor(seq);
    const removes = plans.filter((p) => p.op === "remove");
    const deferred = [];
    await ctx.transaction(`edit items (${plans.length})`, (compound) => {
      const acts = [];
      for (const p of plans) {
        if (p.op === "move") {
          for (const s of p.subjects) acts.push(s.ti.createMoveAction(shared.tick(ctx, p.delta)));
        } else if (p.op === "trim") {
          for (const s of p.subjects) {
            if (p.fields.start !== undefined) acts.push(s.ti.createSetStartAction(shared.tick(ctx, p.fields.start)));
            if (p.fields.in !== undefined) acts.push(s.ti.createSetInPointAction(shared.tick(ctx, p.fields.in)));
            if (p.fields.end !== undefined) acts.push(s.ti.createSetEndAction(shared.tick(ctx, p.fields.end)));
            if (p.fields.out !== undefined) acts.push(s.ti.createSetOutPointAction(shared.tick(ctx, p.fields.out)));
          }
        } else if (p.op === "slip") {
          const d = p.delta;
          for (const io of p.inOut) {
            if (d > 0n && io.start - d >= 0n) {
              acts.push(io.ti.createSetInPointAction(shared.tick(ctx, io.in)), io.ti.createMoveAction(shared.tick(ctx, -d)), io.ti.createSetOutPointAction(shared.tick(ctx, io.out)));
            } else if (d > 0n) {
              acts.push(io.ti.createSetInPointAction(shared.tick(ctx, io.in)));
              deferred.push(io);
            } else if (d < 0n) {
              acts.push(io.ti.createSetOutPointAction(shared.tick(ctx, io.out)), io.ti.createMoveAction(shared.tick(ctx, -d)), io.ti.createSetInPointAction(shared.tick(ctx, io.in)));
            }
          }
        } else if (p.op === "enable" || p.op === "disable") {
          for (const s of p.subjects) acts.push(s.ti.createSetDisabledAction(p.op === "disable"));
        }
      }
      for (const x of acts) compound.addAction(x);
      // Removes last, so the other edits apply to the layout the caller saw. mediaType "both" removes the
      // partners too (live: a remove with MediaType.ANY takes only the selected item); "audio"/"video" removes
      // only the addressed item.
      for (const p of removes) {
        const mt = p.mediaType === "both" ? MT.ANY : p.mediaType === "audio" ? MT.AUDIO : MT.VIDEO;
        shared.addRemoveAction(ctx, compound, editor, p.subjects.map((s) => s.ti), p.ripple, mt);
      }
    });
    if (deferred.length) {
      const slipOf = new Map(plans.filter((p) => p.op === "slip").flatMap((p) => p.inOut.map((io) => [io, p.delta])));
      await ctx.transaction("edit items (finish slips)", (compound) => {
        const acts = [];
        for (const io of deferred) acts.push(io.ti.createMoveAction(shared.tick(ctx, -slipOf.get(io))), io.ti.createSetOutPointAction(shared.tick(ctx, io.out)));
        for (const x of acts) compound.addAction(x);
      });
    }

    const applied = [];
    for (const p of plans) {
      const entry = {
        op: p.op,
        track: p.track,
        index: p.target.index,
        start: shared.fmt(ctx, p.target.start, tb),
        mediaType: p.mediaType,
        partners: Math.max(0, p.subjects.length - 1),
        ripple: p.op === "remove" ? p.ripple : undefined,
      };
      // What Premiere reports for the addressed clip after the edit.
      if (p.op !== "remove") entry.after = shared.fmtTimes(ctx, await shared.readTimes(p.target.ti), tb);
      applied.push(entry);
    }
    return {
      sequence: seq.name,
      applied,
      note: "Indexes refer to the layout before this call; call premiere-get-sequence for the new layout.",
    };
  },
};
