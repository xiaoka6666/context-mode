// OpenClaw plugin entry, in-process (like the OpenCode entry, src/entries/opencode.ts). OpenClaw loads this
// file in the Gateway process through the plugin paradigm `export default { id, name, configSchema,
// register(api) }` (v2.2.0 adapter build/adapters/openclaw/plugin.js). register(api) is called once per
// agent session; every piece of state lives in this closure, none at module level, so a reload leaves
// nothing behind. No console writes: the host owns the terminal.
//
// Every hook builds the raw call-site object the openclaw adapter decodes (src/adapters/openclaw.ts) and
// calls handleHook; this file never opens context.db except through ownJournal for the ctx_* tool rows.
import { z } from "zod/v4";
import { BUNDLE_DIR_ENV, INTERNAL_ERROR_LINE, PLUGIN_ID, SERVER_ENTRY_FILE } from "../core/contracts/constants.ts";
import { CtxError } from "../core/contracts/errors.ts";
import type { HookOutput, ProjectContext, ToolContext, ToolReply } from "../core/contracts/types.ts";
import { handleHook } from "../core/hooks/dispatch.ts";
import { ownJournal } from "../core/journal/own-call.ts";
import { pinOwnBundleDir } from "../core/ops/bundle-dir.ts";
import { recordTurnCommit } from "../core/ops/turn-commit-ledger.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { resolveConfigDir } from "../core/project/config-dir.ts";
import { TOOLS, checkCall } from "../core/tools/registry.ts";
import { INSTRUCTIONS } from "../prompt/_generated.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// OpenClaw supplies this SDK surface at runtime (plugin-module-loader resolves openclaw/plugin-sdk/*
// to its own dist). It performs the real built-in summarization compaction: it reads the session
// transcript, calls the model, and returns { summary, firstKeptEntryId, tokensBefore, tokensAfter }.
// context-mode does not own the compaction algorithm, so it delegates to the runtime (see
// OpenClaw docs: plugins/architecture-internals/context-engines "delegate it explicitly").
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";

const { existsSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs"); // D-CI-PERF-3

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
  /** OpenClaw ContextEngine contract (registry-contract.ts): the factory must return `info` (with non-empty
   *  id + name) and `ingest`/`assemble`/`compact` functions or the host degrades the engine to "legacy"
   *  every turn. context-mode supplies all of them. It does not own the compaction algorithm: `ownsCompaction`
   *  stays false and `compact()` delegates to the runtime (delegateCompactionToRuntime), OpenClaw's documented
   *  path for engines that do not implement the algorithm themselves.
   *  `transcriptSemantics.currentTurnFence` is required for
   *  durable recorder turns (context-engine-logical-turn.ts): without the declaration the host degrades
   *  with "current-turn transcript fencing is not declared" even when the base contract is satisfied.
   *  `transcriptSemantics.turnAdvancementIdempotency` plus `commitTurn` (host-compat.ts) is the second
   *  durable gate: without both, recorder turns degrade with "atomic idempotent turn advancement is not
   *  declared". */
  readonly info: {
    id: string;
    name: string;
    version?: string;
    transcriptSemantics?: {
      currentTurnFence?: "before-current-turn-entry-v1";
      turnAdvancementIdempotency?: "atomic-idempotent-v1";
    };
  };
  ownsCompaction?: boolean;
  /** Delegates to the runtime, which answers with the real result the host applies to the transcript.
   *  `result` is optional: an engine that answers `{ compacted: false }` instead leaves it absent. */
  compact(params?: { sessionId?: string; [k: string]: unknown }): Promise<{
    ok: boolean;
    compacted: boolean;
    result?: {
      summary?: string;
      firstKeptEntryId?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      [k: string]: unknown;
    };
  }>;
  /** Passthrough: context-mode does not store per-message context; the host keeps its own transcript. */
  ingest(params?: { sessionId?: string; [k: string]: unknown }): Promise<{ ingested: boolean }>;
  /** Passthrough: return the supplied messages unchanged; cutting them down stays with the host (ownsCompaction: false). */
  assemble(params?: { messages?: unknown[]; [k: string]: unknown }): Promise<{ messages: unknown[]; estimatedTokens: number }>;
  /** Durable outbox commit (host "atomic-idempotent-v1"): the host retries the same advancement key after
   *  a process or plugin failure; first sight answers "committed", every retry "duplicate". */
  commitTurn?(params?: { advancementKey?: string; [k: string]: unknown }): Promise<{ status: "committed" | "duplicate" }>;
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

    // Pin the doctor's bundle dir for this host (bundle-dir.ts): in the gateway argv[1] is the host's own
    // script, so the argv-based ownBundleDir() falls back to the host's dist and D5 would look for
    // fixtures/hook-roundtrip.json and hook.mjs there (absent: "hook fixture ... is absent"). Two pin
    // sources, in priority order:
    //  1. BUNDLE_DIR_ENV — the host shim sets it when its loader rewrites import.meta.url (the OpenClaw
    //     gateway loads extensions/context-mode/index.ts, whose re-exported entry no longer "sits next to"
    //     server.mjs from the loader's point of view). Validated: the dir must hold SERVER_ENTRY_FILE.
    //  2. the nearest ancestor of this module's own file that holds server.mjs (release-out/ in the stock
    //     layout; a dev tree pins nothing and keeps the argv-based behavior).
    const envPin = env[BUNDLE_DIR_ENV];
    if (typeof envPin === "string" && envPin !== "" && existsSync(join(envPin, SERVER_ENTRY_FILE))) {
      pinOwnBundleDir(envPin);
    } else {
      let dir = dirname(fileURLToPath(import.meta.url));
      for (;;) {
        if (existsSync(join(dir, SERVER_ENTRY_FILE))) {
          pinOwnBundleDir(dir);
          break;
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }

    let sessionId = ""; // the host session id, assigned at session_start (v2.2.0: e.sessionId)
    let turn = 0; // counted by user prompts; step-finish and the tool calls read it (D-M5-P2-2)
    let project: ProjectContext | undefined;
    let payloadPromise: Promise<string> | undefined;
    let promptHint = ""; // the last UserPromptSubmit hook stdout (the pending-compact summary, when one is due)
    const journal = ownJournal(); // D-HF-INPROC-JOURNAL-1
    let commitChain: Promise<{ status: "committed" | "duplicate" }> | undefined; // serializes concurrent commitTurn calls
    let commitDataRoot: string | undefined; // memoized resolveConfigDir(env) (one mkdir + realpath)

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
    // so the host asks the right component and gets a no-op compact. OpenClaw's registry contract additionally
    // requires `info` (id + name) and `ingest`/`assemble` functions; without them the host degrades the engine
    // to "legacy" on every logical turn ("missing info, missing ingest(), missing assemble()"). context-mode
    // supplies them as passthroughs: it stores no per-message context and does not rewrite the message window.
    api.registerContextEngine?.(PLUGIN_ID, () => ({
      info: {
        id: PLUGIN_ID,
        name: "Context Mode",
        // No `version`: there is no version constant in the contracts yet (the same deviation is noted at
        // src/entries/server.ts, where SERVER_KEY carries "dev"). A hardcoded literal here already drifted
        // once — it read "2.2.1" while package.json and the plugin manifests said "2.2.2" — and would drift
        // again on every release. `info.version` is optional in the host contract (only id + name are
        // required), and a stale version is worse than no version, so the field stays out until a constant
        // exists.
        // Durable recorder turns (OpenClaw's default session handling) only admit a context engine that
        // declares the current-turn fence; without it the host degrades to legacy every turn
        // ("current-turn transcript fencing is not declared"). Our assemble is a no-op passthrough, so
        // the fence declaration is safe: the host performs the actual transcript fencing itself.
        // turnAdvancementIdempotency + commitTurn is the second durable gate (host-compat.ts): without
        // both the host degrades recorder turns with "atomic idempotent turn advancement is not declared".
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ownsCompaction: false,
      async compact(params) {
        // Delegate to OpenClaw's built-in summarization compaction instead of a no-op. This is
        // the documented path for engines that do not own the compaction algorithm (see OpenClaw
        // docs: plugins/architecture-internals/context-engines). It returns the real
        // { ok, compacted, result: { summary, firstKeptEntryId, tokensBefore, tokensAfter } },
        // so /compact stops reporting "nothing to compact" and actually frees context.
        return await delegateCompactionToRuntime(params);
      },
      async ingest() {
        // context-mode keeps large tool output out of the conversation via its hooks; it does not store
        // the host's per-message transcript, so every host ingest is a no-op.
        return { ingested: false };
      },
      async assemble(params) {
        // Pass the host's message window through unchanged; truncation remains the host's responsibility
        // (ownsCompaction: false). estimatedTokens is a hint only and does not drive host admission.
        const messages = Array.isArray(params?.messages) ? params.messages : [];
        return { messages, estimatedTokens: 0 };
      },
      commitTurn(params) {
        // Durable outbox contract (OpenClaw src/context-engine/host-compat.ts:18 + the turn outbox): a
        // recorder-backed turn retries the SAME advancement key after a process or plugin failure, so
        // commitTurn must acknowledge idempotently — "committed" on first sight, "duplicate" on retry.
        // context-mode journals each hook as it happens (nothing is pending at commit time), so the
        // commit is the ledger record itself, kept under the data root.
        const key = typeof params?.advancementKey === "string" ? params.advancementKey : "";
        if (key === "") {
          // The host always sends the outbox row's key; an empty one is a host bug. Acknowledge without
          // recording instead of throwing: a thrown error re-queues the outbox row and retries forever.
          return Promise.resolve({ status: "committed" as const });
        }
        commitDataRoot ??= resolveConfigDir(env);
        const root = commitDataRoot;
        commitChain = (commitChain ?? Promise.resolve()).then(() => ({ status: recordTurnCommit(root, key) }));
        return commitChain;
      },
    }));
  },
};
