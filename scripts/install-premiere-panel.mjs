#!/usr/bin/env node
// Package the Premiere UXP panel (src/premiere-uxp/) as build/premiere-mcp-bridge.ccx and, with
// --install, hand it to Adobe's Unified Plugin Installer Agent (UPIA).
//
//   npm run install-premiere-panel                 # package only (default)
//   npm run install-premiere-panel -- --install    # package, then install via UPIA
//   options: --src <plugin dir>  --out <file.ccx>  --install
//
// A .ccx is a plain ZIP of the plugin folder with manifest.json at the archive root (Adobe docs:
// "Package a UXP plugin" -> "A .ccx file is a regular ZIP file under the hood"). We write a minimal
// store-only (no compression) ZIP ourselves so the repo needs no extra dependency.
//
// UPIA usage per Adobe "Install a UXP plugin" docs: on Windows
//   "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install <ccx>
// (macOS binary takes --install). Admin rights may be required.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_SRC = path.join(repoRoot, "src", "premiere-uxp");
export const DEFAULT_OUT = path.join(repoRoot, "build", "premiere-mcp-bridge.ccx");
export const UPIA_PATHS = {
  win32: "C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe",
  darwin: "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent",
};

// ---------------------------------------------------------------------------------------------
// Minimal store-only ZIP writer (PKWARE APPNOTE 4.3: local headers, central directory, EOCD).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a store-only ZIP. entries: [{ name: "dir/file.ext" (forward slashes), data: Buffer }].
 * Returns a Buffer. No ZIP64: each file and the archive must stay under 4 GiB / 65535 entries.
 */
export function createZip(entries, { mtime = new Date() } = {}) {
  const { time, date } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const e of entries) {
    const name = String(e.name).replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.split("/").includes("..")) throw new Error(`bad zip entry name: ${e.name}`);
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const flags = 0x0800; // bit 11: names are UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by: 2.0, MS-DOS attrs
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
    if (offset > 0xffffffff) throw new Error("zip too large (no ZIP64 support)");
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(seen.size, 8);
  eocd.writeUInt16LE(seen.size, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** Recursively list files under dir as [{ name (relative, forward slashes), abs }], sorted, dotfiles skipped. */
export function collectFiles(dir) {
  const out = [];
  (function walk(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith(".")) continue;
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) out.push({ name: r, abs: a });
    }
  })(dir, "");
  return out;
}

/** Validate manifest.json at the plugin root; returns the parsed manifest. */
export function readManifest(srcDir) {
  const file = path.join(srcDir, "manifest.json");
  if (!fs.existsSync(file)) throw new Error(`manifest.json not found at ${file} (a .ccx needs it at the archive root)`);
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!m.id) throw new Error("manifest.json has no `id`");
  if (Array.isArray(m.host)) throw new Error("manifest.json `host` is an array: a .ccx can target one host only (use a single object)");
  if (!m.host || m.host.app !== "premierepro") throw new Error("manifest.json `host.app` must be \"premierepro\"");
  return m;
}

/** Package srcDir into outFile. Returns { outFile, manifest, files, bytes }. */
export function packagePlugin(srcDir = DEFAULT_SRC, outFile = DEFAULT_OUT) {
  if (!fs.existsSync(srcDir)) throw new Error(`plugin folder not found: ${srcDir}`);
  const manifest = readManifest(srcDir);
  const files = collectFiles(srcDir);
  const zip = createZip(files.map((f) => ({ name: f.name, data: fs.readFileSync(f.abs) })));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + ".tmp";
  fs.writeFileSync(tmp, zip);
  fs.renameSync(tmp, outFile);
  return { outFile, manifest, files: files.map((f) => f.name), bytes: zip.length };
}

export function findUpia(platform = process.platform) {
  const p = UPIA_PATHS[platform];
  return p && fs.existsSync(p) ? p : null;
}

/** Where UPIA unpacks a third-party plugin on Windows (seen on Premiere 26.5). */
export function installedPluginDir(manifest, appData = process.env.APPDATA || "") {
  return path.join(appData, "Adobe", "UXP", "Plugins", "External", `${manifest.id}_${manifest.version}`);
}

/**
 * UPIA installs a new version beside the old one and leaves both "enabled" in
 * %APPDATA%\Adobe\UXP\PluginsInfo\v1\premierepro.json; Premiere then may load the old one. Returns a copy of
 * that registry without other versions of pluginId, plus the removed entries. Never touches other plugins.
 */
export function pruneOlderRegistrations(info, pluginId, keepVersion) {
  const plugins = Array.isArray(info && info.plugins) ? info.plugins : [];
  const removed = plugins.filter((p) => p && p.pluginId === pluginId && p.versionString !== keepVersion);
  return { info: { ...info, plugins: plugins.filter((p) => !removed.includes(p)) }, removed };
}

/**
 * Files whose installed copy differs from srcDir (missing or different bytes). UPIA reports success
 * but keeps the old files when the manifest version is unchanged, so check after every install.
 */
export function staleInstalledFiles(srcDir, installedDir) {
  if (!fs.existsSync(installedDir)) return ["(plugin folder missing: " + installedDir + ")"];
  return collectFiles(srcDir)
    .filter((f) => {
      const inst = path.join(installedDir, ...f.name.split("/"));
      return !fs.existsSync(inst) || !fs.readFileSync(inst).equals(fs.readFileSync(f.abs));
    })
    .map((f) => f.name);
}

function printFallback(ccx) {
  console.log(`
Manual install options:
  1. Double-click ${ccx}
     (Creative Cloud Desktop opens and asks to confirm a plugin not from the Marketplace.)
  2. Development: enable Developer Mode in Premiere (Settings > Plugins), then in the UXP Developer
     Tool use "Add Plugin" on src/premiere-uxp/manifest.json and "Load". Dev-loaded plugins must be
     re-loaded after each Premiere restart.
Then open the panel from Window > UXP Plugins > MCP Bridge.`);
}

function premiereIsRunning() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Adobe Premiere Pro.exe", "/NH"], { encoding: "utf8" });
  return /Adobe Premiere Pro\.exe/i.test(r.stdout || "");
}

/**
 * Remove other versions of our plugin from Premiere's UXP plugin registry and delete their folders.
 * Only while Premiere is closed (it rewrites the registry on exit). The registry is backed up first.
 */
function pruneOlderInstalls(manifest, appData = process.env.APPDATA || "") {
  const registry = path.join(appData, "Adobe", "UXP", "PluginsInfo", "v1", "premierepro.json");
  if (!fs.existsSync(registry)) return 0;
  const info = JSON.parse(fs.readFileSync(registry, "utf8"));
  const { info: pruned, removed } = pruneOlderRegistrations(info, manifest.id, manifest.version);
  if (!removed.length) {
    console.log("No older registrations of this plugin.");
    return 0;
  }
  const names = removed.map((p) => p.versionString).join(", ");
  if (premiereIsRunning()) {
    console.error(`Older versions are still registered (${names}) and Premiere may load one of them. ` +
      "Quit Premiere, then run: npm run install-premiere-panel -- --prune-only");
    return 1;
  }
  const backup = `${registry}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(registry, backup);
  const tmp = registry + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pruned));
  fs.renameSync(tmp, registry);
  for (const p of removed) {
    const dir = installedPluginDir({ id: manifest.id, version: p.versionString }, appData);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Removed older registrations (${names}); registry backed up to ${backup}.`);
  return 0;
}

function main(argv) {
  const opts = { src: DEFAULT_SRC, out: DEFAULT_OUT, install: false, pruneOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install") opts.install = true;
    else if (a === "--prune-only") opts.pruneOnly = true;
    else if (a === "--src") opts.src = path.resolve(argv[++i]);
    else if (a === "--out") opts.out = path.resolve(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/install-premiere-panel.mjs [--install | --prune-only] [--src <dir>] [--out <file.ccx>]");
      return 0;
    } else {
      console.error(`unknown option ${a}`);
      return 2;
    }
  }

  if (opts.pruneOnly) {
    if (process.platform !== "win32") return 0;
    return pruneOlderInstalls(readManifest(opts.src));
  }

  let res;
  try {
    res = packagePlugin(opts.src, opts.out);
  } catch (e) {
    console.error(`Packaging failed: ${e.message}`);
    return 1;
  }
  console.log(`Packaged ${res.manifest.id} v${res.manifest.version || "?"} (${res.files.length} files, ${res.bytes} bytes) -> ${res.outFile}`);

  if (!opts.install) {
    console.log("Package only. Re-run with --install to install through Adobe's UPIA.");
    printFallback(res.outFile);
    return 0;
  }

  const upia = findUpia();
  if (!upia) {
    console.error(`UPIA not found${UPIA_PATHS[process.platform] ? ` at ${UPIA_PATHS[process.platform]}` : ` (unsupported platform ${process.platform})`}.`);
    printFallback(res.outFile);
    return 1;
  }
  const flag = process.platform === "win32" ? "/install" : "--install";
  console.log(`Installing via UPIA: "${upia}" ${flag} "${res.outFile}"`);
  const r = spawnSync(upia, [flag, res.outFile], { encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error || r.status !== 0) {
    console.error(`UPIA failed (${r.error ? r.error.message : `exit ${r.status}`}). Admin rights may be required.`);
    printFallback(res.outFile);
    return 1;
  }
  if (process.platform === "win32") {
    const dir = installedPluginDir(res.manifest);
    const stale = staleInstalledFiles(opts.src, dir);
    if (stale.length) {
      console.error(`UPIA reported success, but the installed copy at ${dir} does not match the package ` +
        `(${stale.length} file(s), e.g. ${stale.slice(0, 3).join(", ")}). UPIA keeps the old files when the ` +
        `version is unchanged: bump "version" in src/premiere-uxp/manifest.json (now ${res.manifest.version}) and run again.`);
      return 1;
    }
    console.log(`Verified: installed files at ${dir} match the package.`);
    if (pruneOlderInstalls(res.manifest) !== 0) return 1;
  }
  console.log("Installed. Restart Premiere if it was running, then open Window > UXP Plugins > MCP Bridge.");
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
