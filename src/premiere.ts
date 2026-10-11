// MCP server "premiere": drives Adobe Premiere Pro through the UXP "MCP Bridge" panel.
// Spec: docs/premiere-bridge-spec.md §7. Run with `node build/premiere.js`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { BridgeClient, ProjectState, formatBridgeResult, getBridgeDir, textResult, waitSecondsToMs } from "./bridge/index.js";
import type { BridgeAppConfig, ConfirmInfo, ToolTextResult } from "./bridge/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_CHEATSHEET_PATH = path.join(__dirname, "..", "docs", "premiere-uxp-cheatsheet.md");

export const API_HELP_TOPICS = [
  "transactions", "time", "bins", "import", "editing", "effects", "audio", "markers", "export", "gaps"
] as const;

const TYPED_TIMEOUT_MS = 60 * 1000;
const LONG_TIMEOUT_MS = 300 * 1000;

function pathOf(value: any): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && typeof value.path === "string") {
    return value.path;
  }
  return undefined;
}

function samePrPath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

// The project getState reports as the single saved active one, or undefined.
function singleActiveProject(parsed: any): string | undefined {
  const active = pathOf(parsed.activeProject);
  if (!active) {
    return undefined;
  }
  if (Array.isArray(parsed.openProjects)) {
    const actives = parsed.openProjects.filter((p: any) => p && p.isActive === true);
    if (actives.length !== 1 || !pathOf(actives[0])) {
      return undefined;
    }
  }
  return active;
}

// confirmedProject rules specific to Premiere (spec §7.2, contracts):
// - getState with an explicit `project`: that project, only if it is among the open projects.
// - getState without `project`: only when exactly one project is active and it is saved.
// - getState that shows the confirmed project is no longer open (and confirms nothing else): clear it (null).
// - createProject / openProject success: the new target (_project).
// Anything else falls through to the generic `_projectChanged` -> `_project` rule.
export function premiereConfirmFromResult(parsed: any, info: Partial<ConfirmInfo> = {}): string | null | undefined {
  const command = parsed._commandExecuted;
  if (command === "getState") {
    if (parsed.status !== "success") {
      return undefined;
    }
    const open: string[] | undefined = Array.isArray(parsed.openProjects)
      ? parsed.openProjects.map((p: any) => pathOf(p)).filter((p: string | undefined): p is string => !!p)
      : undefined;
    const findOpen = (p: string) => open?.find((o) => samePrPath(o, p));
    const confirmedGone = !!(info.confirmedProject && open && !findOpen(info.confirmedProject));
    const chosen = info.explicitProject && info.expectedProject
      ? findOpen(info.expectedProject)
      : singleActiveProject(parsed);
    if (chosen) {
      return chosen;
    }
    return confirmedGone ? null : undefined;
  }
  if ((command === "createProject" || command === "openProject") && parsed.status === "success" &&
      typeof parsed._project === "string" && parsed._project !== "") {
    return parsed._project;
  }
  return undefined;
}

export const PREMIERE_CONFIG: BridgeAppConfig = {
  prefix: "pr",
  appLabel: "Premiere Pro",
  panelLabel: "MCP Bridge",
  resultsToolName: "premiere-get-results",
  runningHint: "If it never finishes, a Premiere dialog may be waiting for the user.",
  confirmFromResult: premiereConfirmFromResult
};

// The B-lite CEP sidecar (spec §8). Separate files and lock; shares confirmedProject with the panel.
export const PREMIERE_SIDECAR_CONFIG: BridgeAppConfig = {
  ...PREMIERE_CONFIG,
  prefix: "prx",
  panelLabel: "MCP Bridge sidecar"
};

// ---- Routing between the panel ("pr") and the sidecar ("prx", spec section 8) ----

export interface PremiereRoute {
  via: "pr" | "prx";
  command: string;
  // The args to send, when they differ from the tool's own (after the project / waitSeconds params are removed).
  args?: Record<string, any>;
}

// Tools whose command or channel depends on their args. Pure, so the e2e harness drives the sidecar with the exact
// command names and args the server sends (test/e2e/premiere.e2e.mjs, h.tool).
export const PREMIERE_TOOL_ROUTES: Record<string, (args: Record<string, any>) => PremiereRoute> = {
  "premiere-add-transition": (args) => (typeof args.track === "string" && /^\s*a/i.test(args.track)
    ? { via: "prx", command: "addAudioTransition" }
    : { via: "pr", command: "addTransition" }),
  "premiere-set-speed": () => ({ via: "prx", command: "setSpeed" }),
  "premiere-link-clips": ({ link, ...args }) => ({ via: "prx", command: link === true ? "link" : "unlink", args })
};

// ---- Sidecar availability (spec section 8) ----

export const SIDECAR_HEARTBEAT_FILE = "prx_heartbeat.json";
export const SIDECAR_FRESH_MS = 6000;

export const SIDECAR_INSTALL_HELP =
  "Install the MCP Bridge sidecar (a small CEP extension; UXP can't change clip speed, add audio transitions or link/unlink clips): " +
  "run `npm run install-premiere-sidecar` to see the plan, then `npm run install-premiere-sidecar -- --install --enable-debug` " +
  "(copies it to %APPDATA%\\Adobe\\CEP\\extensions\\com.mcp.premiere.sidecar and sets HKCU\\Software\\Adobe\\CSXS.12 PlayerDebugMode=1, " +
  "needed for an unsigned extension). Restart Premiere and open Window > Extensions (Legacy) > MCP Sidecar once; " +
  "the MCP Bridge panel must stay open too, because the sidecar reads its Pause and folder state.";

// True when the sidecar's heartbeat file was written less than SIDECAR_FRESH_MS ago (its `ts`, else the file mtime).
export function isSidecarAvailable(bridgeDir: string = getBridgeDir(), nowMs: number = Date.now()): boolean {
  const file = path.join(bridgeDir, SIDECAR_HEARTBEAT_FILE);
  try {
    let ts = NaN;
    try {
      ts = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).ts);
    } catch {
      ts = NaN;
    }
    if (Number.isNaN(ts)) {
      ts = fs.statSync(file).mtimeMs;
    }
    const age = nowMs - ts;
    return age >= -SIDECAR_FRESH_MS && age < SIDECAR_FRESH_MS;
  } catch {
    return false;
  }
}

export function sidecarUnavailableResult(toolName: string): ToolTextResult {
  return textResult(JSON.stringify({
    status: "error",
    refused: true,
    code: "NEEDS_SIDECAR_UNAVAILABLE",
    message: `${toolName} needs the MCP Bridge sidecar (CEP), and it isn't running: no ${SIDECAR_HEARTBEAT_FILE} newer than ${SIDECAR_FRESH_MS / 1000} s in the bridge folder. Nothing was sent.`,
    install: SIDECAR_INSTALL_HELP
  }, null, 2), true);
}

const GATE_CODES = ["PROJECT_NOT_OPEN", "PROJECT_NOT_CONFIRMED", "PROJECT_UNSAVED"];

function premiereGateNote(parsed: any): string | undefined {
  if (!GATE_CODES.includes(parsed.code)) {
    return undefined;
  }
  const open = Array.isArray(parsed.openProjects) && parsed.openProjects.length
    ? ` Open projects: ${parsed.openProjects.map((p: any) => pathOf(p) ?? String(p)).join("; ")}.`
    : "";
  return "\n\nRefused by the project gate: the target project is not usable in Premiere Pro." + open +
    " Do not retry blindly. Tell the user which projects are open, ask which one to work on, then pass its path as `project` " +
    "(or call premiere-open-project / premiere-get-state). An untitled project must be saved first.";
}

export function formatPremiereResult(result: string): ToolTextResult {
  return formatBridgeResult(result, { appLabel: PREMIERE_CONFIG.appLabel, gateNote: premiereGateNote });
}

// Returns the `## <topic>` section of the cheat sheet (case-insensitive), or the whole file.
export function getApiHelpText(topic: string | undefined, cheatsheetPath: string = DEFAULT_CHEATSHEET_PATH): { text: string; isError: boolean } {
  let content: string;
  try {
    content = fs.readFileSync(cheatsheetPath, "utf8").replace(/^﻿/, "");
  } catch {
    return {
      text: `The Premiere API cheat sheet is missing (${cheatsheetPath}). Use the Adobe reference instead: ` +
        "https://developer.adobe.com/premiere-pro/uxp/ppro_reference",
      isError: true
    };
  }
  if (!topic) {
    return { text: content, isError: false };
  }
  const wanted = topic.trim().toLowerCase();
  const lines = content.split(/\r?\n/);
  const headings: string[] = [];
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      if (start >= 0) {
        return { text: lines.slice(start, i).join("\n").trimEnd(), isError: false };
      }
      const heading = m[1].trim();
      headings.push(heading);
      const lower = heading.toLowerCase();
      if (lower === wanted || (lower.startsWith(wanted) && /^[^a-z0-9]/.test(lower.slice(wanted.length)))) {
        start = i;
      }
    } else if (start >= 0 && /^#\s/.test(line)) {
      return { text: lines.slice(start, i).join("\n").trimEnd(), isError: false };
    }
  }
  if (start >= 0) {
    return { text: lines.slice(start).join("\n").trimEnd(), isError: false };
  }
  return {
    text: `No "## ${topic}" section in the cheat sheet. Sections: ${headings.join(", ") || "(none)"}. Call premiere-get-api-help without a topic for the whole file.`,
    isError: true
  };
}

// ---- Schemas (spec §7.1) ----

export const TimeSchema = z.union([
  z.object({ frames: z.number().int() }),
  z.object({ timecode: z.string() })
]).describe("{ frames: int } or { timecode: \"HH:MM:SS:FF\" } (\";FF\" for drop-frame), in the sequence's timebase (the clip's own rate for project-item in/out). Floats are rejected.");

const IdSchema = z.union([z.string(), z.number()]);

export const ItemRefSchema = z.union([
  z.string(),
  z.object({ id: IdSchema }),
  z.object({ file: z.string() })
]).describe("Project item: a \"/\"-separated project path such as \"Renders/v003/SH010_v003\", { id } from an earlier result, or { file } (absolute media path).");

export const SequenceRefSchema = z.union([
  z.string(),
  z.object({ id: IdSchema })
]).describe("Sequence: its project path (\"Edits/Main\") or { id } from an earlier result.");

export const TrackRefSchema = z.string().regex(/^[VA][1-9][0-9]*$/, "Track must look like \"V1\" or \"A2\"")
  .describe("Track, 1-based as in the Premiere UI: \"V1\", \"A2\".");

const ClipIndexSchema = z.number().int().min(0).describe("Clip index on the track, as reported by premiere-get-sequence.");

const ProjectArg = z.string().min(1).optional()
  .describe("Absolute path of the target .prproj (must be open in Premiere). Defaults to the project confirmed by premiere-get-state.");

const WaitSecondsArg = z.number().int().min(1).max(600).optional().default(30)
  .describe("How long to wait for the script to finish (default 30, max 600). If it is still running after this, call premiere-get-results later.");

const PROJECT_GUIDANCE =
  "Every tool targets one project by path (`project`, else the one confirmed by premiere-get-state); Premiere never falls back to the active project. " +
  "Refusals PROJECT_NOT_OPEN / PROJECT_UNSAVED / PROJECT_NOT_CONFIRMED: tell the user, don't retry blindly. PAUSED: ask the user to untick Pause in the MCP Bridge panel.";

const MUTATING_NOTE = " Saves the project and takes a rolling backup first; the edit is one undo step, and `undoSteps` in the result counts every undo step added (setup steps and imports included).";

const SCRIPT_DESCRIPTION =
  "Call premiere-get-api-help first; code is an async JS body with ppro, project, sandbox, fs, require, time in scope; use return. " +
  "`project` is the target project, `sandbox` has folder, path(rel), saveAs(path, overwrite?), transaction(name, async (compound, project) => ...), export(...), log(msg). " +
  "Writes (fs, saveAs, exports) are allowed only inside the sandbox folder chosen in the MCP Bridge panel; blocked calls are refused with BLOCKED_CALL before running. " +
  "The project is saved and backed up before each run; the code is archived to <folder>/mcp-scripts/. Result: { status, returnValue, undoSteps, backupPath, ... }. " +
  "If still running after waitSeconds, call premiere-get-results (a Premiere dialog may be waiting). ";

type Handler = (args: any) => Promise<ToolTextResult>;

export interface PremiereToolEntry {
  description: string;
  schema: z.ZodRawShape;
  handler: Handler;
}

export interface PremiereServerOptions {
  cheatsheetPath?: string;
}

export interface PremiereServer {
  server: McpServer;
  tools: Record<string, PremiereToolEntry>;
  bridge: BridgeClient;
  sidecar: BridgeClient;
  projectState: ProjectState;
}

const NO_TARGET_MESSAGE =
  "No target project. Call premiere-get-state first (it confirms the active project when exactly one saved project is active), " +
  "or pass `project` with the absolute path of an open .prproj.";

export function createPremiereServer(options: PremiereServerOptions = {}): PremiereServer {
  const cheatsheetPath = options.cheatsheetPath ?? DEFAULT_CHEATSHEET_PATH;
  const server = new McpServer({ name: "PremiereServer", version: "1.0.0" });
  const projectState = new ProjectState();
  const bridge = new BridgeClient(PREMIERE_CONFIG, projectState);
  const sidecar = new BridgeClient(PREMIERE_SIDECAR_CONFIG, projectState);
  const tools: Record<string, PremiereToolEntry> = {};
  // The client (panel or sidecar) that the last bridge command went to; premiere-get-results reads its file.
  let lastClient: BridgeClient = bridge;

  function register(name: string, description: string, schema: z.ZodRawShape, handler: Handler): void {
    tools[name] = { description, schema, handler };
    (server.tool as any)(name, description, schema, async (args: any) => handler(args ?? {}));
  }

  // `project` arg if given (an explicit override), else confirmedProject (expected undefined: the bridge
  // client fills it in, so confirmFromResult can tell the two apart). Targetless commands may go without either.
  function resolveTarget(project: string | undefined, targetless: boolean): { expected: string | null | undefined } | { error: string } {
    if (project !== undefined) {
      if (!path.win32.isAbsolute(project) && !path.posix.isAbsolute(project)) {
        return { error: `project must be an absolute .prproj path, got "${project}".` };
      }
      return { expected: project };
    }
    if (projectState.confirmedProject) {
      return { expected: undefined };
    }
    if (targetless) {
      return { expected: null };
    }
    return { error: NO_TARGET_MESSAGE };
  }

  function stripUndefined(args: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  interface BridgeToolOptions {
    timeoutMs?: number;
    targetless?: boolean;
    waitWhileRunning?: boolean;
    // Picks the client and command per call: the UXP panel ("pr") or the CEP sidecar ("prx", spec section 8).
    route?: (args: Record<string, any>) => { via: "pr" | "prx"; command: string; args?: Record<string, any> };
  }

  function bridgeTool(name: string, command: string, description: string, schema: z.ZodRawShape, opts: BridgeToolOptions = {}): void {
    const fullSchema: z.ZodRawShape = { ...schema, project: ProjectArg };
    register(name, description, fullSchema, async (params) => {
      const { project, waitSeconds, ...rest } = params ?? {};
      const target = resolveTarget(project, !!opts.targetless);
      if ("error" in target) {
        return textResult(target.error, true);
      }
      const timeoutMs = opts.waitWhileRunning
        ? waitSecondsToMs(waitSeconds)
        : (opts.timeoutMs ?? TYPED_TIMEOUT_MS);
      const routed = opts.route ? opts.route(rest) : { via: "pr" as const, command, args: undefined };
      const client = routed.via === "prx" ? sidecar : bridge;
      if (routed.via === "prx" && !isSidecarAvailable()) {
        return sidecarUnavailableResult(name);
      }
      lastClient = client;
      try {
        const result = await client.sendBridgeCommand(routed.command, stripUndefined(routed.args ?? rest), {
          timeoutMs,
          waitWhileRunning: !!opts.waitWhileRunning,
          expectedProject: target.expected
        });
        return formatPremiereResult(result);
      } catch (error) {
        return textResult(`Error running ${name}: ${String(error)}`, true);
      }
    });
  }

  // ---- Tools (spec §7.2) ----

  bridgeTool("premiere-get-state", "getState",
    "Ask Premiere Pro which projects are open, which is active, the sandbox folder of the target, pause/script/test-harness state and scratch disks. " +
    "With `project`, confirms that project if it is open; without it, confirms the target only when exactly one saved project is active (otherwise pass `project` to every other tool). " +
    "A confirmed project that is no longer open is forgotten. " +
    "Call it before the first command of a session. " + PROJECT_GUIDANCE,
    {}, { targetless: true, timeoutMs: TYPED_TIMEOUT_MS });

  register("premiere-get-api-help",
    "Premiere UXP scripting cheat sheet (served locally, no Premiere round-trip). Read it before writing premiere-run-script-code. " +
    "Without a topic it returns the whole sheet.",
    { topic: z.enum(API_HELP_TOPICS).optional().describe("Section to return.") },
    async ({ topic }) => {
      const help = getApiHelpText(topic, cheatsheetPath);
      return textResult(help.text, help.isError);
    });

  bridgeTool("premiere-create-project", "createProject",
    "Create a new .prproj. The path must be inside a default root remembered in the MCP Bridge panel (else NOT_IN_DEFAULT_ROOT), so it inherits that folder. " +
    "Opens the project and makes it the target.",
    { path: z.string().min(1).describe("Absolute path of the new .prproj.") },
    { targetless: true, timeoutMs: LONG_TIMEOUT_MS });

  bridgeTool("premiere-open-project", "openProject",
    "Open a .prproj with dialogs suppressed (if already open it is just targeted) and make it the target.",
    { path: z.string().min(1).describe("Absolute path of the .prproj.") },
    { targetless: true, timeoutMs: LONG_TIMEOUT_MS });

  bridgeTool("premiere-save-project", "saveProject",
    "Save the target project in place, or save-as to a path inside the sandbox folder (the folder follows the project).",
    {
      path: z.string().min(1).optional().describe("Save-as path inside the folder. Omit to save in place."),
      overwrite: z.boolean().optional().default(false).describe("Allow replacing an existing file on save-as.")
    });

  bridgeTool("premiere-get-project-items", "getProjectItems",
    "List project items (read-only): paths, ids, media paths, durations, in/out points.",
    {
      bin: z.string().optional().describe("Bin path to start from, e.g. \"Renders/v003\". Defaults to the root."),
      recursive: z.boolean().optional().default(true).describe("Include nested bins."),
      type: z.enum(["clip", "sequence", "bin"]).optional().describe("Only items of this type.")
    });

  bridgeTool("premiere-import", "importFiles",
    "Import media files into a bin (nested bins are created as needed)." + MUTATING_NOTE,
    {
      files: z.array(z.string().min(1)).min(1).describe("Absolute media paths. Imports may read from anywhere."),
      bin: z.string().optional().describe("Target bin path, e.g. \"Renders/v003\". Defaults to the root."),
      skipExisting: z.boolean().optional().default(true).describe("Skip files already in the project (matched by media path).")
    }, { timeoutMs: LONG_TIMEOUT_MS });

  bridgeTool("premiere-import-ae-comps", "importAEComps",
    "Link After Effects comps into a bin through Dynamic Link (no render needed; the .aep is only read). " +
    "Omit comps to link every comp in the project." + MUTATING_NOTE,
    {
      aepPath: z.string().min(1).describe("Absolute path of the .aep. Reads may come from anywhere."),
      comps: z.array(z.string().min(1)).min(1).optional().describe("Comp names to link. Omit to link all comps."),
      bin: z.string().optional().describe("Target bin path, e.g. \"AE/SH010\". Created as needed; defaults to the root."),
      skipExisting: z.boolean().optional().default(true).describe("Skip comps already linked in that bin (matched by name).")
    }, { timeoutMs: LONG_TIMEOUT_MS });

  bridgeTool("premiere-replace-media", "replaceMedia",
    "Relink a clip to a new media file (e.g. a newer render). Every timeline use updates; in/out points are kept." + MUTATING_NOTE,
    {
      item: ItemRefSchema,
      newFile: z.string().min(1).describe("Absolute path of the new media file."),
      keepTrims: z.boolean().optional().default(true).describe("Keep the item's in/out points."),
      rename: z.string().optional().describe("New project item name.")
    }, { timeoutMs: LONG_TIMEOUT_MS });

  bridgeTool("premiere-create-sequence", "createSequence",
    "Create a sequence, from a .sqpreset or from clips (settings match the first clip)." + MUTATING_NOTE,
    {
      name: z.string().min(1).describe("Sequence name."),
      bin: z.string().optional().describe("Bin path for the sequence."),
      preset: z.string().optional().describe("Absolute path of a .sqpreset."),
      fromClips: z.array(ItemRefSchema).optional().describe("Clips to build the sequence from (createSequenceFromMedia).")
    });

  bridgeTool("premiere-get-sequence", "getSequence",
    "Read a sequence (read-only): settings, tracks, and items with start/end/in/out/speed/enabled/effects/transitions. Paginated with offset/limit. " +
    "Times are reported as { frames, timecode, seconds }.",
    {
      sequence: SequenceRefSchema,
      tracks: z.array(TrackRefSchema).optional().describe("Only these tracks, e.g. [\"V1\", \"A1\"]."),
      offset: z.number().int().min(0).optional().describe("Skip this many items (pagination)."),
      limit: z.number().int().min(1).max(1000).optional().describe("Return at most this many items (1-1000).")
    });

  bridgeTool("premiere-build-sequence", "buildSequence",
    "Place clips end to end on a track, in order. mode \"replace\" clears the track first, \"append\" adds after the last clip. Linked audio comes along unless withAudio is false." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      mode: z.enum(["append", "replace"]),
      track: TrackRefSchema.optional().default("V1"),
      withAudio: z.boolean().optional().default(true).describe("Bring linked audio along."),
      clips: z.array(z.object({
        item: ItemRefSchema,
        in: TimeSchema.optional(),
        out: TimeSchema.optional(),
        gapBefore: TimeSchema.optional()
      })).min(1)
    });

  bridgeTool("premiere-edit-items", "editItems",
    "Edit placed clips: move (to `to` or by `delta`), trim (start/end on the timeline, in/out in the source), slip (`delta`), remove (ripple or lift), enable/disable. " +
    "`ripple` applies to removes only; ripple with a move is refused (BAD_ARGS), because Premiere's UXP move action can't ripple. " +
    "Locate each clip by `index` or by a time `at` on its track." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      edits: z.array(z.object({
        track: TrackRefSchema,
        index: ClipIndexSchema.optional(),
        at: TimeSchema.optional().describe("Locate the clip under this time instead of by index."),
        op: z.enum(["move", "trim", "slip", "remove", "enable", "disable"]),
        to: TimeSchema.optional().describe("move: new start time."),
        delta: TimeSchema.optional().describe("move/slip: signed offset ({ frames } may be negative)."),
        start: TimeSchema.optional().describe("trim: new timeline start."),
        end: TimeSchema.optional().describe("trim: new timeline end."),
        in: TimeSchema.optional().describe("trim: new source in point."),
        out: TimeSchema.optional().describe("trim: new source out point."),
        mediaType: z.enum(["video", "audio", "both"]).optional().describe("Which part of a linked clip to affect (default both).")
      })).min(1),
      ripple: z.boolean().optional().default(false).describe("Ripple removes (close the gaps). Not available for moves: ripple with a move is BAD_ARGS.")
    });

  bridgeTool("premiere-place-audio", "placeAudio",
    "Place an audio clip (music, SFX, VO) on an audio track at a time." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      item: ItemRefSchema,
      track: TrackRefSchema.optional().default("A1"),
      at: TimeSchema,
      in: TimeSchema.optional(),
      out: TimeSchema.optional(),
      mode: z.enum(["overwrite", "insert"]).optional().default("overwrite")
    });

  bridgeTool("premiere-set-audio", "setAudio",
    "Set a clip's volume: level in dB, fades in/out in frames, and/or volume keyframes." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      track: TrackRefSchema,
      index: ClipIndexSchema,
      levelDb: z.number().optional().describe("Clip volume in dB."),
      fades: z.object({
        inFrames: z.number().int().min(0).optional(),
        outFrames: z.number().int().min(0).optional()
      }).optional(),
      keyframes: z.array(z.object({ at: TimeSchema, db: z.number() })).optional()
    });

  bridgeTool("premiere-add-transition", "addTransition",
    "Add a transition at a clip's start, end or both edges. Video tracks go through the MCP Bridge panel (UXP); " +
    "audio tracks (A1, A2...) go through the MCP Bridge sidecar (CEP), which needs the target project to be the active one in Premiere. " +
    "If the sidecar isn't running, audio transitions return NEEDS_SIDECAR_UNAVAILABLE with install steps." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      track: TrackRefSchema,
      index: ClipIndexSchema,
      edge: z.enum(["start", "end", "both"]),
      type: z.string().optional().describe("Transition name as shown in Premiere. Default \"Cross Dissolve\" on video tracks, \"Constant Power\" on audio tracks (audio: Constant Power, Constant Gain, Exponential Fade)."),
      durationFrames: z.number().int().min(1)
    }, {
      route: PREMIERE_TOOL_ROUTES["premiere-add-transition"]
    });

  bridgeTool("premiere-set-speed", "setSpeed",
    "Change a clip's speed (percent), optionally reversed, rippling later clips. Runs in the MCP Bridge sidecar (CEP; UXP has no speed setter), " +
    "which needs the target project to be the active one in Premiere. If the sidecar isn't running it returns NEEDS_SIDECAR_UNAVAILABLE with install steps." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      track: TrackRefSchema,
      index: ClipIndexSchema,
      percent: z.number().positive().describe("Speed in percent, e.g. 50 for half speed."),
      reverse: z.boolean().optional().default(false),
      ripple: z.boolean().optional().default(true),
      maintainPitch: z.boolean().optional().default(true)
    }, { route: PREMIERE_TOOL_ROUTES["premiere-set-speed"] });

  bridgeTool("premiere-link-clips", "link",
    "Link (link: true) or unlink (link: false) clips in a sequence, e.g. unlink a clip's audio from its video to edit them apart. " +
    "Runs in the MCP Bridge sidecar (CEP; UXP can't link or unlink), which needs the target project to be the active one in Premiere; " +
    "it selects exactly these items, links or unlinks them, then restores the user's selection. " +
    "If the sidecar isn't running it returns NEEDS_SIDECAR_UNAVAILABLE with install steps." + MUTATING_NOTE,
    {
      sequence: SequenceRefSchema,
      items: z.array(z.object({ track: TrackRefSchema, index: ClipIndexSchema })).min(1)
        .describe("Clips to link or unlink, by track and index as reported by premiere-get-sequence."),
      link: z.boolean().describe("true links the items, false unlinks them.")
    }, {
      route: PREMIERE_TOOL_ROUTES["premiere-link-clips"]
    });

  bridgeTool("premiere-add-markers", "addMarkers",
    "Add markers in bulk to a sequence or a project item." + MUTATING_NOTE,
    {
      target: z.union([
        z.object({ sequence: SequenceRefSchema }),
        z.object({ item: ItemRefSchema })
      ]),
      markers: z.array(z.object({
        at: TimeSchema,
        duration: TimeSchema.optional(),
        name: z.string(),
        comment: z.string().optional(),
        color: z.union([z.string(), z.number().int()]).optional().describe("Marker color name or index."),
        type: z.string().optional().describe("Marker type, e.g. \"Comment\", \"Chapter\".")
      })).min(1)
    });

  bridgeTool("premiere-export", "exportSequence",
    "Export a sequence with an .epr preset (direct or queued to Media Encoder), or export a single frame ({ frame, format }). " +
    "The output must be inside the sandbox folder (checked before queueing, else OUTSIDE_FOLDER).",
    {
      sequence: SequenceRefSchema,
      preset: z.string().optional().describe("Absolute path of an .epr export preset (not needed for a frame export)."),
      output: z.string().min(1).describe("Output file path inside the sandbox folder."),
      mode: z.enum(["direct", "queue-ame"]).optional().default("direct"),
      range: z.enum(["full", "workarea"]).optional().describe("Default full."),
      frame: TimeSchema.optional().describe("Export just this frame."),
      format: z.string().optional().describe("Frame export format, e.g. \"png\".")
    }, { timeoutMs: LONG_TIMEOUT_MS });

  bridgeTool("premiere-run-script-code", "runScript",
    "Run JavaScript in Premiere Pro through the MCP Bridge panel. " + SCRIPT_DESCRIPTION + PROJECT_GUIDANCE,
    {
      code: z.string().min(1).describe("Async JS function body. Use `return` to hand back a value, e.g. `return project.name;`."),
      name: z.string().optional().describe("Short label for the archived file, undo name and run log (e.g. \"rename-clips\")."),
      waitSeconds: WaitSecondsArg
    }, { waitWhileRunning: true });

  bridgeTool("premiere-run-script-file", "runScriptFile",
    "Run a .js file from the sandbox folder (relative to it or absolute; must be inside it, else OUTSIDE_FOLDER), exactly like premiere-run-script-code. " +
    SCRIPT_DESCRIPTION + PROJECT_GUIDANCE,
    {
      file: z.string().min(1).describe("Path to the .js file, relative to the sandbox folder or absolute (inside the folder)."),
      waitSeconds: WaitSecondsArg
    }, { waitWhileRunning: true });

  register("premiere-get-results",
    "Get the result of the last command sent to Premiere Pro (the MCP Bridge panel or its sidecar, whichever was used last). Use it to poll a premiere-run-script-code / -file that was still running (status \"running\").",
    {},
    async () => {
      try {
        // The panel (pr) and the sidecar (prx) have separate result files: answer for whichever was sent to last.
        return textResult(lastClient.readResults());
      } catch (error) {
        return textResult(`Error getting results: ${String(error)}`, true);
      }
    });

  return { server, tools, bridge, sidecar, projectState };
}

export async function main(): Promise<void> {
  console.error("Premiere Pro MCP Server starting...");
  const { server } = createPremiereServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Premiere Pro MCP Server running...");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  for (const candidate of [entry, `${entry}.js`]) {
    try {
      if (fs.realpathSync(candidate).toLowerCase() === fs.realpathSync(__filename).toLowerCase()) {
        return true;
      }
    } catch {

    }
  }
  return false;
}

if (isMainModule()) {
  main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
