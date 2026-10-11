"use strict";
// Open-project discovery. Primary source: ProjectUtils.getProjectViewIds() -> getProjectFromViewId()
// (spec section 4; the live spike must confirm it lists every open project). Fallback: every project
// the panel has seen (active, opened, created), re-checked with Project.getProject(guid) on each refresh.
const { normalize } = require("../lib/pathPolicy.js");
const { baseName, projectPathOf } = require("./util.js");
const refs = require("../lib/refs.js");

function guidOf(project) {
  let g;
  try {
    g = project ? project.guid : null;
  } catch (e) {
    g = null;
  }
  return refs.guidString(g) || "";
}

function projectPath(project) {
  try {
    return projectPathOf(project);
  } catch (e) {
    return "";
  }
}

function createRegistry({ ppro, log }) {
  const seen = new Map(); // guid + path -> Project
  let snap = { projects: [], active: null };

  // GUID and path together: Save As keeps the GUID, so a project and its Save As copy can be open at once with
  // the same GUID (live e2e, 26.5.2), and a GUID-only key let one hide the other.
  function keyOf(project) {
    return guidOf(project) + "|" + normalize(projectPath(project));
  }

  function remember(project) {
    if (project) seen.set(keyOf(project), project);
  }

  async function refresh() {
    const found = new Map();
    let active = null;
    try {
      active = await ppro.Project.getActiveProject();
    } catch (e) {
      active = null;
    }
    const PU = ppro.ProjectUtils;
    if (PU && typeof PU.getProjectViewIds === "function" && typeof PU.getProjectFromViewId === "function") {
      try {
        const ids = (await PU.getProjectViewIds()) || [];
        for (const id of ids) {
          try {
            const p = await PU.getProjectFromViewId(id);
            if (p) found.set(keyOf(p), p);
          } catch (e) { /* a view without a project */ }
        }
      } catch (e) {
        if (log) log("getProjectViewIds failed: " + e);
      }
    }
    if (active) found.set(keyOf(active), active);
    for (const [k, p] of Array.from(seen)) {
      seen.delete(k);
      if (found.has(k)) continue;
      let alive = null;
      try {
        alive = p.guid && typeof ppro.Project.getProject === "function" ? ppro.Project.getProject(p.guid) : null;
      } catch (e) {
        alive = null;
      }
      if (!alive || !projectPath(alive)) continue;
      // getProject(guid) answers for only one of the projects sharing a GUID, so file it under its own key: the
      // remembered object may be closed, or moved by a Save As. View ids are the primary source and list them all.
      const ak = keyOf(alive);
      if (!found.has(ak)) found.set(ak, alive);
    }
    for (const [k, p] of found) seen.set(k, p);
    const activeKey = active ? keyOf(active) : null;
    snap = {
      active,
      projects: Array.from(found, ([k, p]) => {
        const path = projectPath(p);
        let name = "";
        try { name = p.name ? String(p.name) : baseName(path); } catch (e) { name = baseName(path); }
        return { path, name, guid: guidOf(p), isActive: k === activeKey, project: p };
      }),
    };
    return snap;
  }

  function snapshot() {
    return snap;
  }

  // The open project whose file matches path (case and separator tolerant), or null.
  function find(path) {
    const n = normalize(path);
    if (n === null) return null;
    return snap.projects.find((e) => e.path && normalize(e.path) === n) || null;
  }

  function openPaths() {
    return snap.projects.map((e) => e.path).filter(Boolean);
  }

  return { refresh, snapshot, find, remember, openPaths };
}

module.exports = { createRegistry, projectPath };
