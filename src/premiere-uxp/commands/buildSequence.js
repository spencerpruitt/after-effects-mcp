"use strict";
const shared = require("./_shared.js");

// Places clips end to end on a video track, trimmed to the requested in/out. See shared.placeAndTrim for the
// mechanics (live 26.5.2: clips land full length, so they are trimmed on the timeline afterwards). Undo steps:
// one for placing (and clearing, in replace mode), one for trimming and moving, and one more only when a clip's
// target is earlier than its head trim (Premiere refuses that move until the trim has happened).
module.exports = {
  name: "buildSequence",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const mode = shared.oneOf(ctx, a.mode, "mode", ["append", "replace"], undefined);
    if (!mode) throw shared.badArgs(ctx, 'mode must be "append" or "replace"');
    const withAudio = shared.optBool(ctx, a.withAudio, "withAudio", true);
    if (!Array.isArray(a.clips) || !a.clips.length) throw shared.badArgs(ctx, "clips must be a non-empty array of {item, in?, out?, gapBefore?}");
    const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
    const tb = await shared.sequenceTimebase(ctx, seq);
    const track = await shared.getTrack(ctx, seq, a.track || "V1", { expect: "video", allowNew: true, name: "track" });
    const existing = await shared.clipItems(ctx, track.track);

    const placements = [];
    const gaps = [];
    for (let i = 0; i < a.clips.length; i++) {
      const c = a.clips[i];
      if (!c || typeof c !== "object") throw shared.badArgs(ctx, `clips[${i}] must be an object with an item`);
      placements.push(await shared.preparePlacement(ctx, c.item, c.in, c.out, tb));
      gaps.push(c.gapBefore !== undefined && c.gapBefore !== null ? shared.parseTicks(ctx, c.gapBefore, tb, `clips[${i}].gapBefore`) : 0n);
    }
    const start0 = mode === "replace" ? 0n : shared.alignToFrame(ctx, existing.reduce((m, e) => (e.end > m ? e.end : m), 0n), tb);
    const layout = (durs) => {
      const out = [];
      let cursor = start0;
      durs.forEach((d, k) => {
        cursor = shared.alignToFrame(ctx, cursor + gaps[k], tb);
        out.push(cursor);
        cursor += d;
      });
      return out;
    };

    // Replace clears the track's clips and their linked audio (a remove with MediaType.ANY takes only the
    // selected item, live 26.5.2).
    const toClear = [];
    if (mode === "replace") {
      for (const e of existing) {
        toClear.push(e.ti);
        for (const pt of await shared.findPartners(ctx, seq, e, "video")) toClear.push(pt.ti);
      }
    }
    const editor = ctx.ppro.SequenceEditor.getEditor(seq);
    const MT = shared.mediaTypes(ctx);
    // Linked audio goes to the audio track with the same number (V1 -> A1).
    const { placed, mismatches } = await shared.placeAndTrim(ctx, seq, tb, {
      name: `build sequence (${mode})`,
      placements,
      vIdx: track.index0,
      aIdx: track.index0,
      keepVideo: true,
      keepAudio: withAudio,
      layout,
      before: toClear.length ? (compound) => shared.addRemoveAction(ctx, compound, editor, toClear, false, MT.ANY) : null,
    });

    const after = await shared.clipItems(ctx, await seq.getVideoTrack(track.index0));
    const list = placed.map(({ p, target, dur }) => {
      const hit = after.find((e) => e.start === target);
      return { item: p.entry.path, id: p.entry.id, index: hit ? hit.index : null, start: shared.fmt(ctx, target, tb), end: shared.fmt(ctx, target + dur, tb) };
    });
    if (mismatches.length) {
      throw ctx.fail("VERIFY_FAILED", `Premiere did not place ${mismatches.length === 1 ? "a clip" : "some clips"} as asked (see mismatches). Undo the reported undo steps or restore the backup.`, {
        sequence: seq.name,
        placed: list,
        mismatches,
      });
    }
    const last = placed[placed.length - 1];
    return {
      sequence: seq.name,
      track: track.label,
      mode,
      placed: list,
      trackEnd: shared.fmt(ctx, last.target + last.dur, tb),
      verified: true,
      audioRemoved: withAudio ? 0 : placed.filter(({ p }) => p.a).length,
    };
  },
};
