// Command-module tests (project, items, refs) against the fake ppro object model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { cmd, makeCtx, standardProject, rejects, FOLDER } from "./premiere-fakeppro.mjs";

const require = createRequire(import.meta.url);
const refs = require("../src/premiere-uxp/lib/refs.js");

// ---------------- refs ----------------

test("refs: item by path is case/space-insensitive; {id} (string or number) and {file}", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  assert.equal((await refs.resolveItem(ctx, " renders/V003/sh010_v003 ")).id, "sh10");
  assert.equal((await refs.resolveItem(ctx, { path: "Renders/v003/SH020_v003" })).id, "sh20");
  assert.equal((await refs.resolveItem(ctx, { id: "sh20" })).path, "Renders/v003/SH020_v003");
  f.sh10.id = "42";
  assert.equal((await refs.resolveItem(ctx, { id: 42 })).path, "Renders/v003/SH010_v003");
  assert.equal((await refs.resolveItem(ctx, { file: "d:/projects/myfilm/SHOTS/SH020/./SH020_v003.mov" })).id, "sh20");
});

test("refs: not found, wrong kind, ambiguous with candidates", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  await rejects(refs.resolveItem(ctx, "Renders/v003/nope"), "ITEM_NOT_FOUND");
  await rejects(refs.resolveItem(ctx, "Renders/v003"), "ITEM_NOT_FOUND"); // a bin, not a clip
  await rejects(refs.resolveItem(ctx, 5), "BAD_ARGS");
  f.renders.add(new f.Item("v003", 2)).add(new f.Item("SH010_v003", 1, { id: "dup", fps: 24 }));
  await assert.rejects(refs.resolveItem(ctx, "Renders/v003/SH010_v003"), (e) => {
    assert.equal(e.code, "AMBIGUOUS_ITEM");
    assert.deepEqual(e.extra.candidates.map((c) => c.id).sort(), ["dup", "sh10"]);
    return true;
  });
});

test("refs: bins resolve, BIN_NOT_FOUND, and create one transaction per missing level", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  assert.equal((await refs.resolveBin(ctx, "")).path, "");
  assert.equal((await refs.resolveBin(ctx, "renders/V003")).path, "Renders/v003");
  await rejects(refs.resolveBin(ctx, "Renders/v004"), "BIN_NOT_FOUND");
  const r = await refs.resolveBin(ctx, "Renders/v004/plates", { create: true });
  assert.deepEqual(r.created, ["Renders/v004", "Renders/v004/plates"]);
  assert.equal(ctx.txns.length, 2);
  assert.equal(ctx.txns[0].actions[0].kind, "createBin");
  assert.equal(ctx.txns[0].actions[0].makeUnique, false);
});

test("refs: sequences by name, path, guid; not found; ambiguous", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  assert.equal((await refs.resolveSequence(ctx, "edit")).sequence, f.seq);
  assert.equal((await refs.resolveSequence(ctx, "Sequences/Edit")).sequence, f.seq);
  assert.equal((await refs.resolveSequence(ctx, { id: "guid-Edit" })).sequence, f.seq);
  await rejects(refs.resolveSequence(ctx, "Nope"), "SEQUENCE_NOT_FOUND");
  await rejects(refs.resolveSequence(ctx, "Sequences/Nope"), "SEQUENCE_NOT_FOUND");
  f.project.addSequence("Edit", { guid: "g2" });
  await rejects(refs.resolveSequence(ctx, "Edit"), "AMBIGUOUS_ITEM");
});

test("refs: track refs", () => {
  const ctx = makeCtx(standardProject());
  assert.deepEqual(refs.parseTrackRef(ctx, "V1"), { type: "video", index0: 0, label: "V1" });
  assert.deepEqual(refs.parseTrackRef(ctx, "a12"), { type: "audio", index0: 11, label: "A12" });
  for (const bad of ["V0", "X1", "1", "", null, "V1.5"]) assert.throws(() => refs.parseTrackRef(ctx, bad), (e) => e.code === "BAD_ARGS");
});

// ---------------- createProject / openProject / saveProject ----------------

test("createProject: default root, FILE_EXISTS, sets target", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { targetless: true, files: ["D:\\Projects\\Old.prproj"] });
  const c = cmd("createProject");
  await rejects(c.run(ctx, { path: "C:\\Elsewhere\\X.prproj" }), "NOT_IN_DEFAULT_ROOT");
  await rejects(c.run(ctx, { path: "D:\\Projects\\Old.prproj" }), "FILE_EXISTS");
  await rejects(c.run(ctx, { path: "D:\\Projects\\New.txt" }), "BAD_ARGS");
  await rejects(c.run(ctx, { path: "relative.prproj" }), "BAD_ARGS");
  const r = await c.run(ctx, { path: "D:\\Projects\\New\\New.prproj" });
  assert.equal(r.path, "D:\\Projects\\New\\New.prproj");
  assert.deepEqual(ctx.targets, ["D:\\Projects\\New\\New.prproj"]);
});

test("createProject: a forward-slash path reaches Premiere with backslashes (a / path hangs on a scratch-disk dialog)", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { targetless: true });
  await cmd("createProject").run(ctx, { path: "D:/Projects/New/Slash.prproj" });
  assert.ok(f.state.log.includes("createProject:D:\\Projects\\New\\Slash.prproj"), f.state.log.join("\n"));
});

test("openProject: already open is just targeted; otherwise opens with dialogs suppressed", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { targetless: true, files: ["D:\\Other\\B.prproj"] });
  const c = cmd("openProject");
  const r1 = await c.run(ctx, { path: "d:/projects/myfilm/EDIT/edit.prproj" });
  assert.equal(r1.alreadyOpen, true);
  assert.ok(!f.state.log.some((l) => l.startsWith("open:")));
  await rejects(c.run(ctx, { path: "D:\\Other\\Missing.prproj" }), "FILE_NOT_FOUND");
  const r2 = await c.run(ctx, { path: "D:\\Other\\B.prproj" });
  assert.equal(r2.alreadyOpen, false);
  assert.deepEqual([f.ppro.lastOpenOptions.convert, f.ppro.lastOpenOptions.locate, f.ppro.lastOpenOptions.warning], [false, false, false]);
  assert.deepEqual(ctx.targets, [f.project.path, "D:\\Other\\B.prproj"]);
});

test("saveProject: in place, save-as checks folder before saving, FILE_EXISTS, SAVE_FAILED", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { files: [FOLDER + "\\Exists.prproj"] });
  const c = cmd("saveProject");
  assert.equal((await c.run(ctx, {})).savedAs, false);
  await rejects(c.run(ctx, { path: "C:\\Outside\\X.prproj" }), "OUTSIDE_FOLDER");
  assert.ok(!f.state.log.some((l) => l.startsWith("saveAs")));
  await rejects(c.run(ctx, { path: FOLDER + "\\Exists.prproj" }), "FILE_EXISTS");
  const r = await c.run(ctx, { path: FOLDER + "\\Exists.prproj", overwrite: true });
  assert.equal(r.savedAs, true);
  const i = f.state.log.indexOf("assertWritable:" + FOLDER + "\\Exists.prproj");
  assert.ok(i >= 0 && i < f.state.log.indexOf("saveAs:" + FOLDER + "\\Exists.prproj"));
  assert.deepEqual(ctx.targets, [FOLDER + "\\Exists.prproj"]);
  const g = standardProject({ saveOk: false });
  await rejects(cmd("saveProject").run(makeCtx(g), {}), "SAVE_FAILED");
});

// ---------------- getProjectItems ----------------

test("getProjectItems: recursive listing, type filter, bin scoping, clip details in clip timebase", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  const c = cmd("getProjectItems");
  const all = await c.run(ctx, {});
  assert.ok(all.items.some((i) => i.path === "Renders/v003/SH010_v003" && i.type === "clip"));
  assert.ok(all.items.some((i) => i.path === "Sequences/Edit" && i.type === "sequence"));
  const clips = await c.run(ctx, { bin: "Renders", type: "clip" });
  assert.deepEqual(clips.items.map((i) => i.path), ["Renders/v003/SH010_v003", "Renders/v003/SH020_v003"]);
  const sh10 = clips.items[0];
  assert.equal(sh10.frameRate, 24);
  // No marks: Premiere reports -400000 s for in and out (live); shown as null. The media duration is real.
  assert.equal(sh10.in, null);
  assert.equal(sh10.out, null);
  assert.deepEqual(sh10.duration, { frames: 100, timecode: "00:00:04:04", seconds: 4.166667 });
  f.sh20.inT = 2n * 10584000000n;
  f.sh20.outT = 40n * 10584000000n;
  const marked = (await c.run(ctx, { bin: "Renders/v003", type: "clip" })).items[1];
  assert.deepEqual([marked.in.frames, marked.out.frames], [2, 40]);
  const flat = await c.run(ctx, { bin: "Renders", recursive: false });
  assert.deepEqual(flat.items.map((i) => i.path), ["Renders/v003"]);
  await rejects(c.run(ctx, { bin: "Nope" }), "BIN_NOT_FOUND");
  await rejects(c.run(ctx, { type: "folder" }), "BAD_ARGS");
});

// ---------------- importFiles ----------------

test("importFiles: nested bins, skipExisting by normalized media path, result items", async () => {
  const f = standardProject();
  const newFile = "D:\\Projects\\MyFilm\\shots\\SH030\\SH030_v001.mov";
  const existing = "d:/projects/myfilm/shots/sh010/SH010_v003.mov";
  const ctx = makeCtx(f, { files: [newFile, existing] });
  const r = await cmd("importFiles").run(ctx, { files: [newFile, existing, newFile], bin: "Renders/v004/new", skipExisting: true });
  assert.deepEqual(r.binsCreated, ["Renders/v004", "Renders/v004/new"]);
  assert.equal(r.imported, 1);
  assert.deepEqual(r.items, [{ path: "Renders/v004/new/SH030_v001.mov", id: r.items[0].id, mediaPath: newFile }]);
  assert.equal(r.skipped[0].path, "Renders/v003/SH010_v003");
  assert.ok(f.state.log.includes("importFiles:1:true"));
  assert.equal(ctx.undoSteps, 3, "two new bins plus the import");
});

test("importFiles: everything already present -> no bins, no import; missing files -> FILE_NOT_FOUND", async () => {
  const f = standardProject();
  const existing = "D:\\Projects\\MyFilm\\shots\\SH010\\SH010_v003.mov";
  const ctx = makeCtx(f, { files: [existing] });
  const r = await cmd("importFiles").run(ctx, { files: [existing], bin: "New/Bin" });
  assert.equal(r.imported, 0);
  assert.equal(ctx.txns.length, 0);
  assert.ok(!f.state.log.some((l) => l.startsWith("importFiles")));
  await rejects(cmd("importFiles").run(ctx, { files: ["D:\\nope.mov"] }), "FILE_NOT_FOUND");
  await rejects(cmd("importFiles").run(ctx, { files: [] }), "BAD_ARGS");
  await rejects(cmd("importFiles").run(ctx, { files: ["rel.mov"] }), "BAD_ARGS");
});

// ---------------- importAEComps ----------------

const AEP = "D:\\Projects\\MyFilm\\ae\\Titles.aep";

test("importAEComps: named comps into a new nested bin; new items found by diffing the bin", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { files: [AEP] });
  const r = await cmd("importAEComps").run(ctx, { aepPath: AEP, comps: ["Main Comp", "Lower Third"], bin: "AE/Titles" });
  assert.ok(f.state.log.includes(`importAEComps:${AEP}:Main Comp|Lower Third`));
  assert.equal(r.aepPath, AEP);
  assert.equal(r.bin, "AE/Titles");
  assert.deepEqual(r.binsCreated, ["AE", "AE/Titles"]);
  assert.deepEqual(r.imported.map((i) => [i.path, i.name]), [["AE/Titles/Main Comp", "Main Comp"], ["AE/Titles/Lower Third", "Lower Third"]]);
  assert.ok(r.imported.every((i) => typeof i.id === "string"));
  assert.deepEqual(r.skipped, []);
  assert.equal(ctx.undoSteps, 3, "two bins plus the import");
});

test("importAEComps: skipExisting skips comps already in the bin by name; all comps uses importAllAEComps", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { files: [AEP] });
  await cmd("importAEComps").run(ctx, { aepPath: AEP, comps: ["Main Comp"], bin: "AE" });
  const r = await cmd("importAEComps").run(ctx, { aepPath: AEP, comps: ["main comp", "End Card"], bin: "AE" });
  assert.deepEqual(r.imported.map((i) => i.name), ["End Card"]);
  assert.deepEqual(r.skipped.map((s) => [s.comp, s.path, s.reason]), [["main comp", "AE/Main Comp", "already in bin"]]);
  assert.ok(f.state.log.includes(`importAEComps:${AEP}:End Card`));
  // Everything already there: no call at all.
  const n = f.state.log.length;
  const none = await cmd("importAEComps").run(ctx, { aepPath: AEP, comps: ["End Card"], bin: "AE" });
  assert.deepEqual([none.imported, none.skipped.length, f.state.log.length], [[], 1, n]);
  // skipExisting=false imports again.
  const again = await cmd("importAEComps").run(ctx, { aepPath: AEP, comps: ["End Card"], bin: "AE", skipExisting: false });
  assert.equal(again.imported.length, 1);
  const all = await cmd("importAEComps").run(ctx, { aepPath: AEP });
  assert.ok(f.state.log.includes(`importAllAEComps:${AEP}`));
  assert.deepEqual(all.imported.map((i) => i.path), ["Main Comp", "Lower Third"]);
  assert.equal(all.bin, "");
});

test("importAEComps: validation and IMPORT_FAILED", async () => {
  const f = standardProject();
  const ctx = makeCtx(f, { files: [AEP, "D:\\x\\clip.mov"] });
  const c = cmd("importAEComps");
  await rejects(c.run(ctx, {}), "BAD_ARGS");
  await rejects(c.run(ctx, { aepPath: "ae\\Titles.aep" }), "BAD_ARGS");
  await rejects(c.run(ctx, { aepPath: "D:\\x\\clip.mov" }), "BAD_ARGS");
  await rejects(c.run(ctx, { aepPath: "D:\\x\\missing.aep" }), "FILE_NOT_FOUND");
  await rejects(c.run(ctx, { aepPath: AEP, comps: [] }), "BAD_ARGS");
  await rejects(c.run(ctx, { aepPath: AEP, comps: ["ok", ""] }), "BAD_ARGS");
  await rejects(c.run(ctx, { aepPath: AEP, bin: 5 }), "BAD_ARGS");
  await rejects(cmd("importAEComps").run(makeCtx(standardProject({ aeImport: false }), { files: [AEP] }), { aepPath: AEP, comps: ["A"] }), "IMPORT_FAILED");
  await rejects(cmd("importAEComps").run(makeCtx(standardProject({ aeImport: "nothing" }), { files: [AEP] }), { aepPath: AEP }), "IMPORT_FAILED");
});

// ---------------- replaceMedia ----------------

test("replaceMedia: relinks, restores trims in one transaction when they changed, renames", async () => {
  const f = standardProject({ relinkResetsTrims: true });
  f.sh10.inT = 10n * 10584000000n;
  f.sh10.outT = 50n * 10584000000n;
  const nf = "D:\\Projects\\MyFilm\\shots\\SH010\\SH010_v004.mov";
  const ctx = makeCtx(f, { files: [nf] });
  const r = await cmd("replaceMedia").run(ctx, { item: "Renders/v003/SH010_v003", newFile: nf, rename: "SH010_v004" });
  assert.equal(f.sh10.mediaPath, nf);
  assert.equal(r.trimsRestored, true);
  assert.equal(f.sh10.inT, 10n * 10584000000n);
  assert.equal(f.sh10.name, "SH010_v004");
  assert.equal(r.path, "Renders/v003/SH010_v004");
  assert.equal(ctx.txns.length, 1);
  assert.deepEqual(ctx.txns[0].actions.map((a) => a.kind), ["setItemInOut", "setName"]);
  assert.equal(ctx.undoSteps, 1, "the relink itself is not undoable (docs), so only the restore counts");
});

test("replaceMedia: unset marks (-400000 s) are reported as null and never 'restored'", async () => {
  const f = standardProject({ relinkResetsTrims: true });
  const nf = "D:\\x\\new.mov";
  const ctx = makeCtx(f, { files: [nf] });
  const r = await cmd("replaceMedia").run(ctx, { item: { id: "sh10" }, newFile: nf });
  assert.deepEqual(r.trims, { in: null, out: null });
  assert.equal(r.trimsRestored, false);
  assert.equal(ctx.txns.length, 0);
});

test("replaceMedia: no transaction when trims survive; errors", async () => {
  const f = standardProject();
  const nf = "D:\\x\\new.mov";
  const ctx = makeCtx(f, { files: [nf] });
  const r = await cmd("replaceMedia").run(ctx, { item: { id: "sh20" }, newFile: nf });
  assert.equal(r.trimsRestored, false);
  assert.equal(ctx.txns.length, 0);
  assert.equal(ctx.undoSteps, 0);
  await rejects(cmd("replaceMedia").run(ctx, { item: { id: "sh20" }, newFile: "D:\\x\\missing.mov" }), "FILE_NOT_FOUND");
  await rejects(cmd("replaceMedia").run(ctx, { item: "Nope", newFile: nf }), "ITEM_NOT_FOUND");
  f.sh20.canChange = false;
  await rejects(cmd("replaceMedia").run(ctx, { item: { id: "sh20" }, newFile: nf }), "UNSUPPORTED");
});

// ---------------- createSequence ----------------

test("createSequence: preset uses createSequenceWithPresetPath and moves into the bin", async () => {
  const f = standardProject();
  const preset = "D:\\Presets\\HD24.sqpreset";
  const ctx = makeCtx(f, { files: [preset] });
  const r = await cmd("createSequence").run(ctx, { name: "Cut 2", bin: "Sequences/v2", preset });
  assert.ok(f.state.log.includes("createSequenceWithPresetPath:" + preset));
  assert.equal(r.path, "Sequences/v2/Cut 2");
  assert.deepEqual(r.timebase, { fpsNum: 24, fpsDen: 1, dropFrame: false });
  assert.deepEqual(ctx.txns.map((t) => t.actions[0].kind), ["createBin", "moveItem"]);
  assert.equal(ctx.undoSteps, 3, "bin, sequence creation, move into the bin");
  assert.ok(ctx.txns.every((t) => !t.name.startsWith("MCP:")), "core adds the MCP: prefix");
  assert.ok((await refs.resolveSequence(ctx, "Sequences/v2/Cut 2")).sequence);
  await rejects(cmd("createSequence").run(ctx, { name: "X", preset: "D:\\nope.sqpreset" }), "FILE_NOT_FOUND");
  await rejects(cmd("createSequence").run(ctx, { name: "X", preset: "D:\\a.txt" }), "BAD_ARGS");
  await rejects(cmd("createSequence").run(ctx, { name: "", preset }), "BAD_ARGS");
});

test("createSequence: fromClips uses createSequenceFromMedia with the target bin (no move)", async () => {
  const f = standardProject();
  const ctx = makeCtx(f);
  await cmd("createSequence").run(ctx, { name: "Auto", bin: "Sequences", fromClips: ["Renders/v003/SH010_v003", { id: "sh20" }] });
  assert.ok(f.state.log.includes("createSequenceFromMedia:2"));
  assert.equal(ctx.txns.length, 0);
  assert.equal(ctx.undoSteps, 1, "sequence creation");
  assert.ok(f.seqBin.children.some((c) => c.name === "Auto"));
  await rejects(cmd("createSequence").run(ctx, { name: "Y", fromClips: ["Nope"] }), "ITEM_NOT_FOUND");
  await rejects(cmd("createSequence").run(ctx, { name: "Y", fromClips: ["x"], preset: "D:\\a.sqpreset" }), "BAD_ARGS");
});
