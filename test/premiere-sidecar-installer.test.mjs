// scripts/install-premiere-sidecar.mjs: dry run by default, prints exactly what it would change; --install
// copies; --enable-debug adds HKCU\Software\Adobe\CSXS.12 PlayerDebugMode. Nothing here touches the real
// %APPDATA% or the registry: dest is a temp folder and `reg` is a fake.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseArgs, buildPlan, formatPlan, applyPlan, main, extensionsDir, listFiles, EXTENSION_ID, DEFAULT_SRC } from "../scripts/install-premiere-sidecar.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "install-premiere-sidecar.mjs");
const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pr-sidecar-install-"));
  roots.push(d);
  return d;
}

test("parseArgs: dry run by default; flags; --csxs validation", () => {
  assert.deepEqual(parseArgs([]), { install: false, enableDebug: false, src: DEFAULT_SRC, dest: null, csxs: ["12"], help: false });
  const o = parseArgs(["--install", "--enable-debug", "--csxs", "12,13", "--dest", "X"]);
  assert.equal(o.install, true);
  assert.equal(o.enableDebug, true);
  assert.deepEqual(o.csxs, ["12", "13"]);
  assert.equal(o.dest, "X");
  assert.throws(() => parseArgs(["--csxs", "abc"]), /--csxs/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});

test("extensionsDir is the per-user CEP folder under APPDATA", () => {
  assert.equal(extensionsDir("C:\\Users\\me\\AppData\\Roaming"), path.join("C:\\Users\\me\\AppData\\Roaming", "Adobe", "CEP", "extensions"));
  assert.throws(() => extensionsDir(""), /APPDATA/);
});

test("the extension package has the manifest, panel, core and host", () => {
  const files = listFiles(DEFAULT_SRC);
  for (const f of ["CSXS/manifest.xml", "index.html", "js/core.js", "js/main.js", "host/host.jsx"]) assert.ok(files.includes(f), f);
  const manifest = fs.readFileSync(path.join(DEFAULT_SRC, "CSXS", "manifest.xml"), "utf8");
  assert.match(manifest, /ExtensionBundleId="com\.mcp\.premiere\.sidecar"/);
  assert.match(manifest, /<Host Name="PPRO" Version="\[26\.0,99\.9\]" \/>/);
  assert.match(manifest, /<ScriptPath>\.\/host\/host\.jsx<\/ScriptPath>/);
  assert.match(manifest, /--enable-nodejs/);
  assert.match(manifest, /--mixed-context/);
});

test("dry-run plan without --enable-debug: copy only, no registry change", () => {
  const appData = tempDir();
  const plan = buildPlan(parseArgs([]), { APPDATA: appData });
  assert.equal(plan.target, path.join(appData, "Adobe", "CEP", "extensions", EXTENSION_ID));
  assert.deepEqual(plan.steps.map((s) => s.kind), ["copy"]);
  const text = formatPlan(plan, { install: false });
  assert.match(text, /^Dry run \(nothing is changed; pass --install to do this\):/);
  assert.ok(text.includes(plan.target));
  assert.ok(text.includes("host/host.jsx"));
  assert.match(text, /No registry change/);
  assert.ok(!text.includes("reg add"));
});

test("dry-run plan with --enable-debug prints the exact registry change; replaces an existing copy", () => {
  const appData = tempDir();
  const target = path.join(appData, "Adobe", "CEP", "extensions", EXTENSION_ID);
  fs.mkdirSync(target, { recursive: true });
  const plan = buildPlan(parseArgs(["--enable-debug"]), { APPDATA: appData });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["remove", "copy", "registry"]);
  assert.deepEqual(plan.steps[2], { kind: "registry", key: "HKCU\\Software\\Adobe\\CSXS.12", name: "PlayerDebugMode", type: "REG_SZ", value: "1" });
  const text = formatPlan(plan, { install: false });
  assert.ok(text.includes(`Remove the existing copy: ${target}`));
  assert.ok(text.includes('Registry: set HKCU\\Software\\Adobe\\CSXS.12  PlayerDebugMode = "1" (REG_SZ)'));
  assert.ok(text.includes('reg add "HKCU\\Software\\Adobe\\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f'));
});

test("main() dry run changes nothing", () => {
  const dest = tempDir();
  const out = [];
  const code = main(["--enable-debug", "--dest", dest], { out: (l) => out.push(l), err: (l) => out.push("ERR " + l), run: () => { throw new Error("must not run reg"); } });
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(dest), []);
  assert.match(out.join("\n"), /Dry run/);
});

test("--install copies the package and runs reg add (faked)", () => {
  const dest = tempDir();
  const ran = [];
  const out = [];
  const code = main(["--install", "--enable-debug", "--csxs", "12,13", "--dest", dest], {
    out: (l) => out.push(l), err: (l) => out.push("ERR " + l), platform: "win32",
    run: (cmd, args) => { ran.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(code, 0, out.join("\n"));
  const target = path.join(dest, EXTENSION_ID);
  assert.deepEqual(listFiles(target), listFiles(DEFAULT_SRC));
  assert.deepEqual(ran, [
    ["reg", "add", "HKCU\\Software\\Adobe\\CSXS.12", "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"],
    ["reg", "add", "HKCU\\Software\\Adobe\\CSXS.13", "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"],
  ]);
  // A second install replaces the first copy.
  fs.writeFileSync(path.join(target, "stale.txt"), "x");
  assert.equal(main(["--install", "--dest", dest], { out: () => {}, err: () => {} }), 0);
  assert.equal(fs.existsSync(path.join(target, "stale.txt")), false);
});

test("a failing reg add is reported", () => {
  const dest = tempDir();
  const plan = buildPlan(parseArgs(["--enable-debug", "--dest", dest]));
  assert.throws(() => applyPlan(plan, { run: () => ({ status: 1, stderr: "Access is denied." }), log: () => {} }), /Access is denied/);
});

test("the CLI defaults to a dry run", () => {
  const dest = tempDir();
  const r = spawnSync(process.execPath, [script, "--dest", dest], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run/);
  assert.deepEqual(fs.readdirSync(dest), []);
});
