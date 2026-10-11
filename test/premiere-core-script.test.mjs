// runScript / runScriptFile: preconditions, archive, run log, line numbers, JSON-safe returns,
// guarded fs / require / premierepro, sandbox helper, undo steps, watchdog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fs, path } from "./premiere-core-fakes.mjs";

function runLog(t) {
  return fs.readFileSync(path.join(t.edit, "mcp-scripts", "run-log.txt"), "utf8").trim().split("\n");
}

test("success: returnValue, archive, backup, run log, running interim first", async () => {
  const t = setup();
  t.spied.calls.length = 0;
  const r = await t.send("runScript", { code: "return { n: project.name, sum: 1 + 2 };", name: "count items!" });
  assert.equal(r.status, "success");
  assert.deepEqual(r.returnValue, { n: "Edit.prproj", sum: 3 });
  assert.match(path.basename(r.archivedAs), /^\d{8}-\d{6}-\d{3}_count-items\.js$/);
  assert.equal(fs.readFileSync(r.archivedAs, "utf8"), "return { n: project.name, sum: 1 + 2 };");
  assert.ok(fs.existsSync(r.backupPath));
  assert.deepEqual(r.sandboxViolations, []);
  assert.equal(r.undoSteps, 0);
  assert.equal(typeof r.durationMs, "number");
  assert.equal(t.project.saveCount, 1);
  const line = runLog(t).pop().split("\t");
  assert.equal(line[1], "count-items");
  assert.equal(line[2], "success");
  // The first result write is the "running" interim.
  const firstTmp = t.spied.calls.findIndex(([n, p]) => n === "writeFile" && /pr_mcp_result\.tmp$/.test(p));
  assert.ok(firstTmp >= 0);
  assert.ok(t.spied.calls.findIndex(([n, p]) => n === "writeFile" && /_count-items\.js$/.test(p)) > firstTmp,
    "interim result is written before the archive");
});

test("running interim result carries the command id and status running", async () => {
  const t = setup();
  let interim = null;
  const code = "await new Promise((r) => setTimeout(r, 30)); return 1;";
  const { writeCommand } = await import("./premiere-core-fakes.mjs");
  const id = writeCommand(t, "runScript", { code });
  const p = t.bridge.tick();
  for (let i = 0; i < 50 && !interim; i++) {
    await new Promise((r) => setTimeout(r, 5));
    try { const r = t.readResult(); if (r.status === "running") interim = r; } catch (e) { /* not yet */ }
  }
  await p;
  assert.ok(interim, "saw the running result");
  assert.equal(interim._commandId, id);
  assert.equal(interim._projectChanged, false);
  assert.equal(t.readResult().status, "success");
});

test("JSON-safe return values: depth 8, host objects become strings", async () => {
  const t = setup();
  const code = `
    const deep = {}; let cur = deep;
    for (let i = 0; i < 12; i++) { cur.next = {}; cur = cur.next; }
    return { deep, f: () => 1, nan: NaN, inf: Infinity, d: new Date(0), big: 10n, arr: [1, "a", null, undefined],
             host: project, cls: new (class Foo { toString() { return "Foo!"; } })(), nested: [[[{ x: 1 }]]] };`;
  const r = await t.send("runScript", { code });
  assert.equal(r.status, "success");
  const v = r.returnValue;
  assert.equal("f" in v, false, "function members are dropped, as in AE");
  assert.equal(v.nan, null);
  assert.equal(v.inf, null);
  assert.equal(v.d, "1970-01-01T00:00:00.000Z");
  assert.equal(v.big, "10");
  assert.deepEqual(v.arr, [1, "a", null, null]);
  assert.equal(typeof v.host, "string");
  assert.equal(v.cls, "Foo!");
  assert.deepEqual(v.nested, [[[{ x: 1 }]]]);
  let depth = 0;
  let cur = v.deep;
  while (cur && typeof cur === "object") { cur = cur.next; depth++; }
  assert.equal(cur, "[depth limit]");
  assert.equal(depth, 7);
});

test("SCRIPT_ERROR reports the script's own line; SYNTAX_ERROR; thrown non-Errors", async () => {
  const t = setup();
  let r = await t.send("runScript", { code: "const a = 1;\nconst b = 2;\nnull.boom();\nreturn a;" });
  assert.equal(r.status, "error");
  assert.equal(r.code, "SCRIPT_ERROR");
  assert.equal(r.line, 3);
  assert.match(r.message, /TypeError/);
  assert.ok(r.archivedAs);
  assert.ok(r.backupPath);
  r = await t.send("runScript", { code: "await Promise.resolve();\n\n\n\nthrow new Error('late');" });
  assert.equal(r.code, "SCRIPT_ERROR");
  assert.equal(r.line, 5);
  assert.equal(r.message, "Error: late");
  r = await t.send("runScript", { code: "return (;" });
  assert.equal(r.code, "SYNTAX_ERROR");
  assert.equal(r.line, null);
  r = await t.send("runScript", { code: "throw 'plain';" });
  assert.equal(r.code, "SCRIPT_ERROR");
  assert.equal(r.message, "plain");
  assert.equal(r.line, null);
  const lines = runLog(t);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.split("\t")[2] === "error"));
});

test("preconditions: NO_FOLDER, FOLDER_MISSING, BLOCKED_CALL, BAD_ARGS, SAVE_FAILED", async () => {
  const t = setup();
  let r = await t.send("runScript", { code: "return localStorage.getItem('x');" });
  assert.equal(r.code, "BLOCKED_CALL");
  assert.equal(r.refused, true);
  assert.equal(t.project.saveCount, 0, "nothing saved or archived for a blocked script");
  assert.equal(fs.existsSync(path.join(t.edit, "mcp-scripts")), false);
  r = await t.send("runScript", {});
  assert.equal(r.code, "BAD_ARGS");
  t.project.saveBehaviour = "throw";
  r = await t.send("runScript", { code: "return 1;" });
  assert.equal(r.code, "SAVE_FAILED");
  assert.ok(r.archivedAs);
  t.project.saveBehaviour = "ok";
  t.bridge.settings.setFolder(t.project.path, path.join(t.root, "missing"));
  r = await t.send("runScript", { code: "return 1;" });
  assert.equal(r.code, "FOLDER_MISSING");
  t.bridge.settings.clearFolder(t.project.path);
  r = await t.send("runScript", { code: "return 1;" });
  assert.equal(r.code, "NO_FOLDER");
});

test("runScriptFile: inside only, FILE_NOT_FOUND, scanned, no archive", async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.edit, "lib.js"), "return 6 * 7;");
  fs.writeFileSync(path.join(t.edit, "bad.js"), "eval('1');");
  fs.writeFileSync(path.join(t.root, "outside.js"), "return 1;");
  let r = await t.send("runScriptFile", { file: "lib.js" });
  assert.equal(r.status, "success");
  assert.equal(r.returnValue, 42);
  assert.equal(r.archivedAs, null);
  assert.equal(runLog(t).pop().split("\t")[1], "lib");
  r = await t.send("runScriptFile", { file: path.join(t.edit, "LIB.JS") });
  assert.equal(r.returnValue, 42);
  r = await t.send("runScriptFile", { file: "bad.js" });
  assert.equal(r.code, "BLOCKED_CALL");
  r = await t.send("runScriptFile", { file: path.join(t.root, "outside.js") });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScriptFile", { file: "..\\outside.js" });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScriptFile", { file: "nope.js" });
  assert.equal(r.code, "FILE_NOT_FOUND");
});

test("guarded fs: writes inside the folder work, outside are OUTSIDE_FOLDER; reads anywhere", async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.root, "readme.txt"), "hello");
  const inside = JSON.stringify(path.join(t.edit, "out", "a.txt"));
  const outside = JSON.stringify(path.join(t.root, "evil.txt"));
  let r = await t.send("runScript", {
    code: `const fs = require('fs');
await fs.mkdir(sandbox.path('out'), { recursive: true });
await fs.writeFile(${inside}, 'ok', { encoding: 'utf-8' });
return await fs.readFile(${JSON.stringify(path.join(t.root, "readme.txt"))}, { encoding: 'utf-8' });`,
  });
  assert.equal(r.status, "success", r.message);
  assert.equal(r.returnValue, "hello");
  assert.equal(fs.readFileSync(path.join(t.edit, "out", "a.txt"), "utf8"), "ok");
  r = await t.send("runScript", { code: `\nawait fs.writeFile(${outside}, 'x');` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  assert.equal(r.line, 2);
  assert.equal(fs.existsSync(path.join(t.root, "evil.txt")), false);
  r = await t.send("runScript", { code: `await fs.rename(${inside}, ${outside});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `await fs.unlink(${JSON.stringify(path.join(t.root, "readme.txt"))});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `await fs.copyFile(${inside}, ${outside});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `await fs.writeFile('relative.txt', 'x');` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `return typeof fs.watch;` });
  assert.equal(r.returnValue, "undefined");
});

test("guarded require: only premierepro, fs, uxp (no storage/shell), os", async () => {
  const t = setup();
  let r = await t.send("runScript", { code: "return require('child_process');" });
  assert.equal(r.code, "BLOCKED_CALL");
  r = await t.send("runScript", {
    code: "const u = require('uxp'); return { keys: Object.keys(u.storage).sort(), top: Object.keys(u).sort(), host: u.host.version, os: require('os').platform(), same: require('premierepro') === ppro };",
  });
  assert.equal(r.status, "success", r.message);
  assert.deepEqual(r.returnValue, { keys: ["domains", "fileTypes", "formats", "types"], top: ["host", "storage", "versions"], host: "26.5.2", os: "win32", same: true });
});

test("wrapped premierepro: export paths checked, host objects unwrapped", async () => {
  const t = setup();
  const out = JSON.stringify(path.join(t.edit, "exports", "cut.mp4"));
  const bad = JSON.stringify(path.join(t.root, "cut.mp4"));
  const seq = "const seq = { isHostSequence: true };";
  let r = await t.send("runScript", { code: `${seq} return await ppro.EncoderManager.getManager().exportSequence(seq, 0, ${out}, 'p.epr', true);` });
  assert.equal(r.status, "success", r.message);
  assert.equal(t.fake.state.calls.at(-1)[0], "exportSequence");
  r = await t.send("runScript", { code: `${seq} return await ppro.EncoderManager.getManager().exportSequence(seq, 0, ${bad}, 'p.epr', true);` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `${seq} return await ppro.EncoderManager.getManager().exportSequence(seq, 0);` });
  assert.equal(r.code, "OUTSIDE_FOLDER", "no output path means Premiere picks one: refused");
  r = await t.send("runScript", { code: `return await ppro.EncoderManager.getManager().encodeFile('C:/in.mov', ${bad});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `return await ppro.Exporter.exportSequenceFrame(null, null, 'f.png', ${JSON.stringify(t.root)});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `return await ppro.Exporter.exportSequenceFrame(null, null, 'f.png', ${JSON.stringify(t.edit)});` });
  assert.equal(r.status, "success", r.message);
  r = await t.send("runScript", { code: `return await ppro.ProjectConverter.exportAsOpenTimelineIO(null, ${bad});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `return await ppro.Project.createProject(${JSON.stringify(path.join(t.root, "x.prproj"))});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  // sandbox.export unwraps the sequence and resolves relative output paths.
  r = await t.send("runScript", { code: `${seq} return await sandbox.export(seq, 'exports/b.mp4', 'p.epr');` });
  assert.equal(r.status, "success", r.message);
  assert.equal(r.returnValue.output, path.join(t.edit, "exports", "b.mp4"));
  r = await t.send("runScript", { code: `${seq} return await sandbox.export(seq, ${bad}, 'p.epr');` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
});

test("Project.createProject from a script needs a remembered default root, like the typed tool", async () => {
  const t = setup();
  const inside = JSON.stringify(path.join(t.edit, "new", "New.prproj"));
  let r = await t.send("runScript", { code: `return !!(await ppro.Project.createProject(${inside}));` });
  assert.equal(r.code, "NOT_IN_DEFAULT_ROOT", "inside the sandbox folder alone is not enough");
  assert.equal(fs.existsSync(path.join(t.edit, "new", "New.prproj")), false);
  t.bridge.settings.rememberRoot(t.edit);
  r = await t.send("runScript", { code: `return !!(await ppro.Project.createProject(${inside}));` });
  assert.equal(r.status, "success", r.message);
  assert.equal(r.returnValue, true);
});

test("scratch disks: getScratchDiskSettings gets the real project; moving outside is blocked", async () => {
  const t = setup();
  const T = "ppro.Constants.ScratchDiskFolderType";
  let r = await t.send("runScript", { code: `const s = await ppro.ProjectSettings.getScratchDiskSettings(project); return s.getScratchDiskPath(${T}.VIDEO_PREVIEW);` });
  assert.equal(r.status, "success", r.message);
  assert.equal(r.returnValue, "C:\\Previews\\Video");
  r = await t.send("runScript", { code: `const s = await ppro.ProjectSettings.getScratchDiskSettings(project); s.setScratchDiskPath(${T}.VIDEO_PREVIEW, 'C:/Elsewhere');` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `const s = await ppro.ProjectSettings.getScratchDiskSettings(project); s.setScratchDiskPath(${T}.VIDEO_PREVIEW, ppro.Constants.ScratchDiskFolder.MY_DOCUMENTS);` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  r = await t.send("runScript", { code: `const s = await ppro.ProjectSettings.getScratchDiskSettings(project); return s.setScratchDiskPath(${T}.VIDEO_PREVIEW, ppro.Constants.ScratchDiskFolder.SAME_AS_PROJECT);` });
  assert.equal(r.status, "success", r.message);
  r = await t.send("runScript", { code: `const s = await ppro.ProjectSettings.getScratchDiskSettings(project); return s.setScratchDiskPath(${T}.AUDIO_PREVIEW, sandbox.path('previews'));` });
  assert.equal(r.status, "success", r.message);
});

test("saveAs: outside blocked; inside via sandbox or project carries the folder and changes the target", async () => {
  const t = setup();
  let r = await t.send("runScript", { code: `await project.saveAs(${JSON.stringify(path.join(t.root, "Out.prproj"))});` });
  assert.equal(r.code, "OUTSIDE_FOLDER");
  assert.equal(r._projectChanged, false);
  r = await t.send("runScript", { code: "return await sandbox.saveAs('cuts/V2.prproj');" });
  assert.equal(r.status, "success", r.message);
  const v2 = path.join(t.edit, "cuts", "V2.prproj");
  assert.equal(r.returnValue, v2);
  assert.equal(r._project, v2);
  assert.equal(r._projectChanged, true);
  assert.equal(t.bridge.settings.folderFor(v2).folder, t.edit);
  r = await t.send("runScript", { code: "return await sandbox.saveAs('cuts/V2.prproj');" }, { expectedProject: v2 });
  assert.equal(r.status, "success", "saving onto itself is not FILE_EXISTS");
  fs.writeFileSync(path.join(t.edit, "Taken.prproj"), "x");
  r = await t.send("runScript", { code: "return await sandbox.saveAs('Taken.prproj');" }, { expectedProject: v2 });
  assert.equal(r.code, "FILE_EXISTS");
  const v3 = path.join(t.edit, "V3.prproj");
  r = await t.send("runScript", { code: `await project.saveAs(${JSON.stringify(v3)}); return project.path;` }, { expectedProject: v2 });
  assert.equal(r.status, "success", r.message);
  assert.equal(r._project, v3);
  assert.equal(r._projectChanged, true);
  assert.equal(t.bridge.settings.folderFor(v3).folder, t.edit);
});

test("transactions: sandbox.transaction and project.executeTransaction count undo steps; async callback is an error", async () => {
  const t = setup();
  let r = await t.send("runScript", {
    code: `const a = project.createRenameAction;
sandbox.transaction('one', (compound) => { compound.addAction(project.createRenameAction('A')); });
sandbox.transaction('two', (compound, p) => { compound.addAction(p.createRenameAction('B')); });
project.lockedAccess(() => project.executeTransaction((c) => { c.addAction(project.createRenameAction('C')); }, 'raw'));
return 'ok';`,
  });
  assert.equal(r.status, "success", r.message);
  assert.equal(r.undoSteps, 3);
  assert.deepEqual(t.project.transactions.map((x) => x.undoString), ["MCP: one", "MCP: two", "raw"]);
  assert.deepEqual(t.project.transactions.map((x) => x.actions[0].rename), ["A", "B", "C"]);
  r = await t.send("runScript", { code: "\nsandbox.transaction('bad', async (c) => { c.addAction(project.createRenameAction('X')); });" });
  assert.equal(r.code, "SCRIPT_ERROR");
  assert.match(r.message, /transaction callback must be synchronous; do async work before calling transaction, then create and add actions synchronously inside it/);
  assert.equal(r.undoSteps, 0);
});

test("sandbox helper: folder, path, log; time helpers are in scope", async () => {
  const t = setup();
  const r = await t.send("runScript", { code: "sandbox.log('hi'); return { folder: sandbox.folder, p: sandbox.path('a/b.txt'), abs: sandbox.path('C:/x'), time: typeof time.parseTime };" });
  assert.equal(r.status, "success", r.message);
  assert.deepEqual(r.returnValue, { folder: t.edit, p: path.join(t.edit, "a", "b.txt"), abs: "C:/x", time: "function" });
  assert.deepEqual(r.logs, ["hi"]);
});

test("watchdog: a run past 60 s writes a possible-modal line to the run log", async () => {
  const t = setup();
  let release;
  const { writeCommand } = await import("./premiere-core-fakes.mjs");
  writeCommand(t, "runScript", { code: "await new Promise((r) => setTimeout(r, 40)); return 1;", name: "slow" });
  const p = t.bridge.tick();
  for (let i = 0; i < 100 && !t.clock.timers.length; i++) await new Promise((r) => setTimeout(r, 2));
  const timer = t.clock.timers.find((x) => x.ms === 60000);
  assert.ok(timer, "watchdog armed");
  timer.fn();
  await p;
  const lines = runLog(t);
  assert.ok(lines.some((l) => l.split("\t")[1] === "slow" && l.split("\t")[2] === "possible-modal"), lines.join("\n"));
  assert.equal(lines.at(-1).split("\t")[2], "success");
  assert.equal(timer.cleared, true);
  void release;
});
