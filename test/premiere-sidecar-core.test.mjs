// Unit tests for the CEP sidecar's panel core (src/premiere-cep/js/core.js): paths, stale check, eval-call
// building, host results, the state mirror, atomic writes, the gate, backups, stamps and the heartbeat.
// The ExtendScript host is replaced by a fake evalHost; files live in a temp bridge folder.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const require = createRequire(import.meta.url);
const Core = require("../src/premiere-cep/js/core.js");

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const roots = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function tempDir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pr-sidecar-" + label + "-"));
  roots.push(d);
  return d;
}

// ---------------- pure helpers ----------------

test("normalize strips the Win32 long-path prefix Premiere 26.5 reports", () => {
  assert.equal(Core.normalize("\\\\?\\D:\\Projects\\MyFilm\\Edit.prproj"), "d:/projects/myfilm/edit.prproj");
  assert.equal(Core.normalize("\\\\?\\UNC\\NAS\\Share\\Edit.prproj"), "//nas/share/edit.prproj");
  assert.equal(Core.normalize("//./D:/x"), "d:/x");
  assert.equal(Core.stripLongPathPrefix("\\\\?\\D:\\a"), "D:\\a");
  assert.equal(Core.stripLongPathPrefix("D:\\a"), "D:\\a");
  assert.ok(Core.samePath("\\\\?\\D:\\Projects\\Edit.prproj", "d:/projects/EDIT.prproj"));
  assert.ok(!Core.samePath("D:\\a\\Edit.prproj", "D:\\b\\Edit.prproj"));
  assert.ok(!Core.samePath("relative\\x", "relative\\x"), "relative paths never match");
  assert.equal(Core.normalize("D:\\a\\..\\..\\b"), null);
});

test("stale check: 120 s, unparseable timestamps never stale", () => {
  const ts = new Date(T0).toISOString();
  assert.equal(Core.isStale(ts, T0 + 120000), false);
  assert.equal(Core.isStale(ts, T0 + 120001), true);
  assert.equal(Core.isStale("not a date", T0 + 1e9), false);
  assert.equal(Core.commandAgeMs(undefined, T0), 0);
});

test("buildEvalCall: ES3-safe literal arguments that round-trip", () => {
  const args = { sequence: "Edits/Main \u00e9", note: "a\"b\\c\u2028d", items: [{ track: "V1", index: 0 }] };
  const script = Core.buildEvalCall("setSpeed", args);
  assert.match(script, /^__mcpSidecar_call\("setSpeed",\{/);
  assert.ok(/^[\x20-\x7e]*$/.test(script), "pure printable ASCII");
  assert.ok(!script.includes("\u2028"));
  let seen;
  new Function("__mcpSidecar_call", script)((name, a) => { seen = { name, a }; });
  assert.deepEqual(seen, { name: "setSpeed", a: args });
  assert.throws(() => Core.buildEvalCall("x();evil", {}), /Bad host function name/);
});

test("parseHostResult: JSON objects pass, CEP errors become HOST_ERROR", () => {
  assert.deepEqual(Core.parseHostResult('{"status":"success","x":1}'), { status: "success", x: 1 });
  for (const bad of ["EvalScript error.", "", undefined, "undefined", "[1,2]", "{oops"]) {
    const r = Core.parseHostResult(bad);
    assert.equal(r.status, "error", String(bad));
    assert.equal(r.code, "HOST_ERROR");
  }
});

test("validateArgs: shapes checked before any save", () => {
  assert.equal(Core.validateArgs("setSpeed", { sequence: "S", track: "V1", index: 0, percent: 50 }), null);
  assert.match(Core.validateArgs("setSpeed", { sequence: "S", track: "V1", index: 0, percent: 0 }), /percent/);
  assert.match(Core.validateArgs("setSpeed", { sequence: "S", track: "X1", index: 0, percent: 50 }), /track/);
  assert.match(Core.validateArgs("setSpeed", { track: "V1", index: 0, percent: 50 }), /sequence/);
  assert.equal(Core.validateArgs("addAudioTransition", { sequence: "S", track: "A1", index: 2, edge: "both", durationFrames: 12 }), null);
  assert.match(Core.validateArgs("addAudioTransition", { sequence: "S", track: "V1", index: 2, edge: "both", durationFrames: 12 }), /audio track/);
  assert.match(Core.validateArgs("addAudioTransition", { sequence: "S", track: "A1", index: 2, edge: "mid", durationFrames: 12 }), /edge/);
  assert.match(Core.validateArgs("addAudioTransition", { sequence: "S", track: "A1", index: 2, edge: "end", durationFrames: 1.5 }), /durationFrames/);
  assert.equal(Core.validateArgs("link", { sequence: "S", items: [{ track: "V1", index: 0 }, { track: "A1", index: 0 }] }), null);
  assert.match(Core.validateArgs("unlink", { sequence: "S", items: [] }), /non-empty/);
  assert.match(Core.validateArgs("unlink", { sequence: "S", items: [{ track: "A1", index: -1 }] }), /index/);
});

// ---------------- files ----------------

test("atomicWrite: tmp then rename, nothing left behind; falls back to in-place", () => {
  const d = tempDir("atomic");
  const file = path.join(d, "r.json");
  const tmp = path.join(d, "r.tmp");
  fs.writeFileSync(file, "old");
  assert.equal(Core.atomicWrite(fs, file, tmp, "new"), "atomic");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(fs.existsSync(tmp), false);
  const stubborn = { ...fs, renameSync() { throw new Error("EBUSY"); } };
  assert.equal(Core.atomicWrite(stubborn, file, tmp, "newer"), "in-place");
  assert.equal(fs.readFileSync(file, "utf8"), "newer");
  assert.equal(fs.existsSync(tmp), false);
});

test("readMirror: missing, unreadable, stale and fresh; folderFor matches \\\\?\\ paths", () => {
  const d = tempDir("mirror");
  const file = path.join(d, "pr_sidecar_state.json");
  assert.equal(Core.readMirror(fs, file, T0).refusal.code, "SIDECAR_STATE_STALE");
  fs.writeFileSync(file, "{nope");
  assert.match(Core.readMirror(fs, file, T0).refusal.message, /unreadable/);
  fs.writeFileSync(file, JSON.stringify({ ts: new Date(T0 - 11000).toISOString(), paused: false, projects: [] }));
  assert.match(Core.readMirror(fs, file, T0).refusal.message, /stale \(11 s old\)/);
  const mirror = { version: 1, ts: new Date(T0 - 500).toISOString(), paused: false,
    projects: [{ path: "D:\\Projects\\MyFilm\\edit\\Edit.prproj", folder: "D:\\Projects\\MyFilm\\edit" }, { path: "D:\\Other.prproj", folder: null }] };
  fs.writeFileSync(file, JSON.stringify(mirror));
  const r = Core.readMirror(fs, file, T0);
  assert.deepEqual(r.mirror, mirror);
  assert.deepEqual(Core.folderFor(r.mirror, "\\\\?\\d:\\projects\\myfilm\\EDIT\\Edit.prproj"), { listed: true, folder: "D:\\Projects\\MyFilm\\edit" });
  assert.deepEqual(Core.folderFor(r.mirror, "D:\\Other.prproj"), { listed: true, folder: null });
  assert.deepEqual(Core.folderFor(r.mirror, "D:\\Closed.prproj"), { listed: false, folder: null });
});

test("backupProject: <folder>/mcp-scripts/backups/<stamp>_<base>.prproj, keeps the newest 10", () => {
  const d = tempDir("backup");
  const proj = path.join(d, "Edit.prproj");
  fs.writeFileSync(proj, "<project/>");
  const dir = path.join(d, "mcp-scripts", "backups");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "20200101-000000-000_Other.prproj"), "x");
  let last;
  for (let i = 0; i < 12; i++) last = Core.backupProject(fs, d, "\\\\?\\" + proj, new Date(T0 + i * 1000));
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.filter((n) => n.endsWith("_Edit.prproj")).length, 10);
  assert.ok(names.includes("20200101-000000-000_Other.prproj"), "other projects' backups are kept");
  assert.equal(fs.readFileSync(last, "utf8"), "<project/>");
  assert.match(path.basename(last), /^\d{8}-\d{6}-\d{3}_Edit\.prproj$/);
});

// ---------------- the sidecar ----------------

function makeSidecar({ mirror = "fresh", paused = false, folder = "edit", open, hostResults = {}, fsImpl = fs } = {}) {
  const root = tempDir("sc");
  const bridgeDir = path.join(root, "bridge");
  const edit = path.join(root, "edit");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.mkdirSync(edit, { recursive: true });
  const projectPath = path.join(edit, "Edit.prproj");
  fs.writeFileSync(projectPath, "<project/>");
  const clock = { t: T0, now: () => clock.t, intervals: [], setInterval(f, ms) { clock.intervals.push({ f, ms }); return clock.intervals.length; }, clearInterval(h) { clock.intervals[h - 1].cleared = true; } };
  const calls = [];
  const openProjects = open || [{ path: "\\\\?\\" + projectPath, name: "Edit.prproj", isActive: true }];
  const evalHost = async (name, args) => {
    calls.push({ name, args });
    if (hostResults[name]) return typeof hostResults[name] === "function" ? hostResults[name](args) : hostResults[name];
    if (name === "listProjects") return { status: "success", projects: openProjects };
    if (name === "saveProject") return { status: "success", path: args.projectPath };
    return { status: "success", op: name, undoSteps: 1 };
  };
  const logs = [];
  const sc = Core.createSidecar({ fs: fsImpl, bridgeDir, evalHost, clock, log: (m) => logs.push(m), version: "1.0.0", pid: 4242 });
  const t = { root, bridgeDir, edit, projectPath, clock, calls, logs, sc };
  t.writeMirror = (m) => fs.writeFileSync(path.join(bridgeDir, "pr_sidecar_state.json"), JSON.stringify(m));
  if (mirror === "fresh") {
    t.writeMirror({ version: 1, writer: "uxp", ts: new Date(T0 - 300).toISOString(), paused,
      projects: [{ path: projectPath, folder: folder === "edit" ? edit : folder }] });
  }
  let n = 0;
  t.write = (command, args = {}, extra = {}) => {
    const data = { id: extra.id || `${T0}-c${++n}`, command, args, timestamp: new Date(clock.t).toISOString(), status: "pending", expectedProject: projectPath, ...extra };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    fs.writeFileSync(path.join(bridgeDir, "prx_command.json"), JSON.stringify(data));
    return data.id;
  };
  t.result = () => JSON.parse(fs.readFileSync(path.join(bridgeDir, "prx_mcp_result.json"), "utf8"));
  t.command = () => JSON.parse(fs.readFileSync(path.join(bridgeDir, "prx_command.json"), "utf8"));
  t.send = async (command, args, extra) => {
    const id = t.write(command, args, extra);
    assert.equal(await sc.tick(), true, "processed");
    const r = t.result();
    assert.equal(r._commandId, id);
    return r;
  };
  return t;
}

const SPEED = { sequence: "Edits/Main", track: "V1", index: 0, percent: 50 };

test("success: gate, save, backup, host call with projectPath, stamps, status completed", async () => {
  const t = makeSidecar();
  const r = await t.send("setSpeed", SPEED);
  assert.equal(r.status, "success");
  assert.equal(r.op, "setSpeed");
  assert.equal(r.undoSteps, 1);
  assert.equal(r._commandExecuted, "setSpeed");
  assert.equal(r._project, t.projectPath, "target path without the \\\\?\\ prefix");
  assert.equal(r._projectChanged, false);
  assert.equal(r._responseTimestamp, new Date(T0).toISOString());
  assert.ok(r.backupPath.startsWith(path.join(t.edit, "mcp-scripts", "backups")));
  assert.ok(fs.existsSync(r.backupPath));
  assert.deepEqual(t.calls.map((c) => c.name), ["listProjects", "saveProject", "setSpeed"]);
  assert.deepEqual(t.calls[2].args, { ...SPEED, projectPath: t.projectPath });
  assert.equal(t.command().status, "completed");
  assert.equal(fs.existsSync(path.join(t.bridgeDir, "prx_mcp_result.tmp")), false);
});

test("same id is not reprocessed; non-pending commands are ignored", async () => {
  const t = makeSidecar();
  const id = t.write("setSpeed", SPEED);
  assert.equal(await t.sc.tick(), true);
  fs.writeFileSync(path.join(t.bridgeDir, "prx_command.json"), JSON.stringify({ ...t.command(), status: "pending" }));
  assert.equal(await t.sc.tick(), false, "same id");
  t.write("setSpeed", SPEED, { status: "completed" });
  assert.equal(await t.sc.tick(), false, "not pending");
  assert.equal(t.result()._commandId, id);
});

test("a newer command written mid-run is not clobbered", async () => {
  const t = makeSidecar({
    hostResults: {
      setSpeed: () => {
        t.write("unlink", { sequence: "S", items: [{ track: "V1", index: 0 }] }, { id: "newer" });
        return { status: "success" };
      },
    },
  });
  await t.send("setSpeed", SPEED);
  const cmd = t.command();
  assert.equal(cmd.id, "newer");
  assert.equal(cmd.status, "pending");
  assert.equal(await t.sc.tick(), true);
  assert.equal(t.result()._commandId, "newer");
});

test("prx_command.json is never written after the final result lands (the server writes next)", async () => {
  // Same rule as the UXP panel: the id check is read-then-write, so the status must be set first.
  for (const failing of [false, true]) {
    let landed = false;
    const after = [];
    const fsImpl = Object.create(fs);
    for (const name of ["writeFileSync", "renameSync", "unlinkSync"]) {
      fsImpl[name] = (...args) => {
        if (landed && args.some((a) => typeof a === "string" && /prx_command\.json/.test(a))) after.push(name);
        const r = fs[name](...args);
        if (name === "renameSync" && /prx_mcp_result\.json$/.test(args[1])) landed = true;
        return r;
      };
    }
    const t = makeSidecar({ fsImpl, hostResults: failing ? { setSpeed: { status: "error", code: "HOST_ERROR", message: "x" } } : {} });
    const r = await t.send("setSpeed", SPEED);
    assert.equal(r.status, failing ? "error" : "success");
    assert.deepEqual(after, [], "no command-file write after the result");
    assert.equal(t.command().status, failing ? "error" : "completed");
  }
});

test("core.js sets window.MCPSidecarCore even when CEP's mixed context also defines module", async () => {
  // Live bug: with --mixed-context, Node's `module` exists in the panel page, so a UMD wrapper that
  // prefers module.exports never set window.MCPSidecarCore and main.js silently did nothing.
  const vm = await import("node:vm");
  const src = fs.readFileSync(new URL("../src/premiere-cep/js/core.js", import.meta.url), "utf8");
  const win = {};
  const mod = { exports: {} };
  const sandbox = { window: win, module: mod, self: win };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof win.MCPSidecarCore?.createSidecar, "function", "window.MCPSidecarCore is set");
  assert.equal(typeof mod.exports.createSidecar, "function", "module.exports is still set for Node");
});

test("STALE before anything else, even for ping", async () => {
  const t = makeSidecar({ mirror: "none" });
  t.clock.t = T0 + 121000;
  const r = await t.send("ping", {}, { timestamp: new Date(T0).toISOString() });
  assert.equal(r.code, "STALE");
  assert.equal(r.refused, true);
  assert.equal(t.command().status, "error");
  assert.equal(t.calls.length, 0);
});

test("ping is exempt from the gate", async () => {
  const t = makeSidecar({ mirror: "none" });
  const r = await t.send("ping", {}, { expectedProject: undefined });
  assert.equal(r.status, "success");
  assert.equal(r.version, "1.0.0");
  assert.equal(r.pid, 4242);
  assert.deepEqual(r.operations, ["setSpeed", "addAudioTransition", "link", "unlink"]);
});

test("gate order: mirror, PAUSED, PROJECT_NOT_CONFIRMED, PROJECT_UNSAVED, PROJECT_NOT_OPEN", async () => {
  let t = makeSidecar({ mirror: "none" });
  assert.equal((await t.send("setSpeed", SPEED)).code, "SIDECAR_STATE_STALE");
  t.writeMirror({ ts: new Date(T0 - 20000).toISOString(), paused: false, projects: [] });
  assert.equal((await t.send("setSpeed", SPEED)).code, "SIDECAR_STATE_STALE");
  assert.equal(t.calls.length, 0);

  t = makeSidecar({ paused: true });
  let r = await t.send("setSpeed", SPEED, { expectedProject: undefined });
  assert.equal(r.code, "PAUSED", "pause wins over a missing project");
  assert.equal(r._project, "");

  t = makeSidecar();
  r = await t.send("setSpeed", SPEED, { expectedProject: undefined });
  assert.equal(r.code, "PROJECT_NOT_CONFIRMED");
  r = await t.send("setSpeed", SPEED, { expectedProject: "" });
  assert.equal(r.code, "PROJECT_UNSAVED");
  r = await t.send("setSpeed", SPEED, { expectedProject: "D:\\Elsewhere\\Other.prproj" });
  assert.equal(r.code, "PROJECT_NOT_OPEN");
  assert.deepEqual(r.openProjects, [t.projectPath], "listed without the \\\\?\\ prefix");
  assert.equal(r.expectedProject, "D:\\Elsewhere\\Other.prproj");
  assert.deepEqual(t.calls.map((c) => c.name), ["listProjects"], "only the PROJECT_NOT_OPEN check reached the host");
  assert.equal(t.command().status, "error");
});

test("target resolved by path: case, separators and the \\\\?\\ prefix", async () => {
  const t = makeSidecar();
  const r = await t.send("link", { sequence: "S", items: [{ track: "V1", index: 0 }] },
    { expectedProject: "\\\\?\\" + t.projectPath.toUpperCase().replace(/\\/g, "/") });
  assert.equal(r.status, "success");
  assert.equal(r._project, t.projectPath);
});

test("BAD_ARGS before save; unknown command; host list failure", async () => {
  let t = makeSidecar();
  let r = await t.send("setSpeed", { ...SPEED, percent: -1 });
  assert.equal(r.code, "BAD_ARGS");
  assert.equal(r.undoSteps, 0);
  assert.deepEqual(t.calls.map((c) => c.name), ["listProjects"], "no save, no backup");
  assert.equal(fs.existsSync(path.join(t.edit, "mcp-scripts")), false);
  r = await t.send("runScript", { code: "1" });
  assert.equal(r.code, "UNKNOWN_COMMAND");

  t = makeSidecar({ hostResults: { listProjects: { status: "error", code: "HOST_ERROR", message: "EvalScript error." } } });
  r = await t.send("setSpeed", SPEED);
  assert.equal(r.code, "HOST_ERROR");
});

test("NO_FOLDER and FOLDER_MISSING come from the mirror; nothing is saved", async () => {
  let t = makeSidecar({ folder: null });
  let r = await t.send("setSpeed", SPEED);
  assert.equal(r.code, "NO_FOLDER");
  assert.equal(r.refused, true);
  t = makeSidecar({ folder: "D:\\Gone\\Folder\\That\\Does\\Not\\Exist" });
  r = await t.send("setSpeed", SPEED);
  assert.equal(r.code, "FOLDER_MISSING");
  assert.ok(!t.calls.some((c) => c.name === "saveProject"));
});

test("SAVE_FAILED stops the run; a backup failure is only a warning", async () => {
  let t = makeSidecar({ hostResults: { saveProject: { status: "error", code: "SAVE_FAILED", message: "Save before run failed" } } });
  let r = await t.send("setSpeed", SPEED);
  assert.equal(r.code, "SAVE_FAILED");
  assert.ok(!t.calls.some((c) => c.name === "setSpeed"));

  t = makeSidecar();
  fs.rmSync(t.projectPath);
  r = await t.send("addAudioTransition", { sequence: "S", track: "A1", index: 0, edge: "end", durationFrames: 12 });
  assert.equal(r.status, "success");
  assert.equal(r.backupPath, null);
  assert.match(r.backupWarning, /Backup failed/);
});

test("host errors pass through with their code and undoSteps 0", async () => {
  const t = makeSidecar({ hostResults: { unlink: { status: "error", code: "TARGET_NOT_ACTIVE", message: "bring it to the front" } } });
  const r = await t.send("unlink", { sequence: "S", items: [{ track: "A1", index: 0 }] });
  assert.equal(r.code, "TARGET_NOT_ACTIVE");
  assert.equal(r.undoSteps, 0);
  assert.ok(r.backupPath, "the backup was taken before the host ran");
  assert.equal(t.command().status, "error");
});

test("heartbeat: { pid, ts, version } on start and every 2 s; polling every 500 ms", async () => {
  const t = makeSidecar();
  t.sc.start();
  const hbFile = path.join(t.bridgeDir, "prx_heartbeat.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(hbFile, "utf8")), { ts: new Date(T0).toISOString(), version: "1.0.0", pid: 4242 });
  assert.deepEqual(t.clock.intervals.map((i) => i.ms).sort((a, b) => a - b), [500, 2000]);
  t.clock.t += 2000;
  t.clock.intervals.find((i) => i.ms === 2000).f();
  assert.equal(JSON.parse(fs.readFileSync(hbFile, "utf8")).ts, new Date(T0 + 2000).toISOString());
  assert.equal(fs.existsSync(path.join(t.bridgeDir, "prx_heartbeat.tmp")), false);
  t.sc.stop();
  assert.ok(t.clock.intervals.every((i) => i.cleared));
});

test("bad JSON in the command file is logged once and does not throw", async () => {
  const t = makeSidecar();
  fs.writeFileSync(path.join(t.bridgeDir, "prx_command.json"), "{half");
  assert.equal(await t.sc.tick(), false);
  assert.equal(await t.sc.tick(), false);
  assert.equal(t.logs.filter((l) => l.startsWith("Error checking for commands")).length, 1);
});
