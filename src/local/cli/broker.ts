import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  WorkFoldCliError,
  WorkFoldCliExitCode,
  createWorkFoldCliResponse,
  normalizeWorkFoldCliRequestId,
  parseWorkFoldCliRequest,
  parseWorkFoldCliResponse,
  type WorkFoldCliRequestV1,
  type WorkFoldCliResponseV1,
} from "./protocol.js";
import {
  WORKFOLD_CLI_MAX_ACT_REQUEST_BYTES,
  isWorkFoldCliActRequest,
  parseWorkFoldCliActRequest,
  parseWorkFoldCliRequestEnvelope,
  type WorkFoldCliActRequestV2,
  type WorkFoldCliBrokeredRequest,
} from "./act-protocol.js";

export const WORKFOLD_CLI_MAX_REQUEST_BYTES = 128 * 1024;
export const WORKFOLD_CLI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const WORKFOLD_CLI_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
export const WORKFOLD_CLI_REQUEST_FUTURE_SKEW_MS = 60 * 1000;
export const WORKFOLD_CLI_DEFAULT_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

export interface WorkFoldCliBrokerOptions {
  stateRoot: string;
  now?: () => Date;
  maxRequestBytes?: number;
  maxActRequestBytes?: number;
  maxResponseBytes?: number;
  maxRequestAgeMs?: number;
  maxFutureSkewMs?: number;
}

export interface WorkFoldCliBrokerPaths {
  root: string;
  requests: string;
  claims: string;
  responses: string;
}

export interface WorkFoldCliRequestPaths {
  request: string;
  claim: string;
  claimLock: string;
  response: string;
}

export interface WorkFoldCliCleanupResult {
  removed: string[];
  skippedUnsafe: string[];
}

export type WorkFoldCliRequestExecutor = (request: WorkFoldCliBrokeredRequest) => Promise<WorkFoldCliResponseV1>;

export class WorkFoldCliFileBroker {
  readonly paths: WorkFoldCliBrokerPaths;
  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly maxRequestBytes: number;
  private readonly maxActRequestBytes: number;
  private readonly claimReadBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxRequestAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly inFlight = new Map<string, Promise<WorkFoldCliResponseV1>>();

  constructor(options: WorkFoldCliBrokerOptions) {
    if (!options.stateRoot.trim() || !isAbsolute(options.stateRoot)) {
      throw new WorkFoldCliError("protocolError", "CLI broker state root must be an absolute path.");
    }
    this.stateRoot = resolve(options.stateRoot);
    this.paths = workFoldCliBrokerPaths(this.stateRoot);
    this.now = options.now ?? (() => new Date());
    this.maxRequestBytes = positiveLimit(options.maxRequestBytes, WORKFOLD_CLI_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.maxActRequestBytes = positiveLimit(options.maxActRequestBytes, WORKFOLD_CLI_MAX_ACT_REQUEST_BYTES, "maxActRequestBytes");
    // Claims are read under the larger lane bound; the exact per-lane cap is
    // re-enforced after the envelope identifies the request's protocol.
    this.claimReadBytes = Math.max(this.maxRequestBytes, this.maxActRequestBytes);
    this.maxResponseBytes = positiveLimit(options.maxResponseBytes, WORKFOLD_CLI_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.maxRequestAgeMs = positiveLimit(options.maxRequestAgeMs, WORKFOLD_CLI_REQUEST_MAX_AGE_MS, "maxRequestAgeMs");
    this.maxFutureSkewMs = positiveLimit(options.maxFutureSkewMs, WORKFOLD_CLI_REQUEST_FUTURE_SKEW_MS, "maxFutureSkewMs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(this.stateRoot);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
      throw new WorkFoldCliError("permissionDenied", "CLI broker state root is not a safe directory.");
    }
    await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(this.paths.root, this.paths.root, "CLI broker root");
    for (const path of [this.paths.requests, this.paths.claims, this.paths.responses]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(this.paths.root, path, "CLI broker directory");
      await chmod(path, 0o700).catch(() => undefined);
    }
  }

  requestPaths(id: string): WorkFoldCliRequestPaths {
    const normalized = normalizeWorkFoldCliRequestId(id);
    return {
      request: safeChild(this.paths.requests, `${normalized}.json`),
      claim: safeChild(this.paths.claims, `${normalized}.json`),
      claimLock: safeChild(this.paths.claims, `${normalized}.lock`),
      response: safeChild(this.paths.responses, `${normalized}.json`),
    };
  }

  async writeRequest(request: WorkFoldCliRequestV1): Promise<string> {
    await this.initialize();
    const validated = parseWorkFoldCliRequest(request);
    this.assertFresh(validated);
    const paths = this.requestPaths(validated.id);
    await assertAbsent(paths.claim, "CLI request is already claimed.");
    await assertAbsent(paths.response, "CLI request already has a response.");
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (bytes.byteLength > this.maxRequestBytes) throw new WorkFoldCliError("protocolError", "CLI request exceeds the size limit.");
    await atomicCreate(paths.request, bytes);
    return paths.request;
  }

  async writeActRequest(request: WorkFoldCliActRequestV2): Promise<string> {
    await this.initialize();
    const validated = parseWorkFoldCliActRequest(request);
    this.assertFresh(validated);
    const paths = this.requestPaths(validated.id);
    await assertAbsent(paths.claim, "CLI request is already claimed.");
    await assertAbsent(paths.response, "CLI request already has a response.");
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (bytes.byteLength > this.maxActRequestBytes) throw new WorkFoldCliError("protocolError", "CLI act request exceeds the size limit.");
    await atomicCreate(paths.request, bytes);
    return paths.request;
  }

  async claimRequest(id: string): Promise<WorkFoldCliBrokeredRequest> {
    await this.initialize();
    const paths = this.requestPaths(id);
    const lock = await acquireLock(paths.claimLock);
    let claimed = false;
    try {
      await assertSafeRegularFile(this.paths.root, paths.request, "CLI request", this.claimReadBytes);
      await assertAbsent(paths.claim, "CLI request is already claimed.");
      await rename(paths.request, paths.claim);
      claimed = true;
      await assertSafeRegularFile(this.paths.root, paths.claim, "CLI claim", this.claimReadBytes);
      const bytes = await readBoundedFile(paths.claim, this.claimReadBytes, "CLI request");
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        throw new WorkFoldCliError("protocolError", "CLI request is not valid JSON.", { cause: error });
      }
      const request = parseWorkFoldCliRequestEnvelope(parsed);
      const laneBound = isWorkFoldCliActRequest(request) ? this.maxActRequestBytes : this.maxRequestBytes;
      if (bytes.byteLength > laneBound) throw new WorkFoldCliError("protocolError", "CLI request exceeds the size limit.");
      if (request.id !== normalizeWorkFoldCliRequestId(id)) {
        throw new WorkFoldCliError("protocolError", "CLI request id does not match its file name.");
      }
      this.assertFresh(request);
      return request;
    } catch (error) {
      if (claimed) await rm(paths.claim, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await lock.close().catch(() => undefined);
      await rm(paths.claimLock, { force: true }).catch(() => undefined);
    }
  }

  async readResponse(id: string): Promise<WorkFoldCliResponseV1> {
    await this.initialize();
    const path = this.requestPaths(id).response;
    await assertSafeRegularFile(this.paths.root, path, "CLI response", this.maxResponseBytes);
    const bytes = await readBoundedFile(path, this.maxResponseBytes, "CLI response");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new WorkFoldCliError("protocolError", "CLI response is not valid JSON.", { cause: error });
    }
    const response = parseWorkFoldCliResponse(parsed);
    if (response.id !== normalizeWorkFoldCliRequestId(id)) {
      throw new WorkFoldCliError("protocolError", "CLI response id does not match its file name.");
    }
    return response;
  }

  async writeResponse(response: WorkFoldCliResponseV1): Promise<string> {
    await this.initialize();
    const validated = parseWorkFoldCliResponse(response);
    const path = this.requestPaths(validated.id).response;
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (bytes.byteLength > this.maxResponseBytes) throw new WorkFoldCliError("protocolError", "CLI response exceeds the size limit.");
    await atomicCreate(path, bytes);
    return path;
  }

  processRequest(id: string, executor: WorkFoldCliRequestExecutor): Promise<WorkFoldCliResponseV1> {
    const normalized = normalizeWorkFoldCliRequestId(id);
    const existing = this.inFlight.get(normalized);
    if (existing) return existing;
    const operation = this.processRequestOnce(normalized, executor).finally(() => {
      if (this.inFlight.get(normalized) === operation) this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, operation);
    return operation;
  }

  async cleanup(options: { olderThanMs?: number } = {}): Promise<WorkFoldCliCleanupResult> {
    await this.initialize();
    const olderThanMs = positiveLimit(options.olderThanMs, WORKFOLD_CLI_DEFAULT_CLEANUP_AGE_MS, "olderThanMs");
    const threshold = this.now().getTime() - olderThanMs;
    const removed: string[] = [];
    const skippedUnsafe: string[] = [];
    for (const directory of [this.paths.requests, this.paths.claims, this.paths.responses]) {
      await assertSafeDirectory(this.paths.root, directory, "CLI broker directory");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!/^[0-9a-f-]{36}\.(?:json|lock)$|^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) continue;
        const path = safeChild(directory, entry.name);
        if (entry.isSymbolicLink() || !entry.isFile()) {
          skippedUnsafe.push(path);
          continue;
        }
        const info = await lstat(path).catch(() => null);
        if (!info || info.isSymbolicLink() || !info.isFile()) {
          if (info) skippedUnsafe.push(path);
          continue;
        }
        if (info.mtimeMs >= threshold) continue;
        await rm(path, { force: true });
        removed.push(path);
      }
    }
    return { removed, skippedUnsafe };
  }

  private async processRequestOnce(id: string, executor: WorkFoldCliRequestExecutor): Promise<WorkFoldCliResponseV1> {
    await this.initialize();
    const paths = this.requestPaths(id);
    try {
      const existing = await fileExists(paths.response) ? await this.readResponse(id) : null;
      if (existing) return existing;
      const request = await this.claimRequest(id);
      let response: WorkFoldCliResponseV1;
      try {
        response = parseWorkFoldCliResponse(await executor(request));
        if (response.id !== id) throw new WorkFoldCliError("protocolError", "CLI executor returned a response for a different request.");
      } catch (error) {
        response = errorResponse(id, error, this.now());
      }
      await this.writeResponse(response);
      return response;
    } catch (error) {
      const response = errorResponse(id, error, this.now());
      if (!await fileExists(paths.response)) await this.writeResponse(response).catch(() => undefined);
      return await fileExists(paths.response) ? this.readResponse(id) : response;
    } finally {
      await rm(paths.claim, { force: true }).catch(() => undefined);
      await rm(paths.claimLock, { force: true }).catch(() => undefined);
    }
  }

  private assertFresh(request: { createdAt: string }): void {
    const now = this.now().getTime();
    const createdAt = Date.parse(request.createdAt);
    if (now - createdAt > this.maxRequestAgeMs) throw new WorkFoldCliError("timeout", "CLI request expired before work-fold could process it.");
    if (createdAt - now > this.maxFutureSkewMs) throw new WorkFoldCliError("protocolError", "CLI request timestamp is too far in the future.");
  }
}

export function workFoldCliBrokerPaths(stateRoot: string): WorkFoldCliBrokerPaths {
  if (!stateRoot.trim() || !isAbsolute(stateRoot)) throw new WorkFoldCliError("protocolError", "CLI broker state root must be an absolute path.");
  const root = resolve(stateRoot, "cli");
  return {
    root,
    requests: join(root, "requests"),
    claims: join(root, "claims"),
    responses: join(root, "responses"),
  };
}

function errorResponse(id: string, error: unknown, completedAt: Date): WorkFoldCliResponseV1 {
  const normalized = error instanceof WorkFoldCliError
    ? error
    : new WorkFoldCliError("failure", error instanceof Error ? error.message : String(error ?? "work-fold command failed."), { cause: error });
  return createWorkFoldCliResponse({
    id,
    exitCode: normalized.exitCode,
    stdout: "",
    stderr: `${normalized.message}\n`,
    result: { ok: false, error: { code: normalized.code, message: normalized.message } },
    completedAt: completedAt.toISOString(),
  });
}

async function atomicCreate(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path.slice(0, -".json".length)}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertAbsent(path, "CLI file already exists.");
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    if (isAlreadyExists(error)) throw new WorkFoldCliError("conflict", "CLI file already exists.", { cause: error });
    throw error;
  }
}

async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    if (isAlreadyExists(error)) throw new WorkFoldCliError("conflict", "CLI request is already being processed.", { cause: error });
    throw error;
  }
}

async function assertSafeDirectory(root: string, path: string, label: string): Promise<void> {
  assertWithin(root, path);
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new WorkFoldCliError("permissionDenied", `${label} is not a safe directory.`);
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  const resolvedPath = await realpath(path).catch(() => resolve(path));
  assertWithin(resolvedRoot, resolvedPath);
}

async function assertSafeRegularFile(root: string, path: string, label: string, maxBytes: number): Promise<void> {
  assertWithin(root, path);
  const info = await lstat(path).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!info) throw new WorkFoldCliError("notFound", `${label} was not found.`);
  if (!info.isFile() || info.isSymbolicLink()) throw new WorkFoldCliError("permissionDenied", `${label} is not a safe regular file.`);
  if (info.size > maxBytes) throw new WorkFoldCliError("protocolError", `${label} exceeds the size limit.`);
  const resolvedRoot = await realpath(root);
  const resolvedPath = await realpath(path);
  assertWithin(resolvedRoot, resolvedPath);
}

async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const before = await stat(path);
  if (!before.isFile() || before.size > maxBytes) throw new WorkFoldCliError("protocolError", `${label} exceeds the size limit.`);
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) throw new WorkFoldCliError("protocolError", `${label} exceeds the size limit.`);
  return bytes;
}

async function assertAbsent(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
    throw new WorkFoldCliError("conflict", message);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function safeChild(parent: string, name: string): string {
  const path = resolve(parent, name);
  assertWithin(parent, path);
  return path;
}

function assertWithin(root: string, path: string): void {
  const base = resolve(root);
  const candidate = resolve(path);
  const child = relative(base, candidate);
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) return;
  throw new WorkFoldCliError("permissionDenied", "CLI broker path escapes its state root.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new WorkFoldCliError("protocolError", `${label} must be a positive number.`);
  return Math.floor(resolved);
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
