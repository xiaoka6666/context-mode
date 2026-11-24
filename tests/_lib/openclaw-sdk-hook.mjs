// tests/_lib/openclaw-sdk-hook.mjs — resolve hook redirecting `openclaw/plugin-sdk/*` to the stub.
//
// Registered from openclaw-sdk-register.mjs, which `scripts/gate.mjs` loads with --import. That ordering
// matters: ESM instantiates (resolves the whole graph of) a module before any of it evaluates, so a
// register() call inside a test file would run too late for that test's own imports. --import runs before
// the test files load, so the hook is in place for the entire graph.
//
// Only `openclaw/plugin-sdk/*` is touched; every other specifier passes through unchanged.
import { fileURLToPath, pathToFileURL } from "node:url";

const STUB_URL = pathToFileURL(fileURLToPath(new URL("./openclaw-sdk-stub.mjs", import.meta.url))).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("openclaw/plugin-sdk/")) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}