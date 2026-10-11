import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  loadAgentSkillCatalog,
  type PiCatalogSource,
  type PiResourceCatalog,
} from "./agent/skill-catalog.js";
import { folderParentIds } from "../shared/folder-nesting.js";
import type { PiSurfaceBlock } from "./agent/surface-manifest.js";
import {
  isPiProjectMutationTrusted,
  listPiPackages,
  type PiConfiguredPackage,
  type PiRuntimeProvider,
} from "./agent/pi-runtime-config.js";
import {
  getWorkFolder,
  listWorkFolders,
  type WorkFolderLocation,
  type WorkFolderSummary,
} from "./work-folder.js";
import {
  composeWorkFoldOverview,
  type WorkFoldOverviewSnapshot,
  type WorkFoldOverviewSourceReaders,
  type WorkFoldOverviewTaskRecord,
} from "./overview.js";

export const workFoldKernelSnapshotVersion = 1 as const;

export type WorkFoldActorKind = "human" | "assistant" | "cli" | "renderer" | "extension" | "app" | "system";

export interface WorkFoldActor {
  kind: WorkFoldActorKind;
  cwd?: string;
  workFolderId?: string;
  conversationId?: string;
}

export interface WorkFoldWorkFolderSnapshot {
  id: string;
  name: string;
  workFolderRoot: string;
  location: WorkFolderLocation;
  createdAt: string;
  updatedAt: string;
  /**
   * The nearest registered work-folder whose folder contains this one (2026-10-01).
   * Present only in the work-folders list and only for a nested work-folder; additive to
   * the v1 snapshot, so a top-level work-folder's shape is unchanged.
   */
  parentWorkFolderId?: string;
}

export interface WorkFoldContextSnapshot {
  kind: "work-fold.context";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  resolution: "work-folder_id" | "cwd" | "none";
  workFolder: WorkFoldWorkFolderSnapshot | null;
}

export interface WorkFoldWorkFoldersSnapshot {
  kind: "work-fold.work-folders";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  workFolders: WorkFoldWorkFolderSnapshot[];
}

export type WorkFoldTaskKind = "assistant_turn" | "compaction";

export interface WorkFoldTaskSnapshot {
  id: string;
  kind: WorkFoldTaskKind;
  status: "running";
  workFolderId: string;
  conversationId?: string;
  actor: WorkFoldActor;
  startedAt: string;
}

export interface WorkFoldTaskInput {
  id?: string;
  kind: WorkFoldTaskKind;
  workFolderId: string;
  conversationId?: string;
  actor: WorkFoldActor;
}

/**
 * Experimental internal task shape for Checks dogfooding. It is deliberately
 * separate from WorkFoldTaskKind and must not enter the stable `work-fold.tasks` v1 projection.
 */
export interface WorkFoldExperimentalCheckRunTaskInput {
  id?: string;
  workFolderId: string;
  actor: WorkFoldActor;
}

export interface WorkFoldExperimentalCheckRunTask {
  id: string;
  kind: "check_run";
  status: "running";
  workFolderId: string;
  actor: WorkFoldActor;
  startedAt: string;
}

/**
 * Experimental internal task shape for one prepared-act execution: the
 * mutation a receipted verb that installs code, widens a power, or destroys
 * data performs through the prepared-act path (src/local/prepared-acts.ts,
 * docs/receipts-not-gates.md). Following the `check_run` precedent it is
 * deliberately separate from WorkFoldTaskKind and must not enter the stable
 * `work-fold.tasks` v1 projection. A work-folder id is present only when the
 * execution mutates one work-folder; Everywhere-scope and machine-scope
 * executions carry none.
 */
export interface WorkFoldExperimentalPreparedActTaskInput {
  id?: string;
  workFolderId?: string;
  /** The journaled act request whose execution this task tracks. */
  requestId: string;
  /** The prepared-act kind being performed. */
  kind: string;
  actor: WorkFoldActor;
}

export interface WorkFoldExperimentalPreparedActTask {
  id: string;
  kind: "prepared_act";
  status: "running";
  workFolderId: string | null;
  requestId: string;
  actKind: string;
  actor: WorkFoldActor;
  startedAt: string;
}

/**
 * Experimental internal task shape for one automation run (docs/automations.md).
 * Following the `check_run` precedent it is deliberately separate from
 * WorkFoldTaskKind and must not enter the stable `work-fold.tasks` v1
 * projection. An automation run is cross-work-folder glue, so it carries no
 * work-folder id; the overview
 * renders automation runs from their own receipts source, never from this task.
 */
export interface WorkFoldExperimentalAutomationRunTaskInput {
  id?: string;
  automationId: string;
  runId: string;
  actor: WorkFoldActor;
}

export interface WorkFoldExperimentalAutomationRunTask {
  id: string;
  kind: "automation_run";
  status: "running";
  automationId: string;
  runId: string;
  actor: WorkFoldActor;
  startedAt: string;
}

export interface WorkFoldTasksSnapshot {
  kind: "work-fold.tasks";
  version: typeof workFoldKernelSnapshotVersion;
  actor: WorkFoldActor;
  workFolderId: string | null;
  tasks: WorkFoldTaskSnapshot[];
}

/**
 * Injected readers for the whole-work-folder History-restore fence
 * (docs/act-ledger.md, conflict rule 7). The kernel's own task registry
 * is the record of which automation runs are active; these readers resolve what
 * an active run means for one work-folder. Both follow the overview-source pattern:
 * the owning application host wires them over its live services.
 */
export interface WorkFoldHistoryRestoreFenceSources {
  /**
   * work-folder ids the automation's declared files hops copy into (`toWorkFolder`), or
   * null when the automation's declaration cannot be found. Absent reader and
   * null/failed reads fail closed: an active automation run whose hops cannot
   * be verified blocks the restore rather than racing it.
   */
  automationRunFilesHopTargets?(automationId: string): Promise<string[] | null>;
  /**
   * Active (accepted, not yet settled) restricted-app automation runs whose
   * app holds a file grant into the named work-folder. The owning host wires it
   * over the restricted-app registry's machine-wide accessor
   * (`listActiveAutomationRuns` in
   * `src/local/agent/restricted-app-service.ts`); a run whose grants cannot
   * be resolved is included by that wiring rather than dropped, and a
   * configured reader that fails blocks the restore (fail closed). An absent
   * reader is absence of evidence, unlike an active automation-run task the
   * kernel can already see.
   */
  appAutomationRunsWithFileGrantInto?(workFolderId: string): Promise<Array<{
    appId: string;
    appAutomationId: string;
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
  resources?: PiResourceCatalog["resources"];
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
  workFolder: WorkFoldWorkFolderSnapshot;
  catalog: WorkFoldCapabilityCatalogSnapshot;
}

export interface WorkFoldKernelOptions {
  runtimeProvider?: PiRuntimeProvider;
  listWorkFolders?: () => Promise<WorkFolderSummary[]>;
  getWorkFolder?: (workFolderId: string) => Promise<WorkFolderSummary>;
  loadCapabilityCatalog?: (workFolderRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiResourceCatalog>;
  listPackages?: (workFolderRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiConfiguredPackage[]>;
  isProjectMutationTrusted?: (workFolderRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<boolean>;
  /**
   * Injected overview source readers, exactly as `listWorkFolders` and
   * `loadCapabilityCatalog` are today. The kernel always supplies its own task
   * registry as the running-task source; an absent reader renders its overview
   * kinds as absent.
   */
  overviewSources?: WorkFoldOverviewSourceReaders;
  /** Reads the per-surface seen markers. The kernel never writes them. */
  readOverviewSeen?: () => Promise<Record<string, string>>;
  /** Injected History-restore fence readers; see the interface's fail-closed rules. */
  historyRestoreFenceSources?: WorkFoldHistoryRestoreFenceSources;
  now?: () => Date;
  createTaskId?: () => string;
}

export class WorkFoldContextRequiredError extends Error {
  readonly code = "WORKFOLD_CONTEXT_REQUIRED";

  constructor() {
    super("A work-folder must be selected explicitly or resolved from the actor's current directory.");
    this.name = "WorkFoldContextRequiredError";
  }
}

/**
 * Reusable in-process authority for the read-only work-folder control plane.
 * HTTP, CLI, and agent adapters consume the same typed snapshots while
 * mutation policy remains in the owning domain services.
 */
export class WorkFoldKernel {
  readonly #runtimeProvider?: PiRuntimeProvider;
  readonly #listWorkFolders: () => Promise<WorkFolderSummary[]>;
  readonly #getWorkFolder: (workFolderId: string) => Promise<WorkFolderSummary>;
  readonly #loadCapabilityCatalog: WorkFoldKernelOptions["loadCapabilityCatalog"] & {};
  readonly #listPackages: WorkFoldKernelOptions["listPackages"] & {};
  readonly #isProjectMutationTrusted: WorkFoldKernelOptions["isProjectMutationTrusted"] & {};
  #overviewSources: WorkFoldOverviewSourceReaders;
  #readOverviewSeen?: () => Promise<Record<string, string>>;
  #historyRestoreFenceSources: WorkFoldHistoryRestoreFenceSources;
  readonly #now: () => Date;
  readonly #createTaskId: () => string;
  readonly #tasks = new Map<
    string,
    | WorkFoldTaskSnapshot
    | WorkFoldExperimentalCheckRunTask
    | WorkFoldExperimentalPreparedActTask
    | WorkFoldExperimentalAutomationRunTask
  >();

  constructor(options: WorkFoldKernelOptions = {}) {
    this.#runtimeProvider = options.runtimeProvider;
    this.#listWorkFolders = options.listWorkFolders ?? listWorkFolders;
    this.#getWorkFolder = options.getWorkFolder ?? getWorkFolder;
    this.#loadCapabilityCatalog = options.loadCapabilityCatalog ?? loadAgentSkillCatalog;
    this.#listPackages = options.listPackages ?? listPiPackages;
    this.#isProjectMutationTrusted = options.isProjectMutationTrusted ?? isPiProjectMutationTrusted;
    this.#overviewSources = options.overviewSources ?? {};
    this.#readOverviewSeen = options.readOverviewSeen;
    this.#historyRestoreFenceSources = options.historyRestoreFenceSources ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#createTaskId = options.createTaskId ?? (() => `task-${randomUUID()}`);
  }

  async getContext(actor: WorkFoldActor): Promise<WorkFoldContextSnapshot> {
    const normalizedActor = normalizeActor(actor);
    if (normalizedActor.workFolderId) {
      return {
        kind: "work-fold.context",
        version: workFoldKernelSnapshotVersion,
        actor: normalizedActor,
        resolution: "work-folder_id",
        workFolder: toWorkFolderSnapshot(await this.#getWorkFolder(normalizedActor.workFolderId)),
      };
    }

    if (normalizedActor.cwd) {
      const cwd = resolve(normalizedActor.cwd);
      const candidates = (await this.#listWorkFolders())
        .filter((workFolder) => pathContains(workFolder.workFolderRoot, cwd))
        .sort((left, right) => resolve(right.workFolderRoot).length - resolve(left.workFolderRoot).length);
      if (candidates[0]) {
        return {
          kind: "work-fold.context",
          version: workFoldKernelSnapshotVersion,
          actor: normalizedActor,
          resolution: "cwd",
          workFolder: toWorkFolderSnapshot(candidates[0]),
        };
      }
    }

    return {
      kind: "work-fold.context",
      version: workFoldKernelSnapshotVersion,
      actor: normalizedActor,
      resolution: "none",
      workFolder: null,
    };
  }

  async getWorkFolders(actor: WorkFoldActor): Promise<WorkFoldWorkFoldersSnapshot> {
    return {
      kind: "work-fold.work-folders",
      version: workFoldKernelSnapshotVersion,
      actor: normalizeActor(actor),
      workFolders: withParentWorkFolderIds((await this.#listWorkFolders()).map(toWorkFolderSnapshot)),
    };
  }

  async getTasks(actor: WorkFoldActor): Promise<WorkFoldTasksSnapshot> {
    const normalizedActor = normalizeActor(actor);
    const scoped = Boolean(normalizedActor.workFolderId || normalizedActor.cwd);
    const context = scoped ? await this.getContext(normalizedActor) : null;
    const workFolderId = context?.workFolder?.id ?? null;
    const tasks = [...this.#tasks.values()]
      // Only the stable kinds enter the `work-fold.tasks` v1 projection; the
      // experimental check_run and fold_act lifecycles stay internal.
      .filter((task): task is WorkFoldTaskSnapshot => task.kind === "assistant_turn" || task.kind === "compaction")
      .filter((task) => !scoped || task.workFolderId === workFolderId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map(copyTask);
    return {
      kind: "work-fold.tasks",
      version: workFoldKernelSnapshotVersion,
      actor: normalizedActor,
      workFolderId,
      tasks,
    };
  }

  async getCapabilities(actor: WorkFoldActor): Promise<WorkFoldCapabilitiesSnapshot> {
    const context = await this.getContext(actor);
    if (!context.workFolder) throw new WorkFoldContextRequiredError();
    const [catalog, packages, mutationTrusted] = await Promise.all([
      this.#loadCapabilityCatalog(context.workFolder.workFolderRoot, this.#runtimeProvider),
      this.#listPackages(context.workFolder.workFolderRoot, this.#runtimeProvider),
      this.#isProjectMutationTrusted(context.workFolder.workFolderRoot, this.#runtimeProvider),
    ]);
    return {
      kind: "work-fold.capabilities",
      version: workFoldKernelSnapshotVersion,
      actor: context.actor,
      workFolder: context.workFolder,
      catalog: buildWorkFoldCapabilityCatalog(catalog, packages, mutationTrusted),
    };
  }

  /**
   * Composes the experimental overview digest (version 0) over the kernel's own
   * task registry, the registered work-folders, and the injected source readers,
   * with one clock reading. The digest sits above all work-folders: it never varies
   * by actor, and the actor is normalized only for interface consistency. The
   * experimental snapshot stays out of the stable `work-fold.tasks`/protocol
   * v1 projections, following the `check_run` precedent, and the kernel stays
   * read-only here — it reads seen markers and never writes one.
   */
  async getOverview(actor: WorkFoldActor): Promise<WorkFoldOverviewSnapshot> {
    normalizeActor(actor);
    const workFolders = (await this.#listWorkFolders()).map(toWorkFolderSnapshot);
    let seen: Record<string, string> = {};
    if (this.#readOverviewSeen) {
      try {
        seen = await this.#readOverviewSeen();
      } catch {
        // A lost seen table only renders more items as new — over-reporting
        // is the safe failure direction for markers.
        seen = {};
      }
    }
    return composeWorkFoldOverview({
      now: this.#now(),
      workFolders: workFolders.map((workFolder) => ({ id: workFolder.id, name: workFolder.name, workFolderRoot: workFolder.workFolderRoot })),
      sources: {
        ...this.#overviewSources,
        runningTasks: async () => this.#overviewTaskRecords(),
      },
      seen,
    });
  }

  /**
   * One-shot wiring seam for the owning application host: the local API
   * constructs its live-registry source readers and seen-marker reader only
   * after the kernel exists (the desktop builds the kernel first), so this
   * attaches them post-construction. It rewires reads only — the kernel stays
   * read-only over overview state, and its own task registry still always
   * supplies the running-task source.
   */
  configureOverview(input: {
    sources?: WorkFoldOverviewSourceReaders;
    readSeen?: () => Promise<Record<string, string>>;
  }): void {
    if (input.sources) this.#overviewSources = { ...input.sources };
    if (input.readSeen) this.#readOverviewSeen = input.readSeen;
  }

  /**
   * Post-construction wiring for the History-restore fence readers, exactly
   * like `configureOverview`: the owning host builds its automation executor after
   * the kernel exists, so the readers attach here. Reads only — the kernel
   * never mutates automation or app state through this seam.
   */
  configureHistoryRestoreFence(input: { sources: WorkFoldHistoryRestoreFenceSources }): void {
    this.#historyRestoreFenceSources = { ...input.sources };
  }

  /**
   * The whole-work-folder History-restore fence (docs/act-ledger.md, conflict
   * rule 7, item 4): person-readable blockers for restoring the named work-folder
   * right now, judged from the kernel's own task registry plus the injected
   * fence readers. Restore replaces the working set running work may be
   * writing into, so the rule is deliberate strengthening over the desktop's
   * confirm dialog:
   *
   * - An active `automation_run` task whose declaration includes a files hop
   *   into this work-folder blocks. A run whose hops cannot be verified — no
   *   reader, an unknown automation, a failed read — blocks too (fail closed):
   *   the registry proves work is running, so unverifiable hops must not
   *   race a restore.
   * - An active restricted-app automation run whose app holds a file grant
   *   into this work-folder blocks, through the injected reader; a configured
   *   reader that fails blocks (fail closed). While no reader is configured
   *   there is no recorded evidence of such runs anywhere in-process, and
   *   this half of the rule stays honestly inactive.
   *
   * The experimental method follows the `check_run` precedent: it is not part
   * of the stable snapshot surface, and turn/compaction/Check-run
   * fencing stays with the act facade's own live route state.
   */
  async listExperimentalHistoryRestoreBlockers(workFolderId: string): Promise<string[]> {
    const targetWorkFolderId = workFolderId.trim();
    if (!targetWorkFolderId) throw new Error("A work-folder id is required.");
    const blockers: string[] = [];
    const automationRuns = [...this.#tasks.values()]
      .filter((task): task is WorkFoldExperimentalAutomationRunTask => task.kind === "automation_run");
    const readTargets = this.#historyRestoreFenceSources.automationRunFilesHopTargets;
    for (const run of automationRuns) {
      const label = `automation run ${run.runId} (automation ${run.automationId})`;
      if (!readTargets) {
        blockers.push(`Wait for the running ${label} to finish before restoring: its files-hop targets cannot be verified in this build.`);
        continue;
      }
      let targets: string[] | null;
      try {
        targets = await readTargets(run.automationId);
      } catch {
        targets = null;
      }
      if (targets === null) {
        blockers.push(`Wait for the running ${label} to finish before restoring: its files-hop targets could not be verified.`);
        continue;
      }
      if (targets.includes(targetWorkFolderId)) {
        blockers.push(`Wait for the running ${label} to finish before restoring: it declares a files hop into this work-folder.`);
      }
    }
    const readAppAutomationRuns = this.#historyRestoreFenceSources.appAutomationRunsWithFileGrantInto;
    if (readAppAutomationRuns) {
      try {
        for (const run of await readAppAutomationRuns(targetWorkFolderId)) {
          blockers.push(
            `Wait for the running app automation ${run.appAutomationId} of ${run.appId} (run ${run.runId}) to finish before restoring: the app holds a file grant into this work-folder.`,
          );
        }
      } catch {
        blockers.push("Wait before restoring: running app automations with file grants into this work-folder could not be verified.");
      }
    }
    return blockers;
  }

  #overviewTaskRecords(): WorkFoldOverviewTaskRecord[] {
    // The overview's running-task vocabulary is closed (assistant_turn,
    // compaction, check_run). A running fold_act execution is deliberately
    // not projected: the act's receipt reaches the overview through the
    // act-receipts source, and the execution itself is a short internal step
    // between the accepted and terminal lines. A routing_run task is likewise
    // excluded: automation runs reach the overview through their own receipts
    // source, and this internal task carries no work-folder id to render.
    return [...this.#tasks.values()]
      .filter((task): task is WorkFoldTaskSnapshot | WorkFoldExperimentalCheckRunTask =>
        task.kind === "assistant_turn" || task.kind === "compaction" || task.kind === "check_run")
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        workFolderId: task.workFolderId,
        ...(task.kind !== "check_run" && task.conversationId ? { conversationId: task.conversationId } : {}),
        startedAt: task.startedAt,
      }));
  }

  startTask(input: WorkFoldTaskInput): WorkFoldTaskSnapshot {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("A task id is required.");
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const workFolderId = input.workFolderId.trim();
    if (!workFolderId) throw new Error("A task needs a work-folder id.");
    const task: WorkFoldTaskSnapshot = {
      id,
      kind: input.kind,
      status: "running",
      workFolderId,
      ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyTask(task);
  }

  /**
   * Starts a Check run in the shared internal lifecycle without promoting the
   * experimental kind into the stable `work-fold.tasks` v1 projection.
   */
  startExperimentalCheckRunTask(input: WorkFoldExperimentalCheckRunTaskInput): WorkFoldExperimentalCheckRunTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("A task id is required.");
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const workFolderId = input.workFolderId.trim();
    if (!workFolderId) throw new Error("A task needs a work-folder id.");
    const task: WorkFoldExperimentalCheckRunTask = {
      id,
      kind: "check_run",
      status: "running",
      workFolderId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalCheckRunTask(task);
  }

  /**
   * Starts one prepared-act execution in the shared internal lifecycle
   * without promoting the experimental kind into the stable `work-fold.tasks` v1
   * projection. The prepared-act executor (src/local/prepared-acts.ts)
   * starts one task per execution and finishes it on every outcome —
   * success, failure, and abort cleanup — so a capability mutation can be
   * fenced against it and no ghost task survives the execution.
   */
  startExperimentalPreparedActTask(input: WorkFoldExperimentalPreparedActTaskInput): WorkFoldExperimentalPreparedActTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const requestId = input.requestId.trim();
    if (!requestId) throw new Error("Fold act task request id is required.");
    const actKind = input.kind.trim();
    if (!actKind) throw new Error("Fold act task kind is required.");
    const workFolderId = input.workFolderId?.trim() || null;
    if (input.workFolderId !== undefined && !workFolderId) throw new Error("A task needs a work-folder id.");
    const task: WorkFoldExperimentalPreparedActTask = {
      id,
      kind: "prepared_act",
      status: "running",
      workFolderId,
      requestId,
      actKind,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalPreparedActTask(task);
  }

  /**
   * Starts one automation run in the shared internal lifecycle without promoting
   * the experimental kind into the stable `work-fold.tasks` v1 projection. The
   * automation executor (src/local/automations/automation-service.ts) starts one task
   * per launched run through its observability port and finishes it on every
   * outcome, so no ghost task survives a settled run.
   */
  startExperimentalAutomationRunTask(input: WorkFoldExperimentalAutomationRunTaskInput): WorkFoldExperimentalAutomationRunTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const automationId = input.automationId.trim();
    if (!automationId) throw new Error("Automation run task automation id is required.");
    const runId = input.runId.trim();
    if (!runId) throw new Error("Automation run task run id is required.");
    const task: WorkFoldExperimentalAutomationRunTask = {
      id,
      kind: "automation_run",
      status: "running",
      automationId,
      runId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalAutomationRunTask(task);
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
    ...(catalog.resources ? { resources: catalog.resources } : {}),
    projectTrust: { ...projectTrust },
    trust: { ...projectTrust },
    // Compatibility for older renderers. A work-folder with no gated resources is
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
      name: extension.name ?? basename(extension.resolvedPath).replace(/\.[^.]+$/, ""),
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
  const scope = source.scope === "user" ? "Everywhere" : source.scope === "project" ? "This work-folder only" : "Temporary";
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
    ...(actor.workFolderId?.trim() ? { workFolderId: actor.workFolderId.trim() } : {}),
    ...(actor.conversationId?.trim() ? { conversationId: actor.conversationId.trim() } : {}),
  };
}

function toWorkFolderSnapshot(workFolder: WorkFolderSummary): WorkFoldWorkFolderSnapshot {
  return {
    id: workFolder.id,
    name: workFolder.name,
    workFolderRoot: resolve(workFolder.workFolderRoot),
    location: { ...workFolder.location },
    createdAt: workFolder.createdAt,
    updatedAt: workFolder.updatedAt,
  };
}

function withParentWorkFolderIds(workFolders: WorkFoldWorkFolderSnapshot[]): WorkFoldWorkFolderSnapshot[] {
  const parents = folderParentIds(workFolders);
  return workFolders.map((workFolder) => {
    const parentWorkFolderId = parents.get(workFolder.id);
    return parentWorkFolderId ? { ...workFolder, parentWorkFolderId } : workFolder;
  });
}

function copyTask(task: WorkFoldTaskSnapshot): WorkFoldTaskSnapshot {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalCheckRunTask(task: WorkFoldExperimentalCheckRunTask): WorkFoldExperimentalCheckRunTask {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalPreparedActTask(task: WorkFoldExperimentalPreparedActTask): WorkFoldExperimentalPreparedActTask {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalAutomationRunTask(task: WorkFoldExperimentalAutomationRunTask): WorkFoldExperimentalAutomationRunTask {
  return { ...task, actor: { ...task.actor } };
}

function pathContains(rootPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
