#!/usr/bin/env node
// Pre-publish scrub gate: `npm run scrub-check -- [ref]` (default ref: public-scrub).
//
// Greps every file in the tree of <ref> (git ls-tree -r + git show <ref>:<path>, i.e. exactly what
// `git archive <ref>` would ship), every path name, and the metadata of every commit reachable from
// <ref> but not from fork/main (all commits if fork/main doesn't exist) -- author/committer names and
// emails plus the full message -- against the regexes in `.scrub-denylist`.
//
// The denylist is untracked (listed in .git/info/exclude) so the patterns themselves never get
// published. Lookup order: --denylist <file>, $SCRUB_DENYLIST, <worktree>/.scrub-denylist,
// <main checkout>/.scrub-denylist (the folder holding the shared .git, so all worktrees use one list).
// Format: one JavaScript regex per line, matched case-insensitively; blank lines and `#` comments
// are ignored. A missing or empty denylist fails closed.
//
// Exit codes: 0 clean, 1 hits found, 2 could not check (denylist missing/invalid/tracked by git, bad ref, git error).
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

export const DEFAULT_REF = "public-scrub";
export const BASE_REF = "fork/main";

export class ScrubError extends Error {}

/** Parse denylist text into [{ source, re, line }]. Throws ScrubError on an invalid regex or no patterns. */
export function parseDenylist(text, label = ".scrub-denylist") {
  const patterns = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let re;
    try {
      re = new RegExp(line, "i");
    } catch (e) {
      throw new ScrubError(`${label}:${i + 1}: invalid regex ${JSON.stringify(line)}: ${e.message}`);
    }
    patterns.push({ source: line, re, line: i + 1 });
  });
  if (patterns.length === 0) throw new ScrubError(`${label} has no patterns: refusing`);
  return patterns;
}

/** Load the denylist from disk; missing file => ScrubError("denylist missing: refusing"). */
export function loadDenylist(file) {
  if (!file || !fs.existsSync(file)) {
    throw new ScrubError(`denylist missing: refusing${file ? ` (looked for ${file})` : ""}`);
  }
  return parseDenylist(fs.readFileSync(file, "utf8"), file);
}

/**
 * Scan text against patterns. Returns hits [{ where, line, pattern, excerpt }], one per (line, pattern).
 * `where` is a label such as a file path or "commit abc1234 author".
 */
export function scanText(text, patterns, where) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const p of patterns) {
      const m = p.re.exec(ln);
      if (m) hits.push({ where, line: i + 1, pattern: p.source, excerpt: excerptAround(ln, m.index, m[0].length) });
    }
  }
  return hits;
}

function excerptAround(line, index, len) {
  const start = Math.max(0, index - 30);
  const end = Math.min(line.length, index + len + 30);
  return (start > 0 ? "..." : "") + line.slice(start, end).replace(/[\x00-\x08\x0b-\x1f]/g, "?") + (end < line.length ? "..." : "");
}

/** Format hits as `file:line: /pattern/ excerpt` lines. */
export function formatHits(hits) {
  return hits.map((h) => `${h.where}:${h.line}: /${h.pattern}/ ${h.excerpt}`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// git plumbing

function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: opts.encoding === null ? undefined : "utf8", maxBuffer: 512 * 1024 * 1024, cwd: opts.cwd });
  if (r.error) throw new ScrubError(`git ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    const err = Buffer.isBuffer(r.stderr) ? r.stderr.toString("utf8") : r.stderr;
    throw new ScrubError(`git ${args.join(" ")} failed: ${String(err).trim()}`);
  }
  return r;
}

function refExists(ref, cwd) {
  return git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, allowFail: true }).status === 0;
}

/** Default denylist candidates for the current repo/worktree. */
export function denylistCandidates(cwd) {
  const out = [];
  const top = git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  if (top.status === 0) out.push(path.join(top.stdout.trim(), ".scrub-denylist"));
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, allowFail: true });
  if (common.status === 0) out.push(path.join(path.dirname(common.stdout.trim()), ".scrub-denylist"));
  return [...new Set(out)];
}

/**
 * The denylist must never be committed: its patterns are the private strings being scrubbed. Throws
 * ScrubError when git tracks it (`git ls-files --error-unmatch`, run in the file's own folder so a list
 * in the main checkout is checked against that repo). A file outside any repo passes.
 */
export function assertDenylistUntracked(file) {
  const r = git(["ls-files", "--error-unmatch", "--", path.basename(file)], { cwd: path.dirname(file), allowFail: true });
  if (r.status === 0) {
    throw new ScrubError(`denylist is tracked by git: refusing (${file}). Run \`git rm --cached ${path.basename(file)}\` and list it in .git/info/exclude.`);
  }
}

/** Every blob in <ref>: [{ path, text }] (binary blobs decoded as latin1 so byte patterns still match). */
function* treeFiles(ref, cwd) {
  const ls = git(["ls-tree", "-r", "-z", "--full-tree", ref], { cwd });
  for (const rec of ls.stdout.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [, type] = rec.slice(0, tab).split(" ");
    const file = rec.slice(tab + 1);
    if (type !== "blob") continue; // submodules (commit) are skipped
    const show = git(["show", `${ref}:${file}`], { cwd, encoding: null });
    const buf = show.stdout;
    const binary = buf.subarray(0, 8000).includes(0);
    yield { path: file, text: buf.toString(binary ? "latin1" : "utf8") };
  }
}

/** Commits to check: reachable from ref, not from fork/main when that exists. */
function commitsToCheck(ref, cwd) {
  const range = refExists(BASE_REF, cwd) ? [ref, "--not", BASE_REF] : [ref];
  const r = git(["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", ...range], { cwd });
  return r.stdout
    .split("\x1e")
    .map((s) => s.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((s) => {
      const [hash, an, ae, cn, ce, body] = s.split("\0");
      return { hash, an, ae, cn, ce, body: body || "" };
    });
}

/** Run the full check. Returns { hits, files, commits, base }. */
export function runScrubCheck({ ref = DEFAULT_REF, patterns, cwd } = {}) {
  if (!refExists(ref, cwd)) throw new ScrubError(`ref not found: ${ref}`);
  const hits = [];
  let files = 0;
  for (const f of treeFiles(ref, cwd)) {
    files++;
    hits.push(...scanText(f.path, patterns, `${ref}:${f.path} (path name)`).map((h) => ({ ...h, line: 0 })));
    hits.push(...scanText(f.text, patterns, `${ref}:${f.path}`));
  }
  const commits = commitsToCheck(ref, cwd);
  for (const c of commits) {
    const id = `commit ${c.hash.slice(0, 10)}`;
    hits.push(...scanText(`${c.an} <${c.ae}>`, patterns, `${id} author`));
    hits.push(...scanText(`${c.cn} <${c.ce}>`, patterns, `${id} committer`));
    hits.push(...scanText(c.body, patterns, `${id} message`));
  }
  return { hits, files, commits: commits.length, base: refExists(BASE_REF, cwd) ? BASE_REF : null };
}

function parseArgs(argv) {
  const opts = { ref: DEFAULT_REF, denylist: process.env.SCRUB_DENYLIST || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--denylist") opts.denylist = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new ScrubError(`unknown option ${a}`);
    else opts.ref = a;
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log("usage: node scripts/scrub-check.mjs [ref=public-scrub] [--denylist <file>]");
      return 0;
    }
    const file = opts.denylist || denylistCandidates().find((f) => fs.existsSync(f)) || denylistCandidates()[0];
    const patterns = loadDenylist(file);
    assertDenylistUntracked(file);
    const { hits, files, commits, base } = runScrubCheck({ ref: opts.ref, patterns });
    const scope = `${files} files in ${opts.ref}, ${commits} commit(s) ${base ? `not in ${base}` : "(all history; fork/main not found)"}, ${patterns.length} pattern(s)`;
    if (hits.length) {
      console.error(formatHits(hits));
      console.error(`\nscrub-check FAILED: ${hits.length} hit(s) — ${scope}`);
      return 1;
    }
    console.log(`scrub-check OK — ${scope}`);
    return 0;
  } catch (e) {
    console.error(`scrub-check: ${e instanceof ScrubError ? e.message : e.stack || e}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = main();
