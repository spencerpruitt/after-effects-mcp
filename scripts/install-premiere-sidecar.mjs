#!/usr/bin/env node
// Install the MCP Bridge sidecar (src/premiere-cep/, a CEP extension, spec section 8) for Premiere Pro.
//
//   npm run install-premiere-sidecar                                    # dry run: print the plan (default)
//   npm run install-premiere-sidecar -- --install                       # copy the extension
//   npm run install-premiere-sidecar -- --install --enable-debug        # also allow unsigned extensions
//   options: --src <extension dir>  --dest <extensions dir>  --csxs 12[,13]
//
// What it changes, and nothing else:
//   1. Copies src/premiere-cep to %APPDATA%\Adobe\CEP\extensions\com.mcp.premiere.sidecar (per-user CEP
//      extensions folder; an existing copy there is replaced).
//   2. With --enable-debug only: sets HKCU\Software\Adobe\CSXS.<N>\PlayerDebugMode = "1" (REG_SZ), which CEP
//      needs to load an unsigned extension. N = 12 by default: Premiere Pro 26.x ships CEP 12 (CEPHtmlEngine
//      12.0.1 in 26.5.2). Source: CEP 12 HTML Extension Cookbook, "Debugging Unsigned Extensions",
//      https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md
//      PlayerDebugMode lets every unsigned CEP extension load for this user, not only this one.
// Restart Premiere afterwards. CEP is disabled by default from Dec 2028 and removed in Dec 2029 (Adobe,
// Sept 2026), after which the sidecar tools report NEEDS_SIDECAR_UNAVAILABLE.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXTENSION_ID = "com.mcp.premiere.sidecar";
export const DEFAULT_SRC = path.join(repoRoot, "src", "premiere-cep");
export const DEFAULT_CSXS = ["12"];

export function parseArgs(argv) {
  const opts = { install: false, enableDebug: false, src: DEFAULT_SRC, dest: null, csxs: DEFAULT_CSXS.slice(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install") opts.install = true;
    else if (a === "--enable-debug") opts.enableDebug = true;
    else if (a === "--dry-run") opts.install = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--src") opts.src = argv[++i];
    else if (a === "--dest") opts.dest = argv[++i];
    else if (a === "--csxs") {
      opts.csxs = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!opts.csxs.length || opts.csxs.some((v) => !/^\d{1,2}$/.test(v))) throw new Error("--csxs takes versions like 12 or 12,13");
    } else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

export function extensionsDir(appData = process.env.APPDATA || "") {
  if (!appData) throw new Error("APPDATA is not set; pass --dest <extensions dir>.");
  return path.join(appData, "Adobe", "CEP", "extensions");
}

// Every file under dir, relative, with "/" separators, sorted.
export function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  })(dir, "");
  return out.sort();
}

// The plan: [{ kind: "copy" | "remove" | "registry", ... }]. Pure apart from reading src and checking dest.
export function buildPlan(opts, env = process.env) {
  if (!fs.existsSync(path.join(opts.src, "CSXS", "manifest.xml"))) {
    throw new Error(`No CSXS/manifest.xml under ${opts.src}`);
  }
  const parent = opts.dest || extensionsDir(env.APPDATA || "");
  const target = path.join(parent, EXTENSION_ID);
  const steps = [];
  if (fs.existsSync(target)) steps.push({ kind: "remove", path: target });
  steps.push({ kind: "copy", from: opts.src, to: target, files: listFiles(opts.src) });
  if (opts.enableDebug) {
    for (const v of opts.csxs) {
      steps.push({ kind: "registry", key: `HKCU\\Software\\Adobe\\CSXS.${v}`, name: "PlayerDebugMode", type: "REG_SZ", value: "1" });
    }
  }
  return { target, steps };
}

export function formatPlan(plan, { install }) {
  const lines = [install ? "Installing the MCP Bridge sidecar:" : "Dry run (nothing is changed; pass --install to do this):"];
  let n = 1;
  for (const s of plan.steps) {
    if (s.kind === "remove") lines.push(`  ${n++}. Remove the existing copy: ${s.path}`);
    else if (s.kind === "copy") {
      lines.push(`  ${n++}. Copy ${s.files.length} files from ${s.from}`);
      lines.push(`     to ${s.to}`);
      for (const f of s.files) lines.push(`       ${f}`);
    } else if (s.kind === "registry") {
      lines.push(`  ${n++}. Registry: set ${s.key}  ${s.name} = "${s.value}" (${s.type})`);
      lines.push(`     = reg add "${s.key}" /v ${s.name} /t ${s.type} /d ${s.value} /f`);
    }
  }
  if (!plan.steps.some((s) => s.kind === "registry")) {
    lines.push("  (No registry change. Unsigned CEP extensions only load with PlayerDebugMode=1: add --enable-debug,");
    lines.push("   which sets HKCU\\Software\\Adobe\\CSXS.12 PlayerDebugMode = \"1\" for every unsigned extension of this user.)");
  }
  lines.push("Then restart Premiere Pro, open Window > Extensions (Legacy) > MCP Sidecar once, and keep the MCP Bridge panel open.");
  return lines.join("\n");
}

export function applyPlan(plan, { run = spawnSync, log = console.log } = {}) {
  for (const s of plan.steps) {
    if (s.kind === "remove") {
      fs.rmSync(s.path, { recursive: true, force: true });
      log(`Removed ${s.path}`);
    } else if (s.kind === "copy") {
      fs.mkdirSync(path.dirname(s.to), { recursive: true });
      fs.cpSync(s.from, s.to, { recursive: true });
      log(`Copied to ${s.to}`);
    } else if (s.kind === "registry") {
      const r = run("reg", ["add", s.key, "/v", s.name, "/t", s.type, "/d", s.value, "/f"], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`reg add ${s.key} failed: ${(r.stderr || r.stdout || "").trim()}`);
      log(`Set ${s.key} ${s.name} = "${s.value}"`);
    }
  }
}

export function main(argv, { env = process.env, out = console.log, err = console.error, run, platform = process.platform } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(String(e.message || e));
    return 2;
  }
  if (opts.help) {
    out("Usage: npm run install-premiere-sidecar [-- --install] [--enable-debug] [--csxs 12[,13]] [--src dir] [--dest dir]");
    return 0;
  }
  if (opts.enableDebug && platform !== "win32" && opts.install) {
    err("--enable-debug writes the Windows registry; on macOS run: defaults write com.adobe.CSXS.12 PlayerDebugMode 1");
    return 2;
  }
  let plan;
  try {
    plan = buildPlan(opts, env);
  } catch (e) {
    err(String(e.message || e));
    return 1;
  }
  out(formatPlan(plan, opts));
  if (!opts.install) return 0;
  try {
    applyPlan(plan, { run, log: out });
  } catch (e) {
    err(`Install failed: ${e.message || e}`);
    return 1;
  }
  out("Done.");
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
