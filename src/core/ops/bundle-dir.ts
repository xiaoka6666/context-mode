// D-OC2-BUNDLE-DIR-1 (#1306): the dir of the running context-mode bundle (server.mjs, hook.mjs, package.json sit there).
// The server and hook run as `node <bundle>/server.mjs`, so process.argv[1] names the bundle. An in-process plugin
// (OpenCode, Pi) runs inside the host: argv[1] is the host's own script, under the Bun-compiled OpenCode binary
// "B:/~BUN/root/...". There the module's own file (<pkg>/opencode/plugin.js, loaded from OpenCode's npm cache) names it.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_ENTRY_FILE } from "../contracts/constants.ts";

/** The bundle dir: argv[1]'s dir when it holds server.mjs, else the nearest dir above `moduleFile` that holds it,
 *  else argv[1]'s dir (the dev tree, where no server.mjs is built). */
export function bundleDirOf(argv1: string, moduleFile: string): string {
  const own = dirname(argv1);
  if (existsSync(join(own, SERVER_ENTRY_FILE))) return own;
  let dir = dirname(moduleFile);
  for (;;) {
    if (existsSync(join(dir, SERVER_ENTRY_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return own;
    dir = up;
  }
}

let memo: { argv1: string; dir: string } | undefined;
let pinnedDir: string | undefined;

/** Pin the bundle dir for the running host. An in-process plugin host (OpenClaw's gateway) starts with
 *  argv[1] set to the host's own script, and the plugin shim that loads this bundle is not an ancestor
 *  of it, so bundleDirOf's walk-up falls back to the host's dist dir: doctor's D5 then looks for
 *  fixtures/hook-roundtrip.json and hook.mjs in the host's dist and reports the fixture absent. The
 *  entry module pins the nearest ancestor of its OWN file that holds SERVER_ENTRY_FILE (the release
 *  bundle root). A no-op for hosts that already resolve their dir from argv[1]. */
export function pinOwnBundleDir(dir: string): void {
  pinnedDir = dir;
}

/** bundleDirOf for this process, kept per argv[1] (tests set argv[1] to a fake bundle). */
export function ownBundleDir(): string {
  if (pinnedDir !== undefined) return pinnedDir;
  const argv1 = process.argv[1] ?? "";
  if (memo?.argv1 !== argv1) memo = { argv1, dir: bundleDirOf(argv1, fileURLToPath(import.meta.url)) };
  return memo.dir;
}
