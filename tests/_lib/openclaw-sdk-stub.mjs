// tests/_lib/openclaw-sdk-stub.mjs — test-only stand-in for `openclaw/plugin-sdk/core`.
//
// The real module resolves only inside the OpenClaw gateway: its plugin module loader aliases
// `openclaw/plugin-sdk/*` to its own dist (sdk-alias, createPluginSdkScopedAliases). Outside the host the
// specifier is unresolvable, so a source-level test that imports a host-dependent entry fails at load time
// with ERR_MODULE_NOT_FOUND before any assertion runs. Loaded through openclaw-sdk-hook.mjs.
//
// It throws if actually invoked rather than answering: a test that reaches compact() should fail loudly, not
// pass against a fabricated { ok, compacted } answer. The gateway never loads this file (the alias shadows
// the specifier there), so production behavior is unaffected.
export const delegateCompactionToRuntime = async () => {
  throw new Error(
    "openclaw-sdk-stub: delegateCompactionToRuntime is not callable outside the OpenClaw gateway",
  );
};