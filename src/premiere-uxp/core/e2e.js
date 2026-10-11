"use strict";
// __e2e_* commands for the end-to-end harness (spec section 10). Accepted only while the panel's
// non-persisted "Allow test harness" checkbox is ticked, and only for paths under %TEMP%\pr-mcp-e2e-*.
const { normalize, isInside } = require("../lib/pathPolicy.js");
const { refusal, mcpError } = require("./util.js");
const { FOLDER_PREFIX, ROOTS_KEY } = require("./settings.js");

const PATH_ARGS = {
  __e2e_setFolder: ["projectPath", "folder"],
  __e2e_clearFolder: ["projectPath"],
  __e2e_addRoot: ["root"],
  __e2e_removeRoot: ["root"],
  __e2e_openProject: ["path"],
  __e2e_closeProject: ["path"],
  __e2e_countItems: ["projectPath"],
  __e2e_readSettings: [],
};

function isE2eCommand(command) {
  return typeof command === "string" && command.indexOf("__e2e_") === 0;
}

// True for a path inside <tempDir>\pr-mcp-e2e-<anything>.
function isTestPath(p, tempDir) {
  const n = normalize(p);
  const t = normalize(tempDir);
  if (n === null || t === null || !isInside(p, tempDir) || n === t) return false;
  const first = n.substring(t.replace(/\/$/, "").length + 1).split("/")[0];
  return first.indexOf("pr-mcp-e2e-") === 0 && first.length > "pr-mcp-e2e-".length;
}

// Returns a refusal, or null when the command may run. PAUSED is checked by the caller first.
function gateE2e(command, args, { harness, tempDir }) {
  if (!harness) {
    return refusal("TEST_HARNESS_DISABLED", "Test-harness commands are refused: tick \"Allow test harness\" in the MCP Bridge panel.");
  }
  const names = PATH_ARGS[command];
  if (!names) return { status: "error", code: "UNKNOWN_COMMAND", message: "Unknown command: " + command };
  for (const k of names) {
    const v = args ? args[k] : undefined;
    if (!tempDir || !isTestPath(v, tempDir)) {
      return refusal("OUTSIDE_TEST_ROOT", "Test-harness paths must be under " + (tempDir || "%TEMP%") + "\\pr-mcp-e2e-*: " + k + " = " + String(v));
    }
  }
  return null;
}

async function countItems(ppro, project) {
  const root = await project.getRootItem();
  const FolderItem = ppro.FolderItem;
  let items = 0;
  let bins = 0;
  async function walk(folder) {
    const children = (await folder.getItems()) || [];
    for (const child of children) {
      items++;
      let sub = null;
      try { sub = FolderItem && typeof FolderItem.cast === "function" ? FolderItem.cast(child) : null; } catch (e) { sub = null; }
      if (sub && typeof sub.getItems === "function") {
        bins++;
        await walk(sub);
      }
    }
  }
  await walk(root);
  return { items, bins };
}

// deps: { ppro, settings, registry, tempDir }
async function runE2e(deps, command, args) {
  const { ppro, settings, registry, tempDir } = deps;
  args = args || {};
  switch (command) {
    case "__e2e_setFolder":
      settings.setFolder(args.projectPath, args.folder);
      return { status: "success", projectPath: args.projectPath, folder: args.folder };
    case "__e2e_clearFolder":
      // Default: forget the entry (teardown). blank:true stores "" like the panel's Clear button.
      if (args.blank) settings.clearFolder(args.projectPath);
      else settings.removeFolder(args.projectPath);
      return { status: "success", projectPath: args.projectPath, blank: !!args.blank };
    case "__e2e_addRoot":
      settings.rememberRoot(args.root);
      return { status: "success", roots: settings.roots().filter((r) => isTestPath(r, tempDir)) };
    case "__e2e_removeRoot":
      settings.forgetRoot(args.root);
      return { status: "success", roots: settings.roots().filter((r) => isTestPath(r, tempDir)) };
    case "__e2e_openProject": {
      const existing = registry.find(args.path);
      if (existing) return { status: "success", path: existing.path, guid: existing.guid, alreadyOpen: true };
      let options;
      if (typeof ppro.OpenProjectOptions === "function") {
        options = new ppro.OpenProjectOptions();
        for (const m of ["setShowConvertProjectDialog", "setShowLocateFileDialog", "setShowWarningDialog", "setAddToMRUList"]) {
          if (typeof options[m] === "function") options[m](false);
        }
      }
      const project = await ppro.Project.open(args.path, options);
      if (!project) throw mcpError("OPEN_FAILED", "Premiere did not open " + args.path);
      registry.remember(project);
      await registry.refresh();
      const entry = registry.find(project.path || args.path);
      return { status: "success", path: project.path || args.path, guid: entry ? entry.guid : null, alreadyOpen: false };
    }
    case "__e2e_closeProject": {
      const entry = registry.find(args.path);
      if (!entry) {
        return refusal("PROJECT_NOT_OPEN", "Not open: " + args.path, { openProjects: registry.openPaths() });
      }
      let options;
      if (typeof ppro.CloseProjectOptions === "function") {
        options = new ppro.CloseProjectOptions();
        if (typeof options.setPromptIfDirty === "function") options.setPromptIfDirty(false);
        if (typeof options.setShowCancelButton === "function") options.setShowCancelButton(false);
      }
      const closed = await entry.project.close(options);
      await registry.refresh();
      return { status: "success", path: entry.path, closed: closed !== false };
    }
    case "__e2e_countItems": {
      const entry = registry.find(args.projectPath);
      if (!entry) return refusal("PROJECT_NOT_OPEN", "Not open: " + args.projectPath, { openProjects: registry.openPaths() });
      return Object.assign({ status: "success", projectPath: entry.path }, await countItems(ppro, entry.project));
    }
    case "__e2e_readSettings": {
      // Only harness-owned entries: the user's own folders stay private.
      const folders = {};
      let roots = [];
      for (const { key, value } of settings.entries()) {
        if (key === ROOTS_KEY) {
          roots = String(value || "").split("\n").filter((r) => r && isTestPath(r, tempDir));
        } else {
          const projectPath = key.substring(FOLDER_PREFIX.length);
          if (isTestPath(projectPath, tempDir)) folders[projectPath] = value;
        }
      }
      return { status: "success", folders, roots };
    }
    default:
      return { status: "error", code: "UNKNOWN_COMMAND", message: "Unknown command: " + command };
  }
}

module.exports = { isE2eCommand, isTestPath, gateE2e, runE2e, countItems };
