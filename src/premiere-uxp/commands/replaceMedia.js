"use strict";
const shared = require("./_shared.js");

module.exports = {
  name: "replaceMedia",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const newFile = shared.requireString(ctx, a.newFile, "newFile");
    if (!shared.isAbsolute(newFile)) throw shared.badArgs(ctx, `newFile must be an absolute path, got "${newFile}"`);
    const keepTrims = shared.optBool(ctx, a.keepTrims, "keepTrims", true);
    const rename = a.rename === undefined || a.rename === null ? null : shared.requireString(ctx, a.rename, "rename");
    const entry = await shared.refs.resolveItem(ctx, a.item, { kinds: ["clip"] });
    if (!(await ctx.pathExists(newFile))) throw ctx.fail("FILE_NOT_FOUND", `No file at "${newFile}"`);
    const clip = entry.clip;
    if (!(await clip.canChangeMediaPath())) throw ctx.fail("UNSUPPORTED", `Premiere cannot change the media path of "${entry.path}"`);
    const previousMediaPath = await clip.getMediaFilePath();
    const before = await shared.readInOut(ctx, clip);

    // Docs: changeMediaFilePath is NOT undoable (so it adds no undo step). Live (26.5.2): every timeline use
    // follows the project item and keeps its timeline trims (in/out/start/end unchanged, even when the new media
    // is longer); overrideCompatibilityCheck=false accepted a same-format file of another length. A path that
    // does not exist returns false rather than throwing.
    const ok = await clip.changeMediaFilePath(newFile, false);
    if (!ok) throw new Error(`Premiere refused to relink "${entry.path}" to "${newFile}" (incompatible media?)`);

    // Unset marks read as -400000 s (null here) and are never "restored".
    const after = await shared.readInOut(ctx, clip);
    const marked = !!(before && before.in !== null && before.out !== null);
    const restore = !!(keepTrims && marked && after && (before.in !== after.in || before.out !== after.out));
    if (restore || rename) {
      await ctx.transaction(`replace media ${entry.name}`, (compound) => {
        const acts = [];
        if (restore) acts.push(clip.createSetInOutPointsAction(shared.tick(ctx, before.in), shared.tick(ctx, before.out)));
        if (rename) acts.push(clip.createSetNameAction(rename));
        for (const x of acts) compound.addAction(x);
      });
    }
    let tb = null;
    try {
      tb = await shared.clipTimebase(ctx, clip, null);
    } catch (e) {
      tb = null;
    }
    const show = (t) => (t == null ? null : tb ? shared.fmt(ctx, t, tb) : { seconds: Number(t) / ctx.time.TICKS_PER_SECOND });
    return {
      id: entry.id,
      path: rename ? shared.refs.joinPath(entry.parentPath, rename) : entry.path,
      mediaPath: newFile,
      previousMediaPath,
      trims: before ? { in: show(before.in), out: show(before.out) } : null,
      trimsRestored: restore,
      renamed: !!rename,
      notes: ["The relink itself is not undoable in Premiere; the pre-run backup is the rollback."],
    };
  },
};
