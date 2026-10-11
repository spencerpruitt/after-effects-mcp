# Bridge end-to-end tests (seam 1)

`bridge.e2e.mjs` checks the bridge command/result file protocol (`docs/bridge-protocol.md`) against the real After Effects 2026 instance. It is an on-demand suite and is not run in CI.

## Run

1. Save your work in AE.
2. Open the bridge panel (`mcp-bridge-auto.jsx`), tick **Auto-run** and make sure **Pause** is unticked. The panel must be the current build: reinstall it and reopen it after any panel change.
3. Run:

```
node test/e2e/bridge.e2e.mjs --i-saved-my-project
node test/e2e/bridge.e2e.mjs --i-saved-my-project --interactive   # also runs the Pause test
```

Run the file directly with `node`. Don't use `node --test`, because flags and stdin don't reach the file that way.

| Flag | Meaning |
|---|---|
| `--i-saved-my-project` | Required. Without it the harness prints why it refuses and exits with code 2. |
| `--interactive` | Runs the Pause test, which asks you on stdin to tick and then untick the panel's Pause checkbox. Without this flag that test is skipped. |

| Env var | Default |
|---|---|
| `AE_MCP_BRIDGE_DIR` | `%USERPROFILE%\ae-mcp-bridge`. The server, panel and harness all resolve it the same way. |
| `AE_AFTERFX_EXE` | `C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe` |

## What it does to your open project

- **Before:** it records the open project's path. It refuses to start if `app.project.dirty` is true, or if the project is Untitled and has items. If AE has no `dirty` property, it relies on the flag.
- **Closing:** it closes your project with AE's normal "save changes?" prompt as a last guard. It never saves your project and never writes to its folder.
- **Throwaway files:** everything happens under `%TEMP%\ae-mcp-e2e-<stamp>\`:
  - `shot\E2E.aep`. Its sandbox folder is `shot\`, written straight into `app.settings` (section `MCPBridgeSandbox`, key `encodeURIComponent(normalize(path))`).
  - `outside\`, which must never be written.
  - `second\Second.aep`, used for the wrong-shot test.
  - `fresh\Fresh.aep`, a never-configured project.
  - `backchannel\`, holding the setup scripts.
- **After,** even when tests fail or you press Ctrl+C:
  - it clears the sandbox settings it wrote
  - it closes the throwaway project without saving
  - it reopens your project
  - it deletes the temp folder

  If restoring fails, it prints the path to reopen by hand.

## How it talks to AE

- **Bridge files:** it writes `ae_command.json` atomically (tmp file, then rename) with `id`, `status: "pending"` and `expectedProject`, the same way the server does. It then polls `ae_mcp_result.json` for a matching `_commandId`, waiting past `status: "running"`.
- **Back channel:** `AfterFX.exe -r <script.jsx>` runs setup and teardown ExtendScript in the running AE, for example opening and closing projects, changing settings, counting items and Edit > Undo. Each script writes an output file that the harness polls for.

## Tests

1. `getSandboxFolder` reports the project, the folder and the flags.
2. Writes inside the folder succeed. Writes outside are refused: open w/a/e, remove, rename, copy target and `Folder.create`. Reads outside are allowed.
3. Render output outside the folder is refused by `sandbox.render()`.
4. `saveProject`: saving in place is allowed, both with no path and with the open project's own path. A new path outside the folder is refused. A new path inside the folder is allowed, sets `_projectChanged`, and carries the folder setting over to the new project, which then accepts commands with the new `expectedProject`. Saving onto an existing file without `overwrite` returns `FILE_EXISTS`.
5. `sandbox.saveAs` outside the folder is refused. Inside the folder (`Save As Copy.aep`) it is allowed, with the same carry-over checks, and `projectName` is decoded (no `%20`).
6. `BLOCKED_CALL` for:
   - `system.callSystem`, `app.project.save(path)` and `renderQueue.render()`
   - `$.evalFile`, `#include` and `eval(`
   - `saveSetting`, `MCPBridgeSandbox`, `SANDBOX_SECTION`, `MCPPathPolicy`, `WriteGuards` and `pauseCheckbox`

   An obfuscated `callSystem` still fails at run time.
7. Clobbering would-be panel globals (`panel = 1; pad = 2; logText = null; ...`) doesn't break the bridge: the next commands still work. The junk globals are deleted afterwards.
8. A pending command with a timestamp 10 minutes old is refused with `STALE`, doesn't run, and is marked `error`.
9. Each script run makes a backup in `mcp-scripts\backups` and reports it in `backupPath`. After 12 runs, only 10 `*_E2E.aep` backups remain.
10. A missing `expectedProject` returns `PROJECT_NOT_CONFIRMED`. `getSandboxFolder` and `getProjectInfo` are exempt.
11. A wrong `expectedProject` returns `PROJECT_MISMATCH`:
   - for another path
   - for `""` while a saved project is open
   - while `Second.aep` is open

   A path that differs only in case or separators is accepted.
12. An unset folder returns `NO_FOLDER` for both `runScript` and `runScriptFile`. Saving in place still works, but saving to a new path doesn't. A folder that doesn't exist returns `FOLDER_MISSING`.
13. The folder is unset for a new Untitled project and for a saved project that was never configured. It is restored when `E2E.aep` is reopened.
14. One Undo reverses everything a run did.
15. The archive `.jsx` and the `run-log.txt` lines appear in `shot\mcp-scripts`, for both successful and failed runs.
16. A 3-second script yields a `running` result before the final success.
17. A script error returns its message and a `line` relative to the script. This is checked for a throw and a runtime error (`SCRIPT_ERROR`) and a syntax error (`SYNTAX_ERROR`).
18. `returnValue` round-trips objects, arrays and unicode. Host objects become strings. Deep nesting doesn't cause an error.
19. `runScriptFile`:
    - Relative and absolute paths inside the folder work.
    - `..\outside\x.jsx` and absolute paths outside return `OUTSIDE_FOLDER`.
    - A file whose contents make a blocked call returns `BLOCKED_CALL`.
    - A missing file returns `FILE_NOT_FOUND`.
20. Stress test: 20 rapid sequential commands each get exactly one matching result, and the command file is marked completed. Each script runs exactly once, which is checked by counting the items it creates and the run-log lines.
21. Race: command B is written while script A (2 seconds long) is running. B still runs afterwards. This is a regression test for the old status-clobber bug.
22. Pause (`--interactive` only):
    - Commands are refused with `PAUSED`, which takes priority over the `expectedProject` check.
    - The folder is kept.
    - `getSandboxFolder` still answers.

## Premiere

`premiere.e2e.mjs` checks the Premiere Pro bridge (`docs/premiere-bridge-spec.md` section 10) against the real Premiere Pro 2026 with the MCP Bridge UXP panel. Like the AE suite, it is on demand and not run in CI. Every `npm test` also checks its logic, teardown and targeting with a dry run against a fake panel (`test/premiere-e2e-dryrun.test.mjs`).

### Run

1. Save your work in Premiere. The harness never targets your projects, but Premiere's scripting API has no "unsaved changes" flag, so it can't check this for you.
2. Open the MCP Bridge panel. Tick **Allow test harness**, which resets at every launch, and make sure **Pause** is unticked.
3. Don't run it while a Claude session is using the Premiere tools, because both write the same `pr_command.json`.
4. Run:

```
npm run test:e2e:premiere -- --i-saved-my-project
npm run test:e2e:premiere -- --i-saved-my-project --interactive     # also the Pause and Undo tests
npm run test:e2e:premiere -- --i-saved-my-project --only P01,P15     # just these cases
```

| Flag | Meaning |
|---|---|
| `--i-saved-my-project` | Required. Without it the harness explains why it refuses and exits with code 2. |
| `--interactive` | Runs the Pause test (tick, then untick Pause when asked) and the Undo test (press Ctrl+Z in Premiere when asked). Without this flag they are skipped. |
| `--only P01,P05` | Runs only the listed cases. Setup and teardown always run. |

| Env var | Default |
|---|---|
| `AE_MCP_BRIDGE_DIR` | `%USERPROFILE%\ae-mcp-bridge`. The server, panel and harness all resolve it the same way. |
| `PR_E2E_EXPORT_PRESET` | Unset. Set it to an `.epr` export preset and P06 exports a full sequence with it. |

The harness also refuses with exit code 2 in three cases:
- The panel doesn't answer `getState`.
- `getState` reports `testHarnessEnabled: false`. Tick **Allow test harness** and run again.
- Pause is ticked.

### What it does to your session

- **Your projects stay open and are never targeted.** Every command carries `expectedProject` set to a throwaway project, or is a gate probe that the panel refuses. The client refuses to write any command whose `expectedProject` or path arguments point outside the temp root. The dry run checks this for every command it sends.
- **It opens throwaway projects alongside yours.** Everything lives under `%TEMP%\pr-mcp-e2e-<stamp>\`:
  - `edit\E2E.prproj` is the target, and its sandbox folder is `edit\`. Setup remembers the temp root as a default root (`__e2e_addRoot`), creates the project with `createProject`, then sets its folder (`__e2e_setFolder`).
  - `second\Second.prproj` is a second open project. Its folder is the temp root, which it gets as the default.
  - `outside\` must never be written by Premiere. The last case checks this.
  - `media\` holds the test clips. If ffmpeg is on PATH, the harness generates two 4-second 29.97 clips with audio, a relink target, a 23.976 clip and a 6-second wav. Without ffmpeg, the media-dependent cases are skipped with a message.
- Premiere makes each newly created project active, so the active project changes while the suite runs. Your projects are still open at the end, which the final `END` line checks.
- **Teardown always runs**, including after a failure or Ctrl+C. It:
  - clears the folder settings it wrote (`__e2e_clearFolder`)
  - forgets the temp root (`__e2e_removeRoot`)
  - closes every throwaway project without saving (`__e2e_closeProject`)
  - deletes the temp folder

  If any step fails, it prints what to do by hand: close the listed projects without saving, use "Forget default" in the panel for the temp root, and delete the folder.

### Output

The harness prints one line per case (`PASS`, `FAIL`, `SKIP` or `SOFT`), then a summary. The exit code is 1 if a hard case fails or teardown is incomplete, and 0 otherwise.

- **Hard** cases fail the run.
- **Soft** cases, and soft checks inside hard cases, cover behaviour whose live semantics are uncertain. They print `SOFT` with the reason and never fail the run. When a hard case passes its hard checks but not its soft ones, it prints `SOFT  ... -- hard checks passed`.

### Cases

The list covers AE cases 1 to 22 where they apply, then the Premiere-specific ones. For a hard case, "Soft:" lists the soft checks inside it.

| Case | Kind | Needs | What it checks |
|---|---|---|---|
| P01 | hard | | `getState` reports the target, folder and flags, shows both throwaway projects open, and shows your projects still open. Soft: `app.version` and scratch disks are reported. |
| P02 | hard | media | Import into `Renders/v001` creates both bins and a re-import is skipped. `getProjectItems` lists the clips, and a missing file returns `FILE_NOT_FOUND`. Soft: undo steps, the 29.97 frame rate. |
| P03 | hard | | Script `fs` writes inside the folder work. writeFile, append, unlink, rename, copyFile and mkdir outside it return `OUTSIDE_FOLDER`, also through `require("fs")`. Reads outside the folder work. |
| P04 | hard | | Exports outside the folder are refused: the typed frame and sequence exports, `sandbox.export`, and the guarded `EncoderManager`, `Exporter` and `ProjectConverter`. |
| P05 | hard | media | A frame export inside the folder writes the file. |
| P06 | soft | media, preset | A full sequence export with `PR_E2E_EXPORT_PRESET`. |
| P07 | hard | | `saveProject`: saving in place works. A path outside the folder is refused, and the call returns `FILE_EXISTS` and `BAD_ARGS` where they apply. |
| P08 | hard | | `sandbox.saveAs` and `project.saveAs` outside the folder are refused. |
| P09 | soft | | Save As inside the folder retargets the project and carries the folder over. |
| P10 | hard | | `BLOCKED_CALL` comes both from the static scan list and from `require("child_process")` at run time. |
| P11 | hard | | Scripts that clobber would-be panel globals don't break the bridge. |
| P12 | hard | | A `STALE` command doesn't run and is marked `error`. This applies to `getState` too. |
| P13 | hard | | Each run makes a `<stamp>_E2E.prproj` backup, and only the newest 10 are kept. Typed tools make backups too. |
| P14 | hard | | `PROJECT_NOT_CONFIRMED`, `PROJECT_UNSAVED` for `""`, and `getState` is exempt. |
| P15 | hard | | `PROJECT_NOT_OPEN` comes with `openProjects`. Case, separators, the `\\?\` prefix and `..` are tolerated. |
| P16 | hard | | Targeting by path works while Second.prproj is active. Soft: Second is the active project after it is reopened. |
| P17 | hard | | `NO_FOLDER` and `FOLDER_MISSING`, for scripts and for mutating typed tools, and the default-root fallback. |
| P18 | hard | | E2E.prproj is closed and reopened. It returns `PROJECT_NOT_OPEN` while closed, and its folder comes back when reopened. |
| P19 | hard | | `createProject` returns `FILE_EXISTS`, `BAD_ARGS` and `NOT_IN_DEFAULT_ROOT` where they apply, and a scripted `createProject` outside the folder is refused. If one of your own default roots contains `%TEMP%`, the `NOT_IN_DEFAULT_ROOT` check is skipped with a note. |
| P20 | hard | | The archive `.js` and the `run-log.txt` lines, for both success and failure. |
| P21 | hard | | A long script reports `running` first. |
| P22 | hard | | `SCRIPT_ERROR` and `SYNTAX_ERROR` come with messages. Soft: line numbers. |
| P23 | hard | | `returnValue` round-trips. Host objects become strings, the depth limit applies, and BigInt values are handled. |
| P24 | hard | | `runScriptFile`: a file inside the folder runs. Outside the folder returns `OUTSIDE_FOLDER`, and the call also returns `BLOCKED_CALL` and `FILE_NOT_FOUND` where they apply. |
| P25 | hard | | 20 rapid commands each get one matching result and each runs exactly once. |
| P26 | hard | | A command written while a script runs is not clobbered and runs afterwards. |
| P27 | hard | interactive | Pause returns `PAUSED` before the target check, also pauses harness commands, and keeps the folder. |
| P28 | hard | media | Create a 29.97 sequence from a clip, then build/replace it with trims and check it frame-exact via `getSequence`. Also checks `BAD_TIME`. Soft: the second trimmed clip, in points, linked audio, appending a 23.976 clip. |
| P29 | hard | media | Bulk markers, timecode, `BAD_TIME` and `BAD_ARGS`. Soft: undo steps, reading markers back, a marker on a clip. |
| P30 | hard | media | `editItems` move and trim end work, and a ripple move is refused. Soft: edge trims (setIn moves the head, setOut the tail), disable/enable, audio-only remove, ripple remove, linked audio moving along, one undo step. |
| P31 | hard | media | `placeAudio` on A2, then `setAudio` level and fades. Soft: the out point is honoured. |
| P32 | hard | media | A video Cross Dissolve. Soft: `getSequence` lists it afterwards. |
| P33 | hard | media, no sidecar | `setSpeed` and audio transitions return `NEEDS_SIDECAR_UNAVAILABLE`, with no backup and no undo step. |
| P34 | soft | media, sidecar | Set speed through the sidecar (`prx_*` files). |
| P35 | soft | media, sidecar | An audio crossfade through the sidecar. |
| P36 | soft | media, sidecar | Unlink and relink through the sidecar. The command names are provisional. |
| P37 | hard | | Moving a scratch disk outside the folder or to My Documents is refused, and nothing changes. |
| P38 | soft | media, interactive | One Ctrl+Z in Premiere removes the marker one typed tool added. |
| P39 | hard | media | `replaceMedia` relinks and renames, and the project item points at the new file. Soft: trims are kept and the timeline follows. |
| P40 | hard | | `outside\` holds only the harness's own files. |

**Sidecar-dependent cases.** Speed, audio transitions and link/unlink need the CEP sidecar. P34 to P36 run only when `getState.sidecarAvailable` is true and are skipped otherwise. Without the sidecar, P33 runs instead and checks that these operations refuse cleanly.

**Why the soft ones are soft.** The capability spike on 26.5.2 found these issues:
- `buildSequence` honoured the first clip's trim duration but not the second clip's in/out (`verified: false`).
- Project items report an unset in/out sentinel, so "trims kept" across a relink can't be read reliably.
- `getSequence` failed once after a transition was added.

These haven't been confirmed live yet:
- Save As with several projects open.
- Marker colours.
- Edge-trim semantics.
- Ripple remove and audio-only remove.
- Undo-step counts.

When one of these is confirmed live, make its check hard.

### Dry run

With `npm test`, `test/premiere-e2e-dryrun.test.mjs` runs the same case list against a fake panel: the real panel core and typed commands, over the fake `premierepro` model from `test/premiere-fakeppro.mjs` as extended in `test/premiere-e2e-fakepanel.mjs`. It uses a temp `AE_MCP_BRIDGE_DIR`. It checks that:
- every case passes with no soft notes
- teardown leaves no folder settings, no default root, no open throwaway project and no temp folder
- your fake project is never saved or edited
- every command targets the temp root
- without media, the media cases skip
- an injected failure still tears down and exits 1
- each refusal exits 2
