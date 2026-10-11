// The UXP panel's read-only state mirror for the CEP sidecar (pr_sidecar_state.json, spec section 8) and
// getState.sidecarAvailable (prx_heartbeat.json fresher than 6 s).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, require, fs, path } from "./premiere-core-fakes.mjs";

const { buildMirror, readSidecarAvailable, MIRROR_FILE } = require("../src/premiere-uxp/core/sidecarMirror.js");
const { createSettings } = require("../src/premiere-uxp/core/settings.js");
const { createFsx } = require("../src/premiere-uxp/core/fsx.js");
const Core = require("../src/premiere-cep/js/core.js");

function readMirrorFile(t) {
  return JSON.parse(fs.readFileSync(path.join(t.bridgeDir, MIRROR_FILE), "utf8"));
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

test("buildMirror: open saved projects only, own folder, default root, cleared folder", () => {
  const settings = createSettings(memStorage());
  settings.setFolder("D:\\Projects\\MyFilm\\edit\\Edit.prproj", "D:\\Projects\\MyFilm\\edit");
  settings.rememberRoot("D:\\Projects\\Shared");
  settings.clearFolder("D:\\Projects\\Shared\\Cleared.prproj");
  const m = buildMirror({
    projects: [
      { path: "D:\\Projects\\MyFilm\\edit\\Edit.prproj" },
      { path: "D:\\Projects\\Shared\\B.prproj" },
      { path: "D:\\Projects\\Shared\\Cleared.prproj" },
      { path: "" },
      { path: "E:\\Loose\\C.prproj" },
    ],
    settings,
    paused: true,
    nowMs: Date.parse("2026-10-07T12:00:00.000Z"),
  });
  assert.deepEqual(m, {
    version: 1, writer: "uxp", ts: "2026-10-07T12:00:00.000Z", paused: true,
    projects: [
      { path: "D:\\Projects\\MyFilm\\edit\\Edit.prproj", folder: "D:\\Projects\\MyFilm\\edit" },
      { path: "D:\\Projects\\Shared\\B.prproj", folder: "D:\\Projects\\Shared" },
      { path: "D:\\Projects\\Shared\\Cleared.prproj", folder: null },
      { path: "E:\\Loose\\C.prproj", folder: null },
    ],
  });
});

test("every poll writes the mirror atomically; the sidecar core reads it back", async () => {
  const t = setup({ label: "mirror" });
  await t.bridge.tick();
  const m = readMirrorFile(t);
  assert.equal(m.paused, false);
  assert.equal(m.ts, new Date(t.clock.now()).toISOString());
  assert.deepEqual(m.projects, [{ path: t.project.path, folder: t.edit }]);
  assert.equal(fs.existsSync(path.join(t.bridgeDir, "pr_sidecar_state.tmp")), false);
  t.clock.advance(500);
  await t.bridge.tick();
  assert.equal(readMirrorFile(t).ts, new Date(t.clock.now()).toISOString(), "rewritten on each poll");
  const read = Core.readMirror(fs, path.join(t.bridgeDir, MIRROR_FILE), t.clock.now());
  assert.deepEqual(Core.folderFor(read.mirror, "\\\\?\\" + t.project.path), { listed: true, folder: t.edit });
});

test("Pause, Clear and Browse rewrite the mirror immediately", async () => {
  const t = setup({ label: "mirror-ui" });
  await t.bridge.tick();
  t.bridge.setPaused(true);
  await t.bridge.mirror.write();
  assert.equal(readMirrorFile(t).paused, true);
  t.bridge.clearFolder();
  await t.bridge.mirror.write();
  assert.deepEqual(readMirrorFile(t).projects, [{ path: t.project.path, folder: null }]);
  t.bridge.chooseFolder(t.edit);
  await t.bridge.mirror.write();
  assert.deepEqual(readMirrorFile(t).projects, [{ path: t.project.path, folder: t.edit }]);
});

test("closed projects drop out of the mirror", async () => {
  const t = setup({ label: "mirror-close" });
  const second = t.fake.openProject(path.join(t.root, "second", "Second.prproj"), { active: false });
  await t.bridge.tick();
  assert.equal(readMirrorFile(t).projects.length, 2);
  await second.close();
  await t.bridge.tick();
  assert.deepEqual(readMirrorFile(t).projects.map((p) => p.path), [t.project.path]);
});

test("getState.sidecarAvailable follows prx_heartbeat.json (fresher than 6 s)", async () => {
  const t = setup({ label: "hb" });
  let r = await t.send("getState", {}, { expectedProject: undefined });
  assert.equal(r.sidecarAvailable, false, "no heartbeat");
  const hb = path.join(t.bridgeDir, "prx_heartbeat.json");
  fs.writeFileSync(hb, JSON.stringify({ pid: 7, ts: new Date(t.clock.now() - 2000).toISOString(), version: "1.0.0" }));
  r = await t.send("getState", {}, { expectedProject: undefined });
  assert.equal(r.sidecarAvailable, true);
  t.clock.advance(4500);
  r = await t.send("getState", {}, { expectedProject: undefined });
  assert.equal(r.sidecarAvailable, false, "6.5 s old");
  const fsx = createFsx(fs.promises);
  fs.writeFileSync(hb, "not json");
  assert.equal(await readSidecarAvailable(fsx, t.bridgeDir, t.clock.now()), false);
});

test("a mirror write failure is logged once and never breaks polling", async () => {
  const t = setup({ label: "mirror-fail" });
  fs.mkdirSync(path.join(t.bridgeDir, "pr_sidecar_state.tmp"));
  await t.bridge.tick();
  await t.bridge.tick();
  assert.equal(t.logs.filter((l) => l.startsWith("Sidecar state mirror write failed")).length, 1);
  const r = await t.send("getState", {}, { expectedProject: undefined });
  assert.equal(r.status, "success");
});
