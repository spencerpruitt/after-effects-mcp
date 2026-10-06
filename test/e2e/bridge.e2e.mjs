// End-to-end tests for the bridge command/result file protocol ("seam 1").
// Contract: docs/bridge-protocol.md. Spec: "AE MCP Folder Sandbox - Spec.md" -> Testing Decisions -> Seam 1.
//
// Runs against the REAL After Effects with the MCP bridge panel open and Auto-run ticked. It closes the
// project you have open, works in throwaway projects under %TEMP%\ae-mcp-e2e-<stamp>\, and reopens your
// project at the end. See test/e2e/README.md.
//
//   node test/e2e/bridge.e2e.mjs --i-saved-my-project [--interactive]
//
// Two channels into AE:
//   (a) the bridge files, exactly as the MCP server uses them (ae_command.json / ae_mcp_result.json);
//   (b) a back channel for setup/teardown: AfterFX.exe -r <script.jsx>, which writes an output file we poll for.
import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------------------------------------
// Flags and safety gate
// ---------------------------------------------------------------------------------------------------------
const ARGS = new Set(process.argv.slice(2));
const INTERACTIVE = ARGS.has("--interactive");

if (!ARGS.has("--i-saved-my-project")) {
  console.error(
    [
      "Refusing to run: pass --i-saved-my-project.",
      "",
      "This suite drives the After Effects instance you have open. It closes your current project",
      "(AE will prompt if it has unsaved changes), creates throwaway projects in a temp folder, and",
      "reopens your project when it finishes. Save your work first, then run:",
      "",
      "  node test/e2e/bridge.e2e.mjs --i-saved-my-project [--interactive]",
      "",
      "--interactive also runs the Pause test, which asks you to tick/untick the panel's Pause checkbox.",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = path.join(here, "..", "..", "src", "scripts", "mcp-bridge-auto.jsx");

// Same resolution as the server and the panel.
const BRIDGE_DIR = process.env.AE_MCP_BRIDGE_DIR || path.join(os.homedir(), "ae-mcp-bridge");
const COMMAND_FILE = path.join(BRIDGE_DIR, "ae_command.json");
const RESULT_FILE = path.join(BRIDGE_DIR, "ae_mcp_result.json");
const AFTERFX =
  process.env.AE_AFTERFX_EXE || "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";

const SANDBOX_SECTION = "MCPBridgeSandbox";
const STAMP = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + process.pid;
const ROOT = path.join(os.tmpdir(), `ae-mcp-e2e-${STAMP}`);
const SHOT = path.join(ROOT, "shot"); // the sandbox folder
const OUTSIDE = path.join(ROOT, "outside"); // sibling, must never be written
const SECOND_DIR = path.join(ROOT, "second"); // a second project, for mismatch tests
const FRESH_DIR = path.join(ROOT, "fresh"); // a never-configured project
const BC_DIR = path.join(ROOT, "backchannel"); // back-channel scripts and their output
const E2E_AEP = path.join(SHOT, "E2E.aep");
const SECOND_AEP = path.join(SECOND_DIR, "Second.aep");
const FRESH_AEP = path.join(FRESH_DIR, "Fresh.aep");

// Pure path policy, extracted from the panel exactly like test/pathPolicy.test.mjs does.
const panelSource = fs.readFileSync(PANEL_SOURCE, "utf8");
const policyMatch = /\/\/ === BEGIN PATH POLICY ===([\s\S]*?)\/\/ === END PATH POLICY ===/.exec(panelSource);
if (!policyMatch) throw new Error("PATH POLICY markers not found in mcp-bridge-auto.jsx");
const { normalize } = new Function(policyMatch[1] + "\nreturn MCPPathPolicy;")();
const sandboxKey = (projectPath) => encodeURIComponent(normalize(projectPath));
const samePath = (a, b) => normalize(a) === normalize(b);

const state = {
  original: null, // { path, numItems, dirty } of the user's project before we touched anything
  e2eProject: null, // E2E.aep as AE reports it (fsName)
  secondProject: null,
  settingKeysWritten: new Set(),
  setupComplete: false,
  tornDown: false,
};

// ---------------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------------
const fmt = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 1200 ? s.slice(0, 1200) + "...(truncated)" : s;
};
// A JS string literal that is also valid ES3 (for embedding values into ExtendScript).
const lit = (s) => JSON.stringify(String(s));

function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null; // missing, or mid-rename, or half-written: just poll again
  }
}

// tmp + rename so the panel never reads a half-written command.
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      // The panel may have the file open for reading for a moment.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

async function waitUntil(predicate, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Channel (a): the bridge files, as the MCP server uses them
// ---------------------------------------------------------------------------------------------------------
let idSeq = 0;
const newId = () => `${Date.now()}-e2e${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Write ae_command.json. expectedProject defaults to E2E.aep; pass a string to override,
 * or omitExpected: true to leave the field out entirely.
 */
function writeCommand(command, args = {}, { expectedProject, omitExpected = false, allowBeforeSetup = false, timestamp } = {}) {
  if (!allowBeforeSetup && !state.setupComplete) {
    throw new Error("Refusing to send a command before the throwaway project is open (setup incomplete).");
  }
  const id = newId();
  const cmd = { id, command, args, timestamp: timestamp || new Date().toISOString(), status: "pending" };
  if (!omitExpected) cmd.expectedProject = expectedProject === undefined ? state.e2eProject : expectedProject;
  // Escape non-ASCII so the panel's File.read() decodes it the same under any codepage.
  const text = JSON.stringify(cmd, null, 2).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  atomicWrite(COMMAND_FILE, text);
  return id;
}

/**
 * Poll ae_mcp_result.json for the result whose _commandId matches, waiting past status "running".
 * Returns { result, statuses } where statuses lists each distinct state seen for this id, in order.
 */
async function waitForResult(id, { timeoutMs = 30000 } = {}) {
  const end = Date.now() + timeoutMs;
  const statuses = [];
  let lastKey = null;
  let lastSeen = null;
  for (;;) {
    const r = readJson(RESULT_FILE);
    if (r) lastSeen = r;
    if (r && r._commandId === id) {
      const key = `${r.status}|${r._responseTimestamp}`;
      if (key !== lastKey) {
        statuses.push(r.status);
        lastKey = key;
      }
      if (r.status !== "running") return { result: r, statuses };
    }
    if (Date.now() > end) {
      const cmd = readJson(COMMAND_FILE);
      throw new assert.AssertionError({
        message:
          `No final result for command ${id} after ${timeoutMs} ms (states seen for it: ${fmt(statuses)}).\n` +
          `  command file now: ${fmt(cmd)}\n  result file now: ${fmt(lastSeen)}`,
      });
    }
    await sleep(50);
  }
}

async function sendCommand(command, args = {}, opts = {}) {
  const id = writeCommand(command, args, opts);
  const { result, statuses } = await waitForResult(id, opts);
  return Object.assign(result, { _statusesSeen: statuses, _sentId: id });
}

const runScript = (code, name, opts) => sendCommand("runScript", name ? { code, name } : { code }, opts);
const runScriptFile = (file, opts) => sendCommand("runScriptFile", { file }, opts);
const getSandboxFolder = (opts) => sendCommand("getSandboxFolder", {}, opts);

/** Wait until the command file holds no pending/running command (so the panel is free for the back channel). */
async function waitForIdle(timeoutMs = 15000) {
  try {
    await waitUntil(() => {
      const c = readJson(COMMAND_FILE);
      return !c || (c.status !== "pending" && c.status !== "running");
    }, timeoutMs, "the bridge to go idle");
  } catch (e) {
    console.warn(`[e2e] warning: ${e.message}; continuing. Command file: ${fmt(readJson(COMMAND_FILE))}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Channel (b): back channel, AfterFX.exe -r <script.jsx>
// ---------------------------------------------------------------------------------------------------------
// Prelude available to every back-channel body. __ROOT is the lowercased temp root.
const BC_PRELUDE = String.raw`
function __ser(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return String(v);
  if (t === "string") {
    return '"' + v.replace(/[\\"\u0000-\u001f\u007f-\uffff]/g, function (c) {
      if (c === "\\") return "\\\\";
      if (c === '"') return '\\"';
      var h = c.charCodeAt(0).toString(16);
      while (h.length < 4) h = "0" + h;
      return "\\u" + h;
    }) + '"';
  }
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(__ser(v[i]));
    return "[" + a.join(",") + "]";
  }
  if (t === "object") {
    var p = [];
    for (var k in v) if (v.hasOwnProperty(k)) p.push(__ser(String(k)) + ":" + __ser(v[k]));
    return "{" + p.join(",") + "}";
  }
  return __ser(String(v));
}
function __isTestPath(p) {
  return String(p).toLowerCase().replace(/\//g, "\\").indexOf(__ROOT + "\\") === 0;
}
// Close the open project. Throwaway projects are discarded; anything else gets AE's normal save prompt.
function __closeCurrent() {
  var f = app.project.file;
  if ((f && __isTestPath(f.fsName)) || (!f && app.project.numItems === 0)) {
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  } else if (!app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)) {
    throw new Error("Closing " + (f ? f.fsName : "the untitled project") + " was cancelled");
  }
}
function __open(p) {
  __closeCurrent();
  app.open(new File(p));
  return app.project.file ? app.project.file.fsName : "";
}
function __saveAs(p) {
  if (!__isTestPath(p)) throw new Error("Back channel refuses to save outside the temp root: " + p);
  app.project.save(new File(p));
  return app.project.file.fsName;
}
function __openPath() { return app.project.file ? app.project.file.fsName : ""; }
`;

let bcSeq = 0;

/** Run `body` (an ExtendScript function body; use return) inside the running AE and return its value. */
async function runInAE(body, { timeoutMs = 60000, label = "back channel" } = {}) {
  const n = ++bcSeq;
  const jsx = path.join(BC_DIR, `bc-${n}.jsx`);
  const out = path.join(BC_DIR, `bc-${n}.out.json`);
  const done = path.join(BC_DIR, `bc-${n}.done`);
  const script = [
    "(function () {",
    `var __ROOT = ${lit(ROOT.toLowerCase())};`,
    BC_PRELUDE,
    "var __r;",
    "try {",
    "  __r = { ok: true, value: (function () {",
    body,
    "  })() };",
    "} catch (e) {",
    "  __r = { ok: false, error: String(e), line: (e && e.line) || null };",
    "}",
    `var __o = new File(${lit(out)}); __o.encoding = "UTF-8"; __o.open("w"); __o.write(__ser(__r)); __o.close();`,
    `var __d = new File(${lit(done)}); __d.open("w"); __d.write("1"); __d.close();`,
    "})();",
  ].join("\n");
  fs.writeFileSync(jsx, "\uFEFF" + script, "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(AFTERFX, ["-r", jsx], { stdio: "ignore", windowsHide: true, detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  try {
    await waitUntil(() => fs.existsSync(done), timeoutMs, `AE to run ${label} (${jsx})`);
  } catch (e) {
    throw new Error(`${e.message}. Is After Effects running and not showing a modal dialog?`);
  }
  const r = readJson(out);
  if (!r) throw new Error(`${label}: unreadable output ${out}`);
  if (!r.ok) throw new Error(`${label} failed in AE: ${r.error}${r.line ? ` (line ${r.line})` : ""}`);
  return r.value;
}

async function setSandboxSetting(projectPath, folderValue) {
  const key = sandboxKey(projectPath);
  state.settingKeysWritten.add(key);
  await runInAE(`app.settings.saveSetting(${lit(SANDBOX_SECTION)}, ${lit(key)}, ${lit(folderValue)}); return true;`, {
    label: "set sandbox setting",
  });
}

/** Make sure E2E.aep is the open project and its folder is SHOT. */
async function ensureE2E() {
  if (!state.setupComplete || state.tornDown) throw new Error("Setup did not complete (or teardown already ran); not touching AE.");
  await waitForIdle();
  const key = sandboxKey(state.e2eProject);
  state.settingKeysWritten.add(key);
  const open = await runInAE(
    `var want = ${lit(state.e2eProject)};
     if (__openPath().toLowerCase() !== want.toLowerCase()) __open(want);
     app.settings.saveSetting(${lit(SANDBOX_SECTION)}, ${lit(key)}, ${lit(SHOT)});
     return __openPath();`,
    { label: "reopen E2E.aep" },
  );
  assert.ok(samePath(open, state.e2eProject), `back channel: expected E2E.aep open, got ${open}`);
}

// ---------------------------------------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------------------------------------
function assertSuccess(res, ctx) {
  assert.equal(res.status, "success", `${ctx}: expected success, got ${fmt(res)}`);
}
// Codes for commands refused before running (gate, preconditions, STALE): these carry refused: true.
const REFUSAL_CODES = new Set([
  "PAUSED", "PROJECT_NOT_CONFIRMED", "PROJECT_MISMATCH", "STALE",
  "NO_FOLDER", "FOLDER_MISSING", "BLOCKED_CALL", "OUTSIDE_FOLDER",
]);
function assertCode(res, code, ctx) {
  assert.equal(res.status, "error", `${ctx}: expected status "error" with code ${code}, got ${fmt(res)}`);
  assert.equal(res.code, code, `${ctx}: expected code ${code}, got ${fmt(res)}`);
  assert.ok(typeof res.message === "string" && res.message.length > 0, `${ctx}: refusal needs a message, got ${fmt(res)}`);
  if (REFUSAL_CODES.has(code)) assert.equal(res.refused, true, `${ctx}: ${code} refusals carry refused: true, got ${fmt(res)}`);
}
function assertGateRefusal(res, code, ctx) {
  assertCode(res, code, ctx);
  assert.equal(res.refused, true, `${ctx}: gate refusals carry refused: true, got ${fmt(res)}`);
}
function assertBlockedWrite(res, target, ctx) {
  assert.equal(res.status, "error", `${ctx}: write outside the folder should fail, got ${fmt(res)}`);
  assert.match(String(res.message), /blocked/i, `${ctx}: message should say "Blocked", got ${fmt(res)}`);
  assert.ok(
    String(res.message).toLowerCase().includes(path.basename(target).toLowerCase()),
    `${ctx}: message should name the refused path (${target}), got ${fmt(res)}`,
  );
}
/** After Claude saved to newPath inside the folder: the folder follows the project, and newPath is the confirmed project. */
async function assertFolderCarriedOver(newPath, ctx) {
  const gs = await getSandboxFolder({ expectedProject: newPath });
  assertSuccess(gs, `${ctx}: getSandboxFolder after save`);
  assert.ok(samePath(gs.projectPath, newPath), `${ctx}: open project should be ${newPath}, got ${fmt(gs)}`);
  assert.ok(samePath(gs.folder, SHOT), `${ctx}: folder should carry over to the new project, got ${fmt(gs)}`);
  assert.equal(gs.scriptsEnabled, true, `${ctx}: scriptsEnabled after save, got ${fmt(gs)}`);
  const r = await runScript(`return "accepted";`, "after-save", { expectedProject: newPath });
  assertSuccess(r, `${ctx}: runScript with expectedProject = the new path`);
  return gs;
}
const assertMissing = (p, ctx) => assert.ok(!fs.existsSync(p), `${ctx}: ${p} must not exist`);

function runLogLines() {
  const file = path.join(SHOT, "mcp-scripts", "run-log.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------------------------------------
async function setup() {
  if (!fs.existsSync(AFTERFX)) throw new Error(`AfterFX.exe not found at ${AFTERFX} (set AE_AFTERFX_EXE)`);
  for (const d of [SHOT, OUTSIDE, SECOND_DIR, FRESH_DIR, BC_DIR]) fs.mkdirSync(d, { recursive: true });

  // 1. Is the panel alive and new enough? getSandboxFolder is read-only and exempt from the gate.
  const probeId = writeCommand("getSandboxFolder", {}, { omitExpected: true, allowBeforeSetup: true });
  let probe;
  try {
    probe = (await waitForResult(probeId, { timeoutMs: 10000 })).result;
  } catch (e) {
    const r = readJson(RESULT_FILE);
    const hint =
      r && !("_commandId" in r)
        ? "The result file has no _commandId: the installed panel predates docs/bridge-protocol.md. Reinstall and reopen it."
        : "Is the bridge panel open in AE with Auto-run ticked, and watching " + BRIDGE_DIR + "?";
    throw new Error(`Bridge panel did not answer getSandboxFolder. ${hint}\n${e.message}`);
  }
  assertSuccess(probe, "panel probe (getSandboxFolder)");

  // 2. Record the user's project, and refuse if it has unsaved changes.
  const orig = await runInAE(
    `return { path: __openPath(), numItems: app.project.numItems,
              dirty: (typeof app.project.dirty === "undefined") ? "unknown" : app.project.dirty };`,
    { label: "inspect open project" },
  );
  if (orig.dirty === true) {
    throw new Error(`Your open project has unsaved changes (${orig.path || "Untitled"}). Save it and run again.`);
  }
  if (!orig.path && orig.numItems > 0) {
    throw new Error("Your open project is Untitled but has items. Save it somewhere and run again.");
  }
  if (orig.dirty === "unknown") {
    console.log("[e2e] app.project.dirty is not available; relying on --i-saved-my-project.");
  }
  state.original = orig;
  console.log(`[e2e] Your project: ${orig.path || "(empty Untitled)"}. It will be reopened at the end.`);

  // 3. Close it (with AE's prompt as a last guard) and build the throwaway projects.
  const created = await runInAE(
    `var expected = ${lit(orig.path)};
     if (__openPath() !== expected) throw new Error("The open project changed since the check: " + __openPath());
     if (!app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)) throw new Error("Closing your project was cancelled; nothing changed.");
     app.newProject();
     var second = __saveAs(${lit(SECOND_AEP)});
     app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
     app.newProject();
     var e2e = __saveAs(${lit(E2E_AEP)});
     return { second: second, e2e: e2e };`,
    { label: "create throwaway projects", timeoutMs: 120000 },
  );
  state.e2eProject = created.e2e;
  state.secondProject = created.second;
  state.setupComplete = true;
  await ensureE2E();

  const gs = await getSandboxFolder();
  assertSuccess(gs, "getSandboxFolder after setup");
  assert.ok(samePath(gs.folder, SHOT), `setup: folder should be ${SHOT}, got ${fmt(gs)}`);
}

async function teardown() {
  if (state.tornDown) return;
  state.tornDown = true;
  try {
    await waitForIdle(30000);
    if (state.original) {
      const clears = [...state.settingKeysWritten]
        .map((k) => `app.settings.saveSetting(${lit(SANDBOX_SECTION)}, ${lit(k)}, "");`)
        .join("\n");
      const reopened = await runInAE(
        `${clears}
         var orig = ${lit(state.original.path)};
         if (orig) { if (__openPath() !== orig) __open(orig); }
         else if (__openPath() !== "" || app.project.numItems > 0) { __closeCurrent(); }
         return __openPath();`,
        { label: "restore your project", timeoutMs: 120000 },
      );
      console.log(`[e2e] Restored: ${reopened || "(empty Untitled)"}`);
    }
  } catch (e) {
    console.error(
      `[e2e] TEARDOWN FAILED: ${e.message}\n` +
        `      Reopen your project manually: ${state.original ? state.original.path || "(it was an empty Untitled)" : "(unchanged)"}`,
    );
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.error(`[e2e] Could not remove ${ROOT}: ${e.message}`);
  }
}

process.once("SIGINT", () => {
  console.error("\n[e2e] Interrupted; restoring your project...");
  teardown().finally(() => process.exit(130));
});

// ---------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------
const T = { timeout: 180_000 };

describe("bridge protocol end-to-end (seam 1)", { concurrency: 1 }, () => {
  before(async () => {
    try {
      await setup();
    } catch (e) {
      await teardown();
      throw e;
    }
  }, { timeout: 300_000 });

  after(teardown, { timeout: 300_000 });

  beforeEach(ensureE2E, { timeout: 120_000 });

  test("getSandboxFolder reports the open project and its folder", T, async () => {
    const r = await getSandboxFolder();
    assertSuccess(r, "getSandboxFolder");
    assert.ok(samePath(r.projectPath, state.e2eProject), `projectPath should be E2E.aep, got ${fmt(r)}`);
    assert.equal(r.projectName, "E2E.aep", `projectName, got ${fmt(r)}`);
    assert.ok(samePath(r.folder, SHOT), `folder should be ${SHOT}, got ${fmt(r)}`);
    assert.equal(r.folderExists, true, `folderExists, got ${fmt(r)}`);
    assert.equal(r.paused, false, `paused (untick Pause in the panel), got ${fmt(r)}`);
    assert.equal(r.scriptsEnabled, true, `scriptsEnabled, got ${fmt(r)}`);
    assert.ok(samePath(r._project, state.e2eProject), `_project field, got ${fmt(r)}`);
    assert.equal(r._commandExecuted, "getSandboxFolder", `_commandExecuted, got ${fmt(r)}`);
  });

  test("writes inside the folder succeed and writes outside are refused", T, async () => {
    const inside = path.join(SHOT, "inside.txt");
    let r = await runScript(
      `var f = new File(sandbox.path("inside.txt"));
       if (!f.open("w")) throw new Error("open failed");
       f.write("hello-inside"); f.close();
       return f.fsName;`,
      "write-inside",
    );
    assertSuccess(r, "write inside");
    assert.equal(fs.readFileSync(inside, "utf8"), "hello-inside", "inside.txt content");

    r = await runScript(`var d = new Folder(sandbox.path("made-dir")); return d.create();`, "mkdir-inside");
    assertSuccess(r, "Folder.create inside");
    assert.ok(fs.existsSync(path.join(SHOT, "made-dir")), "made-dir should exist inside the folder");

    const outsideNew = path.join(OUTSIDE, "outside-new.txt");
    r = await runScript(`var f = new File(${lit(outsideNew)}); f.open("w"); f.write("x"); f.close(); return "wrote";`, "write-outside");
    assertBlockedWrite(r, outsideNew, "File.open('w') outside");
    assertMissing(outsideNew, "write outside");

    const keep = path.join(OUTSIDE, "keep.txt");
    fs.writeFileSync(keep, "original");
    r = await runScript(`var f = new File(${lit(keep)}); f.open("a"); f.write("appended"); f.close(); return 1;`, "append-outside");
    assertBlockedWrite(r, keep, "File.open('a') outside");
    r = await runScript(`var f = new File(${lit(keep)}); f.open("e"); f.write("edited"); f.close(); return 1;`, "edit-outside");
    assertBlockedWrite(r, keep, "File.open('e') outside");
    r = await runScript(`return new File(${lit(keep)}).remove();`, "remove-outside");
    assertBlockedWrite(r, keep, "File.remove outside");
    r = await runScript(`return new File(${lit(keep)}).rename("renamed.txt");`, "rename-outside");
    assertBlockedWrite(r, keep, "File.rename outside");
    assert.equal(fs.readFileSync(keep, "utf8"), "original", "keep.txt must be untouched");
    assertMissing(path.join(OUTSIDE, "renamed.txt"), "rename outside");

    const copyTarget = path.join(OUTSIDE, "copied.txt");
    r = await runScript(`return new File(sandbox.path("inside.txt")).copy(${lit(copyTarget)});`, "copy-to-outside");
    assertBlockedWrite(r, copyTarget, "File.copy to outside");
    assertMissing(copyTarget, "copy to outside");

    const outsideDir = path.join(OUTSIDE, "made-dir");
    r = await runScript(`return new Folder(${lit(outsideDir)}).create();`, "mkdir-outside");
    assertBlockedWrite(r, outsideDir, "Folder.create outside");
    assertMissing(outsideDir, "Folder.create outside");

    // Reading from anywhere stays allowed.
    r = await runScript(`var f = new File(${lit(keep)}); f.open("r"); var s = f.read(); f.close(); return s;`, "read-outside");
    assertSuccess(r, "read outside");
    assert.equal(r.returnValue, "original", "reading outside the folder should work");
  });

  test("render output outside the folder is refused by sandbox.render", T, async () => {
    const out = path.join(OUTSIDE, "render-out.avi");
    const r = await runScript(
      `var comp = app.project.items.addComp("E2E Render", 16, 16, 1, 0.1, 10);
       var item = app.project.renderQueue.items.add(comp);
       item.outputModule(1).file = new File(${lit(out)});
       try { sandbox.render(); } finally { item.remove(); comp.remove(); }
       return "rendered";`,
      "render-outside",
      { timeoutMs: 60000 },
    );
    assert.equal(r.status, "error", `render to outside should be refused, got ${fmt(r)}`);
    assert.match(String(r.message), /outside|render-out/i, `message should explain the refused output, got ${fmt(r)}`);
    const leaked = fs.readdirSync(OUTSIDE).filter((f) => f.startsWith("render-out"));
    assert.deepEqual(leaked, [], "no render output may appear outside the folder");
  });

  test("saveProject: in place allowed, new path outside refused, new path inside allowed", T, async () => {
    let r = await sendCommand("saveProject", {});
    assertSuccess(r, "saveProject in place (no path)");
    assert.ok(samePath(r.savedTo, state.e2eProject), `savedTo should be E2E.aep, got ${fmt(r)}`);

    r = await sendCommand("saveProject", { path: state.e2eProject });
    assertSuccess(r, "saveProject with path = open project (in place)");

    const outsideAep = path.join(OUTSIDE, "E2E-outside.aep");
    r = await sendCommand("saveProject", { path: outsideAep });
    assert.equal(r.status, "error", `saveProject outside should be refused, got ${fmt(r)}`);
    assert.match(String(r.message), /outside/i, `message should say outside, got ${fmt(r)}`);
    assertMissing(outsideAep, "saveProject outside");
    assert.ok(samePath(r._project, state.e2eProject), `open project must still be E2E.aep, got ${fmt(r)}`);

    const copyAep = path.join(SHOT, "E2E-copy.aep");
    state.settingKeysWritten.add(sandboxKey(copyAep)); // the panel copies the folder setting to this key
    r = await sendCommand("saveProject", { path: copyAep });
    assertSuccess(r, "saveProject to a new path inside the folder");
    assert.ok(fs.existsSync(copyAep), "E2E-copy.aep should exist");
    assert.equal(r._projectChanged, true, `saving to a new path should set _projectChanged, got ${fmt(r)}`);
    await assertFolderCarriedOver(copyAep, "saveProject(path)");

    // An existing file without overwrite is refused.
    r = await sendCommand("saveProject", { path: path.join(SHOT, "E2E.aep") }, { expectedProject: copyAep });
    assertCode(r, "FILE_EXISTS", "saveProject onto an existing file without overwrite");
    // beforeEach reopens E2E.aep for the next test.
  });

  test("sandbox.saveAs outside the folder is refused; inside is allowed", T, async () => {
    const outsideAep = path.join(OUTSIDE, "saveas-outside.aep");
    let r = await runScript(`sandbox.saveAs(${lit(outsideAep)}); return app.project.file.fsName;`, "saveas-outside");
    assert.equal(r.status, "error", `sandbox.saveAs outside should fail, got ${fmt(r)}`);
    assertMissing(outsideAep, "sandbox.saveAs outside");
    const gs = await getSandboxFolder();
    assert.ok(samePath(gs.projectPath, state.e2eProject), `open project must still be E2E.aep, got ${fmt(gs)}`);

    // A name with spaces also checks that projectName is decoded (no %20).
    const insideAep = path.join(SHOT, "Save As Copy.aep");
    state.settingKeysWritten.add(sandboxKey(insideAep)); // the panel copies the folder setting to this key
    r = await runScript(`sandbox.saveAs(sandbox.path("Save As Copy.aep")); return app.project.file.fsName;`, "saveas-inside");
    assertSuccess(r, "sandbox.saveAs inside");
    assert.ok(fs.existsSync(insideAep), "Save As Copy.aep should exist");
    assert.equal(r._projectChanged, true, `saveAs inside should set _projectChanged, got ${fmt(r)}`);
    if (r.sandboxViolations !== undefined) assert.deepEqual(r.sandboxViolations, [], "no violations for a save inside");
    const after = await assertFolderCarriedOver(insideAep, "sandbox.saveAs");
    assert.equal(after.projectName, "Save As Copy.aep", `projectName should be decoded, got ${fmt(after)}`);
  });

  test("callSystem, app.project.save(path) and renderQueue.render() are refused with BLOCKED_CALL", T, async () => {
    const marker = path.join(OUTSIDE, "callsystem.txt");
    let r = await runScript(`return system.callSystem("cmd /c echo x> " + ${lit(marker)});`, "callsystem");
    assertCode(r, "BLOCKED_CALL", "system.callSystem");
    assertMissing(marker, "callSystem");

    const savePath = path.join(OUTSIDE, "blocked-save.aep");
    r = await runScript(`app.project.save(new File(${lit(savePath)})); return 1;`, "save-path");
    assertCode(r, "BLOCKED_CALL", "app.project.save(path)");
    assertMissing(savePath, "app.project.save(path)");

    r = await runScript(`app.project.renderQueue.render(); return 1;`, "rq-render");
    assertCode(r, "BLOCKED_CALL", "renderQueue.render()");

    // Code loaders, and anything reaching for the panel's own sandbox state.
    const evalTarget = path.join(OUTSIDE, "evil.jsx");
    fs.writeFileSync(evalTarget, 'app.project.items.addFolder("evalfile-ran");');
    const blocked = [
      ["$.evalFile", `$.evalFile(${lit(evalTarget)}); return 1;`],
      ["#include", `#include ${lit(evalTarget)}\nreturn 1;`],
      ["eval(", `return eval("1 + 1");`],
      ["saveSetting", `app.settings.saveSetting("x", "y", "z"); return 1;`],
      ["MCPBridgeSandbox", `return app.settings.haveSetting("MCPBridgeSandbox", "k");`],
      ["SANDBOX_SECTION", `return typeof SANDBOX_SECTION;`],
      ["MCPPathPolicy", `return typeof MCPPathPolicy;`],
      ["WriteGuards", `return typeof WriteGuards;`],
      ["pauseCheckbox", `return typeof pauseCheckbox;`],
    ];
    for (const [label, code] of blocked) {
      r = await runScript(code, `blocked-${label.replace(/[^a-z]/gi, "")}`);
      assertCode(r, "BLOCKED_CALL", `scan should block ${label}`);
    }
    const ran = await runInAE(`var c = 0; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "evalfile-ran") c++; return c;`);
    assert.equal(ran, 0, "the evalFile/#include target must not have run");

    // Not caught by the scan: the system stub must still refuse at run time.
    r = await runScript(`var s = system; return s["call" + "System"]("cmd /c echo x> " + ${lit(marker)});`, "callsystem-obfuscated");
    assert.equal(r.status, "error", `obfuscated callSystem must fail at run time, got ${fmt(r)}`);
    assertMissing(marker, "obfuscated callSystem");
  });

  test("scripts that clobber would-be panel globals don't break the bridge", T, async () => {
    // The panel's state lives in an IIFE; only __mcpBridgeCheck is global. Undeclared assignments create
    // new globals and must not reach the panel.
    let r = await runScript(
      `panel = 1; pad = 2; logText = null; statusText = null; autoRunCheckbox = null; lastProcessedId = "x";
       checkForCommands = null; executeCommand = null; getSandboxFolder = null; isChecking = true;
       return "clobbered";`,
      "clobber-globals",
    );
    assert.notEqual(r.status, "running", `clobbering script should finish, got ${fmt(r)}`);
    try {
      r = await getSandboxFolder({ timeoutMs: 15000 });
      assertSuccess(r, "getSandboxFolder after the clobbering script");
      assert.ok(samePath(r.folder, SHOT), `folder unchanged, got ${fmt(r)}`);
      r = await runScript(`return "still-works";`, "after-clobber", { timeoutMs: 15000 });
      assertSuccess(r, "runScript after the clobbering script");
      r = await sendCommand("getProjectInfo", {}, { timeoutMs: 15000 });
      assert.ok(samePath(r.path, state.e2eProject), `narrow command after clobbering, got ${fmt(r)}`);
    } finally {
      // Remove the junk globals so they don't linger in AE's engine.
      await runInAE(
        `var names = ["panel","pad","logText","statusText","autoRunCheckbox","lastProcessedId","checkForCommands","executeCommand","getSandboxFolder","isChecking"];
         for (var i = 0; i < names.length; i++) { try { delete $.global[names[i]]; } catch (e) {} }
         return true;`,
        { label: "remove junk globals" },
      ).catch((e) => console.warn(`[e2e] could not remove junk globals: ${e.message}`));
    }
  });

  test("a pending command older than 120 s is refused with STALE and not executed", T, async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const r = await runScript(`app.project.items.addFolder("stale-ran"); return 1;`, "stale", { timestamp: old });
    assertCode(r, "STALE", "command with a 10-minute-old timestamp");
    const ran = await runInAE(`var c = 0; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "stale-ran") c++; return c;`);
    assert.equal(ran, 0, "the stale command must not run");
    await waitUntil(() => {
      const c = readJson(COMMAND_FILE);
      return c && c.id === r._sentId && c.status === "error";
    }, 5000, "the stale command to be marked error");

    // A fresh command right after is accepted.
    const ok = await runScript(`return "fresh";`, "after-stale");
    assertSuccess(ok, "fresh command after a stale one");
  });

  test("each script run makes a rolling backup of the .aep; only the newest 10 are kept", T, async () => {
    const backups = path.join(SHOT, "mcp-scripts", "backups");
    const listE2E = () => (fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => /_E2E\.aep$/i.test(f)) : []);
    let r = await runScript(`return 1;`, "backup-1");
    assertSuccess(r, "backup-1");
    assert.equal(r.backupWarning, undefined, `no backupWarning expected, got ${fmt(r)}`);
    assert.ok(r.backupPath, `result should carry backupPath, got ${fmt(r)}`);
    assert.ok(fs.existsSync(r.backupPath), `backupPath should exist: ${r.backupPath}`);
    assert.ok(samePath(path.dirname(r.backupPath), backups), `backup should be in ${backups}, got ${r.backupPath}`);
    assert.match(path.basename(r.backupPath), /_E2E\.aep$/i, `backup name <stamp>_<base>.aep, got ${r.backupPath}`);

    const paths = new Set([normalize(r.backupPath)]);
    for (let i = 2; i <= 12; i++) {
      r = await runScript(`return ${i};`, `backup-${i}`);
      assertSuccess(r, `backup-${i}`);
      assert.ok(r.backupPath, `backup-${i} should carry backupPath, got ${fmt(r)}`);
      paths.add(normalize(r.backupPath));
    }
    assert.ok(paths.size >= 12, `each run should get its own backup file, got ${paths.size} distinct paths`);
    const left = listE2E();
    assert.equal(left.length, 10, `only the newest 10 backups should remain, found ${left.length}: ${fmt(left)}`);
    assert.ok(fs.existsSync(r.backupPath), "the newest backup must be kept");
  });

  test("a command without expectedProject is refused with PROJECT_NOT_CONFIRMED", T, async () => {
    let r = await runScript(`app.project.items.addFolder("should-not-exist"); return 1;`, "no-expected", { omitExpected: true });
    assertGateRefusal(r, "PROJECT_NOT_CONFIRMED", "runScript without expectedProject");
    r = await sendCommand("saveProject", {}, { omitExpected: true });
    assertGateRefusal(r, "PROJECT_NOT_CONFIRMED", "saveProject without expectedProject");

    // The read-only commands are exempt.
    r = await getSandboxFolder({ omitExpected: true });
    assertSuccess(r, "getSandboxFolder without expectedProject (exempt)");
    r = await sendCommand("getProjectInfo", {}, { omitExpected: true });
    assert.ok(samePath(r.path, state.e2eProject), `getProjectInfo without expectedProject (exempt), got ${fmt(r)}`);
    const n = await runInAE(`var c = 0; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "should-not-exist") c++; return c;`);
    assert.equal(n, 0, "the refused script must not have run");
  });

  test("a wrong expectedProject is refused with PROJECT_MISMATCH naming both projects", T, async () => {
    const other = path.join(ROOT, "elsewhere", "Other.aep");
    let r = await runScript(`return 1;`, "mismatch", { expectedProject: other });
    assertGateRefusal(r, "PROJECT_MISMATCH", "expectedProject = another path");
    assert.ok(samePath(r.expectedProject, other), `refusal.expectedProject, got ${fmt(r)}`);
    assert.ok(samePath(r.openProject, state.e2eProject), `refusal.openProject, got ${fmt(r)}`);

    r = await runScript(`return 1;`, "mismatch-untitled", { expectedProject: "" });
    assertGateRefusal(r, "PROJECT_MISMATCH", 'expectedProject = "" (untitled) while E2E.aep is open');

    // Same project, different spelling (case, separators): normalize() must treat it as a match.
    const respelled = state.e2eProject.toUpperCase().replace(/\\/g, "/");
    r = await runScript(`return "matched";`, "respelled", { expectedProject: respelled });
    assertSuccess(r, "expectedProject differing only in case/separators");

    // Switch shots: Second.aep is open, Claude still expects E2E.aep.
    await runInAE(`return __open(${lit(state.secondProject)});`, { label: "open Second.aep" });
    r = await runScript(`app.project.items.addFolder("wrong-shot"); return 1;`, "wrong-shot");
    assertGateRefusal(r, "PROJECT_MISMATCH", "Second.aep open, E2E.aep expected");
    assert.ok(samePath(r.openProject, state.secondProject), `refusal.openProject should be Second.aep, got ${fmt(r)}`);
    assert.ok(samePath(r.expectedProject, state.e2eProject), `refusal.expectedProject should be E2E.aep, got ${fmt(r)}`);
    assert.match(String(r.message), /Second\.aep/, `message should name the open project, got ${fmt(r)}`);
    const n = await runInAE(`return app.project.numItems;`);
    assert.equal(n, 0, "nothing may be added to Second.aep");
  });

  test("an unset folder refuses scripts with NO_FOLDER; a missing folder with FOLDER_MISSING", T, async () => {
    await setSandboxSetting(state.e2eProject, "");
    let gs = await getSandboxFolder();
    assert.equal(gs.folder, null, `folder should be null when unset, got ${fmt(gs)}`);
    assert.equal(gs.scriptsEnabled, false, `scriptsEnabled should be false, got ${fmt(gs)}`);

    let r = await runScript(`return 1;`, "no-folder");
    assertCode(r, "NO_FOLDER", "runScript with no folder");
    fs.mkdirSync(path.join(SHOT, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(SHOT, "scripts", "nf.jsx"), "return 1;");
    r = await runScriptFile(path.join(SHOT, "scripts", "nf.jsx"));
    assertCode(r, "NO_FOLDER", "runScriptFile with no folder");

    // Saving in place is always allowed; a save to a new path is not.
    r = await sendCommand("saveProject", {});
    assertSuccess(r, "saveProject in place with no folder");
    const newPath = path.join(SHOT, "nofolder-copy.aep");
    r = await sendCommand("saveProject", { path: newPath });
    assert.equal(r.status, "error", `saveProject to a new path with no folder, got ${fmt(r)}`);
    assertMissing(newPath, "saveProject with no folder");

    const missing = path.join(ROOT, "missing-folder");
    await setSandboxSetting(state.e2eProject, missing);
    gs = await getSandboxFolder();
    assert.equal(gs.folderExists, false, `folderExists should be false, got ${fmt(gs)}`);
    assert.equal(gs.scriptsEnabled, false, `scriptsEnabled should be false, got ${fmt(gs)}`);
    r = await runScript(`return 1;`, "folder-missing");
    assertCode(r, "FOLDER_MISSING", "runScript with a folder that doesn't exist");
    assertMissing(missing, "the missing folder must not be created");
  });

  test("the folder is restored when E2E.aep is reopened, and unset for a new project", T, async () => {
    let gs = await getSandboxFolder();
    assert.ok(samePath(gs.folder, SHOT), `before: folder should be ${SHOT}, got ${fmt(gs)}`);

    // Close E2E.aep and start a new Untitled project.
    await runInAE(`__closeCurrent(); app.newProject(); return __openPath();`, { label: "new Untitled project" });
    gs = await getSandboxFolder({ expectedProject: "" });
    assert.equal(gs.projectPath, "", `untitled: projectPath should be "", got ${fmt(gs)}`);
    assert.equal(gs.folder, null, `untitled: folder should be null, got ${fmt(gs)}`);
    assert.equal(gs.scriptsEnabled, false, `untitled: scriptsEnabled, got ${fmt(gs)}`);
    let r = await runScript(`return 1;`, "untitled", { expectedProject: "" });
    assertCode(r, "NO_FOLDER", "runScript in an Untitled project");

    // Save it: a never-configured project still has no folder.
    const fresh = await runInAE(`return __saveAs(${lit(FRESH_AEP)});`, { label: "save Fresh.aep" });
    gs = await getSandboxFolder({ expectedProject: fresh });
    assert.ok(samePath(gs.projectPath, fresh), `fresh: projectPath, got ${fmt(gs)}`);
    assert.equal(gs.folder, null, `fresh: folder should be null (never configured), got ${fmt(gs)}`);
    r = await runScript(`return 1;`, "fresh", { expectedProject: fresh });
    assertCode(r, "NO_FOLDER", "runScript in a never-configured project");

    // Reopen E2E.aep (without rewriting the setting): its folder comes back.
    await runInAE(`return __open(${lit(state.e2eProject)});`, { label: "reopen E2E.aep" });
    gs = await getSandboxFolder();
    assert.ok(samePath(gs.folder, SHOT), `reopened: folder should be restored to ${SHOT}, got ${fmt(gs)}`);
    assert.equal(gs.scriptsEnabled, true, `reopened: scriptsEnabled, got ${fmt(gs)}`);
    r = await runScript(`return "back";`, "reopened");
    assertSuccess(r, "runScript after reopening E2E.aep");
  });

  test("one undo reverses everything a run did", T, async () => {
    const itemsBefore = await runInAE(`return app.project.numItems;`, { label: "count items" });
    const r = await runScript(
      `var a = app.project.items.addComp("Undo A", 64, 64, 1, 1, 24);
       a.layers.addSolid([1, 0, 0], "Undo Solid", 64, 64, 1);
       app.project.items.addComp("Undo B", 64, 64, 1, 1, 24);
       app.project.items.addFolder("Undo Folder");
       return app.project.numItems;`,
      "undo-probe",
    );
    assertSuccess(r, "undo-probe run");
    assert.ok(r.returnValue >= itemsBefore + 3, `run should add items (before ${itemsBefore}), got ${fmt(r)}`);
    const undone = await runInAE(
      `var id = app.findMenuCommandId("Undo MCP: undo-probe");
       app.executeCommand(id || 16);
       return { numItems: app.project.numItems, usedId: id || 16 };`,
      { label: "Edit > Undo" },
    );
    assert.equal(undone.numItems, itemsBefore, `one undo (command ${undone.usedId}) should restore ${itemsBefore} items, got ${undone.numItems}`);
  });

  test("each run is archived as a .jsx and logged in mcp-scripts", T, async () => {
    const scriptsDir = path.join(SHOT, "mcp-scripts");
    const code = `// e2e archive marker ${STAMP}\nreturn "logged";`;
    let r = await runScript(code, "log-probe");
    assertSuccess(r, "log-probe");
    const archived = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir).filter((f) => /_log-probe\.jsx$/.test(f)) : [];
    assert.equal(archived.length, 1, `exactly one archive for log-probe in ${scriptsDir}, got ${fmt(archived)}`);
    assert.match(archived[0], /^\d{8}-\d{6}-\d{3}_log-probe\.jsx$/, "archive name format <yyyymmdd-hhmmss-mmm>_<name>.jsx");
    assert.ok(fs.readFileSync(path.join(scriptsDir, archived[0]), "utf8").includes(`e2e archive marker ${STAMP}`), "archive holds the code");
    if (r.archivedAs) assert.equal(path.basename(r.archivedAs), archived[0], `archivedAs, got ${fmt(r)}`);

    let line = runLogLines().filter((l) => l.split("\t")[1] === "log-probe").pop();
    assert.ok(line, `run-log.txt should have a log-probe line: ${fmt(runLogLines().slice(-5))}`);
    let [iso, name, outcome, ms] = line.split("\t");
    assert.ok(!Number.isNaN(Date.parse(iso)), `log time should be ISO, got ${iso}`);
    assert.equal(name, "log-probe");
    assert.equal(outcome, "success", `log outcome, line: ${line}`);
    assert.ok(Number(ms) >= 0, `log duration, line: ${line}`);

    r = await runScript(`throw new Error("log-probe-failure");`, "log-probe-err");
    assert.equal(r.status, "error", `log-probe-err should fail, got ${fmt(r)}`);
    line = runLogLines().filter((l) => l.split("\t")[1] === "log-probe-err").pop();
    assert.ok(line, "run-log.txt should have a log-probe-err line");
    [, , outcome] = line.split("\t");
    assert.equal(outcome, "error", `log outcome for a failing run, line: ${line}`);
    assert.match(line, /log-probe-failure/, "log line should carry the error message");
  });

  test("a long script yields a 'running' result before the final result", T, async () => {
    const r = await runScript(
      `var t0 = new Date().getTime(); while (new Date().getTime() - t0 < 3000) {} return "slow-done";`,
      "slow-3s",
      { timeoutMs: 60000 },
    );
    assert.ok(r._statusesSeen.includes("running"), `should observe status "running" first, saw ${fmt(r._statusesSeen)}`);
    assert.equal(r._statusesSeen[0], "running", `first state should be "running", saw ${fmt(r._statusesSeen)}`);
    assertSuccess(r, "slow script final result");
    assert.equal(r.returnValue, "slow-done");
    assert.ok(r.durationMs >= 2500, `durationMs should reflect the 3 s run, got ${r.durationMs}`);
  });

  test("a script error returns its message and the line relative to the script", T, async () => {
    let r = await runScript(["var a = 1;", "var b = a + 1;", 'throw new Error("boom-e2e");', "return b;"].join("\n"), "throw-line3");
    assert.equal(r.status, "error", `throw should fail, got ${fmt(r)}`);
    assert.equal(r.code, "SCRIPT_ERROR", `code, got ${fmt(r)}`);
    assert.match(String(r.message), /boom-e2e/, `message, got ${fmt(r)}`);
    assert.equal(r.line, 3, `line should be 3, got ${fmt(r)}`);

    r = await runScript(["var x = 1;", "var y = 2;", "var z = 3;", "notAFunction_e2e();", "return z;"].join("\n"), "ref-line4");
    assert.equal(r.status, "error", `runtime error should fail, got ${fmt(r)}`);
    assert.equal(r.code, "SCRIPT_ERROR", `code, got ${fmt(r)}`);
    assert.match(String(r.message), /notAFunction_e2e/, `message, got ${fmt(r)}`);
    assert.equal(r.line, 4, `line should be 4, got ${fmt(r)}`);

    r = await runScript(["var ok = 1;", "var = ;"].join("\n"), "syntax-error");
    assert.equal(r.status, "error", `syntax error should fail, got ${fmt(r)}`);
    assert.equal(r.code, "SYNTAX_ERROR", `code, got ${fmt(r)}`);
    assert.ok(r.message, `syntax error needs a message, got ${fmt(r)}`);
    if (r.line !== null && r.line !== undefined) assert.equal(r.line, 2, `syntax error line, got ${fmt(r)}`);
  });

  test("returnValue round-trips objects and arrays", T, async () => {
    const expected = {
      n: 42,
      f: 1.5,
      neg: -7,
      s: 'quote " backslash \\ tab \t newline \n',
      unicode: "caf\u00e9 \u2192",
      t: true,
      nul: null,
      arr: [1, "two", null, false, [3, [4]]],
      nested: { deep: [{ k: 1 }, { k: "v" }], empty: {}, emptyArr: [] },
    };
    let r = await runScript(`return ${JSON.stringify(expected)};`, "return-object");
    assertSuccess(r, "return object");
    assert.deepEqual(r.returnValue, expected, "object round-trip");

    r = await runScript(`return [1, [2, [3]], { a: [] }, "x"];`, "return-array");
    assertSuccess(r, "return array");
    assert.deepEqual(r.returnValue, [1, [2, [3]], { a: [] }, "x"], "array round-trip");

    r = await runScript(`return app.project;`, "return-host");
    assertSuccess(r, "return host object");
    assert.equal(typeof r.returnValue, "string", `host objects become strings, got ${fmt(r.returnValue)}`);

    r = await runScript(`var o = {}; var c = o; for (var i = 0; i < 20; i++) { c.d = {}; c = c.d; } return o;`, "return-deep");
    assertSuccess(r, "deeply nested value is cut at the depth limit, not an error");
  });

  test("runScriptFile runs files inside the folder and refuses files outside", T, async () => {
    const dir = path.join(SHOT, "scripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hello.jsx"), 'return { from: "file", n: 7 };');
    let r = await runScriptFile("scripts\\hello.jsx");
    assertSuccess(r, "runScriptFile relative path");
    assert.deepEqual(r.returnValue, { from: "file", n: 7 });
    r = await runScriptFile(path.join(dir, "hello.jsx"));
    assertSuccess(r, "runScriptFile absolute path inside");

    fs.writeFileSync(path.join(OUTSIDE, "x.jsx"), 'app.project.items.addFolder("outside-ran"); return "ran";');
    r = await runScriptFile("..\\outside\\x.jsx");
    assertCode(r, "OUTSIDE_FOLDER", "runScriptFile ..\\outside\\x.jsx");
    r = await runScriptFile(path.join(OUTSIDE, "x.jsx"));
    assertCode(r, "OUTSIDE_FOLDER", "runScriptFile absolute path outside");
    const ran = await runInAE(`var c = 0; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "outside-ran") c++; return c;`);
    assert.equal(ran, 0, "the outside file must not have run");

    fs.writeFileSync(path.join(dir, "blocked.jsx"), 'return system.callSystem("cmd /c echo hi");');
    r = await runScriptFile("scripts\\blocked.jsx");
    assertCode(r, "BLOCKED_CALL", "runScriptFile whose contents call callSystem");

    r = await runScriptFile("scripts\\does-not-exist.jsx");
    assertCode(r, "FILE_NOT_FOUND", "runScriptFile with a missing file inside the folder");
  });

  test("stress: 20 rapid sequential commands each get exactly one matching result", T, async () => {
    const N = 20;
    const scripted = [];
    for (let i = 1; i <= N; i++) {
      let r;
      if (i % 4 === 0) {
        r = await sendCommand("getProjectInfo", {}, { timeoutMs: 15000 });
        assert.ok(samePath(r.path, state.e2eProject), `#${i} getProjectInfo, got ${fmt(r)}`);
      } else {
        r = await runScript(`app.project.items.addFolder("stress-${i}"); return ${i};`, `stress-${i}`, { timeoutMs: 15000 });
        assertSuccess(r, `#${i} runScript`);
        assert.equal(r.returnValue, i, `#${i} returnValue`);
        scripted.push(i);
      }
      assert.equal(r._commandId, r._sentId, `#${i} result must carry its own _commandId`);
      // The command must not stay pending (the old missing-result bug left it hanging).
      await waitUntil(() => {
        const c = readJson(COMMAND_FILE);
        return c && c.id === r._sentId && (c.status === "completed" || c.status === "error");
      }, 5000, `#${i} command file to be marked completed`);
    }
    // Each run executed exactly once: one folder per scripted command.
    const counts = await runInAE(
      `var m = {}; for (var i = 1; i <= app.project.numItems; i++) { var n = app.project.item(i).name; if (/^stress-\\d+$/.test(n)) m[n] = (m[n] || 0) + 1; } return m;`,
    );
    const expectedCounts = Object.fromEntries(scripted.map((i) => [`stress-${i}`, 1]));
    assert.deepEqual(counts, expectedCounts, "each stress script must run exactly once");
    const logged = runLogLines().map((l) => l.split("\t")[1]).filter((n) => /^stress-\d+$/.test(n));
    assert.deepEqual(logged.sort(), Object.keys(expectedCounts).sort(), "run-log has exactly one line per stress script");
  });

  test("race: a command written while another script is running still runs afterwards", T, async () => {
    const idA = writeCommand("runScript", {
      name: "race-A",
      code: `var t0 = new Date().getTime(); while (new Date().getTime() - t0 < 2000) {} app.project.items.addFolder("race-A"); return "A";`,
    });
    await waitUntil(() => {
      const r = readJson(RESULT_FILE);
      const c = readJson(COMMAND_FILE);
      return (r && r._commandId === idA && r.status === "running") || (c && c.id === idA && c.status === "running");
    }, 15000, "script A to start running");

    // Overwrite the command file while A runs (expected: the panel is busy, B waits its turn).
    const idB = writeCommand("runScript", { name: "race-B", code: `app.project.items.addFolder("race-B"); return "B";` });
    const { result: rB } = await waitForResult(idB, { timeoutMs: 30000 });
    assertSuccess(rB, "command B (written while A ran) must run, not be marked completed unexecuted");
    assert.equal(rB.returnValue, "B");
    await waitUntil(() => {
      const c = readJson(COMMAND_FILE);
      return c && c.id === idB && c.status === "completed";
    }, 5000, "command file to show B completed");

    const counts = await runInAE(
      `var m = { "race-A": 0, "race-B": 0 }; for (var i = 1; i <= app.project.numItems; i++) { var n = app.project.item(i).name; if (m.hasOwnProperty(n)) m[n]++; } return m;`,
    );
    assert.deepEqual(counts, { "race-A": 1, "race-B": 1 }, "A and B each ran exactly once");
  });

  test("Pause refuses commands and keeps the folder (interactive)", { skip: !INTERACTIVE && "pass --interactive to run" }, async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let paused = false;
    try {
      await rl.question("\n>>> Tick 'Pause Claude' in the AE bridge panel, then press Enter... ");
      paused = true;
      let gs = await getSandboxFolder();
      assertSuccess(gs, "getSandboxFolder while paused (exempt)");
      assert.equal(gs.paused, true, `paused should be true (did you tick it?), got ${fmt(gs)}`);
      assert.equal(gs.scriptsEnabled, false, `scriptsEnabled should be false while paused, got ${fmt(gs)}`);
      assert.ok(samePath(gs.folder, SHOT), `Pause must not clear the folder, got ${fmt(gs)}`);

      let r = await runScript(`return 1;`, "paused");
      assertGateRefusal(r, "PAUSED", "runScript while paused");
      r = await sendCommand("saveProject", {});
      assertGateRefusal(r, "PAUSED", "saveProject while paused");
      r = await runScript(`return 1;`, "paused-no-expected", { omitExpected: true });
      assertGateRefusal(r, "PAUSED", "Pause is checked before expectedProject");

      await rl.question(">>> Now untick 'Pause Claude', then press Enter... ");
      paused = false;
      gs = await getSandboxFolder();
      assert.equal(gs.paused, false, `paused should be false (did you untick it?), got ${fmt(gs)}`);
      r = await runScript(`return "unpaused";`, "unpaused");
      assertSuccess(r, "runScript after unpausing");
    } finally {
      if (paused) await rl.question(">>> Make sure 'Pause Claude' is unticked, then press Enter... ");
      rl.close();
    }
  });
});
