// Panel core: polling, gate order, stale, targeting, status protection, atomic result writes,
// stamps, mutating wrapper (save + rolling backup), folder resolution, getState, e2e gating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, writeCommand, require, fs, path, spyFs } from "./premiere-core-fakes.mjs";

const { createSettings } = require("../src/premiere-uxp/core/settings.js");
const { runTransaction, ASYNC_MESSAGE } = require("../src/premiere-uxp/core/transaction.js");

const echo = { name: "echo", mutating: false, async run(ctx, args) { return { got: args, projectPath: ctx.projectPath, folder: ctx.folder }; } };
const rename = {
  name: "renameThing",
  mutating: true,
  async run(ctx, args) {
    ctx.transaction("Rename", (compound) => { compound.addAction(ctx.project.createRenameAction(args.to)); });
    return { renamed: args.to };
  },
};

test("getState is exempt from every gate, even when paused or unconfirmed", async () => {
  const t = setup({ commands: [echo] });
  t.bridge.setPaused(true);
  const r = await t.send("getState", {}, { expectedProject: undefined });
  assert.equal(r.status, "success");
  assert.equal(r.paused, true);
  assert.equal(r.scriptsEnabled, false);
});

test("gate order: PAUSED, then PROJECT_NOT_CONFIRMED, then target resolution", async () => {
  const t = setup({ commands: [echo] });
  t.bridge.setPaused(true);
  let r = await t.send("echo", {}, { expectedProject: undefined });
  assert.equal(r.code, "PAUSED");
  assert.equal(r.refused, true);
  r = await t.send("echo", {}, { expectedProject: "C:\\nope\\x.prproj" });
  assert.equal(r.code, "PAUSED");
  t.bridge.setPaused(false);
  r = await t.send("echo", {}, { expectedProject: undefined });
  assert.equal(r.code, "PROJECT_NOT_CONFIRMED");
  r = await t.send("echo", {}, { expectedProject: null });
  assert.equal(r.code, "PROJECT_NOT_CONFIRMED");
  r = await t.send("echo", {}, { expectedProject: "" });
  assert.equal(r.code, "PROJECT_UNSAVED");
  r = await t.send("echo", {}, { expectedProject: "C:\\nope\\x.prproj" });
  assert.equal(r.code, "PROJECT_NOT_OPEN");
  assert.deepEqual(r.openProjects, [t.project.path]);
  assert.equal(r.expectedProject, "C:\\nope\\x.prproj");
  assert.equal(r._projectChanged, false);
});

test("target resolution: case/separator tolerant, and targets a non-active open project", async () => {
  const t = setup({ commands: [echo] });
  const other = t.fake.openProject(path.join(t.root, "second", "Second.prproj"), { active: true });
  assert.equal(t.fake.state.active, other);
  const sloppy = t.project.path.toUpperCase().replace(/\\/g, "/");
  const r = await t.send("echo", { a: 1 }, { expectedProject: sloppy });
  assert.equal(r.status, "success");
  assert.equal(r.projectPath, t.project.path);
  assert.equal(r._project, t.project.path, "_project is the target, not the active project");
  assert.equal(r._projectChanged, false);
  assert.deepEqual(r.got, { a: 1 });
});

test("open-project discovery falls back to projects seen before when view ids fail", async () => {
  const t = setup({ commands: [echo] });
  const other = t.fake.openProject(path.join(t.root, "second", "Second.prproj"), { active: false });
  await t.bridge.tick();
  assert.ok(t.bridge.registry.find(other.path), "found via view ids");
  t.fake.state.viewIdsWork = false;
  let r = await t.send("echo", {}, { expectedProject: other.path });
  assert.equal(r.status, "success", "still found via the remembered guid map");
  await other.close();
  r = await t.send("echo", {}, { expectedProject: other.path });
  assert.equal(r.code, "PROJECT_NOT_OPEN");
});

test("open projects that share a GUID (Save As copies) are all listed and targetable", async () => {
  // Live e2e, 26.5.2: Save As keeps the project GUID, so E2E.prproj reopened next to E2E-copy.prproj and
  // "Save As Copy.prproj" hid each other in openProjects, and teardown could not close them.
  const t = setup({ commands: [echo] });
  const a = t.fake.openProject(path.join(t.root, "x", "A.prproj"), { active: false });
  const b = t.fake.openProject(path.join(t.root, "x", "A-copy.prproj"), { active: false });
  b.guid = a.guid;
  await t.bridge.tick();
  const paths = t.bridge.registry.openPaths();
  assert.ok(paths.includes(a.path) && paths.includes(b.path), JSON.stringify(paths));
  for (const p of [a, b]) {
    const r = await t.send("echo", {}, { expectedProject: p.path });
    assert.equal(r.projectPath, p.path);
  }
  await a.close();
  await t.bridge.tick();
  assert.equal(t.bridge.registry.find(a.path), null, "a closed project is not kept alive by its twin's GUID");
  assert.ok(t.bridge.registry.find(b.path));
  t.fake.state.viewIdsWork = false;
  await t.bridge.tick();
  assert.equal(t.bridge.registry.find(a.path), null, "nor by the remembered map");
  assert.ok(t.bridge.registry.find(b.path));
});

test("stale commands are refused for every command, exempt ones included", async () => {
  const t = setup({ commands: [echo] });
  const old = new Date(t.clock.now() - 121000).toISOString();
  let r = await t.send("getState", {}, { timestamp: old });
  assert.equal(r.code, "STALE");
  r = await t.send("echo", {}, { timestamp: old });
  assert.equal(r.code, "STALE");
  assert.equal(t.readCommand().status, "error");
  r = await t.send("echo", {}, { timestamp: "not a date" });
  assert.equal(r.status, "success", "an unparseable timestamp is never stale");
});

test("commands are processed once: pending + new id only; status set to completed/error", async () => {
  const t = setup({ commands: [echo] });
  const id = writeCommand(t, "echo");
  assert.equal(await t.bridge.tick(), true);
  assert.equal(t.readCommand().status, "completed");
  // Same id rewritten as pending is not reprocessed.
  writeCommand(t, "echo", {}, { id });
  assert.equal(await t.bridge.tick(), false);
  writeCommand(t, "echo", {}, { status: "completed" });
  assert.equal(await t.bridge.tick(), false);
  writeCommand(t, "nope");
  await t.bridge.tick();
  assert.equal(t.readResult().code, "UNKNOWN_COMMAND");
  assert.equal(t.readCommand().status, "error");
});

test("re-entrancy: a tick while another runs does nothing", async () => {
  let release;
  const slow = { name: "slow", async run() { await new Promise((r) => { release = r; }); return {}; } };
  const t = setup({ commands: [slow] });
  writeCommand(t, "slow");
  const first = t.bridge.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await t.bridge.tick(), false);
  release();
  assert.equal(await first, true);
});

test("status is never clobbered: a command written mid-run stays pending", async () => {
  let t;
  const writer = {
    name: "writer",
    async run() { writeCommand(t, "echo", {}, { id: "newer" }); return {}; },
  };
  t = setup({ commands: [writer, echo] });
  writeCommand(t, "writer");
  await t.bridge.tick();
  const cmd = t.readCommand();
  assert.equal(cmd.id, "newer");
  assert.equal(cmd.status, "pending");
  assert.equal(t.readResult()._commandExecuted, "writer");
  await t.bridge.tick();
  assert.equal(t.readResult()._commandId, "newer");
});

test("a command the server writes as soon as the result lands is not clobbered by the status update", async () => {
  // The server writes its next command the moment it sees its result. If the panel marked the old
  // command completed only after writing the result, that read-check-write would overwrite the new one.
  // The id check is a read-then-write, so it can't be made atomic: the only safe rule is that the panel
  // never touches pr_command.json once the final result has landed.
  const base = spyFs();
  let resultLanded = false;
  const afterResult = [];
  const fsImpl = { ...base.fs };
  for (const name of ["writeFile", "rename", "unlink"]) {
    fsImpl[name] = async (...args) => {
      if (resultLanded && args.some((a) => typeof a === "string" && /pr_command\.json/.test(a))) afterResult.push(name);
      const r = await base.fs[name](...args);
      if (name === "rename" && /pr_mcp_result\.json$/.test(args[1]) &&
          JSON.parse(fs.readFileSync(args[1], "utf8")).status !== "running") resultLanded = true;
      return r;
    };
  }
  for (const failing of [false, true]) {
    resultLanded = false;
    afterResult.length = 0;
    const cmds = [echo, { name: "boom", async run() { throw new Error("boom"); } }];
    const t = setup({ commands: cmds, fsImpl });
    const id = writeCommand(t, failing ? "boom" : "echo");
    await t.bridge.tick();
    assert.equal(resultLanded, true);
    assert.deepEqual(afterResult, [], "no pr_command.json write after the result (" + (failing ? "error" : "success") + ")");
    assert.equal(t.readCommand().status, failing ? "error" : "completed");
    assert.equal(t.readResult()._commandId, id);
  }
});

test("result write is atomic: tmp, remove old, rename; stamps present", async () => {
  const t = setup({ commands: [echo] });
  await t.send("echo");
  t.spied.calls.length = 0;
  const id = writeCommand(t, "echo");
  await t.bridge.tick();
  const ops = t.spied.calls.filter(([n, p]) => /pr_mcp_result/.test(p || "") && n !== "lstat" && n !== "readFile");
  assert.deepEqual(ops.map(([n, p]) => n + " " + path.basename(p)), [
    "writeFile pr_mcp_result.tmp",
    "unlink pr_mcp_result.json",
    "rename pr_mcp_result.tmp",
  ]);
  assert.equal(fs.existsSync(path.join(t.bridgeDir, "pr_mcp_result.tmp")), false);
  const r = t.readResult();
  assert.equal(r._commandId, id);
  assert.equal(r._commandExecuted, "echo");
  assert.equal(r._responseTimestamp, new Date(t.clock.now()).toISOString());
  assert.equal(r._project, t.project.path);
  assert.equal(r._projectChanged, false);
});

test("mutating command: save, backup, one transaction = one undo step", async () => {
  const t = setup({ commands: [rename] });
  const r = await t.send("renameThing", { to: "B" });
  assert.equal(r.status, "success");
  assert.equal(r.renamed, "B");
  assert.equal(r.undoSteps, 1);
  assert.equal(t.project.saveCount, 1);
  assert.equal(t.project.transactions.length, 1);
  assert.equal(t.project.transactions[0].undoString, "MCP: Rename");
  assert.match(path.basename(r.backupPath), /^\d{8}-\d{6}-\d{3}_Edit\.prproj$/);
  assert.ok(fs.existsSync(r.backupPath));
  assert.equal(path.dirname(r.backupPath), path.join(t.edit, "mcp-scripts", "backups"));
  assert.equal(r.backupWarning, undefined);
});

test("mutating command: SAVE_FAILED stops the run; NO_FOLDER and FOLDER_MISSING refuse", async () => {
  let ran = 0;
  const m = { name: "m", mutating: true, async run() { ran++; return {}; } };
  const t = setup({ commands: [m] });
  t.project.saveBehaviour = "throw";
  let r = await t.send("m");
  assert.equal(r.code, "SAVE_FAILED");
  t.project.saveBehaviour = "false";
  r = await t.send("m");
  assert.equal(r.code, "SAVE_FAILED");
  assert.equal(ran, 0);
  t.project.saveBehaviour = "ok";
  t.bridge.settings.setFolder(t.project.path, path.join(t.root, "gone"));
  r = await t.send("m");
  assert.equal(r.code, "FOLDER_MISSING");
  t.bridge.settings.clearFolder(t.project.path);
  r = await t.send("m");
  assert.equal(r.code, "NO_FOLDER");
  assert.equal(ran, 0);
});

test("mutating command: precheck runs before the save and backup; a refusal there touches nothing", async () => {
  let ran = 0;
  let prechecked = 0;
  const m = {
    name: "m",
    mutating: true,
    async precheck(ctx, args) {
      prechecked++;
      assert.equal(ctx.projectPath, t.project.path);
      if (args.refuse) throw ctx.fail("NEEDS_SIDECAR_UNAVAILABLE", "needs the sidecar", { why: "test" });
    },
    async run() { ran++; return { ok: 1 }; },
  };
  const t = setup({ commands: [m] });
  let r = await t.send("m", { refuse: true });
  assert.equal(r.code, "NEEDS_SIDECAR_UNAVAILABLE");
  assert.equal(r.why, "test");
  assert.equal(r.undoSteps, 0);
  assert.equal(r.backupPath, undefined);
  assert.equal(t.project.saveCount, 0);
  assert.equal(ran, 0);
  assert.equal(fs.existsSync(path.join(t.edit, "mcp-scripts", "backups")), false);
  r = await t.send("m", {});
  assert.equal(r.status, "success");
  assert.equal(t.project.saveCount, 1);
  assert.deepEqual([prechecked, ran], [2, 1]);
});

test("ctx.noteUndoStep counts non-Action undo steps (import, sequence creation) in undoSteps", async () => {
  const m = {
    name: "m",
    mutating: true,
    async run(ctx) {
      ctx.noteUndoStep();
      ctx.transaction("Rename", (compound) => { compound.addAction(ctx.project.createRenameAction("x")); });
      return {};
    },
  };
  const t = setup({ commands: [m] });
  const r = await t.send("m");
  assert.equal(r.status, "success", r.message);
  assert.equal(r.undoSteps, 2);
});

test("mutating command: backup failure is a warning, not a stop", async () => {
  const m = { name: "m", mutating: true, async run() { return { ok: 1 }; } };
  const t = setup({ commands: [m] });
  fs.unlinkSync(t.project.path); // nothing to copy
  const r = await t.send("m");
  assert.equal(r.status, "success");
  assert.equal(r.backupPath, null);
  assert.match(r.backupWarning, /^Backup failed/);
});

test("backup rotation keeps the newest 10 for that project only", async () => {
  const m = { name: "m", mutating: true, async run() { return {}; } };
  const t = setup({ commands: [m] });
  const dir = path.join(t.edit, "mcp-scripts", "backups");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "20200101-000000-000_Other.prproj"), "x");
  const made = [];
  for (let i = 0; i < 12; i++) {
    t.clock.advance(1001);
    made.push((await t.send("m")).backupPath);
  }
  const mine = fs.readdirSync(dir).filter((n) => n.endsWith("_Edit.prproj")).sort();
  assert.equal(mine.length, 10);
  assert.deepEqual(mine, made.slice(2).map((p) => path.basename(p)));
  assert.ok(fs.existsSync(path.join(dir, "20200101-000000-000_Other.prproj")));
});

test("ctx: fail, assertWritable, isDefaultRoot, pathExists, openProjects, guarded fs, lazy time", async () => {
  const probe = {
    name: "probe",
    async run(ctx) {
      const out = {};
      out.inside = ctx.assertWritable(path.join(ctx.folder, "a.txt"));
      try { ctx.assertWritable(path.join(ctx.folder, "..", "b.txt")); } catch (e) { out.outside = e.code; }
      await ctx.fs.writeFile(path.join(ctx.folder, "ok.txt"), "x");
      try { await ctx.fs.writeFile(path.join(ctx.folder, "..", "bad.txt"), "x"); } catch (e) { out.fsOutside = e.code; }
      out.isDefault = ctx.isDefaultRoot(path.join(ctx.folder, "x.prproj"));
      out.exists = [await ctx.pathExists(path.join(ctx.folder, "ok.txt")), await ctx.pathExists(path.join(ctx.folder, "nope.txt"))];
      out.open = (await ctx.openProjects()).map((e) => e.path);
      try { out.timeType = typeof ctx.time; } catch (e) { out.timeType = "missing"; }
      throw ctx.fail("ITEM_NOT_FOUND", "no such item", { candidates: ["a", "b"], partial: out });
    },
  };
  const t = setup({ commands: [probe] });
  const r = await t.send("probe");
  assert.equal(r.status, "error");
  assert.equal(r.code, "ITEM_NOT_FOUND");
  assert.equal(r.message, "no such item");
  assert.deepEqual(r.candidates, ["a", "b"]);
  assert.equal(r.partial.outside, "OUTSIDE_FOLDER");
  assert.equal(r.partial.fsOutside, "OUTSIDE_FOLDER");
  assert.equal(r.partial.isDefault, false);
  assert.deepEqual(r.partial.exists, [true, false]);
  assert.deepEqual(r.partial.open, [t.project.path]);
  assert.ok(fs.existsSync(path.join(t.edit, "ok.txt")));
  assert.equal(fs.existsSync(path.join(t.root, "bad.txt")), false);
});

test("ctx.transaction: runs fn synchronously inside lockedAccess + executeTransaction; async fn is an error", async () => {
  const asyncTx = {
    name: "asyncTx",
    mutating: true,
    async run(ctx) {
      ctx.transaction("Bad", async (compound) => { compound.addAction(ctx.project.createRenameAction("x")); });
      return {};
    },
  };
  const t = setup({ commands: [rename, asyncTx] });
  const r = await t.send("asyncTx");
  assert.equal(r.status, "error");
  assert.equal(r.message, "Error: " + ASYNC_MESSAGE);
  assert.equal(r.undoSteps, 0);
  assert.equal(t.project.transactions.length, 0);
});

test("runTransaction: create*Action inside the lock works, value returned", () => {
  const fakeProject = {
    inLock: false,
    lockedAccess(cb) { this.inLock = true; try { cb(); } finally { this.inLock = false; } },
    executeTransaction(cb, undoString) { assert.equal(this.inLock, true); this.lastUndoString = undoString; cb({ addAction() { return true; } }); return true; },
  };
  const counters = { undoSteps: 0 };
  const { committed, value } = runTransaction(fakeProject, "x", (c) => { c.addAction({}); return 42; }, counters);
  assert.equal(committed, true);
  assert.equal(value, 42);
  assert.equal(counters.undoSteps, 1);
  assert.equal(fakeProject.lastUndoString, "MCP: x", "runTransaction adds the MCP: prefix");
  assert.throws(() => runTransaction(fakeProject, "x", () => { throw new Error("boom"); }, counters), /boom/);
  assert.throws(() => runTransaction(fakeProject, "x", async () => 1, counters), new RegExp(ASYNC_MESSAGE));
  assert.equal(counters.undoSteps, 1, "failed transactions are not counted");
});

test("folder resolution: own folder, innermost default root, cleared, forget", () => {
  const s = createSettings(makeStore());
  const P = "D:\\Film\\edit\\cut\\Cut.prproj";
  assert.deepEqual(s.folderFor(P), { folder: null, isDefault: false });
  s.rememberRoot("D:\\Film");
  s.rememberRoot("D:\\Film\\edit");
  s.rememberRoot("d:/film/EDIT/"); // duplicate after normalize
  assert.deepEqual(s.roots(), ["D:\\Film", "D:\\Film\\edit"]);
  assert.deepEqual(s.folderFor(P), { folder: "D:\\Film\\edit", isDefault: true });
  s.setFolder(P.toUpperCase(), "D:\\Film\\edit\\cut");
  assert.deepEqual(s.folderFor(P), { folder: "D:\\Film\\edit\\cut", isDefault: false }, "keys are normalized");
  s.clearFolder(P);
  assert.deepEqual(s.folderFor(P), { folder: null, isDefault: false }, "Clear turns the default off for this project");
  s.removeFolder(P);
  s.forgetRoot("D:\\FILM\\EDIT");
  assert.deepEqual(s.folderFor(P), { folder: "D:\\Film", isDefault: true });
  assert.equal(s.isDefaultRoot("D:\\Film\\x\\New.prproj"), true);
  assert.equal(s.isDefaultRoot("E:\\x\\New.prproj"), false);
  assert.equal(s.key(P), "MCPBridgeSandbox:d:/film/edit/cut/cut.prproj");
  assert.equal(s.folderFor("").folder, null);
});

function makeStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

test("folder follows Save As inside the folder; _projectChanged and _project follow the target", async () => {
  const saveAs = {
    name: "saveProject",
    mutating: true,
    async run(ctx, args) {
      if (args.path) {
        ctx.assertWritable(args.path);
        await ctx.project.saveAs(args.path);
        ctx.setTargetProject(ctx.project);
      }
      return { savedTo: ctx.projectPath };
    },
  };
  const t = setup({ commands: [saveAs] });
  const oldPath = t.project.path;
  const newPath = path.join(t.edit, "cuts", "Edit v2.prproj");
  const r = await t.send("saveProject", { path: newPath });
  assert.equal(r.status, "success");
  assert.equal(r._project, newPath);
  assert.equal(r._projectChanged, true);
  assert.equal(t.bridge.settings.folderFor(newPath).folder, t.edit);
  assert.equal(t.bridge.settings.folderFor(newPath).isDefault, false);
  // The new path is now the target.
  const r2 = await t.send("saveProject", {}, { expectedProject: newPath });
  assert.equal(r2.status, "success");
  assert.equal(r2._projectChanged, false);
  const r3 = await t.send("saveProject", {}, { expectedProject: oldPath });
  assert.equal(r3.code, "PROJECT_NOT_OPEN");
});

test("targetless createProject: inherits the default root and becomes the target", async () => {
  const createProject = {
    name: "createProject",
    mutating: true,
    targetless: true,
    async run(ctx, args) {
      if (ctx.project !== null) throw new Error("expected null project");
      if (!ctx.isDefaultRoot(args.path)) throw ctx.fail("NOT_IN_DEFAULT_ROOT", "not in a default root");
      const p = await ctx.ppro.Project.createProject(args.path);
      ctx.setTargetProject(p);
      return { path: p.path, folder: ctx.folder };
    },
  };
  const t = setup({ commands: [createProject] });
  t.bridge.settings.rememberRoot(t.root);
  let r = await t.send("createProject", { path: path.join(t.root, "film", "New.prproj") }, { expectedProject: undefined });
  assert.equal(r.status, "success");
  assert.equal(r.folder, t.root);
  assert.equal(r._projectChanged, true);
  assert.equal(r._project, path.join(t.root, "film", "New.prproj"));
  assert.equal(r.undoSteps, 0);
  r = await t.send("createProject", { path: "Z:\\elsewhere\\X.prproj" }, { expectedProject: undefined });
  assert.equal(r.code, "NOT_IN_DEFAULT_ROOT");
  assert.equal(r._projectChanged, false);
  t.bridge.setPaused(true);
  r = await t.send("createProject", { path: path.join(t.root, "film", "B.prproj") }, { expectedProject: undefined });
  assert.equal(r.code, "PAUSED");
});

test("getState shape (spec section 4)", async () => {
  const t = setup();
  t.fake.openProject(path.join(t.root, "second", "Second.prproj"), { active: false });
  const r = await t.send("getState", {}, { expectedProject: undefined });
  assert.equal(r.status, "success");
  assert.equal(r.openProjects.length, 2);
  assert.deepEqual(Object.keys(r.openProjects[0]).sort(), ["guid", "isActive", "name", "path"]);
  assert.equal(r.activeProject, t.project.path);
  assert.deepEqual(r.target, { path: t.project.path, name: "Edit.prproj", folder: t.edit, folderExists: true, isDefault: false });
  assert.equal(r.paused, false);
  assert.equal(r.scriptsEnabled, true);
  assert.equal(r.testHarnessEnabled, false);
  assert.deepEqual(r.scratchDisks, { videoPreview: "C:\\Previews\\Video", audioPreview: "C:\\Previews\\Audio", autoSave: "SameAsProject", mediaCache: null });
  assert.deepEqual(r.app, { version: "26.5.2" });
  assert.equal(r.sidecarAvailable, false);
  // With expectedProject naming the other project, target is that project.
  const r2 = await t.send("getState", {}, { expectedProject: path.join(t.root, "second", "Second.prproj") });
  assert.equal(r2.target.folder, null);
  assert.equal(r2.scriptsEnabled, false);
});

test("panel UI actions: Browse remembers a default, Clear, Forget default", async () => {
  const t = setup({ withFolder: false });
  await t.bridge.tick();
  assert.equal(t.bridge.uiState().folder, null);
  assert.equal(t.bridge.chooseFolder(t.edit), true);
  assert.deepEqual(t.bridge.settings.roots(), [t.edit]);
  let ui = t.bridge.uiState();
  assert.equal(ui.folder, t.edit);
  assert.equal(ui.isDefault, false);
  t.bridge.settings.removeFolder(t.project.path);
  ui = t.bridge.uiState();
  assert.equal(ui.isDefault, true);
  assert.equal(ui.canForget, true);
  assert.equal(t.bridge.forgetDefault(), true);
  assert.equal(t.bridge.uiState().folder, null);
  t.bridge.chooseFolder(t.edit);
  t.bridge.clearFolder();
  assert.equal(t.bridge.uiState().folder, null);
});

test("e2e commands: PAUSED first, then harness checkbox, then test-root paths", async () => {
  const t = setup();
  const e2eRoot = path.join(t.root, "pr-mcp-e2e-123");
  const proj = path.join(e2eRoot, "edit", "E2E.prproj");
  const folder = path.join(e2eRoot, "edit");
  t.bridge.setPaused(true);
  let r = await t.send("__e2e_setFolder", { projectPath: proj, folder }, { expectedProject: undefined });
  assert.equal(r.code, "PAUSED");
  t.bridge.setPaused(false);
  r = await t.send("__e2e_setFolder", { projectPath: proj, folder }, { expectedProject: undefined });
  assert.equal(r.code, "TEST_HARNESS_DISABLED");
  t.bridge.setHarness(true);
  r = await t.send("__e2e_setFolder", { projectPath: t.project.path, folder }, { expectedProject: undefined });
  assert.equal(r.code, "OUTSIDE_TEST_ROOT");
  r = await t.send("__e2e_setFolder", { projectPath: proj, folder: path.join(t.root, "pr-mcp-e2e-") }, { expectedProject: undefined });
  assert.equal(r.code, "OUTSIDE_TEST_ROOT");
  r = await t.send("__e2e_setFolder", { projectPath: proj, folder }, { expectedProject: undefined });
  assert.equal(r.status, "success");
  r = await t.send("__e2e_addRoot", { root: e2eRoot }, { expectedProject: undefined });
  assert.deepEqual(r.roots, [e2eRoot]);
  r = await t.send("__e2e_readSettings", {}, { expectedProject: undefined });
  const key = Object.keys(r.folders);
  assert.equal(key.length, 1, "the user's own Edit.prproj folder is not reported");
  assert.equal(r.folders[key[0]], folder);
  assert.deepEqual(r.roots, [e2eRoot]);

  r = await t.send("__e2e_openProject", { path: proj }, { expectedProject: undefined });
  assert.equal(r.status, "success");
  const opened = t.fake.state.open.find((p) => p.path === proj);
  opened.rootItems = [{ name: "clip" }, { isFolder: true, async getItems() { return [{ name: "c2" }]; } }];
  r = await t.send("__e2e_countItems", { projectPath: proj }, { expectedProject: undefined });
  assert.equal(r.items, 3);
  assert.equal(r.bins, 1);
  r = await t.send("__e2e_closeProject", { path: proj }, { expectedProject: undefined });
  assert.equal(r.closed, true);
  r = await t.send("__e2e_closeProject", { path: proj }, { expectedProject: undefined });
  assert.equal(r.code, "PROJECT_NOT_OPEN");
  r = await t.send("__e2e_clearFolder", { projectPath: proj }, { expectedProject: undefined });
  assert.equal(r.status, "success");
  r = await t.send("__e2e_removeRoot", { root: e2eRoot }, { expectedProject: undefined });
  assert.deepEqual(r.roots, []);
  r = await t.send("__e2e_readSettings", {}, { expectedProject: undefined });
  assert.deepEqual(r.folders, {});
});
