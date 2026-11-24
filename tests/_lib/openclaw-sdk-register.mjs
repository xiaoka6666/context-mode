// tests/_lib/openclaw-sdk-register.mjs — the `--import` target for the unit-test layer of the gate.
//
// Called by scripts/gate.mjs so that `openclaw/plugin-sdk/*` resolves to tests/_lib/openclaw-sdk-stub.mjs
// before the test graph is instantiated. See openclaw-sdk-hook.mjs for why the registration has to happen
// here rather than inside a test file.
import { register } from "node:module";

register(new URL("./openclaw-sdk-hook.mjs", import.meta.url));