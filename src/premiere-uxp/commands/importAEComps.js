"use strict";
const shared = require("./_shared.js");

// Links After Effects comps into the project through Dynamic Link: Project.importAEComps(aepPath, compNames,
// targetBin) or Project.importAllAEComps(aepPath, targetBin), both Promise<boolean> (UXP docs, since 25.6;
// both exist on Project in 26.5.2). Nothing is written to disk, so the .aep may be anywhere.
// SPIKE: not run live yet (no throwaway .aep could be made without After Effects). Verify: the linked items'
// names (assumed to be the comp names, which skipExisting matches on), whether importAllAEComps nests the comps
// in a sub-bin (the bin is diffed recursively, so either way the new items are found), whether it adds one undo
// step (counted as one, like importFiles), and that no dialog appears.

function diffKey(e) {
  return e.id || e.path;
}

module.exports = {
  name: "importAEComps",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const aepPath = shared.requireString(ctx, a.aepPath, "aepPath");
    if (!shared.isAbsolute(aepPath)) throw shared.badArgs(ctx, `aepPath must be an absolute path, got "${aepPath}"`);
    if (shared.extOf(aepPath) !== "aep") throw shared.badArgs(ctx, `aepPath must be an After Effects project (.aep), got "${aepPath}"`);
    let comps = null;
    if (a.comps !== undefined && a.comps !== null) {
      if (!Array.isArray(a.comps) || !a.comps.length) throw shared.badArgs(ctx, "comps must be a non-empty array of comp names (leave it out to link every comp)");
      comps = a.comps.map((c, i) => shared.requireString(ctx, c, `comps[${i}]`));
    }
    if (a.bin !== undefined && a.bin !== null && typeof a.bin !== "string") throw shared.badArgs(ctx, "bin must be a path string");
    const skipExisting = shared.optBool(ctx, a.skipExisting, "skipExisting", true);
    if (!(await ctx.pathExists(aepPath))) throw ctx.fail("FILE_NOT_FOUND", `No file at "${aepPath}"`);

    // What the bin holds now (if it exists): for skipExisting and for the before/after diff.
    let existing = [];
    try {
      const { bin, path } = await shared.refs.resolveBin(ctx, a.bin, { create: false });
      existing = await shared.refs.walk(ctx, bin, { recursive: true, basePath: path });
    } catch (e) {
      if (e && e.code !== "BIN_NOT_FOUND") throw e;
    }
    const skipped = [];
    let toLink = comps;
    if (comps && skipExisting) {
      const byName = new Map();
      for (const e of existing) if (e.kind !== "bin" && !byName.has(e.name.trim().toLowerCase())) byName.set(e.name.trim().toLowerCase(), e);
      toLink = [];
      for (const c of comps) {
        const hit = byName.get(c.trim().toLowerCase());
        if (hit) skipped.push({ comp: c, path: hit.path, id: hit.id, reason: "already in bin" });
        else toLink.push(c);
      }
    }
    if (toLink && !toLink.length) return { aepPath, bin: null, binsCreated: [], imported: [], skipped };

    const { bin, path, created } = await shared.refs.resolveBin(ctx, a.bin, { create: true });
    const before = new Set((await shared.refs.walk(ctx, bin, { recursive: true, basePath: path })).map(diffKey));
    const ok = toLink ? await ctx.project.importAEComps(aepPath, toLink, bin) : await ctx.project.importAllAEComps(aepPath, bin);
    if (!ok) throw ctx.fail("IMPORT_FAILED", `Premiere reported that linking ${toLink ? toLink.length + " comp(s)" : "the comps"} from "${aepPath}" failed`, { skipped });
    ctx.noteUndoStep();
    const after = await shared.refs.walk(ctx, bin, { recursive: true, basePath: path });
    const imported = after.filter((e) => !before.has(diffKey(e)) && e.kind !== "bin").map((e) => ({ path: e.path, id: e.id, name: e.name }));
    if (!imported.length) throw ctx.fail("IMPORT_FAILED", `Premiere reported success but no new item appeared in bin "${path || "(root)"}"`, { skipped });
    return { aepPath, bin: path, binsCreated: created, imported, skipped };
  },
};
