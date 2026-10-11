"use strict";
const shared = require("./_shared.js");
const { projectPathOf } = require("../core/util.js");
const { normalize } = require("../lib/pathPolicy.js");

module.exports = {
  name: "openProject",
  mutating: false,
  targetless: true,
  async run(ctx, args) {
    const path = shared.requireString(ctx, args && args.path, "path");
    if (!shared.isAbsolute(path)) throw shared.badArgs(ctx, `path must be absolute, got "${path}"`);
    // ctx.openProjects() is core's registry enumeration (spec 4); paths compare like the gate's registry.find.
    const want = normalize(path);
    const open = (await ctx.openProjects()).find((e) => e.path && normalize(e.path) === want);
    if (open) {
      const p = open.project;
      await ctx.setTargetProject(p);
      return { path: projectPathOf(p), name: p.name, guid: shared.refs.guidString(p.guid), alreadyOpen: true };
    }
    if (!(await ctx.pathExists(path))) throw ctx.fail("FILE_NOT_FOUND", `No project file at "${path}"`);
    const opts = new ctx.ppro.OpenProjectOptions();
    // Suppress every dialog UXP lets us suppress (spec 6, "Modal dialogs").
    opts.setShowConvertProjectDialog(false);
    opts.setShowLocateFileDialog(false);
    opts.setShowWarningDialog(false);
    // SPIKE (spec 9.2h): check which dialogs can still appear (e.g. missing fonts, newer-version warnings).
    const project = await ctx.ppro.Project.open(path, opts);
    if (!project) throw new Error(`Premiere did not open "${path}"`);
    await ctx.setTargetProject(project);
    return { path: projectPathOf(project) || path, name: project.name, guid: shared.refs.guidString(project.guid), alreadyOpen: false };
  },
};

