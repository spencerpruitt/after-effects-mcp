# Bridge end-to-end tests (seam 1)

`bridge.e2e.mjs` checks the bridge command/result file protocol (`docs/bridge-protocol.md`) against the real After Effects 2026 instance. It is an on-demand suite and is not run in CI.

## Run

1. Save your work in AE.
2. Open the bridge panel (`Window -> mcp-bridge-auto.jsx`) and make sure **Pause** is unticked. The panel must be the current build: reinstall it and reopen it after any panel change.
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
