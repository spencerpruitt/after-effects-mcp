// Tests for the fake premierepro model itself. The model lives in premiere-fakeppro.mjs (shared with the
// command-module tests and the e2e dry run); it is re-exported here for older imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmd, commands, makeCtx, standardProject } from "./premiere-fakeppro.mjs";

export * from "./premiere-fakeppro.mjs";

test("fake ppro enforces lock rules", async () => {
  const fake = standardProject();
  const ctx = makeCtx(fake);
  assert.throws(() => fake.root.createBinAction("x", false), /outside lockedAccess/);
  await assert.rejects(ctx.transaction("x", async () => {}), /synchronous/);
  await ctx.transaction("ok", (c) => c.addAction(fake.root.createBinAction("New", false)));
  assert.ok(fake.root.children.some((c) => c.name === "New"));
});

test("commands/index exports every typed command once", () => {
  const names = commands.map((c) => c.name);
  assert.deepEqual(names.sort(), [
    "addMarkers", "addTransition", "buildSequence", "createProject", "createSequence", "editItems", "exportSequence",
    "getProjectItems", "getSequence", "importAEComps", "importFiles", "openProject", "placeAudio", "replaceMedia", "saveProject", "setAudio", "setSpeed",
  ]);
  for (const c of commands) {
    assert.equal(typeof c.run, "function");
    assert.equal(typeof c.mutating, "boolean");
    assert.equal(c.targetless, ["createProject", "openProject"].includes(c.name), c.name);
  }
  const readOnly = commands.filter((c) => !c.mutating).map((c) => c.name).sort();
  assert.deepEqual(readOnly, ["exportSequence", "getProjectItems", "getSequence", "openProject"]);
});
