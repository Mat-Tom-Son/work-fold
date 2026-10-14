import {
  WorkFoldCliError,
  type WorkFoldCliActor,
  type WorkFoldCliCapabilitySummary,
  type WorkFoldCliCheckStatusSummary,
  type WorkFoldCliContextSnapshot,
  type WorkFoldCliKernel,
  type WorkFoldCliWorkFolderSummary,
  type WorkFoldCliTaskSummary,
} from "./cli/protocol.js";
import {
  workFoldCheckExperimentalSnapshotVersion,
  type WorkFoldCheckStatusSnapshot,
} from "./checks/check-types.js";
import {
  WorkFoldContextRequiredError,
  type WorkFoldActor,
  type WorkFoldCapabilityScope,
  type WorkFoldWorkFolderSnapshot,
  WorkFoldKernel,
} from "./work-fold-kernel.js";
import { workFoldAgentScopeId } from "./state-paths.js";

interface WorkFoldCliOptions {
  workFolder?: string;
}

export interface WorkFoldCliCheckStatusProviderInput {
  workFolderId: string;
  workFolderRoot: string;
}

export type WorkFoldCliCheckStatusProvider = (
  input: WorkFoldCliCheckStatusProviderInput,
) => Promise<WorkFoldCheckStatusSnapshot>;

export interface WorkFoldCliKernelAdapterOptions {
  checksStatusProvider?: WorkFoldCliCheckStatusProvider;
}

/**
 * Thin CLI projection over the shared WorkFoldKernel. The adapter owns CLI
 * selection rules and deliberately emits only compact, content-free summaries.
 */
export class WorkFoldCliKernelAdapter implements WorkFoldCliKernel {
  readonly #checksStatusProvider?: WorkFoldCliCheckStatusProvider;

  constructor(readonly kernel: WorkFoldKernel, options: WorkFoldCliKernelAdapterOptions = {}) {
    this.#checksStatusProvider = options.checksStatusProvider;
  }

  async getContext(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliContextSnapshot> {
    const selected = await this.#selectWorkFolder(actor, options.workFolder);
    const context = selected
      ? await this.kernel.getContext(scopedActor(actor, selected.id))
      : await this.kernel.getContext(actor);

    return {
      cwd: actor.cwd,
      workFolder: context.workFolder ? summarizeWorkFolder(context.workFolder, true) : null,
      selectedPath: null,
      activeSurface: null,
    };
  }

  async listWorkFolders(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliWorkFolderSummary[]> {
    const snapshot = await this.kernel.getWorkFolders(actor);
    const selected = resolveWorkFoldCliWorkFolderSelector(snapshot.workFolders, options.workFolder);
    const activeId = selected?.id ?? (await this.kernel.getContext(actor)).workFolder?.id;
    const workFolders = selected ? [selected] : snapshot.workFolders;
    return workFolders.map((workFolder) => summarizeWorkFolder(workFolder, workFolder.id === activeId));
  }

  async listTasks(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliTaskSummary[]> {
    const selected = await this.#selectWorkFolder(actor, options.workFolder);
    const snapshot = await this.kernel.getTasks(selected ? scopedActor(actor, selected.id) : actor);
    return snapshot.tasks.map((task) => ({
      id: task.id,
      label: task.kind !== "assistant_turn"
        ? "Chat compaction"
        : task.workFolderId === workFoldAgentScopeId ? "work-fold agent turn" : "Worker turn",
      status: task.status,
      workFolderId: task.workFolderId,
      updatedAt: task.startedAt,
    }));
  }

  async listCapabilities(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliCapabilitySummary[]> {
    const selected = await this.#selectWorkFolder(actor, options.workFolder);
    try {
      const snapshot = await this.kernel.getCapabilities(selected ? scopedActor(actor, selected.id) : actor);
      const { catalog } = snapshot;
      return [
        ...catalog.skills.map((skill): WorkFoldCliCapabilitySummary => ({
          id: `skill:${skill.scope}:${skill.path}`,
          name: skill.name,
          kind: "skill",
          scope: cliScope(skill.scope),
          status: skill.status,
          source: skill.source,
        })),
        ...catalog.extensions.map((extension): WorkFoldCliCapabilitySummary => ({
          id: `extension:${extension.scope}:${extension.id}`,
          name: extension.name,
          kind: "extension",
          scope: cliScope(extension.scope),
          status: extension.status,
          source: extension.source,
        })),
        ...catalog.tools.map((tool): WorkFoldCliCapabilitySummary => ({
          id: `tool:${tool.scope}:${tool.name}`,
          name: tool.label || tool.name,
          kind: "tool",
          scope: cliScope(tool.scope),
          status: tool.active ? tool.status : "inactive",
          source: tool.source,
        })),
        ...catalog.packages.map((item): WorkFoldCliCapabilitySummary => ({
          id: `package:${item.scope}:${item.source}`,
          name: item.source,
          kind: "package",
          scope: cliScope(item.scope),
          status: item.loaded ? "loaded" : item.installed ? "installed" : "missing",
          source: item.source,
        })),
        ...catalog.prompts.map((prompt): WorkFoldCliCapabilitySummary => ({
          id: `prompt:${prompt.scope}:${prompt.path}`,
          name: prompt.name,
          kind: "other",
          scope: cliScope(prompt.scope),
          status: prompt.status,
          source: prompt.source,
        })),
        ...catalog.themes.map((theme): WorkFoldCliCapabilitySummary => ({
          id: `theme:${theme.scope ?? "global"}:${theme.path ?? theme.name}`,
          name: theme.name,
          kind: "other",
          scope: cliScope(theme.scope),
          status: theme.status,
          ...(theme.source ? { source: theme.source } : {}),
        })),
        ...catalog.commands.map((command): WorkFoldCliCapabilitySummary => ({
          id: `command:${command.scope ?? "global"}:${command.name}`,
          name: command.name,
          kind: "other",
          scope: cliScope(command.scope),
          status: command.status,
          source: command.source,
        })),
      ].sort(compareCapabilitySummaries);
    } catch (error) {
      if (error instanceof WorkFoldContextRequiredError) {
        throw new WorkFoldCliError(
          "notFound",
          "No work-folder contains the current working directory. Select one with --work-folder <id-or-name>.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getChecksStatus(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliCheckStatusSummary> {
    const selected = await this.#selectWorkFolder(actor, options.workFolder);
    const context = await this.kernel.getContext(selected ? scopedActor(actor, selected.id) : actor);
    if (!context.workFolder) {
      throw new WorkFoldCliError(
        "notFound",
        "No work-folder contains the current working directory. Select one with --work-folder <id-or-name>.",
      );
    }
    const unavailable = unavailableChecksStatus(context.workFolder.id);
    if (!this.#checksStatusProvider) return unavailable;
    try {
      const snapshot = await this.#checksStatusProvider({
        workFolderId: context.workFolder.id,
        workFolderRoot: context.workFolder.workFolderRoot,
      });
      return projectChecksStatus(snapshot, context.workFolder.id) ?? unavailable;
    } catch {
      // Provider failures may contain file paths or Check error details. The
      // read lane exposes only the fact that aggregate status is unavailable.
      return unavailable;
    }
  }

  async #selectWorkFolder(actor: WorkFoldCliActor, selector: string | undefined): Promise<WorkFoldWorkFolderSnapshot | undefined> {
    if (selector === undefined) return undefined;
    return resolveWorkFoldCliWorkFolderSelector((await this.kernel.getWorkFolders(actor)).workFolders, selector);
  }
}

const checkStates = new Set([
  "not-configured",
  "current-clear",
  "needs-attention",
  "stale",
  "blocked",
  "check-error",
]);

function projectChecksStatus(snapshot: WorkFoldCheckStatusSnapshot, workFolderId: string): WorkFoldCliCheckStatusSummary | null {
  if (!snapshot || snapshot.kind !== "work-fold.checks.experimental" || snapshot.version !== workFoldCheckExperimentalSnapshotVersion) return null;
  if (snapshot.workFolderId !== workFolderId || !checkStates.has(snapshot.state)) return null;
  const counts = [
    snapshot.configured,
    snapshot.proposed,
    snapshot.enabled,
    snapshot.current,
    snapshot.neverRun,
    snapshot.stale,
    snapshot.blocked,
    snapshot.errors,
    snapshot.needsAttention,
    snapshot.running,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  if (snapshot.current + snapshot.neverRun + snapshot.stale > snapshot.enabled) return null;
  if (snapshot.proposed + snapshot.enabled + snapshot.blocked > snapshot.configured) return null;
  if (snapshot.lastRunAt !== null && (typeof snapshot.lastRunAt !== "string" || !Number.isFinite(Date.parse(snapshot.lastRunAt)))) return null;
  return {
    kind: "work-fold.checks.experimental",
    version: workFoldCheckExperimentalSnapshotVersion,
    available: true,
    workFolderId,
    state: snapshot.state,
    configured: snapshot.configured,
    proposed: snapshot.proposed,
    enabled: snapshot.enabled,
    current: snapshot.current,
    neverRun: snapshot.neverRun,
    stale: snapshot.stale,
    blocked: snapshot.blocked,
    errors: snapshot.errors,
    needsAttention: snapshot.needsAttention,
    running: snapshot.running,
    lastRunAt: snapshot.lastRunAt === null ? null : new Date(snapshot.lastRunAt).toISOString(),
  };
}

function unavailableChecksStatus(workFolderId: string): WorkFoldCliCheckStatusSummary {
  return {
    kind: "work-fold.checks.experimental",
    version: workFoldCheckExperimentalSnapshotVersion,
    available: false,
    workFolderId,
    state: "unavailable",
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  };
}

/**
 * Shared "--work-folder <id-or-exact-name>" selection: an id match wins, a unique
 * case-folded name match is accepted, and duplicates are rejected as
 * ambiguous. The act facade reuses this so both CLI lanes select identically.
 */
export function resolveWorkFoldCliWorkFolderSelector<T extends { id: string; name: string }>(
  workFolders: T[],
  selector: string | undefined,
): T | undefined {
  if (selector === undefined) return undefined;
  const normalized = selector.trim();
  const idMatch = workFolders.find((workFolder) => workFolder.id === normalized);
  if (idMatch) return idMatch;

  const folded = normalized.toLocaleLowerCase("en-US");
  const nameMatches = workFolders.filter((workFolder) => workFolder.name.toLocaleLowerCase("en-US") === folded);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new WorkFoldCliError(
      "conflict",
      `work-folder name is ambiguous: ${normalized || "(empty)"}. Use an exact work-folder id.`,
    );
  }
  throw new WorkFoldCliError("notFound", `work-folder not found: ${normalized || "(empty)"}.`);
}

function scopedActor(actor: WorkFoldCliActor, workFolderId: string): WorkFoldActor {
  return { ...actor, workFolderId };
}

function summarizeWorkFolder(workFolder: WorkFoldWorkFolderSnapshot, active: boolean): WorkFoldCliWorkFolderSummary {
  return {
    id: workFolder.id,
    name: workFolder.name,
    workFolderRoot: workFolder.workFolderRoot,
    active,
    ...(workFolder.parentWorkFolderId ? { parentWorkFolderId: workFolder.parentWorkFolderId } : {}),
  };
}

function cliScope(scope: WorkFoldCapabilityScope | "global" | "project" | undefined): string {
  if (scope === "global" || scope === undefined) return "everywhere";
  if (scope === "project") return "work-folder";
  return scope;
}

function compareCapabilitySummaries(
  left: WorkFoldCliCapabilitySummary,
  right: WorkFoldCliCapabilitySummary,
): number {
  const order: Record<WorkFoldCliCapabilitySummary["kind"], number> = {
    skill: 0,
    extension: 1,
    tool: 2,
    package: 3,
    other: 4,
  };
  return order[left.kind] - order[right.kind]
    || left.name.localeCompare(right.name, "en-US", { sensitivity: "base" })
    || left.id.localeCompare(right.id, "en-US");
}
