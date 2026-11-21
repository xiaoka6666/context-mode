// tests/0024-openclaw-turn-commit.test.mjs
// Area: OpenClaw durable outbox contract (gateway src/context-engine/host-compat.ts "atomic-idempotent-v1"):
// commitTurn must acknowledge idempotently — "committed" on first sight of an advancement key,
// "duplicate" on every retry (both complete the outbox row; any other status re-queues it).
// Also: the in-process entry pins the doctor's bundle dir from its own module location (bundle-dir.ts),
// so D5 finds the release fixtures instead of the host's dist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { recordTurnCommit, TURN_COMMIT_LEDGER_FILE, MAX_LEDGER_KEYS } from "../src/core/ops/turn-commit-ledger.ts";
import { ownBundleDir, pinOwnBundleDir, bundleDirOf } from "../src/core/ops/bundle-dir.ts";

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "cm-turn-commit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("recordTurnCommit: first sight committed, retry duplicate", (t) => {
  const dir = scratchDir(t);
  assert.equal(recordTurnCommit(dir, "adv-1"), "committed");
  assert.equal(recordTurnCommit(dir, "adv-1"), "duplicate");
  assert.equal(recordTurnCommit(dir, "adv-1"), "duplicate");
  // a different key commits independently
  assert.equal(recordTurnCommit(dir, "adv-2"), "committed");
  const ledger = JSON.parse(readFileSync(join(dir, TURN_COMMIT_LEDGER_FILE), "utf8"));
  assert.ok(Object.hasOwn(ledger, "adv-1") && Object.hasOwn(ledger, "adv-2"));
  assert.equal(typeof ledger["adv-1"].committedAt, "string");
});

test("recordTurnCommit: a corrupt ledger file degrades to a clean one (at worst one re-commit)", (t) => {
  const dir = scratchDir(t);
  assert.equal(recordTurnCommit(dir, "adv-1"), "committed");
  writeFileSync(join(dir, TURN_COMMIT_LEDGER_FILE), "{ not json");
  assert.equal(recordTurnCommit(dir, "adv-1"), "committed"); // the lost record costs exactly one re-commit
  assert.equal(recordTurnCommit(dir, "adv-1"), "duplicate");
});

test("recordTurnCommit: the map is pruned to the newest MAX_LEDGER_KEYS", (t) => {
  const dir = scratchDir(t);
  // seed MAX_LEDGER_KEYS + 1 entries, oldest first
  const file = join(dir, TURN_COMMIT_LEDGER_FILE);
  const seeded = {};
  for (let i = 0; i <= MAX_LEDGER_KEYS; i++) seeded[`key-${i}`] = { committedAt: new Date(0).toISOString() };
  writeFileSync(file, JSON.stringify(seeded));
  assert.equal(recordTurnCommit(dir, "newest"), "committed");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(Object.keys(ledger).length, MAX_LEDGER_KEYS);
  assert.ok(!Object.hasOwn(ledger, "key-0")); // the oldest insertion was pruned
  assert.ok(Object.hasOwn(ledger, "newest"));
});

test("ownBundleDir: a pin set by the in-process entry wins over the argv-based fallback", () => {
  const before = ownBundleDir();
  pinOwnBundleDir("/some/bundle/root");
  assert.equal(ownBundleDir(), "/some/bundle/root");
  pinOwnBundleDir(before); // restore the host-derived answer for the rest of the process
  assert.equal(ownBundleDir(), before);
});

test("bundleDirOf: an argv dir without server.mjs falls back to the module walk-up", () => {
  const self = fileURLToPath(import.meta.url); // tests/ dir, no server.mjs above the repo root
  assert.equal(bundleDirOf("/nonexistent/host/dist/index.js", self), "/nonexistent/host/dist");
});
