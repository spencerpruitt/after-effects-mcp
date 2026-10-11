// Server routing to the CEP sidecar (spec section 8): premiere-set-speed, audio premiere-add-transition and
// premiere-link-clips go to prx_command.json only when prx_heartbeat.json is fresher than 6 s; otherwise they
// return NEEDS_SIDECAR_UNAVAILABLE without writing anything. premiere-get-results answers for whichever
// client was used last.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPremiereServer, isSidecarAvailable, SIDECAR_FRESH_MS } from "../build/premiere.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = "D:\\Projects\\MyFilm\\edit\\Edit.prproj";

let dir;
const stops = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-sidecar-server-"));
  process.env.AE_MCP_BRIDGE_DIR = dir;
});

afterEach(() => {
  while (stops.length) stops.pop()();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A fake panel or sidecar answering <prefix>_command.json. Returns the commands it saw.
function fakeApp(prefix, respond = (cmd) => ({ status: "success", via: prefix })) {
  const cmdPath = path.join(dir, `${prefix}_command.json`);
  const resPath = path.join(dir, `${prefix}_mcp_result.json`);
  const seen = [];
  let stopped = false;
  let lastId;
  (async () => {
    while (!stopped) {
      try {
        const cmd = JSON.parse(fs.readFileSync(cmdPath, "utf8"));
        if (cmd.status === "pending" && cmd.id !== lastId) {
          lastId = cmd.id;
          seen.push(cmd);
          fs.writeFileSync(resPath, JSON.stringify({ ...respond(cmd), _commandId: cmd.id, _commandExecuted: cmd.command,
            _responseTimestamp: new Date().toISOString(), _project: cmd.expectedProject ?? "", _projectChanged: false }));
        }
      } catch {}
      await sleep(5);
    }
  })();
  stops.push(() => { stopped = true; });
  return seen;
}

function heartbeat(ageMs = 0) {
  fs.writeFileSync(path.join(dir, "prx_heartbeat.json"), JSON.stringify({ pid: 1, ts: new Date(Date.now() - ageMs).toISOString(), version: "1.0.0" }));
}

function server() {
  const srv = createPremiereServer();
  srv.projectState.confirmedProject = A;
  return srv;
}

const call = (srv, name, args = {}) => srv.tools[name].handler(args);
const parse = (res) => JSON.parse(res.content[0].text);

test("isSidecarAvailable: fresh ts, stale ts, mtime fallback, missing file", () => {
  const now = Date.now();
  assert.equal(isSidecarAvailable(dir, now), false, "missing");
  heartbeat(1000);
  assert.equal(isSidecarAvailable(dir, now), true);
  assert.equal(isSidecarAvailable(dir, now + SIDECAR_FRESH_MS), false, "older than 6 s");
  fs.writeFileSync(path.join(dir, "prx_heartbeat.json"), "garbage");
  assert.equal(isSidecarAvailable(dir, Date.now()), true, "unparseable: the file's mtime counts");
  assert.equal(isSidecarAvailable(dir, Date.now() + 60000), false);
});

test("premiere-set-speed without a sidecar: NEEDS_SIDECAR_UNAVAILABLE with install steps, nothing written", async () => {
  const srv = server();
  const res = await call(srv, "premiere-set-speed", { sequence: "Main", track: "V1", index: 0, percent: 50 });
  assert.equal(res.isError, true);
  const r = parse(res);
  assert.equal(r.code, "NEEDS_SIDECAR_UNAVAILABLE");
  assert.match(r.install, /npm run install-premiere-sidecar/);
  assert.match(r.install, /PlayerDebugMode/);
  assert.equal(fs.existsSync(path.join(dir, "prx_command.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "pr_command.json")), false);
  heartbeat(7000);
  assert.equal(parse(await call(srv, "premiere-set-speed", { sequence: "Main", track: "V1", index: 0, percent: 50 })).code, "NEEDS_SIDECAR_UNAVAILABLE", "stale heartbeat");
});

test("premiere-set-speed with a sidecar: prx setSpeed with the args and the target project", async () => {
  heartbeat();
  const prx = fakeApp("prx");
  const pr = fakeApp("pr");
  const srv = server();
  const res = await call(srv, "premiere-set-speed", { sequence: "Main", track: "V1", index: 2, percent: 50, reverse: false, ripple: true, maintainPitch: true });
  assert.equal(parse(res).via, "prx");
  assert.equal(pr.length, 0);
  assert.equal(prx.length, 1);
  assert.equal(prx[0].command, "setSpeed");
  assert.deepEqual(prx[0].args, { sequence: "Main", track: "V1", index: 2, percent: 50, reverse: false, ripple: true, maintainPitch: true });
  assert.equal(prx[0].expectedProject, A);
  // An explicit project overrides the confirmed one.
  await call(srv, "premiere-set-speed", { sequence: "Main", track: "V1", index: 0, percent: 25, project: "D:\\Other\\B.prproj" });
  assert.equal(prx[1].expectedProject, "D:\\Other\\B.prproj");
});

test("premiere-add-transition: video goes to the panel, audio to the sidecar", async () => {
  heartbeat();
  const prx = fakeApp("prx");
  const pr = fakeApp("pr");
  const srv = server();
  let r = parse(await call(srv, "premiere-add-transition", { sequence: "Main", track: "V1", index: 0, edge: "end", durationFrames: 12 }));
  assert.equal(r.via, "pr");
  assert.equal(pr[0].command, "addTransition");
  r = parse(await call(srv, "premiere-add-transition", { sequence: "Main", track: "A2", index: 1, edge: "both", type: "Constant Gain", durationFrames: 8 }));
  assert.equal(r.via, "prx");
  assert.equal(prx[0].command, "addAudioTransition");
  assert.deepEqual(prx[0].args, { sequence: "Main", track: "A2", index: 1, edge: "both", type: "Constant Gain", durationFrames: 8 });
  assert.equal(pr.length, 1);
});

test("premiere-add-transition on audio without a sidecar refuses; video still works", async () => {
  const pr = fakeApp("pr");
  const srv = server();
  const r = parse(await call(srv, "premiere-add-transition", { sequence: "Main", track: "a1", index: 0, edge: "start", durationFrames: 12 }));
  assert.equal(r.code, "NEEDS_SIDECAR_UNAVAILABLE");
  assert.equal(pr.length, 0);
  assert.equal(parse(await call(srv, "premiere-add-transition", { sequence: "Main", track: "V2", index: 0, edge: "start", durationFrames: 12 })).via, "pr");
});

test("premiere-link-clips: link true -> link, false -> unlink; refuses without a sidecar", async () => {
  const srv = server();
  const items = [{ track: "V1", index: 0 }, { track: "A1", index: 0 }];
  assert.equal(parse(await call(srv, "premiere-link-clips", { sequence: "Main", items, link: false })).code, "NEEDS_SIDECAR_UNAVAILABLE");
  heartbeat();
  const prx = fakeApp("prx");
  await call(srv, "premiere-link-clips", { sequence: "Main", items, link: false });
  await call(srv, "premiere-link-clips", { sequence: "Main", items, link: true });
  assert.deepEqual(prx.map((c) => c.command), ["unlink", "link"]);
  assert.deepEqual(prx[0].args, { sequence: "Main", items });
  assert.ok(!("link" in prx[1].args));
  assert.ok("link" in srv.tools["premiere-link-clips"].schema);
  assert.ok("project" in srv.tools["premiere-link-clips"].schema);
});

test("sidecar tools still need a target project", async () => {
  heartbeat();
  const srv = createPremiereServer();
  const res = await call(srv, "premiere-set-speed", { sequence: "Main", track: "V1", index: 0, percent: 50 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /premiere-get-state/);
  assert.equal(fs.existsSync(path.join(dir, "prx_command.json")), false);
});

test("premiere-get-results answers for the client used last", async () => {
  heartbeat();
  fakeApp("prx", () => ({ status: "success", who: "sidecar" }));
  fakeApp("pr", () => ({ status: "success", who: "panel" }));
  const srv = server();
  await call(srv, "premiere-add-transition", { sequence: "Main", track: "V1", index: 0, edge: "end", durationFrames: 12 });
  assert.equal(parse(await call(srv, "premiere-get-results")).who, "panel");
  await sleep(5);
  await call(srv, "premiere-set-speed", { sequence: "Main", track: "V1", index: 0, percent: 50 });
  assert.equal(parse(await call(srv, "premiere-get-results")).who, "sidecar");
  await sleep(5);
  await call(srv, "premiere-add-transition", { sequence: "Main", track: "V1", index: 0, edge: "end", durationFrames: 12 });
  assert.equal(parse(await call(srv, "premiere-get-results")).who, "panel");
});

// Live e2e: P35 sent addTransition and P36 sent { track, index } to the sidecar, so both failed on the harness's
// side. The harness now drives the sidecar through the server's own routing; this keeps its calls valid.
test("the e2e harness's sidecar calls route as the server does and pass the sidecar's argument checks", async () => {
  const { PREMIERE_TOOL_ROUTES } = await import("../build/premiere.js");
  const { SIDECAR_TOOL_CALLS } = await import("./e2e/premiere.e2e.mjs");
  const { createRequire } = await import("node:module");
  const core = createRequire(import.meta.url)("../src/premiere-cep/js/core.js");
  const expected = { speed: "setSpeed", audioCrossfade: "addAudioTransition", unlink: "unlink", link: "link" };
  for (const [key, make] of Object.entries(SIDECAR_TOOL_CALLS)) {
    const [tool, params] = make("Seq");
    const routed = PREMIERE_TOOL_ROUTES[tool]({ ...params });
    assert.equal(routed.via, "prx", key);
    assert.equal(routed.command, expected[key], key);
    assert.ok(core.OPERATIONS.includes(routed.command), key);
    const args = routed.args || params;
    assert.equal(core.validateArgs(routed.command, args), null, `${key}: ${JSON.stringify(args)}`);
    assert.ok(!("link" in args), `${key}: the link flag picks the command and is not sent`);
  }
});
