# Premiere Pro bridge — spec

Status: **draft, awaiting approval.** Nothing in this spec is implemented yet.

Goal: let Claude drive Adobe Premiere Pro 2026 (26.5.x, Windows 11) the way it drives After Effects, from the **same Claude Code session, with both apps open at once**. The motivating loop is: render shots from AE, then have Claude build and refine the Premiere edit. That means creating or opening a `.prproj`, importing renders into bins, assembling and trimming a sequence, placing markers, doing audio, transitions, speed and timing passes, and saving. AE's "Export As Premiere Pro Project" isn't scriptable, and FCP XML import isn't available here.

Scope target: Claude can do **anything a human can do in Premiere that is reachable from a script**, inside the safety boundaries below. §11 lists what isn't reachable.

The Premiere side follows `docs/bridge-protocol.md` wherever possible. This document only describes where it differs or adds to that contract.

---

## 1. Decisions

| # | Topic | Decision |
|---|---|---|
| Q1 | Structure | **Two MCP servers in this repo**, `build/ae.js` and `build/premiere.js`, sharing one bridge module. Both are registered in Claude Code, so one session sees `after-effects` and `premiere` tools at the same time. |
| Q2 | Transport | **Same bridge folder, separate prefixed files**: `pr_command.json` / `pr_mcp_result.json` next to `ae_command.json`. The folder is `%AE_MCP_BRIDGE_DIR%`, defaulting to `%USERPROFILE%\ae-mcp-bridge`, which is never in OneDrive. Transport is file polling, not WebSocket. |
| Q3 / Q10 | Project targeting | `expectedProject` is the **target**, not a check against the active project. The panel resolves it among open projects and never falls back to the active one. If it isn't open: `PROJECT_NOT_OPEN`. |
| Q4 | Sandbox | Imports can **read from anywhere**. **Writes go only inside the sandbox folder.** New projects may only be created inside a **remembered default root**. Premiere roots are stored separately from AE's. |
| Q5 / Q17a | Time | Each time field accepts `frames` (int) **or** `timecode` (string). Floats are rejected. Values follow the sequence's timebase, including 23.976 and drop-frame. Results report both. |
| Q6 / Q17b | Typed tools | v1 set in §7, including `premiere-replace-media`. |
| Q7 / Q13 | e2e | Throwaway projects are opened *alongside* yours, under `%TEMP%\pr-mcp-e2e-*`. Setup goes through `__e2e_*` commands, which are accepted only while the panel's **"Allow test harness"** checkbox is ticked. |
| Q8 | Public fork | Published, scrubbed, gated by `npm run scrub-check` against an untracked denylist. |
| Q9 | Plugin tech | **UXP panel** (`premierepro` module), packaged and installed as a `.ccx` so it survives restarts. |
| Q11 | Script safety | `run-script-code` runs with guarded `require`/`fs`/`ppro` plus a static scan. This is **best-effort**. The real rollback is the save plus backup taken before each run. |
| Q12 | Undo | Each typed tool's edit is one transaction; setup steps (creating missing bins, moving a new sequence into its bin, marker colours, audio-less placement) and non-Action operations (import, sequence creation) add undo steps; relink (`changeMediaFilePath`) is not undoable per Adobe's docs, so only the pre-run backup reverses it; `undoSteps` always reports the true count. A script may make several. |
| Q14 | App-managed writes | Previews, auto-save, media cache and peak files written by Premiere itself are exempt. *Changing* those locations to anywhere outside the sandbox is blocked. |
| Q15 | Exports | The output path must be inside the sandbox. It is checked when the job is queued, including Media Encoder jobs. `premiere-export` is in v1. |
| Q16 | Code help | `premiere-get-api-help` serves `docs/premiere-uxp-cheatsheet.md`. |
| Q18 | Coverage | **Capability spike first.** Anything UXP can do goes into the UXP panel. Anything it can't, most likely set-speed and unlink, goes to a **small CEP/ExtendScript sidecar scoped to just those operations ("B-lite")**. UI automation stays out of the bridge. |

---

## 2. Research summary (Oct 2026)

- **UXP is GA in Premiere since 25.6.** 26.3 added `createSequenceWithPresetPath` and made `lockedAccess` around transactions required. 26.5 added `WorkAreaUtils` and `MediaManager`. Source: <https://developer.adobe.com/premiere-pro/uxp/changelog>. API reference: <https://developer.adobe.com/premiere-pro/uxp/ppro_reference> and <https://github.com/AdobeDocs/uxp-premiere-pro>.
- **Edits are Actions.** Every edit is a `create*Action` added to a `CompoundAction` inside `project.lockedAccess(() => project.executeTransaction(cb, undoString))`. One transaction is one undo step. Most calls are async.
- **CEP is being retired.** Adobe will stop new Marketplace submissions in Dec 2027, disable CEP by default in Dec 2028, and remove it in Dec 2029. The same post says ExtendScript is "not affected". Source: <https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications>. An older forum statement gives "ExtendScript through Sept 2026", which conflicts with this: <https://community.adobe.com/questions-729/extendscript-to-uxp-for-premiere-pro-1553924>. Treat CEP/QE as able to disappear in any release.
- **UXP can't call ExtendScript.** Source: <https://community.adobe.com/questions-734/uxp-error-in-premiere-pro-beta-25-2-evalscript-fails-311854>.
- **Manifest permissions.** `localFileSystem: "fullAccess"` allows `require('fs')` on absolute paths. `allowCodeGenerationFromStrings: true` is needed for `new Function`. `network.domains` would be needed for fetch/WebSocket, but is not used here. Source: <https://developer.adobe.com/premiere-pro/uxp/plugins/concepts/manifest>.
- **No API for menu or shortcut commands**, in either UXP or ExtendScript. Adobe staff, <https://community.adobe.com/t5/premiere-pro-discussions/q-execute-menu-command-from-script-cep-extendscript/m-p/9853031>.
- **The `AgenticSkills/` tools are not available to us.** They are served by Premiere's private in-app MCP (inside `omni.dll`, plus the gated `com.adobe.dva.creative-copilot` plugin) and are undocumented with no external endpoint. We don't use them.

---

## 3. Architecture

```
Claude Code session
 ├─ MCP server "after-effects"  (build/ae.js)        ─┐
 └─ MCP server "premiere"       (build/premiere.js)  ─┤ src/bridge/*  (shared)
                                                      │
 %USERPROFILE%\ae-mcp-bridge\
   ae_command.json  ae_mcp_result.json   ◄─► AE ScriptUI panel (mcp-bridge-auto.jsx)
   pr_command.json  pr_mcp_result.json   ◄─► Premiere UXP panel (src/premiere-uxp/)
   prx_command.json prx_mcp_result.json  ◄─► Premiere CEP sidecar (B-lite, src/premiere-cep/)
```

### 3.1 Refactor (step 1, behaviour-neutral for AE)

Move the bridge plumbing out of `src/index.ts` into `src/bridge/`, parameterised by an app config `{ prefix: "ae" | "pr" | "prx", appLabel }`. The plumbing that moves:

- `writeCommandFile`, `toAsciiJson`, `withBridgeLock`, `sendBridgeCommand`, `queueBridgeCommand`
- `clearResultsFile`, `waitForBridgeResult`, `resultMatchesCommand`
- `confirmedProject`, `pendingScriptId`, `formatScriptToolResult`
- the `get-results` implementation

After the move:

- `src/ae.ts` holds today's AE tools unchanged. `src/index.ts` stays as a thin re-export so existing configs keep working.
- `src/premiere.ts` holds the Premiere tools.
- The AE e2e suite must pass unchanged before any Premiere work lands.

### 3.2 Independence

Each server has its own mutex, `confirmedProject` and `pendingScriptId`. A long AE run never blocks Premiere commands, and the reverse also holds. Within the Premiere server, the UXP panel and the sidecar have **separate** lock and file pairs, but share one `confirmedProject`.

### 3.3 Registration

The README documents adding both servers, for example `claude mcp add premiere -- node <repo>/build/premiere.js`. Claude orchestrates cross-app flows, such as AE render → Premiere import, itself. There is no combined tool.

---

## 4. Protocol (differences from `bridge-protocol.md`)

Everything not listed here is the same as AE, including:

- the command shape (`id`, `command`, `args`, `timestamp`, `status`, `expectedProject`)
- the `pending → running → completed | error` lifecycle and the rule against clobbering status
- 500 ms polling and the 120 s `STALE` check
- the gate order (`PAUSED`, then `PROJECT_NOT_CONFIRMED`, then the target check)
- the refusal shape
- the `_commandId`, `_commandExecuted`, `_responseTimestamp`, `_project` and `_projectChanged` stamps
- atomic tmp-then-rename writes on both sides
- the server writing pure ASCII
- the `running` interim result for script runs

| Area | Premiere behaviour |
|---|---|
| Files | `pr_command.json`, `pr_mcp_result.json` (`.tmp` for atomic writes). Sidecar: `prx_*`. |
| Exempt commands | `getState` (the equivalent of `getSandboxFolder` + `getProjectInfo`) and `getApiHelp`, which is served by the server and never reaches the panel. |
| Target check | Replaces AE's `PROJECT_MISMATCH`. `normalize(expectedProject)` is looked up among **open projects**, not compared to the active one. No match: `PROJECT_NOT_OPEN`, and the result includes `openProjects: [paths]`. `""` (untitled) is **not allowed** as a target: Premiere can't have a script target an unsaved project reliably. Code: `PROJECT_UNSAVED`. |
| Open-project discovery | The primary source is `ProjectUtils.getProjectViewIds()` → `getProjectFromViewId()` (an inferred workaround that the spike must confirm). Fallback: a guid→path map of every project the panel has seen (active, opened, created), refreshed on each poll. |
| `_project` | The target project's path, not the active project's. |
| Result extras | `undoSteps` (the true number of undo steps the command added) on every mutating command. |
| `getState` result | `{ status, openProjects: [{ path, name, guid, isActive }], activeProject, target: { path, folder, folderExists, isDefault }, paused, scriptsEnabled, testHarnessEnabled, scratchDisks: { videoPreview, audioPreview, autoSave, mediaCache }, app: { version }, sidecarAvailable }` (`sidecarAvailable`: `prx_heartbeat.json` fresher than 6 s). No `dirty` flag: the UXP `Project` API (26.5 docs) exposes no unsaved-changes state. |

### Refusal and error codes (new)

| Code | Meaning |
|---|---|
| `PROJECT_NOT_OPEN` | The target isn't among the open projects. |
| `PROJECT_UNSAVED` | The target is `""`. |
| `NOT_IN_DEFAULT_ROOT` | `createProject` path isn't inside a remembered default root. |
| `OUTSIDE_FOLDER` | A write, export, save-as or scratch-disk change points outside the sandbox. |
| `ITEM_NOT_FOUND` / `SEQUENCE_NOT_FOUND` / `BIN_NOT_FOUND` | Typed-tool lookups failed. |
| `AMBIGUOUS_ITEM` | A name or path matches more than one project item. The result lists the candidates. |
| `BAD_TIME` | A float, a timecode with the wrong format, or a time out of range. |
| `NEEDS_SIDECAR_UNAVAILABLE` | A sidecar-only operation was called, and the sidecar isn't running or CEP is unavailable. |
| `UNSUPPORTED` | The operation is known not to be scriptable (see §11). |
| `VERIFY_FAILED` | A placement or edit was committed, but reading it back doesn't match what was asked. The result has `mismatches`, and `undoSteps` / `backupPath` for rolling back. |
| `IMPORT_FAILED` | Premiere reported an import failed, or reported success but nothing new appeared in the bin. |
| `SIDECAR_STATE_STALE` | Sidecar only: the UXP panel's state mirror is missing, unreadable or older than 10 s, so Pause and the folder can't be checked. |
| `TARGET_NOT_ACTIVE` | Sidecar only: the target is open but not the active project. QE and the timeline selection only follow the active project. |
| `SPEED_NOT_APPLIED` / `TRANSITION_NOT_APPLIED` | Sidecar only: the QE call returned, but the DOM read-back shows no change. |
| `HOST_ERROR` / `QE_UNAVAILABLE` | Sidecar only: ExtendScript failed ("EvalScript error.") or QE has no active sequence, track or matching clip. |

AE codes keep their meaning: `PAUSED`, `PROJECT_NOT_CONFIRMED`, `NO_FOLDER`, `FOLDER_MISSING`, `BLOCKED_CALL`, `SAVE_FAILED`, `FILE_EXISTS`, `FILE_NOT_FOUND`, `STALE`, `SCRIPT_ERROR`, `SYNTAX_ERROR`.

---

## 5. The UXP panel (`src/premiere-uxp/`)

- **Manifest:**
  - `host: premierepro`, `minVersion 25.6`, tested on 26.5.2
  - one panel, "MCP Bridge"
  - `requiredPermissions`: `localFileSystem: "fullAccess"`, `allowCodeGenerationFromStrings: true`
  - no network
- **Install:** `npm run install-premiere-panel` packages a `.ccx` and installs it through Creative Cloud / UPIA (`UnifiedPluginInstallerAgent.exe --install`). The script prints the manual double-click route if UPIA isn't found. During development, the UXP Developer Tool can load the plugin instead; that needs Developer Mode and a reload after each restart.
- **Polling:** `setInterval` every 500 ms reads `pr_command.json` with `fs`. One command runs at a time, guarded by a re-entrancy flag, because handlers are async. *Spike: confirm the timers keep running while the panel is hidden or docked behind another tab. If they don't, the README tells you to keep it open.*
- **UI**, mirroring the AE panel:
  - target or active project, and its folder (with "(default)")
  - **Browse… / Clear / Forget default**
  - **Pause**
  - **Allow test harness**: unticked at every launch, and never persisted
  - a log view
- **Storage:** per-project folders and default roots go in the plugin's `localStorage`, under keys `MCPBridgeSandbox:<normalized path>` and `MCPBridgeSandboxRoots`. Only the panel's buttons change them, and the script scan blocks `localStorage`.
- **Path policy:** `normalize`, `isInside` and `scanCode` live in one pure module (`src/premiere-uxp/pathPolicy.js`) that the unit tests import, in the same spirit as the AE `PATH POLICY` block. The rules are the same: case-insensitive, `\` and `/` treated alike, `..` resolved.
- **Folder follows Save As:** same as AE. A save-as inside the folder carries the folder setting over to the new path.
- **Modern JS** is allowed here. The ES3 rules apply only to the AE panel and the sidecar.

---

## 6. Sandbox and safety

| Mechanism | AE | Premiere |
|---|---|---|
| Folder picker plus remembered defaults | ✔ | ✔ Same UX, separate storage. |
| Writes outside the folder blocked | `File`/`Folder` prototype guards | `run-script` gets **wrapped** `fs` and `require` (`require('fs')`, `require('uxp').storage` → guarded proxies; write/rename/unlink/mkdir/copy are path-checked) and a **wrapped `ppro`**. Every API taking an output path is checked: `Project.saveAs`, `createProject`, `EncoderManager.exportSequence/encodeFile/encodeProjectItem`, `Exporter.exportSequenceFrame`, `ProjectConverter.export*`, `Transcript.exportToJSON`, scratch-disk setters in `ProjectSettings`, whether reached as a static or through an instance. The proxies wrap a blank shadow target, because the `premierepro` module's classes and statics are locked properties that a Proxy over the real object must return raw (the e2e breach, Oct 2026). Typed tools check paths themselves. |
| Static scan (`BLOCKED_CALL`) | ✔ | Blocks `globalThis`, `window`, `eval(`, `Function(`, `import(`, `localFileSystem`, `localStorage`, `sessionStorage`, `__mcp`, the panel module names, `shell` / `openExternal` / `openPath`, and `require(` with a non-literal argument. It also applies to files read by `run-script-file`. |
| Project save plus rolling backup before a run | ✔ | `project.save()`, then copy the `.prproj` to `<folder>/mcp-scripts/backups/<stamp>_<name>.prproj`, keeping the newest 10. `SAVE_FAILED` stops the run. A backup failure gives `backupWarning`. Applies to `run-script-*` **and to every mutating typed tool**. |
| Undo grouping | One group per run | Each typed tool's edit is one transaction; setup steps (creating missing bins, moving a new sequence into its bin, marker colours, audio-less placement) and non-Action operations (import, sequence creation) add undo steps; relink (`changeMediaFilePath`) is not undoable per Adobe's docs, so only the pre-run backup reverses it; `undoSteps` always reports the true count. Scripts get `sandbox.transaction(name, fn)`. The backup is the reliable rollback. |
| Archive and run log | ✔ | `<folder>/mcp-scripts/<stamp>_<name>.js` and `run-log.txt`, same format as AE. |
| Expected-project guard | Compared against the open project | Target by path (§4). |
| Stale, pause, one-in-flight, `pendingScriptId` | ✔ | ✔ Identical. |
| Premiere's own writes (previews, auto-save, cache, peaks) | n/a | Exempt. *Changing* their locations to anywhere outside the sandbox is blocked. `getState` reports the current locations. |
| Modal dialogs | n/a | Typed tools pass every suppress option UXP offers: `importFiles(…, suppressUI=true)`, `OpenProjectOptions.setShowConvertProjectDialog/LocateFile/Warning(false)`, `CloseProjectOptions.setPromptIfDirty(false)` for e2e closes only. If a run passes `waitSeconds` it reports `running` with the hint "a Premiere dialog may be waiting". After 60 s the panel watchdog writes a `possible-modal` line to the run log. |

**Script context.** The code runs as an `async` body:

```js
new Function("ppro", "project", "sandbox", "fs", "require", "time", code)
```

- `project` is the resolved target.
- `time` is the time helpers from §7.1.
- `return` hands back a value, which is made JSON-safe with depth 8 and host objects converted to `String`.

**`sandbox` helper:** `folder`, `path(rel)`, `saveAs(path, overwrite?)`, `transaction(name, async (compound, project) => …)`, `export(...)` (path-checked wrapper), `log(msg)`.

**Honest limit, written in the README:** the guards are best-effort, the same as in AE. Determined code inside a `fullAccess` plugin can get around them. The protection that matters is the targeting, the backup, and code that Claude writes for you to see.

---

## 7. MCP tools (`premiere` server)

All mutating tools follow the same flow: pass the gate, run the pre-run save and backup, run the edit in **one transaction**, then return `{ status, …, undoSteps, backupPath }`. Every tool takes an optional `project` (path) argument. It defaults to `confirmedProject`, and if that isn't set the tool asks Claude to call `premiere-get-state` first.

### 7.1 Shared conventions

- **Time:** `{ frames: int }` or `{ timecode: "HH:MM:SS:FF" }`, with `;FF` for drop-frame. Values are converted to Premiere ticks (254016000000 per second) using the **sequence's** timebase. For project-item in/out points, the clip's own frame rate is used. Results return `{ frames, timecode, seconds }`.
- **Item reference:** `"Renders/v003/SH048_v003"` is a project path, `/`-separated from the root. An `{ id }` (from earlier results, valid only within the session) or `{ file }` (an absolute media path, matched via `getMediaFilePath`) are also accepted. If a reference matches more than one item, the tool returns `AMBIGUOUS_ITEM`.
- **Track reference:** `"V1"`, `"A2"`, 1-based, matching the Premiere UI.

### 7.2 v1 tools

| Tool | Parameters | Notes |
|---|---|---|
| `premiere-get-state` | `{ project? }` | Exempt. With `project`, confirms that project if it is open. Without it, sets `confirmedProject` only when exactly one project is active and saved; if not, Claude must pass `project`. A confirmed project that is no longer open is cleared. |
| `premiere-get-api-help` | `{ topic?: "transactions" \| "time" \| "bins" \| "import" \| "editing" \| "effects" \| "audio" \| "markers" \| "export" \| "gaps" }` | Served by the server from the cheat sheet. No bridge round-trip. |
| `premiere-create-project` | `{ path }` | Must be inside a default root, so the folder is inherited. Opens the project and becomes the target. |
| `premiere-open-project` | `{ path }` | Opens with dialogs suppressed. If the project is already open, it's just targeted. |
| `premiere-save-project` | `{ path?, overwrite = false }` | Save in place, or save-as inside the folder (the folder follows). |
| `premiere-get-project-items` | `{ bin?: path, recursive = true, type?: "clip" \| "sequence" \| "bin" }` | Read-only. Returns paths, ids, media paths, durations, in/out points. |
| `premiere-import` | `{ files: string[], bin?: "Renders/v003", skipExisting = true }` | Creates nested bins as needed. `skipExisting` matches by media path. |
| `premiere-import-ae-comps` | `{ aepPath, comps?: string[], bin?: "AE/Titles", skipExisting = true }` | Links After Effects comps by Dynamic Link: `Project.importAEComps(aepPath, comps, bin)`, or `importAllAEComps(aepPath, bin)` when `comps` is left out. The `.aep` can be anywhere, since nothing is written. Bins are created as needed. `skipExisting` skips comps already in the bin by name. New items are found by diffing the bin; returns `IMPORT_FAILED` if Premiere returns false or nothing new appears. Panel command `importAEComps`. |
| `premiere-replace-media` | `{ item, newFile, keepTrims = true, rename?: string }` | Uses `ClipProjectItem.changeMediaFilePath`. All timeline uses update, and the in/out points are kept. |
| `premiere-create-sequence` | `{ name, bin?, preset?: path.sqpreset, fromClips?: item[] }` | `fromClips` uses `createSequenceFromMedia`, so the settings match the first clip. |
| `premiere-get-sequence` | `{ sequence, tracks?: string[] }` | Read-only. Returns settings, tracks, and items with start/end/in/out/speed/enabled/effects/transitions. Paginated. UXP 26.5.2 returns no transition objects, so `transitions` stays empty and `transitionsNote` says so. |
| `premiere-build-sequence` | `{ sequence, mode: "append" \| "replace", track = "V1", clips: [{ item, in?, out?, gapBefore? }] }` | Places clips end to end, in order. `replace` clears the target track (and the clips' linked audio) first. Linked audio comes along by default (`withAudio = true`). Clips land full length, so they are trimmed on the timeline and moved into place: 2 undo steps, or 3 when a clip's target is earlier than its head trim (see `premiere-spike-results.md`). A read-back mismatch is `VERIFY_FAILED`. |
| `premiere-edit-items` | `{ sequence, edits: [{ track, index \| at, op: "move" \| "trim" \| "slip" \| "remove" \| "enable" \| "disable", …}], ripple = false }` | Re-timing: move with `to` (the new start) or `delta`, because `at` locates the clip; trim `start`/`end`/`in`/`out`; ripple or lift remove (`ripple` applies to removes only: UXP's move action can't ripple, so `ripple` with a move is `BAD_ARGS`); `mediaType: "video" \| "audio" \| "both"` (`both` edits and removes the linked partner explicitly). Trims are edge trims: `start`/`in` move the head, `end`/`out` the tail. Give one of each pair, and one move/trim/slip per clip per call. A slip keeps start and end. Results include `after` (start/end/in/out read back). |
| `premiere-place-audio` | `{ sequence, item, track = "A1", at, in?, out?, mode: "overwrite" \| "insert" }` | Music, SFX, VO. Overwrite is placed, trimmed and moved like a build. `insert` takes no `in`/`out` (it lands full length and UXP has no ripple trim). |
| `premiere-set-audio` | `{ sequence, track, index, levelDb?, fades?: { inFrames?, outFrames? }, keyframes?: [{ at, db }] }` | Volume through the intrinsic component's parameters and keyframes. |
| `premiere-add-transition` | `{ sequence, track, index, edge: "start" \| "end" \| "both", type?, durationFrames }` | Video tracks through UXP (default "Cross Dissolve"). Audio tracks through the sidecar (`addAudioTransition`, default "Constant Power"), because UXP's `TransitionFactory` is video-only (spike, 26.5.2). |
| `premiere-set-speed` | `{ sequence, track, index, percent, reverse = false, ripple = true, maintainPitch = true }` | Sidecar (`setSpeed`): UXP has no speed or time-remap setter (spike, 26.5.2). |
| `premiere-link-clips` | `{ sequence, items: [{ track, index }], link: boolean }` | Sidecar (`link` / `unlink`): UXP can't link or unlink (spike, 26.5.2). |
| `premiere-add-markers` | `{ target: { sequence } \| { item }, markers: [{ at, duration?, name, comment?, color?, type? }] }` | Bulk. |
| `premiere-export` | `{ sequence, preset: path.epr, output: path, mode: "direct" \| "queue-ame", range?: "full" \| "workarea" }` | Output must be inside the folder (checked before queueing). Frame export: `{ frame: time, format }`. |
| `premiere-run-script-code` | `{ code, name?, waitSeconds = 30 (max 600) }` | Same contract as AE. The description says to read `premiere-get-api-help` first. |
| `premiere-run-script-file` | `{ file, waitSeconds }` | Inside the folder only. |
| `premiere-get-results` | `{}` | Same as AE's `get-results`, for the `pr`/`prx` files. |

Tools the spike showed UXP can't do (`set-speed`, audio `add-transition`, `link-clips`) route transparently to the sidecar. If the sidecar isn't available, they return `NEEDS_SIDECAR_UNAVAILABLE`. To edit only the audio of a linked clip, unlink it with `premiere-link-clips` first.

---

## 8. The B-lite CEP sidecar

The spike (Premiere 26.5.2) showed that UXP can't set clip speed or time remapping, add audio transitions (`TransitionFactory` is video-only) or link/unlink clips. Those three are the sidecar's whole scope. Adding, locking or targeting tracks was left out: it wasn't needed, and every operation added widens a surface that rests on the unsupported QE DOM.

- **Package:** `src/premiere-cep/`, a CEP extension (`com.mcp.premiere.sidecar`) with one small panel, **Window → Extensions (Legacy) → MCP Sidecar**, that the user can leave docked or close.
  - `CSXS/manifest.xml`: `ExtensionManifest Version="7.0"`, `RequiredRuntime CSXS 11.0`, host `PPRO [26.0,99.9]`, `--enable-nodejs` and `--mixed-context`, `StartOn` `ApplicationActivate`.
  - Premiere 26.5.2 ships CEP 12 (CEPHtmlEngine 12.0.1).
  - On load the host calls `app.setExtensionPersistent(id, 1)` so the extension keeps running while its panel is closed.
- **Decision: the panel JS polls, not the ExtendScript host.** The spec first had the host poll with `app.scheduleTask`. Instead the CEP panel (Chromium + Node) does all the protocol work in `js/core.js`: polling, stale check, gate, stamps, atomic writes, backups and heartbeat.
  - It calls `host/host.jsx` only for what needs Premiere's DOM, through `CSInterface.evalScript`. It calls `window.__adobe_cep__.evalScript` directly, which is all CSInterface does.
  - The arguments are passed as a JSON object literal, escaped to ASCII, so the host needs no `JSON.parse`.
  - This keeps the ES3 part thin and lets Node unit tests cover the protocol.
- **Files:**
  - `prx_command.json` / `prx_mcp_result.json` (`.tmp` + rename). The server side has its own lock and shares `confirmedProject` with the panel.
  - Heartbeat `prx_heartbeat.json` `{ pid, ts, version }`, written every 2 s.
  - The server routes to `prx` only when the heartbeat is fresher than 6 s. The server checks the file directly rather than through `getState`. The UXP panel's `getState.sidecarAvailable` uses the same check.
- **Pause and folders:** the UXP panel writes a read-only mirror, `pr_sidecar_state.json` `{ version, writer, ts, paused, projects: [{ path, folder }] }`.
  - It writes it atomically on every poll and whenever its state changes, and lists only open, saved projects.
  - The sidecar never writes settings.
  - The sidecar refuses everything with `SIDECAR_STATE_STALE` when the mirror is missing, unreadable or older than 10 s. Without a fresh mirror it can't honour Pause.
- **Gate:**
  1. `STALE`
  2. the mirror check
  3. `PAUSED`
  4. `PROJECT_NOT_CONFIRMED` / `PROJECT_UNSAVED`
  5. the target, resolved by path via `app.projects` with `\\?\` stripped (`PROJECT_NOT_OPEN`)

  After the gate: argument checks (`BAD_ARGS`, before any save), the folder (`NO_FOLDER` / `FOLDER_MISSING`), `project.save()` (`SAVE_FAILED`), and a rolling backup into `<folder>/mcp-scripts/backups` (keep 10).
- **Active project only:** QE (`qe.project`) and the timeline selection follow the active project, so a target that is open but not in front is refused with `TARGET_NOT_ACTIVE`. The host makes the sequence active for the QE call (`Project.activeSequence = seq`), then restores the previously active sequence.
- **ES3 reuse:** `host.jsx` carries:
  - the path policy, plus `\\?\` stripping
  - a strict JSON stringify (Premiere 26's ExtendScript has no native JSON)
  - pure helpers between `BEGIN`/`END` markers

  The Node tests evaluate those blocks and run the whole file against a fake DOM.
- **Operations and the calls they make.** QE is undocumented; the argument lists come from live reports, cited in `host.jsx`.

  | Operation | Calls | Read-back |
  |---|---|---|
  | `setSpeed` | QE `trackItem.setSpeed(ratio, duration, reverse, maintainPitch, ripple)`: 5 arguments, ratio = percent/100. The duration argument is tried as `""`, then the new duration in ticks, then as `HH:MM:SS:FF`, until the read-back passes (live, 26.5.2: `""` changed the speed but not the duration). | DOM `getSpeed()`, `isSpeedReversed()`, start/end, and the next clip's start (`rippled`). Success needs the speed **and** the duration (source ÷ ratio, ±1 frame; without ripple, a clip stopped by the next clip is a warning). Otherwise the old speed is put back and the result is `SPEED_NOT_APPLIED` with every attempt. |
  | `addAudioTransition` | `qe.project.getAudioTransitionByName(type)` (default "Constant Power"), then QE `trackItem.addTransition(t, applyToStart, "HH:MM:SS:FF", "0", 0.5, false, true)` per edge. | New spans in DOM `track.transitions`. None gives `TRANSITION_NOT_APPLIED`. |
  | `link` / `unlink` | Select exactly the items (`TrackItem.setSelected(true, true)`), call `Sequence.linkSelection()` / `unlinkSelection()`, then restore the user's selection. | `getLinkedItems().numItems` per item. |

  QE clips are matched to DOM clips by start ticks and `type === "Clip"`, because QE track items include gaps. Only `type` and `start` are read from QE items: some QE properties abort the whole script when read.
- **Install:** `npm run install-premiere-sidecar` prints the plan; the default is a dry run.
  - `-- --install` copies the extension to `%APPDATA%\Adobe\CEP\extensions\com.mcp.premiere.sidecar`.
  - `--enable-debug` adds `HKCU\Software\Adobe\CSXS.12` `PlayerDebugMode = "1"` (REG_SZ), which unsigned extensions need.
  - The README states the Dec 2028 CEP sunset.
- **Needs live verification:**
  - the `setSpeed` second argument and its ripple behaviour
  - the meaning of `addTransition`'s seventh argument
  - whether `linkSelection` works through `setSelected` without UI focus
  - `StartOn` autostart in Premiere
  - timers while the panel is closed

## 9. Implementation order

1. **Refactor** (§3.1). AE unit and e2e suites stay green.
2. **Capability spike**, in a throwaway project under `%TEMP%`, through a dev-loaded UXP plugin. Each result goes into `docs/premiere-uxp-cheatsheet.md` and a short `docs/premiere-spike-results.md`. The questions:
   - a. Does `ProjectUtils.getProjectViewIds()` list all open projects? Does `Project.open` on an already-open path return the open instance?
   - b. Can time-remap/speed be set via `ComponentParam`?
   - c. Can audio-only be removed from a linked clip, and does ripple delete work?
   - d. Can audio transitions be added from UXP?
   - e. Do `setInterval` timers run while the panel is hidden?
   - f. Is `fs` rename-over-existing atomic enough, or is remove-then-rename needed (as in AE)?
   - g. Can the wrapped `require` actually shadow the plugin's `require` inside `new Function`?
   - h. Which calls pop modal dialogs?
3. **UXP panel core:** polling, gate, `getState`, folder UI, path policy plus unit tests.
4. **Script tools:** `run-script-code/file`, guards, backup, archive, log, `get-results`.
5. **Typed tools**, in §7 order.
6. **B-lite sidecar**, if step 2 calls for it.
7. **e2e suite** (§10), the cheat sheet, the README, and the protocol doc update (a Premiere section in `bridge-protocol.md` pointing here).
8. **Scrub and publish** (§12), only after you approve the push.

---

## 10. Testing

- **Unit (`npm test`):**
  - Premiere path policy and scan
  - time conversion: frames/timecode/ticks at 23.976, 24, 25, 29.97 DF, 30, 59.94
  - the shared bridge module (id matching, lock, stale), using a fake panel that reads and writes files in a temp bridge dir
- **e2e (`npm run test:e2e:premiere -- --i-saved-my-project`):**
  - Refuses to start if any open project reports unsaved changes, or if "Allow test harness" isn't ticked.
  - Creates `%TEMP%\pr-mcp-e2e-<stamp>\` containing `edit\E2E.prproj` (the sandbox), `outside\`, `second\Second.prproj` and `media\`. `media\` holds tiny generated clips: ffmpeg if it's present, otherwise checked-in 1-second fixtures.
  - **Your projects stay open and are never targeted.** Every command targets the throwaway paths.
  - The `__e2e_*` commands (set or clear folder, open, close without saving, count items, read settings) are accepted only while the checkbox is ticked and only for paths under `%TEMP%\pr-mcp-e2e-*`.
  - Teardown always runs, including on Ctrl+C: it clears the settings the harness wrote, closes the throwaway projects without saving, and deletes the temp folder.
  - **Cases mirror AE 1–22 where they apply:**
    - gate order
    - `STALE`
    - `PROJECT_NOT_OPEN` while your project is active
    - case and separator tolerance
    - write and export blocking inside and outside the folder
    - `BLOCKED_CALL` list
    - backup rotation at 10
    - archive and run log
    - `running` interim
    - error line numbers
    - `returnValue` round-trip
    - 20-command stress test
    - command written mid-run is not clobbered
    - Pause (`--interactive`)
  - **Premiere-specific cases:**
    - import into nested bins with `skipExisting`
    - build/replace sequence with trims (frame-exact via `get-sequence`)
    - markers, replace-media keeping trims
    - edit-items (move, trim, ripple remove), audio placement and levels, transitions, set-speed
    - export inside the folder succeeds; export outside the folder and scratch-disk redirect are refused
    - one Undo reverses one typed tool
    - target by path while another project is active
  - **Sidecar cases** run only when it's installed.
- **Cross-app smoke test (manual checklist in the README):** in one Claude session, render a 1-second AE comp into the shot folder, then import it into Premiere and build a sequence.

---

## 11. Known gaps (not scriptable, stated in the cheat sheet)

Claude tells you to do these by hand:

- arbitrary menu commands and keyboard shortcuts
- rendering previews
- creating multicam sequences
- true Nest (UXP has `createSubsequence`)
- panel focus and workspaces (the sidecar could do workspaces if ever needed)
- dismissing arbitrary modal dialogs
- applying `.ffx` effect presets
- complex Lumetri curves (unconfirmed)

UI automation is deliberately out of scope for the bridge.

---

## 12. Public fork and scrub rules

- **Branches:** work happens on `premiere-bridge`, branched from local `main` (never pushed). The public version is squashed onto `public`/`public-scrub` for remote `fork`, the same way as today. **Nothing is pushed without asking.**
- **Scrub rules:**
  - Real local paths become `D:\Projects\MyFilm\…` / `%USERPROFILE%\…`.
  - Real shot names become `SH010` / `SH020`.
  - The production's name and abbreviation are removed.
  - The email in commits becomes the GitHub noreply address.
  - The spec link in `bridge-protocol.md` is dropped.
- **`npm run scrub-check`:**
  - Greps the tree about to be pushed (`git archive` of the target branch) and the commit metadata against `.scrub-denylist`, which is **untracked** and listed in `.git/info/exclude`.
  - It exits non-zero on any hit.
  - If the denylist is missing it fails closed: "denylist missing: refusing". If git tracks it (`git ls-files --error-unmatch`), it also refuses.
- **What goes public:** the shared bridge module, both servers, the UXP panel, the sidecar, the cheat sheet, the tests (with placeholder paths), and this spec, scrubbed.

---

## 13. Risks

- **Spike outcomes:** UXP can't set speed, or `fs` timers stop while the panel is hidden. Mitigations are in §8 and §5.
- **CEP or QE removed in a future Premiere release.** Sidecar-routed tools degrade to `NEEDS_SIDECAR_UNAVAILABLE`.
- **UXP API churn:** 26.3 already changed transaction requirements. The cheat sheet records the tested version, and `getState` reports `app.version`.
- **Best-effort sandbox** inside a `fullAccess` plugin (§6).
