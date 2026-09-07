import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname } from "node:path";
import { getSpace, nestedRegisteredSpacePaths, resolveSpacePath } from "./space.js";
import { isSpaceIgnored, readSpaceIgnoreState } from "./space-ignore.js";

export const remoteFilePreviewLimits = Object.freeze({ textBytes: 256 * 1024, imageBytes: 1024 * 1024 });

export type RemoteFilePreview = {
  spaceId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  readAt: string;
} & (
  | { kind: "text"; text: string; format: "markdown" | "text"; truncated: boolean; previewDigest: string }
  | { kind: "image"; mediaType: string; base64: string; previewDigest: string }
  | { kind: "none"; reason: "binary" | "too-large" }
);

const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
};

/** Explicit approved-browser read. This is not a publication or an app file grant. */
export async function readRemoteFilePreview(spaceId: string, relativePath: string): Promise<RemoteFilePreview> {
  const space = await getSpace(spaceId);
  const currentPath = () => remoteVisiblePath(spaceId, relativePath, space.spaceRoot);
  let handle;
  try {
    const path = await currentPath();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw unavailable();
    // A substituted FIFO must never stall the desktop, nor may a link redirect the read.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw unavailable();
    const extension = extname(relativePath).toLowerCase();
    const mediaType = imageTypes[extension];
    const base = { spaceId, path: relativePath, sizeBytes: opened.size, modifiedAt: opened.mtime.toISOString(), readAt: new Date().toISOString() };
    let result: RemoteFilePreview;
    if (mediaType && opened.size > remoteFilePreviewLimits.imageBytes) {
      result = { ...base, kind: "none", reason: "too-large" };
    } else {
      const limit = mediaType ? remoteFilePreviewLimits.imageBytes : remoteFilePreviewLimits.textBytes;
      const bytes = Buffer.alloc(Math.min(opened.size, limit));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw unavailable();
        offset += read.bytesRead;
      }
      const previewDigest = createHash("sha256").update(bytes).digest("hex");
      if (mediaType) result = { ...base, kind: "image", mediaType, base64: bytes.toString("base64"), previewDigest };
      else {
        const truncated = opened.size > limit;
        let text: string | null = null;
        if (!looksBinary(bytes)) {
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }); } catch { /* Invalid UTF-8 is not a text preview. */ }
        }
        result = text === null ? { ...base, kind: "none", reason: "binary" }
          : { ...base, kind: "text", text, format: /\.(md|markdown)$/i.test(relativePath) ? "markdown" : "text", truncated, previewDigest };
      }
    }
    // Recheck the open file and the current registered path before any bytes can leave.
    if (!sameFile(opened, await handle.stat()) || await currentPath() !== path || !sameFile(opened, await lstat(path))) throw unavailable();
    return result;
  } catch { throw unavailable(); }
  finally { await handle?.close(); }
}

/** Metadata-only admission for task result links. Opening the link performs a fresh bounded read. */
export async function isRemoteFileVisible(spaceId: string, relativePath: string): Promise<boolean> {
  try {
    const space = await getSpace(spaceId);
    const path = await remoteVisiblePath(spaceId, relativePath, space.spaceRoot);
    const file = await lstat(path);
    return file.isFile() && !file.isSymbolicLink() && await remoteVisiblePath(spaceId, relativePath, space.spaceRoot) === path;
  } catch { return false; }
}

async function remoteVisiblePath(spaceId: string, relativePath: string, expectedRoot: string): Promise<string> {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 2048
    || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relativePath)
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw unavailable();
  const current = await getSpace(spaceId);
  if (current.spaceRoot !== expectedRoot) throw unavailable();
  const path = resolveSpacePath(expectedRoot, relativePath);
  const [ignore, nested] = await Promise.all([readSpaceIgnoreState(expectedRoot), nestedRegisteredSpacePaths(expectedRoot)]);
  if (isSpaceIgnored(relativePath, ignore.patterns) || nested.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))) throw unavailable();
  return path;
}

function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function looksBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  let controls = 0;
  for (const byte of bytes) if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  return bytes.length > 0 && controls / bytes.length > 0.1;
}
function unavailable(): Error & { statusCode: number } {
  return Object.assign(new Error("This file is unavailable, changed, or is outside this Space's visible files."), { statusCode: 404 });
}
