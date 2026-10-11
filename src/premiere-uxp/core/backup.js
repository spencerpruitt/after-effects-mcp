"use strict";
// Pre-run save and rolling backup (spec section 6): project.save(), then copy the .prproj to
// <folder>/mcp-scripts/backups/<yyyymmdd-hhmmss-mmm>_<base>.prproj, keeping the newest 10 per base name.
const { archiveStamp, baseName, joinPath, mcpError, cleanString, projectPathOf } = require("./util.js");

const BACKUPS_TO_KEEP = 10;

function scriptsDir(folder) {
  return joinPath(folder, "mcp-scripts");
}

async function pruneBackups(fsx, dir, base) {
  const suffix = ("_" + base + ".prproj").toLowerCase();
  const mine = (await fsx.list(dir))
    .filter((n) => /^\d{8}-\d{6}-\d{3}_/.test(n) && n.substring(19).toLowerCase() === suffix)
    .sort()
    .reverse();
  for (const n of mine.slice(BACKUPS_TO_KEEP)) {
    try { await fsx.remove(joinPath(dir, n)); } catch (e) { /* best effort */ }
  }
}

async function backupProject({ fsx, folder, projectPath, now }) {
  const base = baseName(projectPath).replace(/\.prproj$/i, "");
  const dir = joinPath(scriptsDir(folder), "backups");
  await fsx.mkdirp(dir);
  const dest = joinPath(dir, archiveStamp(new Date(now())) + "_" + base + ".prproj");
  await fsx.copy(projectPath, dest);
  await pruneBackups(fsx, dir, base);
  return dest;
}

// Saves the project in place, then backs it up. Throws SAVE_FAILED; a backup failure is a warning.
async function saveAndBackup({ project, folder, fsx, now, log }) {
  let saved;
  try {
    saved = await project.save();
  } catch (e) {
    throw mcpError("SAVE_FAILED", "Save before run failed, nothing was run: " + cleanString(e && e.message ? e.message : e));
  }
  if (saved === false) throw mcpError("SAVE_FAILED", "Save before run failed (project.save() returned false), nothing was run.");
  const out = { backupPath: null };
  try {
    out.backupPath = await backupProject({ fsx, folder, projectPath: projectPathOf(project), now });
  } catch (e) {
    out.backupWarning = "Backup failed: " + cleanString(e && e.message ? e.message : e);
    if (log) log(out.backupWarning);
  }
  return out;
}

module.exports = { BACKUPS_TO_KEEP, scriptsDir, backupProject, pruneBackups, saveAndBackup };
