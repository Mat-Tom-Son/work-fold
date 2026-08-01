import {
  WorkFoldCliError,
  type WorkFoldCliActor,
  type WorkFoldCliCapabilitySummary,
  type WorkFoldCliCheckStatusSummary,
  type WorkFoldCliContextSnapshot,
  type WorkFoldCliKernel,
  type WorkFoldCliSpaceSummary,
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
  type WorkFoldSpaceSnapshot,
  WorkFoldKernel,
} from "./work-fold-kernel.js";

interface WorkFoldCliOptions {
  space?: string;
}

export interface WorkFoldCliCheckStatusProviderInput {
  spaceId: string;
  spaceRoot: string;
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
    const selected = await this.#selectSpace(actor, options.space);
    const context = selected
      ? await this.kernel.getContext(scopedActor(actor, selected.id))
      : await this.kernel.getContext(actor);

    return {
      cwd: actor.cwd,
      space: context.space ? summarizeSpace(context.space, true) : null,
      selectedPath: null,
      activeSurface: null,
    };
  }

  async listSpaces(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliSpaceSummary[]> {
    const snapshot = await this.kernel.getSpaces(actor);
    const selected = resolveWorkFoldCliSpaceSelector(snapshot.spaces, options.space);
    const activeId = selected?.id ?? (await this.kernel.getContext(actor)).space?.id;
    const spaces = selected ? [selected] : snapshot.spaces;
    return spaces.map((space) => summarizeSpace(space, space.id === activeId));
  }

  async listTasks(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliTaskSummary[]> {
    const selected = await this.#selectSpace(actor, options.space);
    const snapshot = await this.kernel.getTasks(selected ? scopedActor(actor, selected.id) : actor);
    return snapshot.tasks.map((task) => ({
      id: task.id,
      label: task.kind === "assistant_turn" ? "Assistant turn" : "Chat compaction",
      status: task.status,
      spaceId: task.spaceId,
      updatedAt: task.startedAt,
    }));
  }

  async listCapabilities(
    actor: WorkFoldCliActor,
    options: WorkFoldCliOptions,
  ): Promise<WorkFoldCliCapabilitySummary[]> {
    const selected = await this.#selectSpace(actor, options.space);
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
          "No Space contains the current working directory. Select one with --space <id-or-name>.",
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
    const selected = await this.#selectSpace(actor, options.space);
    const context = await this.kernel.getContext(selected ? scopedActor(actor, selected.id) : actor);
    if (!context.space) {
      throw new WorkFoldCliError(
        "notFound",
        "No Space contains the current working directory. Select one with --space <id-or-name>.",
      );
    }
    const unavailable = unavailableChecksStatus(context.space.id);
    if (!this.#checksStatusProvider) return unavailable;
    try {
      const snapshot = await this.#checksStatusProvider({
        spaceId: context.space.id,
        spaceRoot: context.space.spaceRoot,
      });
      return projectChecksStatus(snapshot, context.space.id) ?? unavailable;
    } catch {
      // Provider failures may contain file paths or Check error details. The
      // read lane exposes only the fact that aggregate status is unavailable.
      return unavailable;
    }
  }

  async #selectSpace(actor: WorkFoldCliActor, selector: string | undefined): Promise<WorkFoldSpaceSnapshot | undefined> {
    if (selector === undefined) return undefined;
    return resolveWorkFoldCliSpaceSelector((await this.kernel.getSpaces(actor)).spaces, selector);
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

function projectChecksStatus(snapshot: WorkFoldCheckStatusSnapshot, spaceId: string): WorkFoldCliCheckStatusSummary | null {
  if (!snapshot || snapshot.kind !== "work-fold.checks.experimental" || snapshot.version !== workFoldCheckExperimentalSnapshotVersion) return null;
  if (snapshot.spaceId !== spaceId || !checkStates.has(snapshot.state)) return null;
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
    spaceId,
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

function unavailableChecksStatus(spaceId: string): WorkFoldCliCheckStatusSummary {
  return {
    kind: "work-fold.checks.experimental",
    version: workFoldCheckExperimentalSnapshotVersion,
    available: false,
    spaceId,
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
 * Shared "--space <id-or-exact-name>" selection: an id match wins, a unique
 * case-folded name match is accepted, and duplicates are rejected as
 * ambiguous. The act facade reuses this so both CLI lanes select identically.
 */
export function resolveWorkFoldCliSpaceSelector<T extends { id: string; name: string }>(
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
    throw new WorkFoldCliError(
      "conflict",
      `Space name is ambiguous: ${normalized || "(empty)"}. Use an exact Space id.`,
    );
  }
  throw new WorkFoldCliError("notFound", `Space not found: ${normalized || "(empty)"}.`);
}

function scopedActor(actor: WorkFoldCliActor, spaceId: string): WorkFoldActor {
  return { ...actor, spaceId };
}

function summarizeSpace(space: WorkFoldSpaceSnapshot, active: boolean): WorkFoldCliSpaceSummary {
  return {
    id: space.id,
    name: space.name,
    spaceRoot: space.spaceRoot,
    active,
  };
}

function cliScope(scope: WorkFoldCapabilityScope | "global" | "project" | undefined): string {
  if (scope === "global" || scope === undefined) return "personal";
  if (scope === "project") return "space";
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
