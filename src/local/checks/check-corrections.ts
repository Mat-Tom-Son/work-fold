import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { normalizeWorkFoldCheckTargetPath } from "../../shared/checks.js";
import { resolveSpacePath } from "../space.js";

export interface CheckCorrectionProposal {
  kind: "work-fold.check-correction";
  version: 1;
  findingId: string;
  fingerprint: string;
  path: string;
  beforeHash: string;
  replacement: string;
}
export interface CheckCorrectionRecord {
  id: string;
  proposal: CheckCorrectionProposal;
  createdAt: string;
  state: "pending" | "applying" | "applied" | "failed" | "dismissed";
  checkpointId?: string;
  error?: string;
}
export function normalizeCheckCorrection(value: unknown): CheckCorrectionProposal {
  const record = object(value);
  exactKeys(record, ["kind", "version", "findingId", "fingerprint", "path", "beforeHash", "replacement"]);
  if (record.kind !== "work-fold.check-correction" || record.version !== 1) throw new Error("Unsupported Check correction proposal.");
  if (typeof record.replacement !== "string" || Buffer.byteLength(record.replacement, "utf8") > 128 * 1024 || record.replacement.includes("\0") || Buffer.from(record.replacement, "utf8").toString("utf8") !== record.replacement) throw new Error("A correction must contain at most 128 KiB of valid UTF-8 text.");
  return { kind: "work-fold.check-correction", version: 1,
    findingId: text(record.findingId, 160), fingerprint: fingerprint(record.fingerprint),
    path: normalizeWorkFoldCheckTargetPath(record.path), beforeHash: hash(record.beforeHash), replacement: record.replacement };
}
export function normalizeCheckCorrectionRecord(value: unknown): CheckCorrectionRecord {
  const record = object(value);
  const keys = ["id", "proposal", "createdAt", "state"];
  exactKeys(record, [...keys, ...(record.checkpointId !== undefined ? ["checkpointId"] : []), ...(record.error !== undefined ? ["error"] : [])]);
  const proposal = normalizeCheckCorrection(record.proposal);
  if (record.id !== correctionId(proposal)) throw new Error("Check correction identity changed.");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("Invalid correction timestamp.");
  if (record.state !== "pending" && record.state !== "applying" && record.state !== "applied" && record.state !== "failed" && record.state !== "dismissed") throw new Error("Invalid correction state.");
  return { id: record.id, proposal, createdAt: record.createdAt, state: record.state,
    ...(record.checkpointId !== undefined ? { checkpointId: text(record.checkpointId, 160) } : {}),
    ...(record.error !== undefined ? { error: text(record.error, 2000) } : {}) };
}
export function correctionId(proposal: CheckCorrectionProposal): string {
  return `correction-${createHash("sha256").update(JSON.stringify(proposal)).digest("hex")}`;
}
export async function readCheckCorrectionProposal(path: string): Promise<CheckCorrectionProposal> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Correction proposal must be a regular JSON file no larger than 1 MiB.");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1024 * 1024) throw new Error("Correction proposal is oversized.");
    return normalizeCheckCorrection(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
  } finally { await handle.close(); }
}

/** Writes only through the handle whose exact bytes were reviewed. The caller
 * holds the Space History/ownership lease and has journaled a safety checkpoint. */
export async function writeCheckCorrection(root: string, proposal: CheckCorrectionProposal): Promise<void> {
  const absolute = resolveSpacePath(root, proposal.path);
  const handle = await open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024) throw new Error("Correction target must be an ordinary unlinked text file no larger than 128 KiB.");
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const named = await lstat(resolveSpacePath(root, proposal.path));
    const current = await handle.stat();
    if (length !== before.size || [named, current].some((info) => !info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs)
      || createHash("sha256").update(buffer.subarray(0, length)).digest("hex") !== proposal.beforeHash) throw new Error("The file changed since this correction was prepared. Ask for a fresh correction.");
    const bytes = Buffer.from(proposal.replacement, "utf8");
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
      if (!bytesWritten) throw new Error("Correction write made no progress.");
      written += bytesWritten;
    }
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally { await handle.close(); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Correction must be an object.");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error("Correction contains missing or unknown fields.");
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("Invalid correction text field.");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Correction requires an exact SHA-256 fingerprint.");
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^finding-[a-f0-9]{32}$/.test(value)) throw new Error("Correction requires an exact finding fingerprint.");
  return value;
}
