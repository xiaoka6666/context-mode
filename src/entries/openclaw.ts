// OpenClaw plugin entry, in-process (like the OpenCode entry, src/entries/opencode.ts). OpenClaw loads this
// file in the Gateway process through the plugin paradigm `export default { id, name, configSchema,
// register(api) }` (v2.2.0 adapter build/adapters/openclaw/plugin.js). register(api) is called once per
// agent session; every piece of state lives in this closure, none at module level, so a reload leaves
// nothing behind. No console writes: the host owns the terminal.
//
// Every hook builds the raw call-site object the openclaw adapter decodes (src/adapters/openclaw.ts) and
// calls handleHook; this file never opens context.db except through ownJournal for the ctx_* tool rows.
import { z } from "zod/v4";
import { INTERNAL_ERROR_LINE, PLUGIN_ID } from "../core/contracts/constants.ts";
import { CtxError } from "../core/contracts/errors.ts";
import type { HookOutput, ProjectContext, ToolContext, ToolReply } from "../core/contracts/types.ts";
import { handleHook } from "../core/hooks/dispatch.ts";
import { ownJournal } from "../core/journal/own-call.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { TOOLS, checkCall } from "../core/tools/registry.ts";
import { INSTRUCTIONS } from "../prompt/_generated.ts";

const AGENT = "openclaw" as const; // AgentId, joins the list in contracts/agents.ts

// System-generated wrappers the host may feed to before_model_resolve; a prompt row for one would be noise.
// Mirrors the v2.2.0 OpenClaw adapter (build/adapters/openclaw/plugin.js).
const SYSTEM_REMINDER_PREFIXES = Object.freeze([
  "<system-reminder>",
  "<task-notification>",
  "<context_guidance>",
  "<tool-result>",
]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// The OpenClaw event fields this entry reads. before/after_tool_call carry toolName, params and the result
// (v2+ `result`, older builds `output`) plus the failure flag (`error` string or `isError` boolean, v2.2.0
// accepted both); session_start carries the host session id.
export interface OpenClawEvent {
  toolName?: string;
  toolCallId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  error?: unknown;
  isError?: boolean;
  durationMs?: number;
  sessionId?: string;
  sessionKey?: string;
  resumedFrom?: string;
  userMessage?: string;
  message?: string;
  content?: string;
}

// MCP-style tool result the host reads back from a registered tool.
export interface OpenClawToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface OpenClawToolDef {
  name: string;
  description: string;
  /** JSON Schema (TypeBox-compatible) of the tool input. */
  parameters: unknown;
  execute(toolCallId: string, params: unknown): Promise<OpenClawToolResult>;
}

export interface OpenClawContextEngine {
  ownsCompaction: boolean;
  compact(): Promise<{ ok: boolean; compacted: boolean }>;
}

/** The OpenClaw plugin API surface this entry uses. register() is synchronous (the host calls it once per
 *  session, v2.2.0); async work runs in the hook closures. */
export interface OpenClawApi {
  on(event: string, handler: (e: OpenClawEvent) => unknown, opts?: { priority?: number }): void;
  registerHook?(event: string, handler: (e: OpenClawEvent) => unknown, meta?: { name?: string; description?: string }): void;
  registerTool?(def: OpenClawToolDef): void;
  registerContextEngine?(id: string, factory: () => OpenClawContextEngine): void;
  /** Per-turn usage bus (v2.2.0: openclaw/plugin-sdk/diagnostic-runtime `model.usage`); absent hosts stay inert. */
  onDiagnosticEvent?(cb: (evt: { type?: string }) => void): void;
}

export default {
  id: PLUGIN_ID,
  name: "Context Mode",
  configSchema: {
    type: "object",
    properties: { enabled: { type: "boolean", default: true, description: "Enable or disable the context-mode plugin." } },
    additionalProperties: false,
  },
  register(api: OpenClawApi): void {
    const cwd = process.cwd(); // the project dir: the Gateway session cwd at plugin load (row projectSource spawn-cwd)
    const env = process.env;
    let sessionId = ""; // the host session id, assigned at session_start (v2.2.0: e.sessionId)
    let turn = 0; // counted by user prompts; step-finish and the tool calls read it (D-M5-P2-2)
    let project: ProjectContext | undefined;
    let payloadPromise: Promise<string> | undefined;
    let promptHint = ""; // the last UserPromptSubmit hook stdout (the pending-compact summary, when one is due)
    const journal = ownJournal(); // D-HF-INPROC-JOURNAL-1

    const call = (raw: Record<string, unknown>): Promise<HookOutput> =>
      handleHook(AGENT, { ...raw, sessionId, directory: cwd }, env);

    function projectOf(): ProjectContext {
      project ??= resolveProject(AGENT, { env, argv: process.argv, cwd });
      return project;
    }

    // The one system payload of this session: the SessionStart text handleHook returns, then INSTRUCTIONS,
    // joined once and never recomputed (Q12, as on the OpenCode entry).
    function payloadFor(): Promise<string> {
      payloadPromise ??= call({ type: "context", turn })
        .then((out) => [out.stdout, INSTRUCTIONS].filter((s) => s !== "").join("\n\n"));
      return payloadPromise;
    }

    // 1. Tools: every ctx_* tool registers through the host tool API; the handler is the same TOOLS entry the
    // MCP server calls (impl/12 §1). The schema is the zod type as JSON Schema (TypeBox-compatible object).
    for (const tool of TOOLS) {
      api.registerTool?.({
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.schema as z.ZodType, { target: "draft-2020-12", io: "input" }),
        async execute(_toolCallId, params) {
          const checked = checkCall(tool, params);
          if (!checked.ok) return { content: [{ type: "text", text: checked.line }], isError: true };
          const ctx: ToolContext = {
            get project(): ProjectContext {
              return projectOf();
            },
            sessionId,
            turn,
            signal: new AbortController().signal,
            protocolVersion: "",
          };
          let reply: ToolReply;
          try {
            reply = await tool.handler(checked.data, ctx);
          } catch (err) {
            return { content: [{ type: "text", text: err instanceof CtxError ? err.toLine() : INTERNAL_ERROR_LINE }], isError: true };
          }
          // D-HF-INPROC-JOURNAL-1: the row the MCP server writes; an unresolved project has no DB, so no row.
          if (project !== undefined) await journal(project, ctx, tool.name, reply);
          return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
        },
      });
    }

    // 2. before_tool_call: PreToolUse. exit 2 is a deny: the host blocks the call with the reason (v2.2.0 shape).
    api.on("before_tool_call", async (e) => {
      const out = await call({ type: "execute.before", tool: str(e.toolName), args: e.params ?? {}, callID: str(e.toolCallId), turn });
      if (out.exitCode === 2) return { block: true, blockReason: out.stdout };
      return undefined;
    });

    // 3. after_tool_call: PostToolUse. A replace comes back as stdout and is written into the host's result
    // object in-process (the host reads `result` on v2+ and `output` on older builds; both get the text).
    api.on("after_tool_call", async (e) => {
      const rawResult = e.result !== undefined ? e.result : e.output;
      const out = await call({
        type: "execute.after", tool: str(e.toolName), args: e.params ?? {}, output: rawResult,
        isError: e.error !== undefined || e.isError === true, callID: str(e.toolCallId), turn,
      });
      if (out.stdout !== "") return { result: out.stdout, output: out.stdout };
      return undefined;
    });

    // 4. session_start: assign the host session id and fire SessionStart (the payload memo starts here; a host
    // that skips session_start computes it lazily at the first before_prompt_build).
    api.on("session_start", async (e) => {
      if (typeof e.sessionId === "string" && e.sessionId !== "") sessionId = e.sessionId;
      await payloadFor();
    });

    // 5. command:new and command:reset are SessionStart too (a new or reset session re-delivers the resume
    // hint); command:stop has no v2.2.1 canonical event on this row, so it is a no-op.
    api.registerHook?.("command:new", () => payloadFor(), { name: "context-mode.session-new", description: "Session start: the context-mode SessionStart hook" });
    api.registerHook?.("command:reset", () => payloadFor(), { name: "context-mode.session-reset", description: "Session reset: the context-mode SessionStart hook" });
    api.registerHook?.("command:stop", () => undefined, { name: "context-mode.session-stop", description: "No-op: this row has no Stop hook; the pending-compact flag is consumed on the next prompt" });

    // 6. before_model_resolve: the user message capture (UserPromptSubmit). The prompt row belongs to the turn
    // it starts; system-generated wrappers stay out (v2.2.0 filter). The hook stdout (the pending-compact
    // summary, when one is due) is held for the prompt build of this turn.
    api.on("before_model_resolve", async (e) => {
      const message = str(e.userMessage ?? e.message ?? e.content);
      if (message === "") return;
      const trimmed = message.trimStart();
      if (SYSTEM_REMINDER_PREFIXES.some((p) => trimmed.startsWith(p))) return;
      turn += 1;
      promptHint = (await call({ type: "prompt", message, turn })).stdout;
    });

    // 7. before_prompt_build: inject the system payload (SessionStart text + INSTRUCTIONS, memoized) and this
    // turn's prompt hint into the system prompt. Priority 5, after the host's resume-style injections (v2.2.0
    // used 10 for the snapshot, 5 for the routing block; this row keeps one handler).
    api.on("before_prompt_build", async () => {
      const text = [await payloadFor(), promptHint].filter((s) => s !== "").join("\n\n");
      if (text === "") return undefined;
      return { appendSystemContext: text };
    }, { priority: 5 });

    // 8. Compaction: PreCompact sets the pending-compact marker; after_compaction repeats the same call, which
    // is idempotent (the flag is one meta value). The summary itself goes out on the next UserPromptSubmit.
    api.on("before_compaction", () => call({ type: "compaction", turn }));
    api.on("after_compaction", () => call({ type: "compaction", turn }));

    // 9. step-finish is the Usage event (D-M5-arch-2), one cost row per (session, turn). It comes from the
    // host's per-turn usage diagnostic; hosts without the bus keep the row off (inert, not a failure).
    if (typeof api.onDiagnosticEvent === "function") {
      api.onDiagnosticEvent((evt) => {
        if (evt?.type !== "model.usage") return;
        void call({ type: "step-finish", turn });
      });
    }

    // 10. Context engine: context-mode does not own compaction (the host truncates); the engine is registered
    // so the host asks the right component and gets a no-op compact.
    api.registerContextEngine?.(PLUGIN_ID, () => ({
      ownsCompaction: false,
      async compact() {
        return { ok: true, compacted: false };
      },
    }));
  },
};
