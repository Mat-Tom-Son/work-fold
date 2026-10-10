import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { WorkFoldCheckTargetRole } from "../../shared/checks.js";
import { resolveSpacePath } from "../space.js";
import type { WorkFoldCheckTargetResolution } from "./target-resolver.js";

/** Read budgets only; whether the inputs fit is decided against the selected model's real context window. */
export const modelCheckLimits = Object.freeze({ maximumFiles: 1_000, maximumFileBytes: 16 * 1024 * 1024, maximumTotalBytes: 64 * 1024 * 1024, maximumFindings: 1_000, timeoutMs: 30 * 60_000 });
const mebibytes = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;
export interface WorkFoldCheckTextSnapshot {
  path: string;
  text: string;
  sha256: string;
  sizeBytes: number;
  roles: WorkFoldCheckTargetRole[];
}

/** Read from one no-follow handle, then rebind it to the named file. Never
 * return partially decoded, truncated, linked, or concurrently changed input. */
export async function readCheckTextSnapshot(root: string, path: string, roles: WorkFoldCheckTargetRole[], signal?: AbortSignal): Promise<WorkFoldCheckTextSnapshot> {
  signal?.throwIfAborted();
  const absolutePath = resolveSpacePath(root, path);
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > modelCheckLimits.maximumFileBytes) throw new Error(`Model Check requires a regular text file no larger than ${mebibytes(modelCheckLimits.maximumFileBytes)}: ${path}`);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(resolveSpacePath(root, path));
    if (length > modelCheckLimits.maximumFileBytes || length !== before.size || !named.isFile()
      || [after, named].some((info) => info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs)) {
      throw new Error(`Check input changed while being read: ${path}`);
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new Error(`Model Check requires UTF-8 text: ${path}`);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Model Check requires UTF-8 text: ${path}`); }
    signal?.throwIfAborted();
    return { path, text, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: length, roles: [...roles] };
  } finally { await handle.close(); }
}

export async function loadCheckTextSnapshots(root: string, resolution: WorkFoldCheckTargetResolution, signal?: AbortSignal): Promise<WorkFoldCheckTextSnapshot[]> {
  if (resolution.missingExactTargets.length) throw new Error("A model review cannot run while a designated file is missing.");
  if (!resolution.files.length || resolution.files.length > modelCheckLimits.maximumFiles) throw new Error(`A model review requires 1–${modelCheckLimits.maximumFiles.toLocaleString("en-US")} designated text files.`);
  const snapshots: WorkFoldCheckTextSnapshot[] = [];
  let total = 0;
  for (const file of resolution.files) {
    const snapshot = await readCheckTextSnapshot(root, file.path, file.roles, signal);
    total += snapshot.sizeBytes;
    if (total > modelCheckLimits.maximumTotalBytes) throw new Error(`Model Check inputs exceed the ${mebibytes(modelCheckLimits.maximumTotalBytes)} total limit. Narrow the targets.`);
    snapshots.push(snapshot);
  }
  return snapshots;
}
