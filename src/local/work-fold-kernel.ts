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
import {
  composeWorkFoldGlance,
  type WorkFoldGlanceSnapshot,
  type WorkFoldGlanceSourceReaders,
  type WorkFoldGlanceTaskRecord,
} from "./glance.js";

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

/**
 * Experimental internal task shape for a consecrated execution: the mutation
 * that runs after a person (or an exercised standing policy) approves a staged
 * act (docs/fold-consecrations.md). Following the `check_run` precedent it is
 * deliberately separate from WorkFoldTaskKind and must not enter the stable
 * space.tasks v1 projection. A Space id is present only when the execution
 * mutates one Space; Personal-scope and machine-scope executions carry none.
 */
export interface WorkFoldExperimentalFoldDecisionTaskInput {
  id?: string;
  spaceId?: string;
  /** The staged act whose approved execution this task tracks. */
  stagedActId: string;
  actor: WorkFoldActor;
}

export interface WorkFoldExperimentalFoldDecisionTask {
  id: string;
  kind: "fold_decision";
  status: "running";
  spaceId: string | null;
  stagedActId: string;
  actor: WorkFoldActor;
  startedAt: string;
}

/**
 * Experimental internal task shape for one routing run (docs/fold-routings.md).
 * Following the `check_run` precedent it is deliberately separate from
 * WorkFoldTaskKind and must not enter the stable space.tasks v1 projection. A
 * routing run is cross-Space glue, so it carries no Space id; the glance
 * renders routing runs from their own receipts source, never from this task.
 */
export interface WorkFoldExperimentalRoutingRunTaskInput {
  id?: string;
  routingId: string;
  runId: string;
  actor: WorkFoldActor;
}

export interface WorkFoldExperimentalRoutingRunTask {
  id: string;
  kind: "routing_run";
  status: "running";
  routingId: string;
  runId: string;
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

/**
 * Injected readers for the whole-Space History-restore fence
 * (docs/fold-act-ledger.md, conflict rule 7). The kernel's own task registry
 * is the record of which routing runs are active; these readers resolve what
 * an active run means for one Space. Both follow the glance-source pattern:
 * the owning application host wires them over its live services.
 */
export interface WorkFoldHistoryRestoreFenceSources {
  /**
   * Space ids the routing's declared files hops copy into (`toSpace`), or
   * null when the routing's declaration cannot be found. Absent reader and
   * null/failed reads fail closed: an active routing run whose hops cannot
   * be verified blocks the restore rather than racing it.
   */
  routingRunFilesHopTargets?(routingId: string): Promise<string[] | null>;
  /**
   * Active (accepted, not yet settled) restricted-app automation runs whose
   * app holds a file grant into the named Space. The owning host wires it
   * over the restricted-app registry's machine-wide accessor
   * (`listActiveAutomationRuns` in
   * `src/local/agent/restricted-app-service.ts`); a run whose grants cannot
   * be resolved is included by that wiring rather than dropped, and a
   * configured reader that fails blocks the restore (fail closed). An absent
   * reader is absence of evidence, unlike an active routing-run task the
   * kernel can already see.
   */
  automationRunsWithFileGrantInto?(spaceId: string): Promise<Array<{
    appId: string;
    automationId: string;
    runId: string;
  }>>;
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
  /**
   * Injected glance source readers, exactly as `listSpaces` and
   * `loadCapabilityCatalog` are today. The kernel always supplies its own task
   * registry as the running-task source; an absent reader renders its glance
   * kinds as absent.
   */
  glanceSources?: WorkFoldGlanceSourceReaders;
  /** Reads the per-surface seen markers. The kernel never writes them. */
  readGlanceSeen?: () => Promise<Record<string, string>>;
  /** Injected History-restore fence readers; see the interface's fail-closed rules. */
  historyRestoreFenceSources?: WorkFoldHistoryRestoreFenceSources;
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
  #glanceSources: WorkFoldGlanceSourceReaders;
  #readGlanceSeen?: () => Promise<Record<string, string>>;
  #historyRestoreFenceSources: WorkFoldHistoryRestoreFenceSources;
  readonly #now: () => Date;
  readonly #createTaskId: () => string;
  readonly #tasks = new Map<
    string,
    | WorkFoldTaskSnapshot
    | WorkFoldExperimentalCheckRunTask
    | WorkFoldExperimentalFoldDecisionTask
    | WorkFoldExperimentalRoutingRunTask
  >();

  constructor(options: WorkFoldKernelOptions = {}) {
    this.#runtimeProvider = options.runtimeProvider;
    this.#listSpaces = options.listSpaces ?? listSpaces;
    this.#getSpace = options.getSpace ?? getSpace;
    this.#loadCapabilityCatalog = options.loadCapabilityCatalog ?? loadAgentSkillCatalog;
    this.#listPackages = options.listPackages ?? listPiPackages;
    this.#isProjectMutationTrusted = options.isProjectMutationTrusted ?? isPiProjectMutationTrusted;
    this.#glanceSources = options.glanceSources ?? {};
    this.#readGlanceSeen = options.readGlanceSeen;
    this.#historyRestoreFenceSources = options.historyRestoreFenceSources ?? {};
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
      // Only the stable kinds enter the space.tasks v1 projection; the
      // experimental check_run and fold_decision lifecycles stay internal.
      .filter((task): task is WorkFoldTaskSnapshot => task.kind === "assistant_turn" || task.kind === "compaction")
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

  /**
   * Composes the experimental glance digest (version 0) over the kernel's own
   * task registry, the registered Spaces, and the injected source readers,
   * with one clock reading. The digest is management-scoped: it never varies
   * by actor, and the actor is normalized only for interface consistency. The
   * experimental snapshot stays out of the stable `work-fold.tasks`/protocol
   * v1 projections, following the `check_run` precedent, and the kernel stays
   * read-only here — it reads seen markers and never writes one.
   */
  async getGlance(actor: WorkFoldActor): Promise<WorkFoldGlanceSnapshot> {
    normalizeActor(actor);
    const spaces = (await this.#listSpaces()).map(toSpaceSnapshot);
    let seen: Record<string, string> = {};
    if (this.#readGlanceSeen) {
      try {
        seen = await this.#readGlanceSeen();
      } catch {
        // A lost seen table only renders more items as new — over-reporting
        // is the safe failure direction for markers.
        seen = {};
      }
    }
    return composeWorkFoldGlance({
      now: this.#now(),
      spaces: spaces.map((space) => ({ id: space.id, name: space.name, spaceRoot: space.spaceRoot })),
      sources: {
        ...this.#glanceSources,
        runningTasks: async () => this.#glanceTaskRecords(),
      },
      seen,
    });
  }

  /**
   * One-shot wiring seam for the owning application host: the local API
   * constructs its live-registry source readers and seen-marker reader only
   * after the kernel exists (the desktop builds the kernel first), so this
   * attaches them post-construction. It rewires reads only — the kernel stays
   * read-only over glance state, and its own task registry still always
   * supplies the running-task source.
   */
  configureGlance(input: {
    sources?: WorkFoldGlanceSourceReaders;
    readSeen?: () => Promise<Record<string, string>>;
  }): void {
    if (input.sources) this.#glanceSources = { ...input.sources };
    if (input.readSeen) this.#readGlanceSeen = input.readSeen;
  }

  /**
   * Post-construction wiring for the History-restore fence readers, exactly
   * like `configureGlance`: the owning host builds its routing executor after
   * the kernel exists, so the readers attach here. Reads only — the kernel
   * never mutates routing or app state through this seam.
   */
  configureHistoryRestoreFence(input: { sources: WorkFoldHistoryRestoreFenceSources }): void {
    this.#historyRestoreFenceSources = { ...input.sources };
  }

  /**
   * The whole-Space History-restore fence (docs/fold-act-ledger.md, conflict
   * rule 7, item 4): person-readable blockers for restoring the named Space
   * right now, judged from the kernel's own task registry plus the injected
   * fence readers. Restore replaces the working set running work may be
   * writing into, so the rule is deliberate strengthening over the desktop's
   * confirm dialog:
   *
   * - An active `routing_run` task whose declaration includes a files hop
   *   into this Space blocks. A run whose hops cannot be verified — no
   *   reader, an unknown routing, a failed read — blocks too (fail closed):
   *   the registry proves work is running, so unverifiable hops must not
   *   race a restore.
   * - An active restricted-app automation run whose app holds a file grant
   *   into this Space blocks, through the injected reader; a configured
   *   reader that fails blocks (fail closed). While no reader is configured
   *   there is no recorded evidence of such runs anywhere in-process, and
   *   this half of the rule stays honestly inactive.
   *
   * The experimental method follows the `check_run` precedent: it is not part
   * of the stable snapshot surface, and Assistant-turn/compaction/Check-run
   * fencing stays with the act facade's own live route state.
   */
  async listExperimentalHistoryRestoreBlockers(spaceId: string): Promise<string[]> {
    const targetSpaceId = spaceId.trim();
    if (!targetSpaceId) throw new Error("Space task Space id is required.");
    const blockers: string[] = [];
    const routingRuns = [...this.#tasks.values()]
      .filter((task): task is WorkFoldExperimentalRoutingRunTask => task.kind === "routing_run");
    const readTargets = this.#historyRestoreFenceSources.routingRunFilesHopTargets;
    for (const run of routingRuns) {
      const label = `routing run ${run.runId} (routing ${run.routingId})`;
      if (!readTargets) {
        blockers.push(`Wait for the running ${label} to finish before restoring: its files-hop targets cannot be verified in this build.`);
        continue;
      }
      let targets: string[] | null;
      try {
        targets = await readTargets(run.routingId);
      } catch {
        targets = null;
      }
      if (targets === null) {
        blockers.push(`Wait for the running ${label} to finish before restoring: its files-hop targets could not be verified.`);
        continue;
      }
      if (targets.includes(targetSpaceId)) {
        blockers.push(`Wait for the running ${label} to finish before restoring: it declares a files hop into this Space.`);
      }
    }
    const readAutomationRuns = this.#historyRestoreFenceSources.automationRunsWithFileGrantInto;
    if (readAutomationRuns) {
      try {
        for (const run of await readAutomationRuns(targetSpaceId)) {
          blockers.push(
            `Wait for the running app automation ${run.automationId} of ${run.appId} (run ${run.runId}) to finish before restoring: the app holds a file grant into this Space.`,
          );
        }
      } catch {
        blockers.push("Wait before restoring: running app automations with file grants into this Space could not be verified.");
      }
    }
    return blockers;
  }

  #glanceTaskRecords(): WorkFoldGlanceTaskRecord[] {
    // The glance's running-task vocabulary is closed (assistant_turn,
    // compaction, check_run). A running fold_decision execution is deliberately
    // not projected: pending cards and settled decisions already reach the
    // glance through its own staged-act readers, and the execution itself is a
    // short internal step between them. A routing_run task is likewise
    // excluded: routing runs reach the glance through their own receipts
    // source, and this internal task carries no Space id to render.
    return [...this.#tasks.values()]
      .filter((task): task is WorkFoldTaskSnapshot | WorkFoldExperimentalCheckRunTask =>
        task.kind === "assistant_turn" || task.kind === "compaction" || task.kind === "check_run")
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        spaceId: task.spaceId,
        ...(task.kind !== "check_run" && task.conversationId ? { conversationId: task.conversationId } : {}),
        startedAt: task.startedAt,
      }));
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

  /**
   * Starts a consecrated execution in the shared internal lifecycle without
   * promoting the experimental kind into the stable space.tasks v1 projection.
   * The decision path (src/local/fold-decisions.ts) starts one task per
   * approved execution and finishes it on every outcome — success, failure,
   * and abort cleanup — so a capability mutation can be fenced against it and
   * no ghost task survives the execution.
   */
  startExperimentalFoldDecisionTask(input: WorkFoldExperimentalFoldDecisionTaskInput): WorkFoldExperimentalFoldDecisionTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (this.#tasks.has(id)) throw new Error(`Space task is already running: ${id}`);
    const stagedActId = input.stagedActId.trim();
    if (!stagedActId) throw new Error("Fold decision task staged-act id is required.");
    const spaceId = input.spaceId?.trim() || null;
    if (input.spaceId !== undefined && !spaceId) throw new Error("Space task Space id is required.");
    const task: WorkFoldExperimentalFoldDecisionTask = {
      id,
      kind: "fold_decision",
      status: "running",
      spaceId,
      stagedActId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalFoldDecisionTask(task);
  }

  /**
   * Starts one routing run in the shared internal lifecycle without promoting
   * the experimental kind into the stable space.tasks v1 projection. The
   * routing executor (src/local/routings/routing-service.ts) starts one task
   * per launched run through its observability port and finishes it on every
   * outcome, so no ghost task survives a settled run.
   */
  startExperimentalRoutingRunTask(input: WorkFoldExperimentalRoutingRunTaskInput): WorkFoldExperimentalRoutingRunTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (this.#tasks.has(id)) throw new Error(`Space task is already running: ${id}`);
    const routingId = input.routingId.trim();
    if (!routingId) throw new Error("Routing run task routing id is required.");
    const runId = input.runId.trim();
    if (!runId) throw new Error("Routing run task run id is required.");
    const task: WorkFoldExperimentalRoutingRunTask = {
      id,
      kind: "routing_run",
      status: "running",
      routingId,
      runId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalRoutingRunTask(task);
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

function copyExperimentalFoldDecisionTask(task: WorkFoldExperimentalFoldDecisionTask): WorkFoldExperimentalFoldDecisionTask {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalRoutingRunTask(task: WorkFoldExperimentalRoutingRunTask): WorkFoldExperimentalRoutingRunTask {
  return { ...task, actor: { ...task.actor } };
}

function pathContains(rootPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
