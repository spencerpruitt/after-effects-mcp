"use strict";
const shared = require("./_shared.js");

module.exports = {
  name: "importFiles",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    if (!Array.isArray(a.files) || !a.files.length) throw shared.badArgs(ctx, "files must be a non-empty array of absolute paths");
    const files = a.files.map((f, i) => shared.requireString(ctx, f, `files[${i}]`));
    for (const f of files) if (!shared.isAbsolute(f)) throw shared.badArgs(ctx, `files must be absolute paths, got "${f}"`);
    const skipExisting = shared.optBool(ctx, a.skipExisting, "skipExisting", true);
    if (a.bin !== undefined && a.bin !== null && typeof a.bin !== "string") throw shared.badArgs(ctx, "bin must be a path string");
    const missing = [];
    for (const f of files) if (!(await ctx.pathExists(f))) missing.push(f);
    if (missing.length) throw ctx.fail("FILE_NOT_FOUND", `${missing.length} file(s) not found: ${missing.join(", ")}`, { missing });

    // Media already in the project (anywhere), by normalized media path.
    const known = new Map();
    if (skipExisting) {
      for (const e of await shared.refs.walk(ctx, await shared.refs.getRoot(ctx))) {
        if (e.kind !== "clip") continue;
        const mp = await shared.refs.mediaPathOf(ctx, e);
        const n = mp && shared.refs.normalizeMediaPath(mp);
        if (n && !known.has(n)) known.set(n, e);
      }
    }
    const toImport = [];
    const skipped = [];
    const seen = new Set();
    for (const f of files) {
      const n = shared.refs.normalizeMediaPath(f);
      if (seen.has(n)) continue;
      seen.add(n);
      const hit = known.get(n);
      if (hit) skipped.push({ file: f, path: hit.path, id: hit.id, reason: "already in project" });
      else toImport.push(f);
    }

    // Bins are created only when something will be imported into them.
    let binInfo = { bin: null, path: "", created: [] };
    if (toImport.length) {
      binInfo = await shared.refs.resolveBin(ctx, a.bin, { create: true });
      // importFiles is not an Action. With suppressUI=true, importing .mp4 and .wav opened no dialog (live, 26.5.2).
      // SPIKE: the docs don't say whether it adds an undo step; it is counted as one in undoSteps.
      const ok = await ctx.project.importFiles(toImport, true, binInfo.bin, false);
      if (!ok) throw new Error(`Premiere reported the import failed (bin "${binInfo.path || "(root)"}")`);
      ctx.noteUndoStep();
    }

    const items = [];
    const notFound = [];
    if (toImport.length) {
      const inBin = await shared.refs.walk(ctx, binInfo.bin, { recursive: true, basePath: binInfo.path });
      const byMedia = new Map();
      for (const e of inBin) {
        if (e.kind !== "clip") continue;
        const mp = await shared.refs.mediaPathOf(ctx, e);
        if (mp) byMedia.set(shared.refs.normalizeMediaPath(mp), Object.assign(e, { mediaPath: mp }));
      }
      for (const f of toImport) {
        const e = byMedia.get(shared.refs.normalizeMediaPath(f));
        if (e) items.push({ path: e.path, id: e.id, mediaPath: e.mediaPath });
        else notFound.push(f);
      }
    }
    const result = { bin: binInfo.path, binsCreated: binInfo.created, imported: items.length, items, skipped };
    if (notFound.length) result.notFoundAfterImport = notFound;
    return result;
  },
};
