"use strict";
// getState (exempt from the gate): the equivalent of AE's getSandboxFolder + getProjectInfo, spec section 4.

async function readScratchDisks(ppro, project) {
  const out = { videoPreview: null, audioPreview: null, autoSave: null, mediaCache: null };
  try {
    const PS = ppro.ProjectSettings;
    const T = ppro.Constants && ppro.Constants.ScratchDiskFolderType;
    if (!project || !PS || typeof PS.getScratchDiskSettings !== "function" || !T) return out;
    const s = await PS.getScratchDiskSettings(project);
    const read = (type) => {
      try {
        if (type === undefined) return null;
        const v = s.getScratchDiskPath(type);
        return v === undefined || v === null ? null : String(v);
      } catch (e) {
        return null;
      }
    };
    out.videoPreview = read(T.VIDEO_PREVIEW);
    out.audioPreview = read(T.AUDIO_PREVIEW);
    out.autoSave = read(T.AUTO_SAVE);
    // The media cache is an app preference with no UXP API: always null.
  } catch (e) { /* leave nulls */ }
  return out;
}

// deps: { registry, settings, fsx, ppro, state: { paused, harness }, hostVersion }
async function getState(deps, expectedProject) {
  const { registry, settings, fsx, ppro } = deps;
  const snap = registry.snapshot();
  const active = snap.projects.find((e) => e.isActive) || null;
  let entry = expectedProject ? registry.find(expectedProject) : null;
  if (!entry) entry = active;
  const paused = !!deps.state.paused;
  let target = null;
  let scriptsEnabled = false;
  if (entry && entry.path) {
    const { folder, isDefault } = settings.folderFor(entry.path);
    const folderExists = folder ? await fsx.isDir(folder) : false;
    target = { path: entry.path, name: entry.name, folder, folderExists, isDefault };
    scriptsEnabled = !!(folder && folderExists && !paused);
  } else if (entry) {
    target = { path: "", name: entry.name, folder: null, folderExists: false, isDefault: false };
  }
  return {
    status: "success",
    openProjects: snap.projects.map((e) => ({ path: e.path, name: e.name, guid: e.guid, isActive: e.isActive })),
    activeProject: active ? active.path : null,
    target,
    paused,
    scriptsEnabled,
    testHarnessEnabled: !!deps.state.harness,
    scratchDisks: await readScratchDisks(ppro, entry ? entry.project : null),
    app: { version: deps.hostVersion || null },
    sidecarAvailable: false,
  };
}

module.exports = { getState, readScratchDisks };
