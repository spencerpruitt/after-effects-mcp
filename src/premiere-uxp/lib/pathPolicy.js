"use strict";
// Path policy for the Premiere UXP panel. Pure: no UXP or Premiere APIs, so Node unit tests load it
// directly (test/premiere-pathPolicy.test.mjs). normalize/isInside follow the AE panel's
// MCPPathPolicy exactly; note the argument order here is isInside(child, folder), per the
// cross-stream contract.

// Absolute Windows path -> canonical lowercase form with "/" separators, or null if not absolute/invalid.
// Case-insensitive, "\" and "/" alike, "." dropped, ".." resolved (escaping above the root is invalid).
// Premiere 26.5 reports project paths with the Win32 long-path prefix (\\?\C:\..., \\?\UNC\server\share).
// Strip it so paths compare and display like the ones users type.
function stripLongPathPrefix(p) {
  const s = p === null || p === undefined ? "" : String(p);
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s)) return "\\\\" + s.substring(8);
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return s.substring(4);
  return s;
}

function normalize(p) {
  if (p === null || p === undefined) return null;
  const s = stripLongPathPrefix(p).replace(/\\/g, "/");
  if (s.length === 0) return null;
  let prefix;
  let rest;
  const m = /^([a-zA-Z]):(\/.*)?$/.exec(s);
  if (m) {
    prefix = m[1].toLowerCase() + ":";
    rest = m[2] || "/";
  } else if (/^\/\/[^/]+\/[^/]+/.test(s)) {
    const parts = s.substring(2).split("/");
    prefix = "//" + parts[0].toLowerCase() + "/" + parts[1].toLowerCase();
    rest = "/" + parts.slice(2).join("/");
  } else if (/^\/[a-zA-Z](\/|$)/.test(s)) {
    // URI form: /d/Projects/MyFilm/shots/SH010
    prefix = s.charAt(1).toLowerCase() + ":";
    rest = s.substring(2) || "/";
  } else {
    return null;
  }
  const out = [];
  for (const seg of rest.split("/")) {
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

// True when child is the folder itself or anything beneath it.
function isInside(child, folder) {
  let f = normalize(folder);
  const c = normalize(child);
  if (f === null || c === null) return false;
  if (f.charAt(f.length - 1) === "/") f = f.substring(0, f.length - 1);
  return c === f || c.indexOf(f + "/") === 0;
}

// Every panel module: the basenames of the files under core/, lib/ and commands/ (a unit test keeps this in
// sync with the folders). Scripts may not load them, by require name or by path.
const PANEL_MODULES = Object.freeze([
  // core/
  "backup", "bridge", "e2e", "fsx", "guards", "registry", "scriptRunner", "settings", "sidecarMirror", "state", "transaction",
  "util",
  // lib/
  "pathPolicy", "refs", "time",
  // commands/
  "_shared", "addMarkers", "addTransition", "buildSequence", "createProject", "createSequence", "editItems",
  "exportSequence", "getProjectItems", "getSequence", "importAEComps", "importFiles", "index", "openProject", "placeAudio",
  "replaceMedia", "saveProject", "setAudio", "setSpeed",
]);
const MODULE_NAMES = "(?:" + PANEL_MODULES.join("|") + ")";
// require("state"), require("state.js"), require("C:/.../core/state.js"). Plain words such as `state` or `time`
// elsewhere in user code are not matched.
const REQUIRE_PANEL_MODULE = new RegExp("\\brequire\\s*\\(\\s*[\"'`](?:[^\"'`]*[/\\\\])?" + MODULE_NAMES + "(?:\\.js)?[\"'`]");
// "core/state", "lib\\time.js", "commands/editItems.js" anywhere (e.g. a path built for a later require).
const PANEL_MODULE_PATH = new RegExp("(?:^|[^A-Za-z0-9_])(?:core|lib|commands)[/\\\\]+" + MODULE_NAMES + "(?![A-Za-z0-9_])");

// Static scan for things the runtime guards can't intercept. Returns a reason string, or null if clean.
// Best-effort (spec section 6): the guarded require/fs/ppro and the pre-run backup are the real defence.
const RULES = [
  [/\bglobalThis\b|\bwindow\b|\bdocument\b|\bself\s*[.[]|\bglobal\s*[.[]/,
    "Access to the panel's globals (globalThis, window, document, self, global) is blocked"],
  [/\beval\b/, "eval is blocked"],
  [/\bFunction\b/, "The Function constructor is blocked"],
  [/\bconstructor\s*\)?\s*\(|["'`]constructor["'`]|\bconstructor\s*\.\s*constructor/,
    "Calling a constructor property is blocked (it can build functions from strings)"],
  [/\bset(Timeout|Interval)\s*\(\s*["'`]/, "setTimeout/setInterval with a code string is blocked"],
  [/\bimport\s*\(/, "Dynamic import() is blocked"],
  [/\blocalFileSystem\b/, "uxp.storage.localFileSystem is blocked; use require('fs') with paths inside the folder"],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, "Plugin storage (localStorage, sessionStorage, indexedDB) is blocked"],
  [/__mcp|MCPBridge|\bpathPolicy\b|\bscriptRunner\b/, "Changing the bridge's settings, folder or guards from a script is blocked"],
  [/\bshell\b|\bopenExternal\b|\bopenPath\b/, "uxp.shell (openExternal/openPath) is blocked"],
  // require() must name a module with a plain string literal, and never a panel file.
  [/\brequire\s*\(\s*(?!["'][^"'`\\]*["']\s*\))/, "require() must be called with a plain string literal"],
  [/\brequire\s*\(\s*["'][./\\]/, "require() of plugin files is blocked"],
  [REQUIRE_PANEL_MODULE, "require() of the panel's own modules is blocked"],
  [PANEL_MODULE_PATH, "Paths to the panel's own modules are blocked"],
];

function scanCode(code) {
  const s = String(code);
  for (const [re, reason] of RULES) {
    if (re.test(s)) return reason;
  }
  return null;
}

module.exports = { normalize, isInside, scanCode, PANEL_MODULES, stripLongPathPrefix };
