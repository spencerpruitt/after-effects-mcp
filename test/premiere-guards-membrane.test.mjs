// Regression guard for the guarded-ppro membrane (spec section 6). The live e2e run on 26.5.2 found that a
// script's ppro.Project.createProject(<outside>) and ppro.EncoderManager.getManager().exportSequence(<outside>)
// reached Premiere: UXP's premierepro module exposes its classes (and their statics) as non-writable,
// non-configurable properties, and a Proxy must return such a property's exact value, so a membrane that proxies
// the real object hands the raw class back. This fake is built the same way (frozen module, locked statics,
// methods on prototypes and locked own instance methods), and every output-path API must be refused outside
// the folder before the fake "Premiere" sees the call, whether reached as a static or through an instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createGuards } = require("../src/premiere-uxp/core/guards.js");
const { isInside } = require("../src/premiere-uxp/lib/pathPolicy.js");

const FOLDER = "C:\\Film\\edit";
const IN = (f) => FOLDER + "\\" + f;
const OUT = (f) => "C:\\Elsewhere\\" + f;

// Defines a locked (non-writable, non-configurable) property, as UXP's native bindings do.
function lock(obj, name, value) {
  Object.defineProperty(obj, name, { value, writable: false, configurable: false, enumerable: true });
}

function makeUxpLikePpro() {
  const calls = [];
  const hit = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(true);
  };

  class Project {
    constructor(p) { this.path = p; }
  }
  // Instance method on the prototype (like Project.saveAs), plus a locked own one.
  lock(Project.prototype, "saveAs", hit("saveAs"));
  lock(Project, "createProject", hit("createProject"));
  lock(Project, "getActiveProject", () => Promise.resolve(null));

  class EncoderManager {}
  lock(EncoderManager.prototype, "exportSequence", hit("exportSequence"));
  lock(EncoderManager.prototype, "encodeFile", hit("encodeFile"));
  lock(EncoderManager.prototype, "encodeProjectItem", hit("encodeProjectItem"));
  const manager = new EncoderManager();
  lock(EncoderManager, "getManager", () => manager);

  class Exporter {}
  lock(Exporter, "exportSequenceFrame", hit("exportSequenceFrame"));

  class ProjectConverter {}
  lock(ProjectConverter, "exportAAF", hit("exportAAF"));
  lock(ProjectConverter, "exportAsFinalCutProXML", hit("exportAsFinalCutProXML"));
  lock(ProjectConverter, "exportAsOpenTimelineIO", hit("exportAsOpenTimelineIO"));

  class Transcript {}
  lock(Transcript, "exportToJSON", hit("exportToJSON"));

  const T = Object.freeze({ VIDEO_PREVIEW: "VideoPreview", AUDIO_PREVIEW: "AudioPreview", AUTO_SAVE: "AutoSave" });
  const F = Object.freeze({ SAME_AS_PROJECT: "SameAsProject", MY_DOCUMENTS: "MyDocuments" });
  class ScratchDiskSettings {
    constructor() {
      // Locked own method, the other shape a native binding can take.
      lock(this, "setScratchDiskPath", hit("setScratchDiskPath"));
    }
  }
  lock(ScratchDiskSettings.prototype, "getScratchDiskPath", () => F.SAME_AS_PROJECT);
  class ProjectSettings {}
  lock(ProjectSettings, "getScratchDiskSettings", () => Promise.resolve(new ScratchDiskSettings()));
  lock(ProjectSettings, "createSetScratchDiskSettingsAction", hit("createSetScratchDiskSettingsAction"));

  const ppro = {};
  for (const [k, v] of Object.entries({ Project, EncoderManager, Exporter, ProjectConverter, Transcript, ProjectSettings })) lock(ppro, k, v);
  lock(ppro, "Constants", Object.freeze({ ScratchDiskFolderType: T, ScratchDiskFolder: F, ExportType: Object.freeze({ IMMEDIATELY: 0 }) }));
  Object.freeze(ppro);
  return { ppro, calls, Project, T, F };
}

function setup({ projectPath = IN("Edit.prproj"), defaultRoot = "C:\\Film" } = {}) {
  const fake = makeUxpLikePpro();
  const rawProject = new fake.Project(projectPath);
  const g = createGuards({
    ppro: fake.ppro,
    getFolder: () => FOLDER,
    getProjectPath: () => rawProject.path,
    isDefaultRoot: (p) => isInside(p, defaultRoot),
  });
  return { ...fake, g, ppro: g.wrappedPpro, project: g.membrane.wrap(rawProject) };
}

async function refused(fn, code, label) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.equal(err.mcpCode, code, `${label}: ${err && err.message}`);
}

// [label, call(ppro, project, T, F)] for every output-path API in spec section 6, outside the folder.
const OUTSIDE_CALLS = [
  ["static Project.createProject", (p) => p.Project.createProject(OUT("New.prproj"))],
  ["instance project.saveAs", (p, project) => project.saveAs(OUT("Copy.prproj"))],
  ["getter EncoderManager.getManager().exportSequence", (p) => p.EncoderManager.getManager().exportSequence(null, 0, OUT("a.mp4"), "x.epr", true)],
  ["getter EncoderManager.getManager().encodeFile", (p) => p.EncoderManager.getManager().encodeFile(IN("in.mov"), OUT("a.mp4"), "x.epr")],
  ["getter EncoderManager.getManager().encodeProjectItem", (p) => p.EncoderManager.getManager().encodeProjectItem(null, OUT("a.mp4"), "x.epr")],
  ["static Exporter.exportSequenceFrame (folder)", (p) => p.Exporter.exportSequenceFrame(null, null, "f.png", "C:\\Elsewhere\\", 16, 16)],
  ["static Exporter.exportSequenceFrame (full path)", (p) => p.Exporter.exportSequenceFrame(null, null, OUT("f.png"), FOLDER, 16, 16)],
  ["static ProjectConverter.exportAAF", (p) => p.ProjectConverter.exportAAF(null, OUT("t.aaf"))],
  ["static ProjectConverter.exportAsFinalCutProXML", (p) => p.ProjectConverter.exportAsFinalCutProXML(null, OUT("t.xml"))],
  ["static ProjectConverter.exportAsOpenTimelineIO", (p) => p.ProjectConverter.exportAsOpenTimelineIO(null, OUT("t.otio"))],
  ["static Transcript.exportToJSON", (p) => p.Transcript.exportToJSON(null, OUT("t.json"))],
  ["instance ScratchDiskSettings.setScratchDiskPath (path)", async (p, project, T) => {
    const s = await p.ProjectSettings.getScratchDiskSettings(project);
    return s.setScratchDiskPath(T.VIDEO_PREVIEW, "C:\\Elsewhere");
  }],
  ["instance ScratchDiskSettings.setScratchDiskPath (My Documents)", async (p, project, T, F) => {
    const s = await p.ProjectSettings.getScratchDiskSettings(project);
    return s.setScratchDiskPath(T.AUTO_SAVE, F.MY_DOCUMENTS);
  }],
  ["instance ScratchDiskSettings.setScratchDiskPath (arguments swapped)", async (p, project, T) => {
    const s = await p.ProjectSettings.getScratchDiskSettings(project);
    return s.setScratchDiskPath("C:\\Elsewhere", T.VIDEO_PREVIEW);
  }],
];

for (const [label, call] of OUTSIDE_CALLS) {
  test(`membrane refuses ${label} outside the folder, before Premiere is called`, async () => {
    const t = setup();
    await refused(() => call(t.ppro, t.project, t.T, t.F), "OUTSIDE_FOLDER", label);
    assert.deepEqual(t.calls, [], `${label}: the host was called: ${JSON.stringify(t.calls)}`);
  });
}

test("membrane: createProject inside the folder still needs a remembered default root", async () => {
  const t = setup({ defaultRoot: "D:\\Roots" });
  await refused(() => t.ppro.Project.createProject(IN("New.prproj")), "NOT_IN_DEFAULT_ROOT", "createProject outside the default roots");
  assert.deepEqual(t.calls, []);
});

test("membrane: inside the folder the same calls reach Premiere with raw arguments", async () => {
  const t = setup();
  await t.ppro.Project.createProject(IN("New.prproj"));
  await t.ppro.EncoderManager.getManager().exportSequence(null, 0, IN("a.mp4"), "x.epr", true);
  await t.ppro.ProjectConverter.exportAsOpenTimelineIO(null, IN("t.otio"));
  await t.ppro.Exporter.exportSequenceFrame(null, null, "f.png", FOLDER, 16, 16);
  const s = await t.ppro.ProjectSettings.getScratchDiskSettings(t.project);
  s.setScratchDiskPath(t.T.VIDEO_PREVIEW, IN("previews"));
  s.setScratchDiskPath(t.T.AUDIO_PREVIEW, t.F.SAME_AS_PROJECT); // the project file is inside
  assert.deepEqual(t.calls.map((c) => c[0]),
    ["createProject", "exportSequence", "exportAsOpenTimelineIO", "exportSequenceFrame", "setScratchDiskPath", "setScratchDiskPath"]);
});

test("membrane: forward-slash createProject paths reach Premiere with backslashes (a / path opens a scratch-disk dialog)", async () => {
  const t = setup();
  await t.ppro.Project.createProject("C:/Film/edit/New.prproj");
  assert.equal(t.calls[0][1], "C:\\Film\\edit\\New.prproj");
});

test("membrane: proxies of locked classes still behave (typeof, instanceof, constants, enumeration)", async () => {
  const t = setup();
  assert.equal(typeof t.ppro.Project, "function");
  assert.equal(t.ppro.Constants.ScratchDiskFolder.MY_DOCUMENTS, "MyDocuments");
  assert.ok(t.project instanceof t.ppro.Project, "a wrapped instance is an instance of the wrapped class");
  assert.ok(Object.keys(t.ppro).includes("EncoderManager"));
  assert.equal(t.ppro.Project, t.ppro.Project, "one proxy per host object");
  assert.equal(t.project.path, IN("Edit.prproj"));
});
