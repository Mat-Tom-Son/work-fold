import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  parseRestrictedAppManifest,
  type RestrictedAppManifest,
} from "./restricted-app-manifest.js";
import {
  hashAppPlatformArtifact,
  parseAppPlatformArtifactDigest,
  type AppPlatformArtifactDigest,
  type AppPlatformArtifactEntry,
} from "./app-platform-artifact.js";
import { isReservedSpacePathSegment } from "../space-path-policy.js";
export const restrictedAppPackageLimits = {
  files: 2_048,
  bytes: 50 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  manifestBytes: 512 * 1024,
  depth: 24,
} as const;

const forbiddenPackageFields = [
  "scripts",
  "bin",
  "workspaces",
  "gypfile",
  "pi",
] as const;

export interface RestrictedAppPackageInspection {
  sourceRoot: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
  manifest: RestrictedAppManifest;
  files: string[];
  totalBytes: number;
  digest: string;
  artifactDigest: AppPlatformArtifactDigest;
}

export interface RestrictedAppStageReceipt {
  id: string;
  packageName: string;
  version: string;
  digest: string;
  artifactDigest: AppPlatformArtifactDigest;
  stagedRoot: string;
  fileCount: number;
  totalBytes: number;
  manifest: RestrictedAppManifest;
}

export interface RestrictedAppPackageSnapshot {
  receipt: RestrictedAppStageReceipt;
  files: ReadonlyMap<string, Uint8Array>;
}

export interface RestrictedAppReleaseArtifactEntry {
  readonly path: string;
  readonly bytesBase64: string;
}

export interface RestrictedAppPackageInspectionHooks {
  /** Deterministic race injection for boundary tests; production callers omit it. */
  afterCollection?(): void | Promise<void>;
}

/**
 * Validate a prebuilt browser app package without importing its code, invoking
 * npm, resolving dependencies, or running package lifecycle scripts.
 */
export async function inspectRestrictedAppPackage(
  sourceRoot: string,
  hooks: RestrictedAppPackageInspectionHooks = {},
): Promise<RestrictedAppPackageInspection> {
  const root = resolve(sourceRoot);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Restricted app package root must be a regular directory, not a link.");
  }

  const entries = await collectPackageFiles(root);
  await hooks.afterCollection?.();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const packageEntry = byPath.get("package.json");
  if (!packageEntry) throw new Error("Restricted app package must contain package.json.");
  if (packageEntry.size > 64 * 1024) throw new Error("Restricted app package.json exceeds the 64 KB limit.");

  const initialPackageJson = jsonObject(
    Buffer.from(await readExactPackageFile(packageEntry, "package")).toString("utf8"),
    "Restricted app package.json",
  );
  const initialManifestPath = packagePathValue(initialPackageJson.agentApp, "Restricted app package agentApp");
  const initialManifestEntry = byPath.get(initialManifestPath);
  if (!initialManifestEntry) throw new Error(`Restricted app manifest does not exist: ${initialManifestPath}`);
  if (initialManifestEntry.size > restrictedAppPackageLimits.manifestBytes) {
    throw new Error(`Restricted app manifest exceeds the ${restrictedAppPackageLimits.manifestBytes / 1024} KB limit.`);
  }

  const snapshot = await readPackageEntries(entries, "package");
  const packageJson = jsonObject(snapshotText(snapshot.files, "package.json", "Restricted app package.json"), "Restricted app package.json");
  for (const field of forbiddenPackageFields) {
    if (field in packageJson) throw new Error(`Restricted app package.json cannot declare ${field}.`);
  }
  const packageName = packageNameValue(packageJson.name);
  const packageVersion = packageVersionValue(packageJson.version);
  if (packageJson.type !== "module") throw new Error('Restricted app package.json must set type to "module".');
  const manifestPath = packagePathValue(packageJson.agentApp, "Restricted app package agentApp");
  if (manifestPath !== initialManifestPath) throw new Error("Restricted app package.json changed during inspection.");
  const manifestEntry = byPath.get(manifestPath);
  if (!manifestEntry) throw new Error(`Restricted app manifest does not exist: ${manifestPath}`);
  if (manifestEntry.size > restrictedAppPackageLimits.manifestBytes) {
    throw new Error(`Restricted app manifest exceeds the ${restrictedAppPackageLimits.manifestBytes / 1024} KB limit.`);
  }

  const manifest = parseRestrictedAppManifest(jsonObject(
    snapshotText(snapshot.files, manifestPath, "Restricted app manifest"),
    "Restricted app manifest",
  ));
  requirePackageFile(byPath, manifest.runtime.entry, "Restricted app UI entry");
  if (manifest.runtime.worker) requirePackageFile(byPath, manifest.runtime.worker, "Restricted app worker entry");

  return {
    sourceRoot: root,
    packageName,
    packageVersion,
    manifestPath,
    manifest,
    files: entries.map((entry) => entry.path),
    totalBytes: snapshot.totalBytes,
    digest: snapshot.digest,
    artifactDigest: snapshot.artifactDigest,
  };
}

/**
 * Copy an inspected package into immutable content-addressed app data. The
 * staged copy is inspected again and must have the same digest before it can
 * be returned to the sandbox host.
 */
export async function stageRestrictedAppPackage(
  sourceRoot: string,
  stagingRoot: string,
  expectedDigest?: string,
): Promise<RestrictedAppStageReceipt> {
  const source = await inspectRestrictedAppPackage(sourceRoot);
  if (expectedDigest !== undefined && source.digest !== expectedDigest) {
    throw new Error("Restricted app package changed after review.");
  }
  const root = resolve(stagingRoot);
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Restricted app staging root must be a regular directory, not a link.");
  }
  const destination = join(root, source.digest);
  if (await isDirectory(destination)) {
    const existing = await inspectRestrictedAppPackage(destination);
    if (existing.digest !== source.digest) throw new Error("Restricted app staging destination does not match its content digest.");
    return stageReceipt(existing, destination);
  }

  const temporary = join(root, `.staging-${randomUUID()}`);
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const packagePath of source.files) {
      const from = join(source.sourceRoot, ...packagePath.split("/"));
      const to = join(temporary, ...packagePath.split("/"));
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o600);
      await syncRestrictedAppFile(to);
    }
    const staged = await inspectRestrictedAppPackage(temporary);
    if (staged.digest !== source.digest) throw new Error("Restricted app package changed while it was being staged.");
    if (expectedDigest !== undefined && staged.digest !== expectedDigest) throw new Error("Restricted app package changed after review.");
    await syncRestrictedAppPackageDirectories(temporary, staged.files);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!await isDirectory(destination)) throw error;
    }
    await syncRestrictedAppDirectory(root);
    const installed = await inspectRestrictedAppPackage(destination);
    if (installed.digest !== source.digest) throw new Error("Restricted app staged digest does not match its install receipt.");
    return stageReceipt(installed, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Materialize one already-verified App Release Feature artifact into the
 * restricted-app package store. Release bytes are still treated as hostile at
 * this boundary: paths, base64, package declarations, and both content digests
 * are revalidated before a receipt can be returned.
 */
export async function stageRestrictedAppReleaseArtifact(
  entries: readonly RestrictedAppReleaseArtifactEntry[],
  expectedArtifactDigest: AppPlatformArtifactDigest,
  stagingRoot: string,
): Promise<RestrictedAppStageReceipt> {
  const expected = parseAppPlatformArtifactDigest(expectedArtifactDigest);
  const decoded = decodeReleaseArtifactEntries(entries);
  if (hashAppPlatformArtifact(decoded, {
    files: restrictedAppPackageLimits.files,
    pathBytes: 240,
    fileBytes: restrictedAppPackageLimits.fileBytes,
    totalBytes: restrictedAppPackageLimits.bytes,
  }) !== expected) {
    throw new Error("Restricted app release artifact digest does not match its entries.");
  }
  assertMaterializablePackagePaths(decoded.map((entry) => entry.path));

  const root = resolve(stagingRoot);
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Restricted app staging root must be a regular directory, not a link.");
  }

  const temporary = join(root, `.release-${randomUUID()}`);
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    let fileCount = 0;
    let totalBytes = 0;
    for (const entry of decoded) {
      fileCount += 1;
      totalBytes += entry.bytes.byteLength;
      if (fileCount > restrictedAppPackageLimits.files) {
        throw new Error("Restricted app release artifact exceeds the file-count limit while being written.");
      }
      if (entry.bytes.byteLength > restrictedAppPackageLimits.fileBytes) {
        throw new Error(`Restricted app release artifact file exceeds the per-file limit: ${entry.path}`);
      }
      if (totalBytes > restrictedAppPackageLimits.bytes) {
        throw new Error("Restricted app release artifact exceeds the total-size limit while being written.");
      }

      const destination = join(temporary, ...entry.path.split("/"));
      assertContainedPath(temporary, destination);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(entry.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    const materialized = await inspectRestrictedAppPackage(temporary);
    if (materialized.artifactDigest !== expected) {
      throw new Error("Restricted app release artifact changed while it was being materialized.");
    }
    await syncRestrictedAppPackageDirectories(temporary, materialized.files);
    const receipt = await stageRestrictedAppPackage(temporary, root, materialized.digest);
    if (receipt.artifactDigest !== expected) {
      throw new Error("Restricted app staged artifact digest does not match the verified App Release.");
    }
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Read and hash every staged byte exactly once before a sandbox launch. */
export async function snapshotRestrictedAppPackage(receipt: RestrictedAppStageReceipt): Promise<RestrictedAppPackageSnapshot> {
  const root = resolve(receipt.stagedRoot);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Restricted app staged root is not a regular directory.");
  const entries = await collectPackageFiles(root);
  const snapshot = await readPackageEntries(entries, "staged package");
  const files = snapshot.files;
  if (snapshot.digest !== receipt.digest || snapshot.artifactDigest !== receipt.artifactDigest
    || entries.length !== receipt.fileCount || snapshot.totalBytes !== receipt.totalBytes) {
    throw new Error("Restricted app staged bytes do not match the install receipt.");
  }
  const packageJson = jsonObject(snapshotText(files, "package.json", "Restricted app staged package.json"), "Restricted app staged package.json");
  for (const field of forbiddenPackageFields) {
    if (field in packageJson) throw new Error(`Restricted app staged package.json cannot declare ${field}.`);
  }
  if (packageNameValue(packageJson.name) !== receipt.packageName || packageVersionValue(packageJson.version) !== receipt.version || packageJson.type !== "module") {
    throw new Error("Restricted app staged package identity does not match the install receipt.");
  }
  const manifestPath = packagePathValue(packageJson.agentApp, "Restricted app staged package agentApp");
  const manifest = parseRestrictedAppManifest(jsonObject(snapshotText(files, manifestPath, "Restricted app staged manifest"), "Restricted app staged manifest"));
  if (manifest.id !== receipt.id || JSON.stringify(manifest) !== JSON.stringify(receipt.manifest) || !files.has(manifest.runtime.entry)
    || Boolean(manifest.runtime.worker && !files.has(manifest.runtime.worker))) {
    throw new Error("Restricted app staged manifest does not match the install receipt.");
  }
  return { receipt: { ...receipt, manifest: structuredClone(receipt.manifest) }, files };
}

interface PackageFile {
  path: string;
  absolutePath: string;
  size: number;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

async function collectPackageFiles(root: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];
  let totalBytes = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > restrictedAppPackageLimits.depth) throw new Error("Restricted app package exceeds the directory depth limit.");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const packagePath = relative(root, absolutePath).split(sep).join("/");
      assertContainedPath(root, absolutePath);
      assertPortablePackagePath(packagePath, "Restricted app package path");
      if (entry.isSymbolicLink()) throw new Error(`Restricted app package cannot contain links: ${packagePath}`);
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Restricted app package can contain only regular files and directories: ${packagePath}`);
      const fileStat = await lstat(absolutePath, { bigint: true });
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error(`Restricted app package file is not regular: ${packagePath}`);
      if (fileStat.size > BigInt(restrictedAppPackageLimits.fileBytes)) throw new Error(`Restricted app package file exceeds the per-file limit: ${packagePath}`);
      const size = Number(fileStat.size);
      files.push({
        path: packagePath,
        absolutePath,
        size,
        dev: fileStat.dev,
        ino: fileStat.ino,
        ctimeNs: fileStat.ctimeNs,
        mtimeNs: fileStat.mtimeNs,
      });
      totalBytes += size;
      if (files.length > restrictedAppPackageLimits.files) throw new Error("Restricted app package exceeds the file-count limit.");
      if (totalBytes > restrictedAppPackageLimits.bytes) throw new Error("Restricted app package exceeds the total-size limit.");
    }
  }
  await visit(root, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readPackageEntries(
  entries: readonly PackageFile[],
  label: string,
): Promise<{
  files: Map<string, Uint8Array>;
  totalBytes: number;
  digest: string;
  artifactDigest: AppPlatformArtifactDigest;
}> {
  const files = new Map<string, Uint8Array>();
  const digest = createHash("sha256");
  const artifactEntries: Array<{ path: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const bytes = await readExactPackageFile(entry, label);
    totalBytes += bytes.byteLength;
    if (totalBytes > restrictedAppPackageLimits.bytes) {
      throw new Error(`Restricted app ${label} exceeds the total-size limit.`);
    }
    digest.update(`${Buffer.byteLength(entry.path)}:${entry.path}:${bytes.byteLength}:`);
    digest.update(bytes);
    files.set(entry.path, bytes);
    artifactEntries.push({ path: entry.path, bytes });
  }
  return {
    files,
    totalBytes,
    digest: digest.digest("hex"),
    artifactDigest: hashAppPlatformArtifact(artifactEntries),
  };
}

async function readExactPackageFile(entry: PackageFile, label: string): Promise<Uint8Array> {
  const handle = await open(entry.absolutePath, constants.O_RDONLY);
  try {
    const before = await handle.stat({ bigint: true });
    assertSamePackageFile(entry, before, label);
    const allocation = Buffer.allocUnsafe(entry.size + 1);
    let offset = 0;
    while (offset < allocation.byteLength) {
      const { bytesRead } = await handle.read(allocation, offset, allocation.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    assertSamePackageFile(entry, after, label);
    if (offset !== entry.size) throw new Error(`Restricted app ${label} file changed while it was being read: ${entry.path}`);
    return allocation.subarray(0, entry.size);
  } finally {
    await handle.close();
  }
}

function decodeReleaseArtifactEntries(
  values: readonly RestrictedAppReleaseArtifactEntry[],
): AppPlatformArtifactEntry[] {
  if (!Array.isArray(values)) throw new Error("Restricted app release artifact entries must be an array.");
  if (values.length > restrictedAppPackageLimits.files) {
    throw new Error("Restricted app release artifact exceeds the file-count limit.");
  }

  const decoded: AppPlatformArtifactEntry[] = [];
  let totalBytes = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value: unknown = values[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Restricted app release artifact entry ${index + 1} must be an object.`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !Object.hasOwn(record, "path") || !Object.hasOwn(record, "bytesBase64")) {
      throw new Error(`Restricted app release artifact entry ${index + 1} must contain only path and bytesBase64.`);
    }
    if (typeof record.path !== "string") {
      throw new Error(`Restricted app release artifact entry ${index + 1} path must be a string.`);
    }
    assertPortablePackagePath(record.path, `Restricted app release artifact entry ${index + 1} path`);
    const bytes = decodeCanonicalBase64(
      record.bytesBase64,
      `Restricted app release artifact entry ${index + 1}`,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > restrictedAppPackageLimits.bytes) {
      throw new Error("Restricted app release artifact exceeds the total-size limit.");
    }
    decoded.push({ path: record.path, bytes });
  }
  return decoded;
}

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeCanonicalBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0
    || value.length > Math.ceil(restrictedAppPackageLimits.fileBytes / 3) * 4
    || !canonicalBase64Pattern.test(value)) {
    throw new Error(`${label} bytesBase64 must be canonical RFC 4648 base64.`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const expectedBytes = (value.length / 4) * 3 - padding;
  if (expectedBytes > restrictedAppPackageLimits.fileBytes) {
    throw new Error(`${label} exceeds the per-file limit.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} bytesBase64 must be canonical RFC 4648 base64.`);
  }
  return new Uint8Array(decoded);
}

function assertMaterializablePackagePaths(paths: readonly string[]): void {
  const nodes = new Map<string, { path: string; kind: "directory" | "file" }>();
  for (const path of paths) {
    const segments = path.split("/");
    if (segments.length - 1 > restrictedAppPackageLimits.depth) {
      throw new Error("Restricted app release artifact exceeds the directory depth limit.");
    }
    for (let index = 1; index <= segments.length; index += 1) {
      const nodePath = segments.slice(0, index).join("/");
      const kind = index === segments.length ? "file" : "directory";
      const key = nodePath.toLocaleLowerCase("en-US");
      const existing = nodes.get(key);
      if (existing) {
        if (existing.kind !== kind) {
          throw new Error(`Restricted app release artifact path conflicts with a file ancestor: ${path}`);
        }
        if (existing.path !== nodePath) {
          throw new Error(`Restricted app release artifact paths collide on portable filesystems: ${path}`);
        }
      } else {
        nodes.set(key, { path: nodePath, kind });
      }
    }
  }
}

function assertSamePackageFile(
  entry: PackageFile,
  stat: BigIntStats,
  label: string,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(entry.size)
    || stat.dev !== entry.dev || stat.ino !== entry.ino
    || stat.ctimeNs !== entry.ctimeNs || stat.mtimeNs !== entry.mtimeNs) {
    throw new Error(`Restricted app ${label} file changed after enumeration: ${entry.path}`);
  }
}

function requirePackageFile(files: Map<string, PackageFile>, path: string, label: string): PackageFile {
  const file = files.get(path);
  if (!file) throw new Error(`${label} does not exist: ${path}`);
  return file;
}

function packageNameValue(value: unknown): string {
  if (typeof value !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(value)) {
    throw new Error("Restricted app package name is invalid.");
  }
  return value;
}

function packageVersionValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Restricted app package version must be a simple semantic version.");
  }
  return value;
}

function packagePathValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a portable relative package path.`);
  assertPortablePackagePath(value, label);
  if (!value.toLowerCase().endsWith(".json")) throw new Error(`${label} must name a JSON file.`);
  return value;
}

function assertPortablePackagePath(value: string, label: string): void {
  const segments = value.split("/");
  if (!value || value.length > 240 || value.includes("\\") || value.includes(":") || value.includes("\0")
    || value.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === ".."
      || isReservedSpacePathSegment(segment) || isReservedWindowsName(segment))) {
    throw new Error(`${label} must be a portable relative package path.`);
  }
}

function jsonObject(source: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function snapshotText(files: ReadonlyMap<string, Uint8Array>, path: string, label: string): string {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`${label} is missing.`);
  return Buffer.from(bytes).toString("utf8");
}

function assertContainedPath(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || resolve(root, child) !== resolve(candidate)) {
    throw new Error("Restricted app package path escapes its root.");
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    return !value.isSymbolicLink() && value.isDirectory();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncRestrictedAppFile(path: string): Promise<void> {
  // Windows requires a writable file handle for FlushFileBuffers even though
  // this operation does not change the staged bytes.
  const handle = await open(path, constants.O_RDWR);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncRestrictedAppPackageDirectories(root: string, packagePaths: readonly string[]): Promise<void> {
  const directories = new Set<string>([root]);
  for (const packagePath of packagePaths) {
    const segments = packagePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(join(root, ...segments.slice(0, index)));
    }
  }
  const deepestFirst = [...directories].sort((left, right) => {
    const leftRelative = relative(root, left);
    const rightRelative = relative(root, right);
    const leftDepth = leftRelative ? leftRelative.split(sep).length : 0;
    const rightDepth = rightRelative ? rightRelative.split(sep).length : 0;
    const depthDifference = rightDepth - leftDepth;
    return depthDifference || right.localeCompare(left);
  });
  for (const directory of deepestFirst) await syncRestrictedAppDirectory(directory);
}

async function syncRestrictedAppDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM" && code !== "ENOTSUP") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function stageReceipt(inspection: RestrictedAppPackageInspection, stagedRoot: string): RestrictedAppStageReceipt {
  return {
    id: inspection.manifest.id,
    packageName: inspection.packageName,
    version: inspection.packageVersion,
    digest: inspection.digest,
    artifactDigest: inspection.artifactDigest,
    stagedRoot,
    fileCount: inspection.files.length,
    totalBytes: inspection.totalBytes,
    manifest: inspection.manifest,
  };
}

function isReservedWindowsName(segment: string): boolean {
  const stem = segment.split(".")[0]?.toUpperCase();
  return stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/.test(stem ?? "") || /^LPT[1-9]$/.test(stem ?? "")
    || segment.endsWith(".") || segment.endsWith(" ");
}
