import { createHash } from "node:crypto";

export const appPlatformArtifactFormat = "work-fold.artifact.v1" as const;
export const appPlatformArtifactHashAlgorithm = "sha256" as const;

export const appPlatformArtifactDefaultLimits = {
  files: 2_048,
  pathBytes: 240,
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
} as const;

export interface AppPlatformArtifactEntry {
  path: string;
  bytes: Uint8Array;
}

export interface AppPlatformArtifactLimits {
  files?: number;
  pathBytes?: number;
  fileBytes?: number;
  totalBytes?: number;
}

export type AppPlatformArtifactDigest =
  `${typeof appPlatformArtifactFormat}:${typeof appPlatformArtifactHashAlgorithm}:${string}`;

const artifactDigestPattern = /^work-fold.artifact.v1:sha256:[0-9a-f]{64}$/;

export function parseAppPlatformArtifactDigest(value: unknown): AppPlatformArtifactDigest {
  if (typeof value !== "string" || !artifactDigestPattern.test(value)) {
    throw new AppPlatformArtifactError(
      "ARTIFACT_INVALID",
      "Artifact digest must use work-fold.artifact.v1 with a lowercase SHA-256 value.",
    );
  }
  return value as AppPlatformArtifactDigest;
}

export type AppPlatformArtifactErrorCode =
  | "ARTIFACT_INVALID"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "ARTIFACT_PATH_DUPLICATE"
  | "ARTIFACT_PATH_INVALID";

export class AppPlatformArtifactError extends Error {
  constructor(
    readonly code: AppPlatformArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppPlatformArtifactError";
  }
}

const encoder = new TextEncoder();
const artifactMagic = encoder.encode("work-fold.artifact");
const artifactVersion = 1;
const maximumUint32 = 0xffff_ffff;

interface NormalizedArtifactEntry {
  path: string;
  pathBytes: Uint8Array;
  bytes: Uint8Array;
}

interface NormalizedLimits {
  files: number;
  pathBytes: number;
  fileBytes: number;
  totalBytes: number;
}

/**
 * Hash a complete logical artifact using the work-fold.artifact.v1 framing.
 *
 * The SHA-256 preimage is exactly:
 *
 *   18 bytes  ASCII "work-fold.artifact" magic
 *    4 bytes  unsigned big-endian format version (1)
 *    4 bytes  unsigned big-endian file count
 *   repeated for each file in bytewise UTF-8 path order:
 *    4 bytes  unsigned big-endian UTF-8 path length
 *    N bytes  UTF-8 path
 *    8 bytes  unsigned big-endian content length
 *    M bytes  raw content
 *
 * Artifact paths are the only strings this contract NFC-constrains. Callers
 * must supply paths already in NFC; this function rejects rather than silently
 * rewriting them. Other declarations and user strings do not inherit a Unicode
 * normalization rule from this artifact-path contract. Path ordering is an
 * unsigned bytewise comparison of the NFC UTF-8 bytes, independent of locale
 * and filesystem behavior. Case-distinct paths remain distinct.
 */
export function hashAppPlatformArtifact(
  entries: Iterable<AppPlatformArtifactEntry>,
  limits: AppPlatformArtifactLimits = {},
): AppPlatformArtifactDigest {
  if (!entries || typeof entries[Symbol.iterator] !== "function") {
    throw new AppPlatformArtifactError("ARTIFACT_INVALID", "Artifact entries must be an iterable.");
  }

  const bounded = normalizeLimits(limits);
  const normalized: NormalizedArtifactEntry[] = [];
  let totalBytes = 0;

  for (const [index, entry] of enumerate(entries)) {
    if (normalized.length >= bounded.files) {
      throw new AppPlatformArtifactError(
        "ARTIFACT_LIMIT_EXCEEDED",
        `Artifact cannot contain more than ${bounded.files} files.`,
      );
    }
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string"
      || !(entry.bytes instanceof Uint8Array)) {
      throw new AppPlatformArtifactError(
        "ARTIFACT_INVALID",
        `Artifact entry ${index + 1} must contain a string path and Uint8Array bytes.`,
      );
    }

    const pathBytes = artifactPathBytes(entry.path, bounded.pathBytes);
    if (entry.bytes.byteLength > bounded.fileBytes) {
      throw new AppPlatformArtifactError(
        "ARTIFACT_LIMIT_EXCEEDED",
        `Artifact file exceeds the ${bounded.fileBytes}-byte per-file limit: ${entry.path}`,
      );
    }
    if (totalBytes > bounded.totalBytes - entry.bytes.byteLength) {
      throw new AppPlatformArtifactError(
        "ARTIFACT_LIMIT_EXCEEDED",
        `Artifact content exceeds the ${bounded.totalBytes}-byte total limit.`,
      );
    }
    totalBytes += entry.bytes.byteLength;
    normalized.push({
      path: entry.path,
      pathBytes,
      bytes: new Uint8Array(entry.bytes),
    });
  }

  normalized.sort((left, right) => compareBytes(left.pathBytes, right.pathBytes));
  for (let index = 1; index < normalized.length; index += 1) {
    if (compareBytes(normalized[index - 1]!.pathBytes, normalized[index]!.pathBytes) === 0) {
      throw new AppPlatformArtifactError(
        "ARTIFACT_PATH_DUPLICATE",
        `Artifact path is duplicated after NFC validation: ${normalized[index]!.path}`,
      );
    }
  }

  const hash = createHash(appPlatformArtifactHashAlgorithm);
  hash.update(artifactMagic);
  hash.update(unsigned32(artifactVersion));
  hash.update(unsigned32(normalized.length));
  for (const entry of normalized) {
    hash.update(unsigned32(entry.pathBytes.byteLength));
    hash.update(entry.pathBytes);
    hash.update(unsigned64(entry.bytes.byteLength));
    hash.update(entry.bytes);
  }
  return `${appPlatformArtifactFormat}:${appPlatformArtifactHashAlgorithm}:${hash.digest("hex")}`;
}

function normalizeLimits(value: AppPlatformArtifactLimits): NormalizedLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppPlatformArtifactError("ARTIFACT_INVALID", "Artifact limits must be an object.");
  }
  const unknown = Object.keys(value).find((key) => !["files", "pathBytes", "fileBytes", "totalBytes"].includes(key));
  if (unknown) {
    throw new AppPlatformArtifactError("ARTIFACT_INVALID", `Artifact limits contain unsupported field ${unknown}.`);
  }
  return {
    files: limitValue(value.files, appPlatformArtifactDefaultLimits.files, "file count", 0, maximumUint32),
    pathBytes: limitValue(value.pathBytes, appPlatformArtifactDefaultLimits.pathBytes, "path", 1, maximumUint32),
    fileBytes: limitValue(value.fileBytes, appPlatformArtifactDefaultLimits.fileBytes, "file bytes", 0, Number.MAX_SAFE_INTEGER),
    totalBytes: limitValue(value.totalBytes, appPlatformArtifactDefaultLimits.totalBytes, "total bytes", 0, Number.MAX_SAFE_INTEGER),
  };
}

function limitValue(
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AppPlatformArtifactError(
      "ARTIFACT_INVALID",
      `Artifact ${label} limit must be a safe integer from ${minimum} through ${maximum}.`,
    );
  }
  return result;
}

function artifactPathBytes(path: string, maximumBytes: number): Uint8Array {
  if (!path || path.includes("\\") || /[:<>"|?*\u0000-\u001f\u007f]/u.test(path) || path.startsWith("/")) {
    throw invalidPath(path);
  }
  assertUnicodeScalarString(path);
  if (path.normalize("NFC") !== path) {
    throw new AppPlatformArtifactError(
      "ARTIFACT_PATH_INVALID",
      `Artifact path must already be NFC and must not rely on normalization: ${printablePath(path)}`,
    );
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isReservedWindowsSegment(segment))) {
    throw invalidPath(path);
  }
  const bytes = encoder.encode(path);
  if (bytes.byteLength > maximumBytes) {
    throw new AppPlatformArtifactError(
      "ARTIFACT_LIMIT_EXCEEDED",
      `Artifact path exceeds the ${maximumBytes}-byte UTF-8 limit: ${printablePath(path)}`,
    );
  }
  return bytes;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new AppPlatformArtifactError(
          "ARTIFACT_PATH_INVALID",
          `Artifact path contains a lone Unicode surrogate: ${printablePath(value)}`,
        );
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new AppPlatformArtifactError(
        "ARTIFACT_PATH_INVALID",
        `Artifact path contains a lone Unicode surrogate: ${printablePath(value)}`,
      );
    }
  }
}

function isReservedWindowsSegment(segment: string): boolean {
  const stem = segment.split(".")[0]!.toUpperCase();
  return stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/.test(stem) || /^LPT[1-9]$/.test(stem)
    || segment.endsWith(".") || segment.endsWith(" ");
}

function invalidPath(path: string): AppPlatformArtifactError {
  return new AppPlatformArtifactError(
    "ARTIFACT_PATH_INVALID",
    `Artifact path must be a portable relative path with safe segments: ${printablePath(path)}`,
  );
}

function printablePath(path: string): string {
  return JSON.stringify(path);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.byteLength - right.byteLength;
}

function unsigned32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function unsigned64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function* enumerate<T>(values: Iterable<T>): Generator<[number, T]> {
  let index = 0;
  for (const value of values) {
    yield [index, value];
    index += 1;
  }
}
