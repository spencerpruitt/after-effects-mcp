// End-to-end tests for the Premiere Pro bridge (docs/premiere-bridge-spec.md section 10).
// Contract: docs/bridge-protocol.md plus the Premiere differences in spec section 4.
//
// Runs against the REAL Premiere Pro with the MCP Bridge panel open and "Allow test harness" ticked. Your own
// projects stay open and are never targeted: every command names a throwaway project under
// %TEMP%\pr-mcp-e2e-<stamp>\, and teardown closes those projects and deletes the folder. See test/e2e/README.md.
//
//   npm run test:e2e:premiere -- --i-saved-my-project [--interactive] [--only P01,P05]
//   node test/e2e/premiere.e2e.mjs --i-saved-my-project [--interactive]
//
// The case list and runner are exported (runSuite, CASES) so test/premiere-e2e-dryrun.test.mjs can run them
// against an in-process fake panel.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createPrClient, fmt } from "./lib/prBridge.mjs";

const require = createRequire(import.meta.url);
const { normalize, isInside } = require("../../src/premiere-uxp/lib/pathPolicy.js");

// The server's per-tool routing (src/premiere.ts PREMIERE_TOOL_ROUTES), from the build (`npm run build`).
let routesPromise = null;
export function serverRoutes() {
  if (!routesPromise) {
    routesPromise = import("../../build/premiere.js").then((m) => m.PREMIERE_TOOL_ROUTES, (e) => {
      routesPromise = null;
      throw new Error(`the sidecar cases need the server build for its routing; run npm run build (${e.message})`);
    });
  }
  return routesPromise;
}

// ---------------------------------------------------------------------------------------------------------
// Safety: what the harness may send
// ---------------------------------------------------------------------------------------------------------

// Commands that skip the panel's project gate (getState) or carry their target in their args (createProject,
// openProject, the __e2e_* harness commands). Everything else must name a throwaway project in expectedProject,
// or leave it out / send "" on purpose (gate probes, which the panel refuses).
export const EXEMPT_COMMANDS = Object.freeze(["getState", "createProject", "openProject"]);
export const isExemptCommand = (command) => EXEMPT_COMMANDS.includes(command) || String(command).startsWith("__e2e_");

// Argument keys that name a file or folder the command acts on. (`preset` is read-only and may live anywhere.)
const PATH_ARG_KEYS = ["path", "projectPath", "root", "folder", "output", "newFile", "file"];

export const samePath = (a, b) => {
  const na = normalize(a);
  return na !== null && na === normalize(b);
};

/** Returns null when the command only targets things under root, otherwise the reason it must not be sent. */
export function checkCommandTarget(cmd, root) {
  const ep = cmd.expectedProject;
  if (ep !== undefined && typeof ep !== "string") return `${cmd.command}: expectedProject must be a string`;
  if (typeof ep === "string" && ep !== "" && !isInside(ep, root)) return `${cmd.command}: expectedProject ${ep} is outside ${root}`;
  const args = cmd.args || {};
  const named = [];
  for (const k of PATH_ARG_KEYS) if (typeof args[k] === "string") named.push([k, args[k]]);
  if (Array.isArray(args.files)) args.files.forEach((f, i) => named.push([`files[${i}]`, f]));
  for (const [k, v] of named) {
    // Relative paths resolve inside the sandbox folder (or are refused); absolute ones must be ours.
    if (normalize(v) !== null && !isInside(v, root)) return `${cmd.command}: args.${k} ${v} is outside ${root}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------

/** %TEMP%, resolved like the panel does (it checks __e2e_* paths against %TEMP%\pr-mcp-e2e-*). */
export function defaultTempBase() {
  return process.env.TEMP || process.env.TMP || os.tmpdir();
}

export function makeStamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + process.pid;
}

export function makeLayout(tempBase, stamp) {
  const ROOT = path.join(tempBase, `pr-mcp-e2e-${stamp}`);
  const EDIT = path.join(ROOT, "edit"); // the sandbox folder of E2E.prproj
  const SECOND_DIR = path.join(ROOT, "second");
  return {
    ROOT,
    EDIT,
    OUTSIDE: path.join(ROOT, "outside"), // must never be written by Premiere
    SECOND_DIR,
    MEDIA: path.join(ROOT, "media"),
    E2E: path.join(EDIT, "E2E.prproj"),
    SECOND: path.join(SECOND_DIR, "Second.prproj"),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------------------

export const MEDIA_FILES = Object.freeze({
  sh010: "SH010_v001.mp4", // 29.97, 4 s, with audio
  sh020: "SH020_v001.mp4", // 29.97, 4 s, with audio
  sh010v2: "SH010_v002.mp4", // 29.97, 4 s, with audio (relink target)
  c23976: "SH010_v001_23976.mp4", // 23.976, 4 s, with audio
  music: "music.wav", // 6 s, audio only
});

/** mode: "auto" (ffmpeg if on PATH), "fake" (placeholder files, dry run only) or "none". */
function prepareMedia(dir, mode) {
  const files = Object.fromEntries(Object.entries(MEDIA_FILES).map(([k, f]) => [k, path.join(dir, f)]));
  if (mode === "none") return { available: false, reason: "media disabled for this run", files };
  fs.mkdirSync(dir, { recursive: true });
  if (mode === "fake") {
    for (const f of Object.values(files)) fs.writeFileSync(f, "placeholder media for the dry run");
    return { available: true, files };
  }
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
  if (probe.error || probe.status !== 0) {
    return { available: false, reason: "ffmpeg is not on PATH, so no test media could be generated", files };
  }
  const ff = (args) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe", windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr || r.error)}`);
  };
  const video = (src, rate, hz, out) =>
    ff(["-f", "lavfi", "-i", `${src}=size=640x360:rate=${rate}:duration=4`, "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=4`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
  try {
    video("testsrc2", "30000/1001", 440, files.sh010);
    video("smptebars", "30000/1001", 660, files.sh020);
    video("testsrc2", "30000/1001", 550, files.sh010v2);
    video("testsrc2", "24000/1001", 330, files.c23976);
    ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-c:a", "pcm_s16le", files.music]);
  } catch (e) {
    return { available: false, reason: e.message, files };
  }
  return { available: true, files };
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------
const lit = (s) => JSON.stringify(String(s));

// The sidecar cases' tool calls (P34-P36), exported so a unit test checks them against the server's routing and
// the sidecar's argument checks (test/premiere-sidecar-server.test.mjs).
const LINK_PAIR = Object.freeze([{ track: "V1", index: 0 }, { track: "A1", index: 0 }]);
export const SIDECAR_TOOL_CALLS = Object.freeze({
  speed: (sequence) => ["premiere-set-speed", { sequence, track: "V1", index: 0, percent: 50, reverse: false, ripple: true, maintainPitch: true }],
  audioCrossfade: (sequence) => ["premiere-add-transition", { sequence, track: "A1", index: 0, edge: "end", type: "Constant Power", durationFrames: 10 }],
  unlink: (sequence) => ["premiere-link-clips", { sequence, items: LINK_PAIR.map((i) => ({ ...i })), link: false }],
  link: (sequence) => ["premiere-link-clips", { sequence, items: LINK_PAIR.map((i) => ({ ...i })), link: true }],
});
const exists = (p) => fs.existsSync(p);

function listRecursive(dir, base = dir) {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(path.relative(base, full));
    if (e.isDirectory()) out.push(...listRecursive(full, base));
  }
  return out;
}

function withTimeout(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function ok(res, ctx) {
  assert.equal(res.status, "success", `${ctx}: expected success, got ${fmt(res)}`);
}
function hasCode(res, code, ctx) {
  assert.equal(res.status, "error", `${ctx}: expected an error with code ${code}, got ${fmt(res)}`);
  assert.equal(res.code, code, `${ctx}: expected code ${code}, got ${fmt(res)}`);
  assert.ok(typeof res.message === "string" && res.message.length > 0, `${ctx}: an error needs a message, got ${fmt(res)}`);
}
function refused(res, code, ctx) {
  hasCode(res, code, ctx);
  assert.equal(res.refused, true, `${ctx}: ${code} refusals carry refused: true, got ${fmt(res)}`);
}
function blockedWrite(res, target, ctx) {
  hasCode(res, "OUTSIDE_FOLDER", ctx);
  assert.match(String(res.message), /outside/i, `${ctx}: message should say outside, got ${fmt(res)}`);
  assert.ok(String(res.message).toLowerCase().includes(path.basename(target).toLowerCase()),
    `${ctx}: message should name ${target}, got ${fmt(res)}`);
}
const missing = (p, ctx) => assert.ok(!exists(p), `${ctx}: ${p} must not exist`);

const trackItems = (seqResult, track) => (seqResult.items || []).filter((i) => i.track === track).sort((a, b) => a.index - b.index);

// ---------------------------------------------------------------------------------------------------------
// Cases. kind: "hard" fails the run; "soft" reports but never fails it (uncertain live semantics).
// A hard case can also make soft checks (h.soft): the case then reports SOFT instead of PASS.
// needs: media | interactive | sidecar | noSidecar | exportPreset
// ---------------------------------------------------------------------------------------------------------
export const CASES = [
  {
    id: "P01", title: "getState reports the throwaway target, its folder and the flags", kind: "hard",
    async run(h) {
      const { L } = h;
      const r = await h.state();
      ok(r, "getState");
      assert.ok(samePath(r.target && r.target.path, L.E2E), `target.path should be E2E.prproj, got ${fmt(r.target)}`);
      assert.equal(r.target.name, "E2E.prproj", `target.name, got ${fmt(r.target)}`);
      assert.ok(samePath(r.target.folder, L.EDIT), `target.folder should be ${L.EDIT}, got ${fmt(r.target)}`);
      assert.equal(r.target.folderExists, true, `folderExists, got ${fmt(r.target)}`);
      assert.equal(r.target.isDefault, false, `isDefault (the folder is set for the project), got ${fmt(r.target)}`);
      assert.equal(r.paused, false, `paused (untick Pause in the panel), got ${r.paused}`);
      assert.equal(r.scriptsEnabled, true, `scriptsEnabled, got ${r.scriptsEnabled}`);
      assert.equal(r.testHarnessEnabled, true, `testHarnessEnabled, got ${r.testHarnessEnabled}`);
      assert.equal(r._commandExecuted, "getState");
      const open = (r.openProjects || []).map((p) => p.path);
      assert.ok(open.some((p) => samePath(p, L.E2E)) && open.some((p) => samePath(p, L.SECOND)), `openProjects should list both throwaway projects, got ${fmt(open)}`);
      for (const mine of h.st.userProjects) {
        assert.ok(open.some((p) => samePath(p, mine)), `your project ${mine} should still be open, got ${fmt(open)}`);
      }
      h.soft("getState reports the Premiere version (app.version)", () => assert.ok(r.app && r.app.version, fmt(r.app)));
      h.soft("getState reports scratch-disk locations", () => assert.ok(r.scratchDisks && "videoPreview" in r.scratchDisks, fmt(r.scratchDisks)));
    },
  },
  {
    id: "P02", title: "import into nested bins; skipExisting skips media already in the project", kind: "hard", needs: ["media"],
    async run(h) {
      const { M } = h;
      const files = [M.sh010, M.sh020, M.music];
      let r = await h.send("importFiles", { files, bin: "Renders/v001", skipExisting: true });
      ok(r, "import 3 files into Renders/v001");
      const reported = [...(r.items || []).map((i) => i.mediaPath), ...(r.skipped || []).map((s) => s.file)];
      for (const f of files) assert.ok(reported.some((p) => samePath(p, f)), `${path.basename(f)} should be imported or skipped, got ${fmt(r)}`);
      for (const it of r.items || []) assert.match(it.path, /^Renders\/v001\//, `item path should be under Renders/v001, got ${it.path}`);
      if (r.imported === 3) {
        assert.deepEqual(r.binsCreated, ["Renders", "Renders/v001"], `both bin levels are created, got ${fmt(r.binsCreated)}`);
      }
      assert.ok(r.backupPath && isInside(r.backupPath, path.join(h.L.EDIT, "mcp-scripts", "backups")), `a mutating typed tool takes a backup in the folder, got ${fmt(r.backupPath)}`);
      h.soft("import reports at least one undo step", () => assert.ok(r.imported === 0 || r.undoSteps >= 1, `undoSteps ${r.undoSteps}`));

      r = await h.send("importFiles", { files: [M.sh010], bin: "Renders/v001", skipExisting: true });
      ok(r, "re-import");
      assert.equal(r.imported, 0, `re-import should import nothing, got ${fmt(r)}`);
      assert.equal((r.skipped || []).length, 1, `re-import should skip the file, got ${fmt(r)}`);
      assert.equal(r.skipped[0].reason, "already in project");

      r = await h.send("getProjectItems", { bin: "Renders", recursive: true });
      ok(r, "getProjectItems Renders");
      const clips = (r.items || []).filter((i) => i.type === "clip");
      for (const f of files) {
        assert.ok(clips.some((c) => samePath(c.mediaPath, f) && /^Renders\/v001\//.test(c.path)), `${path.basename(f)} should be listed under Renders/v001, got ${fmt(clips)}`);
      }
      assert.ok((r.items || []).some((i) => i.type === "bin" && i.path === "Renders/v001"), "the nested bin is listed");
      h.soft("clips report their frame rate (29.97 for the mp4s)", () => {
        const c = clips.find((x) => samePath(x.mediaPath, M.sh010));
        assert.ok(c && Math.abs(c.frameRate - 29.97) < 0.01, fmt(c));
      });

      r = await h.send("importFiles", { files: [path.join(h.L.MEDIA, "does-not-exist.mp4")] });
      hasCode(r, "FILE_NOT_FOUND", "import a missing file");
      r = await h.send("importFiles", { files: ["relative\\clip.mp4"] });
      hasCode(r, "BAD_ARGS", "import a relative path");
    },
  },
  {
    id: "P03", title: "script writes inside the folder succeed; writes outside are refused; reads anywhere work", kind: "hard",
    async run(h) {
      const { L } = h;
      const inside = path.join(L.EDIT, "inside.txt");
      let r = await h.script(`await fs.writeFile(sandbox.path("inside.txt"), "hello-inside", { encoding: "utf-8" }); return sandbox.path("inside.txt");`, "write-inside");
      ok(r, "write inside");
      assert.equal(fs.readFileSync(inside, "utf8"), "hello-inside", "inside.txt content");
      r = await h.script(`await fs.mkdir(sandbox.path("made-dir")); return true;`, "mkdir-inside");
      ok(r, "mkdir inside");
      assert.ok(exists(path.join(L.EDIT, "made-dir")), "made-dir should exist");

      const keep = h.writeOutside("keep.txt", "original");
      const out = (n) => path.join(L.OUTSIDE, n);
      const attempts = [
        ["fs.writeFile outside", `await fs.writeFile(${lit(out("outside-new.txt"))}, "x", { encoding: "utf-8" });`, out("outside-new.txt")],
        ["fs.writeFile append outside", `await fs.writeFile(${lit(keep)}, "appended", { encoding: "utf-8", flag: "a" });`, keep],
        ["fs.unlink outside", `await fs.unlink(${lit(keep)});`, keep],
        ["fs.rename outside", `await fs.rename(${lit(keep)}, ${lit(out("renamed.txt"))});`, keep],
        ["fs.rename inside -> outside", `await fs.rename(sandbox.path("inside.txt"), ${lit(out("moved-out.txt"))});`, out("moved-out.txt")],
        ["fs.copyFile to outside", `await fs.copyFile(sandbox.path("inside.txt"), ${lit(out("copied.txt"))});`, out("copied.txt")],
        ["fs.mkdir outside", `await fs.mkdir(${lit(out("made-dir"))});`, out("made-dir")],
        ["require('fs').writeFile outside", `const f = require("fs"); await f.writeFile(${lit(out("via-require.txt"))}, "x", { encoding: "utf-8" });`, out("via-require.txt")],
      ];
      for (const [label, code, target] of attempts) {
        r = await h.script(code + "\nreturn 1;", "blocked-write");
        blockedWrite(r, target, label);
      }
      assert.equal(fs.readFileSync(keep, "utf8"), "original", "keep.txt must be untouched");
      for (const n of ["outside-new.txt", "renamed.txt", "moved-out.txt", "copied.txt", "made-dir", "via-require.txt"]) missing(out(n), "blocked write");
      assert.ok(exists(inside), "inside.txt must still be inside");

      r = await h.script(`return String(await fs.readFile(${lit(keep)}, { encoding: "utf-8" }));`, "read-outside");
      ok(r, "read outside");
      assert.equal(r.returnValue, "original", "reading outside the folder is allowed");
    },
  },
  {
    id: "P04", title: "exports outside the folder are refused (typed tool, sandbox.export, guarded ppro)", kind: "hard",
    async run(h) {
      const { L } = h;
      const outPng = path.join(L.OUTSIDE, "frame-out.png");
      const outMp4 = path.join(L.OUTSIDE, "seq-out.mp4");
      let r = await h.send("exportSequence", { sequence: "NoSuchSequence", output: outPng, frame: { frames: 0 }, format: "png" });
      hasCode(r, "OUTSIDE_FOLDER", "typed frame export outside (checked before the sequence lookup)");
      r = await h.send("exportSequence", { sequence: "NoSuchSequence", output: outMp4, preset: path.join(L.EDIT, "none.epr") });
      hasCode(r, "OUTSIDE_FOLDER", "typed sequence export outside");
      const scripted = [
        ["sandbox.export outside", `return await sandbox.export(null, ${lit(outMp4)}, "none.epr");`, outMp4],
        ["EncoderManager.exportSequence outside", `const m = ppro.EncoderManager.getManager(); return await m.exportSequence(null, ppro.Constants.ExportType.IMMEDIATELY, ${lit(outMp4)}, "none.epr", true);`, outMp4],
        ["Exporter.exportSequenceFrame outside", `return await ppro.Exporter.exportSequenceFrame(null, ppro.TickTime.createWithTicks("0"), "f.png", ${lit(L.OUTSIDE + path.sep)}, 16, 16);`, L.OUTSIDE],
        ["ProjectConverter.exportAsOpenTimelineIO outside", `return await ppro.ProjectConverter.exportAsOpenTimelineIO(null, ${lit(path.join(L.OUTSIDE, "t.otio"))});`, path.join(L.OUTSIDE, "t.otio")],
      ];
      for (const [label, code, target] of scripted) {
        r = await h.script(code, "export-outside");
        blockedWrite(r, target, label);
      }
      const leaked = listRecursive(L.OUTSIDE).filter((f) => /frame-out|seq-out|f\.png|t\.otio/i.test(f));
      assert.deepEqual(leaked, [], "no export output may appear outside the folder");
    },
  },
  {
    id: "P05", title: "a frame export inside the folder succeeds", kind: "hard", needs: ["media"],
    async run(h) {
      const seq = await h.makeSequence("ExportSeq");
      const out = path.join(h.L.EDIT, "frame5.png");
      const r = await h.send("exportSequence", { sequence: seq.name, output: out, frame: { frames: 5 }, format: "png" });
      ok(r, "frame export inside");
      assert.equal(r.frame.frames, 5);
      assert.ok(await h.waitFile(out, 15000), `${out} should be written`);
    },
  },
  {
    id: "P06", title: "a full sequence export inside the folder succeeds (PR_E2E_EXPORT_PRESET)", kind: "soft", needs: ["media", "exportPreset"],
    async run(h) {
      const seq = await h.makeSequence("ExportFull");
      const out = path.join(h.L.EDIT, "exports", "full");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await h.send("exportSequence", { sequence: seq.name, output: out, preset: h.exportPreset, mode: "direct" }, { timeoutMs: 300000 });
      ok(r, "direct export inside");
      assert.ok(isInside(r.output, h.L.EDIT), `output inside the folder, got ${r.output}`);
      assert.ok(await h.waitFile(r.output, 120000), `${r.output} should be written`);
    },
  },
  {
    id: "P07", title: "saveProject: in place allowed, outside refused, existing file needs overwrite", kind: "hard",
    async run(h) {
      const { L } = h;
      let r = await h.send("saveProject", {});
      ok(r, "saveProject in place");
      assert.equal(r.savedAs, false);
      assert.ok(samePath(r.path, L.E2E), `path (compared with normalize, may carry \\\\?\\), got ${r.path}`);
      r = await h.send("saveProject", { path: L.E2E });
      ok(r, "saveProject with the project's own path");
      assert.equal(r.savedAs, false);

      const outside = path.join(L.OUTSIDE, "E2E-outside.prproj");
      r = await h.send("saveProject", { path: outside });
      hasCode(r, "OUTSIDE_FOLDER", "saveProject outside");
      missing(outside, "saveProject outside");
      assert.ok(samePath(r._project, L.E2E), `the target must still be E2E.prproj, got ${r._project}`);

      const existing = path.join(L.EDIT, "Existing.prproj");
      fs.writeFileSync(existing, "not a project");
      r = await h.send("saveProject", { path: existing });
      hasCode(r, "FILE_EXISTS", "saveProject onto an existing file without overwrite");
      assert.equal(fs.readFileSync(existing, "utf8"), "not a project", "the existing file is untouched");
      r = await h.send("saveProject", { path: path.join(L.EDIT, "E2E.txt") });
      hasCode(r, "BAD_ARGS", "saveProject to a non-.prproj path");
    },
  },
  {
    id: "P08", title: "Save As outside the folder is refused (sandbox.saveAs, project.saveAs)", kind: "hard",
    async run(h) {
      const { L } = h;
      const outside = path.join(L.OUTSIDE, "saveas-outside.prproj");
      let r = await h.script(`await sandbox.saveAs(${lit(outside)}); return 1;`, "saveas-outside");
      hasCode(r, "OUTSIDE_FOLDER", "sandbox.saveAs outside");
      r = await h.script(`await project.saveAs(${lit(outside)}); return 1;`, "project-saveas-outside");
      hasCode(r, "OUTSIDE_FOLDER", "project.saveAs outside (guarded ppro)");
      missing(outside, "Save As outside");
      const gs = await h.state();
      assert.ok((gs.openProjects || []).some((p) => samePath(p.path, L.E2E)), "E2E.prproj is still open");
    },
  },
  {
    id: "P09", title: "Save As inside the folder retargets the project and the folder follows", kind: "soft",
    async run(h) {
      const { L } = h;
      const copy = path.join(L.EDIT, "E2E-copy.prproj");
      h.trackProject(copy);
      let r = await h.send("saveProject", { path: copy });
      ok(r, "saveProject to a new path inside");
      assert.equal(r.savedAs, true);
      assert.equal(r._projectChanged, true, `_projectChanged, got ${fmt(r)}`);
      assert.ok(exists(copy), "E2E-copy.prproj exists");
      let gs = await h.state(copy);
      assert.ok(samePath(gs.target && gs.target.path, copy), `getState(copy) target, got ${fmt(gs.target)}`);
      assert.ok(samePath(gs.target.folder, L.EDIT), `the folder follows the save-as, got ${fmt(gs.target)}`);
      r = await h.script(`return project.name;`, "after-saveas", { expectedProject: copy });
      ok(r, "a command targeting the copy");

      await h.ensureE2E();
      const sa = path.join(L.EDIT, "Save As Copy.prproj");
      h.trackProject(sa);
      r = await h.script(`return await sandbox.saveAs(sandbox.path("Save As Copy.prproj"));`, "saveas-inside");
      ok(r, "sandbox.saveAs inside");
      assert.equal(r._projectChanged, true, `_projectChanged, got ${fmt(r)}`);
      assert.deepEqual(r.sandboxViolations, [], "no violations for a save inside");
      gs = await h.state(sa);
      assert.ok(samePath(gs.target && gs.target.folder, L.EDIT), `the folder follows sandbox.saveAs, got ${fmt(gs.target)}`);
    },
  },
  {
    id: "P10", title: "the static scan refuses blocked calls with BLOCKED_CALL", kind: "hard",
    async run(h) {
      const blocked = [
        ["globalThis", `return typeof globalThis;`],
        ["window", `return typeof window;`],
        ["eval(", `return eval("1 + 1");`],
        ["Function(", `return Function("return 1")();`],
        ["constructor()", `return [].map.constructor("return 1")();`],
        ["import(", `return await import("fs");`],
        ["setTimeout(string)", `setTimeout("1", 0); return 1;`],
        ["localFileSystem", `return require("uxp").storage.localFileSystem;`],
        ["localStorage", `return localStorage.length;`],
        ["sessionStorage", `return sessionStorage.length;`],
        ["__mcp", `return typeof __mcpBridge;`],
        ["MCPBridgeSandbox", `return "MCPBridgeSandbox:x";`],
        ["require(variable)", `const n = "fs"; return require(n);`],
        ["require('./...')", `return require("./core/settings.js");`],
        ["panel module path", `const p = "core/settings"; return p;`],
        ["shell", `return require("uxp").shell;`],
      ];
      for (const [label, code] of blocked) {
        const r = await h.script(code, "blocked");
        refused(r, "BLOCKED_CALL", `scan should block ${label}`);
      }
      // Passes the scan, refused by the guarded require at run time.
      const r = await h.script(`return typeof require("child_process");`, "blocked-require");
      hasCode(r, "BLOCKED_CALL", "require('child_process') at run time");
    },
  },
  {
    id: "P11", title: "scripts that clobber would-be panel globals don't break the bridge", kind: "hard",
    async run(h) {
      const names = ["bridge", "tick", "logLines", "render", "commands", "settings", "registry", "$"];
      let r = await h.script(names.map((n) => `${n} = null;`).join(" ") + ` return "clobbered";`, "clobber-globals");
      assert.notEqual(r.status, "running", `the clobbering script should finish, got ${fmt(r)}`);
      try {
        const gs = await h.state();
        ok(gs, "getState after clobbering");
        assert.ok(samePath(gs.target.folder, h.L.EDIT), "folder unchanged");
        r = await h.script(`return "still-works";`, "after-clobber");
        ok(r, "runScript after clobbering");
        r = await h.send("getProjectItems", {});
        ok(r, "a typed command after clobbering");
      } finally {
        // Remove the junk globals (sloppy-mode delete of implicit globals) so they don't linger in the panel.
        await h.script(names.map((n) => `try { delete ${n}; } catch (e) {}`).join(" ") + " return true;", "unclobber").catch(() => {});
      }
    },
  },
  {
    id: "P12", title: "a pending command older than 120 s is refused with STALE and not run", kind: "hard",
    async run(h) {
      const marker = path.join(h.L.EDIT, "stale-ran.txt");
      const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      let r = await h.script(`await fs.writeFile(sandbox.path("stale-ran.txt"), "ran", { encoding: "utf-8" }); return 1;`, "stale", { timestamp: old });
      refused(r, "STALE", "a 10-minute-old runScript");
      missing(marker, "the stale command must not run");
      assert.ok(await h.waitUntil(() => {
        const c = h.client.readCommand();
        return c && c.id === r._sentId && c.status === "error";
      }, 5000), "the stale command is marked error");
      r = await h.send("getState", {}, { timestamp: old });
      refused(r, "STALE", "STALE applies to exempt commands too");
      r = await h.script(`return "fresh";`, "after-stale");
      ok(r, "a fresh command right after");
    },
  },
  {
    id: "P13", title: "each run backs up the .prproj; only the newest 10 backups are kept", kind: "hard",
    async run(h) {
      const dir = path.join(h.L.EDIT, "mcp-scripts", "backups");
      const list = () => (exists(dir) ? fs.readdirSync(dir).filter((f) => /_E2E\.prproj$/i.test(f)) : []);
      let r = await h.script(`return 1;`, "backup-1");
      ok(r, "backup-1");
      assert.equal(r.backupWarning, undefined, `no backupWarning expected, got ${fmt(r)}`);
      assert.ok(r.backupPath && exists(r.backupPath), `backupPath should exist, got ${fmt(r.backupPath)}`);
      assert.ok(samePath(path.dirname(r.backupPath), dir), `backup should be in ${dir}, got ${r.backupPath}`);
      assert.match(path.basename(r.backupPath), /^\d{8}-\d{6}-\d{3}_E2E\.prproj$/i, "backup name <stamp>_<base>.prproj");
      const seen = new Set([normalize(r.backupPath)]);
      for (let i = 2; i <= 12; i++) {
        r = await h.script(`return ${i};`, `backup-${i}`);
        ok(r, `backup-${i}`);
        seen.add(normalize(r.backupPath));
      }
      assert.ok(seen.size >= 12, `each run gets its own backup, got ${seen.size} distinct paths`);
      assert.equal(list().length, 10, `only the newest 10 backups remain, found ${fmt(list())}`);
      assert.ok(exists(r.backupPath), "the newest backup is kept");
      r = await h.send("saveProject", {});
      ok(r, "a mutating typed tool");
      assert.ok(r.backupPath && samePath(path.dirname(r.backupPath), dir), `typed tools back up too, got ${fmt(r.backupPath)}`);
      assert.equal(list().length, 10, "still 10 after a typed tool");
    },
  },
  {
    id: "P14", title: "no expectedProject is PROJECT_NOT_CONFIRMED, \"\" is PROJECT_UNSAVED; getState is exempt", kind: "hard",
    async run(h) {
      const marker = path.join(h.L.EDIT, "unconfirmed-ran.txt");
      const code = `await fs.writeFile(sandbox.path("unconfirmed-ran.txt"), "ran", { encoding: "utf-8" }); return 1;`;
      let r = await h.script(code, "no-expected", { omitExpected: true });
      refused(r, "PROJECT_NOT_CONFIRMED", "runScript without expectedProject");
      r = await h.send("saveProject", {}, { omitExpected: true });
      refused(r, "PROJECT_NOT_CONFIRMED", "saveProject without expectedProject");
      r = await h.script(code, "untitled", { expectedProject: "" });
      refused(r, "PROJECT_UNSAVED", "expectedProject \"\"");
      missing(marker, "refused scripts must not run");
      r = await h.send("getState", {});
      ok(r, "getState without expectedProject (exempt)");
    },
  },
  {
    id: "P15", title: "a project that isn't open is PROJECT_NOT_OPEN; case, separators and \\\\?\\ are tolerated", kind: "hard",
    async run(h) {
      const { L } = h;
      const other = path.join(L.ROOT, "elsewhere", "Other.prproj");
      let r = await h.script(`return 1;`, "not-open", { expectedProject: other });
      refused(r, "PROJECT_NOT_OPEN", "expectedProject = a path that isn't open");
      assert.ok(samePath(r.expectedProject, other), `refusal.expectedProject, got ${fmt(r)}`);
      assert.ok(Array.isArray(r.openProjects) && r.openProjects.some((p) => samePath(p, L.E2E)), `refusal.openProjects lists the open projects, got ${fmt(r)}`);
      assert.match(String(r.message), /Other\.prproj/, "the message names the project");
      r = await h.send("getProjectItems", {}, { expectedProject: other });
      refused(r, "PROJECT_NOT_OPEN", "typed command, project not open");

      const respelled = L.E2E.toUpperCase().replace(/\\/g, "/");
      r = await h.script(`return "matched";`, "respelled", { expectedProject: respelled });
      ok(r, "expectedProject differing only in case and separators");
      r = await h.script(`return "matched";`, "long-path", { expectedProject: "\\\\?\\" + L.E2E });
      ok(r, "expectedProject with the \\\\?\\ long-path prefix");
      assert.ok(samePath(r._project, L.E2E), `_project, got ${r._project}`);
      r = await h.script(`return "matched";`, "dotdot", { expectedProject: L.EDIT + path.sep + ".." + path.sep + "edit" + path.sep + "E2E.prproj" });
      ok(r, "expectedProject with a .. segment");
    },
  },
  {
    id: "P16", title: "target by path while another project is active", kind: "hard",
    async run(h) {
      const { L } = h;
      let r = await h.e2e("__e2e_closeProject", { path: L.SECOND });
      ok(r, "close Second.prproj");
      r = await h.script(`return 1;`, "second-closed", { expectedProject: L.SECOND });
      refused(r, "PROJECT_NOT_OPEN", "Second.prproj closed");
      r = await h.e2e("__e2e_openProject", { path: L.SECOND });
      ok(r, "reopen Second.prproj");
      assert.equal(r.alreadyOpen, false);
      const gs = await h.state();
      h.soft("Second.prproj is the active project after reopening", () => assert.ok(samePath(gs.activeProject, L.SECOND), `active: ${gs.activeProject}`));

      r = await h.script(`await fs.writeFile(sandbox.path("targeted.txt"), project.name, { encoding: "utf-8" }); return project.name;`, "target-by-path");
      ok(r, "runScript targeting E2E.prproj while Second.prproj is active");
      assert.match(String(r.returnValue), /^E2E(\.prproj)?$/, `the script ran in E2E.prproj, got ${fmt(r.returnValue)}`);
      assert.ok(samePath(r._project, L.E2E), `_project is the target, got ${r._project}`);
      assert.ok(exists(path.join(L.EDIT, "targeted.txt")), "the write landed in E2E's folder");
      r = await h.send("getProjectItems", {}, { expectedProject: L.SECOND });
      ok(r, "getProjectItems on Second.prproj");
      assert.equal(r.count, 0, `nothing was added to Second.prproj, got ${fmt(r)}`);
    },
  },
  {
    id: "P17", title: "no folder is NO_FOLDER, a missing folder FOLDER_MISSING; default roots apply", kind: "hard",
    async run(h) {
      const { L } = h;
      try {
        let r = await h.e2e("__e2e_clearFolder", { projectPath: L.E2E, blank: true });
        ok(r, "clear the folder (blank, like the panel's Clear)");
        let gs = await h.state();
        assert.equal(gs.target.folder, null, `folder should be null, got ${fmt(gs.target)}`);
        assert.equal(gs.scriptsEnabled, false);
        r = await h.script(`return 1;`, "no-folder");
        refused(r, "NO_FOLDER", "runScript with no folder");
        const nf = path.join(L.EDIT, "scripts", "nf.js");
        fs.mkdirSync(path.dirname(nf), { recursive: true });
        fs.writeFileSync(nf, "return 1;");
        r = await h.scriptFile(nf);
        refused(r, "NO_FOLDER", "runScriptFile with no folder");
        r = await h.send("saveProject", {});
        refused(r, "NO_FOLDER", "a mutating typed tool with no folder (no backup possible)");
        r = await h.send("getProjectItems", {});
        ok(r, "read-only typed tools work without a folder");

        const gone = path.join(L.ROOT, "missing-folder");
        r = await h.e2e("__e2e_setFolder", { projectPath: L.E2E, folder: gone });
        ok(r, "set a folder that doesn't exist");
        gs = await h.state();
        assert.equal(gs.target.folderExists, false);
        assert.equal(gs.scriptsEnabled, false);
        r = await h.script(`return 1;`, "folder-missing");
        refused(r, "FOLDER_MISSING", "runScript with a missing folder");
        r = await h.send("saveProject", {});
        refused(r, "FOLDER_MISSING", "a mutating typed tool with a missing folder");
        missing(gone, "the missing folder must not be created");

        r = await h.e2e("__e2e_clearFolder", { projectPath: L.E2E });
        ok(r, "forget the project's own folder entry");
        gs = await h.state();
        assert.ok(samePath(gs.target.folder, L.ROOT) && gs.target.isDefault === true, `the default root applies, got ${fmt(gs.target)}`);
        gs = await h.state(L.SECOND);
        assert.ok(samePath(gs.target.folder, L.ROOT) && gs.target.isDefault === true, `Second.prproj uses the default root, got ${fmt(gs.target)}`);
      } finally {
        await h.e2e("__e2e_setFolder", { projectPath: L.E2E, folder: L.EDIT });
      }
    },
  },
  {
    id: "P18", title: "the folder is restored when E2E.prproj is closed and reopened", kind: "hard",
    async run(h) {
      const { L } = h;
      let r = await h.e2e("__e2e_closeProject", { path: L.E2E });
      ok(r, "close E2E.prproj");
      let gs = await h.state(null);
      assert.ok(!(gs.openProjects || []).some((p) => samePath(p.path, L.E2E)), "E2E.prproj is no longer open");
      r = await h.script(`return 1;`, "closed");
      refused(r, "PROJECT_NOT_OPEN", "the target was closed");
      r = await h.e2e("__e2e_openProject", { path: L.E2E });
      ok(r, "reopen E2E.prproj");
      assert.equal(r.alreadyOpen, false);
      gs = await h.state();
      assert.ok(samePath(gs.target.folder, L.EDIT), `the folder comes back with the project, got ${fmt(gs.target)}`);
      r = await h.script(`return "back";`, "reopened");
      ok(r, "runScript after reopening");
      r = await h.e2e("__e2e_openProject", { path: L.E2E });
      ok(r, "open an already-open project");
      assert.equal(r.alreadyOpen, true);
    },
  },
  {
    id: "P19", title: "createProject: default roots only, no overwrite, .prproj only", kind: "hard",
    async run(h) {
      const { L } = h;
      let r = await h.send("createProject", { path: L.E2E });
      hasCode(r, "FILE_EXISTS", "createProject onto an existing project");
      r = await h.send("createProject", { path: path.join(L.EDIT, "notes.txt") });
      hasCode(r, "BAD_ARGS", "createProject with a non-.prproj path");
      r = await h.send("createProject", { path: "relative\\X.prproj" });
      hasCode(r, "BAD_ARGS", "createProject with a relative path");
      const scripted = path.join(L.OUTSIDE, "Scripted.prproj");
      r = await h.script(`return await ppro.Project.createProject(${lit(scripted)});`, "create-outside");
      hasCode(r, "OUTSIDE_FOLDER", "ppro.Project.createProject outside the folder");
      missing(scripted, "scripted createProject");

      const nope = path.join(L.OUTSIDE, "Nope.prproj");
      r = await h.e2e("__e2e_removeRoot", { root: L.ROOT });
      ok(r, "forget the temp root as a default");
      try {
        r = await h.send("createProject", { path: nope });
        if (r.status === "success") {
          // One of your own default roots contains %TEMP%: the panel was right to allow it.
          h.trackProject(nope);
          h.allowOutside("*");
          await h.e2e("__e2e_closeProject", { path: nope });
          h.note(`createProject was allowed because one of your own default roots contains ${L.ROOT}; NOT_IN_DEFAULT_ROOT not checked`);
        } else {
          hasCode(r, "NOT_IN_DEFAULT_ROOT", "createProject outside every default root");
          missing(nope, "createProject outside the default roots");
        }
      } finally {
        await h.e2e("__e2e_addRoot", { root: L.ROOT });
      }
    },
  },
  {
    id: "P20", title: "each run is archived as a .js and logged in mcp-scripts/run-log.txt", kind: "hard",
    async run(h) {
      const dir = path.join(h.L.EDIT, "mcp-scripts");
      const code = `// e2e archive marker ${h.stamp}\nreturn "logged";`;
      let r = await h.script(code, "log-probe");
      ok(r, "log-probe");
      const archived = exists(dir) ? fs.readdirSync(dir).filter((f) => /_log-probe\.js$/.test(f)) : [];
      assert.equal(archived.length, 1, `one archive for log-probe, got ${fmt(archived)}`);
      assert.match(archived[0], /^\d{8}-\d{6}-\d{3}_log-probe\.js$/, "archive name <yyyymmdd-hhmmss-mmm>_<name>.js");
      assert.ok(fs.readFileSync(path.join(dir, archived[0]), "utf8").includes(`e2e archive marker ${h.stamp}`), "the archive holds the code");
      assert.equal(path.basename(r.archivedAs || ""), archived[0], `archivedAs, got ${fmt(r.archivedAs)}`);
      let line = h.runLog().filter((l) => l.split("\t")[1] === "log-probe").pop();
      assert.ok(line, "run-log.txt has a log-probe line");
      const [iso, name, outcome, ms] = line.split("\t");
      assert.ok(!Number.isNaN(Date.parse(iso)), `log time is ISO, got ${iso}`);
      assert.equal(name, "log-probe");
      assert.equal(outcome, "success");
      assert.ok(Number(ms) >= 0, `duration, line: ${line}`);

      r = await h.script(`throw new Error("log-probe-failure");`, "log-probe-err");
      assert.equal(r.status, "error");
      line = h.runLog().filter((l) => l.split("\t")[1] === "log-probe-err").pop();
      assert.ok(line, "run-log.txt has a log-probe-err line");
      assert.equal(line.split("\t")[2], "error", `outcome, line: ${line}`);
      assert.match(line, /log-probe-failure/, "the log line carries the message");
    },
  },
  {
    id: "P21", title: "a long script yields a 'running' result before the final result", kind: "hard",
    async run(h) {
      const ms = h.timing.slowMs;
      const r = await h.script(`await new Promise((resolve) => setTimeout(resolve, ${ms})); return "slow-done";`, "slow");
      assert.equal(r._statusesSeen[0], "running", `the first state should be "running", saw ${fmt(r._statusesSeen)}`);
      ok(r, "slow script");
      assert.equal(r.returnValue, "slow-done");
      assert.ok(r.durationMs >= ms * 0.8, `durationMs reflects the run, got ${r.durationMs}`);
    },
  },
  {
    id: "P22", title: "a script error returns its message and the line relative to the script", kind: "hard",
    async run(h) {
      let r = await h.script(["const a = 1;", "const b = a + 1;", 'throw new Error("boom-e2e");', "return b;"].join("\n"), "throw-line3");
      hasCode(r, "SCRIPT_ERROR", "throw");
      assert.match(String(r.message), /boom-e2e/);
      h.soft("a throw reports line 3", () => assert.equal(r.line, 3, fmt(r)));
      r = await h.script(["const x = 1;", "const y = 2;", "const z = 3;", "notAFunction_e2e();", "return z;"].join("\n"), "ref-line4");
      hasCode(r, "SCRIPT_ERROR", "runtime error");
      assert.match(String(r.message), /notAFunction_e2e/);
      const l4 = r.line;
      h.soft("a runtime error reports line 4", () => assert.equal(l4, 4, fmt(r)));
      r = await h.script(["const fine = 1;", "const = ;"].join("\n"), "syntax-error");
      hasCode(r, "SYNTAX_ERROR", "syntax error");
    },
  },
  {
    id: "P23", title: "returnValue round-trips objects, arrays, unicode; host objects become strings", kind: "hard",
    async run(h) {
      const expected = {
        n: 42, f: 1.5, neg: -7, s: 'quote " backslash \\ tab \t newline \n', unicode: "café →", t: true, nul: null,
        arr: [1, "two", null, false, [3, [4]]], nested: { deep: [{ k: 1 }, { k: "v" }], empty: {}, emptyArr: [] },
      };
      let r = await h.script(`return ${JSON.stringify(expected)};`, "return-object");
      ok(r, "return object");
      assert.deepEqual(r.returnValue, expected, "object round-trip");
      r = await h.script(`return [1, [2, [3]], { a: [] }, "x"];`, "return-array");
      assert.deepEqual(r.returnValue, [1, [2, [3]], { a: [] }, "x"], "array round-trip");
      r = await h.script(`return project;`, "return-host");
      ok(r, "return a host object");
      assert.equal(typeof r.returnValue, "string", `host objects become strings, got ${fmt(r.returnValue)}`);
      r = await h.script(`const o = {}; let c = o; for (let i = 0; i < 20; i++) { c.d = {}; c = c.d; } return o;`, "return-deep");
      ok(r, "deep nesting is cut, not an error");
      assert.ok(JSON.stringify(r.returnValue).includes("[depth limit]"), "the depth limit marker appears");
      r = await h.script(`return 12345678901234567890n;`, "return-bigint");
      assert.equal(r.returnValue, "12345678901234567890", "BigInt becomes a string");
      r = await h.script(`return undefined;`, "return-undefined");
      assert.equal(r.returnValue, null, "undefined becomes null");
    },
  },
  {
    id: "P24", title: "runScriptFile runs files inside the folder and refuses files outside", kind: "hard",
    async run(h) {
      const { L } = h;
      const dir = path.join(L.EDIT, "scripts");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "hello.js"), 'return { from: "file", n: 7 };');
      let r = await h.scriptFile("scripts\\hello.js");
      ok(r, "relative path");
      assert.deepEqual(r.returnValue, { from: "file", n: 7 });
      r = await h.scriptFile(path.join(dir, "hello.js"));
      ok(r, "absolute path inside");
      h.writeOutside("x.js", 'await fs.writeFile(sandbox.path("outside-ran.txt"), "ran", { encoding: "utf-8" }); return "ran";');
      r = await h.scriptFile("..\\outside\\x.js");
      refused(r, "OUTSIDE_FOLDER", "..\\outside\\x.js");
      r = await h.scriptFile(path.join(L.OUTSIDE, "x.js"));
      refused(r, "OUTSIDE_FOLDER", "absolute path outside");
      missing(path.join(L.EDIT, "outside-ran.txt"), "the outside file must not run");
      fs.writeFileSync(path.join(dir, "blocked.js"), 'return eval("1");');
      r = await h.scriptFile("scripts\\blocked.js");
      refused(r, "BLOCKED_CALL", "a file whose contents call eval");
      r = await h.scriptFile("scripts\\does-not-exist.js");
      hasCode(r, "FILE_NOT_FOUND", "a missing file inside the folder");
    },
  },
  {
    id: "P25", title: "stress: 20 rapid sequential commands each get exactly one matching result", kind: "hard",
    async run(h) {
      const dir = path.join(h.L.EDIT, "stress");
      fs.mkdirSync(dir, { recursive: true });
      const scripted = [];
      for (let i = 1; i <= 20; i++) {
        let r;
        if (i % 4 === 0) {
          r = await h.state();
          assert.ok(samePath(r.target && r.target.path, h.L.E2E), `#${i} getState`);
        } else {
          r = await h.script(`await fs.writeFile(sandbox.path("stress/stress-${i}.txt"), "${i}", { encoding: "utf-8", flag: "a" }); return ${i};`, `stress-${i}`);
          ok(r, `#${i} runScript`);
          assert.equal(r.returnValue, i);
          scripted.push(i);
        }
        assert.equal(r._commandId, r._sentId, `#${i} carries its own _commandId`);
        assert.ok(await h.waitUntil(() => {
          const c = h.client.readCommand();
          return c && c.id === r._sentId && (c.status === "completed" || c.status === "error");
        }, 5000), `#${i} the command file is marked completed`);
      }
      for (const i of scripted) {
        assert.equal(fs.readFileSync(path.join(dir, `stress-${i}.txt`), "utf8"), String(i), `stress-${i} ran exactly once`);
      }
      const logged = h.runLog().map((l) => l.split("\t")[1]).filter((n) => /^stress-\d+$/.test(n)).sort();
      assert.deepEqual(logged, scripted.map((i) => `stress-${i}`).sort(), "one run-log line per stress script");
    },
  },
  {
    id: "P26", title: "race: a command written while another script runs still runs afterwards", kind: "hard",
    async run(h) {
      const idA = await h.write("runScript", {
        name: "race-A",
        code: `await new Promise((resolve) => setTimeout(resolve, ${h.timing.raceMs})); await fs.writeFile(sandbox.path("race-A.txt"), "A", { encoding: "utf-8", flag: "a" }); return "A";`,
      });
      assert.ok(await h.waitUntil(() => {
        const r = h.client.readResult();
        const c = h.client.readCommand();
        return (r && r._commandId === idA && r.status === "running") || (c && c.id === idA && c.status === "running");
      }, 15000), "script A starts running");
      const idB = await h.write("runScript", { name: "race-B", code: `await fs.writeFile(sandbox.path("race-B.txt"), "B", { encoding: "utf-8", flag: "a" }); return "B";` });
      const { result: rB } = await h.client.waitForResult(idB, { timeoutMs: 60000 });
      ok(rB, "command B, written while A ran, runs");
      assert.equal(rB.returnValue, "B");
      assert.ok(await h.waitUntil(() => {
        const c = h.client.readCommand();
        return c && c.id === idB && c.status === "completed";
      }, 5000), "the command file shows B completed");
      assert.equal(fs.readFileSync(path.join(h.L.EDIT, "race-A.txt"), "utf8"), "A", "A ran exactly once");
      assert.equal(fs.readFileSync(path.join(h.L.EDIT, "race-B.txt"), "utf8"), "B", "B ran exactly once");
    },
  },
  {
    id: "P27", title: "Pause refuses commands (before the target check) and keeps the folder", kind: "hard", needs: ["interactive"],
    async run(h) {
      let paused = false;
      try {
        await h.prompt({ key: "pause-on", text: "Tick 'Pause' in the MCP Bridge panel in Premiere, then press Enter... " });
        paused = true;
        let gs = await h.state();
        ok(gs, "getState while paused (exempt)");
        assert.equal(gs.paused, true, "paused should be true (did you tick it?)");
        assert.equal(gs.scriptsEnabled, false);
        assert.ok(samePath(gs.target.folder, h.L.EDIT), "Pause keeps the folder");
        let r = await h.script(`return 1;`, "paused");
        refused(r, "PAUSED", "runScript while paused");
        r = await h.send("saveProject", {});
        refused(r, "PAUSED", "a typed tool while paused");
        r = await h.script(`return 1;`, "paused-no-expected", { omitExpected: true });
        refused(r, "PAUSED", "Pause is checked before expectedProject");
        r = await h.e2e("__e2e_countItems", { projectPath: h.L.E2E });
        refused(r, "PAUSED", "harness commands are paused too");
        await h.prompt({ key: "pause-off", text: "Now untick 'Pause', then press Enter... " });
        paused = false;
        gs = await h.state();
        assert.equal(gs.paused, false, "paused should be false (did you untick it?)");
        r = await h.script(`return "unpaused";`, "unpaused");
        ok(r, "runScript after unpausing");
      } finally {
        if (paused) await h.prompt({ key: "pause-ensure-off", text: "Make sure 'Pause' is unticked, then press Enter... " });
      }
    },
  },
  {
    id: "P28", title: "build/replace a sequence with trims, frame-exact via getSequence", kind: "hard", needs: ["media"],
    async run(h) {
      const p = await h.importMedia();
      let r = await h.send("createSequence", { name: "Build", bin: "Sequences", fromClips: [p.sh010] });
      ok(r, "createSequence from a clip");
      assert.equal(r.path, "Sequences/Build");
      assert.deepEqual([r.timebase.fpsNum, r.timebase.fpsDen], [30000, 1001], `the sequence takes the clip's 29.97, got ${fmt(r.timebase)}`);
      r = await h.send("buildSequence", { sequence: "Build", mode: "replace", track: "V1", clips: [
        { item: p.sh010, in: { frames: 10 }, out: { frames: 70 } },
        { item: p.sh020, in: { frames: 15 }, out: { frames: 100 } },
      ] });
      ok(r, "build replace with trims");
      assert.equal(r.placed.length, 2);
      assert.deepEqual([r.placed[0].start.frames, r.placed[0].end.frames], [0, 60], `clip 1 spans 0-60, got ${fmt(r.placed[0])}`);
      const built = r;
      let s = await h.getSeq("Build");
      let v1 = trackItems(s, "V1");
      assert.equal(v1.length, 2, `replace leaves exactly the 2 new clips on V1, got ${fmt(v1)}`);
      assert.deepEqual([v1[0].start.frames, v1[0].end.frames], [0, 60], `V1[0] is frame-exact, got ${fmt(v1[0])}`);
      h.soft("buildSequence verified every placement", () => assert.equal(built.verified, true, fmt(built.mismatches)));
      h.soft("the second trimmed clip spans 60-145", () => assert.deepEqual([v1[1].start.frames, v1[1].end.frames], [60, 145], fmt(v1[1])));
      h.soft("the first clip's in point is 10", () => assert.equal(v1[0].in.frames, 10, fmt(v1[0])));
      h.soft("linked audio lands on A1 at the same starts", () => {
        const a1 = trackItems(s, "A1");
        assert.deepEqual(a1.map((i) => i.start.frames), v1.map((i) => i.start.frames), fmt(a1));
      });

      r = await h.send("buildSequence", { sequence: "Build", mode: "replace", track: "V1", clips: [{ item: p.sh020 }] });
      ok(r, "replace with one untrimmed clip");
      s = await h.getSeq("Build");
      v1 = trackItems(s, "V1");
      assert.equal(v1.length, 1, `replace clears the track first, got ${fmt(v1)}`);
      assert.equal(v1[0].start.frames, 0);
      assert.equal(v1[0].end.frames, r.placed[0].end.frames, "getSequence matches the build result");

      r = await h.send("buildSequence", { sequence: "Build", mode: "append", track: "V1", clips: [{ item: p.c23976 }] });
      ok(r, "append a 23.976 clip to the 29.97 sequence");
      const appended = r;
      s = await h.getSeq("Build");
      const v1b = trackItems(s, "V1");
      h.soft("the appended 23.976 clip starts where the track ended", () => {
        assert.equal(v1b.length, 2, fmt(v1b));
        assert.equal(v1b[1].start.frames, v1b[0].end.frames, fmt(v1b));
        assert.equal(appended.verified, true, fmt(appended.mismatches));
      });

      r = await h.send("buildSequence", { sequence: "Build", mode: "append", clips: [{ item: p.sh010, in: { frames: 1.5 } }] });
      hasCode(r, "BAD_TIME", "a float frame count");
      r = await h.send("buildSequence", { sequence: "Build", mode: "append", clips: [{ item: p.sh010, in: { timecode: "1:2" } }] });
      hasCode(r, "BAD_TIME", "a malformed timecode");
      r = await h.send("buildSequence", { sequence: "NoSuchSequence", mode: "append", clips: [{ item: p.sh010 }] });
      hasCode(r, "SEQUENCE_NOT_FOUND", "an unknown sequence");
    },
  },
  {
    id: "P29", title: "markers on a sequence and a clip (bulk, timecode, colours)", kind: "hard", needs: ["media"],
    async run(h) {
      const seq = await h.makeSequence("Markers");
      let r = await h.send("addMarkers", { target: { sequence: seq.name }, markers: [
        { at: { frames: 0 }, name: "Start", comment: "e2e", color: "Green" },
        { at: { timecode: "00:00:01:00" }, duration: { frames: 10 }, name: "Beat", color: 3 },
      ] });
      ok(r, "addMarkers");
      assert.equal(r.added, 2);
      assert.equal(r.markers[1].at.frames, 30, `00:00:01:00 at 29.97 NDF is frame 30, got ${fmt(r.markers[1])}`);
      assert.equal(r.markers[1].duration.frames, 10);
      const steps = r.undoSteps;
      h.soft("markers plus colours report 2 undo steps", () => assert.equal(steps, 2, `undoSteps ${steps}`));
      r = await h.send("addMarkers", { target: { sequence: seq.name }, markers: [{ at: { frames: 1.5 }, name: "Float" }] });
      hasCode(r, "BAD_TIME", "a float marker time");
      r = await h.send("addMarkers", { target: { sequence: seq.name }, markers: [{ at: { frames: 1 }, name: "Bad", color: "chartreuse" }] });
      hasCode(r, "BAD_ARGS", "an unknown colour");
      await h.soft("the markers can be read back by a script", async () => {
        const names = await h.markerNames(seq.name);
        assert.ok(names.includes("Start") && names.includes("Beat"), fmt(names));
      });
      await h.soft("a marker on a project item", async () => {
        const m = await h.send("addMarkers", { target: { item: seq.paths.sh020 }, markers: [{ at: { frames: 5 }, name: "ItemMark" }] });
        ok(m, "item marker");
      });
    },
  },
  {
    id: "P30", title: "edit-items: move, trims (edge trims), enable/disable, removes, ripple", kind: "hard", needs: ["media"],
    async run(h) {
      const seq = await h.makeSequence("EditOps");
      let s = await h.getSeq(seq.name);
      let v1 = trackItems(s, "V1");
      assert.equal(v1.length, 2, `two clips to start with, got ${fmt(v1)}`);
      const dur1 = v1[1].end.frames - v1[1].start.frames;

      let r = await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 1, op: "move", to: { frames: 150 } }] });
      ok(r, "move V1[1] to 150");
      const moveSteps = r.undoSteps;
      s = await h.getSeq(seq.name);
      v1 = trackItems(s, "V1");
      assert.deepEqual([v1[1].start.frames, v1[1].end.frames], [150, 150 + dur1], `moved, got ${fmt(v1[1])}`);
      h.soft("a typed edit is one undo step", () => assert.equal(moveSteps, 1, `undoSteps ${moveSteps}`));
      const sMove = s;
      h.soft("the linked audio moved with it", () => assert.ok(trackItems(sMove, "A1").some((i) => i.start.frames === 150), fmt(trackItems(sMove, "A1"))));

      r = await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 0, op: "trim", end: { frames: 100 } }] });
      ok(r, "trim V1[0] end to 100");
      s = await h.getSeq(seq.name);
      v1 = trackItems(s, "V1");
      assert.equal(v1[0].end.frames, 100, `trimmed end, got ${fmt(v1[0])}`);
      assert.equal(v1[0].start.frames, 0, "the start stays");

      r = await h.send("editItems", { sequence: seq.name, ripple: true, edits: [{ track: "V1", index: 0, op: "move", delta: { frames: 5 } }] });
      hasCode(r, "BAD_ARGS", "a ripple move (UXP's move can't ripple)");
      r = await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 9, op: "remove" }] });
      hasCode(r, "ITEM_NOT_FOUND", "an index past the end");

      await h.soft("trim in = 10 is an edge trim: the head moves (start 10, in 10)", async () => {
        const before = trackItems(await h.getSeq(seq.name), "V1")[0];
        ok(await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 0, op: "trim", in: { frames: before.in.frames + 10 } }] }), "trim in");
        const after = trackItems(await h.getSeq(seq.name), "V1")[0];
        assert.deepEqual([after.start.frames, after.in.frames, after.end.frames], [before.start.frames + 10, before.in.frames + 10, before.end.frames], fmt({ before, after }));
      });
      await h.soft("trim out = out - 10 is an edge trim: the tail moves", async () => {
        const before = trackItems(await h.getSeq(seq.name), "V1")[1];
        ok(await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 1, op: "trim", out: { frames: before.out.frames - 10 } }] }), "trim out");
        const after = trackItems(await h.getSeq(seq.name), "V1")[1];
        assert.deepEqual([after.start.frames, after.end.frames, after.out.frames], [before.start.frames, before.end.frames - 10, before.out.frames - 10], fmt({ before, after }));
      });
      await h.soft("disable then enable a clip", async () => {
        ok(await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 1, op: "disable" }] }), "disable");
        assert.equal(trackItems(await h.getSeq(seq.name), "V1")[1].enabled, false, "disabled");
        ok(await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 1, op: "enable" }] }), "enable");
        assert.equal(trackItems(await h.getSeq(seq.name), "V1")[1].enabled, true, "enabled");
      });
      await h.soft("remove only the audio half of a linked clip", async () => {
        const before = await h.getSeq(seq.name);
        const a1 = trackItems(before, "A1");
        const v1Start = trackItems(before, "V1")[1].start.frames;
        const ai = a1.find((i) => i.start.frames === v1Start);
        assert.ok(ai, `an A1 partner at ${v1Start}: ${fmt(a1)}`);
        ok(await h.send("editItems", { sequence: seq.name, edits: [{ track: "A1", index: ai.index, op: "remove", mediaType: "audio" }] }), "remove audio");
        const after = await h.getSeq(seq.name);
        assert.equal(trackItems(after, "A1").length, a1.length - 1, "one audio clip fewer");
        assert.equal(trackItems(after, "V1").length, trackItems(before, "V1").length, "the video stays");
      });
      await h.soft("a ripple remove closes the gap", async () => {
        const before = trackItems(await h.getSeq(seq.name), "V1");
        assert.equal(before.length, 2, fmt(before));
        const gone = before[0].end.frames - before[0].start.frames;
        ok(await h.send("editItems", { sequence: seq.name, ripple: true, edits: [{ track: "V1", index: 0, op: "remove" }] }), "ripple remove");
        const after = trackItems(await h.getSeq(seq.name), "V1");
        assert.equal(after.length, 1, fmt(after));
        assert.equal(after[0].start.frames, before[1].start.frames - gone, fmt({ before, after }));
      });
    },
  },
  {
    id: "P31", title: "place audio (music) on A2 and set its level and fades", kind: "hard", needs: ["media"],
    async run(h) {
      const seq = await h.makeSequence("Audio");
      let r = await h.send("placeAudio", { sequence: seq.name, item: seq.paths.music, track: "A2", at: { frames: 0 }, out: { frames: 120 }, mode: "overwrite" });
      ok(r, "placeAudio");
      assert.equal(r.track, "A2");
      assert.equal(r.start.frames, 0);
      const placed = r;
      const s = await h.getSeq(seq.name);
      const a2 = trackItems(s, "A2");
      assert.equal(a2.length, 1, `one clip on A2, got ${fmt(a2)}`);
      assert.equal(a2[0].start.frames, 0);
      h.soft("the out point (120 frames) is honoured", () => {
        assert.equal(a2[0].end.frames, 120, fmt(a2[0]));
        assert.equal(placed.verified, true);
      });
      r = await h.send("setAudio", { sequence: seq.name, track: "A2", index: 0, levelDb: -6, fades: { inFrames: 15, outFrames: 15 } });
      ok(r, "setAudio level and fades");
      assert.equal(r.levelDb, -6);
      assert.equal(r.keyframes.length, 4, `fade in + fade out = 4 keyframes, got ${fmt(r.keyframes)}`);
      r = await h.send("setAudio", { sequence: seq.name, track: "A2", index: 0, levelDb: 12 });
      hasCode(r, "BAD_ARGS", "a level above +6 dB");
      r = await h.send("placeAudio", { sequence: seq.name, item: seq.paths.music, track: "V1", at: { frames: 0 } });
      hasCode(r, "BAD_ARGS", "audio on a video track");
    },
  },
  {
    id: "P32", title: "a video transition (Cross Dissolve) at a clip edge", kind: "hard", needs: ["media"],
    async run(h) {
      const seq = await h.makeSequence("Trans");
      let r = await h.send("addTransition", { sequence: seq.name, track: "V1", index: 0, edge: "end", type: "Cross Dissolve", durationFrames: 10 });
      ok(r, "addTransition");
      assert.match(r.matchName, /Cross Dissolve/i);
      assert.equal(r.duration.frames, 10);
      r = await h.send("addTransition", { sequence: seq.name, track: "V1", index: 0, edge: "end", durationFrames: 0 });
      hasCode(r, "BAD_TIME", "a zero-length transition");
      await h.soft("getSequence still works after a transition and lists it", async () => {
        const s = await h.getSeq(seq.name);
        const v1 = (s.tracks || []).find((t) => t.track === "V1");
        assert.ok(v1 && v1.transitions.length >= 1, fmt(v1));
      });
    },
  },
  {
    id: "P33", title: "sidecar-only operations refuse cleanly without the sidecar (no save, no backup)", kind: "hard", needs: ["media", "noSidecar"],
    async run(h) {
      const seq = await h.makeSequence("NoSidecar");
      const before = h.backups();
      let r = await h.send("setSpeed", { sequence: seq.name, track: "V1", index: 0, percent: 50 });
      hasCode(r, "NEEDS_SIDECAR_UNAVAILABLE", "setSpeed");
      assert.equal(r.undoSteps, 0);
      assert.equal(r.backupPath, undefined, "a refusal known up front takes no backup");
      r = await h.send("addTransition", { sequence: seq.name, track: "A1", index: 0, edge: "start", durationFrames: 10 });
      hasCode(r, "NEEDS_SIDECAR_UNAVAILABLE", "an audio transition");
      assert.equal(r.undoSteps, 0);
      assert.deepEqual(h.backups(), before, "no new backups");
    },
  },
  {
    id: "P34", title: "set speed through the sidecar", kind: "soft", needs: ["media", "sidecar"],
    async run(h) {
      const seq = await h.makeSequence("Speed");
      const before = trackItems(await h.getSeq(seq.name), "V1");
      const r = await h.tool(...SIDECAR_TOOL_CALLS.speed(seq.name));
      ok(r, "setSpeed via the sidecar");
      h.note(`info: host call ${r.hostCall}`);
      const after = trackItems(await h.getSeq(seq.name), "V1");
      assert.equal(after[0].speed, 0.5, fmt(after[0]));
      const d0 = before[0].end.frames - before[0].start.frames;
      assert.ok(Math.abs(after[0].end.frames - after[0].start.frames - d0 * 2) <= 1, `half speed doubles the duration: ${d0} -> ${after[0].end.frames - after[0].start.frames}`);
      assert.equal(after[1].start.frames, after[0].end.frames, "ripple pushed the next clip");
    },
  },
  {
    id: "P35", title: "an audio crossfade through the sidecar", kind: "soft", needs: ["media", "sidecar"],
    async run(h) {
      const seq = await h.makeSequence("AudioXfade");
      const r = await h.tool(...SIDECAR_TOOL_CALLS.audioCrossfade(seq.name));
      ok(r, "audio transition via the sidecar");
      assert.equal(r._commandExecuted, "addAudioTransition", "an audio track goes to the sidecar's addAudioTransition");
      assert.ok(Array.isArray(r.added) && r.added.length === 1, `one transition added, got ${fmt(r.added)}`);
      await h.soft("getSequence lists the audio transition on A1", async () => {
        const a1 = ((await h.getSeq(seq.name)).tracks || []).find((t) => t.track === "A1");
        assert.ok(a1 && a1.transitions.length >= 1, fmt(a1));
      });
    },
  },
  {
    id: "P36", title: "unlink and relink a clip through the sidecar", kind: "soft", needs: ["media", "sidecar"],
    async run(h) {
      const seq = await h.makeSequence("Link");
      let r = await h.tool(...SIDECAR_TOOL_CALLS.unlink(seq.name));
      ok(r, "unlink via the sidecar");
      assert.equal(r._commandExecuted, "unlink");
      const unlinked = r.items.map((i) => i.linkedItems);
      r = await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 0, op: "move", delta: { frames: 5 }, mediaType: "video" }] });
      ok(r, "move only the video");
      const s = await h.getSeq(seq.name);
      assert.equal(trackItems(s, "A1")[0].start.frames, 0, "the unlinked audio stays");
      // Move the video back so the pair lines up again, then relink.
      ok(await h.send("editItems", { sequence: seq.name, edits: [{ track: "V1", index: 0, op: "move", delta: { frames: -5 }, mediaType: "video" }] }), "move the video back");
      r = await h.tool(...SIDECAR_TOOL_CALLS.link(seq.name));
      ok(r, "link via the sidecar");
      assert.equal(r._commandExecuted, "link");
      // getLinkedItems().numItems may or may not count the clip itself; linking must raise it either way.
      assert.ok(r.items.every((i, k) => typeof i.linkedItems === "number" && i.linkedItems > unlinked[k]),
        `both clips linked again: unlinked ${fmt(unlinked)}, now ${fmt(r.items)}`);
    },
  },
  {
    id: "P37", title: "redirecting a scratch disk outside the folder is refused", kind: "hard",
    async run(h) {
      const before = (await h.state()).scratchDisks;
      // Evidence for the next reader: the live scratch-disk API surface (read-only).
      const api = await h.script(`const PS = ppro.ProjectSettings;
const s = await PS.getScratchDiskSettings(project);
const names = (o) => { const out = []; for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) out.push(...Object.getOwnPropertyNames(p)); return [...new Set(out)].sort(); };
return { projectSettings: names(PS), settings: names(s), types: ppro.Constants.ScratchDiskFolderType, folders: ppro.Constants.ScratchDiskFolder };`, "scratch-api");
      if (api.status === "success") h.note(`info: scratch API ${fmt(api.returnValue)}`);
      // ScratchDiskSettings.setScratchDiskPath(type, location), applied with ProjectSettings
      // .createSetScratchDiskSettingsAction(project, settings) in a transaction (docs/premiere-uxp-cheatsheet.md).
      // The guard refuses at the setter, so the action is never built; were the setter let through, the
      // transaction would apply it and the before/after check below would catch it.
      const attempt = (type, location, swap) => `const T = ppro.Constants.ScratchDiskFolderType;
const s = await ppro.ProjectSettings.getScratchDiskSettings(project);
${swap ? `s.setScratchDiskPath(${location}, T.${type});` : `s.setScratchDiskPath(T.${type}, ${location});`}
if (typeof ppro.ProjectSettings.createSetScratchDiskSettingsAction === "function") {
  sandbox.transaction("scratch", (compound) => compound.addAction(ppro.ProjectSettings.createSetScratchDiskSettingsAction(project, s)));
}
return "changed";`;
      let r = await h.script(attempt("VIDEO_PREVIEW", lit(h.L.OUTSIDE)), "scratch-outside");
      blockedWrite(r, h.L.OUTSIDE, "video previews to outside\\");
      r = await h.script(attempt("VIDEO_PREVIEW", lit(h.L.OUTSIDE), true), "scratch-outside-swapped");
      blockedWrite(r, h.L.OUTSIDE, "video previews to outside\\ (arguments the other way round)");
      r = await h.script(attempt("AUTO_SAVE", "ppro.Constants.ScratchDiskFolder.MY_DOCUMENTS"), "scratch-mydocs");
      hasCode(r, "OUTSIDE_FOLDER", "auto-save to My Documents");
      const after = (await h.state()).scratchDisks;
      assert.deepEqual(after, before, "the scratch disks are unchanged");
    },
  },
  {
    id: "P38", title: "one Undo in Premiere reverses one typed tool", kind: "soft", needs: ["media", "interactive"],
    async run(h) {
      const seq = await h.makeSequence("UndoSeq");
      const r = await h.send("addMarkers", { target: { sequence: seq.name }, markers: [{ at: { frames: 3 }, name: "UndoProbe" }] });
      ok(r, "addMarkers");
      assert.equal(r.undoSteps, 1, "one marker without a colour is one undo step");
      assert.ok((await h.markerNames(seq.name)).includes("UndoProbe"), "the marker is there");
      await h.prompt({ key: "undo", sequence: seq.name, text: `In Premiere, open sequence ${seq.name} in E2E.prproj, click in its timeline, press Ctrl+Z once, then press Enter... ` });
      const names = await h.markerNames(seq.name);
      assert.ok(!names.includes("UndoProbe"), `one Undo removes the marker, got ${fmt(names)}`);
    },
  },
  {
    id: "P39", title: "replace media relinks a clip, keeps its trims and renames it", kind: "hard", needs: ["media"],
    async run(h) {
      const seq = await h.makeSequence("Relink");
      const { M } = h;
      let r = await h.send("replaceMedia", { item: seq.paths.sh010, newFile: M.sh010v2, keepTrims: true, rename: "SH010_v002" });
      ok(r, "replaceMedia");
      assert.ok(samePath(r.mediaPath, M.sh010v2), `mediaPath, got ${r.mediaPath}`);
      assert.ok(samePath(r.previousMediaPath, M.sh010), `previousMediaPath, got ${r.previousMediaPath}`);
      assert.match(r.path, /\/SH010_v002$/, `renamed, got ${r.path}`);
      const relinked = r;
      r = await h.send("getProjectItems", { type: "clip" });
      ok(r, "getProjectItems");
      const it = r.items.find((i) => i.path === relinked.path);
      assert.ok(it && samePath(it.mediaPath, M.sh010v2), `the project item points at the new file, got ${fmt(it)}`);
      // An unmarked clip reports in/out as null (Premiere's -400000 s "unset" sentinel); that counts as unchanged.
      h.soft("the clip's trims are kept (unset, or readable and unchanged)", () => {
        const t = relinked.trims;
        assert.ok(t && (t.in === null || t.in.frames >= 0) && (t.out === null || t.out.frames >= 0), fmt(t));
      });
      await h.soft("the timeline use follows the relink", async () => {
        const v1 = trackItems(await h.getSeq(seq.name), "V1");
        assert.ok(v1[0].item && samePath(v1[0].item.mediaPath, M.sh010v2), fmt(v1[0]));
      });
      r = await h.send("replaceMedia", { item: seq.paths.sh020, newFile: path.join(h.L.MEDIA, "missing.mp4") });
      hasCode(r, "FILE_NOT_FOUND", "relink to a missing file");
      r = await h.send("replaceMedia", { item: seq.paths.sh020, newFile: "relative.mp4" });
      hasCode(r, "BAD_ARGS", "relink to a relative path");
    },
  },
  {
    id: "P40", title: "nothing was written to outside\\ except the harness's own files", kind: "hard", noEnsure: true,
    async run(h) {
      if (h.st.outsideWritten.has("*")) {
        h.note("skipped: a project was created in outside\\ (see P19)");
        return;
      }
      const unexpected = listRecursive(h.L.OUTSIDE).filter((f) => !h.st.outsideWritten.has(f.toLowerCase()));
      assert.deepEqual(unexpected, [], `unexpected files in ${h.L.OUTSIDE}`);
    },
  },
];

// ---------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------

/**
 * Runs the suite. Returns { exitCode, results, sent, root, teardownProblems, refusedReason? }.
 * opts: bridgeDir, tempBase, stamp, interactive, prompt({key,text}), media ("auto"|"fake"|"none"), only (ids),
 *       timing { slowMs, raceMs, caseTimeoutMs, commandTimeoutMs, probeTimeoutMs, pollMs }, log(line),
 *       handleSigint, exportPreset.
 */
export async function runSuite(opts = {}) {
  const out = opts.log || ((s) => console.log(s));
  const stamp = opts.stamp || makeStamp();
  const L = makeLayout(opts.tempBase || defaultTempBase(), stamp);
  const timing = {
    slowMs: 3000, raceMs: 2000, caseTimeoutMs: 300000, commandTimeoutMs: 120000, probeTimeoutMs: 10000, pollMs: 50,
    ...(opts.timing || {}),
  };
  const sent = [];
  const results = [];
  const st = {
    setupStarted: false, setupComplete: false, tornDown: false, aborted: false, teardownMode: false, caseGen: 0,
    rootAdded: false, projects: new Set(), outsideWritten: new Set(), userProjects: [], sidecarAvailable: false, media: null,
  };

  const guard = (cmd) => {
    if (st.aborted && !st.teardownMode) throw new Error(`run aborted; not sending ${cmd.command}`);
    if (!st.setupComplete && !isExemptCommand(cmd.command)) throw new Error(`setup is incomplete; refusing to send ${cmd.command}`);
    const why = checkCommandTarget(cmd, L.ROOT);
    if (why) throw new Error(`SAFETY: refusing to send a command that targets something outside the temp root: ${why}`);
  };
  const onSend = (cmd) => sent.push({ cmd, result: null });
  const clientOpts = { bridgeDir: opts.bridgeDir, guard, onSend, pollMs: timing.pollMs, timeoutMs: timing.commandTimeoutMs };
  const client = createPrClient(clientOpts);
  const sidecar = createPrClient({ ...clientOpts, prefix: "prx" });

  async function send(command, args = {}, so = {}) {
    const o = { ...so };
    if (!o.omitExpected && o.expectedProject === undefined && !isExemptCommand(command)) o.expectedProject = L.E2E;
    if (o.expectedProject === null) delete o.expectedProject;
    const c = o.channel === "prx" ? sidecar : client;
    const r = await c.send(command, args, o);
    const rec = sent.find((s) => s.cmd.id === r._sentId);
    if (rec) rec.result = { status: r.status, code: r.code, refused: r.refused === true };
    trackFrom(r);
    return r;
  }

  // Every throwaway project the run creates, opens or Save-As-retargets to, for teardown: a Save As moves the
  // result's _project, and createProject / openProject name theirs in projectPath / path.
  function trackFrom(r) {
    if (!r || r.status !== "success") return;
    for (const p of [r._project, r.projectPath, r.path]) {
      if (typeof p === "string" && /\.prproj$/i.test(p) && isInside(p, L.ROOT)) st.projects.add(p);
    }
  }
  const e2e = (command, args) => send(command, args);
  const state = (ep = L.E2E) => send("getState", {}, ep === null ? {} : { expectedProject: ep });

  let rl = null;
  const prompt = opts.prompt || (async ({ text }) => {
    rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\n>>> " + text);
  });

  async function waitUntil(pred, ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (await pred()) return true;
      if (Date.now() > end) return false;
      await sleep(Math.min(50, timing.pollMs));
    }
  }

  async function ensureE2E() {
    await client.waitForIdle(timing.commandTimeoutMs);
    let gs = await state();
    ok(gs, "getState before the case");
    if (gs.paused) throw new Error("Pause is ticked in the MCP Bridge panel; untick it");
    if (!(gs.openProjects || []).some((p) => samePath(p.path, L.E2E))) {
      ok(await e2e("__e2e_openProject", { path: L.E2E }), "reopen E2E.prproj");
      gs = await state();
    }
    if (!gs.target || !samePath(gs.target.folder, L.EDIT)) {
      ok(await e2e("__e2e_setFolder", { projectPath: L.E2E, folder: L.EDIT }), "set E2E's folder");
    }
  }

  function makeH(gen, notes) {
    const live = () => {
      if (gen !== st.caseGen) throw new Error("this case timed out; not sending more commands");
    };
    const h = {
      L, M: st.media ? st.media.files : {}, st, stamp, timing, client, prompt, waitUntil, exportPreset: opts.exportPreset,
      async send(c, a, so) { live(); return send(c, a, so); },
      async e2e(c, a) { live(); return e2e(c, a); },
      async state(ep) { live(); return state(ep === undefined ? L.E2E : ep); },
      // Sends what the MCP server sends for that tool: its command name, args and channel (pr or prx).
      async tool(toolName, params, so = {}) {
        live();
        const route = (await serverRoutes())[toolName];
        if (!route) throw new Error(`no server route for ${toolName}`);
        const routed = route({ ...params });
        return send(routed.command, routed.args || params, { ...so, channel: routed.via });
      },
      script: (code, name, so) => h.send("runScript", name ? { code, name } : { code }, so),
      scriptFile: (file, so) => h.send("runScriptFile", { file }, so),
      async write(command, args) { live(); return client.writeCommand(command, args, { expectedProject: L.E2E }); },
      ensureE2E: async () => { live(); await ensureE2E(); },
      note: (msg) => notes.push(msg),
      soft(label, fn) {
        const fail = (e) => notes.push(`${label}: ${String(e && e.message ? e.message : e).split("\n")[0]}`);
        try {
          const v = fn();
          if (v && typeof v.then === "function") return v.then(() => {}, fail);
        } catch (e) {
          fail(e);
        }
        return undefined;
      },
      trackProject: (p) => st.projects.add(p),
      allowOutside: (rel) => st.outsideWritten.add(rel.toLowerCase()),
      writeOutside(rel, content) {
        const p = path.join(L.OUTSIDE, rel);
        fs.writeFileSync(p, content);
        st.outsideWritten.add(rel.toLowerCase());
        return p;
      },
      runLog() {
        const f = path.join(L.EDIT, "mcp-scripts", "run-log.txt");
        return exists(f) ? fs.readFileSync(f, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean) : [];
      },
      backups() {
        const d = path.join(L.EDIT, "mcp-scripts", "backups");
        return exists(d) ? fs.readdirSync(d).sort() : [];
      },
      waitFile: (p, ms) => waitUntil(() => exists(p), ms),
      async importMedia() {
        const M = h.M;
        const files = [M.sh010, M.sh020, M.c23976, M.music];
        const r = await h.send("importFiles", { files, bin: "Renders/v001", skipExisting: true });
        ok(r, "import the test media");
        const byFile = new Map();
        for (const it of r.items || []) byFile.set(normalize(it.mediaPath), it.path);
        for (const s of r.skipped || []) byFile.set(normalize(s.file), s.path);
        const paths = {};
        for (const k of ["sh010", "sh020", "c23976", "music"]) {
          paths[k] = byFile.get(normalize(M[k]));
          assert.ok(paths[k], `import did not report ${M[k]}: ${fmt(r)}`);
        }
        return paths;
      },
      // A fresh sequence <name> in bin Sequences, with SH010 then SH020 (untrimmed) on V1 (and A1).
      async makeSequence(name) {
        const paths = await h.importMedia();
        ok(await h.send("createSequence", { name, bin: "Sequences", fromClips: [paths.sh010] }), `createSequence ${name}`);
        const build = await h.send("buildSequence", { sequence: name, mode: "replace", track: "V1", clips: [{ item: paths.sh010 }, { item: paths.sh020 }] });
        ok(build, `buildSequence ${name}`);
        return { name, paths, build };
      },
      async getSeq(name) {
        const r = await h.send("getSequence", { sequence: name });
        ok(r, `getSequence ${name}`);
        return r;
      },
      async markerNames(seqName) {
        const r = await h.script(`const seq = (await project.getSequences()).find((s) => s.name === ${lit(seqName)});
const markers = await ppro.Markers.getMarkers(seq);
return Array.from(markers.getMarkers()).map((m) => m.getName());`, "read-markers");
        ok(r, "read markers");
        return r.returnValue;
      },
    };
    return h;
  }

  const print = (rec) => {
    const tag = rec.outcome.padEnd(4);
    out(`${tag}  ${rec.id}  ${rec.title}${rec.detail ? "  -- " + rec.detail : ""}`);
    for (const n of rec.notes || []) out(`            soft: ${n}`);
  };
  const record = (c, outcome, detail, notes) => {
    const rec = { id: c.id, title: c.title, kind: c.kind, outcome, detail: detail || "", notes: notes || [] };
    results.push(rec);
    print(rec);
  };

  async function teardown() {
    if (st.tornDown) return [];
    st.tornDown = true;
    st.teardownMode = true;
    const problems = [];
    const leftOpen = [];
    if (st.setupStarted && !(await client.waitForIdle(30000))) problems.push("the bridge still had a command in flight");
    if (st.setupStarted) {
      try {
        const rs = await e2e("__e2e_readSettings", {});
        ok(rs, "__e2e_readSettings");
        for (const p of Object.keys(rs.folders || {})) {
          if (!isInside(p, L.ROOT)) continue;
          const r = await e2e("__e2e_clearFolder", { projectPath: p });
          if (r.status !== "success") problems.push(`clear folder setting for ${p}: ${r.code || r.message}`);
        }
      } catch (e) {
        problems.push(`clear folder settings: ${e.message}`);
      }
      try {
        const r = await e2e("__e2e_removeRoot", { root: L.ROOT });
        if (r.status !== "success") problems.push(`forget default root: ${r.code || r.message}`);
      } catch (e) {
        problems.push(`forget default root: ${e.message}`);
      }
      // Close every throwaway project: the tracked ones (setup, Save As results, reopened ones) and anything else
      // open under the root. Repeat until none is left, because a project can hide another in a listing (Save As
      // copies share a GUID) and only shows up once its twin is closed.
      try {
        const failedClose = new Set();
        for (let round = 0; round < 6; round++) {
          const gs = await state(null);
          const ours = new Set([...st.projects].map((p) => normalize(p)));
          const open = (gs.openProjects || []).filter((p) => isInside(p.path, L.ROOT) || ours.has(normalize(p.path)));
          const todo = open.filter((p) => !failedClose.has(normalize(p.path)));
          if (!todo.length) {
            leftOpen.push(...open.map((p) => p.path));
            break;
          }
          for (const p of todo) {
            const r = await e2e("__e2e_closeProject", { path: p.path });
            if (r.status !== "success" && r.code !== "PROJECT_NOT_OPEN") {
              problems.push(`close ${p.path}: ${r.code || r.message}`);
              failedClose.add(normalize(p.path));
            }
          }
        }
      } catch (e) {
        problems.push(`close the throwaway projects: ${e.message}`);
        leftOpen.push(...st.projects);
      }
      if (leftOpen.length && !problems.some((p) => p.startsWith("close "))) problems.push(`still open: ${leftOpen.join(", ")}`);
    }
    // Premiere keeps media and preview files open for a while after a project closes (EPERM / EBUSY): retry.
    const deadline = Date.now() + (timing.deleteRetryMs === undefined ? 30000 : timing.deleteRetryMs);
    for (;;) {
      try {
        fs.rmSync(L.ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        break;
      } catch (e) {
        if (["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code) && Date.now() < deadline) {
          await sleep(1000);
          continue;
        }
        let left = [];
        try { left = listRecursive(L.ROOT); } catch { /* gone or unreadable */ }
        problems.push(`delete ${L.ROOT}: ${e.code || e.message}; left behind: ${left.length ? left.join(", ") : "(the folder itself)"}`);
        break;
      }
    }
    if (problems.length) {
      out(`[pr-e2e] TEARDOWN INCOMPLETE:\n  - ${problems.join("\n  - ")}`);
      out([
        "[pr-e2e] Restore by hand:",
        `  1. In Premiere, close these throwaway projects without saving: ${leftOpen.length ? leftOpen.join(", ") : `any project under ${L.ROOT}`}.`,
        `  2. In the MCP Bridge panel, ${L.ROOT} may still be a remembered default folder: select a project under it and click "Forget default". Nothing writes there once the folder is gone.`,
        `  3. Delete ${L.ROOT} if it still exists.`,
        "  Your own projects were never targeted.",
      ].join("\n"));
    }
    return problems;
  }

  const onSigint = () => {
    out("\n[pr-e2e] Interrupted; tearing down (press Ctrl+C again to force quit)...");
    st.aborted = true;
    st.caseGen++;
    teardown().finally(() => process.exit(130));
  };
  if (opts.handleSigint) process.once("SIGINT", onSigint);

  const started = Date.now();
  let teardownProblems = [];
  try {
    // 1. Is the panel there, and does it allow the harness?
    let probe;
    try {
      probe = await client.send("getState", {}, { timeoutMs: timing.probeTimeoutMs });
    } catch (e) {
      return refuse(`The MCP Bridge panel did not answer getState. Is it open in Premiere and watching ${client.bridgeDir}?\n${e.message}`);
    }
    if (probe.status !== "success") return refuse(`getState failed: ${fmt(probe)}`);
    if (probe.testHarnessEnabled !== true) {
      return refuse('The panel refuses test-harness commands. Tick "Allow test harness" in the MCP Bridge panel in Premiere (it resets every launch), then run again.');
    }
    if (probe.paused) return refuse("Pause is ticked in the MCP Bridge panel. Untick it, then run again.");
    st.sidecarAvailable = probe.sidecarAvailable === true;
    st.userProjects = (probe.openProjects || []).map((p) => p.path).filter((p) => p && !isInside(p, L.ROOT));
    out(`[pr-e2e] Premiere ${probe.app && probe.app.version ? probe.app.version : "(version unknown)"}; sidecar ${st.sidecarAvailable ? "available" : "not available"}.`);
    out(`[pr-e2e] Your open projects (never targeted): ${st.userProjects.length ? st.userProjects.map((p) => path.basename(p)).join(", ") : "none"}.`);
    out(`[pr-e2e] Throwaway root: ${L.ROOT}`);

    // 2. Folders and media.
    st.setupStarted = true;
    for (const d of [L.EDIT, L.OUTSIDE, L.SECOND_DIR, L.MEDIA]) fs.mkdirSync(d, { recursive: true });
    st.media = prepareMedia(L.MEDIA, opts.media || "auto");
    if (!st.media.available) out(`[pr-e2e] No test media (${st.media.reason}); media-dependent cases will be skipped.`);

    // 3. Throwaway projects: the temp root becomes a default root, so createProject is allowed there.
    try {
      ok(await e2e("__e2e_addRoot", { root: L.ROOT }), "__e2e_addRoot");
      st.rootAdded = true;
      st.projects.add(L.SECOND);
      ok(await send("createProject", { path: L.SECOND }), "createProject Second.prproj");
      st.projects.add(L.E2E);
      const created = await send("createProject", { path: L.E2E });
      ok(created, "createProject E2E.prproj");
      ok(await e2e("__e2e_setFolder", { projectPath: L.E2E, folder: L.EDIT }), "__e2e_setFolder");
      const gs = await state();
      ok(gs, "getState after setup");
      assert.ok(samePath(gs.target && gs.target.folder, L.EDIT), `setup: E2E's folder should be ${L.EDIT}, got ${fmt(gs.target)}`);
      st.setupComplete = true;
    } catch (e) {
      out(`FAIL  SETUP  creating the throwaway projects  -- ${e.message}`);
      results.push({ id: "SETUP", title: "setup", kind: "hard", outcome: "FAIL", detail: e.message, notes: [] });
    }

    // 4. Cases.
    const only = opts.only && opts.only.length ? new Set(opts.only) : null;
    for (const c of CASES) {
      if (!st.setupComplete || st.aborted) break;
      if (only && !only.has(c.id)) continue;
      const needs = c.needs || [];
      let skip = null;
      if (needs.includes("media") && !st.media.available) skip = `no media: ${st.media.reason}`;
      else if (needs.includes("interactive") && !opts.interactive) skip = "pass --interactive to run";
      else if (needs.includes("sidecar") && !st.sidecarAvailable) skip = "the CEP sidecar is not installed (getState.sidecarAvailable is false)";
      else if (needs.includes("noSidecar") && st.sidecarAvailable) skip = "the sidecar is installed; the sidecar cases cover this";
      else if (needs.includes("exportPreset") && !opts.exportPreset) skip = "set PR_E2E_EXPORT_PRESET to an .epr file to run";
      if (skip) {
        record(c, "SKIP", skip);
        continue;
      }
      const notes = [];
      const gen = ++st.caseGen;
      try {
        if (!c.noEnsure) await ensureE2E();
        await withTimeout(c.run(makeH(gen, notes)), timing.caseTimeoutMs, c.id);
        const softFails = notes.filter((n) => !/^(skipped|info):/.test(n));
        record(c, softFails.length ? "SOFT" : "PASS", softFails.length ? "hard checks passed" : "", notes);
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).split("\n").slice(0, 4).join(" | ");
        if (c.kind === "soft") record(c, "SOFT", msg, notes);
        else record(c, "FAIL", msg, notes);
      } finally {
        st.caseGen++;
        await client.waitForIdle(timing.commandTimeoutMs);
      }
    }
  } finally {
    teardownProblems = await teardown();
    if (opts.handleSigint) process.removeListener("SIGINT", onSigint);
    if (rl) rl.close();
  }

  // 5. Your projects: still open, never targeted.
  if (st.setupStarted && !teardownProblems.length) {
    try {
      const gs = await client.send("getState", {}, { timeoutMs: timing.probeTimeoutMs });
      const open = (gs.openProjects || []).map((p) => p.path);
      const gone = st.userProjects.filter((p) => !open.some((q) => samePath(p, q)));
      const ours = open.filter((p) => isInside(p, L.ROOT));
      const targeted = sent.filter((s) => typeof s.cmd.expectedProject === "string" && st.userProjects.some((u) => samePath(u, s.cmd.expectedProject)));
      const c = { id: "END", title: `your ${st.userProjects.length} project(s) are still open and were never targeted; no throwaway project is left open` };
      if (gone.length || ours.length || targeted.length) record(c, "FAIL", fmt({ gone, leftOpen: ours, targeted: targeted.length }));
      else record(c, "PASS");
    } catch (e) {
      record({ id: "END", title: "final getState" }, "FAIL", e.message);
    }
  }

  const count = (o) => results.filter((r) => r.outcome === o).length;
  const failed = count("FAIL");
  out(`\n[pr-e2e] ${count("PASS")} passed, ${count("SOFT")} soft, ${count("SKIP")} skipped, ${failed} failed` +
    `${teardownProblems.length ? ", teardown incomplete" : ""} (${Math.round((Date.now() - started) / 1000)} s).`);
  return { exitCode: failed || teardownProblems.length ? 1 : 0, results, sent, root: L.ROOT, layout: L, bridgeDir: client.bridgeDir, teardownProblems };

  function refuse(reason) {
    out(`[pr-e2e] Refusing to run: ${reason}`);
    return { exitCode: 2, refusedReason: reason, results, sent, root: L.ROOT, layout: L, bridgeDir: client.bridgeDir, teardownProblems: [] };
  }
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------
export const REFUSAL_TEXT = [
  "Refusing to run: pass --i-saved-my-project.",
  "",
  "This suite drives the Premiere Pro you have open. It opens throwaway projects under",
  "%TEMP%\\pr-mcp-e2e-<stamp>\\ alongside yours and never targets your projects, but Premiere's",
  "scripting API has no 'unsaved changes' flag, so the harness can't check your work is saved.",
  "Save your projects, tick \"Allow test harness\" in the MCP Bridge panel, then run:",
  "",
  "  npm run test:e2e:premiere -- --i-saved-my-project [--interactive] [--only P01,P05]",
  "",
  "--interactive also runs the Pause test and the Undo test, which ask you to act in Premiere.",
].join("\n");

async function main(argv) {
  const args = argv.slice(2);
  if (!args.includes("--i-saved-my-project")) {
    console.error(REFUSAL_TEXT);
    return 2;
  }
  const onlyArg = args.find((a) => a.startsWith("--only"));
  let only = null;
  if (onlyArg) {
    const v = onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1];
    only = String(v || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  console.log([
    "[pr-e2e] WARNING: Premiere's UXP API exposes no 'unsaved changes' flag, so this harness can't refuse",
    "         on unsaved work. It never targets your projects (every command names a throwaway project",
    "         under %TEMP%\\pr-mcp-e2e-*), but it opens and closes projects alongside yours. You passed",
    "         --i-saved-my-project: make sure that's true.",
  ].join("\n"));
  const r = await runSuite({
    interactive: args.includes("--interactive"),
    only,
    handleSigint: true,
    exportPreset: process.env.PR_E2E_EXPORT_PRESET || undefined,
  });
  return r.exitCode;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e); process.exitCode = 1; },
  );
}

