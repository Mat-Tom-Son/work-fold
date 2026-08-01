import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export type RestrictedAppFileAccess = "read" | "read-write";
export type RestrictedAppFileTarget = "file" | "directory";

/** The reviewed maximum file authority declared by an app revision. */
export interface RestrictedAppFileDeclaration {
  id: string;
  target: RestrictedAppFileTarget;
  access: RestrictedAppFileAccess;
}

/** A user-approved, Space-relative target bound to one reviewed declaration. */
export interface RestrictedAppFileGrant {
  id: string;
  declarationId: string;
  root: string;
  access: RestrictedAppFileAccess;
}

/**
 * Host-owned authority for one installed app revision. This object must never
 * be accepted from the restricted renderer.
 */
export interface RestrictedAppFileContext {
  spaceRoot: string;
  declarations: readonly RestrictedAppFileDeclaration[];
  grants: readonly RestrictedAppFileGrant[];
  authorizeCommit?: () => void | Promise<void>;
}

export interface RestrictedAppFileListRequest {
  grantId: string;
  path: string;
}

export interface RestrictedAppFileReadRequest {
  grantId: string;
  path: string;
  encoding?: "utf8" | "base64";
}

export interface RestrictedAppFileWriteRequest {
  grantId: string;
  path: string;
  encoding?: "utf8" | "base64";
  data: string;
  mode: "create" | "replace";
}

export interface RestrictedAppFileListEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  sizeBytes?: number;
  modifiedAt: string;
}

export interface RestrictedAppFileListResult {
  path: string;
  entries: RestrictedAppFileListEntry[];
  truncated: boolean;
}

export interface RestrictedAppFileReadResult {
  path: string;
  encoding: "utf8" | "base64";
  data: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface RestrictedAppFileWriteResult {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export type RestrictedAppFileErrorCode =
  | "FILE_DENIED"
  | "FILE_NOT_FOUND"
  | "FILE_CONFLICT"
  | "FILE_TOO_LARGE"
  | "FILE_FAILED";

export class RestrictedAppFileError extends Error {
  constructor(readonly code: RestrictedAppFileErrorCode, message: string) {
    super(message);
    this.name = "RestrictedAppFileError";
  }
}

export interface RestrictedAppFileBrokerOptions {
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxListEntries?: number;
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const maximumRelativePathLength = 512;
const maximumGrants = 32;
const defaultMaximumReadBytes = 512 * 1024;
const defaultMaximumWriteBytes = 512 * 1024;
const defaultMaximumListEntries = 200;
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

interface PreparedGrant {
  spaceRoot: string;
  spaceRealRoot: string;
  grantRoot: string;
  grantRealRoot: string;
  declaration: RestrictedAppFileDeclaration;
  grant: RestrictedAppFileGrant;
}

interface ResolvedRequestPath {
  absolutePath: string;
  relativePath: string;
  exists: boolean;
}

/**
 * A narrow filesystem broker for sandboxed apps. App payloads name only a
 * grant and a path below it; Space identity, reviewed authority, and grant
 * roots always arrive through the trusted host context.
 */
export class RestrictedAppFileBroker {
  readonly #maxReadBytes: number;
  readonly #maxWriteBytes: number;
  readonly #maxListEntries: number;

  constructor(options: RestrictedAppFileBrokerOptions = {}) {
    this.#maxReadBytes = positiveBound(options.maxReadBytes, defaultMaximumReadBytes, "read byte limit", 16 * 1024 * 1024);
    this.#maxWriteBytes = positiveBound(options.maxWriteBytes, defaultMaximumWriteBytes, "write byte limit", 16 * 1024 * 1024);
    this.#maxListEntries = positiveBound(options.maxListEntries, defaultMaximumListEntries, "list entry limit", 1_000);
  }

  /** Effective bounds for this broker, published to apps through the limits bridge. */
  get limits(): { maxReadBytes: number; maxWriteBytes: number; maxListEntries: number } {
    return {
      maxReadBytes: this.#maxReadBytes,
      maxWriteBytes: this.#maxWriteBytes,
      maxListEntries: this.#maxListEntries,
    };
  }

  async validateGrant(context: RestrictedAppFileContext, grantId: string): Promise<void> {
    await prepareGrant(context, idValue(grantId, "App file grant id"));
  }

  async list(context: RestrictedAppFileContext, value: unknown): Promise<RestrictedAppFileListResult> {
    const request = parseListRequest(value);
    const prepared = await prepareGrant(context, request.grantId);
    const target = await resolveRequestPath(prepared, request.path, false);
    const targetInfo = await safeLstat(target.absolutePath);
    if (!targetInfo?.isDirectory()) throw new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app path is not a folder.");
    await assertCanonicalContainment(prepared, target.absolutePath);

    const entries: RestrictedAppFileListEntry[] = [];
    let truncated = false;
    const directory = await opendir(target.absolutePath).catch((error) => {
      throw fileSystemError(error, "work-fold could not list the granted folder.");
    });
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        if (isReservedMetadataSegment(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(target.absolutePath, entry.name);
        const info = await safeLstat(path);
        if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
        try {
          await assertCanonicalContainment(prepared, path);
        } catch (error) {
          if (error instanceof RestrictedAppFileError && error.code === "FILE_DENIED") continue;
          throw error;
        }
        if (entries.length >= this.#maxListEntries) {
          truncated = true;
          break;
        }
        const relativePath = target.relativePath === "." ? entry.name : `${target.relativePath}/${entry.name}`;
        entries.push({
          name: entry.name,
          path: relativePath,
          kind: info.isDirectory() ? "directory" : "file",
          ...(info.isFile() ? { sizeBytes: Number(info.size) } : {}),
          modifiedAt: info.mtime.toISOString(),
        });
      }
    } catch (error) {
      if (error instanceof RestrictedAppFileError) throw error;
      throw fileSystemError(error, "work-fold could not list the granted folder.");
    } finally {
      await directory.close().catch(() => undefined);
    }
    entries.sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory" ? -1 : 1);
    return { path: target.relativePath, entries, truncated };
  }

  async read(context: RestrictedAppFileContext, value: unknown): Promise<RestrictedAppFileReadResult> {
    const request = parseReadRequest(value);
    const prepared = await prepareGrant(context, request.grantId);
    const target = await resolveRequestPath(prepared, request.path, false);
    const handle = await open(target.absolutePath, constants.O_RDONLY | noFollowFlag).catch((error) => {
      throw fileSystemError(error, "work-fold could not open the granted file.");
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app path is not a file.");
      if (info.size > this.#maxReadBytes) throw new RestrictedAppFileError("FILE_TOO_LARGE", `The granted file exceeds the ${this.#maxReadBytes}-byte read limit.`);
      await assertCanonicalContainment(prepared, target.absolutePath);
      const bytes = Buffer.alloc(this.#maxReadBytes + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > this.#maxReadBytes) throw new RestrictedAppFileError("FILE_TOO_LARGE", `The granted file exceeds the ${this.#maxReadBytes}-byte read limit.`);
      const data = bytes.subarray(0, read.bytesRead);
      const encoding = request.encoding ?? "utf8";
      let encoded: string;
      if (encoding === "base64") encoded = data.toString("base64");
      else {
        try {
          encoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          throw new RestrictedAppFileError("FILE_FAILED", "The granted file is not valid UTF-8. Read it as base64 instead.");
        }
      }
      const finalInfo = await handle.stat();
      if (!finalInfo.isFile() || finalInfo.size !== read.bytesRead) {
        throw new RestrictedAppFileError("FILE_CONFLICT", "The granted file changed while work-fold was reading it.");
      }
      return {
        path: target.relativePath,
        encoding,
        data: encoded,
        sizeBytes: read.bytesRead,
        modifiedAt: finalInfo.mtime.toISOString(),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async write(context: RestrictedAppFileContext, value: unknown): Promise<RestrictedAppFileWriteResult> {
    const request = parseWriteRequest(value);
    const prepared = await prepareGrant(context, request.grantId);
    if (prepared.declaration.access !== "read-write" || prepared.grant.access !== "read-write") {
      throw new RestrictedAppFileError("FILE_DENIED", "This app grant is read-only.");
    }
    const bytes = requestBytes(request, this.#maxWriteBytes);
    const target = await resolveRequestPath(prepared, request.path, request.mode === "create");
    if (prepared.declaration.target === "file" && request.mode !== "replace") {
      throw new RestrictedAppFileError("FILE_DENIED", "A file grant can replace only its selected file.");
    }
    const current = await safeLstat(target.absolutePath);
    if (current?.isSymbolicLink() || (current && !current.isFile())) {
      throw new RestrictedAppFileError("FILE_DENIED", "Restricted apps can write only ordinary files.");
    }
    if (request.mode === "create" && current) throw new RestrictedAppFileError("FILE_CONFLICT", "A file already exists at the requested app path.");
    if (request.mode === "replace" && !current) throw new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app file does not exist.");
    if (current) await assertCanonicalContainment(prepared, target.absolutePath);

    const parentPath = resolve(target.absolutePath, "..");
    const parentInfo = await safeLstat(parentPath);
    if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new RestrictedAppFileError("FILE_DENIED", "The granted file parent is not an ordinary folder.");
    }
    await assertWriteParentContainment(prepared, parentPath);

    const temporary = join(parentPath, `.work-fold-app-write-${randomUUID()}.tmp`);
    let temporaryPresent = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      temporaryPresent = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }

      // Recheck the authority boundary and destination immediately before the
      // atomic namespace operation. This also rejects a link swapped in after
      // the initial validation.
      await assertWriteParentContainment(prepared, parentPath);
      const latest = await safeLstat(target.absolutePath);
      if (latest?.isSymbolicLink() || (latest && !latest.isFile())) {
        throw new RestrictedAppFileError("FILE_DENIED", "Restricted apps can write only ordinary files.");
      }
      await context.authorizeCommit?.();
      if (request.mode === "create") {
        if (latest) throw new RestrictedAppFileError("FILE_CONFLICT", "A file already exists at the requested app path.");
        await link(temporary, target.absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw new RestrictedAppFileError("FILE_CONFLICT", "A file already exists at the requested app path.");
          throw fileSystemError(error, "work-fold could not create the granted file.");
        });
        await unlink(temporary);
        temporaryPresent = false;
      } else {
        if (!latest) throw new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app file no longer exists.");
        await rename(temporary, target.absolutePath).catch((error) => {
          throw fileSystemError(error, "work-fold could not replace the granted file.");
        });
        temporaryPresent = false;
      }
      await assertCanonicalContainment(prepared, target.absolutePath);
      const written = await stat(target.absolutePath);
      if (!written.isFile() || written.size !== bytes.length) throw new RestrictedAppFileError("FILE_FAILED", "work-fold could not verify the written file.");
      return {
        path: target.relativePath,
        sizeBytes: written.size,
        modifiedAt: written.mtime.toISOString(),
      };
    } finally {
      if (temporaryPresent) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function prepareGrant(context: RestrictedAppFileContext, grantId: string): Promise<PreparedGrant> {
  if (!context || typeof context !== "object") throw new RestrictedAppFileError("FILE_DENIED", "Restricted app file authority is unavailable.");
  if (!isAbsolute(context.spaceRoot)) throw new RestrictedAppFileError("FILE_DENIED", "Restricted app Space authority is invalid.");
  const spaceRoot = resolve(context.spaceRoot);
  if (spaceRoot === parse(spaceRoot).root) throw new RestrictedAppFileError("FILE_DENIED", "A filesystem root cannot be granted to an app.");
  const spaceInfo = await safeLstat(spaceRoot);
  if (!spaceInfo?.isDirectory() || spaceInfo.isSymbolicLink()) throw new RestrictedAppFileError("FILE_DENIED", "The app Space root is not an ordinary folder.");
  if (!Array.isArray(context.declarations) || !Array.isArray(context.grants)
    || context.declarations.length > maximumGrants || context.grants.length > maximumGrants) {
    throw new RestrictedAppFileError("FILE_DENIED", "Restricted app file authority is invalid.");
  }
  const declarations = context.declarations.map(validateDeclaration);
  const grants = context.grants.map(validateGrant);
  if (new Set(declarations.map((item) => item.id)).size !== declarations.length
    || new Set(grants.map((item) => item.id)).size !== grants.length) {
    throw new RestrictedAppFileError("FILE_DENIED", "Restricted app file authority contains duplicate ids.");
  }
  const grant = grants.find((item) => item.id === grantId);
  if (!grant) throw new RestrictedAppFileError("FILE_DENIED", "The app does not have this Space file grant.");
  const declaration = declarations.find((item) => item.id === grant.declarationId);
  if (!declaration || (grant.access === "read-write" && declaration.access !== "read-write")) {
    throw new RestrictedAppFileError("FILE_DENIED", "The app file grant exceeds its reviewed declaration.");
  }

  const spaceRealRoot = await realpath(spaceRoot).catch((error) => {
    throw fileSystemError(error, "work-fold could not resolve the app Space root.");
  });
  const root = safeRelativePath(grant.root, "App grant root");
  const grantRoot = root === "." ? spaceRoot : resolve(spaceRoot, ...root.split("/"));
  await assertNoLinkSegments(spaceRoot, grantRoot);
  const grantInfo = await safeLstat(grantRoot);
  if (!grantInfo || grantInfo.isSymbolicLink()
    || (declaration.target === "file" ? !grantInfo.isFile() : !grantInfo.isDirectory())) {
    throw new RestrictedAppFileError("FILE_DENIED", `The app's granted ${declaration.target} is unavailable.`);
  }
  const grantRealRoot = await realpath(grantRoot).catch((error) => {
    throw fileSystemError(error, "work-fold could not resolve the app grant.");
  });
  if (!pathContains(spaceRealRoot, grantRealRoot)) {
    throw new RestrictedAppFileError("FILE_DENIED", "The app grant escapes its Space.");
  }
  return { spaceRoot, spaceRealRoot, grantRoot, grantRealRoot, declaration, grant };
}

async function resolveRequestPath(prepared: PreparedGrant, value: string, allowMissing: boolean): Promise<ResolvedRequestPath> {
  const relativePath = safeRelativePath(value, "App file path");
  if (prepared.declaration.target === "file" && relativePath !== ".") {
    throw new RestrictedAppFileError("FILE_DENIED", "A file grant can access only its selected file.");
  }
  const absolutePath = relativePath === "." ? prepared.grantRoot : resolve(prepared.grantRoot, ...relativePath.split("/"));
  if (!pathContains(prepared.grantRoot, absolutePath)) throw new RestrictedAppFileError("FILE_DENIED", "The app path escapes its grant.");
  await assertNoLinkSegments(prepared.grantRoot, absolutePath);
  const info = await safeLstat(absolutePath);
  if (!info && !allowMissing) throw new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app path does not exist.");
  if (info) await assertCanonicalContainment(prepared, absolutePath);
  return { absolutePath, relativePath, exists: Boolean(info) };
}

async function assertCanonicalContainment(prepared: PreparedGrant, path: string): Promise<void> {
  await assertNoLinkSegments(prepared.grantRoot, path);
  const resolved = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app path does not exist.");
    throw fileSystemError(error, "work-fold could not resolve the granted app path.");
  });
  if (!pathContains(prepared.spaceRealRoot, resolved) || !pathContains(prepared.grantRealRoot, resolved)) {
    throw new RestrictedAppFileError("FILE_DENIED", "The app path escapes its Space file grant.");
  }
}

async function assertWriteParentContainment(prepared: PreparedGrant, parentPath: string): Promise<void> {
  if (prepared.declaration.target !== "file") {
    await assertCanonicalContainment(prepared, parentPath);
    return;
  }

  const expectedParent = resolve(prepared.grantRoot, "..");
  if (resolve(parentPath) !== expectedParent) {
    throw new RestrictedAppFileError("FILE_DENIED", "The app file parent escapes its grant.");
  }
  await assertNoLinkSegments(prepared.spaceRoot, parentPath);
  const resolvedParent = await realpath(parentPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new RestrictedAppFileError("FILE_NOT_FOUND", "The granted file parent does not exist.");
    throw fileSystemError(error, "work-fold could not resolve the granted app file parent.");
  });
  if (!pathContains(prepared.spaceRealRoot, resolvedParent)
    || resolvedParent !== resolve(prepared.grantRealRoot, "..")) {
    throw new RestrictedAppFileError("FILE_DENIED", "The app file parent escapes its Space file grant.");
  }
}

async function assertNoLinkSegments(root: string, path: string): Promise<void> {
  if (!pathContains(root, path)) throw new RestrictedAppFileError("FILE_DENIED", "The app path escapes its grant.");
  const child = relative(root, path);
  if (!child) return;
  let cursor = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const info = await safeLstat(cursor);
    if (!info) return;
    if (info.isSymbolicLink()) throw new RestrictedAppFileError("FILE_DENIED", "Restricted app paths cannot traverse links or junctions.");
  }
}

function parseListRequest(value: unknown): RestrictedAppFileListRequest {
  const request = requestObject(value, ["grantId", "path"]);
  return { grantId: idValue(request.grantId, "App file grant id"), path: stringValue(request.path, "App file path", maximumRelativePathLength) };
}

function parseReadRequest(value: unknown): RestrictedAppFileReadRequest {
  const request = requestObject(value, ["grantId", "path", "encoding"]);
  const encoding = encodingValue(request.encoding);
  return {
    grantId: idValue(request.grantId, "App file grant id"),
    path: stringValue(request.path, "App file path", maximumRelativePathLength),
    ...(encoding ? { encoding } : {}),
  };
}

function parseWriteRequest(value: unknown): RestrictedAppFileWriteRequest {
  const request = requestObject(value, ["grantId", "path", "encoding", "data", "mode"]);
  const encoding = encodingValue(request.encoding);
  if (typeof request.data !== "string") throw new RestrictedAppFileError("FILE_DENIED", "App file data must be text.");
  if (request.mode !== "create" && request.mode !== "replace") {
    throw new RestrictedAppFileError("FILE_DENIED", "App file write mode must be create or replace.");
  }
  return {
    grantId: idValue(request.grantId, "App file grant id"),
    path: stringValue(request.path, "App file path", maximumRelativePathLength),
    ...(encoding ? { encoding } : {}),
    data: request.data,
    mode: request.mode,
  };
}

function requestObject(value: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RestrictedAppFileError("FILE_DENIED", "App file request must be an object.");
  }
  const request = value as Record<string, unknown>;
  const unknown = Object.keys(request).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new RestrictedAppFileError("FILE_DENIED", `App file request contains an unsupported field: ${unknown}`);
  return request;
}

function validateDeclaration(value: RestrictedAppFileDeclaration): RestrictedAppFileDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RestrictedAppFileError("FILE_DENIED", "App file declaration is invalid.");
  const item = value as RestrictedAppFileDeclaration;
  const keys = Object.keys(item);
  if (keys.some((key) => key !== "id" && key !== "target" && key !== "access")) throw new RestrictedAppFileError("FILE_DENIED", "App file declaration has unsupported fields.");
  if ((item.target !== "file" && item.target !== "directory") || (item.access !== "read" && item.access !== "read-write")) {
    throw new RestrictedAppFileError("FILE_DENIED", "App file declaration is invalid.");
  }
  return { id: idValue(item.id, "App file declaration id"), target: item.target, access: item.access };
}

function validateGrant(value: RestrictedAppFileGrant): RestrictedAppFileGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RestrictedAppFileError("FILE_DENIED", "App file grant is invalid.");
  const item = value as RestrictedAppFileGrant;
  const keys = Object.keys(item);
  if (keys.some((key) => key !== "id" && key !== "declarationId" && key !== "root" && key !== "access")) {
    throw new RestrictedAppFileError("FILE_DENIED", "App file grant has unsupported fields.");
  }
  if (item.access !== "read" && item.access !== "read-write") throw new RestrictedAppFileError("FILE_DENIED", "App file grant access is invalid.");
  return {
    id: idValue(item.id, "App file grant id"),
    declarationId: idValue(item.declarationId, "App file declaration id"),
    root: safeRelativePath(item.root, "App grant root"),
    access: item.access,
  };
}

function safeRelativePath(value: unknown, label: string): string {
  const path = stringValue(value, label, maximumRelativePathLength);
  if (path === ".") return path;
  if (isAbsolute(path) || path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("\0")) {
    throw new RestrictedAppFileError("FILE_DENIED", `${label} must be a safe relative path.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isUnsafePortableSegment(segment) || isReservedMetadataSegment(segment))) {
    throw new RestrictedAppFileError("FILE_DENIED", `${label} must be a safe relative path outside work-fold metadata.`);
  }
  return segments.join("/");
}

function requestBytes(request: RestrictedAppFileWriteRequest, maximum: number): Buffer {
  const encoding = request.encoding ?? "utf8";
  let bytes: Buffer;
  if (encoding === "utf8") {
    if (Buffer.byteLength(request.data, "utf8") > maximum) throw new RestrictedAppFileError("FILE_TOO_LARGE", `App file data exceeds the ${maximum}-byte write limit.`);
    bytes = Buffer.from(request.data, "utf8");
  } else {
    if (request.data.length > Math.ceil(maximum / 3) * 4 + 4 || !canonicalBase64(request.data)) {
      throw new RestrictedAppFileError("FILE_DENIED", "App file data must use canonical base64 encoding.");
    }
    bytes = Buffer.from(request.data, "base64");
    if (bytes.length > maximum) throw new RestrictedAppFileError("FILE_TOO_LARGE", `App file data exceeds the ${maximum}-byte write limit.`);
  }
  return bytes;
}

function canonicalBase64(value: string): boolean {
  if (!value) return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function encodingValue(value: unknown): "utf8" | "base64" | undefined {
  if (value === undefined) return undefined;
  if (value !== "utf8" && value !== "base64") throw new RestrictedAppFileError("FILE_DENIED", "App file encoding must be utf8 or base64.");
  return value;
}

function idValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new RestrictedAppFileError("FILE_DENIED", `${label} is invalid.`);
  return value;
}

function stringValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new RestrictedAppFileError("FILE_DENIED", `${label} is invalid.`);
  return value;
}

function positiveBound(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`Restricted app ${label} is invalid.`);
  return result;
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw fileSystemError(error, "work-fold could not inspect the granted app path.");
  });
}

function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return !child || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isReservedMetadataSegment(segment: string): boolean {
  const value = segment.toLocaleLowerCase("en-US");
  return value === ".work-fold" || value === ".workspace" || value === ".pi";
}

function isUnsafePortableSegment(segment: string): boolean {
  const stem = segment.split(".")[0]?.toLocaleUpperCase();
  return segment.endsWith(".") || segment.endsWith(" ")
    || stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/.test(stem ?? "") || /^LPT[1-9]$/.test(stem ?? "");
}

function fileSystemError(error: unknown, fallback: string): RestrictedAppFileError {
  if (error instanceof RestrictedAppFileError) return error;
  const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
  if (code === "ENOENT") return new RestrictedAppFileError("FILE_NOT_FOUND", "The requested app path does not exist.");
  if (code === "EEXIST") return new RestrictedAppFileError("FILE_CONFLICT", "A file already exists at the requested app path.");
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") return new RestrictedAppFileError("FILE_DENIED", "work-fold denied the restricted app file operation.");
  return new RestrictedAppFileError("FILE_FAILED", fallback);
}
