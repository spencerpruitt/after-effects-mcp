"use strict";
const shared = require("./_shared.js");
const { projectPathOf, toWindowsPath } = require("../core/util.js");

module.exports = {
  name: "createProject",
  mutating: true,
  targetless: true,
  async run(ctx, args) {
    // Backslashes: a forward-slash path makes Premiere 26.5.2 show a modal scratch-disk dialog (see toWindowsPath).
    const path = toWindowsPath(shared.requireString(ctx, args && args.path, "path"));
    if (!shared.isAbsolute(path)) throw shared.badArgs(ctx, `path must be absolute, got "${path}"`);
    if (shared.extOf(path) !== "prproj") throw shared.badArgs(ctx, `path must end in .prproj, got "${path}"`);
    if (!ctx.isDefaultRoot(path)) {
      throw ctx.fail("NOT_IN_DEFAULT_ROOT", `New projects can only be created inside a remembered default root (pick one with Browse in the panel). "${path}" is not inside one.`);
    }
    if (await ctx.pathExists(path)) throw ctx.fail("FILE_EXISTS", `"${path}" already exists; use premiere-open-project instead`);
    // Project.createProject(path) creates, opens and activates the project without a dialog (live, 26.5.2).
    // The parent folder must exist.
    const project = await ctx.ppro.Project.createProject(path);
    if (!project) throw new Error(`Premiere did not create the project at "${path}"`);
    await ctx.setTargetProject(project);
    return { path: projectPathOf(project) || path, name: project.name, guid: shared.refs.guidString(project.guid) };
  },
};
