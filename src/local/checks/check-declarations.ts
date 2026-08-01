import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  declarationFromWorkspaceCheckProposal,
  normalizeWorkspaceCheckDeclaration,
  normalizeWorkspaceCheckProposal,
  type WorkspaceCheckDeclaration,
  type WorkspaceCheckProposal,
} from "../../shared/checks.js";
import { workspaceCheckDeclarationDir } from "../state-paths.js";
import { workspaceCheckDigest } from "./check-integrity.js";

const maximumDeclarationBytes = 256 * 1024;
const maximumDeclarations = 256;
const maximumDirectoryEntries = 4_096;

export interface WorkspaceCheckDeclarationRecord {
  declaration: WorkspaceCheckDeclaration;
  digest: string;
  path: string;
}

export interface WorkspaceCheckDeclarationDiscovery {
  declarations: WorkspaceCheckDeclarationRecord[];
  errors: Array<{ file: string; message: string }>;
}

export async function discoverWorkspaceCheckDeclarations(workspaceRoot: string): Promise<WorkspaceCheckDeclarationDiscovery> {
  const directory = workspaceCheckDeclarationDir(workspaceRoot);
  const directoryInfo = await lstat(directory).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  if (directoryInfo === null) return { declarations: [], errors: [] };
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    return { declarations: [], errors: [{ file: "checks", message: "The Check declaration directory is not a safe ordinary directory." }] };
  }
  const entries = [];
  const handle = await opendir(directory);
  let visited = 0;
  try {
    for await (const entry of handle) {
      visited += 1;
      if (visited > maximumDirectoryEntries) {
        return { declarations: [], errors: [{ file: "checks", message: `The Check declaration directory has more than ${maximumDirectoryEntries} entries.` }] };
      }
      if (entry.name.endsWith(".json")) entries.push(entry);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  if (entries.length > maximumDeclarations) {
    return { declarations: [], errors: [{ file: "checks", message: `The Space has more than ${maximumDeclarations} Check declarations.` }] };
  }
  const declarations: WorkspaceCheckDeclarationRecord[] = [];
  const errors: WorkspaceCheckDeclarationDiscovery["errors"] = [];
  for (const entry of entries) {
    try {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Check declarations must be ordinary files, not links or special files.");
      const path = join(directory, entry.name);
      const source = await readBoundedOrdinaryFile(path);
      const declaration = normalizeWorkspaceCheckDeclaration(JSON.parse(source));
      if (`${declaration.id}.json` !== entry.name) throw new Error("Check declaration filename must match its id.");
      declarations.push({ declaration, digest: workspaceCheckDigest(declaration), path });
    } catch (error) {
      errors.push({ file: entry.name, message: errorMessage(error) });
    }
  }
  return { declarations, errors };
}

export async function readWorkspaceCheckProposal(path: string): Promise<WorkspaceCheckProposal> {
  const resolved = resolve(path);
  return normalizeWorkspaceCheckProposal(JSON.parse(await readBoundedOrdinaryFile(resolved)));
}

export async function writeWorkspaceCheckDeclaration(
  workspaceRoot: string,
  proposal: WorkspaceCheckProposal,
): Promise<WorkspaceCheckDeclarationRecord> {
  const declaration = declarationFromWorkspaceCheckProposal(proposal);
  const directory = workspaceCheckDeclarationDir(workspaceRoot);
  await ensureOrdinaryDirectory(directory);
  const path = join(directory, `${declaration.id}.json`);
  await writeNewAtomicJson(path, declaration);
  return { declaration, digest: workspaceCheckDigest(declaration), path };
}

async function ensureOrdinaryDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Check declarations require a safe ordinary directory.");
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Check declarations require safe Space metadata.");
}

async function readBoundedOrdinaryFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Check document must be an ordinary file, not a link or special file.");
  if (info.size > maximumDeclarationBytes) throw new Error(`Check document exceeds ${maximumDeclarationBytes} bytes.`);
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const afterOpen = await handle.stat();
    if (!afterOpen.isFile() || afterOpen.dev !== info.dev || afterOpen.ino !== info.ino) throw new Error("Check document changed while it was opened.");
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source, "utf8") > maximumDeclarationBytes) throw new Error(`Check document exceeds ${maximumDeclarationBytes} bytes.`);
    return source;
  } finally {
    await handle.close();
  }
}

async function writeNewAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
