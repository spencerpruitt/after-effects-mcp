/* Wiring for the MCP Bridge sidecar panel: Node's fs, the bridge folder, CSInterface-style evalScript, and
 * the core (js/core.js). Runs in CEP with --enable-nodejs --mixed-context, so require() is available here. */
(function () {
  "use strict";
  var EXTENSION_ID = "com.mcp.premiere.sidecar.panel";
  var VERSION = "1.0.1";
  var Core = window.MCPSidecarCore;
  var logLines = [];

  function el(id) { return document.getElementById(id); }

  function log(message) {
    try {
      logLines.unshift(new Date().toLocaleTimeString() + ": " + message);
      if (logLines.length > 200) logLines.length = 200;
      el("log").textContent = logLines.join("\n");
    } catch (e) { /* never throw from logging */ }
  }

  function status(text) {
    try { el("status").textContent = text; } catch (e) { /* ignore */ }
  }

  // CSInterface.evalScript(script, callback) is a thin wrapper over window.__adobe_cep__.evalScript
  // (CSInterface.js in https://github.com/Adobe-CEP/CEP-Resources, CEP_12.x); called directly so the
  // extension needs no vendored library.
  function evalScript(script) {
    return new Promise(function (resolve) {
      if (!window.__adobe_cep__ || typeof window.__adobe_cep__.evalScript !== "function") {
        resolve("EvalScript error. (not running inside CEP)");
        return;
      }
      window.__adobe_cep__.evalScript(script, function (result) { resolve(result); });
    });
  }

  function evalHost(name, args) {
    return evalScript(Core.buildEvalCall(name, args)).then(Core.parseHostResult);
  }

  if (!Core) {
    status("Sidecar core (js/core.js) did not load; the sidecar can't run. Reinstall it.");
    return;
  }

  var fs, os, path;
  try {
    fs = require("fs");
    os = require("os");
    path = require("path");
  } catch (e) {
    status("Node.js is not enabled for this panel; the sidecar can't run.");
    log(String(e));
    return;
  }

  var bridgeDir = (process.env.AE_MCP_BRIDGE_DIR || "") || path.join(os.homedir(), "ae-mcp-bridge");
  try { fs.mkdirSync(bridgeDir, { recursive: true }); } catch (e) { /* exists */ }

  var sidecar = Core.createSidecar({
    fs: fs, bridgeDir: bridgeDir, evalHost: evalHost, log: log, version: VERSION, pid: process.pid,
  });

  evalHost("init", { extensionId: EXTENSION_ID }).then(function (r) {
    if (r && r.status === "success") {
      log("Premiere " + (r.app ? r.app.version : "?") + ", QE " + (r.qe ? "available" : "NOT available") + (r.persistent ? ", persistent" : ""));
    } else {
      log("Host init failed: " + (r && r.message));
    }
  });

  sidecar.start();
  status("MCP Sidecar running");
  log("Command file: " + sidecar.paths.command);
  log("Heartbeat: " + sidecar.paths.heartbeat + " (every " + Core.HEARTBEAT_MS / 1000 + " s)");
  window.addEventListener("unload", function () { sidecar.stop(); });
})();
