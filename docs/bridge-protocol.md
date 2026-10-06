# Bridge protocol

Shared contract between the MCP server (`src/index.ts`), the AE panel (`src/scripts/mcp-bridge-auto.jsx`) and the end-to-end harness (`test/e2e/`).

Bridge folder: `%AE_MCP_BRIDGE_DIR%` or `%USERPROFILE%\ae-mcp-bridge`.

## Command file `ae_command.json` (written by the server)

```json
{
  "id": "1759790000000-k3j2h1",
  "command": "runScript",
  "args": { "code": "return app.project.numItems;", "name": "count-items" },
  "timestamp": "2026-10-06T22:00:00.000Z",
  "status": "pending",
  "expectedProject": "D:\\Projects\\MyFilm\\shots\\SH010\\SH010.aep"
}
```

- `id`: unique per command. Legacy commands without `id` use `timestamp` as the id.
- `expectedProject`: the absolute path of the .aep Claude believes is open, or `""` for an untitled project. Omitted when the server hasn't confirmed a project yet.
- `status`: `pending` → `running` → `completed` | `error`. The panel only rewrites the status when the file's `id` still equals the id it is processing. A newer command written meanwhile is never clobbered.

## Panel processing

- The panel polls every 500 ms. It processes a command when `status === "pending"` and `id !== lastProcessedId`. It reads the command file as UTF-8.
- **Stale check**, applied to every command, exempt ones included: if `timestamp` is more than 120 s old, the command is not run. The panel writes `{ "status": "error", "refused": true, "code": "STALE", "message": "..." }` and sets the command's status to `error`. A `timestamp` the panel can't parse is never treated as stale.
- **Gate**, applied in this order. The exempt read-only commands `getSandboxFolder` and `getProjectInfo` skip it.
  1. The Pause checkbox is on: refused with code `PAUSED`.
  2. `expectedProject` is missing: refused with code `PROJECT_NOT_CONFIRMED`.
  3. Comparing `normalize(expectedProject)` against `normalize(open project path)`, both `""` when untitled, gives a mismatch: refused with code `PROJECT_MISMATCH`. The refusal includes `expectedProject` and `openProject`.
- Refusal result shape: `{ "status": "error", "refused": true, "code": "...", "message": "..." }`.

## Result file `ae_mcp_result.json` (written by the panel)

- Every result object gets these fields added:
  - `_commandId`
  - `_commandExecuted` (the command name)
  - `_responseTimestamp` (ISO)
  - `_project` (the open project path, `""` if untitled)
  - `_projectChanged`: `true` when the command succeeded and a different project is open than when it started (for example after `sandbox.saveAs` or `saveProject` with a path). It is `false` on errors, refusals and `running` results.
- Writes are atomic: the panel writes `ae_mcp_result.tmp`, removes the old `ae_mcp_result.json`, then renames.
- For `runScript` and `runScriptFile`, the panel first writes `{ "status": "running", ... }` with the same `_commandId`. It overwrites this with the final result when the run ends.

## Commands added

### `getSandboxFolder` (exempt from the gate)

Arguments: `{}`. Returns:

```json
{ "status": "success", "projectPath": "...", "projectName": "SH010.aep", "folder": "F:\\...\\SH010" , "folderExists": true, "paused": false, "scriptsEnabled": true }
```

- `folder` is `null` when the project is unsaved or no folder has been chosen.
- `scriptsEnabled` = folder set && folder exists && not paused.

### `runScript`

Arguments: `{ "code": string, "name"?: string }`.

### `runScriptFile`

Arguments: `{ "file": string }`. The path is relative to the folder or absolute, and must resolve inside the folder.

**Steps, in order:**
1. **Precondition checks:**
   - No folder set: code `NO_FOLDER`.
   - Folder doesn't exist: code `FOLDER_MISSING`.
   - `MCPPathPolicy.scanCode(code)` finds a blocked call: code `BLOCKED_CALL`. This check also applies to file contents.
   - `runScriptFile` path outside the folder: code `OUTSIDE_FOLDER`.
2. **Archive** (`runScript` only): write the code to `<folder>/mcp-scripts/<yyyymmdd-hhmmss-mmm>_<name>.jsx`.
3. **Save in place:** `app.project.save()` if the project has a file. If the save fails, the panel returns code `SAVE_FAILED` and doesn't run the script.
   - **Rolling backup:** if the project has a file, the panel copies the saved .aep to `<folder>/mcp-scripts/backups/<yyyymmdd-hhmmss-mmm>_<project base name>.aep`. It keeps the newest 10 backups for that project base name and deletes older ones. A failed backup doesn't stop the run: the result gets a `backupWarning`.
4. **Install write guards,** which throw `Error("Blocked: ... outside the writable folder: <path>")`:
   - `File.prototype.open` with mode containing w, a or e
   - `File.prototype.remove`, `rename`, `copy` (target)
   - `File.prototype.execute`, which is always blocked
   - `Folder.prototype.create`, `remove`, `rename`
5. **Open an undo group:** `app.beginUndoGroup("MCP: <name>")`.
6. **Run** the code as the body of `new Function("sandbox", "system", code)`. Scripts use `return` to hand back a value. `system` is a stub whose `callSystem` throws.
7. **Clean up:** in `finally`, `app.endUndoGroup()` and restore the guards.
8. **Audit:** if the project's file path changed to a location outside the folder, add the entry to `sandboxViolations`.
9. **Log:** append a line to `<folder>/mcp-scripts/run-log.txt`: `ISO time \t name \t success|error \t durationMs \t message`.

**Script results:**
- Success: `{ "status": "success", "returnValue": <JSON-safe value>, "durationMs": n, "archivedAs": "...", "sandboxViolations": [], "backupPath": "..."|null, "backupWarning"?: "..." }`.
- Error: `{ "status": "error", "code"?: "...", "message": "...", "line": n|null, "archivedAs"?: "...", "backupPath"?: "..."|null, "backupWarning"?: "..." }`. `backupPath` is present once the run has got past the backup step.
- `line` is relative to the script's own first line.
- Return values are converted to JSON-safe form: depth limit 8, and host objects become `String(value)`.

**`sandbox` helper available to scripts:**

| Member | What it does |
|---|---|
| `sandbox.folder` | The writable folder path. |
| `sandbox.path(rel)` | Turns a path relative to the folder into an absolute path. Absolute paths are returned unchanged. |
| `sandbox.saveAs(path, overwrite?)` | Saves the project to a path inside the folder. The new project keeps the same folder setting (see below). |
| `sandbox.render()` | Checks that every queued render-queue output module's file is inside the folder, then calls `renderQueue.render()`. |
| `sandbox.saveFrameToPng(comp, time, path)` | Saves a frame, after checking the path is inside the folder. |

**Folder follows Save As:** when `sandbox.saveAs` or `saveProject` with a `path` saves the project to a new path inside the folder, the panel stores the same folder for the new project. This copies the user's existing choice, and the folder can never get wider.

## Panel implementation notes

- **One global:** all panel code runs inside a single IIFE, so a script that assigns to an undeclared name can't overwrite panel state. The panel's only global is `$.global.__mcpBridgeCheck`, which `app.scheduleTask("__mcpBridgeCheck()", 500, true)` calls. The JSON and `Date.prototype.toISOString` polyfills are also installed globally, so scripts can use them.
- **ES3:** ExtendScript has no `Date.prototype.toISOString`, so the panel adds a polyfill if it is missing. Results from older panels have no `_responseTimestamp` because that call threw. Panel code must stay ES3: no `Array.prototype.indexOf`, `forEach`, `map` or `filter`, no `String.prototype.trim`, `Object.keys`, `Function.prototype.bind` or `Array.isArray`, and no ISO `Date.parse`.

## Server behaviour

- **One command in flight.** Every bridge interaction (clear the result file → write the command → wait for its result) runs through a promise-chain mutex (`sendBridgeCommand()`). Tools that only queue a command (`run-script`, `create-composition`, `run-bridge-test`, …) hold the lock only for clear + write (`queueBridgeCommand()`). `get-results` reads without the lock.
- `writeCommandFile()` generates the `id`, returns it, and adds `expectedProject` from `confirmedProject` when that is known. It also records the id as `lastCommandId`, which only `get-results` uses.
- The command file is written **atomically**: the server writes `ae_command.json.tmp`, then renames it over `ae_command.json`, retrying briefly if the panel holds the file. Non-ASCII characters are escaped as `\uXXXX`, so the file is pure ASCII.
- `waitForBridgeResult(id, command, …)` matches `_commandId === id` (the id of that call's own command). It falls back to the command name only when the result has no `_commandId` (old panels). With `waitWhileRunning`, it keeps polling while `status === "running"`.
- `confirmedProject` is updated **only** from a successful result whose `_commandId` is the command's own id:
  - `getSandboxFolder` → `projectPath`
  - `getProjectInfo` → `path`
  - any command with `status: "success"` and `_projectChanged === true` → `_project` (Claude's own Save As moved the project inside the folder)
  - Refusals and errors never update it.
- **Running scripts are protected.** When a script tool stops waiting while the script is still running, its id becomes `pendingScriptId`. A `run-script` call that queues `runScript` or `runScriptFile` also sets `pendingScriptId`. While it is set, every other bridge command is refused before anything is written: "A script is still running in After Effects (id …). Call get-results until it finishes." `get-results` is exempt. `pendingScriptId` is cleared when any read sees a non-running result with that id, or after 30 minutes as a safety valve.
- **New tools:**
  - `get-sandbox-folder`
  - `run-script-code` `{ code, name?, waitSeconds = 30 (max 600) }`
  - `run-script-file` `{ file, waitSeconds }`
  - If a script is still running when `waitSeconds` runs out, the tool returns "still running — call get-results".
  - A `STALE` refusal is reported as an error, with a note saying nothing ran.
