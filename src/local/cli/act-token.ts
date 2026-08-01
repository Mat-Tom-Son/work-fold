import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { workFoldCliBrokerPaths } from "./broker.js";
import { WORKFOLD_CLI_ACT_TOKEN_PATTERN } from "./protocol.js";

/**
 * Per-launch act-token file. The interactive desktop app mints a fresh token
 * every run, writes it here so the installed shims can attach it to act-lane
 * requests, and removes it on shutdown. Possession proves the caller can read
 * this user's application-data directory while the app is running — the
 * same-user boundary this personal, local product deliberately relies on.
 * POSIX gets mode 0600; Windows relies on the profile directory's ACLs.
 */
export interface WorkFoldCliActTokenFileV1 {
  version: 1;
  actToken: string;
  createdAt: string;
  product: string;
}

const actTokenFileName = "act-token.json";
const maxActTokenFileBytes = 4 * 1024;

export function workFoldCliActTokenPath(stateRoot: string): string {
  return join(workFoldCliBrokerPaths(stateRoot).root, actTokenFileName);
}

export async function writeWorkFoldCliActTokenFile(stateRoot: string, token: string, product: string): Promise<void> {
  if (!WORKFOLD_CLI_ACT_TOKEN_PATTERN.test(token)) throw new Error("Act token is malformed.");
  const path = workFoldCliActTokenPath(stateRoot);
  const record: WorkFoldCliActTokenFileV1 = {
    version: 1,
    actToken: token,
    createdAt: new Date().toISOString(),
    product,
  };
  await mkdir(workFoldCliBrokerPaths(stateRoot).root, { recursive: true, mode: 0o700 });
  const temp = join(workFoldCliBrokerPaths(stateRoot).root, `${actTokenFileName}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    // Windows rename does not clobber, and rotation must replace stale files.
    await rm(path, { force: true });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readWorkFoldCliActTokenFile(stateRoot: string): Promise<WorkFoldCliActTokenFileV1 | null> {
  try {
    const bytes = await readFile(workFoldCliActTokenPath(stateRoot));
    if (bytes.byteLength > maxActTokenFileBytes) return null;
    const record = JSON.parse(bytes.toString("utf8")) as Partial<WorkFoldCliActTokenFileV1>;
    if (record.version !== 1) return null;
    if (typeof record.actToken !== "string" || !WORKFOLD_CLI_ACT_TOKEN_PATTERN.test(record.actToken)) return null;
    if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) return null;
    if (typeof record.product !== "string" || !record.product.trim()) return null;
    return { version: 1, actToken: record.actToken, createdAt: record.createdAt, product: record.product };
  } catch {
    return null;
  }
}

export async function removeWorkFoldCliActTokenFile(stateRoot: string): Promise<void> {
  await rm(workFoldCliActTokenPath(stateRoot), { force: true });
}
