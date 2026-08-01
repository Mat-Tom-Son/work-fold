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

export function managedSpaceRoot(): string {
  const override = process.env.WORKFOLD_CONTENT_DIR?.trim();
  return override ? resolve(override) : join(workFoldStateRoot(), "spaces");
}

export function resourceLibraryRoot(): string {
  const override = process.env.WORKFOLD_RESOURCES_DIR?.trim();
  return override ? resolve(override) : join(workFoldStateRoot(), "resources");
}

export function spaceRegistryFile(): string {
  return join(workFoldStateRoot(), "space-registry.json");
}

/** Machine-local Space identity and appearance preferences. */
export function spaceAppearanceFile(): string {
  return join(workFoldStateRoot(), "appearance.json");
}

/** Machine-local staged code and lifecycle receipts for restricted apps. */
export function restrictedAppRoot(): string {
  return join(workFoldStateRoot(), "restricted-apps");
}

/**
 * Scope id for the management conversation that sits above all Spaces. It is
 * a distinct conversation scope, not a Space: its records describe this
 * machine's Space registry, so they are machine-local application state.
 */
export const workFoldManagementScopeId = "work-fold-management";

/** Machine-local root holding the management scope's conversation records. */
export function workFoldManagementRoot(): string {
  return join(workFoldStateRoot(), "management");
}

export function spaceStateDir(spaceRoot: string): string {
  const resolved = resolve(spaceRoot);
  const key = spaceStateKey(resolved);
  return join(workFoldStateRoot(), "state", "spaces", key);
}

/**
 * Machine-local Check authority and private run state, keyed by stable Space
 * identity rather than the folder path. Moving a registered Space therefore
 * preserves its state, while removal can explicitly revoke the one identity.
 */
export function spaceCheckStateFile(spaceId: string): string {
  const normalized = spaceId.trim();
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/.test(normalized)) {
    throw new Error("A valid Space id is required for Check state.");
  }
  const readable = safeSegment(normalized).slice(0, 48) || "space";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(workFoldStateRoot(), "checks", "spaces", `${readable}-${hash}.json`);
}

export function spaceMetadataDir(spaceRoot: string): string {
  return portableMetadataPath(join(resolve(spaceRoot), ".work-fold"), "Space metadata directory");
}

export function spaceStateKey(spaceRoot: string): string {
  const resolved = resolve(spaceRoot);
  const readable = safeSegment(basename(resolved)).slice(0, 40) || "space";
  const normalized = process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${readable}-${hash}`;
}

export function spaceManifestFile(spaceRoot: string): string {
  return portableMetadataPath(join(spaceMetadataDir(spaceRoot), "space.json"), "Space manifest");
}

export function spaceConversationDir(spaceRoot: string): string {
  return portableMetadataPath(join(spaceMetadataDir(spaceRoot), "conversations"), "Space conversation directory");
}

/** Portable, inert Check declarations. Local enablement remains in app state. */
export function spaceCheckDeclarationDir(spaceRoot: string): string {
  return portableMetadataPath(join(spaceMetadataDir(spaceRoot), "checks"), "Space Check declaration directory");
}

export function spaceHistoryRoot(spaceRoot: string): string {
  return join(spaceStateDir(spaceRoot), "history");
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
