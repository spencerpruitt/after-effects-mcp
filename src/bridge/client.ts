// Shared file bridge between an MCP server and an app panel (After Effects, Premiere UXP panel,
// Premiere CEP sidecar). See docs/bridge-protocol.md and docs/premiere-bridge-spec.md §3-§4.
//
// One BridgeClient per command/result file pair. Each client has its own mutex, lastCommandId and
// pendingScriptId. The confirmed project lives in a ProjectState object that several clients may
// share (the Premiere panel and its sidecar share one).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type BridgePrefix = "ae" | "pr" | "prx";

export interface BridgeAppConfig {
  // File prefix: `${prefix}_command.json`, `${prefix}_mcp_result.json`.
  prefix: BridgePrefix;
  // Human name used in messages ("After Effects", "Premiere Pro").
  appLabel: string;
  // Panel name used in the stale-result warning ("MCP Bridge Auto").
  panelLabel: string;
  // Name of the tool that reads results ("get-results", "premiere-get-results").
  resultsToolName: string;
  // Extra sentence appended to the "still running" message (e.g. "A Premiere dialog may be waiting.").
  runningHint?: string;
  // Heartbeat file the panel's poll tick writes ({ ts: ISO, ... }) in the bridge dir. With `revive`,
  // a heartbeat older than heartbeatStaleMs (default 6000) before a command is sent means the poll
  // task is dead (After Effects drops it after a project is opened from its menus): revive() is
  // called to re-arm it, and the command waits briefly for a fresh heartbeat before being written.
  heartbeatFileName?: string;
  heartbeatStaleMs?: number;
  // How long to wait for a fresh heartbeat after a kick (default REVIVE_WAIT_MS).
  reviveWaitMs?: number;
  // Re-arms the panel's poll from outside the app (AE: AfterFX.exe -r). Returns true when a kick was
  // sent, false when nothing could be done (app not running, unsupported platform).
  revive?: () => Promise<boolean> | boolean;
  // App-specific confirmedProject rule for a successful result of our own command. Return the
  // project path to confirm, null to clear confirmedProject, or undefined to fall through to the
  // generic _projectChanged rule.
  confirmFromResult?: (parsed: any, info: ConfirmInfo) => string | null | undefined;
}

// What the command being answered was sent with, for confirmFromResult.
export interface ConfirmInfo {
  // expectedProject as written to the command file (undefined when the field was omitted).
  expectedProject: string | undefined;
  // True when the caller passed expectedProject explicitly instead of defaulting to confirmedProject.
  explicitProject: boolean;
  confirmedProject: string | undefined;
}

// Holds the project the server believes it is targeting. Shareable between clients.
export class ProjectState {
  confirmedProject: string | undefined;
}

export interface WaitOptions {
  // Keep polling while the matched result reports status "running" (runScript / runScriptFile).
  waitWhileRunning?: boolean;
}

export interface SendOptions extends WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  // Overrides confirmedProject as the command's expectedProject. `null` omits the field.
  expectedProject?: string | null;
}

export interface WriteOptions {
  expectedProject?: string | null;
}

export const PENDING_SCRIPT_MAX_MS = 30 * 60 * 1000;
export const HEARTBEAT_STALE_MS = 6000;
// How long reviveIfStale waits for the first fresh heartbeat after a kick.
export const REVIVE_WAIT_MS = 10000;

// Must match the panels' folder: %USERPROFILE%\ae-mcp-bridge (kept out of Documents, which OneDrive can redirect).
export function getBridgeDir(): string {
  const bridgeDir = process.env.AE_MCP_BRIDGE_DIR || path.join(os.homedir(), "ae-mcp-bridge");
  if (!fs.existsSync(bridgeDir)) {
    fs.mkdirSync(bridgeDir, { recursive: true });
  }
  return bridgeDir;
}

export function generateCommandId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ExtendScript can mangle non-ASCII text when reading the file; escape everything outside ASCII as \uXXXX.
export function toAsciiJson(value: any): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function resultMatchesCommand(parsed: any, commandId: string | undefined, expectedCommand?: string): boolean {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  if (parsed._commandId !== undefined && parsed._commandId !== null && parsed._commandId !== "") {
    return commandId !== undefined && parsed._commandId === commandId;
  }
  // Older panels don't echo the id; fall back to the command name.
  return !expectedCommand || parsed._commandExecuted === expectedCommand;
}

export class BridgeClient {
  readonly config: BridgeAppConfig;
  readonly projectState: ProjectState;
  // Id of the most recent command written by writeCommandFile(). Only readResults() (which reads
  // without the bridge lock) relies on it; tool calls match on the id writeCommandFile() returned.
  lastCommandId: string | undefined;
  // Id of a runScript / runScriptFile that was still running when its tool call stopped waiting.
  // While set, every other bridge command is refused so it can't overwrite the running command.
  pendingScriptId: string | undefined;
  pendingScriptSince = 0;
  // How the most recent command was targeted (see ConfirmInfo).
  private lastSent: { id: string; expectedProject: string | undefined; explicitProject: boolean } | undefined;
  private bridgeChain: Promise<unknown> = Promise.resolve();
  // What the last reviveIfStale() did, for the timeout hint of the command that followed it.
  private lastReviveNote: string | undefined;

  constructor(config: BridgeAppConfig, projectState: ProjectState = new ProjectState()) {
    this.config = config;
    this.projectState = projectState;
  }

  get confirmedProject(): string | undefined {
    return this.projectState.confirmedProject;
  }

  set confirmedProject(value: string | undefined) {
    this.projectState.confirmedProject = value;
  }

  get commandFileName(): string {
    return `${this.config.prefix}_command.json`;
  }

  get resultFileName(): string {
    return `${this.config.prefix}_mcp_result.json`;
  }

  commandFilePath(): string {
    return path.join(getBridgeDir(), this.commandFileName);
  }

  heartbeatFilePath(): string | undefined {
    return this.config.heartbeatFileName ? path.join(getBridgeDir(), this.config.heartbeatFileName) : undefined;
  }

  // Milliseconds since the panel's last heartbeat (its `ts`, else the file's mtime); undefined
  // without a heartbeat file (no heartbeat configured, or a panel that predates heartbeats).
  heartbeatAgeMs(): number | undefined {
    const file = this.heartbeatFilePath();
    if (!file || !fs.existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const ts = Date.parse(parsed && parsed.ts);
      if (!Number.isNaN(ts)) return Math.max(0, Date.now() - ts);
    } catch {

    }
    try {
      return Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
    } catch {
      return undefined;
    }
  }

  heartbeatFresh(): boolean {
    const age = this.heartbeatAgeMs();
    return age !== undefined && age < (this.config.heartbeatStaleMs ?? HEARTBEAT_STALE_MS);
  }

  // Called before each command is written. With a stale heartbeat, kicks the panel's poll back to
  // life through config.revive and waits (up to REVIVE_WAIT_MS) for a fresh heartbeat. Returns a
  // note about what happened, or undefined when nothing was needed or possible.
  async reviveIfStale(waitMs: number = this.config.reviveWaitMs ?? REVIVE_WAIT_MS): Promise<string | undefined> {
    this.lastReviveNote = undefined;
    if (!this.config.revive) return undefined;
    const age = this.heartbeatAgeMs();
    if (age === undefined || age < (this.config.heartbeatStaleMs ?? HEARTBEAT_STALE_MS)) return undefined;
    const app = this.config.appLabel;
    const ageText = `${Math.round(age / 1000)} s`;
    let kicked = false;
    try {
      kicked = await this.config.revive();
    } catch (error) {
      console.error("Revive failed:", error);
    }
    if (!kicked) {
      this.lastReviveNote = `The ${this.config.panelLabel} panel's last poll was ${ageText} ago and it could not be re-armed (${app} not running, or not supported here).`;
      console.error(this.lastReviveNote);
      return this.lastReviveNote;
    }
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (this.heartbeatFresh()) {
        this.lastReviveNote = `The ${this.config.panelLabel} panel's poll had stopped (last poll ${ageText} ago, usually because a project was opened from ${app}'s menus); it was re-armed.`;
        console.error(this.lastReviveNote);
        return this.lastReviveNote;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    this.lastReviveNote = `The ${this.config.panelLabel} panel's poll had stopped (last poll ${ageText} ago). A re-arm was sent but no heartbeat followed within ${Math.round(waitMs / 1000)} s: ` +
      `${app} is probably showing a dialog, possibly "Cannot run a script while a modal dialog is waiting for response" (the state opening a project from its menus leaves behind). ` +
      `Ask the user to dismiss it and click in ${app}.`;
    console.error(this.lastReviveNote);
    return this.lastReviveNote;
  }

  resultFilePath(): string {
    return path.join(getBridgeDir(), this.resultFileName);
  }

  // Updates confirmedProject only from a successful result that answers command `commandId`:
  // the app's own rule (config.confirmFromResult), or any success with _projectChanged === true
  // (_project). Refusals and errors never count.
  updateConfirmedProjectFromResult(parsed: any, commandId: string | undefined): void {
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    if (parsed.refused || parsed.status === "error" || parsed.error) {
      return;
    }
    if (!commandId || parsed._commandId !== commandId) {
      return;
    }
    const sent = this.lastSent && this.lastSent.id === commandId ? this.lastSent : undefined;
    const info: ConfirmInfo = {
      expectedProject: sent ? sent.expectedProject : undefined,
      explicitProject: sent ? sent.explicitProject : false,
      confirmedProject: this.confirmedProject
    };
    const fromApp = this.config.confirmFromResult ? this.config.confirmFromResult(parsed, info) : undefined;
    if (fromApp === null) {
      if (this.confirmedProject !== undefined) {
        this.confirmedProject = undefined;
        console.error("Confirmed project cleared: it is no longer open.");
      }
      return;
    }
    if (fromApp !== undefined) {
      this.confirmedProject = fromApp;
    } else if (parsed.status === "success" && parsed._projectChanged === true && typeof parsed._project === "string") {
      this.confirmedProject = parsed._project;
    } else {
      return;
    }
    console.error(`Confirmed open project: ${this.confirmedProject === "" ? "(untitled)" : this.confirmedProject}`);
  }

  // Clears pendingScriptId once a final (non-running) result for it has been seen.
  notePendingScriptResult(parsed: any): void {
    if (this.pendingScriptId && parsed && typeof parsed === "object" &&
        parsed._commandId === this.pendingScriptId && parsed.status !== "running") {
      console.error(`Script ${this.pendingScriptId} finished.`);
      this.pendingScriptId = undefined;
    }
  }

  // Protects a queued or still-running script until a read sees its final result.
  markPendingScript(id: string): void {
    this.pendingScriptId = id;
    this.pendingScriptSince = Date.now();
  }

  // Returns a refusal message while a script is still running, or undefined.
  pendingScriptMessage(): string | undefined {
    if (!this.pendingScriptId) {
      return undefined;
    }
    if (Date.now() - this.pendingScriptSince > PENDING_SCRIPT_MAX_MS) {
      console.error(`Giving up on pending script ${this.pendingScriptId} after 30 minutes.`);
      this.pendingScriptId = undefined;
      return undefined;
    }
    // The result may already be final even if nobody called get-results yet.
    try {
      const resultPath = this.resultFilePath();
      if (fs.existsSync(resultPath)) {
        const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        this.updateConfirmedProjectFromResult(parsed, this.pendingScriptId);
        this.notePendingScriptResult(parsed);
      }
    } catch {

    }
    if (!this.pendingScriptId) {
      return undefined;
    }
    return `A script is still running in ${this.config.appLabel} (id ${this.pendingScriptId}). Call ${this.config.resultsToolName} until it finishes.`;
  }

  async waitForBridgeResult(commandId: string | undefined, expectedCommand?: string, timeoutMs: number = 5000, pollMs: number = 250, options: WaitOptions = {}): Promise<string> {
    const start = Date.now();
    const resultPath = this.resultFilePath();
    let lastContent: string | undefined;
    let sawRunning = false;

    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, "utf8");
          if (content && content.length > 0 && content !== lastContent) {
            lastContent = content;
            try {
              const parsed = JSON.parse(content);
              if (resultMatchesCommand(parsed, commandId, expectedCommand)) {
                if (options.waitWhileRunning && parsed.status === "running") {
                  sawRunning = true;
                } else {
                  this.updateConfirmedProjectFromResult(parsed, commandId);
                  this.notePendingScriptResult(parsed);
                  return content;
                }
              }
            } catch {

            }
          }
        } catch {

        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    if (sawRunning) {
      return JSON.stringify({
        status: "running",
        _commandId: commandId,
        message: `Script is still running after ${Math.round(timeoutMs / 1000)}s — call ${this.config.resultsToolName} later to fetch the final result.` +
          (this.config.runningHint ? ` ${this.config.runningHint}` : "")
      });
    }
    const base = `Timed out waiting for bridge result${expectedCommand ? ` for command '${expectedCommand}'` : ""}.`;
    const hint = this.timeoutHint(commandId);
    return JSON.stringify(hint ? { error: `${base} ${hint.message}`, code: hint.code } : { error: base });
  }

  // Why a command timed out, read from the command file the panel updates: still "pending" means the
  // panel never picked it up (its poller isn't running: a modal dialog, a project loading, or the panel
  // closed); "running" means it started and is still going.
  timeoutHint(commandId: string | undefined): { code: string; message: string } | undefined {
    if (!commandId) return undefined;
    let cmd: any;
    try {
      cmd = JSON.parse(fs.readFileSync(this.commandFilePath(), "utf8"));
    } catch {
      return undefined;
    }
    if (!cmd || String(cmd.id || cmd.timestamp || "") !== commandId) return undefined;
    const app = this.config.appLabel;
    if (cmd.status === "pending") {
      const age = this.heartbeatAgeMs();
      const heartbeat = this.config.heartbeatFileName
        ? (age === undefined
          ? ` No heartbeat file: the installed panel predates heartbeats or has never polled.`
          : ` The panel's last poll was ${Math.round(age / 1000)} s ago.`)
        : "";
      const revive = this.lastReviveNote ? ` ${this.lastReviveNote}` : "";
      return {
        code: "NOT_PICKED_UP",
        message: `${app} never picked the command up, so the ${this.config.panelLabel} panel isn't polling: ` +
          `${app} is probably showing a dialog (open/save, missing footage, an error) or still loading a project, ` +
          `or the panel is closed.${heartbeat}${revive} Ask the user to check ${app}, then retry; commands older than 120 s are dropped.`
      };
    }
    if (cmd.status === "running") {
      return {
        code: "STILL_RUNNING",
        message: `${app} picked the command up and it is still running. Call ${this.config.resultsToolName} later.`
      };
    }
    return undefined;
  }

  // Writes the command atomically (tmp + rename) and returns its id. Throws if it can't be written.
  writeCommandFile(command: string, args: Record<string, any> = {}, options: WriteOptions = {}): string {
    const bridgeDir = getBridgeDir();
    const commandFile = path.join(bridgeDir, this.commandFileName);
    const tmpFile = path.join(bridgeDir, `${this.commandFileName}.tmp`);
    const id = generateCommandId();
    const commandData: Record<string, any> = {
      id,
      command,
      args,
      timestamp: new Date().toISOString(),
      status: "pending"
    };
    const expected = options.expectedProject !== undefined ? options.expectedProject : this.confirmedProject;
    if (expected !== undefined && expected !== null) {
      commandData.expectedProject = expected;
    }
    this.lastCommandId = id;
    this.lastSent = {
      id,
      expectedProject: commandData.expectedProject,
      explicitProject: typeof options.expectedProject === "string"
    };
    fs.writeFileSync(tmpFile, toAsciiJson(commandData));
    // The panel may briefly hold the target open while reading it; retry the rename.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmpFile, commandFile);
        break;
      } catch (error) {
        if (attempt >= 20) {
          console.error("Error writing command file:", error);
          throw error;
        }
        sleepSync(25);
      }
    }
    console.error(`Command "${command}" (${id}) written to ${commandFile}`);
    return id;
  }

  // Only one bridge command is in flight at a time: every clear -> write -> wait runs through this chain.
  withBridgeLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.bridgeChain.then(() => fn());
    this.bridgeChain = run.catch(() => undefined);
    return run;
  }

  // Clears the result file, writes the command and waits for its result, holding the bridge lock.
  // Throws if a script is still running in the app.
  sendBridgeCommand(command: string, args: Record<string, any> = {}, options: SendOptions = {}): Promise<string> {
    return this.withBridgeLock(async () => {
      const busy = this.pendingScriptMessage();
      if (busy) {
        throw new Error(busy);
      }
      await this.reviveIfStale();
      this.clearResultsFile();
      const id = this.writeCommandFile(command, args, { expectedProject: options.expectedProject });
      const result = await this.waitForBridgeResult(id, command, options.timeoutMs ?? 7000, options.pollMs ?? 250, options);
      if (options.waitWhileRunning) {
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.status === "running" && parsed._commandId === id) {
            this.markPendingScript(id);
          }
        } catch {

        }
      }
      return result;
    });
  }

  // Clears the result file and writes the command without waiting (call get-results later).
  // Holds the bridge lock only for clear + write. Throws if a script is still running.
  queueBridgeCommand(command: string, args: Record<string, any> = {}, options: WriteOptions = {}): Promise<string> {
    return this.withBridgeLock(async () => {
      const busy = this.pendingScriptMessage();
      if (busy) {
        throw new Error(busy);
      }
      await this.reviveIfStale();
      this.clearResultsFile();
      return this.writeCommandFile(command, args, options);
    });
  }

  clearResultsFile(): void {
    try {
      const resultFile = this.resultFilePath();
      const resetData = {
        status: "waiting",
        message: `Waiting for new result from ${this.config.appLabel}...`,
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(resultFile, JSON.stringify(resetData, null, 2));
      console.error(`Results file cleared at ${resultFile}`);
    } catch (error) {
      console.error("Error clearing results file:", error);
    }
  }

  // The get-results implementation: reads the result file without the lock.
  readResults(): string {
    try {
      const tempFilePath = this.resultFilePath();
      console.error(`Checking for results at: ${tempFilePath}`);

      if (fs.existsSync(tempFilePath)) {
        const stats = fs.statSync(tempFilePath);
        console.error(`Result file exists, last modified: ${stats.mtime.toISOString()}`);

        const content = fs.readFileSync(tempFilePath, "utf8");
        console.error(`Result file content length: ${content.length} bytes`);

        let stillRunning = false;
        try {
          const parsed = JSON.parse(content);
          // Reads happen outside the bridge lock; the file can only answer the most recent command.
          this.updateConfirmedProjectFromResult(parsed, this.lastCommandId);
          this.notePendingScriptResult(parsed);
          // A long script legitimately leaves the "running" placeholder untouched for a while.
          stillRunning = !!parsed && parsed.status === "running";
        } catch {

        }

        const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
        if (!stillRunning && stats.mtime < thirtySecondsAgo) {
          console.error(`WARNING: Result file is older than 30 seconds. ${this.config.appLabel} may not be updating results.`);
          return JSON.stringify({
            warning: "Result file appears to be stale (not recently updated).",
            message: `This could indicate ${this.config.appLabel} is not properly writing results or the ${this.config.panelLabel} panel isn't running.`,
            lastModified: stats.mtime.toISOString(),
            originalContent: content
          });
        }

        return content;
      } else {
        console.error(`Result file not found at: ${tempFilePath}`);
        return JSON.stringify({ error: `No results file found. Please run a script in ${this.config.appLabel} first.` });
      }
    } catch (error) {
      console.error("Error reading results file:", error);
      return JSON.stringify({ error: `Failed to read results: ${String(error)}` });
    }
  }
}
