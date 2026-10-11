export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface FormatOptions {
  // App label used in the STALE note ("After Effects", "Premiere Pro").
  appLabel: string;
  // Returns a note for a project-gate refusal, or undefined when the refusal isn't a gate refusal.
  gateNote?: (parsed: any) => string | undefined;
}

export function textResult(text: string, isError = false): ToolTextResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {})
  };
}

// Turns a raw bridge result into a tool result: marks errors, explains gate refusals and STALE.
export function formatBridgeResult(result: string, options: FormatOptions): ToolTextResult {
  let note = "";
  let isError = false;
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      if (parsed.status === "error" || parsed.error) {
        isError = true;
      }
      const gate = parsed.refused && options.gateNote ? options.gateNote(parsed) : undefined;
      if (gate !== undefined) {
        note = gate;
      } else if (parsed.code === "STALE") {
        isError = true;
        note = "\n\nThe panel skipped this command because it was more than 120 s old by the time it was read " +
          `(${options.appLabel} was busy or the panel was closed). Nothing ran; call the tool again if it is still wanted.`;
      }
    }
  } catch {

  }
  return {
    content: [
      {
        type: "text",
        text: result + note
      }
    ],
    ...(isError ? { isError: true } : {})
  };
}
