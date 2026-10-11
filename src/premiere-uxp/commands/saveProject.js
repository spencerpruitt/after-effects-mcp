"use strict";
const shared = require("./_shared.js");

module.exports = {
  name: "saveProject",
  mutating: true,
  targetless: false,
  async run(ctx, args) {
    const a = args || {};
    const overwrite = shared.optBool(ctx, a.overwrite, "overwrite", false);
    const project = ctx.project;
    if (a.path === undefined || a.path === null || a.path === "") {
      const ok = await project.save();
      if (!ok) throw ctx.fail("SAVE_FAILED", `Premiere could not save "${project.path}"`);
      return { path: project.path, savedAs: false };
    }
    const path = shared.requireString(ctx, a.path, "path");
    if (!shared.isAbsolute(path)) throw shared.badArgs(ctx, `path must be absolute, got "${path}"`);
    if (shared.extOf(path) !== "prproj") throw shared.badArgs(ctx, `path must end in .prproj, got "${path}"`);
    ctx.assertWritable(path);
    if (shared.refs.normalizeMediaPath(path) === shared.refs.normalizeMediaPath(project.path || "")) {
      const ok = await project.save();
      if (!ok) throw ctx.fail("SAVE_FAILED", `Premiere could not save "${project.path}"`);
      return { path: project.path, savedAs: false };
    }
    if (!overwrite && (await ctx.pathExists(path))) throw ctx.fail("FILE_EXISTS", `"${path}" already exists; pass overwrite: true to replace it`);
    const from = project.path;
    // Docs: saveAs makes the copy the active project and updates this Project object in place to the copy.
    const ok = await project.saveAs(path);
    if (!ok) throw ctx.fail("SAVE_FAILED", `Premiere could not save "${from}" as "${path}"`);
    await ctx.setTargetProject(project);
    return { path: project.path || path, previousPath: from, savedAs: true };
  },
};
