import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { workFoldStateRoot } from "./state-paths.js";

/**
 * Retired gate state (docs/receipts-not-gates.md, F19). Older builds kept a
 * pending-decision store, a digest-addressed holding area for routing
 * declarations awaiting a decision, an authority-mode store, and a
 * standing-policy store under `fold/` in the state root. None of it has a
 * reader any more, and a pending record in the old store is an intent nobody
 * confirmed: it must never run. Startup therefore removes these files
 * without opening or parsing them, best-effort, and swallows every error —
 * a file that cannot be removed is inert either way. The act-receipts
 * journal is untouched; receipts older builds wrote remain readable history.
 */
const RETIRED_FOLD_FILES = [
  "staged-acts.json",
  "authority.json",
  "authority-changes.jsonl",
  "authority-changes.1.jsonl",
  "policies.json",
  "policy-changes.jsonl",
  "policy-changes.1.jsonl",
] as const;

const RETIRED_FOLD_DIRECTORIES = ["staged-routings"] as const;

export async function removeRetiredFoldGateState(stateRoot: string = workFoldStateRoot()): Promise<void> {
  const fold = join(stateRoot, "fold");
  for (const name of RETIRED_FOLD_FILES) {
    await rm(join(fold, name), { force: true }).catch(() => undefined);
  }
  for (const name of RETIRED_FOLD_DIRECTORIES) {
    await rm(join(fold, name), { recursive: true, force: true }).catch(() => undefined);
  }
  // The old store wrote through `staged-acts.json.<uuid>.tmp` siblings; an
  // interrupted write leaves one behind, and it holds the same kind of
  // never-confirmed intent.
  const entries = await readdir(fold).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith("staged-acts.json.") || !entry.endsWith(".tmp")) continue;
    await rm(join(fold, entry), { force: true }).catch(() => undefined);
  }
}
