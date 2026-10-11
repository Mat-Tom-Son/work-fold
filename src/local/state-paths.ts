import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

let configuredStateRoot: string | null = null;

export function configureWorkFoldStateRoot(stateRoot: string | undefined): void {
  configuredStateRoot = stateRoot?.trim() ? resolve(stateRoot) : null;
}

export function workFoldStateRoot(): string {
  if (configuredStateRoot) return configuredStateRoot;
  const override = process.env.WORKFOLD_STATE_DIR?.trim();
  if (override) return resolve(override);
  return join(platformAppDataBase(), "work-fold");
}

export function managedWorkFolderRoot(): string {
  const override = process.env.WORKFOLD_CONTENT_DIR?.trim();
  return override ? resolve(override) : join(workFoldStateRoot(), "spaces");
}

export function workFolderRegistryFile(): string {
  return join(workFoldStateRoot(), "work-folder-registry.json");
}

/** Machine-local work-folder identity and appearance preferences. */
export function workFolderAppearanceFile(): string {
  return join(workFoldStateRoot(), "appearance.json");
}

/** Machine-local staged code and lifecycle receipts for restricted apps. */
export function restrictedAppRoot(): string {
  return join(workFoldStateRoot(), "restricted-apps");
}

/** Recently deleted, the machine-local trash for reversible destruction (docs/receipts-not-gates.md, F20). */
export function workFoldRecentlyDeletedRoot(): string {
  return join(workFoldStateRoot(), "recently-deleted");
}

/** Machine-local durable request graph (docs/collaboration-contract.md, F25). */
export function workFoldRequestsRoot(): string {
  return join(workFoldStateRoot(), "requests");
}

/**
 * Scope id for the work-fold agent that sits above all work-folders. It is
 * a distinct conversation scope, not a work-folder: its records describe this
 * machine's work-folder registry, so they are machine-local application state.
 */
export const workFoldAgentScopeId = "work-fold-agent";

/** Machine-local root holding the work-fold agent scope's conversation records. */
export function workFoldAgentRoot(): string {
  return join(workFoldStateRoot(), "management");
}

export function workFolderStateDir(workFolderRoot: string): string {
  const resolved = resolve(workFolderRoot);
  const key = workFolderStateKey(resolved);
  return join(workFoldStateRoot(), "state", "work-folders", key);
}

/**
 * Machine-local Check authority and private run state, keyed by stable
 * work-folder identity rather than the folder path. Moving a registered
 * work-folder therefore preserves its state, while removal can explicitly
 * revoke the one identity.
 */
export function workFolderCheckStateFile(workFolderId: string): string {
  const normalized = workFolderId.trim();
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/.test(normalized)) {
    throw new Error("A valid work-folder id is required for Check state.");
  }
  const readable = safeSegment(normalized).slice(0, 48) || "space";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(workFoldStateRoot(), "checks", "work-folders", `${readable}-${hash}.json`);
}

export function workFolderMetadataDir(workFolderRoot: string): string {
  return portableMetadataPath(join(resolve(workFolderRoot), ".work-fold"), "work-folder metadata directory");
}

export function workFolderStateKey(workFolderRoot: string): string {
  const resolved = resolve(workFolderRoot);
  const readable = safeSegment(basename(resolved)).slice(0, 40) || "space";
  const normalized = process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${readable}-${hash}`;
}

export function workFolderManifestFile(workFolderRoot: string): string {
  return portableMetadataPath(join(workFolderMetadataDir(workFolderRoot), "work-folder.json"), "work-folder manifest");
}

export function workFolderConversationDir(workFolderRoot: string): string {
  return portableMetadataPath(join(workFolderMetadataDir(workFolderRoot), "conversations"), "work-folder conversation directory");
}

/** Portable, inert Check declarations. Local enablement remains in app state. */
export function workFolderCheckDeclarationDir(workFolderRoot: string): string {
  return portableMetadataPath(join(workFolderMetadataDir(workFolderRoot), "checks"), "work-folder Check declaration directory");
}

export function workFolderHistoryRoot(workFolderRoot: string): string {
  return join(workFolderStateDir(workFolderRoot), "history");
}

function platformAppDataBase(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) return appData;
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function portableMetadataPath(path: string, label: string): string {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link or junction.`);
  }
  return path;
}
