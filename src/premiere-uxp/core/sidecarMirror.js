"use strict";
// Read-only mirror of the panel's Pause flag and per-project folders for the CEP sidecar (spec section 8).
// The sidecar can't read the plugin's localStorage, so the panel writes pr_sidecar_state.json in the bridge
// folder on every poll and whenever its state changes. The sidecar only reads it and never writes settings.
// Only open, saved projects are listed, so folders for closed projects never leave the panel.
//
// File shape (version 1):
//   { "version": 1, "writer": "uxp", "ts": ISO, "paused": bool,
//     "projects": [{ "path": "D:\\Projects\\MyFilm\\edit\\Edit.prproj", "folder": "D:\\Projects\\MyFilm\\edit" | null }] }
// The heartbeat the sidecar writes back is prx_heartbeat.json: { pid?, ts: ISO, version }.
const { joinPath } = require("./util.js");

const MIRROR_FILE = "pr_sidecar_state.json";
const HEARTBEAT_FILE = "prx_heartbeat.json";
const HEARTBEAT_FRESH_MS = 6000;

// Pure: the mirror object for a registry snapshot, the settings and the pause flag.
function buildMirror({ projects, settings, paused, nowMs }) {
  const list = [];
  for (const e of projects || []) {
    if (!e || !e.path) continue;
    list.push({ path: e.path, folder: settings.folderFor(e.path).folder || null });
  }
  return { version: 1, writer: "uxp", ts: new Date(nowMs).toISOString(), paused: !!paused, projects: list };
}

// True when the sidecar heartbeat file exists and its ts is fresher than HEARTBEAT_FRESH_MS.
async function readSidecarAvailable(fsx, bridgeDir, nowMs) {
  try {
    const file = joinPath(bridgeDir, HEARTBEAT_FILE);
    if (!(await fsx.exists(file))) return false;
    const hb = JSON.parse(await fsx.readText(file));
    const ts = Date.parse(hb && hb.ts);
    if (isNaN(ts)) return false;
    const age = nowMs - ts;
    return age >= -HEARTBEAT_FRESH_MS && age < HEARTBEAT_FRESH_MS;
  } catch (e) {
    return false;
  }
}

// deps: { fsx, bridgeDir, settings, registry, state: { paused }, now, log }
function createSidecarMirror(deps) {
  const { fsx, bridgeDir, settings, registry, state, now } = deps;
  const log = deps.log || (() => {});
  const file = joinPath(bridgeDir, MIRROR_FILE);
  const tmp = joinPath(bridgeDir, "pr_sidecar_state.tmp");
  let lastError = null;
  let writing = null;

  async function writeOnce() {
    const mirror = buildMirror({ projects: registry.snapshot().projects, settings, paused: state.paused, nowMs: now() });
    const text = JSON.stringify(mirror, null, 2);
    try {
      // tmp -> remove old -> rename, as for result files; the sidecar never sees a half-written file.
      await fsx.writeText(tmp, text);
      try {
        if (await fsx.exists(file)) await fsx.remove(file);
        await fsx.rename(tmp, file);
      } catch (e) {
        await fsx.writeText(file, text);
        try { await fsx.remove(tmp); } catch (e2) { /* ignore */ }
      }
      lastError = null;
      return mirror;
    } catch (e) {
      const msg = "Sidecar state mirror write failed: " + e;
      if (msg !== lastError) log(msg);
      lastError = msg;
      return null;
    }
  }

  // Serialised: a state change during a poll's write queues one more write after it.
  function write() {
    const run = (writing || Promise.resolve()).then(writeOnce, writeOnce);
    writing = run.then(() => null, () => null);
    return run;
  }

  return { write, file };
}

module.exports = { createSidecarMirror, buildMirror, readSidecarAvailable, MIRROR_FILE, HEARTBEAT_FILE, HEARTBEAT_FRESH_MS };
