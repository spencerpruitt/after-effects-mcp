// Unit tests for the Premiere tooling scripts: the .ccx (store-only zip) writer and the scrub-check matcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { crc32, createZip, collectFiles, packagePlugin, readManifest, staleInstalledFiles, installedPluginDir, pruneOlderRegistrations } from "../scripts/install-premiere-panel.mjs";
import { parseDenylist, loadDenylist, scanText, formatHits, runScrubCheck, ScrubError, assertDenylistUntracked } from "../scripts/scrub-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scrubScript = path.join(here, "..", "scripts", "scrub-check.mjs");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Independent zip reader: EOCD -> central directory -> local headers. Returns [{ name, data, crc, method }]. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, "EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd, "central directory must end at EOCD");
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central header signature");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, "local header signature");
    assert.equal(buf.toString("utf8", lho + 30, lho + 30 + buf.readUInt16LE(lho + 26)), name, "local/central names agree");
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    assert.equal(csize, usize, "store-only: sizes equal");
    out.push({ name, method, crc, data: buf.subarray(dataStart, dataStart + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function writePluginFixture(dir) {
  fs.mkdirSync(path.join(dir, "core"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "test.plugin", version: "1.0.0", host: { app: "premierepro", minVersion: "25.6" } }));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><p>hé</p>");
  fs.writeFileSync(path.join(dir, "core", "gate.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
}

// ---------------------------------------------------------------------------------------------
// zip / ccx

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("createZip output reads back: names, data, CRCs, store method", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"id":"x"}') },
    { name: "lib/ünï.js", data: Buffer.from("// utf8 name\n") },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const parsed = readZip(createZip(entries));
  assert.deepEqual(parsed.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) {
    assert.equal(parsed[i].method, 0);
    assert.deepEqual(Buffer.from(parsed[i].data), entries[i].data);
    assert.equal(parsed[i].crc, crc32(entries[i].data));
  }
});

test("createZip rejects unsafe or duplicate names", () => {
  assert.throws(() => createZip([{ name: "../x", data: "" }]), /bad zip entry/);
  assert.throws(() => createZip([{ name: "/abs", data: "" }]), /bad zip entry/);
  assert.throws(() => createZip([{ name: "a", data: "" }, { name: "a", data: "" }]), /duplicate/);
});

test("packagePlugin puts manifest.json at the archive root and skips dotfiles", () => {
  const dir = tempDir("pr-ccx-src-");
  const out = path.join(tempDir("pr-ccx-out-"), "nested", "plugin.ccx");
  try {
    writePluginFixture(dir);
    const res = packagePlugin(dir, out);
    assert.equal(res.manifest.id, "test.plugin");
    const parsed = readZip(fs.readFileSync(out));
    const names = parsed.map((e) => e.name).sort();
    assert.deepEqual(names, ["core/gate.js", "index.html", "manifest.json"]);
    assert.equal(parsed.find((e) => e.name === "index.html").data.toString("utf8"), "<!doctype html><p>hé</p>");
    assert.deepEqual(collectFiles(dir).map((f) => f.name), ["core/gate.js", "index.html", "manifest.json"]);
    assert.equal(fs.existsSync(out + ".tmp"), false);

    // Cross-check with Windows' bundled bsdtar, which reads zip archives (GNU tar does not).
    const bsdtar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : null;
    if (bsdtar && fs.existsSync(bsdtar)) {
      const r = spawnSync(bsdtar, ["-tf", out], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).sort(), names);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(path.dirname(out)), { recursive: true, force: true });
  }
});

test("readManifest validates id and a single premierepro host", () => {
  const dir = tempDir("pr-ccx-man-");
  try {
    assert.throws(() => readManifest(dir), /manifest\.json not found/);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "a", host: [{ app: "premierepro" }] }));
    assert.throws(() => readManifest(dir), /array/);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ host: { app: "premierepro" } }));
    assert.throws(() => readManifest(dir), /no `id`/);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "a", host: { app: "ps" } }));
    assert.throws(() => readManifest(dir), /premierepro/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// scrub-check matcher

const SAMPLE_DENYLIST = [
  "# comment line",
  "",
  "Q:[\\\\/]+Secret Drive",
  "\\bzzproj\\b",
  "  \\bSH9(?:01|02)\\b  ",
].join("\n");

test("parseDenylist: skips blanks and comments, trims, case-insensitive", () => {
  const pats = parseDenylist(SAMPLE_DENYLIST);
  assert.deepEqual(pats.map((p) => p.source), ["Q:[\\\\/]+Secret Drive", "\\bzzproj\\b", "\\bSH9(?:01|02)\\b"]);
  assert.deepEqual(pats.map((p) => p.line), [3, 4, 5]);
  assert.ok(pats[1].re.test("the ZZPROJ folder"));
});

test("parseDenylist: invalid regex and empty list fail closed", () => {
  assert.throws(() => parseDenylist("ok\n(unclosed"), (e) => e instanceof ScrubError && /:2: invalid regex/.test(e.message));
  assert.throws(() => parseDenylist("# only comments\n\n"), /no patterns: refusing/);
});

test("loadDenylist: missing file refuses", () => {
  assert.throws(() => loadDenylist(path.join(os.tmpdir(), "definitely-missing-denylist-xyz")), /denylist missing: refusing/);
  assert.throws(() => loadDenylist(null), /denylist missing: refusing/);
});

test("scanText: reports 1-based line numbers per pattern, both slash styles, word boundaries", () => {
  const pats = parseDenylist(SAMPLE_DENYLIST);
  const text = [
    "clean line",
    'const p = "Q:\\\\Secret Drive\\\\shots";',
    "posix q:/secret drive/x and SH901",
    "SH9010 and zzprojects are fine",
  ].join("\r\n");
  const hits = scanText(text, pats, "src/x.js");
  assert.deepEqual(hits.map((h) => [h.line, h.pattern]), [
    [2, "Q:[\\\\/]+Secret Drive"],
    [3, "Q:[\\\\/]+Secret Drive"],
    [3, "\\bSH9(?:01|02)\\b"],
  ]);
  assert.match(formatHits(hits).split("\n")[0], /^src\/x\.js:2: \/Q:\[\\\\\/\]\+Secret Drive\/ /);
  assert.deepEqual(scanText("nothing here", pats, "f"), []);
});

test("runScrubCheck + CLI on a temp repo: tree, path names and commit metadata", () => {
  const repo = tempDir("pr-scrub-repo-");
  const g = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=Zed Tester", "-c", "user.email=zed@zzproj.example", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  try {
    g("init", "-q", "-b", "work");
    fs.mkdirSync(path.join(repo, "shots"));
    fs.writeFileSync(path.join(repo, "shots", "SH902.txt"), "line one\nsee Q:/Secret Drive/x\n");
    fs.writeFileSync(path.join(repo, "clean.txt"), "nothing\n");
    g("add", ".");
    g("commit", "-q", "-m", "Add files\n\nbody mentions SH901");
    const pats = parseDenylist(SAMPLE_DENYLIST);
    const { hits, files, commits, base } = runScrubCheck({ ref: "work", patterns: pats, cwd: repo });
    assert.equal(files, 2);
    assert.equal(commits, 1);
    assert.equal(base, null);
    const where = hits.map((h) => `${h.where}:${h.line}`).map((s) => s.replace(/commit [0-9a-f]+/, "commit X"));
    assert.ok(where.includes("work:shots/SH902.txt (path name):0"), where.join("\n"));
    assert.ok(where.includes("work:shots/SH902.txt:2"), where.join("\n"));
    assert.ok(where.includes("commit X author:1"), where.join("\n"));
    assert.ok(where.includes("commit X committer:1"), where.join("\n"));
    assert.ok(where.includes("commit X message:3"), where.join("\n"));
    assert.ok(!where.some((w) => w.startsWith("work:clean.txt")));

    // CLI: fail closed without a denylist (exit 2), exit 1 with hits, exit 0 when clean.
    const run = (...args) => spawnSync(process.execPath, [scrubScript, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, SCRUB_DENYLIST: "" } });
    let r = run("work");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /denylist missing: refusing/);
    const dl = path.join(repo, ".scrub-denylist");
    fs.writeFileSync(dl, SAMPLE_DENYLIST);
    r = run("work");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /work:shots\/SH902\.txt:2: /);
    fs.writeFileSync(dl, "\\bnever-matches-anything-qq\\b\n");
    r = run("work");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run("no-such-ref");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ref not found/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a denylist tracked by git refuses (function and CLI); an untracked one is fine", () => {
  const repo = tempDir("pr-scrub-tracked-");
  const g = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=Zed Tester", "-c", "user.email=zed@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    g("init", "-q", "-b", "work");
    fs.writeFileSync(path.join(repo, "clean.txt"), "nothing\n");
    const dl = path.join(repo, ".scrub-denylist");
    fs.writeFileSync(dl, "\bnever-matches-anything-qq\b\n");
    g("add", "clean.txt");
    g("commit", "-q", "-m", "init");
    assertDenylistUntracked(dl); // untracked: no throw
    assertDenylistUntracked(path.join(os.tmpdir(), "not-in-any-repo-denylist-xyz")); // outside a repo: no throw
    g("add", ".scrub-denylist");
    assert.throws(() => assertDenylistUntracked(dl), (e) => e instanceof ScrubError && /tracked by git/.test(e.message));
    const r = spawnSync(process.execPath, [scrubScript, "work"], { cwd: repo, encoding: "utf8", env: { ...process.env, SCRUB_DENYLIST: "" } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /tracked by git/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("staleInstalledFiles: flags missing folder, changed and missing files; empty when identical", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pr-stale-"));
  const src = path.join(base, "src");
  const inst = path.join(base, "inst");
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "manifest.json"), "{}");
  fs.writeFileSync(path.join(src, "lib", "a.js"), "new");
  assert.equal(staleInstalledFiles(src, inst).length, 1);
  fs.mkdirSync(path.join(inst, "lib"), { recursive: true });
  fs.writeFileSync(path.join(inst, "manifest.json"), "{}");
  fs.writeFileSync(path.join(inst, "lib", "a.js"), "old");
  assert.deepEqual(staleInstalledFiles(src, inst), ["lib/a.js"]);
  fs.writeFileSync(path.join(inst, "lib", "a.js"), "new");
  assert.deepEqual(staleInstalledFiles(src, inst), []);
  fs.rmSync(base, { recursive: true, force: true });
});

test("pruneOlderRegistrations: drops only older versions of our own plugin id", () => {
  const info = { plugins: [
    { pluginId: "com.mcp.premiere.bridge", versionString: "1.0.2", path: "$localPlugins\\External\\com.mcp.premiere.bridge_1.0.2" },
    { pluginId: "com.other.plugin", versionString: "0.9.0", path: "x" },
    { pluginId: "com.mcp.premiere.bridge", versionString: "1.0.3", path: "$localPlugins\\External\\com.mcp.premiere.bridge_1.0.3" },
  ] };
  const { info: out, removed } = pruneOlderRegistrations(info, "com.mcp.premiere.bridge", "1.0.3");
  assert.deepEqual(out.plugins.map((p) => p.pluginId + "@" + p.versionString), ["com.other.plugin@0.9.0", "com.mcp.premiere.bridge@1.0.3"]);
  assert.deepEqual(removed.map((p) => p.versionString), ["1.0.2"]);
  assert.equal(info.plugins.length, 3, "input not mutated");
  assert.deepEqual(pruneOlderRegistrations({ plugins: [] }, "a", "1").removed, []);
});

test("installedPluginDir: External/<id>_<version> under APPDATA", () => {
  const d = installedPluginDir({ id: "com.x.y", version: "1.2.3" }, "R");
  assert.equal(d, path.join("R", "Adobe", "UXP", "Plugins", "External", "com.x.y_1.2.3"));
});
