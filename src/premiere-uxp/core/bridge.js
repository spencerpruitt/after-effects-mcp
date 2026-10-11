"use strict";
// The Premiere panel core: polls pr_command.json, gates, dispatches and writes pr_mcp_result.json.
// Pure apart from injected dependencies, so tests drive it with fakes:
//   fs        UXP require('fs') (promise form) or Node fs.promises
//   ppro      require('premierepro')
//   storage   localStorage-like { getItem, setItem, removeItem, key, length }
//   clock     { now(), setInterval, clearInterval, setTimeout, clearTimeout }
//   commands  array of command modules { name, mutating, targetless, precheck?(ctx, args), run(ctx, args) }
// See docs/bridge-protocol.md and docs/premiere-bridge-spec.md sections 4-6.
const { normalize, isInside } = require("../lib/pathPolicy.js");
const { refusal, errorResult, mcpError, samePath, joinPath, cleanString, projectPathOf } = require("./util.js");
const { createFsx } = require("./fsx.js");
const { createSettings } = require("./settings.js");
const { createRegistry } = require("./registry.js");
const { saveAndBackup } = require("./backup.js");
const { createGuardedFs } = require("./guards.js");
const { runTransaction } = require("./transaction.js");
const { runScriptCommand } = require("./scriptRunner.js");
const { getState } = require("./state.js");
const { isE2eCommand, gateE2e, runE2e } = require("./e2e.js");
const { createSidecarMirror, readSidecarAvailable } = require("./sidecarMirror.js");

const POLL_MS = 500;
const STALE_AFTER_MS = 120000;
const EXEMPT = new Set(["getState", "getApiHelp"]);
const SCRIPT_COMMANDS = new Set(["runScript", "runScriptFile"]);

function defaultLoadTime() {
  return require("../lib/time.js");
}

function displayName(p) {
  if (!p) return "an untitled project";
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

function createBridge(deps) {
  const {
    fs, ppro, storage, bridgeDir, tempDir, uxp, os, hostVersion,
  } = deps;
  const clock = deps.clock || {
    now: () => Date.now(),
    setInterval: (f, ms) => setInterval(f, ms),
    clearInterval: (h) => clearInterval(h),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h),
  };
  const now = () => clock.now();
  const log = deps.log || (() => {});
  const loadTime = deps.loadTime || defaultLoadTime;
  const fsx = createFsx(fs);
  const settings = createSettings(storage);
  const registry = createRegistry({ ppro, log });
  const commandMap = new Map();
  for (const m of deps.commands || []) {
    if (m && typeof m.name === "string" && typeof m.run === "function") commandMap.set(m.name, m);
  }

  const paths = {
    command: joinPath(bridgeDir, "pr_command.json"),
    result: joinPath(bridgeDir, "pr_mcp_result.json"),
    tmp: joinPath(bridgeDir, "pr_mcp_result.tmp"),
  };

  const state = {
    paused: false,
    harness: false, // never persisted: unticked at every launch
    lastProcessedId: null,
    busy: false,
    lastTargetPath: null,
    lastCheckError: null,
    interval: null,
  };

  // Read-only mirror of Pause and the open projects' folders for the CEP sidecar (spec section 8).
  const mirror = createSidecarMirror({ fsx, bridgeDir, settings, registry, state, now, log });
  function writeMirror() {
    mirror.write().catch(() => {});
  }

  // --- result and command files ---

  async function writeResult(resultObj, command, commandId, startPath, endPath) {
    resultObj._commandId = commandId;
    resultObj._commandExecuted = command;
    resultObj._responseTimestamp = new Date(now()).toISOString();
    resultObj._project = endPath || "";
    resultObj._projectChanged = resultObj.status !== "error" && resultObj.status !== "running" &&
      !samePath(startPath, endPath);
    const text = JSON.stringify(resultObj, null, 2);
    // tmp -> remove old -> rename, as in the AE panel.
    await fsx.writeText(paths.tmp, text);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (await fsx.exists(paths.result)) await fsx.remove(paths.result);
        await fsx.rename(paths.tmp, paths.result);
        return;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    // Last resort: write in place so a result always exists.
    await fsx.writeText(paths.result, text);
    try { await fsx.remove(paths.tmp); } catch (e) { /* ignore */ }
    log("Warning: atomic rename failed, wrote result in place.");
  }

  // Rewrites the command file's status only while it still holds the command being processed.
  async function updateCommandStatus(status, commandId) {
    try {
      if (!(await fsx.exists(paths.command))) return;
      const content = await fsx.readText(paths.command);
      if (!content) return;
      const data = JSON.parse(content);
      if (String(data.id || data.timestamp || "") !== commandId) return;
      data.status = status;
      await fsx.writeText(paths.command, JSON.stringify(data, null, 2));
    } catch (e) {
      log("Error updating command status: " + e);
    }
  }

  // --- gate ---

  // Returns { refused } or { target: registry entry | null, startPath }.
  function gate(cmd) {
    const command = cmd.command;
    const active = registry.snapshot().projects.find((e) => e.isActive);
    if (EXEMPT.has(command)) return { target: null, startPath: active ? active.path : "" };
    if (state.paused) {
      return { refused: refusal("PAUSED", "Paused: the user has paused Claude in the MCP Bridge panel in Premiere. Ask the user to untick Pause, then retry.") };
    }
    if (isE2eCommand(command)) {
      const r = gateE2e(command, cmd.args || {}, { harness: state.harness, tempDir });
      return r ? { refused: r } : { target: null, startPath: "" };
    }
    const mod = commandMap.get(command);
    if (mod && mod.targetless) return { target: null, startPath: "" };
    const expected = cmd.expectedProject;
    if (expected === undefined || expected === null) {
      return { refused: refusal("PROJECT_NOT_CONFIRMED", "No project confirmed yet. Call premiere-get-state to see which projects are open in Premiere, then retry with a project path.") };
    }
    if (expected === "") {
      return { refused: refusal("PROJECT_UNSAVED", "An untitled project can't be targeted. Ask the user to save it, then call premiere-get-state.") };
    }
    const entry = registry.find(expected);
    if (!entry) {
      return {
        refused: refusal("PROJECT_NOT_OPEN",
          displayName(expected) + " is not open in Premiere. Ask the user to open it, or call premiere-get-state and target an open project.",
          { expectedProject: expected, openProjects: registry.openPaths() }),
      };
    }
    return { target: entry, startPath: entry.path };
  }

  // --- typed command modules ---

  function buildCtx(mod, project, run) {
    const counters = run.counters;
    const ctx = {
      ppro,
      project,
      projectPath: project ? projectPathOf(project) : null,
      folder: project ? settings.folderFor(projectPathOf(project)).folder : null,
      fail: (code, message, extra) => mcpError(code, message, extra),
      assertWritable(absPath) {
        if (!ctx.folder) throw mcpError("NO_FOLDER", "No writable folder is set for this project. Ask the user to choose one with Browse... in the MCP Bridge panel.");
        if (!isInside(absPath, ctx.folder)) {
          throw mcpError("OUTSIDE_FOLDER", "Path is outside the writable folder (" + ctx.folder + "): " + String(absPath));
        }
        return absPath;
      },
      isDefaultRoot: (absPath) => settings.isDefaultRoot(absPath),
      // Read-only existence check (reads may go anywhere).
      pathExists: (absPath) => fsx.exists(absPath),
      // Open projects from the registry, refreshed: [{ path, name, guid, isActive, project }].
      async openProjects() {
        await registry.refresh();
        return registry.snapshot().projects;
      },
      setTargetProject(p) {
        const prevPath = ctx.projectPath;
        const prevFolder = ctx.folder;
        registry.remember(p);
        const newPath = projectPathOf(p);
        if (prevFolder && newPath && !samePath(prevPath, newPath)) settings.inheritFolder(newPath, prevFolder);
        ctx.project = p;
        ctx.projectPath = newPath;
        ctx.folder = newPath ? settings.folderFor(newPath).folder : null;
        if (newPath) state.lastTargetPath = newPath;
        run.endPath = newPath;
        return newPath;
      },
      transaction(undoName, fn) {
        if (!ctx.project) throw mcpError("PROJECT_NOT_OPEN", "No target project for a transaction.");
        return runTransaction(ctx.project, undoName || mod.name, fn, counters).value;
      },
      // An undo step Premiere adds outside our transactions (importFiles, sequence creation, ...).
      noteUndoStep() {
        counters.undoSteps++;
      },
      log: (msg) => log("[" + mod.name + "] " + cleanString(msg)),
      fs: createGuardedFs(fs, () => ctx.folder),
    };
    Object.defineProperty(ctx, "time", { enumerable: true, get: () => loadTime() });
    return ctx;
  }

  async function runModule(mod, entry, args, run) {
    const project = entry ? entry.project : null;
    run.counters = { undoSteps: 0 };
    const ctx = buildCtx(mod, project, run);
    // precheck(ctx, args): optional, read-only. A refusal known before any change (e.g. NEEDS_SIDECAR_UNAVAILABLE)
    // is thrown here, so it never costs a save and a backup.
    if (typeof mod.precheck === "function") {
      try {
        await mod.precheck(ctx, args);
      } catch (e) {
        const r = errorResult(e);
        if (mod.mutating) r.undoSteps = 0;
        return r;
      }
    }
    let backup = null;
    if (mod.mutating && project) {
      const { folder } = settings.folderFor(projectPathOf(project));
      if (!folder) return refusal("NO_FOLDER", "No writable folder is set for this project, so no backup can be taken. Ask the user to choose one with Browse... in the MCP Bridge panel.");
      if (!(await fsx.isDir(folder))) return refusal("FOLDER_MISSING", "The writable folder no longer exists: " + folder + ". Ask the user to choose it again in the MCP Bridge panel.");
      try {
        backup = await saveAndBackup({ project, folder, fsx, now, log });
      } catch (e) {
        return errorResult(e);
      }
    }
    let result;
    try {
      const out = await mod.run(ctx, args);
      result = Object.assign({ status: "success" }, out && typeof out === "object" ? out : { result: out });
    } catch (e) {
      result = errorResult(e);
    }
    if (ctx.project && run.endPath === undefined) run.endPath = projectPathOf(ctx.project);
    if (mod.mutating) {
      result.undoSteps = run.counters.undoSteps;
      if (backup) {
        result.backupPath = backup.backupPath;
        if (backup.backupWarning) result.backupWarning = backup.backupWarning;
      }
    }
    return result;
  }

  // --- dispatch ---

  async function execute(cmd) {
    const command = cmd.command;
    const args = cmd.args || {};
    const commandId = String(cmd.id || cmd.timestamp || "");
    const run = { startPath: "", endPath: undefined, counters: { undoSteps: 0 } };
    let result;
    log("Command: " + command);
    try {
      const written = Date.parse(cmd.timestamp);
      const ageMs = isNaN(written) ? 0 : now() - written;
      let g;
      if (ageMs > STALE_AFTER_MS) {
        g = {
          refused: refusal("STALE", "This command was written " + Math.round(ageMs / 1000) + " s ago, so it was not run (commands older than " +
            STALE_AFTER_MS / 1000 + " s are dropped). Check the project state, then send it again if it is still wanted."),
        };
      } else {
        g = gate(cmd);
      }
      if (g.refused) {
        result = g.refused;
        const t = cmd.expectedProject ? registry.find(cmd.expectedProject) : null;
        run.startPath = t ? t.path : "";
        log("Refused " + command + " (" + result.code + ")");
      } else {
        run.startPath = g.startPath;
        const entry = g.target;
        if (entry) state.lastTargetPath = entry.path;
        if (command === "getState") {
          result = await getState({ registry, settings, fsx, ppro, state, hostVersion }, cmd.expectedProject);
          result.sidecarAvailable = await readSidecarAvailable(fsx, bridgeDir, now());
        } else if (SCRIPT_COMMANDS.has(command)) {
          await writeResult({ status: "running", message: "Script is running in Premiere." }, command, commandId, run.startPath, run.startPath);
          const project = entry.project;
          result = await runScriptCommand({
            fsx, rawFs: fs, ppro, uxp, os, project, folder: settings.folderFor(projectPathOf(project)).folder,
            settings, registry, now, clock, log, loadTime,
          }, command, args);
          run.endPath = projectPathOf(project);
          if (run.endPath && !samePath(run.endPath, entry.path)) state.lastTargetPath = run.endPath;
        } else if (isE2eCommand(command)) {
          result = await runE2e({ ppro, settings, registry, tempDir }, command, args);
        } else if (commandMap.has(command)) {
          result = await runModule(commandMap.get(command), entry, args, run);
        } else {
          result = { status: "error", code: "UNKNOWN_COMMAND", message: "Unknown command: " + command };
        }
      }
    } catch (e) {
      log("ERROR in " + command + ": " + e);
      result = errorResult(e);
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) result = { status: "success", result };
    const endPath = run.endPath === undefined ? run.startPath : run.endPath;
    let failed = result.status === "error";
    // Mark the command done BEFORE writing the result. The server writes its next command as soon as it
    // sees this result, so a status update after the result could overwrite that new command (the
    // id check is a read-then-write, not atomic). The server waits on the result file, not the status.
    await updateCommandStatus(failed ? "error" : "completed", commandId);
    try {
      await writeResult(result, command, commandId, run.startPath, endPath);
    } catch (e) {
      log("CRITICAL: failed to write result file: " + e);
      if (!failed) await updateCommandStatus("error", commandId);
      failed = true;
    }
    log((failed ? "Error: " : "Done: ") + command + (failed && result.message ? " - " + result.message : ""));
    return result;
  }

  // --- polling ---

  async function tick() {
    if (state.busy) return false;
    state.busy = true;
    let ran = false;
    try {
      try { await registry.refresh(); } catch (e) { log("Project refresh failed: " + e); }
      await mirror.write();
      if (deps.onTick) { try { deps.onTick(); } catch (e) { /* cosmetic */ } }
      if (await fsx.exists(paths.command)) {
        const content = await fsx.readText(paths.command);
        if (content) {
          const data = JSON.parse(content);
          const commandId = String(data.id || data.timestamp || "");
          if (data.status === "pending" && commandId !== state.lastProcessedId) {
            state.lastProcessedId = commandId;
            await updateCommandStatus("running", commandId);
            await execute(data);
            ran = true;
          }
        }
      }
      state.lastCheckError = null;
    } catch (e) {
      const msg = String(e);
      if (msg !== state.lastCheckError) log("Error checking for commands: " + msg);
      state.lastCheckError = msg;
    } finally {
      state.busy = false;
    }
    if (ran && deps.onTick) { try { deps.onTick(); } catch (e) { /* cosmetic */ } }
    return ran;
  }

  function start() {
    stop();
    state.interval = clock.setInterval(() => { tick(); }, POLL_MS);
  }

  function stop() {
    if (state.interval !== null) {
      clock.clearInterval(state.interval);
      state.interval = null;
    }
  }

  // --- panel UI ---

  // The project the panel shows: the last target if still open, else the active project.
  function uiProject() {
    const snap = registry.snapshot();
    const last = state.lastTargetPath ? registry.find(state.lastTargetPath) : null;
    return last || snap.projects.find((e) => e.isActive) || null;
  }

  function uiState() {
    const e = uiProject();
    const p = e ? e.path : "";
    const info = p ? settings.folderFor(p) : { folder: null, isDefault: false };
    return {
      projectPath: p,
      projectName: e ? e.name : "",
      folder: info.folder,
      isDefault: info.isDefault,
      openCount: registry.snapshot().projects.length,
      paused: state.paused,
      harness: state.harness,
      canBrowse: !!p,
      canClear: !!info.folder,
      canForget: !!(p && info.isDefault),
    };
  }

  function chooseFolder(folder) {
    const e = uiProject();
    if (!e || !e.path || normalize(folder) === null) return false;
    settings.setFolder(e.path, folder);
    settings.rememberRoot(folder);
    log("Writable folder set: " + folder + " (also the default for projects saved inside it)");
    writeMirror();
    return true;
  }

  function clearFolder() {
    const e = uiProject();
    if (!e || !e.path) return false;
    settings.clearFolder(e.path);
    log("Writable folder cleared for " + e.name);
    writeMirror();
    return true;
  }

  function forgetDefault() {
    const e = uiProject();
    if (!e || !e.path || settings.hasOwn(e.path)) return false;
    const root = settings.defaultRootFor(e.path);
    if (!root) return false;
    settings.forgetRoot(root);
    log("No longer a default folder: " + root);
    writeMirror();
    return true;
  }

  function setPaused(v) {
    state.paused = !!v;
    log(state.paused ? "Paused: Claude's commands will be refused." : "Resumed: Claude's commands are accepted.");
    writeMirror();
  }

  function setHarness(v) {
    state.harness = !!v;
    log(state.harness ? "Test harness allowed (until the panel reloads)." : "Test harness disabled.");
  }

  return {
    tick, start, stop, execute, gate, writeResult, updateCommandStatus,
    uiState, chooseFolder, clearFolder, forgetDefault, setPaused, setHarness,
    settings, registry, state, paths, mirror,
  };
}

module.exports = { createBridge, POLL_MS, STALE_AFTER_MS };
