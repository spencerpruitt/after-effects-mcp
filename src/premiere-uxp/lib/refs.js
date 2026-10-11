// Reference resolution for the Premiere UXP panel's typed commands: project items, bins, sequences and tracks.
// Pure: everything host-related comes in through ctx (ctx.ppro, ctx.project, ctx.transaction, ctx.fail).
"use strict";

const { normalize } = require("./pathPolicy.js");

// ProjectItem.type values are undocumented in UXP and there is no Constants.ProjectItemType (26.5.2). Live, a bin
// reports 2, matching ExtendScript's ProjectItemType (CLIP=1, BIN=2, ROOT=3, FILE=4); the others are assumed from
// it. Clips and sequences are told apart by ClipProjectItem.isSequence(), not by type. A ProjectItemType enum
// is used instead if a future release adds one.
const DEFAULT_ITEM_TYPES = { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 };

function itemTypes(ctx) {
  const c = ctx.ppro && ctx.ppro.Constants && ctx.ppro.Constants.ProjectItemType;
  return c && c.BIN !== undefined ? Object.assign({}, DEFAULT_ITEM_TYPES, c) : DEFAULT_ITEM_TYPES;
}

function normalizeName(s) {
  return String(s == null ? "" : s).normalize("NFC").trim().toLowerCase();
}

// Media / file paths compare with the path policy's normalize (case-insensitive, \ and / alike, . and ..
// resolved). A path it rejects (relative, escaping its root) falls back to a lowercase, "/"-separated string.
function normalizeMediaPath(p) {
  const s = String(p == null ? "" : p).trim();
  const n = normalize(s);
  return n !== null ? n : s.replace(/\\/g, "/").toLowerCase();
}

function splitItemPath(p) {
  return String(p == null ? "" : p)
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function joinPath(parent, name) {
  return parent ? parent + "/" + name : name;
}

async function getRoot(ctx) {
  const root = await ctx.project.getRootItem();
  if (!root) throw new Error("Premiere returned no root item for the project");
  return root;
}

function itemId(item) {
  try {
    return typeof item.getId === "function" ? String(item.getId()) : null;
  } catch (e) {
    return null;
  }
}

// -> "bin" | "clip" | "sequence"
async function itemKind(ctx, item) {
  const T = itemTypes(ctx);
  if (item.type === T.BIN || item.type === T.ROOT) return "bin";
  const clip = asClip(ctx, item);
  try {
    if (clip && typeof clip.isSequence === "function" && (await clip.isSequence())) return "sequence";
  } catch (e) {
    /* treat as clip */
  }
  return "clip";
}

function asFolder(ctx, item) {
  const F = ctx.ppro.FolderItem;
  return F && typeof F.cast === "function" ? F.cast(item) : item;
}

function asClip(ctx, item) {
  const C = ctx.ppro.ClipProjectItem;
  return C && typeof C.cast === "function" ? C.cast(item) : item;
}

async function childrenOf(ctx, folder) {
  const items = await folder.getItems();
  return Array.isArray(items) ? items : Array.from(items || []);
}

// Walks a folder. Returns [{ item, name, path, kind, id, parentPath }] in depth-first order.
async function walk(ctx, folder, opts) {
  const o = Object.assign({ recursive: true, basePath: "" }, opts || {});
  const out = [];
  async function visit(f, base) {
    for (const child of await childrenOf(ctx, f)) {
      const kind = await itemKind(ctx, child);
      const path = joinPath(base, child.name);
      out.push({ item: child, name: child.name, path, kind, id: itemId(child), parentPath: base });
      if (kind === "bin" && o.recursive) await visit(asFolder(ctx, child), path);
    }
  }
  await visit(folder, o.basePath);
  return out;
}

async function mediaPathOf(ctx, entry) {
  if (entry.kind !== "clip") return null;
  try {
    const p = await asClip(ctx, entry.item).getMediaFilePath();
    return p || null;
  } catch (e) {
    return null;
  }
}

function candidatesOf(matches) {
  return matches.map((m) => ({ path: m.path, id: m.id, type: m.kind }));
}

function describeRef(ref) {
  return typeof ref === "string" ? `"${ref}"` : JSON.stringify(ref);
}

// ref: "Bin/Sub/Name" | { path } | { id } | { file }. opts.kinds: allowed kinds (default clip+sequence).
// Returns { item, clip, path, id, kind, name, mediaPath? }.
async function resolveItem(ctx, ref, opts) {
  const kinds = (opts && opts.kinds) || ["clip", "sequence"];
  if (ref == null || (typeof ref !== "string" && typeof ref !== "object") || Array.isArray(ref)) {
    throw ctx.fail("BAD_ARGS", `Item reference must be a project path string, {id} or {file}; got ${describeRef(ref)}`);
  }
  const root = await getRoot(ctx);
  let matches;
  if (typeof ref === "string" || typeof ref.path === "string") {
    const segs = splitItemPath(typeof ref === "string" ? ref : ref.path);
    if (!segs.length) throw ctx.fail("BAD_ARGS", `Empty item path ${describeRef(ref)}`);
    matches = await matchPath(ctx, root, segs, "");
  } else if (ref.id != null) {
    const all = await walk(ctx, root);
    matches = all.filter((e) => e.id === String(ref.id));
  } else if (typeof ref.file === "string") {
    const want = normalizeMediaPath(ref.file);
    const all = await walk(ctx, root);
    matches = [];
    for (const e of all) {
      if (e.kind !== "clip") continue;
      const mp = await mediaPathOf(ctx, e);
      if (mp && normalizeMediaPath(mp) === want) {
        e.mediaPath = mp;
        matches.push(e);
      }
    }
  } else {
    throw ctx.fail("BAD_ARGS", `Item reference must be a project path string, {id} or {file}; got ${describeRef(ref)}`);
  }
  const typed = matches.filter((m) => kinds.includes(m.kind));
  if (!typed.length) {
    const msg = matches.length
      ? `${describeRef(ref)} is a ${matches[0].kind}, expected ${kinds.join(" or ")}`
      : `No project item matches ${describeRef(ref)}`;
    throw ctx.fail("ITEM_NOT_FOUND", msg);
  }
  if (typed.length > 1) {
    throw ctx.fail("AMBIGUOUS_ITEM", `${describeRef(ref)} matches ${typed.length} project items`, { candidates: candidatesOf(typed) });
  }
  const m = typed[0];
  return Object.assign(m, { clip: m.kind === "bin" ? null : asClip(ctx, m.item) });
}

// All entries reachable by following segs (case-insensitive names) from folder; duplicate bin names are all explored.
async function matchPath(ctx, folder, segs, base) {
  const [head, ...rest] = segs;
  const want = normalizeName(head);
  const out = [];
  for (const child of await childrenOf(ctx, folder)) {
    if (normalizeName(child.name) !== want) continue;
    const kind = await itemKind(ctx, child);
    const path = joinPath(base, child.name);
    if (!rest.length) out.push({ item: child, name: child.name, path, kind, id: itemId(child), parentPath: base });
    else if (kind === "bin") out.push(...(await matchPath(ctx, asFolder(ctx, child), rest, path)));
  }
  return out;
}

// Resolves a bin path ("" / "/" / undefined = root). opts.create: create missing bins.
// Returns { bin, path, created: [paths] }. Each missing level is one transaction: a new bin only exists after
// its createBinAction is committed, and its children need it as their parent.
async function resolveBin(ctx, binPath, opts) {
  const create = !!(opts && opts.create);
  if (binPath != null && typeof binPath !== "string") throw ctx.fail("BAD_ARGS", `bin must be a path string, got ${describeRef(binPath)}`);
  const segs = splitItemPath(binPath);
  let folder = await getRoot(ctx);
  let path = "";
  const created = [];
  for (const seg of segs) {
    let found = await findChildBins(ctx, folder, seg, path);
    if (found.length > 1) {
      throw ctx.fail("AMBIGUOUS_ITEM", `Bin path "${joinPath(path, seg)}" matches ${found.length} bins`, { candidates: candidatesOf(found) });
    }
    if (!found.length) {
      if (!create) throw ctx.fail("BIN_NOT_FOUND", `No bin "${joinPath(path, seg)}" in the project`);
      const parent = folder;
      await ctx.transaction(`create bin ${seg}`, (compound) => {
        compound.addAction(parent.createBinAction(seg, false));
      });
      found = await findChildBins(ctx, folder, seg, path);
      if (found.length !== 1) throw new Error(`Created bin "${joinPath(path, seg)}" but could not find it afterwards`);
      created.push(joinPath(path, seg));
    }
    folder = asFolder(ctx, found[0].item);
    path = found[0].path;
  }
  return { bin: folder, path, created };
}

async function findChildBins(ctx, folder, name, base) {
  const want = normalizeName(name);
  const out = [];
  for (const child of await childrenOf(ctx, folder)) {
    if (normalizeName(child.name) !== want) continue;
    if ((await itemKind(ctx, child)) !== "bin") continue;
    out.push({ item: child, name: child.name, path: joinPath(base, child.name), kind: "bin", id: itemId(child) });
  }
  return out;
}

// A Premiere Guid (or anything with toString) as a string; null when absent.
function guidString(g) {
  if (g == null) return null;
  try {
    return typeof g.toString === "function" ? String(g.toString()) : String(g);
  } catch (e) {
    return null;
  }
}

// ref: "Name" (sequence name) | "Bin/Name" (project path) | {path} | {id} (sequence guid or project item id) | {name}.
// Returns { sequence, name, guid }.
async function resolveSequence(ctx, ref) {
  if (ref == null || ref === "" || (typeof ref !== "string" && typeof ref !== "object") || Array.isArray(ref)) {
    throw ctx.fail("BAD_ARGS", `sequence must be a name, project path, {id} or {path}; got ${describeRef(ref)}`);
  }
  const all = (await ctx.project.getSequences()) || [];
  const seqs = Array.from(all);
  const pathRef = typeof ref === "string" ? (splitItemPath(ref).length > 1 ? ref : null) : typeof ref.path === "string" ? ref.path : null;
  if (pathRef) {
    let entry;
    try {
      entry = await resolveItem(ctx, pathRef, { kinds: ["sequence"] });
    } catch (e) {
      if (e && e.code === "ITEM_NOT_FOUND") throw ctx.fail("SEQUENCE_NOT_FOUND", `No sequence at project path "${pathRef}"`);
      throw e;
    }
    const seq = await entry.clip.getSequence();
    if (!seq) throw ctx.fail("SEQUENCE_NOT_FOUND", `Project item "${entry.path}" has no sequence`);
    return { sequence: seq, name: seq.name, guid: guidString(seq.guid), path: entry.path };
  }
  let matches;
  if (typeof ref === "object" && ref.id != null) {
    const want = String(ref.id).toLowerCase();
    matches = [];
    for (const s of seqs) {
      if ((guidString(s.guid) || "").toLowerCase() === want) {
        matches.push(s);
        continue;
      }
      try {
        const pi = await s.getProjectItem();
        if (pi && itemId(pi) === String(ref.id)) matches.push(s);
      } catch (e) {
        /* ignore */
      }
    }
  } else {
    const name = typeof ref === "string" ? ref : ref.name;
    if (typeof name !== "string") throw ctx.fail("BAD_ARGS", `sequence must be a name, project path, {id} or {path}; got ${describeRef(ref)}`);
    const want = normalizeName(name);
    matches = seqs.filter((s) => normalizeName(s.name) === want);
  }
  if (!matches.length) throw ctx.fail("SEQUENCE_NOT_FOUND", `No sequence matches ${describeRef(ref)}`);
  if (matches.length > 1) {
    throw ctx.fail("AMBIGUOUS_ITEM", `${describeRef(ref)} matches ${matches.length} sequences; pass its project path or {id}`, {
      candidates: matches.map((s) => ({ name: s.name, id: guidString(s.guid), type: "sequence" })),
    });
  }
  return { sequence: matches[0], name: matches[0].name, guid: guidString(matches[0].guid) };
}

// "V1" / "a2" -> { type: "video" | "audio", index0, label }
function parseTrackRef(ctx, ref) {
  const m = /^\s*([VvAa])\s*(\d+)\s*$/.exec(typeof ref === "string" ? ref : "");
  if (!m || Number(m[2]) < 1) throw ctx.fail("BAD_ARGS", `Track must look like "V1" or "A2" (1-based), got ${describeRef(ref)}`);
  const type = m[1].toLowerCase() === "v" ? "video" : "audio";
  const index0 = Number(m[2]) - 1;
  return { type, index0, label: (type === "video" ? "V" : "A") + (index0 + 1) };
}

// Project path of an item (walks the tree). Returns null if not found.
async function pathOfItem(ctx, item) {
  const id = itemId(item);
  if (id == null) return null;
  const all = await walk(ctx, await getRoot(ctx));
  const hit = all.find((e) => e.id === id);
  return hit ? hit.path : null;
}

module.exports = {
  normalizeName,
  normalizeMediaPath,
  splitItemPath,
  joinPath,
  itemKind,
  itemId,
  asFolder,
  asClip,
  getRoot,
  walk,
  mediaPathOf,
  resolveItem,
  resolveBin,
  resolveSequence,
  parseTrackRef,
  pathOfItem,
  guidString,
};
