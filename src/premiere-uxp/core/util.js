"use strict";
// Small pure helpers shared by the panel core. No UXP or Premiere APIs.
const { normalize } = require("../lib/pathPolicy.js");
const { pad } = require("../lib/time.js");

// <yyyymmdd-hhmmss-mmm> in local time, same as the AE panel (19 characters, sorts oldest-first).
function archiveStamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + "-" +
    pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2) + "-" + pad(d.getMilliseconds(), 3);
}

function safeScriptName(name) {
  let s = String(name || "script").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 60) s = s.substring(0, 60);
  return s || "script";
}

// Strips control characters other than tab/newline/carriage return.
function cleanString(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

// An Error carrying a bridge code; the core turns it into { status: "error", code, message, ...extra }.
function mcpError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.mcpCode = code;
  if (extra) e.extra = extra;
  return e;
}

function refusal(code, message, extra) {
  return Object.assign({ status: "error", refused: true, code, message }, extra || {});
}

function errorResult(e) {
  if (e && (e.mcpCode || e.code) && typeof (e.mcpCode || e.code) === "string") {
    return Object.assign({ status: "error", code: e.mcpCode || e.code, message: cleanString(e.message) }, e.extra || {});
  }
  const message = e instanceof Error ? e.toString() : String(e);
  return { status: "error", message: cleanString(message) };
}

function samePath(a, b) {
  if (!a || !b) return !a && !b;
  return normalize(a) === normalize(b);
}

function baseName(p) {
  return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
}

function dirName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? "" : s.substring(0, i);
}

// Windows-style join; the folder keeps its own separators.
function joinPath(folder, rel) {
  const f = String(folder).replace(/[\\/]+$/, "");
  const r = String(rel).replace(/^[\\/]+/, "");
  return f + "\\" + r.replace(/\//g, "\\");
}

// Relative paths resolve against the folder; absolute paths are returned unchanged.
function resolveInFolder(folder, p) {
  if (normalize(p) !== null) return String(p);
  return joinPath(folder, p);
}

// Converts a script's return value to something JSON.stringify can always handle:
// depth limit 8, host objects and class instances become String(value).
function toJsonSafe(value, depth) {
  depth = depth || 0;
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === "boolean") return value;
  if (t === "number") return isFinite(value) ? value : null;
  if (t === "string") return cleanString(value);
  if (t === "bigint") return value.toString();
  if (t === "function" || t === "symbol") return null;
  if (depth >= 8) return "[depth limit]";
  try {
    if (Array.isArray(value)) return Array.from(value, (v) => toJsonSafe(v, depth + 1));
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const obj = {};
      for (const k of Object.keys(value)) {
        if (typeof value[k] !== "function") obj[k] = toJsonSafe(value[k], depth + 1);
      }
      return obj;
    }
    return cleanString(String(value));
  } catch (e) {
    return "[unprintable]";
  }
}

// A Premiere Project's path without the Win32 long-path prefix that 26.5 adds; "" if none.
function projectPathOf(project) {
  try {
    return project && project.path ? require("../lib/pathPolicy.js").stripLongPathPrefix(String(project.path)) : "";
  } catch (e) {
    return "";
  }
}

// "C:/a/b.prproj" -> "C:\a\b.prproj". Premiere 26.5.2 can't resolve "Same as Project" scratch disks for a
// project created at a forward-slash path: it shows a modal "The scratch disks are write protected or
// unavailable" dialog and Project.createProject waits on it (live, Oct 2026). Drive and UNC paths only.
function toWindowsPath(p) {
  if (typeof p !== "string") return p;
  if (/^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/?.]/.test(p)) return p.replace(/\//g, "\\");
  return p;
}

module.exports = {
  projectPathOf, toWindowsPath,
  archiveStamp, safeScriptName, cleanString, mcpError, refusal, errorResult,
  samePath, baseName, dirName, joinPath, resolveInFolder, toJsonSafe,
};
