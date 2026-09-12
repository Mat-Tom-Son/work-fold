import { loadIncludedMcpConfig } from "./included-mcp-setup.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResolvedPiRuntime } from "./pi-runtime-config.js";
import type { NativeResource } from "./resource-lifecycle.js";

import { includedToolDefinitions } from "../../shared/included-tools.js";
export { includedToolDefinitions, type IncludedToolId } from "../../shared/included-tools.js";
export interface IncludedToolsConfiguration {
  rootPath: string;
  stateRoot: string;
  helperAppPath?: string;
}

export function includedToolsRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dirname(dir) !== dir) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try { if (JSON.parse(readFileSync(manifest, "utf8")).name === "work-fold-desktop") return join(dir, "resources", "included-tools"); } catch { /* Keep walking to the host package. */ }
    }
    dir = dirname(dir);
  }
  throw new Error("The included Assistant tools could not be located.");
}

/** Pi itself evaluates the same exact +path/-path filters used for user-added resources. */
export async function resolveIncludedResources(cwd: string, runtime: ResolvedPiRuntime): Promise<NativeResource[]> {
  const config = runtime.config.includedTools;
  if (!config) return [];
  const paths = includedToolDefinitions.map((item) => join(config.rootPath, item.id, "index.ts"));
  const skillRoot = join(config.rootPath, "documents", "skills");
  const global = runtime.settingsManager.getGlobalSettings();
  const settings = SettingsManager.inMemory({ extensions: [...paths, ...(global.extensions ?? [])], skills: [skillRoot, ...(global.skills ?? [])] }, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd, agentDir: runtime.agentDir, settingsManager: settings });
  const native = await manager.resolve(async () => "skip");
  return [
    ...native.extensions.filter((item) => paths.includes(item.path)).map((item) => ({ ...item, kind: "extensions" as const, included: includedToolDefinitions.find((definition) => join(config.rootPath, definition.id, "index.ts") === item.path), metadata: { ...item.metadata, source: "Included with work-fold", scope: "user" as const } })),
    ...native.skills.filter((item) => item.path.startsWith(`${skillRoot}/`)).map((item) => ({ ...item, kind: "skills" as const, included: includedToolDefinitions.find((definition) => definition.id === "documents"), metadata: { ...item.metadata, source: "Included with work-fold", scope: "user" as const } })),
  ];
}

/** A per-runtime native event bus; no process-global current Chat or renderer capability. */
export async function includedResourceOptions(cwd: string, runtime: ResolvedPiRuntime, mode: "catalog" | "session") {
  const config = runtime.config.includedTools;
  if (!config) return {};
  const resources = await resolveIncludedResources(cwd, runtime);
  const eventBus = createEventBus();
  eventBus.on("work-fold:extension-host:v1", (value) => {
    if (!value || typeof value !== "object" || Reflect.get(value, "version") !== 1) return;
    Reflect.set(value, "context", {
      version: 1, mode, cwd: resolve(cwd), agentDir: runtime.agentDir, stateRoot: config.stateRoot,
      helperAppPath: config.helperAppPath,
      companionPath: join(config.stateRoot, "chrome-companion"),
      getMcpConfig: () => loadIncludedMcpConfig({ agentDir: runtime.agentDir, ...(runtime.projectTrust.trusted ? { cwd: resolve(cwd) } : {}) }),
      // Credentials are read only when an operation actually needs them.
      getSearchConfig: async () => {
        const credential = runtime.authStorage.get("work-fold:web:brave");
        return credential?.type === "api_key" ? { provider: "brave", apiKey: credential.key } : { provider: "duckduckgo" };
      },
    });
  });
  return {
    eventBus,
    additionalExtensionPaths: [...resources.filter((item) => item.kind === "extensions" && item.enabled).map((item) => item.path), ...(runtime.config.additionalExtensionPaths ?? [])],
    additionalSkillPaths: [...resources.filter((item) => item.kind === "skills" && item.enabled).map((item) => item.path), ...(runtime.config.additionalSkillPaths ?? [])],
  };
}
