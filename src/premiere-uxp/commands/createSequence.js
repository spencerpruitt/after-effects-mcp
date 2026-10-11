"use strict";
const shared = require("./_shared.js");

module.exports = {
  name: "createSequence",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const name = shared.requireString(ctx, a.name, "name");
    const hasPreset = a.preset !== undefined && a.preset !== null;
    const hasClips = a.fromClips !== undefined && a.fromClips !== null;
    if (hasPreset && hasClips) throw shared.badArgs(ctx, "Give either preset or fromClips, not both");
    let preset = null;
    if (hasPreset) {
      preset = shared.requireString(ctx, a.preset, "preset");
      if (shared.extOf(preset) !== "sqpreset") throw shared.badArgs(ctx, `preset must be a .sqpreset file, got "${preset}"`);
      if (!(await ctx.pathExists(preset))) throw ctx.fail("FILE_NOT_FOUND", `No sequence preset at "${preset}"`);
    }
    let clips = null;
    if (hasClips) {
      if (!Array.isArray(a.fromClips) || !a.fromClips.length) throw shared.badArgs(ctx, "fromClips must be a non-empty array of item references");
      clips = [];
      for (const ref of a.fromClips) clips.push(await shared.refs.resolveItem(ctx, ref, { kinds: ["clip"] }));
    }
    const wantBin = a.bin !== undefined && a.bin !== null && a.bin !== "";
    const binInfo = wantBin ? await shared.refs.resolveBin(ctx, a.bin, { create: true }) : null;

    const project = ctx.project;
    let seq;
    // Sequence creation calls are not Actions. createSequenceFromMedia opened no dialog live (26.5.2).
    // SPIKE: the docs don't say whether they add an undo step; each is counted as one in undoSteps.
    if (clips) {
      const target = binInfo ? binInfo.bin : await shared.refs.getRoot(ctx);
      seq = await project.createSequenceFromMedia(name, clips.map((c) => c.clip), target);
    } else if (preset) {
      // createSequence(name, presetPath) is deprecated since 26.3 in favour of createSequenceWithPresetPath.
      seq = typeof project.createSequenceWithPresetPath === "function" ? await project.createSequenceWithPresetPath(name, preset) : await project.createSequence(name, preset);
    } else {
      seq = await project.createSequence(name);
    }
    if (!seq) throw new Error(`Premiere did not create sequence "${name}"`);
    ctx.noteUndoStep();

    const seqItem = await seq.getProjectItem();
    if (binInfo && !clips && seqItem) {
      const dest = binInfo.bin;
      // FolderItem.createMoveItemAction(item, newParent), called on the destination bin, moved the new sequence
      // into it live (26.5.2).
      await ctx.transaction(`move sequence ${name}`, (compound) => {
        compound.addAction(dest.createMoveItemAction(seqItem, dest));
      });
    }
    const tb = await shared.sequenceTimebase(ctx, seq);
    return {
      name: seq.name || name,
      guid: shared.refs.guidString(seq.guid),
      id: seqItem ? shared.refs.itemId(seqItem) : null,
      path: shared.refs.joinPath(binInfo ? binInfo.path : "", seq.name || name),
      binsCreated: binInfo ? binInfo.created : [],
      timebase: tb,
    };
  },
};
