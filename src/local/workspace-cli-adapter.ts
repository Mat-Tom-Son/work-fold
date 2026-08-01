import {
  WorkspaceCliError,
  type WorkspaceCliActor,
  type WorkspaceCliCapabilitySummary,
  type WorkspaceCliCheckStatusSummary,
  type WorkspaceCliContextSnapshot,
  type WorkspaceCliKernel,
  type WorkspaceCliSpaceSummary,
  type WorkspaceCliTaskSummary,
} from "./cli/protocol.js";
import {
  workspaceCheckExperimentalSnapshotVersion,
  type WorkspaceCheckStatusSnapshot,
} from "./checks/check-types.js";
import {
  WorkspaceContextRequiredError,
  type WorkspaceActor,
  type WorkspaceCapabilityScope,
  type WorkspaceSpaceSnapshot,
  WorkspaceKernel,
} from "./workspace-kernel.js";

interface WorkspaceCliOptions {
  space?: string;
}

export interface WorkspaceCliCheckStatusProviderInput {
  workspaceId: string;
  workspaceRoot: string;
}

export type WorkspaceCliCheckStatusProvider = (
  input: WorkspaceCliCheckStatusProviderInput,
) => Promise<WorkspaceCheckStatusSnapshot>;

export interface WorkspaceCliKernelAdapterOptions {
  checksStatusProvider?: WorkspaceCliCheckStatusProvider;
}

/**
 * Thin CLI projection over the shared WorkspaceKernel. The adapter owns CLI
 * selection rules and deliberately emits only compact, content-free summaries.
 */
export class WorkspaceCliKernelAdapter implements WorkspaceCliKernel {
  readonly #checksStatusProvider?: WorkspaceCliCheckStatusProvider;

  constructor(readonly kernel: WorkspaceKernel, options: WorkspaceCliKernelAdapterOptions = {}) {
    this.#checksStatusProvider = options.checksStatusProvider;
  }

  async getContext(
    actor: WorkspaceCliActor,
    options: WorkspaceCliOptions,
  ): Promise<WorkspaceCliContextSnapshot> {
    const selected = await this.#selectSpace(actor, options.space);
    const context = selected
      ? await this.kernel.getContext(scopedActor(actor, selected.id))
      : await this.kernel.getContext(actor);

    return {
      cwd: actor.cwd,
      space: context.workspace ? summarizeSpace(context.workspace, true) : null,
      selectedPath: null,
      activeSurface: null,
    };
  }

  async listSpaces(
    actor: WorkspaceCliActor,
    options: WorkspaceCliOptions,
  ): Promise<WorkspaceCliSpaceSummary[]> {
    const snapshot = await this.kernel.getSpaces(actor);
    const selected = resolveWorkspaceCliSpaceSelector(snapshot.spaces, options.space);
    const activeId = selected?.id ?? (await this.kernel.getContext(actor)).workspace?.id;
    const spaces = selected ? [selected] : snapshot.spaces;
    return spaces.map((space) => summarizeSpace(space, space.id === activeId));
  }

  async listTasks(
    actor: WorkspaceCliActor,
    options: WorkspaceCliOptions,
  ): Promise<WorkspaceCliTaskSummary[]> {
    const selected = await this.#selectSpace(actor, options.space);
    const snapshot = await this.kernel.getTasks(selected ? scopedActor(actor, selected.id) : actor);
    return snapshot.tasks.map((task) => ({
      id: task.id,
      label: task.kind === "assistant_turn" ? "Assistant turn" : "Chat compaction",
      status: task.status,
      workspaceId: task.workspaceId,
      updatedAt: task.startedAt,
    }));
  }

  async listCapabilities(
    actor: WorkspaceCliActor,
    options: WorkspaceCliOptions,
  ): Promise<WorkspaceCliCapabilitySummary[]> {
    const selected = await this.#selectSpace(actor, options.space);
    try {
      const snapshot = await this.kernel.getCapabilities(selected ? scopedActor(actor, selected.id) : actor);
      const { catalog } = snapshot;
      return [
        ...catalog.skills.map((skill): WorkspaceCliCapabilitySummary => ({
          id: `skill:${skill.scope}:${skill.path}`,
          name: skill.name,
          kind: "skill",
          scope: cliScope(skill.scope),
          status: skill.status,
          source: skill.source,
        })),
        ...catalog.extensions.map((extension): WorkspaceCliCapabilitySummary => ({
          id: `extension:${extension.scope}:${extension.id}`,
          name: extension.name,
          kind: "extension",
          scope: cliScope(extension.scope),
          status: extension.status,
          source: extension.source,
        })),
        ...catalog.tools.map((tool): WorkspaceCliCapabilitySummary => ({
          id: `tool:${tool.scope}:${tool.name}`,
          name: tool.label || tool.name,
          kind: "tool",
          scope: cliScope(tool.scope),
          status: tool.active ? tool.status : "inactive",
          source: tool.source,
        })),
        ...catalog.packages.map((item): WorkspaceCliCapabilitySummary => ({
          id: `package:${item.scope}:${item.source}`,
          name: item.source,
          kind: "package",
          scope: cliScope(item.scope),
          status: item.loaded ? "loaded" : item.installed ? "installed" : "missing",
          source: item.source,
        })),
        ...catalog.prompts.map((prompt): WorkspaceCliCapabilitySummary => ({
          id: `prompt:${prompt.scope}:${prompt.path}`,
          name: prompt.name,
          kind: "other",
          scope: cliScope(prompt.scope),
          status: prompt.status,
          source: prompt.source,
        })),
        ...catalog.themes.map((theme): WorkspaceCliCapabilitySummary => ({
          id: `theme:${theme.scope ?? "global"}:${theme.path ?? theme.name}`,
          name: theme.name,
          kind: "other",
          scope: cliScope(theme.scope),
          status: theme.status,
          ...(theme.source ? { source: theme.source } : {}),
        })),
        ...catalog.commands.map((command): WorkspaceCliCapabilitySummary => ({
          id: `command:${command.scope ?? "global"}:${command.name}`,
          name: command.name,
          kind: "other",
          scope: cliScope(command.scope),
          status: command.status,
          source: command.source,
        })),
      ].sort(compareCapabilitySummaries);
    } catch (error) {
      if (error instanceof WorkspaceContextRequiredError) {
        throw new WorkspaceCliError(
          "notFound",
          "No Space contains the current working directory. Select one with --space <id-or-name>.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getChecksStatus(
    actor: WorkspaceCliActor,
    options: WorkspaceCliOptions,
  ): Promise<WorkspaceCliCheckStatusSummary> {
    const selected = await this.#selectSpace(actor, options.space);
    const context = await this.kernel.getContext(selected ? scopedActor(actor, selected.id) : actor);
    if (!context.workspace) {
      throw new WorkspaceCliError(
        "notFound",
        "No Space contains the current working directory. Select one with --space <id-or-name>.",
      );
    }
    const unavailable = unavailableChecksStatus(context.workspace.id);
    if (!this.#checksStatusProvider) return unavailable;
    try {
      const snapshot = await this.#checksStatusProvider({
        workspaceId: context.workspace.id,
        workspaceRoot: context.workspace.rootPath,
      });
      return projectChecksStatus(snapshot, context.workspace.id) ?? unavailable;
    } catch {
      // Provider failures may contain file paths or Check error details. The
      // read lane exposes only the fact that aggregate status is unavailable.
      return unavailable;
    }
  }

  async #selectSpace(actor: WorkspaceCliActor, selector: string | undefined): Promise<WorkspaceSpaceSnapshot | undefined> {
    if (selector === undefined) return undefined;
    return resolveWorkspaceCliSpaceSelector((await this.kernel.getSpaces(actor)).spaces, selector);
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

function projectChecksStatus(snapshot: WorkspaceCheckStatusSnapshot, workspaceId: string): WorkspaceCliCheckStatusSummary | null {
  if (!snapshot || snapshot.kind !== "workspace.checks.experimental" || snapshot.version !== workspaceCheckExperimentalSnapshotVersion) return null;
  if (snapshot.workspaceId !== workspaceId || !checkStates.has(snapshot.state)) return null;
  const counts = [
    snapshot.configured,
    snapshot.proposed,
    snapshot.enabled,
    snapshot.current,
    snapshot.stale,
    snapshot.blocked,
    snapshot.errors,
    snapshot.needsAttention,
    snapshot.running,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  if (snapshot.lastRunAt !== null && (typeof snapshot.lastRunAt !== "string" || !Number.isFinite(Date.parse(snapshot.lastRunAt)))) return null;
  return {
    kind: "workspace.checks.experimental",
    version: workspaceCheckExperimentalSnapshotVersion,
    available: true,
    workspaceId,
    state: snapshot.state,
    configured: snapshot.configured,
    proposed: snapshot.proposed,
    enabled: snapshot.enabled,
    current: snapshot.current,
    stale: snapshot.stale,
    blocked: snapshot.blocked,
    errors: snapshot.errors,
    needsAttention: snapshot.needsAttention,
    running: snapshot.running,
    lastRunAt: snapshot.lastRunAt === null ? null : new Date(snapshot.lastRunAt).toISOString(),
  };
}

function unavailableChecksStatus(workspaceId: string): WorkspaceCliCheckStatusSummary {
  return {
    kind: "workspace.checks.experimental",
    version: workspaceCheckExperimentalSnapshotVersion,
    available: false,
    workspaceId,
    state: "unavailable",
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  };
}

/**
 * Shared "--space <id-or-exact-name>" selection: an id match wins, a unique
 * case-folded name match is accepted, and duplicates are rejected as
 * ambiguous. The act facade reuses this so both CLI lanes select identically.
 */
export function resolveWorkspaceCliSpaceSelector<T extends { id: string; name: string }>(
  spaces: T[],
  selector: string | undefined,
): T | undefined {
  if (selector === undefined) return undefined;
  const normalized = selector.trim();
  const idMatch = spaces.find((space) => space.id === normalized);
  if (idMatch) return idMatch;

  const folded = normalized.toLocaleLowerCase("en-US");
  const nameMatches = spaces.filter((space) => space.name.toLocaleLowerCase("en-US") === folded);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new WorkspaceCliError(
      "conflict",
      `Space name is ambiguous: ${normalized || "(empty)"}. Use an exact Space id.`,
    );
  }
  throw new WorkspaceCliError("notFound", `Space not found: ${normalized || "(empty)"}.`);
}

function scopedActor(actor: WorkspaceCliActor, workspaceId: string): WorkspaceActor {
  return { ...actor, workspaceId };
}

function summarizeSpace(space: WorkspaceSpaceSnapshot, active: boolean): WorkspaceCliSpaceSummary {
  return {
    id: space.id,
    name: space.name,
    rootPath: space.rootPath,
    active,
  };
}

function cliScope(scope: WorkspaceCapabilityScope | "global" | "project" | undefined): string {
  if (scope === "global" || scope === undefined) return "personal";
  if (scope === "project") return "space";
  return scope;
}

function compareCapabilitySummaries(
  left: WorkspaceCliCapabilitySummary,
  right: WorkspaceCliCapabilitySummary,
): number {
  const order: Record<WorkspaceCliCapabilitySummary["kind"], number> = {
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
