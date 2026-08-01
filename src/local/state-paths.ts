import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

let configuredStateRoot: string | null = null;

export function configureWorkspaceStateRoot(rootPath: string | undefined): void {
  configuredStateRoot = rootPath?.trim() ? resolve(rootPath) : null;
}

export function workspaceStateRoot(): string {
  if (configuredStateRoot) return configuredStateRoot;
  const override = process.env.WORKSPACE_STATE_DIR?.trim();
  if (override) return resolve(override);
  return join(platformAppDataBase(), "Workspace");
}

export function managedWorkspaceRoot(): string {
  const override = process.env.WORKSPACE_CONTENT_DIR?.trim();
  return override ? resolve(override) : join(workspaceStateRoot(), "workspaces");
}

export function resourceLibraryRoot(): string {
  const override = process.env.WORKSPACE_RESOURCES_DIR?.trim();
  return override ? resolve(override) : join(workspaceStateRoot(), "resources");
}

export function workspaceRegistryFile(): string {
  return join(workspaceStateRoot(), "workspace-registry.json");
}

/** Machine-local Space identity and appearance preferences. */
export function workspaceAppearanceFile(): string {
  return join(workspaceStateRoot(), "appearance.json");
}

/** Machine-local staged code and lifecycle receipts for restricted apps. */
export function restrictedAppRoot(): string {
  return join(workspaceStateRoot(), "restricted-apps");
}

/**
 * Scope id for the management conversation that sits above all Spaces. It is
 * a distinct conversation scope, not a Space: its records describe this
 * machine's Space registry, so they are machine-local application state.
 */
export const workspaceManagementScopeId = "workspace-management";

/** Machine-local root holding the management scope's conversation records. */
export function workspaceManagementRoot(): string {
  return join(workspaceStateRoot(), "management");
}

export function workspaceStateDir(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  const key = workspaceStateKey(resolved);
  return join(workspaceStateRoot(), "state", "workspaces", key);
}

export function workspaceMetadataDir(workspaceRoot: string): string {
  return portableMetadataPath(join(resolve(workspaceRoot), ".workspace"), "Space metadata directory");
}

export function workspaceStateKey(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  const readable = safeSegment(basename(resolved)).slice(0, 40) || "workspace";
  const normalized = process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${readable}-${hash}`;
}

export function workspaceManifestFile(workspaceRoot: string): string {
  return portableMetadataPath(join(workspaceMetadataDir(workspaceRoot), "space.json"), "Space manifest");
}

export function workspaceConversationDir(workspaceRoot: string): string {
  return portableMetadataPath(join(workspaceMetadataDir(workspaceRoot), "conversations"), "Space conversation directory");
}

/** Previous releases stored these portable records in the app-data state tree. */
export function legacyWorkspaceManifestFile(workspaceRoot: string): string {
  return join(workspaceStateDir(workspaceRoot), "workspace.json");
}

/** Previous releases stored these portable records in the app-data state tree. */
export function legacyWorkspaceConversationDir(workspaceRoot: string): string {
  return join(workspaceStateDir(workspaceRoot), "conversations");
}

export function workspaceSessionDir(workspaceRoot: string): string {
  return join(workspaceStateDir(workspaceRoot), "sessions");
}

export function workspaceHistoryRoot(workspaceRoot: string): string {
  return join(workspaceStateDir(workspaceRoot), "history");
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
