import type { SpaceCheckpoint } from "../history.js";

export const maxTurnFileChanges = 64;
export interface WorkFoldTurnFileChanges {
  beforeCheckpointId: string;
  afterCheckpointId: string;
  files: Array<{ path: string; hashSha256: string; sizeBytes: number }>;
  truncated: boolean;
}

/** Observed History changes during a turn, not a claim that every edit was made by the model. */
export function turnFileChanges(before: SpaceCheckpoint | null, after: SpaceCheckpoint | null): WorkFoldTurnFileChanges | undefined {
  if (!before || !after || before.scope !== "full" || after.scope !== "full") return undefined;
  const prior = new Map(before.files.map((file) => [file.path, file.hashSha256]));
  const skipped = before.skippedFiles.map((file) => file.path);
  const changed = after.files.filter((file) => safeTurnFilePath(file.path) && !skipped.some((path) => file.path === path || file.path.startsWith(`${path}/`)) && prior.get(file.path) !== file.hashSha256)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId,
    files: changed.slice(0, maxTurnFileChanges).map(({ path, hashSha256, sizeBytes }) => ({ path, hashSha256, sizeBytes })),
    truncated: changed.length > maxTurnFileChanges };
}

export function parseTurnFileChanges(value: unknown): WorkFoldTurnFileChanges {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Turn file changes are invalid.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["beforeCheckpointId", "afterCheckpointId", "files", "truncated"].includes(key))
    || ![data.beforeCheckpointId, data.afterCheckpointId].every((id) => typeof id === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(id))
    || !Array.isArray(data.files) || data.files.length > maxTurnFileChanges || typeof data.truncated !== "boolean") throw new Error("Turn file changes are invalid.");
  const files = data.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Turn file reference is invalid.");
    const file = value as Record<string, unknown>;
    if (Object.keys(file).length !== 3 || Object.keys(file).some((key) => !["path", "hashSha256", "sizeBytes"].includes(key))
      || !safeTurnFilePath(file.path) || typeof file.hashSha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.hashSha256)
      || !Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes as number) < 0) throw new Error("Turn file reference is invalid.");
    return { path: file.path as string, hashSha256: file.hashSha256, sizeBytes: file.sizeBytes as number };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Turn file changes contain duplicate paths.");
  return { beforeCheckpointId: data.beforeCheckpointId as string, afterCheckpointId: data.afterCheckpointId as string, files, truncated: data.truncated };
}

export function safeTurnFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && !value.split("/").some((part) => !part || part === "." || part === ".." || [".work-fold", ".workspace", ".pi"].includes(part.toLowerCase()));
}
