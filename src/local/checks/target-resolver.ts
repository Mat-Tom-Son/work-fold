import type { Dirent, Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { WorkspaceCheckTarget, WorkspaceCheckTargetRole } from "../../shared/checks.js";

export const workspaceCheckTargetHardLimits = Object.freeze({
  maxSelectors: 64,
  maxVisitedEntries: 10_000,
  maxDepth: 32,
  maxFiles: 512,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});

export interface WorkspaceCheckTargetLimits {
  maxSelectors: number;
  maxVisitedEntries: number;
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface WorkspaceCheckResolvedFile {
  /** Canonical Space-relative path, using `/` separators. */
  path: string;
  /** Internal filesystem path for the runner. Never expose this through a content-free projection. */
  absolutePath: string;
  sizeBytes: number;
  selectorIndexes: number[];
  roles: WorkspaceCheckTargetRole[];
}

export interface WorkspaceCheckMissingExactTarget {
  path: string;
  selectorIndexes: number[];
  roles: WorkspaceCheckTargetRole[];
}

export interface WorkspaceCheckTargetResolution {
  files: WorkspaceCheckResolvedFile[];
  missingExactTargets: WorkspaceCheckMissingExactTarget[];
  totalBytes: number;
  visitedEntries: number;
}

export type WorkspaceCheckTargetResolutionErrorCode =
  | "INVALID_ROOT"
  | "INVALID_LIMIT"
  | "INVALID_SELECTOR"
  | "UNSAFE_PATH"
  | "RESERVED_PATH"
  | "SYMLINK"
  | "TARGET_NOT_FOUND"
  | "TYPE_MISMATCH"
  | "LIMIT_EXCEEDED"
  | "FILESYSTEM_ERROR";

export class WorkspaceCheckTargetResolutionError extends Error {
  readonly code: WorkspaceCheckTargetResolutionErrorCode;
  readonly targetPath?: string;

  constructor(
    code: WorkspaceCheckTargetResolutionErrorCode,
    message: string,
    options: { targetPath?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspaceCheckTargetResolutionError";
    this.code = code;
    this.targetPath = options.targetPath;
  }
}

export interface ResolveWorkspaceCheckTargetsOptions {
  /** Callers may tighten, but never widen, the resolver's hard limits. */
  limits?: Partial<WorkspaceCheckTargetLimits>;
  signal?: AbortSignal;
}

interface PreparedRoot {
  lexicalRoot: string;
  canonicalRoot: string;
}

interface MutableResolvedFile extends Omit<WorkspaceCheckResolvedFile, "selectorIndexes" | "roles"> {
  selectorIndexes: Set<number>;
  roles: Set<WorkspaceCheckTargetRole>;
}

interface MutableMissingTarget extends Omit<WorkspaceCheckMissingExactTarget, "selectorIndexes" | "roles"> {
  selectorIndexes: Set<number>;
  roles: Set<WorkspaceCheckTargetRole>;
}

interface ResolutionState {
  root: PreparedRoot;
  limits: WorkspaceCheckTargetLimits;
  files: Map<string, MutableResolvedFile>;
  missing: Map<string, MutableMissingTarget>;
  totalBytes: number;
  visitedEntries: number;
  signal?: AbortSignal;
}

/**
 * Resolves one already-normalized Check declaration's targets without reading
 * file contents. Exact targets may remain missing; every other inability to
 * establish a bounded, link-free target set is a resolver error.
 */
export async function resolveWorkspaceCheckTargets(
  workspaceRoot: string,
  targets: readonly WorkspaceCheckTarget[],
  options: ResolveWorkspaceCheckTargetsOptions = {},
): Promise<WorkspaceCheckTargetResolution> {
  const limits = resolvedLimits(options.limits);
  if (!Array.isArray(targets) || targets.length < 1) {
    throw new WorkspaceCheckTargetResolutionError("INVALID_SELECTOR", "At least one explicit Check target is required.");
  }
  if (targets.length > limits.maxSelectors) {
    throw limitError(`Check target count exceeds the ${limits.maxSelectors}-selector limit.`);
  }

  const state: ResolutionState = {
    root: await prepareRoot(workspaceRoot),
    limits,
    files: new Map(),
    missing: new Map(),
    totalBytes: 0,
    visitedEntries: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  for (const [selectorIndex, target] of targets.entries()) {
    throwIfAborted(state.signal);
    const path = safeTargetPath(target?.path);
    const role = target?.role;
    if (role !== "primary" && role !== "reference") {
      throw new WorkspaceCheckTargetResolutionError("INVALID_SELECTOR", `Check target ${selectorIndex + 1} has an invalid role.`, { targetPath: path });
    }
    if (target.kind === "file") {
      await resolveExactFile(state, path, selectorIndex, role);
      continue;
    }
    if (target.kind !== "tree" || typeof target.recursive !== "boolean") {
      throw new WorkspaceCheckTargetResolutionError("INVALID_SELECTOR", `Check target ${selectorIndex + 1} is invalid.`, { targetPath: path });
    }
    const extensions = normalizedExtensions(target.extensions, path);
    await resolveTree(state, path, target.recursive, extensions, selectorIndex, role);
  }

  return {
    files: [...state.files.values()]
      .map((file) => ({
        ...file,
        selectorIndexes: [...file.selectorIndexes].sort((left, right) => left - right),
        roles: sortedRoles(file.roles),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    missingExactTargets: [...state.missing.values()]
      .map((target) => ({
        ...target,
        selectorIndexes: [...target.selectorIndexes].sort((left, right) => left - right),
        roles: sortedRoles(target.roles),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    totalBytes: state.totalBytes,
    visitedEntries: state.visitedEntries,
  };
}

async function prepareRoot(workspaceRoot: string): Promise<PreparedRoot> {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim() || !isAbsolute(workspaceRoot)) {
    throw new WorkspaceCheckTargetResolutionError("INVALID_ROOT", "The Check resolver requires an absolute Space root.");
  }
  const lexicalRoot = resolve(workspaceRoot);
  const info = await checkedLstat(lexicalRoot, "The Space root is unavailable.", "INVALID_ROOT");
  if (info.isSymbolicLink()) {
    throw new WorkspaceCheckTargetResolutionError("SYMLINK", "A Space root used for Checks cannot be a symbolic link or junction.");
  }
  if (!info.isDirectory()) {
    throw new WorkspaceCheckTargetResolutionError("INVALID_ROOT", "The Check resolver Space root must be a directory.");
  }
  const canonicalRoot = await checkedRealpath(lexicalRoot, "The Space root could not be canonicalized.");
  return { lexicalRoot, canonicalRoot };
}

async function resolveExactFile(
  state: ResolutionState,
  path: string,
  selectorIndex: number,
  role: WorkspaceCheckTargetRole,
): Promise<void> {
  const target = await inspectRelativePath(state.root, path, true);
  if (!target) {
    const missing = state.missing.get(path) ?? { path, selectorIndexes: new Set(), roles: new Set() };
    missing.selectorIndexes.add(selectorIndex);
    missing.roles.add(role);
    state.missing.set(path, missing);
    return;
  }
  if (!target.info.isFile()) {
    throw new WorkspaceCheckTargetResolutionError("TYPE_MISMATCH", `Exact Check target is not a regular file: ${path}`, { targetPath: path });
  }
  addFile(state, path, target.absolutePath, target.info, selectorIndex, role);
}

async function resolveTree(
  state: ResolutionState,
  path: string,
  recursive: boolean,
  extensions: ReadonlySet<string>,
  selectorIndex: number,
  role: WorkspaceCheckTargetRole,
): Promise<void> {
  const target = await inspectRelativePath(state.root, path, false);
  if (!target) {
    throw new WorkspaceCheckTargetResolutionError("TARGET_NOT_FOUND", `Check tree target does not exist: ${path}`, { targetPath: path });
  }
  if (!target.info.isDirectory()) {
    throw new WorkspaceCheckTargetResolutionError("TYPE_MISMATCH", `Check tree target is not a directory: ${path}`, { targetPath: path });
  }
  await visitTree(state, target.absolutePath, path, recursive, extensions, selectorIndex, role, 0);
}

async function visitTree(
  state: ResolutionState,
  absoluteDirectory: string,
  relativeDirectory: string,
  recursive: boolean,
  extensions: ReadonlySet<string>,
  selectorIndex: number,
  role: WorkspaceCheckTargetRole,
  depth: number,
): Promise<void> {
  throwIfAborted(state.signal);
  if (depth > state.limits.maxDepth) {
    throw limitError(`Check target traversal exceeds the ${state.limits.maxDepth}-level depth limit.`, relativeDirectory);
  }
  const entries: Dirent[] = [];
  try {
    const directory = await opendir(absoluteDirectory);
    try {
      for await (const entry of directory) {
        if (state.visitedEntries + entries.length + 1 > state.limits.maxVisitedEntries) {
          throw limitError(`Check target traversal exceeds the ${state.limits.maxVisitedEntries}-entry limit.`, relativeDirectory);
        }
        entries.push(entry);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof WorkspaceCheckTargetResolutionError) throw error;
    throw filesystemError(error, `Workspace could not enumerate Check target tree: ${relativeDirectory}`, relativeDirectory);
  }

  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    throwIfAborted(state.signal);
    state.visitedEntries += 1;
    if (state.visitedEntries > state.limits.maxVisitedEntries) {
      throw limitError(`Check target traversal exceeds the ${state.limits.maxVisitedEntries}-entry limit.`, relativeDirectory);
    }
    const path = `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(absoluteDirectory, entry.name);
    assertLexicallyInside(state.root.lexicalRoot, absolutePath, path);
    const info = await checkedLstat(absolutePath, `Workspace could not inspect Check target: ${path}`, "FILESYSTEM_ERROR", path);
    if (info.isSymbolicLink()) {
      throw new WorkspaceCheckTargetResolutionError("SYMLINK", `Check target trees cannot contain symbolic links or junctions: ${path}`, { targetPath: path });
    }
    if (isReservedSegment(entry.name)) continue;
    if (info.isDirectory()) {
      if (!recursive) continue;
      const canonical = await checkedRealpath(absolutePath, `Workspace could not canonicalize Check target directory: ${path}`, path);
      assertCanonicalInside(state.root.canonicalRoot, canonical, path);
      await visitTree(state, absolutePath, path, recursive, extensions, selectorIndex, role, depth + 1);
      continue;
    }
    if (!info.isFile() || !matchesExtension(entry.name, extensions)) continue;
    const canonical = await checkedRealpath(absolutePath, `Workspace could not canonicalize Check target file: ${path}`, path);
    assertCanonicalInside(state.root.canonicalRoot, canonical, path);
    addFile(state, path, absolutePath, info, selectorIndex, role);
  }
}

async function inspectRelativePath(
  root: PreparedRoot,
  path: string,
  allowMissing: boolean,
): Promise<{ absolutePath: string; info: Stats } | null> {
  let cursor = root.lexicalRoot;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    assertLexicallyInside(root.lexicalRoot, cursor, path);
    let info: Stats;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (allowMissing && isMissingError(error)) return null;
      if (isMissingError(error)) return null;
      throw filesystemError(error, `Workspace could not inspect Check target: ${path}`, path);
    }
    if (info.isSymbolicLink()) {
      throw new WorkspaceCheckTargetResolutionError("SYMLINK", `Check targets cannot traverse symbolic links or junctions: ${path}`, { targetPath: path });
    }
    const final = index === segments.length - 1;
    if (!final && !info.isDirectory()) {
      throw new WorkspaceCheckTargetResolutionError("TYPE_MISMATCH", `Check target path traverses a non-directory: ${path}`, { targetPath: path });
    }
  }
  const info = await checkedLstat(cursor, `Workspace could not inspect Check target: ${path}`, "FILESYSTEM_ERROR", path);
  const canonical = await checkedRealpath(cursor, `Workspace could not canonicalize Check target: ${path}`, path);
  assertCanonicalInside(root.canonicalRoot, canonical, path);
  return { absolutePath: cursor, info };
}

function addFile(
  state: ResolutionState,
  path: string,
  absolutePath: string,
  info: Stats,
  selectorIndex: number,
  role: WorkspaceCheckTargetRole,
): void {
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > state.limits.maxFileBytes) {
    throw limitError(`Check target exceeds the ${state.limits.maxFileBytes}-byte per-file limit: ${path}`, path);
  }
  const existing = state.files.get(path);
  if (existing) {
    if (existing.sizeBytes !== info.size) {
      throw new WorkspaceCheckTargetResolutionError("FILESYSTEM_ERROR", `Check target changed during resolution: ${path}`, { targetPath: path });
    }
    existing.selectorIndexes.add(selectorIndex);
    existing.roles.add(role);
    return;
  }
  if (state.files.size >= state.limits.maxFiles) {
    throw limitError(`Resolved Check targets exceed the ${state.limits.maxFiles}-file limit.`, path);
  }
  if (!Number.isSafeInteger(state.totalBytes + info.size) || state.totalBytes + info.size > state.limits.maxTotalBytes) {
    throw limitError(`Resolved Check targets exceed the ${state.limits.maxTotalBytes}-byte total limit.`, path);
  }
  state.files.set(path, {
    path,
    absolutePath,
    sizeBytes: info.size,
    selectorIndexes: new Set([selectorIndex]),
    roles: new Set([role]),
  });
  state.totalBytes += info.size;
}

function safeTargetPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0") || value.includes("\\")) {
    throw new WorkspaceCheckTargetResolutionError("UNSAFE_PATH", "Check targets must use bounded Space-relative paths.");
  }
  if (value === "." || isAbsolute(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new WorkspaceCheckTargetResolutionError("UNSAFE_PATH", "Check targets cannot select the Space root or an absolute path.", { targetPath: value });
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new WorkspaceCheckTargetResolutionError("UNSAFE_PATH", "Check targets must be normalized paths beneath the Space root.", { targetPath: value });
  }
  if (segments.some(isReservedSegment)) {
    throw new WorkspaceCheckTargetResolutionError("RESERVED_PATH", "Check targets cannot select .workspace or .pi material.", { targetPath: value });
  }
  if (segments.some(isUnsafeWindowsPathSegment)) {
    throw new WorkspaceCheckTargetResolutionError("UNSAFE_PATH", "Check targets cannot contain Windows-reserved or ambiguous path segments.", { targetPath: value });
  }
  return segments.join("/");
}

function isUnsafeWindowsPathSegment(segment: string): boolean {
  if (segment.includes(":") || /[. ]$/.test(segment)) return true;
  const stem = segment.split(".", 1)[0]!.toLocaleLowerCase("en-US");
  return stem === "con" || stem === "prn" || stem === "aux" || stem === "nul"
    || /^com[1-9]$/.test(stem) || /^lpt[1-9]$/.test(stem);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkspaceCheckTargetResolutionError("FILESYSTEM_ERROR", String(signal.reason || "Check target resolution was aborted."));
  }
}

function normalizedExtensions(value: unknown, targetPath: string): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new WorkspaceCheckTargetResolutionError("INVALID_SELECTOR", "Check tree targets require explicit extension filters.", { targetPath });
  }
  const extensions = value.map((item) => {
    if (typeof item !== "string" || item.length > 24) {
      throw new WorkspaceCheckTargetResolutionError("INVALID_SELECTOR", "Check tree target contains an invalid extension filter.", { targetPath });
    }
    const extension = item.toLocaleLowerCase("en-US");
    if (!/^\.[a-z0-9][a-z0-9._+-]*$/.test(extension)) {
      throw new WorkspaceCheckTargetResolutionError("INVALID_SELECTOR", "Check tree target contains an invalid extension filter.", { targetPath });
    }
    return extension;
  });
  return new Set(extensions.sort(compareText));
}

function matchesExtension(name: string, extensions: ReadonlySet<string>): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return [...extensions].some((extension) => normalized.endsWith(extension));
}

function resolvedLimits(value: Partial<WorkspaceCheckTargetLimits> | undefined): WorkspaceCheckTargetLimits {
  const result: WorkspaceCheckTargetLimits = { ...workspaceCheckTargetHardLimits };
  if (!value) return result;
  for (const key of Object.keys(result) as Array<keyof WorkspaceCheckTargetLimits>) {
    const requested = value[key];
    if (requested === undefined) continue;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > workspaceCheckTargetHardLimits[key]) {
      throw new WorkspaceCheckTargetResolutionError("INVALID_LIMIT", `Check target ${key} must be a positive integer no greater than the hard limit.`);
    }
    result[key] = requested;
  }
  return result;
}

function sortedRoles(roles: ReadonlySet<WorkspaceCheckTargetRole>): WorkspaceCheckTargetRole[] {
  return [...roles].sort((left, right) => roleOrder(left) - roleOrder(right));
}

function roleOrder(role: WorkspaceCheckTargetRole): number {
  return role === "primary" ? 0 : 1;
}

function isReservedSegment(segment: string): boolean {
  const normalized = segment.toLocaleLowerCase("en-US");
  return normalized === ".workspace" || normalized === ".pi";
}

function assertLexicallyInside(root: string, candidate: string, targetPath: string): void {
  if (!pathContains(root, candidate)) {
    throw new WorkspaceCheckTargetResolutionError("UNSAFE_PATH", "Check target path escapes its Space.", { targetPath });
  }
}

function assertCanonicalInside(root: string, candidate: string, targetPath: string): void {
  if (!pathContains(root, candidate)) {
    throw new WorkspaceCheckTargetResolutionError("UNSAFE_PATH", "Check target resolves outside its Space.", { targetPath });
  }
}

function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function checkedLstat(
  path: string,
  fallback: string,
  code: WorkspaceCheckTargetResolutionErrorCode,
  targetPath?: string,
): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code === "INVALID_ROOT") {
      throw new WorkspaceCheckTargetResolutionError(code, fallback, { targetPath, cause: error });
    }
    throw filesystemError(error, fallback, targetPath);
  }
}

async function checkedRealpath(path: string, fallback: string, targetPath?: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw filesystemError(error, fallback, targetPath);
  }
}

function filesystemError(error: unknown, fallback: string, targetPath?: string): WorkspaceCheckTargetResolutionError {
  if (error instanceof WorkspaceCheckTargetResolutionError) return error;
  return new WorkspaceCheckTargetResolutionError("FILESYSTEM_ERROR", fallback, { targetPath, cause: error });
}

function limitError(message: string, targetPath?: string): WorkspaceCheckTargetResolutionError {
  return new WorkspaceCheckTargetResolutionError("LIMIT_EXCEEDED", message, { targetPath });
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
