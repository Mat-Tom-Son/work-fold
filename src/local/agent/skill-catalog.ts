import { readFile } from "node:fs/promises";

import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type ResourceDiagnostic,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import {
  createExtensionUiContext,
  createHeadlessExtensionUiBridge,
} from "./extension-ui.js";
import {
  resolvePiRuntime,
  type PiRuntimeProvider,
  type ResolvedPiRuntime,
} from "./pi-runtime-config.js";
import {
  loadExtensionSurfaceManifests,
  type PiExtensionSurface,
} from "./surface-manifest.js";

export interface PiCatalogSource {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

export interface PiToolCatalogItem {
  name: string;
  label: string;
  description: string;
  active: boolean;
  kind: "core" | "extension";
  core: boolean;
  configurable: false;
  configurationScope: "chat";
  source: PiCatalogSource;
}

export interface PiToolManagement {
  mode: "session-only";
  persisted: false;
  /** Whether the Capabilities API can change the active tool set. */
  mutable: false;
  scope: "chat";
  reason: string;
}

export interface PiSkillCatalogItem {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  disableModelInvocation: boolean;
  content?: string;
  source: PiCatalogSource;
}

export interface PiExtensionCatalogItem {
  path: string;
  resolvedPath: string;
  source: PiCatalogSource;
  tools: string[];
  commands: string[];
  flags: string[];
}

export interface PiPromptCatalogItem {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
  source: PiCatalogSource;
}

export interface PiThemeCatalogItem {
  name: string;
  path?: string;
  source?: PiCatalogSource;
}

export interface PiContextFileCatalogItem {
  path: string;
  content: string;
}

export interface PiCommandCatalogItem {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  sourceInfo?: PiCatalogSource;
}

export interface PiCatalogDiagnostic {
  type: "info" | "warning" | "error" | "collision";
  message: string;
  path?: string;
}

export interface PiResourceCatalog {
  projectTrust: ResolvedPiRuntime["projectTrust"];
  packages: ReturnType<ResolvedPiRuntime["settingsManager"]["getPackages"]>;
  toolManagement: PiToolManagement;
  tools: PiToolCatalogItem[];
  skills: PiSkillCatalogItem[];
  extensions: PiExtensionCatalogItem[];
  surfaces: PiExtensionSurface[];
  prompts: PiPromptCatalogItem[];
  themes: PiThemeCatalogItem[];
  contextFiles: PiContextFileCatalogItem[];
  commands: PiCommandCatalogItem[];
  diagnostics: PiCatalogDiagnostic[];
}

/** Compatibility name retained for the local API while its UI migrates. */
export type AgentSkillCatalog = PiResourceCatalog;

/**
 * Loads the same native Pi resources an actual chat session will use. Project
 * packages/extensions/skills are included only when project trust resolves.
 */
export async function loadAgentSkillCatalog(
  spaceRoot: string,
  runtimeProvider?: PiRuntimeProvider,
): Promise<PiResourceCatalog> {
  const runtime = await resolvePiRuntime(spaceRoot, runtimeProvider);
  const services = await createAgentSessionServices({
    cwd: spaceRoot,
    agentDir: runtime.agentDir,
    authStorage: runtime.authStorage,
    settingsManager: runtime.settingsManager,
    modelRegistry: runtime.modelRegistry,
    resourceLoaderOptions: additionalResourceOptions(runtime),
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(spaceRoot),
  });

  try {
    await result.session.bindExtensions({
      mode: "rpc",
      uiContext: createExtensionUiContext(
        // Catalog reads must never block an HTTP request on an extension dialog.
        // Actual chat sessions bind the host bridge and expose full RPC-style UI.
        createHeadlessExtensionUiBridge(),
        { conversationId: "catalog", spaceRoot },
      ),
    });
    return buildPiResourceCatalog(result.session, runtime, services.diagnostics);
  } finally {
    result.session.dispose();
  }
}

export async function buildPiResourceCatalog(
  session: AgentSession,
  runtime: ResolvedPiRuntime,
  serviceDiagnostics: Array<{ type: "info" | "warning" | "error"; message: string }> = [],
): Promise<PiResourceCatalog> {
  const loader = session.resourceLoader;
  const extensionResult = loader.getExtensions();
  const skillsResult = loader.getSkills();
  const promptsResult = loader.getPrompts();
  const themesResult = loader.getThemes();
  const activeTools = new Set(session.getActiveToolNames());

  const skills = await Promise.all(skillsResult.skills.map(async (skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
    ...(await readOptionalText(skill.filePath).then((content) => content === undefined ? {} : { content })),
    source: catalogSource(skill.sourceInfo),
  })));

  const extensions = extensionResult.extensions.map((extension) => ({
    path: extension.path,
    resolvedPath: extension.resolvedPath,
    source: catalogSource(extension.sourceInfo),
    tools: [...extension.tools.keys()].sort(),
    commands: [...extension.commands.keys()].sort(),
    flags: [...extension.flags.keys()].sort(),
  }));
  const surfaceResult = await loadExtensionSurfaceManifests(extensions);

  const tools = session.getAllTools().map((tool) => {
    const core = tool.sourceInfo.source === "builtin";
    return {
      name: tool.name,
      label: session.getToolDefinition(tool.name)?.label ?? humanize(tool.name),
      description: tool.description,
      active: activeTools.has(tool.name),
      kind: core ? "core" as const : "extension" as const,
      core,
      configurable: false as const,
      configurationScope: "chat" as const,
      source: catalogSource(tool.sourceInfo),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  const prompts = promptsResult.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
    path: prompt.filePath,
    source: catalogSource(prompt.sourceInfo),
  })).sort((left, right) => left.name.localeCompare(right.name));

  const themes = themesResult.themes.map((theme) => ({
    name: theme.name ?? "Unnamed theme",
    ...(theme.sourcePath ? { path: theme.sourcePath } : {}),
    ...(theme.sourceInfo ? { source: catalogSource(theme.sourceInfo) } : {}),
  })).sort((left, right) => left.name.localeCompare(right.name));

  const commands: PiCommandCatalogItem[] = [
    ...builtInPiCommands,
    ...extensionResult.extensions.flatMap((loaded) =>
      [...loaded.commands.values()].map((command) => ({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        source: "extension" as const,
        sourceInfo: catalogSource(command.sourceInfo),
      }))),
    ...prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt" as const,
      sourceInfo: prompt.source,
    })),
    ...skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      sourceInfo: skill.source,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name));

  return {
    projectTrust: runtime.projectTrust,
    packages: runtime.settingsManager.getPackages(),
    toolManagement: {
      mode: "session-only",
      persisted: false,
      mutable: false,
      scope: "chat",
      reason: "Pi has no persisted Personal or Space tool default; tool selection belongs to each Chat.",
    },
    tools,
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    extensions: extensions.sort((left, right) => left.resolvedPath.localeCompare(right.resolvedPath)),
    surfaces: surfaceResult.surfaces,
    prompts,
    themes,
    contextFiles: loader.getAgentsFiles().agentsFiles,
    commands,
    diagnostics: [
      ...serviceDiagnostics,
      ...extensionResult.errors.map((item) => ({
        type: "error" as const,
        path: item.path,
        message: item.error,
      })),
      ...surfaceResult.diagnostics,
      ...resourceDiagnostics(skillsResult.diagnostics),
      ...resourceDiagnostics(promptsResult.diagnostics),
      ...resourceDiagnostics(themesResult.diagnostics),
    ],
  };
}

export const builtInPiCommands: PiCommandCatalogItem[] = [
  ["settings", "Open settings"],
  ["model", "Select a model"],
  ["scoped-models", "Choose models for cycling"],
  ["export", "Export the session"],
  ["share", "Share the session as a secret GitHub gist"],
  ["copy", "Copy the last agent message"],
  ["name", "Set the session display name"],
  ["session", "Show session information and statistics"],
  ["changelog", "Show Pi changelog entries"],
  ["hotkeys", "Show keyboard shortcuts"],
  ["trust", "Show Space trust status"],
  ["login", "Configure provider authentication"],
  ["logout", "Remove provider authentication"],
  ["compact", "Compact the session context"],
  ["reload", "Reload extensions, skills, prompts, and themes"],
  ["quit", "Quit work-fold"],
].map(([name, description]) => ({ name, description, source: "builtin" }));

function additionalResourceOptions(runtime: ResolvedPiRuntime) {
  return {
    additionalExtensionPaths: runtime.config.additionalExtensionPaths,
    additionalSkillPaths: runtime.config.additionalSkillPaths,
    additionalPromptTemplatePaths: runtime.config.additionalPromptTemplatePaths,
    additionalThemePaths: runtime.config.additionalThemePaths,
  };
}

function catalogSource(source: SourceInfo): PiCatalogSource {
  return {
    path: source.path,
    source: source.source,
    scope: source.scope,
    origin: source.origin,
    ...(source.baseDir ? { baseDir: source.baseDir } : {}),
  };
}

function resourceDiagnostics(diagnostics: ResourceDiagnostic[]): PiCatalogDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    type: diagnostic.type,
    message: diagnostic.message,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
  }));
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
