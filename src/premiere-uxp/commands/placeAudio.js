"use strict";
const shared = require("./_shared.js");

module.exports = {
  name: "placeAudio",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const mode = shared.oneOf(ctx, a.mode, "mode", ["overwrite", "insert"], "overwrite");
    if (a.at === undefined || a.at === null) throw shared.badArgs(ctx, "at (a time) is required");
    const trimmed = (a.in !== undefined && a.in !== null) || (a.out !== undefined && a.out !== null);
    // Live (26.5.2): an insert lands full length and ripples later clips by that length; trimming it afterwards
    // would leave a gap, and UXP has no ripple trim.
    if (mode === "insert" && trimmed) throw shared.badArgs(ctx, 'mode "insert" cannot take in/out (UXP inserts full length and has no ripple trim); use mode "overwrite", or set the clip\'s marks first');
    const { sequence: seq } = await shared.refs.resolveSequence(ctx, a.sequence);
    const tb = await shared.sequenceTimebase(ctx, seq);
    const track = await shared.getTrack(ctx, seq, a.track || "A1", { expect: "audio", allowNew: true, name: "track" });
    const start = shared.alignToFrame(ctx, shared.parseTicks(ctx, a.at, tb, "at"), tb);
    const p = await shared.preparePlacement(ctx, a.item, a.in, a.out, tb);

    if (mode === "insert") {
      const editor = ctx.ppro.SequenceEditor.getEditor(seq);
      // SPIKE: videoTrackIndex 0 is passed; for media that also has video, its video is inserted on V1 too.
      await ctx.transaction(`place audio ${p.entry.name} (insert)`, (compound) => {
        const act = editor.createInsertProjectItemAction(p.entry.item, shared.tick(ctx, start), 0, track.index0, false);
        compound.addAction(act);
      });
      const after = await shared.clipItems(ctx, await seq.getAudioTrack(track.index0));
      const hit = after.find((e) => e.start === start);
      if (!hit) throw ctx.fail("VERIFY_FAILED", "Premiere did not insert the clip where asked.", { sequence: seq.name, mismatches: [{ item: p.entry.path, problem: "no clip at the insert point" }] });
      return { sequence: seq.name, track: track.label, mode, item: p.entry.path, index: hit.index, start: shared.fmt(ctx, start, tb), end: shared.fmt(ctx, hit.end, tb), verified: true };
    }

    // Overwrite: placed full length past the sequence end, trimmed, moved to `at` (shared.placeAndTrim). Any video
    // the media brings (it lands on V1) is removed.
    const { placed, mismatches } = await shared.placeAndTrim(ctx, seq, tb, {
      name: `place audio ${p.entry.name}`,
      placements: [p],
      vIdx: 0,
      aIdx: track.index0,
      keepVideo: false,
      keepAudio: true,
      layout: () => [start],
    });
    const at = await shared.clipItems(ctx, await seq.getAudioTrack(track.index0));
    const hit = placed.length ? at.find((e) => e.start === start) : null;
    const end = placed.length ? start + placed[0].dur : null;
    if (mismatches.length) {
      throw ctx.fail("VERIFY_FAILED", "Premiere did not place the audio as asked (see mismatches). Undo the reported undo steps or restore the backup.", { sequence: seq.name, mismatches });
    }
    return {
      sequence: seq.name,
      track: track.label,
      mode,
      item: p.entry.path,
      index: hit ? hit.index : null,
      start: shared.fmt(ctx, start, tb),
      end: shared.fmt(ctx, end, tb),
      verified: true,
    };
  },
};
