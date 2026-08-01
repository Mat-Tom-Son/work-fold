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
  getSpace,
  listSpaces,
  type SpaceLocation,
  type SpaceSummary,
} from "./space.js";

export const workFoldKernelSnapshotVersion = 1 as const;

export type WorkFoldActorKind = "human" | "assistant" | "cli" | "renderer" | "extension" | "app" | "system";

export interface WorkFoldActor {
  kind: WorkFoldActorKind;
  cwd?: string;
  spaceId?: string;
  conversationId?: string;
}

export interface WorkFoldSpaceSnapshot {
  id: string;
  name: string;
  spaceRoot: string;
  location: SpaceLocation;
  createdAt: string;
  updatedAt: string;
}

export interface WorkFoldContextSnapshot {
  kind: "work-fold.context";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  resolution: "space_id" | "cwd" | "none";
  space: WorkFoldSpaceSnapshot | null;
}

export interface WorkFoldSpacesSnapshot {
  kind: "work-fold.spaces";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  spaces: WorkFoldSpaceSnapshot[];
}

export type WorkFoldTaskKind = "assistant_turn" | "compaction";

export interface WorkFoldTaskSnapshot {
  id: string;
  kind: WorkFoldTaskKind;
  status: "running";
  spaceId: string;
  conversationId?: string;
  actor: WorkFoldActor;
  startedAt: string;
}

export interface WorkFoldTaskInput {
  id?: string;
  kind: WorkFoldTaskKind;
  spaceId: string;
  conversationId?: string;
  actor: WorkFoldActor;
}

/**
 * Experimental internal task shape for Checks dogfooding. It is deliberately
 * separate from WorkFoldTaskKind and must not enter space.tasks v1.
 */
export interface WorkFoldExperimentalCheckRunTaskInput {
  id?: string;
  spaceId: string;
  actor: WorkFoldActor;
}

export interface WorkFoldExperimentalCheckRunTask {
  id: string;
  kind: "check_run";
  status: "running";
  spaceId: string;
  actor: WorkFoldActor;
  startedAt: string;
}

export interface WorkFoldTasksSnapshot {
  kind: "work-fold.tasks";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  spaceId: string | null;
  tasks: WorkFoldTaskSnapshot[];
}

export type WorkFoldCapabilityScope = "global" | "project" | "temporary";
export type WorkFoldCapabilityOrigin = "package" | "top-level";
export type WorkFoldCapabilityStatus = "loaded";

export interface WorkFoldCapabilityProvenance {
  label: string;
  source: string;
  path: string;
  scope: WorkFoldCapabilityScope;
  origin: WorkFoldCapabilityOrigin;
  baseDir?: string;
  packageSource?: string;
}

export interface WorkFoldCapabilityTrustSnapshot {
  required: boolean;
  trusted: boolean;
  savedDecision: boolean | null;
  mutationTrusted: boolean;
}

export interface WorkFoldPackageSnapshot {
  source: string;
  scope: "global" | "project";
  filtered: boolean;
  installedPath?: string;
  installed: boolean;
  loaded: boolean;
}

interface WorkFoldLoadedCapabilitySnapshot {
  source: string;
  scope: WorkFoldCapabilityScope;
  origin: WorkFoldCapabilityOrigin;
  packageSource?: string;
  sourceInfo: WorkFoldCapabilityProvenance;
  provenance: WorkFoldCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: WorkFoldCapabilityStatus;
}

export interface WorkFoldSkillSnapshot extends WorkFoldLoadedCapabilitySnapshot {
  name: string;
  description: string;
  path: string;
  content?: string;
  disableModelInvocation?: true;
}

export interface WorkFoldExtensionSnapshot extends WorkFoldLoadedCapabilitySnapshot {
  id: string;
  name: string;
  path: string;
  commands: string[];
  tools: string[];
  flags: string[];
}

export interface WorkFoldExtensionSurfaceSnapshot extends WorkFoldLoadedCapabilitySnapshot {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  extensionPath: string;
  manifestPath: string;
  views: PiResourceCatalog["surfaces"][number]["views"];
}

export interface WorkFoldToolSnapshot extends WorkFoldLoadedCapabilitySnapshot {
  name: string;
  label: string;
  description: string;
  active: boolean;
  kind: "core" | "extension";
  core: boolean;
  configurable: false;
  configurationScope: "chat";
}

export interface WorkFoldPromptSnapshot extends WorkFoldLoadedCapabilitySnapshot {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
}

export interface WorkFoldThemeSnapshot {
  name: string;
  path?: string;
  source?: string;
  scope?: WorkFoldCapabilityScope;
  origin?: WorkFoldCapabilityOrigin;
  packageSource?: string;
  sourceInfo?: WorkFoldCapabilityProvenance;
  provenance?: WorkFoldCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: WorkFoldCapabilityStatus;
}

export interface WorkFoldCommandSnapshot {
  name: string;
  description?: string;
  kind: "builtin" | "extension" | "prompt" | "skill";
  source: string;
  scope?: WorkFoldCapabilityScope;
  origin?: WorkFoldCapabilityOrigin;
  packageSource?: string;
  sourceInfo?: WorkFoldCapabilityProvenance;
  provenance?: WorkFoldCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: WorkFoldCapabilityStatus;
}

export interface WorkFoldCapabilityDiagnosticSnapshot {
  type: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface WorkFoldCapabilityCatalogSnapshot {
  projectTrust: WorkFoldCapabilityTrustSnapshot;
  trust: WorkFoldCapabilityTrustSnapshot;
  projectTrusted: boolean;
  packages: WorkFoldPackageSnapshot[];
  toolManagement: PiResourceCatalog["toolManagement"];
  skills: WorkFoldSkillSnapshot[];
  extensions: WorkFoldExtensionSnapshot[];
  surfaces: WorkFoldExtensionSurfaceSnapshot[];
  tools: WorkFoldToolSnapshot[];
  prompts: WorkFoldPromptSnapshot[];
  themes: WorkFoldThemeSnapshot[];
  commands: WorkFoldCommandSnapshot[];
  diagnostics: WorkFoldCapabilityDiagnosticSnapshot[];
}

export interface WorkFoldCapabilitiesSnapshot {
  kind: "work-fold.capabilities";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  space: WorkFoldSpaceSnapshot;
  catalog: WorkFoldCapabilityCatalogSnapshot;
}

export interface WorkFoldKernelOptions {
  runtimeProvider?: PiRuntimeProvider;
  listSpaces?: () => Promise<SpaceSummary[]>;
  getSpace?: (spaceId: string) => Promise<SpaceSummary>;
  loadCapabilityCatalog?: (spaceRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiResourceCatalog>;
  listPackages?: (spaceRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiConfiguredPackage[]>;
  isProjectMutationTrusted?: (spaceRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<boolean>;
  now?: () => Date;
  createTaskId?: () => string;
}

export class WorkFoldContextRequiredError extends Error {
  readonly code = "WORKFOLD_CONTEXT_REQUIRED";

  constructor() {
    super("A Space must be selected explicitly or resolved from the actor's current directory.");
    this.name = "WorkFoldContextRequiredError";
  }
}

/**
 * Reusable in-process authority for the read-only Space control plane.
 * HTTP, CLI, and Assistant adapters consume the same typed snapshots while
 * mutation policy remains in the owning domain services.
 */
export class WorkFoldKernel {
  readonly #runtimeProvider?: PiRuntimeProvider;
  readonly #listSpaces: () => Promise<SpaceSummary[]>;
  readonly #getSpace: (spaceId: string) => Promise<SpaceSummary>;
  readonly #loadCapabilityCatalog: WorkFoldKernelOptions["loadCapabilityCatalog"] & {};
  readonly #listPackages: WorkFoldKernelOptions["listPackages"] & {};
  readonly #isProjectMutationTrusted: WorkFoldKernelOptions["isProjectMutationTrusted"] & {};
  readonly #now: () => Date;
  readonly #createTaskId: () => string;
  readonly #tasks = new Map<string, WorkFoldTaskSnapshot | WorkFoldExperimentalCheckRunTask>();

  constructor(options: WorkFoldKernelOptions = {}) {
    this.#runtimeProvider = options.runtimeProvider;
    this.#listSpaces = options.listSpaces ?? listSpaces;
    this.#getSpace = options.getSpace ?? getSpace;
    this.#loadCapabilityCatalog = options.loadCapabilityCatalog ?? loadAgentSkillCatalog;
    this.#listPackages = options.listPackages ?? listPiPackages;
    this.#isProjectMutationTrusted = options.isProjectMutationTrusted ?? isPiProjectMutationTrusted;
    this.#now = options.now ?? (() => new Date());
    this.#createTaskId = options.createTaskId ?? (() => `task-${randomUUID()}`);
  }

  async getContext(actor: WorkFoldActor): Promise<WorkFoldContextSnapshot> {
    const normalizedActor = normalizeActor(actor);
    if (normalizedActor.spaceId) {
      return {
        kind: "work-fold.context",
        version: workFoldKernelSnapshotVersion,
        actor: normalizedActor,
        resolution: "space_id",
        space: toSpaceSnapshot(await this.#getSpace(normalizedActor.spaceId)),
      };
    }

    if (normalizedActor.cwd) {
      const cwd = resolve(normalizedActor.cwd);
      const candidates = (await this.#listSpaces())
        .filter((space) => pathContains(space.spaceRoot, cwd))
        .sort((left, right) => resolve(right.spaceRoot).length - resolve(left.spaceRoot).length);
      if (candidates[0]) {
        return {
          kind: "work-fold.context",
          version: workFoldKernelSnapshotVersion,
          actor: normalizedActor,
          resolution: "cwd",
          space: toSpaceSnapshot(candidates[0]),
        };
      }
    }

    return {
      kind: "work-fold.context",
      version: workFoldKernelSnapshotVersion,
      actor: normalizedActor,
      resolution: "none",
      space: null,
    };
  }

  async getSpaces(actor: WorkFoldActor): Promise<WorkFoldSpacesSnapshot> {
    return {
      kind: "work-fold.spaces",
      version: workFoldKernelSnapshotVersion,
      actor: normalizeActor(actor),
      spaces: (await this.#listSpaces()).map(toSpaceSnapshot),
    };
  }

  async getTasks(actor: WorkFoldActor): Promise<WorkFoldTasksSnapshot> {
    const normalizedActor = normalizeActor(actor);
    const scoped = Boolean(normalizedActor.spaceId || normalizedActor.cwd);
    const context = scoped ? await this.getContext(normalizedActor) : null;
    const spaceId = context?.space?.id ?? null;
    const tasks = [...this.#tasks.values()]
      .filter((task): task is WorkFoldTaskSnapshot => task.kind !== "check_run")
      .filter((task) => !scoped || task.spaceId === spaceId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map(copyTask);
    return {
      kind: "work-fold.tasks",
      version: workFoldKernelSnapshotVersion,
      actor: normalizedActor,
      spaceId,
      tasks,
    };
  }

  async getCapabilities(actor: WorkFoldActor): Promise<WorkFoldCapabilitiesSnapshot> {
    const context = await this.getContext(actor);
    if (!context.space) throw new WorkFoldContextRequiredError();
    const [catalog, packages, mutationTrusted] = await Promise.all([
      this.#loadCapabilityCatalog(context.space.spaceRoot, this.#runtimeProvider),
      this.#listPackages(context.space.spaceRoot, this.#runtimeProvider),
      this.#isProjectMutationTrusted(context.space.spaceRoot, this.#runtimeProvider),
    ]);
    return {
      kind: "work-fold.capabilities",
      version: workFoldKernelSnapshotVersion,
      actor: context.actor,
      space: context.space,
      catalog: buildWorkFoldCapabilityCatalog(catalog, packages, mutationTrusted),
    };
  }

  startTask(input: WorkFoldTaskInput): WorkFoldTaskSnapshot {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("Space task id is required.");
    if (this.#tasks.has(id)) throw new Error(`Space task is already running: ${id}`);
    const spaceId = input.spaceId.trim();
    if (!spaceId) throw new Error("Space task Space id is required.");
    const task: WorkFoldTaskSnapshot = {
      id,
      kind: input.kind,
      status: "running",
      spaceId,
      ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyTask(task);
  }

  /**
   * Starts a Check run in the shared internal lifecycle without promoting the
   * experimental kind into the stable space.tasks v1 projection.
   */
  startExperimentalCheckRunTask(input: WorkFoldExperimentalCheckRunTaskInput): WorkFoldExperimentalCheckRunTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("Space task id is required.");
    if (this.#tasks.has(id)) throw new Error(`Space task is already running: ${id}`);
    const spaceId = input.spaceId.trim();
    if (!spaceId) throw new Error("Space task Space id is required.");
    const task: WorkFoldExperimentalCheckRunTask = {
      id,
      kind: "check_run",
      status: "running",
      spaceId,
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

export function buildWorkFoldCapabilityCatalog(
  catalog: PiResourceCatalog,
  packages: PiConfiguredPackage[],
  mutationTrusted: boolean,
): WorkFoldCapabilityCatalogSnapshot {
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
  scope: WorkFoldCapabilityScope;
  origin: WorkFoldCapabilityOrigin;
  packageSource?: string;
  sourceInfo: WorkFoldCapabilityProvenance;
  provenance: WorkFoldCapabilityProvenance;
} {
  const scope: WorkFoldCapabilityScope = source.scope === "user" ? "global" : source.scope;
  const provenance: WorkFoldCapabilityProvenance = {
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

function normalizeActor(actor: WorkFoldActor): WorkFoldActor {
  return {
    kind: actor.kind,
    ...(actor.cwd?.trim() ? { cwd: resolve(actor.cwd.trim()) } : {}),
    ...(actor.spaceId?.trim() ? { spaceId: actor.spaceId.trim() } : {}),
    ...(actor.conversationId?.trim() ? { conversationId: actor.conversationId.trim() } : {}),
  };
}

function toSpaceSnapshot(space: SpaceSummary): WorkFoldSpaceSnapshot {
  return {
    id: space.id,
    name: space.name,
    spaceRoot: resolve(space.spaceRoot),
    location: { ...space.location },
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
  };
}

function copyTask(task: WorkFoldTaskSnapshot): WorkFoldTaskSnapshot {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalCheckRunTask(task: WorkFoldExperimentalCheckRunTask): WorkFoldExperimentalCheckRunTask {
  return { ...task, actor: { ...task.actor } };
}

function pathContains(rootPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
