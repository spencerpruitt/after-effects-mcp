// Unit tests for the bridge panel's path policy. The module is pure ES3 and lives inside the panel
// between BEGIN/END PATH POLICY markers, so we extract that exact text and evaluate it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(path.join(here, "..", "src", "scripts", "mcp-bridge-auto.jsx"), "utf8");
const match = /\/\/ === BEGIN PATH POLICY ===([\s\S]*?)\/\/ === END PATH POLICY ===/.exec(panelSource);
if (!match) throw new Error("PATH POLICY markers not found in mcp-bridge-auto.jsx");
const { normalize, isInside, scanCode } = new Function(match[1] + "\nreturn MCPPathPolicy;")();

const SHOT = "D:\\Projects\\MyFilm\\shots\\SH010";

test("normalize: canonical form", () => {
  assert.equal(normalize("F:\\A\\B"), "f:/a/b");
  assert.equal(normalize("f:/a/b/"), "f:/a/b");
  assert.equal(normalize("F:/a//b\\.\\c"), "f:/a/b/c");
  assert.equal(normalize("F:\\a\\b\\..\\c"), "f:/a/c");
  assert.equal(normalize("F:"), "f:/");
  assert.equal(normalize("/d/Projects/MyFilm"), "d:/projects/myfilm");
  assert.equal(normalize("\\\\Server\\Share\\x"), "//server/share/x");
});

test("normalize: rejects relative, empty, null and escapes above root", () => {
  for (const bad of [null, undefined, "", "a\\b", "..\\x", "./x", "F:\\..", "F:\\a\\..\\..\\b"]) {
    assert.equal(normalize(bad), null, `expected null for ${String(bad)}`);
  }
});

const cases = [
  ["the folder itself", SHOT, true],
  ["folder with trailing slash", SHOT + "\\", true],
  ["direct child", SHOT + "\\out.png", true],
  ["nested subfolder", SHOT + "\\renders\\v1\\frame.png", true],
  ["mixed separators", SHOT.replace(/\\/g, "/") + "/x.jsx", true],
  ["drive-letter and name case", SHOT.toUpperCase().replace("D:", "d:") + "\\x.jsx", true],
  ["dot segments that stay inside", SHOT + "\\a\\.\\..\\x.jsx", true],
  ["prefix collision SH010b", SHOT + "b\\x.jsx", false],
  ["sibling shot", SHOT.replace("SH010", "SH020") + "\\x.jsx", false],
  [".. escape to parent", SHOT + "\\..\\x.jsx", false],
  [".. escape then back in by name", SHOT + "\\..\\SH010\\x.jsx", true],
  ["deep .. escape", SHOT + "\\a\\..\\..\\..\\MyFilm.aep", false],
  ["parent folder", "D:\\Projects\\MyFilm\\shots", false],
  ["other drive", "C:\\Projects\\MyFilm\\shots\\SH010\\x", false],
  ["UNC path", "\\\\nas\\share\\SH010\\x", false],
  ["relative path", "SH010\\x.jsx", false],
  ["empty", "", false],
  ["null", null, false],
];

for (const [name, candidate, expected] of cases) {
  test(`isInside: ${name}`, () => {
    assert.equal(isInside(SHOT, candidate), expected);
  });
}

test("isInside: unset or invalid folder allows nothing", () => {
  assert.equal(isInside(null, SHOT + "\\x"), false);
  assert.equal(isInside("", SHOT + "\\x"), false);
  assert.equal(isInside("relative", "relative\\x"), false);
});

test("isInside: UNC folder", () => {
  assert.equal(isInside("\\\\NAS\\Share\\Shots", "//nas/share/shots/a.txt"), true);
  assert.equal(isInside("\\\\NAS\\Share\\Shots", "//nas/share/shotsX/a.txt"), false);
});

test("scanCode: blocks calls that can't be intercepted", () => {
  const blocked = [
    'system.callSystem("cmd")',
    'app.project.save(new File("C:/x.aep"))',
    "app.project.renderQueue.render()",
    "rq.queueInAME(true)",
    'comp.saveFrameToPng(0, new File("x.png"))',
    'new File("x.bat").execute()',
    'app.settings.saveSetting("MCPBridgeSandbox", "k", "C:/")',
    "restoreWriteGuards(saved)",
    "pauseCheckbox.value = false",
    "__mcpBridgeCheck = null",
    '$.evalFile(sandbox.path("lib.jsx"))',
    '#include "lib.jsx"',
    'eval("1+1")',
    'var x = eval ("1")',
  ];
  for (const code of blocked) assert.notEqual(scanCode(code), null, code);
});

test("scanCode: allows plain saves, sandbox helpers and ordinary code", () => {
  const allowed = [
    "app.project.save()",
    "app.project.save( )",
    'sandbox.saveAs("x.aep")',
    "sandbox.render()",
    'sandbox.saveFrameToPng(comp, 0, "f.png")',
    "app.executeCommand(2004)",
    "var retrieval = 1; layer.medieval(2);",
    'var c = app.project.items.addComp("A", 1920, 1080, 1, 5, 24); return c.name;',
  ];
  for (const code of allowed) assert.equal(scanCode(code), null, code);
});
