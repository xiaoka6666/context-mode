// OpenClaw in-process adapter, mirroring opencode.ts (ADR-0001 §3): the plugin entry (src/entries/openclaw.ts)
// loads inside the OpenClaw Gateway process and calls handleHook with a raw object whose `type` is the hook
// call-site name, plus the event fields. decode/encode keep handleHook on one code path for every agent.
// OpenClaw registers the ctx_* tools under their bare names (TOOL_NAME_PREFIX is empty, as on Pi).
import type { AuxEventName, CanonicalEventName, CanonicalHookEvent, Decision, HookOutput, ToolResultInfo } from "../core/contracts/types.ts";

export const TOOL_NAME_PREFIX = ""; // OpenClaw calls the ctx_* tools bare; the row prefix is "" (impl/10 §1.3, Pi form)

// Call-site name -> canonical event. Usage = the step-finish cost row (as on OpenCode, D-M5-arch-2): the entry
// fires it from the host's per-turn usage event when the diagnostic bus is available.
const OPENCLAW_EVENTS: Readonly<Record<string, CanonicalEventName | AuxEventName>> = {
  context: "SessionStart",
  prompt: "UserPromptSubmit",
  "execute.before": "PreToolUse",
  "execute.after": "PostToolUse",
  compaction: "PreCompact",
  "step-finish": "Usage",
};

// OpenClaw native tool name -> canonical name, starting-point mapping (names not listed stay as received).
// exec is OpenClaw's shell tool (args.command, like Claude Code Bash); read takes `path` (in READ_PATH_KEYS);
// web_fetch takes `url`; write/edit/apply_patch journal as an edit (EDIT_TOOLS via the canonical names).
export const EXEC_TOOL_NAME = "exec";
export const READ_TOOL_NAME = "read";
export const WEBFETCH_TOOL_NAME = "web_fetch";
export const EDIT_TOOL_NAMES: readonly string[] = Object.freeze(["write", "edit", "apply_patch"]);
const NATIVE_TO_CANONICAL: Readonly<Record<string, string>> = Object.freeze({
  [EXEC_TOOL_NAME]: "Bash",
  [READ_TOOL_NAME]: "Read",
  [WEBFETCH_TOOL_NAME]: "WebFetch",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
});

export function toCanonicalTool(name: string): string {
  return Object.prototype.hasOwnProperty.call(NATIVE_TO_CANONICAL, name) ? NATIVE_TO_CANONICAL[name] : name;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// The entry passes the result text as `output` (the host's `result`, else its older `output` field) and the
// failure flag as `isError` (the host's `error` string folded into it).
function readResult(p: Record<string, unknown>): ToolResultInfo {
  const text = p.output === undefined ? "" : typeof p.output === "string" ? p.output : JSON.stringify(p.output);
  const info: ToolResultInfo = { isError: p.isError === true, bytes: Buffer.byteLength(text), text };
  if (typeof p.exitCode === "number") info.exitCode = p.exitCode;
  return info;
}

// sessionId and directory come from the entry's per-session closure: the OpenClaw session id (session_start
// event) and process.cwd() at plugin load, like the OpenCode `directory` (impl/10 §11 cwd row).
export function decode(raw: unknown): CanonicalHookEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("openclaw: hook payload is not an object");
  const p = raw as Record<string, unknown>;
  const native = typeof p.type === "string" ? p.type : "";
  const event = Object.prototype.hasOwnProperty.call(OPENCLAW_EVENTS, native) ? OPENCLAW_EVENTS[native] : undefined;
  if (event === undefined) throw new Error("openclaw: unknown hook event " + String(p.type));
  const ev: CanonicalHookEvent = { event, agent: "openclaw", sessionId: String(p.sessionId ?? ""), cwd: String(p.directory ?? "") };
  if (event === "UserPromptSubmit" && typeof p.message === "string") ev.prompt = p.message;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const name = String(p.tool ?? "");
    ev.tool = { name, canonicalName: toCanonicalTool(name), input: record(p.args) };
    if (typeof p.callID === "string") ev.tool.callId = p.callID;
  }
  if (event === "PostToolUse") ev.result = readResult(p);
  if (typeof p.turn === "number") ev.turn = p.turn;
  return ev;
}

// hint: SessionStart and UserPromptSubmit carry text. Unlike opencode (whose host has no prompt-attach channel,
// so prompt hints are dropped), OpenClaw's before_prompt_build injects both into the system prompt, so the
// pending-compact summary delivered on the next UserPromptSubmit reaches the model (row compactDelivery
// "pending-flag"). deny: only `execute.before` can fail; rewrite first, exit 2. replace: the entry writes the
// stdout back into the host's result object (execute.after), as on OpenCode (D-R54-OC-REPLACE-1). Never throws
// (shared encode step 3).
export function encode(ev: CanonicalHookEvent, d: Decision, _extra?: string): HookOutput {
  switch (d.kind) {
    case "allow":
      return { stdout: "", exitCode: 0 };
    case "hint":
      return { stdout: ev.event === "SessionStart" || ev.event === "UserPromptSubmit" ? d.text : "", exitCode: 0 };
    case "deny":
      if (ev.event !== "PreToolUse") return { stdout: "", exitCode: 0 };
      return { stdout: d.rewritten === undefined ? d.reason : d.rewritten + "\n" + d.reason, exitCode: 2 };
    case "replace":
      return { stdout: ev.event === "PostToolUse" ? d.output : "", exitCode: 0 };
  }
}
