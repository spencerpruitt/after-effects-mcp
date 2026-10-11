// Dry run of the Premiere end-to-end harness (test/e2e/premiere.e2e.mjs) against an in-process fake panel:
// the real panel core and typed commands over the fake premierepro model (premiere-e2e-fakepanel.mjs), polling
// a temp bridge dir set through AE_MCP_BRIDGE_DIR. It proves the harness logic, its teardown, and that it never
// targets anything outside its temp root. Nothing here touches Premiere or %USERPROFILE%\ae-mcp-bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startFakePanel } from "./premiere-e2e-fakepanel.mjs";
import { runSuite, CASES, checkCommandTarget, REFUSAL_TEXT } from "./e2e/premiere.e2e.mjs";

const require = createRequire(import.meta.url);
const { normalize, isInside } = require("../src/premiere-uxp/lib/pathPolicy.js");
const { FOLDER_PREFIX, ROOTS_KEY } = require("../src/premiere-uxp/core/settings.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "e2e", "premiere.e2e.mjs");
// The panel checks __e2e_* paths against %TEMP%\pr-mcp-e2e-*; harness and fake panel use the same base.
const TEMP_BASE = process.env.TEMP || process.env.TMP || os.tmpdir();
const DRY_TIMING = { slowMs: 600, raceMs: 500, caseTimeoutMs: 60000, commandTimeoutMs: 20000, probeTimeoutMs: 5000, pollMs: 10 };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pr-e2e-dryrun-"));
process.on("exit", () => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
});

let runSeq = 0;
// A fresh bridge dir (via AE_MCP_BRIDGE_DIR, as the live run resolves it) and a fake panel watching it.
function freshPanel(extra = {}) {
  const n = ++runSeq;
  const bridgeDir = path.join(scratch, `bridge-${n}`);
  fs.mkdirSync(bridgeDir, { recursive: true });
  process.env.AE_MCP_BRIDGE_DIR = bridgeDir;
  const userProjectPath = path.join(scratch, "user", "Mine.prproj");
  const panel = startFakePanel({ bridgeDir, tempDir: TEMP_BASE, userProjectPath, ...extra });
  return { panel, bridgeDir, userProjectPath, stamp: `dryrun-${process.pid}-${n}` };
}

function dryPrompt(panel) {
  return async ({ key, sequence }) => {
    if (key === "pause-on") panel.bridge.setPaused(true);
    else if (key.startsWith("pause-")) panel.bridge.setPaused(false);
    else if (key === "undo") panel.undoMarker(sequence, "UndoProbe");
  };
}

// Independent of the harness's own guard: every command names a throwaway project under the temp root, or is
// exempt (getState, createProject, openProject, __e2e_*) with its path arguments under the root, or is a gate
// probe without a target that the panel refused.
const EXEMPT = (c) => ["getState", "createProject", "openProject"].includes(c) || c.startsWith("__e2e_");
function assertNeverOutsideRoot(r) {
  assert.ok(r.sent.length > 0, "the harness sent commands");
  for (const { cmd, result } of r.sent) {
    const where = `${cmd.command} ${JSON.stringify(cmd.args).slice(0, 200)}`;
    assert.equal(checkCommandTarget(cmd, r.root), null, where);
    const ep = cmd.expectedProject;
    for (const k of ["path", "projectPath", "root", "folder", "output", "newFile", "file"]) {
      const v = cmd.args && cmd.args[k];
      if (typeof v === "string" && normalize(v) !== null) assert.ok(isInside(v, r.root), `${where}: args.${k} outside the temp root`);
    }
    for (const f of (cmd.args && cmd.args.files) || []) if (normalize(f) !== null) assert.ok(isInside(f, r.root), `${where}: files outside the temp root`);
    if (typeof ep === "string" && ep !== "") {
      assert.ok(isInside(ep, r.root), `${where}: expectedProject ${ep} is outside ${r.root}`);
    } else if (!EXEMPT(cmd.command)) {
      assert.ok(result && result.refused && ["PROJECT_NOT_CONFIRMED", "PROJECT_UNSAVED", "PAUSED"].includes(result.code),
        `${where}: a command without a target must be a refused gate probe, got ${JSON.stringify(result)}`);
    }
  }
}

function assertCleanTeardown(panel, r, userProjectPath) {
  assert.deepEqual(r.teardownProblems, [], "teardown reported no problems");
  assert.ok(!fs.existsSync(r.root), `the temp root ${r.root} is deleted`);
  const root = normalize(r.root);
  for (let i = 0; i < panel.storage.length; i++) {
    const k = panel.storage.key(i);
    if (k.startsWith(FOLDER_PREFIX)) assert.ok(!k.startsWith(FOLDER_PREFIX + root), `folder setting left behind: ${k}`);
  }
  const roots = String(panel.storage.getItem(ROOTS_KEY) || "").split("\n").filter(Boolean);
  assert.ok(!roots.some((x) => normalize(x) === root), `the temp root is still a default root: ${roots}`);
  const leftOpen = panel.openProjects().map((p) => p.path).filter((p) => isInside(p, r.root));
  assert.deepEqual(leftOpen, [], "no throwaway project is left open");
  assert.ok(panel.isOpen(userProjectPath), "your project is still open");
  assert.equal(panel.user.saveCount, 0, "your project was never saved");
  assert.equal(panel.user.transactions.length, 0, "your project was never edited");
}

test("dry run: the whole case list passes against the fake panel, then tears down", { timeout: 240000 }, async (t) => {
  const { panel, bridgeDir, userProjectPath, stamp } = freshPanel();
  const lines = [];
  try {
    const r = await runSuite({
      tempBase: TEMP_BASE, stamp, media: "fake", interactive: true, prompt: dryPrompt(panel),
      timing: DRY_TIMING, log: (s) => lines.push(s),
    });
    t.diagnostic(lines.join("\n"));
    const bad = r.results.filter((x) => x.outcome === "FAIL" || x.outcome === "SOFT");
    assert.deepEqual(bad, [], "every case passes against the fake (SOFT here means the fake or the harness is wrong)");
    assert.equal(r.exitCode, 0);
    const ids = r.results.map((x) => x.id);
    for (const c of CASES) assert.ok(ids.includes(c.id), `case ${c.id} reported`);
    assert.ok(ids.includes("END"), "the final 'your projects' check ran");
    const skipped = r.results.filter((x) => x.outcome === "SKIP").map((x) => x.id).sort();
    const expectSkipped = CASES.filter((c) => (c.needs || []).some((n) => n === "sidecar" || n === "exportPreset")).map((c) => c.id).sort();
    assert.deepEqual(skipped, expectSkipped, "only the sidecar and export-preset cases skip");
    assert.ok(r.results.find((x) => x.id === "P27").outcome === "PASS", "the Pause case ran (simulated prompts)");
    assertNeverOutsideRoot(r);
    assertCleanTeardown(panel, r, userProjectPath);
    assert.equal(r.bridgeDir, bridgeDir, "the harness used the temp bridge dir from AE_MCP_BRIDGE_DIR");
    assert.notEqual(normalize(r.bridgeDir), normalize(path.join(os.homedir(), "ae-mcp-bridge")), "never the real bridge dir");
  } finally {
    panel.stop();
  }
});

test("dry run: without media, the media cases skip with a reason and teardown is clean", { timeout: 60000 }, async (t) => {
  const { panel, userProjectPath, stamp } = freshPanel();
  const lines = [];
  try {
    const mediaCases = CASES.filter((c) => (c.needs || []).includes("media")).map((c) => c.id);
    const r = await runSuite({ tempBase: TEMP_BASE, stamp, media: "none", only: ["P01", ...mediaCases], timing: DRY_TIMING, log: (s) => lines.push(s) });
    t.diagnostic(lines.join("\n"));
    assert.equal(r.exitCode, 0);
    assert.equal(r.results.find((x) => x.id === "P01").outcome, "PASS");
    for (const id of mediaCases) {
      const rec = r.results.find((x) => x.id === id);
      assert.equal(rec.outcome, "SKIP", id);
      assert.ok(rec.detail.length > 0, `${id} says why it skipped`);
    }
    assert.ok(lines.some((l) => /No test media/.test(l)), "the run says media is missing");
    assertNeverOutsideRoot(r);
    assertCleanTeardown(panel, r, userProjectPath);
  } finally {
    panel.stop();
  }
});

test("dry run: a hard failure still tears everything down and exits 1", { timeout: 60000 }, async (t) => {
  const { panel, userProjectPath, stamp } = freshPanel({ failCommands: ["getProjectItems"] });
  const lines = [];
  try {
    const r = await runSuite({ tempBase: TEMP_BASE, stamp, media: "fake", only: ["P01", "P02", "P03"], timing: DRY_TIMING, log: (s) => lines.push(s) });
    t.diagnostic(lines.join("\n"));
    assert.equal(r.results.find((x) => x.id === "P02").outcome, "FAIL", "the injected failure fails P02");
    assert.equal(r.results.find((x) => x.id === "P03").outcome, "PASS", "later cases still run");
    assert.equal(r.exitCode, 1);
    assert.ok(lines.some((l) => /^FAIL {2}P02/.test(l)), "a FAIL line is printed");
    assertNeverOutsideRoot(r);
    assertCleanTeardown(panel, r, userProjectPath);
  } finally {
    panel.stop();
  }
});

test("dry run: refuses (exit 2) when 'Allow test harness' is unticked, before creating anything", { timeout: 30000 }, async () => {
  const { panel, stamp } = freshPanel({ harness: false });
  const lines = [];
  try {
    const r = await runSuite({ tempBase: TEMP_BASE, stamp, media: "fake", timing: DRY_TIMING, log: (s) => lines.push(s) });
    assert.equal(r.exitCode, 2);
    assert.match(r.refusedReason, /Allow test harness/);
    assert.deepEqual(r.sent.map((s) => s.cmd.command), ["getState"], "only the probe was sent");
    assert.ok(!fs.existsSync(r.root), "no temp root was created");
  } finally {
    panel.stop();
  }
});

test("dry run: refuses (exit 2) when Pause is ticked", { timeout: 30000 }, async () => {
  const { panel, stamp } = freshPanel();
  panel.bridge.setPaused(true);
  try {
    const r = await runSuite({ tempBase: TEMP_BASE, stamp, media: "fake", timing: DRY_TIMING, log: () => {} });
    assert.equal(r.exitCode, 2);
    assert.match(r.refusedReason, /Pause/);
  } finally {
    panel.stop();
  }
});

test("the CLI refuses without --i-saved-my-project (exit 2) and writes no command", () => {
  const bridgeDir = path.join(scratch, "cli-bridge");
  fs.mkdirSync(bridgeDir, { recursive: true });
  const r = spawnSync(process.execPath, [HARNESS], { env: { ...process.env, AE_MCP_BRIDGE_DIR: bridgeDir }, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes("--i-saved-my-project"), r.stderr);
  assert.ok(REFUSAL_TEXT.includes("Allow test harness"));
  assert.deepEqual(fs.readdirSync(bridgeDir), [], "nothing was written to the bridge dir");
});

test("the harness guard refuses commands that target anything outside the temp root", () => {
  const root = path.join(TEMP_BASE, "pr-mcp-e2e-guardtest");
  const inside = path.join(root, "edit", "E2E.prproj");
  const mine = path.join(scratch, "user", "Mine.prproj");
  assert.equal(checkCommandTarget({ command: "runScript", args: {}, expectedProject: inside }, root), null);
  assert.equal(checkCommandTarget({ command: "runScript", args: {}, expectedProject: "\\\\?\\" + inside.toUpperCase() }, root), null);
  assert.equal(checkCommandTarget({ command: "runScript", args: {} }, root), null, "a gate probe without a target");
  assert.match(checkCommandTarget({ command: "runScript", args: {}, expectedProject: mine }, root), /outside/);
  assert.match(checkCommandTarget({ command: "createProject", args: { path: mine } }, root), /outside/);
  assert.match(checkCommandTarget({ command: "__e2e_closeProject", args: { path: mine } }, root), /outside/);
  assert.match(checkCommandTarget({ command: "importFiles", args: { files: [mine] }, expectedProject: inside }, root), /outside/);
  assert.match(checkCommandTarget({ command: "runScript", args: {}, expectedProject: path.join(root, "..", "x", "X.prproj") }, root), /outside/);
  assert.equal(checkCommandTarget({ command: "runScriptFile", args: { file: "..\\outside\\x.js" }, expectedProject: inside }, root), null, "relative files resolve in the folder");
});
