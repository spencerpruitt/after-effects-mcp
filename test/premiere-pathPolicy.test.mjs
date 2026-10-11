// Unit tests for the Premiere UXP panel's path policy (src/premiere-uxp/lib/pathPolicy.js).
// Same normalize/isInside semantics as the AE MCPPathPolicy, but isInside takes (child, folder)
// per the cross-stream contract, and scanCode uses the Premiere blocked list (spec section 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { normalize, isInside, scanCode, PANEL_MODULES, stripLongPathPrefix } = require("../src/premiere-uxp/lib/pathPolicy.js");
const fs = require("fs");
const nodePath = require("path");

const SHOT = "D:\\Projects\\MyFilm\\edit\\SH010";

test("normalize: canonical form", () => {
  assert.equal(normalize("F:\\A\\B"), "f:/a/b");
  assert.equal(normalize("f:/a/b/"), "f:/a/b");
  assert.equal(normalize("F:/a//b\\.\\c"), "f:/a/b/c");
  assert.equal(normalize("F:\\a\\b\\..\\c"), "f:/a/c");
  assert.equal(normalize("F:"), "f:/");
  assert.equal(normalize("F:\\"), "f:/");
  assert.equal(normalize("/d/Projects/MyFilm/shots/SH010"), "d:/projects/myfilm/shots/sh010");
  assert.equal(normalize("\\\\Server\\Share\\x"), "//server/share/x");
});

test("normalize: rejects relative, empty, null, non-strings and escapes above root", () => {
  for (const bad of [null, undefined, "", "a\\b", "..\\x", "./x", "F:\\..", "F:\\a\\..\\..\\b", "file:/C:/x", "plugin-data:/x"]) {
    assert.equal(normalize(bad), null, `expected null for ${String(bad)}`);
  }
});

const cases = [
  ["the folder itself", SHOT, true],
  ["folder with trailing slash", SHOT + "\\", true],
  ["direct child", SHOT + "\\out.mp4", true],
  ["nested subfolder", SHOT + "\\exports\\v1\\frame.png", true],
  ["mixed separators", SHOT.replace(/\\/g, "/") + "/x.js", true],
  ["drive-letter and name case", SHOT.toUpperCase().replace("D:", "d:") + "\\x.js", true],
  ["dot segments that stay inside", SHOT + "\\a\\.\\..\\x.js", true],
  ["prefix collision SH010b", SHOT + "b\\x.js", false],
  ["sibling shot", SHOT.replace("SH010", "SH020") + "\\x.js", false],
  [".. escape to parent", SHOT + "\\..\\x.js", false],
  [".. escape then back in by name", SHOT + "\\..\\SH010\\x.js", true],
  ["deep .. escape", SHOT + "\\a\\..\\..\\..\\MyFilm.prproj", false],
  ["parent folder", "D:\\Projects\\MyFilm\\edit", false],
  ["other drive", "C:\\Projects\\MyFilm\\edit\\SH010\\x", false],
  ["UNC path", "\\\\nas\\share\\SH010\\x", false],
  ["relative path", "SH010\\x.js", false],
  ["empty", "", false],
  ["null", null, false],
];

for (const [name, candidate, expected] of cases) {
  test(`isInside(child, folder): ${name}`, () => {
    assert.equal(isInside(candidate, SHOT), expected);
  });
}

test("isInside: unset or invalid folder allows nothing", () => {
  assert.equal(isInside(SHOT + "\\x", null), false);
  assert.equal(isInside(SHOT + "\\x", ""), false);
  assert.equal(isInside("relative\\x", "relative"), false);
});

test("isInside: drive root folder and UNC folder", () => {
  assert.equal(isInside("D:\\anything\\x", "D:\\"), true);
  assert.equal(isInside("E:\\anything\\x", "D:\\"), false);
  assert.equal(isInside("//nas/share/shots/a.txt", "\\\\NAS\\Share\\Shots"), true);
  assert.equal(isInside("//nas/share/shotsX/a.txt", "\\\\NAS\\Share\\Shots"), false);
});

test("scanCode: blocks the Premiere list (spec section 6)", () => {
  const blocked = [
    "globalThis.x = 1",
    "window.setTimeout(f, 1)",
    "document.getElementById('pause').checked = false",
    'eval("1+1")',
    'var x = eval ("1")',
    'new Function("return this")()',
    "const F = Function; F('x')",
    'import("fs")',
    "const { localFileSystem } = require('uxp').storage",
    "localStorage.setItem('k', 'v')",
    "sessionStorage.clear()",
    "__mcpBridge.stop()",
    "localStorage['MCPBridgeSandboxRoots']",
    "x = 'MCPBridgeSandbox:d:/a'",
    "require('uxp').shell.openPath('C:/x.bat')",
    "shell.openExternal('https://x')",
    "openPath('C:/x')",
    "require(name)",
    "require('pre' + 'mierepro')",
    "require(`fs`)",
    "require ( x )",
    "require('./core/bridge.js')",
    "require('../lib/pathPolicy.js')",
    "pathPolicy.isInside = () => true",
    "scriptRunner.run()",
    "(() => {}).constructor('return this')()",
    "x['constructor']['constructor']('code')",
    "Object.getPrototypeOf(async function(){}).constructor('x')",
    "setTimeout('alert(1)', 10)",
    "setInterval(\"x()\", 10)",
    "self.localStorage",
    "global.process",
    "indexedDB.open('x')",
  ];
  for (const code of blocked) assert.notEqual(scanCode(code), null, code);
});

test("scanCode: returns a reason string", () => {
  assert.equal(typeof scanCode("eval('x')"), "string");
});

test("scanCode: allows ordinary Premiere script code", () => {
  const allowed = [
    "const ppro = require('premierepro'); return 1;",
    'const fs = require("fs"); await fs.writeFile(sandbox.path("a.txt"), "x");',
    "const os = require('os'); return os.platform();",
    "const items = await (await project.getRootItem()).getItems(); return items.length;",
    "await sandbox.transaction('rename', (compound) => { compound.addAction(a); });",
    "await sandbox.saveAs('cut2.prproj')",
    "await sandbox.export(seq, 'out.mp4', 'C:/presets/h264.epr')",
    "var retrieval = 1; layer.medieval(2); const evaluate = 3; const functional = 4;",
    "const windowed = 1; const documentation = 2; const shellfish = 3;",
    "return { name: project.name, path: project.path };",
    "const t = time.parseTime({ frames: 24 }, tb);",
    "setTimeout(() => done(), 10)",
    "const myself = 1; const globals = 2;",
  ];
  for (const code of allowed) assert.equal(scanCode(code), null, code);
});

test("PANEL_MODULES lists every module basename under core/, lib/ and commands/", () => {
  const uxp = nodePath.join(nodePath.dirname(require.resolve("../src/premiere-uxp/lib/pathPolicy.js")), "..");
  const names = new Set();
  for (const dir of ["core", "lib", "commands"]) {
    for (const f of fs.readdirSync(nodePath.join(uxp, dir))) if (f.endsWith(".js")) names.add(f.slice(0, -3));
  }
  assert.deepEqual([...PANEL_MODULES].sort(), [...names].sort());
  for (const n of ["bridge", "registry", "settings", "backup", "transaction", "guards", "scriptRunner", "state", "e2e", "fsx", "util", "pathPolicy", "time", "refs", "_shared"]) {
    assert.ok(PANEL_MODULES.includes(n), n);
  }
});

test("scanCode: every panel module is blocked by require or path form", () => {
  for (const n of PANEL_MODULES) {
    for (const code of [
      `require("${n}")`,
      `require('${n}.js')`,
      `require("C:/plugins/mcp/core/${n}.js")`,
      `const p = "lib/${n}"`,
      `const p = "commands\\\\${n}.js"`,
    ]) assert.notEqual(scanCode(code), null, code);
  }
});

test("scanCode: words that are also panel module names stay allowed in user code", () => {
  const allowed = [
    "const state = await seq.getSettings(); return state;",
    "const t = time.parseTime({ frames: 24 }, tb); const timebase = 1;",
    "sandbox.log('state'); sandbox.log(\"time\"); const refs = []; const settings = {}; let backup = null;",
    "const util = 1; const transaction = 2; const guards = []; const registry = new Map();",
    "await sandbox.transaction('bridge cut', (compound) => {});",
    "const p = sandbox.path('renders/time/state.mov');",
    "return { state: 'ok', time: 3, index: 0 };",
  ];
  for (const code of allowed) assert.equal(scanCode(code), null, code);
});

// Built with "\\" escapes: LONG = \\?\ , DEV = \\.\ , UNC_LONG = \\?\UNC\
const LONG = "\\\\?\\";
const DEV = "\\\\.\\";
const UNC_LONG = "\\\\?\\UNC\\";

test("normalize: Windows long-path prefix (Premiere 26.5 reports project paths this way)", () => {
  assert.equal(LONG.length, 4);
  assert.equal(normalize(LONG + "D:\\Projects\\MyFilm\\edit\\Cut.prproj"), "d:/projects/myfilm/edit/cut.prproj");
  assert.equal(normalize(UNC_LONG + "server\\share\\Cut.prproj"), "//server/share/cut.prproj");
  assert.equal(normalize(DEV + "D:\\a"), "d:/a");
  assert.equal(isInside(LONG + "D:\\Projects\\MyFilm\\edit\\Cut.prproj", "D:\\Projects\\MyFilm\\edit"), true);
});

test("stripLongPathPrefix: clean display paths", () => {
  assert.equal(stripLongPathPrefix(LONG + "D:\\a\\b.prproj"), "D:\\a\\b.prproj");
  assert.equal(stripLongPathPrefix(UNC_LONG + "server\\share\\x"), "\\\\server\\share\\x");
  assert.equal(stripLongPathPrefix("D:\\a"), "D:\\a");
  assert.equal(stripLongPathPrefix(""), "");
});

test("projectPathOf: Premiere Project paths come back without the long-path prefix", () => {
  const { projectPathOf } = require("../src/premiere-uxp/core/util.js");
  assert.equal(projectPathOf({ path: LONG + "D:\\Projects\\MyFilm\\edit\\Cut.prproj" }), "D:\\Projects\\MyFilm\\edit\\Cut.prproj");
  assert.equal(projectPathOf(null), "");
  assert.equal(projectPathOf({ path: "" }), "");
});
