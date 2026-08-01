import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  loadAgentSkillCatalog,
  type PiCatalogSource,
  type PiResourceCatalog,
} from "./agent/skill-catalog.js";
import type { PiSurfaceBlock } from "./agent/surface-manifest.js";
import {
  isPiProjectMutationTrusted,
  listPiPackages,
  type PiConfiguredPackage,
  type PiRuntimeProvider,
} from "./agent/pi-runtime-config.js";
import {
  getWorkspace,
  listWorkspaces,
  type WorkspaceLocation,
  type WorkspaceSummary,
} from "./workspace.js";

export const workspaceKernelSnapshotVersion = 1 as const;

export type WorkspaceActorKind = "human" | "assistant" | "cli" | "renderer" | "extension" | "app" | "system";

export interface WorkspaceActor {
  kind: WorkspaceActorKind;
  cwd?: string;
  workspaceId?: string;
  conversationId?: string;
}

export interface WorkspaceSpaceSnapshot {
  id: string;
  name: string;
  rootPath: string;
  location: WorkspaceLocation;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceContextSnapshot {
  kind: "workspace.context";
  version: typeof workspaceKernelSnapshotVersion;
  actor: WorkspaceActor;
  resolution: "workspace_id" | "cwd" | "none";
  workspace: WorkspaceSpaceSnapshot | null;
}

export interface WorkspaceSpacesSnapshot {
  kind: "workspace.spaces";
  version: typeof workspaceKernelSnapshotVersion;
  actor: WorkspaceActor;
  spaces: WorkspaceSpaceSnapshot[];
}

export type WorkspaceTaskKind = "assistant_turn" | "compaction";

export interface WorkspaceTaskSnapshot {
  id: string;
  kind: WorkspaceTaskKind;
  status: "running";
  workspaceId: string;
  conversationId?: string;
  actor: WorkspaceActor;
  startedAt: string;
}

export interface WorkspaceTaskInput {
  id?: string;
  kind: WorkspaceTaskKind;
  workspaceId: string;
  conversationId?: string;
  actor: WorkspaceActor;
}

/**
 * Experimental internal task shape for Checks dogfooding. It is deliberately
 * separate from WorkspaceTaskKind and must not enter workspace.tasks v1.
 */
export interface WorkspaceExperimentalCheckRunTaskInput {
  id?: string;
  workspaceId: string;
  actor: WorkspaceActor;
}

export interface WorkspaceExperimentalCheckRunTask {
  id: string;
  kind: "check_run";
  status: "running";
  workspaceId: string;
  actor: WorkspaceActor;
  startedAt: string;
}

export interface WorkspaceTasksSnapshot {
  kind: "workspace.tasks";
  version: typeof workspaceKernelSnapshotVersion;
  actor: WorkspaceActor;
  workspaceId: string | null;
  tasks: WorkspaceTaskSnapshot[];
}

export type WorkspaceCapabilityScope = "global" | "project" | "temporary";
export type WorkspaceCapabilityOrigin = "package" | "top-level";
export type WorkspaceCapabilityStatus = "loaded";

export interface WorkspaceCapabilityProvenance {
  label: string;
  source: string;
  path: string;
  scope: WorkspaceCapabilityScope;
  origin: WorkspaceCapabilityOrigin;
  baseDir?: string;
  packageSource?: string;
}

export interface WorkspaceCapabilityTrustSnapshot {
  required: boolean;
  trusted: boolean;
  savedDecision: boolean | null;
  mutationTrusted: boolean;
}

export interface WorkspacePackageSnapshot {
  source: string;
  scope: "global" | "project";
  filtered: boolean;
  installedPath?: string;
  installed: boolean;
  loaded: boolean;
}

interface WorkspaceLoadedCapabilitySnapshot {
  source: string;
  scope: WorkspaceCapabilityScope;
  origin: WorkspaceCapabilityOrigin;
  packageSource?: string;
  sourceInfo: WorkspaceCapabilityProvenance;
  provenance: WorkspaceCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: WorkspaceCapabilityStatus;
}

export interface WorkspaceSkillSnapshot extends WorkspaceLoadedCapabilitySnapshot {
  name: string;
  description: string;
  path: string;
  content?: string;
  disableModelInvocation?: true;
}

export interface WorkspaceExtensionSnapshot extends WorkspaceLoadedCapabilitySnapshot {
  id: string;
  name: string;
  path: string;
  commands: string[];
  tools: string[];
  flags: string[];
}

export interface WorkspaceExtensionSurfaceSnapshot extends WorkspaceLoadedCapabilitySnapshot {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  extensionPath: string;
  manifestPath: string;
  views: PiResourceCatalog["surfaces"][number]["views"];
}

export interface WorkspaceToolSnapshot extends WorkspaceLoadedCapabilitySnapshot {
  name: string;
  label: string;
  description: string;
  active: boolean;
  kind: "core" | "extension";
  core: boolean;
  configurable: false;
  configurationScope: "chat";
}

export interface WorkspacePromptSnapshot extends WorkspaceLoadedCapabilitySnapshot {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
}

export interface WorkspaceThemeSnapshot {
  name: string;
  path?: string;
  source?: string;
  scope?: WorkspaceCapabilityScope;
  origin?: WorkspaceCapabilityOrigin;
  packageSource?: string;
  sourceInfo?: WorkspaceCapabilityProvenance;
  provenance?: WorkspaceCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: WorkspaceCapabilityStatus;
}

export interface WorkspaceCommandSnapshot {
  name: string;
  description?: string;
  kind: "builtin" | "extension" | "prompt" | "skill";
  source: string;
  scope?: WorkspaceCapabilityScope;
  origin?: WorkspaceCapabilityOrigin;
  packageSource?: string;
  sourceInfo?: WorkspaceCapabilityProvenance;
  provenance?: WorkspaceCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: WorkspaceCapabilityStatus;
}

export interface WorkspaceCapabilityDiagnosticSnapshot {
  type: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface WorkspaceCapabilityCatalogSnapshot {
  projectTrust: WorkspaceCapabilityTrustSnapshot;
  trust: WorkspaceCapabilityTrustSnapshot;
  projectTrusted: boolean;
  packages: WorkspacePackageSnapshot[];
  toolManagement: PiResourceCatalog["toolManagement"];
  skills: WorkspaceSkillSnapshot[];
  extensions: WorkspaceExtensionSnapshot[];
  surfaces: WorkspaceExtensionSurfaceSnapshot[];
  tools: WorkspaceToolSnapshot[];
  prompts: WorkspacePromptSnapshot[];
  themes: WorkspaceThemeSnapshot[];
  commands: WorkspaceCommandSnapshot[];
  diagnostics: WorkspaceCapabilityDiagnosticSnapshot[];
}

export interface WorkspaceCapabilitiesSnapshot {
  kind: "workspace.capabilities";
  version: typeof workspaceKernelSnapshotVersion;
  actor: WorkspaceActor;
  workspace: WorkspaceSpaceSnapshot;
  catalog: WorkspaceCapabilityCatalogSnapshot;
}

export interface WorkspaceKernelOptions {
  runtimeProvider?: PiRuntimeProvider;
  listWorkspaces?: () => Promise<WorkspaceSummary[]>;
  getWorkspace?: (workspaceId: string) => Promise<WorkspaceSummary>;
  loadCapabilityCatalog?: (workspaceRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiResourceCatalog>;
  listPackages?: (workspaceRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiConfiguredPackage[]>;
  isProjectMutationTrusted?: (workspaceRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<boolean>;
  now?: () => Date;
  createTaskId?: () => string;
}

export class WorkspaceContextRequiredError extends Error {
  readonly code = "WORKSPACE_CONTEXT_REQUIRED";

  constructor() {
    super("A Space must be selected explicitly or resolved from the actor's current directory.");
    this.name = "WorkspaceContextRequiredError";
  }
}

/**
 * Reusable in-process authority for the read-only Workspace control plane.
 * HTTP, CLI, and Assistant adapters consume the same typed snapshots while
 * mutation policy remains in the owning domain services.
 */
export class WorkspaceKernel {
  readonly #runtimeProvider?: PiRuntimeProvider;
  readonly #listWorkspaces: () => Promise<WorkspaceSummary[]>;
  readonly #getWorkspace: (workspaceId: string) => Promise<WorkspaceSummary>;
  readonly #loadCapabilityCatalog: WorkspaceKernelOptions["loadCapabilityCatalog"] & {};
  readonly #listPackages: WorkspaceKernelOptions["listPackages"] & {};
  readonly #isProjectMutationTrusted: WorkspaceKernelOptions["isProjectMutationTrusted"] & {};
  readonly #now: () => Date;
  readonly #createTaskId: () => string;
  readonly #tasks = new Map<string, WorkspaceTaskSnapshot | WorkspaceExperimentalCheckRunTask>();

  constructor(options: WorkspaceKernelOptions = {}) {
    this.#runtimeProvider = options.runtimeProvider;
    this.#listWorkspaces = options.listWorkspaces ?? listWorkspaces;
    this.#getWorkspace = options.getWorkspace ?? getWorkspace;
    this.#loadCapabilityCatalog = options.loadCapabilityCatalog ?? loadAgentSkillCatalog;
    this.#listPackages = options.listPackages ?? listPiPackages;
    this.#isProjectMutationTrusted = options.isProjectMutationTrusted ?? isPiProjectMutationTrusted;
    this.#now = options.now ?? (() => new Date());
    this.#createTaskId = options.createTaskId ?? (() => `task-${randomUUID()}`);
  }

  async getContext(actor: WorkspaceActor): Promise<WorkspaceContextSnapshot> {
    const normalizedActor = normalizeActor(actor);
    if (normalizedActor.workspaceId) {
      return {
        kind: "workspace.context",
        version: workspaceKernelSnapshotVersion,
        actor: normalizedActor,
        resolution: "workspace_id",
        workspace: toSpaceSnapshot(await this.#getWorkspace(normalizedActor.workspaceId)),
      };
    }

    if (normalizedActor.cwd) {
      const cwd = resolve(normalizedActor.cwd);
      const candidates = (await this.#listWorkspaces())
        .filter((workspace) => pathContains(workspace.rootPath, cwd))
        .sort((left, right) => resolve(right.rootPath).length - resolve(left.rootPath).length);
      if (candidates[0]) {
        return {
          kind: "workspace.context",
          version: workspaceKernelSnapshotVersion,
          actor: normalizedActor,
          resolution: "cwd",
          workspace: toSpaceSnapshot(candidates[0]),
        };
      }
    }

    return {
      kind: "workspace.context",
      version: workspaceKernelSnapshotVersion,
      actor: normalizedActor,
      resolution: "none",
      workspace: null,
    };
  }

  async getSpaces(actor: WorkspaceActor): Promise<WorkspaceSpacesSnapshot> {
    return {
      kind: "workspace.spaces",
      version: workspaceKernelSnapshotVersion,
      actor: normalizeActor(actor),
      spaces: (await this.#listWorkspaces()).map(toSpaceSnapshot),
    };
  }

  async getTasks(actor: WorkspaceActor): Promise<WorkspaceTasksSnapshot> {
    const normalizedActor = normalizeActor(actor);
    const scoped = Boolean(normalizedActor.workspaceId || normalizedActor.cwd);
    const context = scoped ? await this.getContext(normalizedActor) : null;
    const workspaceId = context?.workspace?.id ?? null;
    const tasks = [...this.#tasks.values()]
      .filter((task): task is WorkspaceTaskSnapshot => task.kind !== "check_run")
      .filter((task) => !scoped || task.workspaceId === workspaceId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map(copyTask);
    return {
      kind: "workspace.tasks",
      version: workspaceKernelSnapshotVersion,
      actor: normalizedActor,
      workspaceId,
      tasks,
    };
  }

  async getCapabilities(actor: WorkspaceActor): Promise<WorkspaceCapabilitiesSnapshot> {
    const context = await this.getContext(actor);
    if (!context.workspace) throw new WorkspaceContextRequiredError();
    const [catalog, packages, mutationTrusted] = await Promise.all([
      this.#loadCapabilityCatalog(context.workspace.rootPath, this.#runtimeProvider),
      this.#listPackages(context.workspace.rootPath, this.#runtimeProvider),
      this.#isProjectMutationTrusted(context.workspace.rootPath, this.#runtimeProvider),
    ]);
    return {
      kind: "workspace.capabilities",
      version: workspaceKernelSnapshotVersion,
      actor: context.actor,
      workspace: context.workspace,
      catalog: buildWorkspaceCapabilityCatalog(catalog, packages, mutationTrusted),
    };
  }

  startTask(input: WorkspaceTaskInput): WorkspaceTaskSnapshot {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("Workspace task id is required.");
    if (this.#tasks.has(id)) throw new Error(`Workspace task is already running: ${id}`);
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) throw new Error("Workspace task Space id is required.");
    const task: WorkspaceTaskSnapshot = {
      id,
      kind: input.kind,
      status: "running",
      workspaceId,
      ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyTask(task);
  }

  /**
   * Starts a Check run in the shared internal lifecycle without promoting the
   * experimental kind into the stable workspace.tasks v1 projection.
   */
  startExperimentalCheckRunTask(input: WorkspaceExperimentalCheckRunTaskInput): WorkspaceExperimentalCheckRunTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("Workspace task id is required.");
    if (this.#tasks.has(id)) throw new Error(`Workspace task is already running: ${id}`);
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) throw new Error("Workspace task Space id is required.");
    const task: WorkspaceExperimentalCheckRunTask = {
      id,
      kind: "check_run",
      status: "running",
      workspaceId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalCheckRunTask(task);
  }

  finishTask(taskId: string): boolean {
    return this.#tasks.delete(taskId);
  }
}

export function buildWorkspaceCapabilityCatalog(
  catalog: PiResourceCatalog,
  packages: PiConfiguredPackage[],
  mutationTrusted: boolean,
): WorkspaceCapabilityCatalogSnapshot {
  const loadedPackageSources = new Set([
    ...catalog.skills.map((item) => item.source),
    ...catalog.extensions.map((item) => item.source),
    ...catalog.surfaces.map((item) => item.source),
    ...catalog.prompts.map((item) => item.source),
    ...catalog.themes.flatMap((item) => item.source ? [item.source] : []),
  ].filter((source) => source.origin === "package").map((source) => source.source));
  const projectTrust = { ...catalog.projectTrust, mutationTrusted };

  return {
    projectTrust: { ...projectTrust },
    trust: { ...projectTrust },
    // Compatibility for older renderers. A Space with no gated resources is
    // runtime-trusted even when it has no saved mutation decision.
    projectTrusted: catalog.projectTrust.trusted,
    packages: packages.map((item) => ({
      source: item.source,
      scope: item.scope === "project" ? "project" : "global",
      filtered: item.filtered,
      ...(item.installedPath ? { installedPath: item.installedPath } : {}),
      installed: Boolean(item.installedPath),
      loaded: loadedPackageSources.has(item.source),
    })),
    toolManagement: { ...catalog.toolManagement },
    skills: catalog.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      source: sourceLabel(skill.source),
      ...capabilitySourceFields(skill.source),
      enabled: true,
      loaded: true,
      status: "loaded",
      ...(skill.content !== undefined ? { content: skill.content } : {}),
      ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
    })),
    extensions: catalog.extensions.map((extension) => ({
      id: extension.resolvedPath,
      name: basename(extension.resolvedPath).replace(/\.[^.]+$/, ""),
      path: extension.path,
      source: sourceLabel(extension.source),
      ...capabilitySourceFields(extension.source),
      enabled: true,
      loaded: true,
      status: "loaded",
      commands: [...extension.commands],
      tools: [...extension.tools],
      flags: [...extension.flags],
    })),
    surfaces: catalog.surfaces.map((surface) => ({
      id: surface.id,
      title: surface.title,
      ...(surface.description ? { description: surface.description } : {}),
      ...(surface.icon ? { icon: surface.icon } : {}),
      extensionPath: surface.extensionPath,
      manifestPath: surface.manifestPath,
      views: surface.views.map((view) => ({
        id: view.id,
        title: view.title,
        ...(view.description ? { description: view.description } : {}),
        blocks: view.blocks.map(copySurfaceBlock),
      })),
      source: sourceLabel(surface.source),
      ...capabilitySourceFields(surface.source),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      source: sourceLabel(tool.source),
      ...capabilitySourceFields(tool.source),
      enabled: true,
      loaded: true,
      status: "loaded",
      active: tool.active,
      kind: tool.kind,
      core: tool.core,
      configurable: tool.configurable,
      configurationScope: tool.configurationScope,
    })),
    prompts: catalog.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      path: prompt.path,
      source: sourceLabel(prompt.source),
      ...capabilitySourceFields(prompt.source),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    themes: catalog.themes.map((theme) => ({
      name: theme.name,
      ...(theme.path ? { path: theme.path } : {}),
      ...(theme.source ? {
        source: sourceLabel(theme.source),
        ...capabilitySourceFields(theme.source),
      } : {}),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    commands: catalog.commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      kind: command.source,
      ...(command.sourceInfo ? {
        source: sourceLabel(command.sourceInfo),
        ...capabilitySourceFields(command.sourceInfo),
      } : { source: command.source }),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({
      type: diagnostic.type === "collision" ? "warning" : diagnostic.type,
      message: diagnostic.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
    })),
  };
}

function copySurfaceBlock(block: PiSurfaceBlock): PiSurfaceBlock {
  if (block.type === "heading" || block.type === "text") return { ...block };
  if (block.type === "callout") return { ...block };
  if (block.type === "metrics") return { ...block, items: block.items.map((item) => ({ ...item })) };
  if (block.type === "table") return { ...block, columns: [...block.columns], rows: block.rows.map((row) => [...row]) };
  return { ...block, items: block.items.map((item) => ({ ...item })) };
}

function sourceLabel(source: PiCatalogSource): string {
  const scope = source.scope === "user" ? "Personal" : source.scope === "project" ? "This Space" : "Temporary";
  const origin = source.origin === "package"
    ? source.source
    : source.source === "auto" ? "standard Pi location" : source.source;
  return [scope, origin].filter(Boolean).join(" · ");
}

function capabilitySourceFields(source: PiCatalogSource): {
  scope: WorkspaceCapabilityScope;
  origin: WorkspaceCapabilityOrigin;
  packageSource?: string;
  sourceInfo: WorkspaceCapabilityProvenance;
  provenance: WorkspaceCapabilityProvenance;
} {
  const scope: WorkspaceCapabilityScope = source.scope === "user" ? "global" : source.scope;
  const provenance: WorkspaceCapabilityProvenance = {
    label: sourceLabel(source),
    source: source.source,
    path: source.path,
    scope,
    origin: source.origin,
    ...(source.baseDir ? { baseDir: source.baseDir } : {}),
    ...(source.origin === "package" ? { packageSource: source.source } : {}),
  };
  return {
    scope,
    origin: source.origin,
    ...(source.origin === "package" ? { packageSource: source.source } : {}),
    sourceInfo: { ...provenance },
    provenance: { ...provenance },
  };
}

function normalizeActor(actor: WorkspaceActor): WorkspaceActor {
  return {
    kind: actor.kind,
    ...(actor.cwd?.trim() ? { cwd: resolve(actor.cwd.trim()) } : {}),
    ...(actor.workspaceId?.trim() ? { workspaceId: actor.workspaceId.trim() } : {}),
    ...(actor.conversationId?.trim() ? { conversationId: actor.conversationId.trim() } : {}),
  };
}

function toSpaceSnapshot(workspace: WorkspaceSummary): WorkspaceSpaceSnapshot {
  return {
    id: workspace.id,
    name: workspace.name,
    rootPath: resolve(workspace.rootPath),
    location: { ...workspace.location },
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function copyTask(task: WorkspaceTaskSnapshot): WorkspaceTaskSnapshot {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalCheckRunTask(task: WorkspaceExperimentalCheckRunTask): WorkspaceExperimentalCheckRunTask {
  return { ...task, actor: { ...task.actor } };
}

function pathContains(rootPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
