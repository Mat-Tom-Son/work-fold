import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  assertWorkFoldRoutingAtAdmissionHorizon,
  contentAddressedWorkFoldRoutingDeclaration,
  normalizeWorkFoldRoutingProposal,
  readWorkFoldRoutingDocument,
  workFoldRoutingDocumentMaxBytes,
  workFoldRoutingProposalFileSuffix,
  type WorkFoldRoutingDeclaration,
} from "./routing-declarations.js";

/**
 * Pending routing proposals (docs/fold-routings.md, "Where routings live in
 * the product"): the work-fold agent writes inert `*.work-fold-routing.json`
 * files at the top level of its management working folder, and Settings →
 * Automations lists them so a person can turn one on without the terminal.
 * The scan reads only that one folder, never recurses, and is bounded in
 * both file count and per-file size. A scanned file carries no authority:
 * turning it on re-reads the exact file through the same enable path as the
 * CLI, which pins its digest at that moment.
 */
export const workFoldRoutingProposalScanBounds = Object.freeze({
  maxFiles: 64,
  maxFileBytes: workFoldRoutingDocumentMaxBytes,
});

export type WorkFoldRoutingProposalScanEntry =
  | {
    valid: true;
    path: string;
    fileName: string;
    declaration: WorkFoldRoutingDeclaration;
    digest: string;
  }
  | {
    valid: false;
    path: string;
    fileName: string;
    problem: string;
    /** Stable identity survives a time-sensitive admission refusal. */
    normalized?: { declaration: WorkFoldRoutingDeclaration; digest: string };
  };

export interface WorkFoldRoutingProposalScan {
  entries: WorkFoldRoutingProposalScanEntry[];
  /** More proposal files exist than the scan bound admits. */
  truncated: boolean;
}

export async function scanWorkFoldRoutingProposals(
  folder: string,
  options: { now?: Date } = {},
): Promise<WorkFoldRoutingProposalScan> {
  const root = resolve(folder);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => isProposalFileName(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], truncated: false };
    throw error;
  }
  const admitted = names.slice(0, workFoldRoutingProposalScanBounds.maxFiles);
  const entries: WorkFoldRoutingProposalScanEntry[] = [];
  for (const fileName of admitted) {
    entries.push(await scanOne(join(root, fileName), fileName, options.now ?? new Date()));
  }
  return { entries, truncated: names.length > admitted.length };
}

/**
 * Admits only an absolute path naming a proposal file directly inside the
 * management working folder; anything else is refused before it is read.
 */
export function resolveWorkFoldRoutingProposalPath(folder: string, path: unknown): string {
  if (typeof path !== "string" || !path || !isAbsolute(path)) {
    throw new Error("An absolute automation file path is required.");
  }
  const resolved = resolve(path);
  if (dirname(resolved) !== resolve(folder) || !isProposalFileName(basename(resolved))) {
    throw new Error("Only automation files in the work-fold agent's folder can be turned on here.");
  }
  return resolved;
}

function isProposalFileName(name: string): boolean {
  return name.endsWith(workFoldRoutingProposalFileSuffix) && name.length > workFoldRoutingProposalFileSuffix.length;
}

async function scanOne(path: string, fileName: string, now: Date): Promise<WorkFoldRoutingProposalScanEntry> {
  const invalid = (problem: string): WorkFoldRoutingProposalScanEntry => ({ valid: false, path, fileName, problem });
  let text: string;
  try {
    text = await readWorkFoldRoutingDocument(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("ordinary file")) return invalid("Not a regular file.");
    if (message.includes("256 KiB")) return invalid("Larger than 256 KiB.");
    return invalid("Could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("Not valid JSON.");
  }
  let normalized: { declaration: WorkFoldRoutingDeclaration; digest: string };
  try {
    normalized = contentAddressedWorkFoldRoutingDeclaration(normalizeWorkFoldRoutingProposal(parsed));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  try {
    assertWorkFoldRoutingAtAdmissionHorizon(normalized.declaration, now);
    return { valid: true, path, fileName, ...normalized };
  } catch (error) {
    return { valid: false, path, fileName, problem: error instanceof Error ? error.message : String(error), normalized };
  }
}
