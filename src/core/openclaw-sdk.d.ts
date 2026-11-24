// Ambient type declarations for OpenClaw-supplied SDK imports.
//
// context-mode is a standalone package; `openclaw/plugin-sdk/*` is supplied by the OpenClaw
// runtime (the plugin module loader resolves it to OpenClaw's own dist). esbuild marks it
// external, so no runtime resolution happens here. tsc needs a local declaration to pass
// typecheck without a dependency on the OpenClaw source tree.
//
// Only the surface context-mode actually uses is declared here. Keep it narrow.

declare module "openclaw/plugin-sdk/core" {
  /** Compact params the host passes to a context engine's compact(). */
  export interface ContextEngineCompactParams {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    sessionTarget?: Record<string, unknown>;
    tokenBudget?: number;
    currentTokenCount?: number;
    force?: boolean;
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
    runtimeSettings?: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }

  /** Result of a context-engine compaction pass. */
  export interface ContextEngineCompactResult {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      summary?: string;
      firstKeptEntryId?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      details?: Record<string, unknown>;
      sessionId?: string;
      sessionTarget?: Record<string, unknown>;
    };
  }

  /**
   * Delegate compaction to OpenClaw's built-in summarization runtime. Reads the session
   * transcript, calls the model, and returns a real summary + firstKeptEntryId. This is the
   * documented path for engines that do not own the compaction algorithm.
   */
  export function delegateCompactionToRuntime(
    params: ContextEngineCompactParams | Record<string, unknown> | undefined,
  ): Promise<ContextEngineCompactResult>;
}
