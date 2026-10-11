"use strict";
// Thin wiring: real UXP modules into the panel core (core/bridge.js), plus the panel UI.
// Everything is inside one IIFE so scripts can't reach panel state through globals.
(function () {
  const uxp = require("uxp");
  const ppro = require("premierepro");
  const fs = require("fs");
  const os = require("os");
  const { createBridge } = require("./core/bridge.js");

  const $ = (id) => document.getElementById(id);
  const logLines = [];

  function log(message) {
    try {
      logLines.unshift(new Date().toLocaleTimeString() + ": " + message);
      if (logLines.length > 300) logLines.length = 300;
      const el = $("log");
      if (el) el.textContent = logLines.join("\n");
    } catch (e) { /* never throw from logging */ }
  }

  function envVar(name) {
    try {
      // eslint-disable-next-line no-undef
      return typeof process !== "undefined" && process.env ? process.env[name] || "" : "";
    } catch (e) {
      return "";
    }
  }

  const home = os.homedir();
  // %AE_MCP_BRIDGE_DIR% when UXP exposes the environment, else %USERPROFILE%\ae-mcp-bridge.
  const bridgeDir = envVar("AE_MCP_BRIDGE_DIR") || home + "\\ae-mcp-bridge";
  const tempDir = envVar("TEMP") || envVar("TMP") || home + "\\AppData\\Local\\Temp";

  let commands = [];
  try {
    const loaded = require("./commands/index.js");
    commands = Array.isArray(loaded) ? loaded : [];
  } catch (e) {
    log("No typed commands loaded: " + e);
  }

  let hostVersion = null;
  try { hostVersion = uxp.host && uxp.host.version ? String(uxp.host.version) : null; } catch (e) { hostVersion = null; }

  const bridge = createBridge({
    fs, ppro, storage: window.localStorage, bridgeDir, tempDir, uxp, os, hostVersion, commands, log,
    onTick: refreshUi,
  });

  let lastUi = null;
  function refreshUi() {
    const s = bridge.uiState();
    const key = JSON.stringify(s);
    if (key === lastUi) return;
    lastUi = key;
    $("project").textContent = "Project: " + (s.projectPath ? s.projectName + "  (" + s.projectPath + ")" : "None open, or untitled (save it to choose a folder)");
    $("folder").textContent = "Folder: " + (s.folder ? s.folder + (s.isDefault ? " (default)" : "") : "Not set - Claude can't run scripts or edit");
    $("open").textContent = "Open projects: " + s.openCount;
    setEnabled("browse", s.canBrowse);
    setEnabled("clear", s.canClear);
    setEnabled("forget", s.canForget);
    $("status").textContent = s.paused ? "Paused - Claude's commands are refused" : "Ready";
  }

  function setEnabled(id, on) {
    const el = $(id);
    if (on) el.removeAttribute("disabled");
    else el.setAttribute("disabled", "");
  }

  $("browse").addEventListener("click", async () => {
    try {
      const picked = await uxp.storage.localFileSystem.getFolder();
      if (picked && picked.nativePath) {
        bridge.chooseFolder(picked.nativePath);
        refreshUi();
      }
    } catch (e) {
      log("Folder picker failed: " + e);
    }
  });
  $("clear").addEventListener("click", () => { bridge.clearFolder(); refreshUi(); });
  $("forget").addEventListener("click", () => { bridge.forgetDefault(); refreshUi(); });
  $("pause").addEventListener("change", (ev) => { bridge.setPaused(!!ev.target.checked); refreshUi(); });
  // Never persisted: unticked at every launch.
  $("harness").checked = false;
  $("harness").addEventListener("change", (ev) => { bridge.setHarness(!!ev.target.checked); refreshUi(); });

  async function startBridge() {
    try {
      await fs.mkdir(bridgeDir, { recursive: true });
    } catch (e) { /* exists */ }
    log("MCP Bridge started (Premiere " + (hostVersion || "?") + ")");
    log("Command file: " + bridge.paths.command);
    log("Result file: " + bridge.paths.result);
    bridge.start();
    bridge.tick();
  }

  let started = false;
  function ensureStarted() {
    if (started) return;
    started = true;
    startBridge();
  }

  try {
    uxp.entrypoints.setup({
      panels: {
        mcpBridge: {
          create() { ensureStarted(); },
          show() { ensureStarted(); refreshUi(); },
        },
      },
    });
  } catch (e) {
    log("entrypoints.setup failed: " + e);
  }
  ensureStarted();
})();
