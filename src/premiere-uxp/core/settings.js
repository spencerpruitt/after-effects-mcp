"use strict";
// Per-project sandbox folders and remembered default roots, kept in the plugin's localStorage.
// Keys: "MCPBridgeSandbox:<normalized project path>" (folder, or "" after Clear) and
// "MCPBridgeSandboxRoots" (newline-separated). Resolution matches the AE panel: the project's own
// setting wins; otherwise the innermost default root containing the project file.
const { normalize, isInside } = require("../lib/pathPolicy.js");

const FOLDER_PREFIX = "MCPBridgeSandbox:";
const ROOTS_KEY = "MCPBridgeSandboxRoots";

function createSettings(storage) {
  function key(projectPath) {
    return FOLDER_PREFIX + normalize(projectPath);
  }
  function roots() {
    const v = storage.getItem(ROOTS_KEY);
    return v ? String(v).split("\n").filter(Boolean) : [];
  }
  function saveRoots(list) {
    storage.setItem(ROOTS_KEY, list.join("\n"));
  }
  function hasOwn(projectPath) {
    if (normalize(projectPath) === null) return false;
    const v = storage.getItem(key(projectPath));
    return v !== null && v !== undefined;
  }
  function defaultRootFor(projectPath) {
    let best = null;
    for (const r of roots()) {
      if (isInside(projectPath, r) && (!best || normalize(r).length > normalize(best).length)) best = r;
    }
    return best;
  }
  // { folder: string|null, isDefault: boolean }
  function folderFor(projectPath) {
    if (!projectPath || normalize(projectPath) === null) return { folder: null, isDefault: false };
    if (hasOwn(projectPath)) {
      const v = storage.getItem(key(projectPath));
      return { folder: v ? String(v) : null, isDefault: false };
    }
    const root = defaultRootFor(projectPath);
    return { folder: root, isDefault: !!root };
  }
  function setFolder(projectPath, folder) {
    storage.setItem(key(projectPath), String(folder));
  }
  // Clear: "" turns the folder off for this project only, even when it came from a default.
  function clearFolder(projectPath) {
    storage.setItem(key(projectPath), "");
  }
  // Removes the project's own entry (e2e teardown), so defaults apply again.
  function removeFolder(projectPath) {
    storage.removeItem(key(projectPath));
  }
  function rememberRoot(folder) {
    const list = roots();
    if (list.some((r) => normalize(r) === normalize(folder))) return;
    list.push(String(folder));
    saveRoots(list);
  }
  function forgetRoot(folder) {
    saveRoots(roots().filter((r) => normalize(r) !== normalize(folder)));
  }
  function isDefaultRoot(absPath) {
    return roots().some((r) => isInside(absPath, r));
  }
  // Folder follows Save As: a project saved to a new path inside the folder keeps the same folder.
  function inheritFolder(newPath, folder) {
    if (newPath && folder && isInside(newPath, folder)) {
      setFolder(newPath, folder);
      return true;
    }
    return false;
  }
  // Every bridge entry, for __e2e_readSettings: [{ key, value }].
  function entries() {
    const out = [];
    const n = storage.length || 0;
    for (let i = 0; i < n; i++) {
      const k = storage.key(i);
      if (k && (k.indexOf(FOLDER_PREFIX) === 0 || k === ROOTS_KEY)) out.push({ key: k, value: storage.getItem(k) });
    }
    return out;
  }
  return {
    key, roots, hasOwn, defaultRootFor, folderFor, setFolder, clearFolder, removeFolder,
    rememberRoot, forgetRoot, isDefaultRoot, inheritFolder, entries,
  };
}

module.exports = { createSettings, FOLDER_PREFIX, ROOTS_KEY };
