// Unit tests for the shared bridge module (src/bridge), run against build/ (npm test builds first).
// A fake panel polls the command file in a temp bridge dir and writes results like the real panels.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BridgeClient, ProjectState, toAsciiJson, formatBridgeResult, resultMatchesCommand, waitSecondsToMs } from "../build/bridge/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PR = {
  prefix: "pr",
  appLabel: "Premiere Pro",
  panelLabel: "MCP Bridge",
  resultsToolName: "premiere-get-results",
  runningHint: "a Premiere dialog may be waiting."
};
const AE = {
  prefix: "ae",
  appLabel: "After Effects",
  panelLabel: "MCP Bridge Auto",
  resultsToolName: "get-results",
  confirmFromResult: (p) => (p._commandExecuted === "getSandboxFolder" && p.status === "success" ? p.projectPath : undefined)
};

let dir;
const panels = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  process.env.AE_MCP_BRIDGE_DIR = dir;
});

afterEach(() => {
  while (panels.length) panels.pop().stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// respond(cmd, write) is called once per new pending command; write(obj, overrides?) stamps and writes the result.
function fakePanel(prefix, respond) {
  const cmdPath = path.join(dir, `${prefix}_command.json`);
  const resPath = path.join(dir, `${prefix}_mcp_result.json`);
  const seen = [];
  let stopped = false;
  let lastId;
  const write = (cmd, obj, stamps = {}) => {
    const full = { ...obj, _commandId: cmd.id, _commandExecuted: cmd.command, _responseTimestamp: new Date().toISOString(),
      _project: cmd.expectedProject ?? "", _projectChanged: false, ...stamps };
    const tmp = path.join(dir, `${prefix}_mcp_result.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(full));
    fs.rmSync(resPath, { force: true });
    fs.renameSync(tmp, resPath);
  };
  (async () => {
    while (!stopped) {
      try {
        const cmd = JSON.parse(fs.readFileSync(cmdPath, "utf8"));
        if (cmd.status === "pending" && cmd.id !== lastId) {
          lastId = cmd.id;
          seen.push(cmd);
          await respond(cmd, (obj, stamps) => write(cmd, obj, stamps));
        }
      } catch {}
      await sleep(5);
    }
  })();
  const panel = { seen, stop() { stopped = true; } };
  panels.push(panel);
  return panel;
}

const fast = { timeoutMs: 3000, pollMs: 10 };

test("pr prefix uses pr_command.json / pr_mcp_result.json; ae names unchanged", async () => {
  const pr = new BridgeClient(PR);
  const ae = new BridgeClient(AE);
  assert.equal(pr.commandFileName, "pr_command.json");
  assert.equal(pr.resultFileName, "pr_mcp_result.json");
  assert.equal(ae.commandFileName, "ae_command.json");
  assert.equal(ae.resultFileName, "ae_mcp_result.json");
  assert.equal(new BridgeClient({ ...PR, prefix: "prx" }).commandFileName, "prx_command.json");

  fakePanel("pr", (cmd, write) => write({ status: "success", echo: cmd.args.x }));
  const result = JSON.parse(await pr.sendBridgeCommand("ping", { x: 1 }, fast));
  assert.equal(result.echo, 1);
  assert.ok(fs.existsSync(path.join(dir, "pr_command.json")));
  assert.ok(!fs.existsSync(path.join(dir, "ae_command.json")));
});

test("matches its own id and ignores results with another _commandId", async () => {
  const pr = new BridgeClient(PR);
  fakePanel("pr", async (cmd, write) => {
    write({ status: "success", which: "other" }, { _commandId: "someone-else" });
    await sleep(60);
    write({ status: "success", which: "mine" });
  });
  const result = JSON.parse(await pr.sendBridgeCommand("ping", {}, fast));
  assert.equal(result.which, "mine");
});

test("resultMatchesCommand: id wins, falls back to command name only without an id", () => {
  assert.equal(resultMatchesCommand({ _commandId: "a" }, "a"), true);
  assert.equal(resultMatchesCommand({ _commandId: "b", _commandExecuted: "x" }, "a", "x"), false);
  assert.equal(resultMatchesCommand({ _commandExecuted: "x" }, "a", "x"), true);
  assert.equal(resultMatchesCommand({ _commandExecuted: "y" }, "a", "x"), false);
});

test("times out with an error when no matching result arrives", async () => {
  const pr = new BridgeClient(PR);
  const result = JSON.parse(await pr.sendBridgeCommand("ping", {}, { timeoutMs: 150, pollMs: 10 }));
  assert.match(result.error, /Timed out .*'ping'/);
});

test("timeout says the panel never picked the command up while it is still pending", async () => {
  const ae = new BridgeClient(AE);
  const result = JSON.parse(await ae.sendBridgeCommand("getSandboxFolder", {}, { timeoutMs: 150, pollMs: 10, expectedProject: null }));
  assert.equal(result.code, "NOT_PICKED_UP");
  assert.match(result.error, /Timed out .*'getSandboxFolder'.*never picked the command up.*MCP Bridge Auto.*dialog/);
});

function writeHeartbeat(ageMs) {
  fs.writeFileSync(path.join(dir, "ae_heartbeat.json"), JSON.stringify({ ts: new Date(Date.now() - ageMs).toISOString(), project: "" }));
}

test("a stale heartbeat revives the panel before the command is written, then the command runs", async () => {
  let kicks = 0;
  const ae = new BridgeClient({ ...AE, heartbeatFileName: "ae_heartbeat.json", revive: () => {
    kicks++;
    // The kick re-arms the panel: it starts polling and heartbeating again.
    writeHeartbeat(0);
    fakePanel("ae", (cmd, write) => write({ status: "success", revived: true }));
    return true;
  } });
  writeHeartbeat(60000);
  const result = JSON.parse(await ae.sendBridgeCommand("getProjectInfo", {}, { ...fast, expectedProject: null }));
  assert.equal(kicks, 1);
  assert.equal(result.revived, true);
  // Fresh heartbeat: no second kick.
  await ae.sendBridgeCommand("getProjectInfo", {}, { ...fast, expectedProject: null });
  assert.equal(kicks, 1);
});

test("no revive without a heartbeat file, with a fresh one, or without a revive hook", async () => {
  let kicks = 0;
  const ae = new BridgeClient({ ...AE, heartbeatFileName: "ae_heartbeat.json", revive: () => { kicks++; return true; } });
  fakePanel("ae", (cmd, write) => write({ status: "success" }));
  await ae.sendBridgeCommand("getProjectInfo", {}, { ...fast, expectedProject: null });
  writeHeartbeat(1000);
  await ae.sendBridgeCommand("getProjectInfo", {}, { ...fast, expectedProject: null });
  assert.equal(kicks, 0);
  writeHeartbeat(60000);
  assert.equal(await new BridgeClient({ ...AE, heartbeatFileName: "ae_heartbeat.json" }).reviveIfStale(50), undefined);
});

test("timeout after a failed revive reports the heartbeat age and what the kick did", async () => {
  const ae = new BridgeClient({ ...AE, heartbeatFileName: "ae_heartbeat.json", reviveWaitMs: 60, revive: () => true });
  writeHeartbeat(30000);
  const result = JSON.parse(await ae.sendBridgeCommand("getSandboxFolder", {}, { timeoutMs: 150, pollMs: 10, expectedProject: null }));
  assert.equal(result.code, "NOT_PICKED_UP");
  assert.match(result.error, /last poll was 30 s ago.*last poll 30 s ago.*no heartbeat followed.*modal dialog/);

  const noKick = new BridgeClient({ ...AE, heartbeatFileName: "ae_heartbeat.json", reviveWaitMs: 60, revive: () => false });
  const r2 = JSON.parse(await noKick.sendBridgeCommand("getSandboxFolder", {}, { timeoutMs: 150, pollMs: 10, expectedProject: null }));
  assert.match(r2.error, /could not be re-armed/);
});

test("timeout says the command is still running once the panel marked it running", async () => {
  const ae = new BridgeClient(AE);
  const pending = ae.sendBridgeCommand("getProjectInfo", {}, { timeoutMs: 200, pollMs: 10, expectedProject: null });
  await sleep(30);
  const f = path.join(dir, "ae_command.json");
  const cmd = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...cmd, status: "running" }));
  const result = JSON.parse(await pending);
  assert.equal(result.code, "STILL_RUNNING");
  assert.match(result.error, /still running\. Call get-results/);
});

test("waitWhileRunning keeps polling through the running result", async () => {
  const pr = new BridgeClient(PR);
  fakePanel("pr", async (cmd, write) => {
    write({ status: "running" });
    await sleep(150);
    write({ status: "success", returnValue: 42 });
  });
  const result = JSON.parse(await pr.sendBridgeCommand("runScript", { code: "return 42" }, { ...fast, waitWhileRunning: true }));
  assert.equal(result.returnValue, 42);
  assert.equal(pr.pendingScriptId, undefined);
});

test("still running: reports running with hint, sets pendingScriptId, refuses other commands until final", async () => {
  const pr = new BridgeClient(PR);
  let finish;
  const done = new Promise((r) => (finish = r));
  fakePanel("pr", async (cmd, write) => {
    if (cmd.command === "runScript") {
      write({ status: "running" });
      await done;
      write({ status: "success", returnValue: "late" });
    } else {
      write({ status: "success" });
    }
  });
  const running = JSON.parse(await pr.sendBridgeCommand("runScript", { code: "x" }, { timeoutMs: 200, pollMs: 10, waitWhileRunning: true }));
  assert.equal(running.status, "running");
  assert.match(running.message, /premiere-get-results/);
  assert.match(running.message, /a Premiere dialog may be waiting/);
  assert.equal(pr.pendingScriptId, running._commandId);

  await assert.rejects(pr.sendBridgeCommand("ping", {}, fast),
    /A script is still running in Premiere Pro \(id .*\)\. Call premiere-get-results until it finishes\./);
  await assert.rejects(pr.queueBridgeCommand("ping"), /still running/);

  finish();
  await sleep(100);
  const final = JSON.parse(pr.readResults());
  assert.equal(final.returnValue, "late");
  assert.equal(pr.pendingScriptId, undefined);
  const ok = JSON.parse(await pr.sendBridgeCommand("ping", {}, fast));
  assert.equal(ok.status, "success");
});

test("pendingScriptMessage clears itself when the final result is already on disk", async () => {
  const pr = new BridgeClient(PR);
  pr.markPendingScript("abc");
  fs.writeFileSync(pr.resultFilePath(), JSON.stringify({ status: "success", _commandId: "abc" }));
  assert.equal(pr.pendingScriptMessage(), undefined);
  assert.equal(pr.pendingScriptId, undefined);
});

test("command file is written atomically as pure-ASCII JSON", () => {
  const pr = new BridgeClient(PR);
  pr.confirmedProject = "C:\\Projekte\\Küche\\Schnitt.prproj";
  const id = pr.writeCommandFile("importFiles", { files: ["C:\\médias\\clip✓.mov"] });
  const bytes = fs.readFileSync(path.join(dir, "pr_command.json"));
  assert.ok(bytes.every((b) => b < 0x80), "command file must be pure ASCII");
  assert.ok(!fs.existsSync(path.join(dir, "pr_command.json.tmp")), "tmp file must be renamed away");
  const cmd = JSON.parse(bytes.toString("utf8"));
  assert.equal(cmd.id, id);
  assert.equal(pr.lastCommandId, id);
  assert.equal(cmd.status, "pending");
  assert.equal(cmd.command, "importFiles");
  assert.deepEqual(cmd.args.files, ["C:\\médias\\clip✓.mov"]);
  assert.equal(cmd.expectedProject, "C:\\Projekte\\Küche\\Schnitt.prproj");
  assert.equal(toAsciiJson({ a: "é" }), '{\n  "a": "\\u00e9"\n}');
});

test("expectedProject: confirmedProject by default, override, null omits", () => {
  const pr = new BridgeClient(PR);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, "pr_command.json"), "utf8"));
  pr.writeCommandFile("a");
  assert.equal("expectedProject" in read(), false);
  pr.confirmedProject = "C:\\x\\A.prproj";
  pr.writeCommandFile("a");
  assert.equal(read().expectedProject, "C:\\x\\A.prproj");
  pr.writeCommandFile("a", {}, { expectedProject: "C:\\x\\B.prproj" });
  assert.equal(read().expectedProject, "C:\\x\\B.prproj");
  pr.writeCommandFile("a", {}, { expectedProject: null });
  assert.equal("expectedProject" in read(), false);
});

test("mutex serialises two sends: the second command is written only after the first result", async () => {
  const pr = new BridgeClient(PR);
  const cmdPath = path.join(dir, "pr_command.json");
  const overlaps = [];
  const panel = fakePanel("pr", async (cmd, write) => {
    await sleep(120);
    // While this command is being processed nobody may have replaced the command file.
    const onDisk = JSON.parse(fs.readFileSync(cmdPath, "utf8"));
    if (onDisk.id !== cmd.id) overlaps.push(cmd.command);
    write({ status: "success", name: cmd.command });
  });
  const [a, b] = await Promise.all([
    pr.sendBridgeCommand("first", {}, fast),
    pr.sendBridgeCommand("second", {}, fast)
  ]);
  assert.equal(JSON.parse(a).name, "first");
  assert.equal(JSON.parse(b).name, "second");
  assert.deepEqual(panel.seen.map((c) => c.command), ["first", "second"]);
  assert.deepEqual(overlaps, []);
});

test("separate clients have separate locks: a long pr command does not block prx", async () => {
  const state = new ProjectState();
  const pr = new BridgeClient(PR, state);
  const prx = new BridgeClient({ ...PR, prefix: "prx" }, state);
  fakePanel("pr", async (cmd, write) => { await sleep(400); write({ status: "success" }); });
  fakePanel("prx", (cmd, write) => write({ status: "success" }));
  const slow = pr.sendBridgeCommand("slow", {}, fast);
  const t0 = Date.now();
  await prx.sendBridgeCommand("quick", {}, fast);
  assert.ok(Date.now() - t0 < 300, "prx must not wait for pr");
  await slow;
  state.confirmedProject = "C:\\p\\S.prproj";
  assert.equal(prx.confirmedProject, "C:\\p\\S.prproj", "shared ProjectState");
});

test("confirmedProject: updated only by our own successful result", async () => {
  const ae = new BridgeClient(AE);
  // Own getSandboxFolder success confirms.
  ae.updateConfirmedProjectFromResult({ status: "success", _commandId: "1", _commandExecuted: "getSandboxFolder", projectPath: "C:\\a\\A.aep" }, "1");
  assert.equal(ae.confirmedProject, "C:\\a\\A.aep");
  // Someone else's result never counts.
  ae.updateConfirmedProjectFromResult({ status: "success", _commandId: "2", _commandExecuted: "getSandboxFolder", projectPath: "C:\\b\\B.aep" }, "1");
  ae.updateConfirmedProjectFromResult({ status: "success", _commandId: "2", _projectChanged: true, _project: "C:\\b\\B.aep" }, "1");
  assert.equal(ae.confirmedProject, "C:\\a\\A.aep");
  // Refusals and errors never count.
  ae.updateConfirmedProjectFromResult({ status: "error", refused: true, code: "PROJECT_MISMATCH", _commandId: "3", _projectChanged: true, _project: "C:\\c\\C.aep" }, "3");
  ae.updateConfirmedProjectFromResult({ status: "error", _commandId: "3", _commandExecuted: "getSandboxFolder", projectPath: "C:\\c\\C.aep" }, "3");
  assert.equal(ae.confirmedProject, "C:\\a\\A.aep");
  // _projectChanged on own success counts.
  ae.updateConfirmedProjectFromResult({ status: "success", _commandId: "4", _projectChanged: true, _project: "C:\\a\\A2.aep" }, "4");
  assert.equal(ae.confirmedProject, "C:\\a\\A2.aep");
  // Success without _projectChanged doesn't.
  ae.updateConfirmedProjectFromResult({ status: "success", _commandId: "5", _projectChanged: false, _project: "C:\\z\\Z.aep" }, "5");
  assert.equal(ae.confirmedProject, "C:\\a\\A2.aep");
});

test("confirmFromResult gets what was sent and may clear confirmedProject with null", async () => {
  const calls = [];
  const pr = new BridgeClient({ ...PR, confirmFromResult: (p, info) => { calls.push(info); return p.clear ? null : undefined; } });
  pr.confirmedProject = "C:\\p\\A.prproj";
  let clear = false;
  fakePanel("pr", (cmd, write) => write({ status: "success", clear }));
  await pr.sendBridgeCommand("getState", {}, fast);
  assert.deepEqual(calls.at(-1), { expectedProject: "C:\\p\\A.prproj", explicitProject: false, confirmedProject: "C:\\p\\A.prproj" });
  await pr.sendBridgeCommand("getState", {}, { ...fast, expectedProject: "C:\\p\\B.prproj" });
  assert.deepEqual(calls.at(-1), { expectedProject: "C:\\p\\B.prproj", explicitProject: true, confirmedProject: "C:\\p\\A.prproj" });
  assert.equal(pr.confirmedProject, "C:\\p\\A.prproj");
  clear = true;
  await pr.sendBridgeCommand("getState", {}, { ...fast, expectedProject: null });
  assert.deepEqual(calls.at(-1), { expectedProject: undefined, explicitProject: false, confirmedProject: "C:\\p\\A.prproj" });
  assert.equal(pr.confirmedProject, undefined);
});

test("confirmedProject through a real round trip, and get-results with a foreign result", async () => {
  const pr = new BridgeClient(PR);
  pr.confirmedProject = "C:\\p\\A.prproj";
  fakePanel("pr", (cmd, write) => write({ status: "success" }, { _projectChanged: true, _project: "C:\\p\\B.prproj" }));
  await pr.sendBridgeCommand("saveProject", { path: "C:\\p\\B.prproj" }, fast);
  assert.equal(pr.confirmedProject, "C:\\p\\B.prproj");
  // A result for a command we did not send (e.g. another server instance) is ignored by readResults.
  fs.writeFileSync(pr.resultFilePath(), JSON.stringify({ status: "success", _commandId: "foreign", _projectChanged: true, _project: "C:\\p\\X.prproj" }));
  pr.readResults();
  assert.equal(pr.confirmedProject, "C:\\p\\B.prproj");
});

test("STALE result is reported as an error with a note that nothing ran", async () => {
  const pr = new BridgeClient(PR);
  fakePanel("pr", (cmd, write) => write({ status: "error", refused: true, code: "STALE", message: "too old" }));
  const raw = await pr.sendBridgeCommand("ping", {}, fast);
  const out = formatBridgeResult(raw, { appLabel: "Premiere Pro" });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Nothing ran/);
  assert.match(out.content[0].text, /Premiere Pro was busy/);
  // A STALE without status:error is still an error.
  assert.equal(formatBridgeResult(JSON.stringify({ code: "STALE" }), { appLabel: "X" }).isError, true);
  assert.equal(formatBridgeResult(JSON.stringify({ status: "success" }), { appLabel: "X" }).isError, undefined);
});

test("clearResultsFile and readResults messages use the app label", () => {
  const pr = new BridgeClient(PR);
  assert.match(JSON.parse(pr.readResults()).error, /run a script in Premiere Pro first/);
  pr.clearResultsFile();
  const waiting = JSON.parse(fs.readFileSync(pr.resultFilePath(), "utf8"));
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.message, "Waiting for new result from Premiere Pro...");
});

test("waitSecondsToMs: default 30, clamped to 1-600, in ms (same as the AE clamp for any number)", () => {
  const ae = (s) => Math.min(Math.max(s, 1), 600) * 1000;
  for (const s of [-5, 0, 1, 30, 599.5, 600, 601, 1e9]) assert.equal(waitSecondsToMs(s), ae(s), String(s));
  assert.equal(waitSecondsToMs(undefined), 30000);
  assert.equal(waitSecondsToMs(Number.NaN), 30000);
});
