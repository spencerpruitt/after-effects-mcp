// Unit tests for the "premiere" MCP server's tool handlers (build/premiere.js), driven without stdio
// against a fake panel that answers pr_command.json in a temp bridge dir.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import {
  createPremiereServer, getApiHelpText, premiereConfirmFromResult, TimeSchema, ItemRefSchema, TrackRefSchema, API_HELP_TOPICS
} from "../build/premiere.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = "C:\\Edit\\A.prproj";
const B = "C:\\Edit\\B.prproj";

let dir;
let stopPanel = () => {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-server-test-"));
  process.env.AE_MCP_BRIDGE_DIR = dir;
});

afterEach(() => {
  stopPanel();
  fs.rmSync(dir, { recursive: true, force: true });
});

// respond(cmd) returns { result, stamps? } or a promise of it; null = never answer.
function fakePanel(respond) {
  const cmdPath = path.join(dir, "pr_command.json");
  const resPath = path.join(dir, "pr_mcp_result.json");
  const seen = [];
  let stopped = false;
  let lastId;
  const write = (cmd, obj, stamps = {}) => {
    fs.writeFileSync(resPath, JSON.stringify({ ...obj, _commandId: cmd.id, _commandExecuted: cmd.command,
      _responseTimestamp: new Date().toISOString(), _project: cmd.expectedProject ?? "", _projectChanged: false, ...stamps }));
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
  stopPanel = () => { stopped = true; };
  return seen;
}

const ok = (cmd, write) => write({ status: "success" });
const call = (srv, name, args = {}) => srv.tools[name].handler(args);
const text = (res) => res.content[0].text;

test("registers every v1 tool with the expected name", () => {
  const srv = createPremiereServer();
  const expected = [
    "premiere-get-state", "premiere-get-api-help", "premiere-create-project", "premiere-open-project", "premiere-save-project",
    "premiere-get-project-items", "premiere-import", "premiere-replace-media", "premiere-create-sequence", "premiere-get-sequence",
    "premiere-build-sequence", "premiere-edit-items", "premiere-place-audio", "premiere-set-audio", "premiere-add-transition",
    "premiere-set-speed", "premiere-add-markers", "premiere-export", "premiere-run-script-code", "premiere-run-script-file",
    "premiere-get-results", "premiere-link-clips", "premiere-import-ae-comps"
  ];
  assert.deepEqual(Object.keys(srv.tools).sort(), [...expected].sort());
  for (const name of expected) {
    if (name === "premiere-get-api-help" || name === "premiere-get-results") continue;
    assert.ok("project" in srv.tools[name].schema, `${name} takes project`);
  }
  for (const name of ["premiere-run-script-code", "premiere-run-script-file"]) {
    assert.match(srv.tools[name].description,
      /Call premiere-get-api-help first; code is an async JS body with ppro, project, sandbox, fs, require, time in scope; use return\./);
  }
});

test("premiere-import-ae-comps sends importAEComps with its args", async () => {
  const srv = createPremiereServer();
  const seen = fakePanel(ok);
  const res = await call(srv, "premiere-import-ae-comps", { aepPath: "D:\\Projects\\MyFilm\\shots\\SH010\\SH010.aep", comps: ["Main"], bin: "AE", skipExisting: true, project: A });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(seen[0].command, "importAEComps");
  assert.equal(seen[0].expectedProject, A);
  assert.deepEqual(seen[0].args, { aepPath: "D:\\Projects\\MyFilm\\shots\\SH010\\SH010.aep", comps: ["Main"], bin: "AE", skipExisting: true });
});

test("project arg maps to expectedProject; args drop project/waitSeconds", async () => {
  const srv = createPremiereServer();
  const seen = fakePanel(ok);
  const res = await call(srv, "premiere-import", { files: ["C:\\r\\a.mov"], bin: "Renders", skipExisting: true, project: A });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(seen[0].command, "importFiles");
  assert.equal(seen[0].expectedProject, A);
  assert.deepEqual(seen[0].args, { files: ["C:\\r\\a.mov"], bin: "Renders", skipExisting: true });

  await call(srv, "premiere-run-script-code", { code: "return 1", waitSeconds: 5, project: B });
  assert.equal(seen[1].command, "runScript");
  assert.equal(seen[1].expectedProject, B);
  assert.deepEqual(seen[1].args, { code: "return 1" });
});

test("without project and without a confirmed project, tools refuse before writing anything", async () => {
  const srv = createPremiereServer();
  const res = await call(srv, "premiere-get-project-items", {});
  assert.equal(res.isError, true);
  assert.match(text(res), /premiere-get-state first/);
  assert.equal(fs.existsSync(path.join(dir, "pr_command.json")), false);

  const rel = await call(srv, "premiere-save-project", { project: "Edit\\A.prproj" });
  assert.equal(rel.isError, true);
  assert.match(text(rel), /absolute/);
});

test("getState / openProject / createProject may go without a target (no expectedProject sent)", async () => {
  const srv = createPremiereServer();
  const seen = fakePanel((cmd, write) => write({ status: "success", openProjects: [], activeProject: null }));
  await call(srv, "premiere-get-state", {});
  assert.equal(seen[0].command, "getState");
  assert.equal("expectedProject" in seen[0], false);
  await call(srv, "premiere-open-project", { path: A });
  assert.equal(seen[1].command, "openProject");
  assert.deepEqual(seen[1].args, { path: A });
  assert.equal("expectedProject" in seen[1], false);
});

test("getState confirms only when exactly one saved project is active; later tools use it", async () => {
  const srv = createPremiereServer();
  let state = { openProjects: [{ path: A, isActive: true }, { path: B, isActive: false }], activeProject: A };
  const seen = fakePanel((cmd, write) => write(cmd.command === "getState" ? { status: "success", ...state } : { status: "success" }));
  await call(srv, "premiere-get-state", {});
  assert.equal(srv.projectState.confirmedProject, A);
  await call(srv, "premiere-get-project-items", {});
  assert.equal(seen[1].expectedProject, A);

  // Untitled active project, A still open: unchanged.
  state = { openProjects: [{ path: "", isActive: true }, { path: A, isActive: false }, { path: B, isActive: false }], activeProject: "" };
  await call(srv, "premiere-get-state", {});
  assert.equal(srv.projectState.confirmedProject, A);
  // Explicit project wins over confirmedProject, and does not change it.
  await call(srv, "premiere-get-project-items", { project: B });
  assert.equal(seen[3].expectedProject, B);
  assert.equal(srv.projectState.confirmedProject, A);
});

test("premiereConfirmFromResult rules", () => {
  const gs = (extra) => premiereConfirmFromResult({ _commandExecuted: "getState", status: "success", ...extra });
  assert.equal(gs({ activeProject: A, openProjects: [{ path: A, isActive: true }] }), A);
  assert.equal(gs({ activeProject: { path: A }, openProjects: [{ path: A, isActive: true }] }), A);
  assert.equal(gs({ activeProject: A, openProjects: [{ path: A, isActive: true }, { path: B, isActive: true }] }), undefined);
  assert.equal(gs({ activeProject: A, openProjects: [{ path: A, isActive: false }] }), undefined);
  assert.equal(gs({ activeProject: "" }), undefined);
  assert.equal(gs({ activeProject: null }), undefined);
  assert.equal(premiereConfirmFromResult({ _commandExecuted: "getState", status: "error", activeProject: A }), undefined);
  assert.equal(premiereConfirmFromResult({ _commandExecuted: "openProject", status: "success", _project: B }), B);
  assert.equal(premiereConfirmFromResult({ _commandExecuted: "createProject", status: "success", _project: B }), B);
  assert.equal(premiereConfirmFromResult({ _commandExecuted: "importFiles", status: "success", _project: B }), undefined);
});

test("premiereConfirmFromResult: explicit project, no project, and clearing a closed confirmed project", () => {
  const C = "C:\\Edit\\C.prproj";
  const open = [{ path: A, isActive: true }, { path: B, isActive: false }];
  const gs = (extra, info) => premiereConfirmFromResult({ _commandExecuted: "getState", status: "success", ...extra }, info);
  // Explicit project: confirm it only if it is open (matched case/separator-insensitively), never the active one.
  assert.equal(gs({ activeProject: A, openProjects: open }, { explicitProject: true, expectedProject: "c:/edit/b.prproj", confirmedProject: A }), B);
  assert.equal(gs({ activeProject: A, openProjects: open }, { explicitProject: true, expectedProject: C, confirmedProject: A }), undefined);
  assert.equal(gs({ activeProject: A, openProjects: open }, { explicitProject: true, expectedProject: C, confirmedProject: C }), null);
  // No project: exactly one active saved project, else clear a confirmed project that is no longer open.
  assert.equal(gs({ activeProject: A, openProjects: open }, { explicitProject: false, expectedProject: B, confirmedProject: B }), A);
  const untitled = [{ path: "", isActive: true }, { path: B, isActive: false }];
  assert.equal(gs({ activeProject: "", openProjects: untitled }, { explicitProject: false, expectedProject: B, confirmedProject: B }), undefined);
  assert.equal(gs({ activeProject: "", openProjects: untitled }, { explicitProject: false, expectedProject: C, confirmedProject: C }), null);
  assert.equal(gs({ activeProject: null, openProjects: [] }, { explicitProject: false, confirmedProject: C }), null);
});

test("get-state with project confirms that open project; a closed confirmed project is cleared", async () => {
  const srv = createPremiereServer();
  let state = { openProjects: [{ path: A, isActive: true }, { path: B, isActive: false }], activeProject: A };
  const seen = fakePanel((cmd, write) => write(cmd.command === "getState" ? { status: "success", ...state } : { status: "success" }));
  await call(srv, "premiere-get-state", { project: B });
  assert.equal(seen[0].expectedProject, B);
  assert.equal(srv.projectState.confirmedProject, B, "explicit project, not the active one");
  await call(srv, "premiere-get-state", { project: "C:\\Edit\\Closed.prproj" });
  assert.equal(srv.projectState.confirmedProject, B, "a project that is not open is not confirmed");
  // B is closed and the active project is untitled: the stale confirmation is dropped.
  state = { openProjects: [{ path: "", isActive: true }], activeProject: "" };
  await call(srv, "premiere-get-state", {});
  assert.equal(seen[2].expectedProject, B);
  assert.equal(srv.projectState.confirmedProject, undefined);
  const res = await call(srv, "premiere-get-project-items", {});
  assert.equal(res.isError, true);
  assert.match(text(res), /premiere-get-state first/);
});

test("get-sequence limit is an int from 1 to 1000", () => {
  const srv = createPremiereServer();
  const gs = z.object(srv.tools["premiere-get-sequence"].schema);
  assert.ok(gs.safeParse({ sequence: "S", limit: 1000 }).success);
  for (const limit of [0, 1001, 2.5]) assert.equal(gs.safeParse({ sequence: "S", limit }).success, false, String(limit));
});

test("confirmedProject: open/create success, own _projectChanged, never refusals", async () => {
  const srv = createPremiereServer();
  let reply = { obj: { status: "success" }, stamps: {} };
  fakePanel((cmd, write) => write(reply.obj, { _project: cmd.args.path ?? cmd.expectedProject, ...reply.stamps }));
  await call(srv, "premiere-open-project", { path: A });
  assert.equal(srv.projectState.confirmedProject, A);
  await call(srv, "premiere-create-project", { path: B });
  assert.equal(srv.projectState.confirmedProject, B);

  reply = { obj: { status: "success" }, stamps: { _projectChanged: true, _project: "C:\\Edit\\B2.prproj" } };
  await call(srv, "premiere-save-project", { path: "C:\\Edit\\B2.prproj" });
  assert.equal(srv.projectState.confirmedProject, "C:\\Edit\\B2.prproj");

  reply = { obj: { status: "error", refused: true, code: "PROJECT_NOT_OPEN", openProjects: [A] }, stamps: { _project: A } };
  const res = await call(srv, "premiere-open-project", { path: A });
  assert.equal(res.isError, true);
  assert.match(text(res), /Refused by the project gate/);
  assert.match(text(res), /Open projects: C:\\Edit\\A\.prproj/);
  assert.equal(srv.projectState.confirmedProject, "C:\\Edit\\B2.prproj");
});

test("STALE and errors come back as isError", async () => {
  const srv = createPremiereServer();
  fakePanel((cmd, write) => write({ status: "error", refused: true, code: "STALE", message: "old" }));
  const res = await call(srv, "premiere-get-state", {});
  assert.equal(res.isError, true);
  assert.match(text(res), /Nothing ran/);
});

test("run-script still running mentions premiere-get-results and a Premiere dialog", async () => {
  const srv = createPremiereServer();
  fakePanel((cmd, write) => write({ status: "running" }));
  const res = await call(srv, "premiere-run-script-code", { code: "await new Promise(() => {})", waitSeconds: 1, project: A });
  const parsed = JSON.parse(text(res));
  assert.equal(parsed.status, "running");
  assert.match(parsed.message, /premiere-get-results/);
  assert.match(parsed.message, /a Premiere dialog may be waiting/);
  const blocked = await call(srv, "premiere-get-state", {});
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /A script is still running in Premiere Pro/);
  const results = await call(srv, "premiere-get-results", {});
  assert.equal(JSON.parse(text(results)).status, "running");
});

test("get-api-help: whole file, case-insensitive sections, unknown topic, missing file", async () => {
  const sheet = path.join(dir, "cheatsheet.md");
  fs.writeFileSync(sheet, [
    "# Premiere UXP cheat sheet", "", "Intro.", "",
    "## Transactions", "Use lockedAccess.", "```js", "## not a heading", "```", "### Sub", "detail", "",
    "## Time", "Ticks per second: 254016000000.", "",
    "## Export (direct and AME)", "exportSequence.", ""
  ].join("\n"));
  const srv = createPremiereServer({ cheatsheetPath: sheet });
  const all = await call(srv, "premiere-get-api-help", {});
  assert.equal(text(all), fs.readFileSync(sheet, "utf8"));

  const tx = text(await call(srv, "premiere-get-api-help", { topic: "transactions" }));
  assert.ok(tx.startsWith("## Transactions"));
  assert.match(tx, /## not a heading/);
  assert.match(tx, /### Sub\ndetail$/);
  assert.doesNotMatch(tx, /Ticks/);

  assert.equal(text(await call(srv, "premiere-get-api-help", { topic: "time" })), "## Time\nTicks per second: 254016000000.");
  assert.match(text(await call(srv, "premiere-get-api-help", { topic: "export" })), /^## Export \(direct and AME\)\nexportSequence\.$/);

  const missing = await call(srv, "premiere-get-api-help", { topic: "gaps" });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Sections: Transactions, Time, Export \(direct and AME\)/);

  const none = getApiHelpText("time", path.join(dir, "nope.md"));
  assert.equal(none.isError, true);
  assert.match(none.text, /cheat sheet is missing/);
  assert.equal(fs.existsSync(path.join(dir, "pr_command.json")), false, "help never reaches the panel");
});

test("default cheat sheet path resolves to <repo>/docs/premiere-uxp-cheatsheet.md", () => {
  const res = getApiHelpText(undefined);
  if (res.isError) {
    assert.match(res.text, /docs[\\/]premiere-uxp-cheatsheet\.md/);
  } else {
    assert.ok(res.text.length > 0);
  }
});

test("schemas: time, item and track refs, api-help topics", () => {
  assert.ok(TimeSchema.safeParse({ frames: 12 }).success);
  assert.ok(TimeSchema.safeParse({ frames: -3 }).success);
  assert.ok(TimeSchema.safeParse({ timecode: "00:00:01:12" }).success);
  assert.equal(TimeSchema.safeParse({ frames: 1.5 }).success, false);
  assert.equal(TimeSchema.safeParse(12).success, false);
  assert.equal(TimeSchema.safeParse({ seconds: 1 }).success, false);

  assert.ok(ItemRefSchema.safeParse("Renders/v003/SH010_v003").success);
  assert.ok(ItemRefSchema.safeParse({ id: "abc" }).success);
  assert.ok(ItemRefSchema.safeParse({ file: "C:\\r\\a.mov" }).success);
  assert.equal(ItemRefSchema.safeParse({ name: "x" }).success, false);

  for (const t of ["V1", "A2", "V12"]) assert.ok(TrackRefSchema.safeParse(t).success, t);
  for (const t of ["V0", "v1", "1", "A", "B1"]) assert.equal(TrackRefSchema.safeParse(t).success, false, t);

  assert.deepEqual([...API_HELP_TOPICS], ["transactions", "time", "bins", "import", "editing", "effects", "audio", "markers", "export", "gaps"]);

  const srv = createPremiereServer();
  const build = z.object(srv.tools["premiere-build-sequence"].schema);
  const parsed = build.parse({ sequence: "Edits/Main", mode: "append", clips: [{ item: { id: 7 }, in: { frames: 0 }, out: { timecode: "00:00:02:00" } }] });
  assert.equal(parsed.track, "V1");
  assert.equal(parsed.withAudio, true);
  assert.equal(build.safeParse({ sequence: "S", mode: "append", clips: [{ item: "x", in: { frames: 0.5 } }] }).success, false);
  const script = z.object(srv.tools["premiere-run-script-code"].schema);
  assert.equal(script.parse({ code: "return 1" }).waitSeconds, 30);
  assert.equal(script.safeParse({ code: "x", waitSeconds: 601 }).success, false);
});
