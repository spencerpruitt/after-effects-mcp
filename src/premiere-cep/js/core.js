/* MCP Bridge sidecar core (docs/premiere-bridge-spec.md section 8, docs/bridge-protocol.md "Premiere").
 *
 * Runs in the CEP panel (Chromium + Node, --enable-nodejs --mixed-context) and in the Node unit tests
 * (test/premiere-sidecar-core.test.mjs). Pure apart from injected dependencies:
 *   fs        Node's fs (sync API)
 *   evalHost  (name, args) => Promise<object>: runs __mcpSidecar_call(name, args) in host/host.jsx
 *   clock     { now(), setInterval, clearInterval }
 *
 * Protocol, same as the UXP panel (src/premiere-uxp/core/bridge.js):
 *   - polls prx_command.json every 500 ms; runs it when status === "pending" and id !== lastProcessedId
 *   - STALE after 120 s; then the gate; the command file's status is only rewritten while it holds our id
 *   - result written atomically: prx_mcp_result.tmp -> remove old -> rename, stamped with _commandId,
 *     _commandExecuted, _responseTimestamp, _project, _projectChanged
 * Gate: state mirror readable and fresh (the UXP panel writes pr_sidecar_state.json; the sidecar never writes
 * settings), PAUSED, PROJECT_NOT_CONFIRMED / PROJECT_UNSAVED, then the target resolved by path among
 * app.projects (PROJECT_NOT_OPEN). Mutating operations then need the project's folder (NO_FOLDER /
 * FOLDER_MISSING), save the project and take a rolling backup into <folder>/mcp-scripts/backups (keep 10).
 * Heartbeat: prx_heartbeat.json { pid, ts, version } every 2 s.
 */
(function (root, factory) {
  var api = factory();
  // Set both: under CEP's --mixed-context the panel page also has Node's `module`, and main.js reads
  // window.MCPSidecarCore. Exporting only to module.exports there left the sidecar silently dead.
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.MCPSidecarCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var POLL_MS = 500;
  var HEARTBEAT_MS = 2000;
  var STALE_AFTER_MS = 120000;
  var MIRROR_FRESH_MS = 10000;
  var BACKUPS_TO_KEEP = 10;
  var FILES = {
    command: "prx_command.json",
    result: "prx_mcp_result.json",
    tmp: "prx_mcp_result.tmp",
    heartbeat: "prx_heartbeat.json",
    heartbeatTmp: "prx_heartbeat.tmp",
    mirror: "pr_sidecar_state.json",
  };
  // Operations the sidecar runs. All of them edit the timeline, so all are mutating.
  var OPERATIONS = ["setSpeed", "addAudioTransition", "link", "unlink"];
  var EXEMPT = ["ping"];

  // ---------------------------------------------------------------------------------------------
  // Paths (same rules as src/premiere-uxp/lib/pathPolicy.js, plus the \\?\ prefix Premiere 26.5 reports).

  function stripLongPathPrefix(p) {
    var s = p === null || p === undefined ? "" : String(p);
    if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s)) return "\\\\" + s.substring(8);
    if (/^[\\/]{2}[?.][\\/]/.test(s)) return s.substring(4);
    return s;
  }

  function normalize(p) {
    if (p === null || p === undefined) return null;
    var s = stripLongPathPrefix(p).replace(/\\/g, "/");
    if (s.length === 0) return null;
    var prefix, rest;
    var m = /^([a-zA-Z]):(\/.*)?$/.exec(s);
    if (m) {
      prefix = m[1].toLowerCase() + ":";
      rest = m[2] || "/";
    } else if (/^\/\/[^/]+\/[^/]+/.test(s)) {
      var parts = s.substring(2).split("/");
      prefix = "//" + parts[0].toLowerCase() + "/" + parts[1].toLowerCase();
      rest = "/" + parts.slice(2).join("/");
    } else if (/^\/[a-zA-Z](\/|$)/.test(s)) {
      prefix = s.charAt(1).toLowerCase() + ":";
      rest = s.substring(2) || "/";
    } else {
      return null;
    }
    var out = [];
    var segs = rest.split("/");
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0) return null;
        out.pop();
        continue;
      }
      out.push(seg.toLowerCase());
    }
    return prefix + "/" + out.join("/");
  }

  function samePath(a, b) {
    var na = normalize(a);
    return na !== null && na === normalize(b);
  }

  function joinPath(folder, rel) {
    return String(folder).replace(/[\\/]+$/, "") + "\\" + String(rel).replace(/^[\\/]+/, "").replace(/\//g, "\\");
  }

  function baseName(p) {
    return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  }

  function displayName(p) {
    return p ? baseName(p) : "an untitled project";
  }

  // ---------------------------------------------------------------------------------------------
  // Small pure helpers.

  function refusal(code, message, extra) {
    var r = { status: "error", refused: true, code: code, message: message };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }

  // Age of a command in ms, or 0 when its timestamp can't be parsed (never treated as stale).
  function commandAgeMs(timestamp, nowMs) {
    var written = Date.parse(timestamp);
    return isNaN(written) ? 0 : nowMs - written;
  }

  function isStale(timestamp, nowMs) {
    return commandAgeMs(timestamp, nowMs) > STALE_AFTER_MS;
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = "0" + s;
    return s;
  }

  // <yyyymmdd-hhmmss-mmm>, local time, as the AE and UXP panels.
  function archiveStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + "-" +
      pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2) + "-" + pad(d.getMilliseconds(), 3);
  }

  // JSON for an ExtendScript source string: escapes everything outside printable ASCII, including U+2028/9,
  // which end an ES3 string literal.
  function toEs3Json(value) {
    return JSON.stringify(value === undefined ? null : value).replace(/[\u007f-\uffff]/g, function (c) {
      return "\\u" + pad(c.charCodeAt(0).toString(16), 4);
    });
  }

  // The script CSInterface.evalScript runs: a call with literal arguments (JSON is valid ES3 source), so the
  // host never needs JSON.parse.
  function buildEvalCall(name, args) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) throw new Error("Bad host function name: " + name);
    return "__mcpSidecar_call(" + toEs3Json(String(name)) + "," + toEs3Json(args || {}) + ")";
  }

  // evalScript's answer -> result object. CEP returns "EvalScript error." when the script threw or the
  // host function is missing (host.jsx not loaded).
  function parseHostResult(text) {
    if (text === undefined || text === null || text === "" || text === "undefined") {
      return { status: "error", code: "HOST_ERROR", message: "The ExtendScript host returned nothing (host.jsx not loaded?)." };
    }
    if (/^EvalScript error/i.test(String(text))) {
      return { status: "error", code: "HOST_ERROR", message: "ExtendScript failed: " + String(text) + " (a QE call may have aborted the script)." };
    }
    try {
      var parsed = JSON.parse(String(text));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return { status: "error", code: "HOST_ERROR", message: "Unexpected host result: " + String(text).slice(0, 200) };
    } catch (e) {
      return { status: "error", code: "HOST_ERROR", message: "Unparseable host result: " + String(text).slice(0, 200) };
    }
  }

  // Cheap argument checks before any save or backup (the host re-validates everything).
  function validateArgs(command, a) {
    a = a || {};
    var track = /^\s*[VvAa]\s*[1-9][0-9]*\s*$/;
    function isIndex(v) { return typeof v === "number" && Math.floor(v) === v && v >= 0; }
    if (a.sequence === undefined || a.sequence === null || a.sequence === "") return "sequence is required";
    if (command === "link" || command === "unlink") {
      if (!Array.isArray(a.items) || a.items.length < 1) return "items must be a non-empty array of { track, index }";
      for (var i = 0; i < a.items.length; i++) {
        var it = a.items[i] || {};
        if (typeof it.track !== "string" || !track.test(it.track)) return "items[" + i + "].track must look like \"V1\" or \"A2\"";
        if (!isIndex(it.index)) return "items[" + i + "].index must be a 0-based integer";
      }
      return null;
    }
    if (typeof a.track !== "string" || !track.test(a.track)) return "track must look like \"V1\" or \"A2\"";
    if (!isIndex(a.index)) return "index must be a 0-based integer";
    if (command === "setSpeed") {
      if (typeof a.percent !== "number" || !isFinite(a.percent) || a.percent <= 0 || a.percent > 10000) return "percent must be a number > 0 and <= 10000";
    }
    if (command === "addAudioTransition") {
      if (!/^\s*[Aa]/.test(a.track)) return "addAudioTransition needs an audio track (A1, A2...)";
      if (["start", "end", "both"].indexOf(a.edge) < 0) return "edge must be \"start\", \"end\" or \"both\"";
      if (typeof a.durationFrames !== "number" || Math.floor(a.durationFrames) !== a.durationFrames || a.durationFrames < 1) return "durationFrames must be a positive integer";
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Files.

  function exists(fs, p) {
    try {
      fs.statSync(p);
      return true;
    } catch (e) {
      return false;
    }
  }

  function isDir(fs, p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch (e) {
      return false;
    }
  }

  // tmp -> remove old -> rename (retried), as the AE and UXP panels; falls back to writing in place so a
  // result always exists. Returns "atomic" or "in-place".
  function atomicWrite(fs, file, tmp, text) {
    fs.writeFileSync(tmp, text, "utf8");
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        if (exists(fs, file)) fs.unlinkSync(file);
        fs.renameSync(tmp, file);
        return "atomic";
      } catch (e) {
        /* the reader may hold the file; retry */
      }
    }
    fs.writeFileSync(file, text, "utf8");
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return "in-place";
  }

  // The UXP panel's mirror. Returns { mirror } or { refusal } (missing, unreadable or older than 10 s).
  function readMirror(fs, file, nowMs) {
    var why = null;
    var mirror = null;
    try {
      mirror = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      why = exists(fs, file) ? "unreadable" : "missing";
    }
    if (!why) {
      var ts = mirror && Date.parse(mirror.ts);
      if (!mirror || typeof mirror !== "object" || !Array.isArray(mirror.projects) || isNaN(ts)) why = "unreadable";
      else if (nowMs - ts > MIRROR_FRESH_MS) why = "stale (" + Math.round((nowMs - ts) / 1000) + " s old)";
    }
    if (why) {
      return {
        refusal: refusal("SIDECAR_STATE_STALE",
          "The MCP Bridge panel's state mirror (" + FILES.mirror + ") is " + why + ", so the sidecar can't see Pause or the folder. " +
          "Ask the user to open the MCP Bridge panel in Premiere (Window > UXP Plugins > MCP Bridge), then retry."),
      };
    }
    return { mirror: mirror };
  }

  // Folder for a project from the mirror: { listed, folder }.
  function folderFor(mirror, projectPath) {
    var list = (mirror && mirror.projects) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && samePath(list[i].path, projectPath)) {
        return { listed: true, folder: list[i].folder ? String(list[i].folder) : null };
      }
    }
    return { listed: false, folder: null };
  }

  // Copy the saved .prproj to <folder>/mcp-scripts/backups/<stamp>_<base>.prproj; keep the newest 10 per base.
  function backupProject(fs, folder, projectPath, date) {
    var base = baseName(projectPath).replace(/\.prproj$/i, "");
    var dir = joinPath(joinPath(folder, "mcp-scripts"), "backups");
    fs.mkdirSync(dir, { recursive: true });
    var dest = joinPath(dir, archiveStamp(date) + "_" + base + ".prproj");
    fs.copyFileSync(stripLongPathPrefix(projectPath), dest);
    pruneBackups(fs, dir, base);
    return dest;
  }

  function pruneBackups(fs, dir, base) {
    var suffix = ("_" + base + ".prproj").toLowerCase();
    var mine = fs.readdirSync(dir).filter(function (n) {
      return /^\d{8}-\d{6}-\d{3}_/.test(n) && n.substring(19).toLowerCase() === suffix;
    }).sort().reverse();
    for (var i = BACKUPS_TO_KEEP; i < mine.length; i++) {
      try { fs.unlinkSync(joinPath(dir, mine[i])); } catch (e) { /* best effort */ }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The sidecar.

  function createSidecar(deps) {
    var fs = deps.fs;
    var evalHost = deps.evalHost;
    var clock = deps.clock || {
      now: function () { return Date.now(); },
      setInterval: function (f, ms) { return setInterval(f, ms); },
      clearInterval: function (h) { clearInterval(h); },
    };
    var now = function () { return clock.now(); };
    var log = deps.log || function () {};
    var version = deps.version || "0.0.0";
    var paths = {};
    for (var k in FILES) paths[k] = joinPath(deps.bridgeDir, FILES[k]);

    var state = { lastProcessedId: null, busy: false, poll: null, beat: null, lastCheckError: null, lastHeartbeatError: null };

    function writeResult(result, command, commandId, projectPath) {
      result._commandId = commandId;
      result._commandExecuted = command;
      result._responseTimestamp = new Date(now()).toISOString();
      result._project = projectPath || "";
      // The sidecar never moves a project (no save-as).
      result._projectChanged = false;
      var how = atomicWrite(fs, paths.result, paths.tmp, JSON.stringify(result, null, 2));
      if (how !== "atomic") log("Warning: atomic rename failed, wrote result in place.");
    }

    function updateCommandStatus(status, commandId) {
      try {
        if (!exists(fs, paths.command)) return;
        var data = JSON.parse(fs.readFileSync(paths.command, "utf8"));
        if (String(data.id || data.timestamp || "") !== commandId) return;
        data.status = status;
        fs.writeFileSync(paths.command, JSON.stringify(data, null, 2), "utf8");
      } catch (e) {
        log("Error updating command status: " + e);
      }
    }

    // Returns { refused } or { target: { path, name }, mirror }.
    async function gate(cmd) {
      var m = readMirror(fs, paths.mirror, now());
      if (m.refusal) return { refused: m.refusal };
      if (m.mirror.paused) {
        return { refused: refusal("PAUSED", "Paused: the user has paused Claude in the MCP Bridge panel in Premiere. Ask the user to untick Pause, then retry.") };
      }
      var expected = cmd.expectedProject;
      if (expected === undefined || expected === null) {
        return { refused: refusal("PROJECT_NOT_CONFIRMED", "No project confirmed yet. Call premiere-get-state to see which projects are open in Premiere, then retry with a project path.") };
      }
      if (expected === "") {
        return { refused: refusal("PROJECT_UNSAVED", "An untitled project can't be targeted. Ask the user to save it, then call premiere-get-state.") };
      }
      var listed = await evalHost("listProjects", {});
      if (!listed || listed.status !== "success" || !Array.isArray(listed.projects)) {
        return { refused: { status: "error", code: (listed && listed.code) || "HOST_ERROR", message: "Could not list open projects: " + ((listed && listed.message) || "no answer") } };
      }
      var open = listed.projects.map(function (p) { return { path: stripLongPathPrefix(p.path), name: p.name }; });
      for (var i = 0; i < open.length; i++) {
        if (samePath(open[i].path, expected)) return { target: open[i], mirror: m.mirror };
      }
      return {
        refused: refusal("PROJECT_NOT_OPEN",
          displayName(expected) + " is not open in Premiere. Ask the user to open it, or call premiere-get-state and target an open project.",
          { expectedProject: expected, openProjects: open.map(function (p) { return p.path; }).filter(Boolean) }),
      };
    }

    async function runOperation(command, args, target, mirror) {
      var bad = validateArgs(command, args);
      if (bad) return { status: "error", code: "BAD_ARGS", message: bad, undoSteps: 0 };
      var f = folderFor(mirror, target.path).folder;
      if (!f) return refusal("NO_FOLDER", "No writable folder is set for this project, so no backup can be taken. Ask the user to choose one with Browse... in the MCP Bridge panel.");
      if (!isDir(fs, f)) return refusal("FOLDER_MISSING", "The writable folder no longer exists: " + f + ". Ask the user to choose it again in the MCP Bridge panel.");
      var saved = await evalHost("saveProject", { projectPath: target.path });
      if (!saved || saved.status !== "success") {
        return { status: "error", code: (saved && saved.code) || "SAVE_FAILED", message: (saved && saved.message) || "Save before run failed, nothing was run.", undoSteps: 0 };
      }
      var backupPath = null;
      var backupWarning;
      try {
        backupPath = backupProject(fs, f, target.path, new Date(now()));
      } catch (e) {
        backupWarning = "Backup failed: " + (e && e.message ? e.message : e);
        log(backupWarning);
      }
      var hostArgs = {};
      for (var key in args) if (Object.prototype.hasOwnProperty.call(args, key)) hostArgs[key] = args[key];
      hostArgs.projectPath = target.path;
      var result = await evalHost(command, hostArgs);
      if (!result || typeof result !== "object") result = { status: "error", code: "HOST_ERROR", message: "No result from the host." };
      if (typeof result.undoSteps !== "number") result.undoSteps = result.status === "success" ? 1 : 0;
      result.backupPath = backupPath;
      if (backupWarning) result.backupWarning = backupWarning;
      return result;
    }

    async function execute(cmd) {
      var command = cmd.command;
      var args = cmd.args || {};
      var commandId = String(cmd.id || cmd.timestamp || "");
      var projectPath = "";
      var result;
      log("Command: " + command);
      try {
        var age = commandAgeMs(cmd.timestamp, now());
        if (age > STALE_AFTER_MS) {
          result = refusal("STALE", "This command was written " + Math.round(age / 1000) + " s ago, so it was not run (commands older than " +
            STALE_AFTER_MS / 1000 + " s are dropped). Check the project state, then send it again if it is still wanted.");
        } else if (EXEMPT.indexOf(command) >= 0) {
          result = { status: "success", version: version, pid: deps.pid === undefined ? null : deps.pid, operations: OPERATIONS.slice() };
        } else {
          var g = await gate(cmd);
          if (g.refused) {
            result = g.refused;
          } else {
            projectPath = g.target.path;
            if (OPERATIONS.indexOf(command) < 0) {
              result = { status: "error", code: "UNKNOWN_COMMAND", message: "Unknown sidecar command: " + command + ". The sidecar runs only " + OPERATIONS.join(", ") + "." };
            } else {
              result = await runOperation(command, args, g.target, g.mirror);
            }
          }
        }
      } catch (e) {
        log("ERROR in " + command + ": " + e);
        result = { status: "error", message: String(e && e.message ? e.message : e) };
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) result = { status: "success", result: result };
      var failed = result.status === "error";
      if (result.refused) log("Refused " + command + " (" + result.code + ")");
      // Status first, result second: the server writes its next command as soon as it sees the result,
      // and the id-checked status update is read-then-write, so it must never run after the result.
      updateCommandStatus(failed ? "error" : "completed", commandId);
      try {
        writeResult(result, command, commandId, projectPath);
      } catch (e) {
        log("CRITICAL: failed to write result file: " + e);
        if (!failed) updateCommandStatus("error", commandId);
        failed = true;
      }
      log((failed ? "Error: " : "Done: ") + command + (failed && result.message ? " - " + result.message : ""));
      return result;
    }

    async function tick() {
      if (state.busy) return false;
      state.busy = true;
      var ran = false;
      try {
        if (exists(fs, paths.command)) {
          var content = fs.readFileSync(paths.command, "utf8");
          if (content) {
            var data = JSON.parse(content);
            var commandId = String(data.id || data.timestamp || "");
            if (data.status === "pending" && commandId !== state.lastProcessedId) {
              state.lastProcessedId = commandId;
              updateCommandStatus("running", commandId);
              await execute(data);
              ran = true;
            }
          }
        }
        state.lastCheckError = null;
      } catch (e) {
        var msg = String(e);
        if (msg !== state.lastCheckError) log("Error checking for commands: " + msg);
        state.lastCheckError = msg;
      } finally {
        state.busy = false;
      }
      return ran;
    }

    function writeHeartbeat() {
      var hb = { ts: new Date(now()).toISOString(), version: version };
      if (deps.pid !== undefined && deps.pid !== null) hb.pid = deps.pid;
      try {
        atomicWrite(fs, paths.heartbeat, paths.heartbeatTmp, JSON.stringify(hb));
        state.lastHeartbeatError = null;
      } catch (e) {
        var msg = "Heartbeat write failed: " + e;
        if (msg !== state.lastHeartbeatError) log(msg);
        state.lastHeartbeatError = msg;
      }
      return hb;
    }

    function start() {
      stop();
      writeHeartbeat();
      state.poll = clock.setInterval(function () { tick(); }, POLL_MS);
      state.beat = clock.setInterval(writeHeartbeat, HEARTBEAT_MS);
    }

    function stop() {
      if (state.poll !== null) clock.clearInterval(state.poll);
      if (state.beat !== null) clock.clearInterval(state.beat);
      state.poll = null;
      state.beat = null;
    }

    return {
      tick: tick, start: start, stop: stop, execute: execute, gate: gate, writeResult: writeResult,
      writeHeartbeat: writeHeartbeat, updateCommandStatus: updateCommandStatus, paths: paths, state: state,
    };
  }

  return {
    POLL_MS: POLL_MS, HEARTBEAT_MS: HEARTBEAT_MS, STALE_AFTER_MS: STALE_AFTER_MS, MIRROR_FRESH_MS: MIRROR_FRESH_MS,
    BACKUPS_TO_KEEP: BACKUPS_TO_KEEP, FILES: FILES, OPERATIONS: OPERATIONS,
    stripLongPathPrefix: stripLongPathPrefix, normalize: normalize, samePath: samePath, joinPath: joinPath,
    commandAgeMs: commandAgeMs, isStale: isStale, archiveStamp: archiveStamp, toEs3Json: toEs3Json,
    buildEvalCall: buildEvalCall, parseHostResult: parseHostResult, validateArgs: validateArgs,
    atomicWrite: atomicWrite, readMirror: readMirror, folderFor: folderFor, backupProject: backupProject,
    pruneBackups: pruneBackups, createSidecar: createSidecar,
  };
});
