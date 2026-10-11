// Bridge client for the Premiere end-to-end harness (and its dry run): writes pr_command.json (or the sidecar's
// prx_command.json) atomically, exactly as the MCP server does, and polls pr_mcp_result.json for the result whose
// _commandId matches. Contract: docs/bridge-protocol.md, docs/premiere-bridge-spec.md section 4.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Same resolution as the server and the panel. Read at call time, so a test can point it at a temp dir. */
export function bridgeDirFromEnv() {
  return process.env.AE_MCP_BRIDGE_DIR || path.join(os.homedir(), "ae-mcp-bridge");
}

export const fmt = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 1500 ? s.slice(0, 1500) + "...(truncated)" : s;
};

export function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null; // missing, mid-rename or half-written: poll again
  }
}

// tmp + rename so the panel never reads a half-written command. The retry waits asynchronously: the panel may
// hold the file for a moment, and in the dry run it lives in this very process.
async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 80 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      await sleep(25);
    }
  }
}

// Pure ASCII, like the server: non-ASCII becomes \uXXXX.
const toAsciiJson = (v) => JSON.stringify(v, null, 2).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

let idSeq = 0;
const newId = () => `${Date.now()}-pre2e${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * createPrClient({ bridgeDir, prefix = "pr", guard, onSend, pollMs, timeoutMs })
 *   guard(cmd)  called before anything is written; throw to refuse the command (the harness's safety check).
 *   onSend(cmd) called after the command file is written (the dry run records every command).
 */
export function createPrClient(opts = {}) {
  const bridgeDir = opts.bridgeDir || bridgeDirFromEnv();
  const prefix = opts.prefix || "pr";
  const pollMs = opts.pollMs || 50;
  const defaultTimeoutMs = opts.timeoutMs || 60000;
  const files = {
    command: path.join(bridgeDir, `${prefix}_command.json`),
    result: path.join(bridgeDir, `${prefix}_mcp_result.json`),
  };

  /**
   * Writes the command file and returns its id. expectedProject: a string is sent as is; omitExpected: true
   * leaves the field out. timestamp overrides the ISO time (for the STALE test). Resolves to the id.
   */
  async function writeCommand(command, args = {}, { expectedProject, omitExpected = false, timestamp } = {}) {
    const cmd = { id: newId(), command, args, timestamp: timestamp || new Date().toISOString(), status: "pending" };
    if (!omitExpected && expectedProject !== undefined) cmd.expectedProject = expectedProject;
    if (opts.guard) opts.guard(cmd);
    fs.mkdirSync(bridgeDir, { recursive: true });
    await atomicWrite(files.command, toAsciiJson(cmd));
    if (opts.onSend) opts.onSend(JSON.parse(JSON.stringify(cmd)));
    return cmd.id;
  }

  /** Polls for the result with _commandId === id, waiting past "running". Returns { result, statuses }. */
  async function waitForResult(id, { timeoutMs = defaultTimeoutMs } = {}) {
    const end = Date.now() + timeoutMs;
    const statuses = [];
    let lastKey = null;
    let lastSeen = null;
    for (;;) {
      const r = readJson(files.result);
      if (r) lastSeen = r;
      if (r && r._commandId === id) {
        const key = `${r.status}|${r._responseTimestamp}`;
        if (key !== lastKey) {
          statuses.push(r.status);
          lastKey = key;
        }
        if (r.status !== "running") return { result: r, statuses };
      }
      if (Date.now() > end) {
        const err = new Error(
          `No final result for command ${id} after ${timeoutMs} ms (states seen: ${fmt(statuses)}).\n` +
            `  command file now: ${fmt(readJson(files.command))}\n  result file now: ${fmt(lastSeen)}`,
        );
        err.code = "BRIDGE_TIMEOUT";
        throw err;
      }
      await sleep(pollMs);
    }
  }

  // The panel writes the result first and only then rewrites the command file's status (read, then write).
  // A command written in that gap would be overwritten by the old one, so wait (briefly) for the previous
  // command to be marked completed/error before writing the next. Race tests use writeCommand directly.
  async function send(command, args = {}, sendOpts = {}) {
    await waitForIdle(sendOpts.idleWaitMs === undefined ? 3000 : sendOpts.idleWaitMs);
    const id = await writeCommand(command, args, sendOpts);
    const { result, statuses } = await waitForResult(id, sendOpts);
    return Object.assign(result, { _statusesSeen: statuses, _sentId: id });
  }

  /** Waits until the command file holds no pending/running command. Returns false on timeout. */
  async function waitForIdle(timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const c = readJson(files.command);
      if (!c || (c.status !== "pending" && c.status !== "running")) return true;
      if (Date.now() > end) return false;
      await sleep(pollMs);
    }
  }

  return {
    bridgeDir,
    prefix,
    files,
    writeCommand,
    waitForResult,
    send,
    waitForIdle,
    readCommand: () => readJson(files.command),
    readResult: () => readJson(files.result),
  };
}
