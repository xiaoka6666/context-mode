// OpenClaw's durable outbox (gateway src/agents/harness/context-engine-turn-outbox.ts) re-runs the
// context engine's commitTurn with the SAME advancement key after a process or plugin failure, so the
// engine must acknowledge idempotently: "committed" for the first record of a key, "duplicate" for
// every retry (both statuses complete the outbox row; any other status throws and re-queues it).
//
// The ledger is one JSON map under the data root (<data root>/openclaw-turn-commits.json). The gateway
// process is the single writer (the in-process engine; the standalone MCP server never commits turns),
// and an atomic tmp+rename (ops/atomic-file.ts) keeps a crash from corrupting the file. A lost or
// corrupt ledger costs at most one extra "committed" report — still a valid outbox status.
const { existsSync, readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { join } from "node:path";

import { atomicWriteFile } from "./atomic-file.ts";

export const TURN_COMMIT_LEDGER_FILE = "openclaw-turn-commits.json";
export const MAX_LEDGER_KEYS = 512; // pruned from the oldest; a re-sent older key reports "committed" again, which the host accepts

type LedgerEntry = { committedAt: string };

function readLedger(file: string): Record<string, LedgerEntry> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, LedgerEntry>)
      : {};
  } catch {
    return {}; // corrupt or a mid-crash file: start clean
  }
}

/** Record one advancement key: "committed" on first sight, "duplicate" on retry. The map is pruned to
 *  the newest MAX_LEDGER_KEYS (JSON object key order is insertion order). Synchronous on purpose: the
 *  host drains outbox rows sequentially, and commitTurn's caller serializes concurrent calls. */
export function recordTurnCommit(dataRoot: string, advancementKey: string): "committed" | "duplicate" {
  const file = join(dataRoot, TURN_COMMIT_LEDGER_FILE);
  const ledger = readLedger(file);
  if (Object.hasOwn(ledger, advancementKey)) return "duplicate";
  const next: Record<string, LedgerEntry> = {};
  for (const [key, entry] of Object.entries(ledger)) next[key] = entry;
  next[advancementKey] = { committedAt: new Date().toISOString() };
  const keys = Object.keys(next);
  while (keys.length > MAX_LEDGER_KEYS) delete next[keys.shift() as string]; // shift() = the oldest insertion
  atomicWriteFile(file, JSON.stringify(next));
  return "committed";
}
