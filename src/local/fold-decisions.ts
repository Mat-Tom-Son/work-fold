import {
  restrictedAppAutomationScheduleSummary,
  type RestrictedAppInstalled,
  type RestrictedAppService,
} from "./agent/restricted-app-service.js";
import type { RestrictedAppProposalReceipt } from "./agent/restricted-app-proposals.js";
import type { PiRuntimeProvider } from "./agent/pi-runtime-config.js";
import { importPiSkillBundleVerified, piSkillBundleContentDigest } from "./agent/skill-import.js";
import type { WorkFoldCliActReceiptV2, WorkFoldCliActUndoRef } from "./cli/act-receipts.js";
import {
  FOLD_DECISION_SURFACES,
  FoldStagedActError,
  type FoldDecisionRecord,
  type FoldStagedAct,
  type FoldStagedActDecisionInput,
  type FoldStagedActKind,
  type FoldStagedActState,
  type FoldStagedActStore,
} from "./fold-staged-acts.js";
import { managedSpaceDeletionPinIssue } from "./space.js";
import type {
  WorkFoldExperimentalFoldDecisionTask,
  WorkFoldExperimentalFoldDecisionTaskInput,
} from "./work-fold-kernel.js";

/**
 * The consecration decision path (docs/fold-consecrations.md): the one host
 * routine behind every needs-you click and every exercised standing policy.
 * Deciding is deliberately NOT an act-lane verb — the act facade must never
 * expose these internals — so this service is constructed only by the desktop
 * wiring and reached only through the renderer/popover session routes and the
 * approved remote browser's signed envelope.
 *
 * The path runs, in order: eligibility precheck (refuses without consuming),
 * pin recheck against live state (a mismatch invalidates, nothing executes),
 * atomic journal-first consumption inside the staged-act store's serialized
 * critical section (the primary at-most-once gate), then execution through
 * the same domain service as the equivalent desktop action, as an internal
 * kernel task participating in capability-mutation fencing.
 */

/**
 * Deterministic decision request id derived from the staged-act id. It is the
 * durable journal backstop after store cleanup, not an independent gate: the
 * store's atomic staged→approved check-and-set is the primary at-most-once
 * gate, and this id keeps a crash between the journal append and the store
 * commit from ever executing a second time under the same identity.
 */
export function foldDecisionRequestId(stagedActId: string): string {
  return `fold-decision:${stagedActId}`;
}

export type FoldDecisionErrorCode =
  /** The equivalent desktop button would refuse too; the card says what it is waiting for. */
  | "NOT_ELIGIBLE"
  /** A surface rule refused: no self-approval, or Personal-scope make-runnable off the desktop. */
  | "SURFACE_FORBIDDEN"
  /** No execution adapter is bound for this kind in this build; approval is refused before anything is consumed. */
  | "EXECUTION_UNAVAILABLE"
  /** A pinned identity no longer matches live state; the act transitioned to `invalidated`. */
  | "PIN_MISMATCH"
  /** The journal backstop found an accepted decision that never committed; the act is void. */
  | "DECISION_INTERRUPTED";

export class FoldDecisionError extends Error {
  readonly code: FoldDecisionErrorCode;
  /** The staged act's resulting state, when the refusal settled the record. */
  readonly state?: FoldStagedActState;

  constructor(code: FoldDecisionErrorCode, message: string, options: { state?: FoldStagedActState; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FoldDecisionError";
    this.code = code;
    if (options.state !== undefined) this.state = options.state;
  }
}

/**
 * Typed identifiers an execution hands back for the terminal receipt.
 * Identifiers and short host-composed lines only — receipts never grow file
 * contents, credentials, or model prose.
 */
export interface FoldDecisionExecutionEffect {
  detail?: string;
  checkpointId?: string;
  taskId?: string;
  undoRef?: WorkFoldCliActUndoRef;
}

/** The capability-mutation scope a consecrated execution reserves. */
export type FoldDecisionFenceScope =
  | { scope: "global" }
  | { scope: "space"; spaceId: string };

/**
 * Injectable seam over the local API's capability-mutation reservation state
 * (`runCapabilityMutation` / `runRestrictedAppMutation` in
 * src/local/server.ts). `probe` answers, without reserving, whether the scope
 * could be reserved right now — the eligibility precheck refuses on a busy
 * probe so an ineligible click consumes nothing. `run` reserves the scope for
 * the execution and releases it on every outcome, exactly as the equivalent
 * desktop route would.
 */
export interface FoldDecisionMutationFence {
  probe(scope: FoldDecisionFenceScope): Promise<string | null> | string | null;
  run<T>(scope: FoldDecisionFenceScope, operation: () => Promise<T>): Promise<T>;
}

/** The kernel surface the decision path needs: one internal task per execution. */
export interface FoldDecisionKernelSeam {
  startExperimentalFoldDecisionTask(input: WorkFoldExperimentalFoldDecisionTaskInput): WorkFoldExperimentalFoldDecisionTask;
  finishTask(taskId: string): boolean;
}

/**
 * The durable receipts journal the act lane already appends
 * (src/local/cli/act-receipts.ts). `append` is best-effort by contract; the
 * decision path treats a failed `accepted` append as journal-unavailable and
 * refuses without consuming, while terminal appends surface a warning only.
 */
export interface FoldDecisionReceiptsWriter {
  append(entry: Omit<WorkFoldCliActReceiptV2, "v" | "at">): Promise<boolean>;
  hasAccepted(requestId: string): Promise<boolean>;
}

/**
 * One per-kind execution adapter: the bridge from a staged act's typed pins to
 * the same domain service the equivalent desktop action uses. Adapters never
 * decide — they re-verify and execute after the decision path has consumed
 * approval.
 */
export interface FoldStagedActKindAdapter {
  /**
   * A waiting-for reason when the equivalent desktop control would refuse
   * right now (lifecycle state, runtime availability). Refusing here consumes
   * nothing; the card stays pending.
   */
  eligibilityIssue?(act: FoldStagedAct): Promise<string | null> | string | null;
  /**
   * Re-verifies every pinned identity against current state immediately
   * before consumption. A returned reason transitions the act to
   * `invalidated`; nothing executes.
   */
  recheckPins(act: FoldStagedAct): Promise<string | null> | string | null;
  /** Runs the same mutation the equivalent desktop action runs. */
  execute(act: FoldStagedAct): Promise<FoldDecisionExecutionEffect | void>;
  /**
   * The capability-fence scope the execution reserves. Omit for the default
   * (the act's Space, or global when the act names none). Return null when
   * the bound execution path performs its own reservation — reserving twice
   * for the same Space would deadlock against the server's mutation state.
   */
  fenceScope?(act: FoldStagedAct): FoldDecisionFenceScope | null;
}

/**
 * Per-kind bindings. An unbound kind can still be staged, listed, denied,
 * canceled, and expired — but approving it is refused honestly before
 * anything is consumed, following the act lane's journal-first
 * honest-unavailable discipline.
 */
export type FoldDecisionAdapters = Partial<Record<FoldStagedActKind, FoldStagedActKindAdapter>>;

/** Default fence scope: the act's Space when it names one, otherwise global. */
export function foldDecisionFenceScope(act: FoldStagedAct): FoldDecisionFenceScope {
  const spaceId = foldStagedActSpaceId(act);
  return spaceId ? { scope: "space", spaceId } : { scope: "global" };
}

export interface FoldDecisionSurfaceRestrictions {
  /**
   * Personal-scope make-runnable acts load into the fold's own runtime on
   * next start, so their decision belongs to a desktop surface; the remote
   * client renders these cards read-only.
   */
  desktopOnly: boolean;
  /**
   * The remote grant whose request staged this act. That grant can never
   * decide it — one compromised browser must not both cause a staging and
   * click it through.
   */
  stagedByGrantId?: string;
}

/**
 * The two surface rules, computed from the record so every surface can state
 * them on the card instead of discovering them at refusal time.
 */
export function foldDecisionSurfaceRestrictions(act: FoldStagedAct): FoldDecisionSurfaceRestrictions {
  const personalScope = act.parameters.scope === "personal" || act.pins.scope === "personal";
  return {
    desktopOnly: act.category === "make-runnable" && personalScope,
    ...(act.provenance.grantId !== undefined ? { stagedByGrantId: act.provenance.grantId } : {}),
  };
}

export interface FoldDecisionResult {
  /** The settled record: denied, or approved with its execution outcome. */
  act: FoldStagedAct;
  /**
   * False when the terminal receipt could not be appended. The applied
   * outcome stands — an applied mutation is never failed retroactively — and
   * the caller surfaces the warning, as the act executor does.
   */
  receipted: boolean;
}

export interface FoldDecisionServiceOptions {
  store: FoldStagedActStore;
  receipts: FoldDecisionReceiptsWriter;
  kernel: FoldDecisionKernelSeam;
  fence: FoldDecisionMutationFence;
  adapters: FoldDecisionAdapters;
}

export class FoldDecisionService {
  readonly #store: FoldStagedActStore;
  readonly #receipts: FoldDecisionReceiptsWriter;
  readonly #kernel: FoldDecisionKernelSeam;
  readonly #fence: FoldDecisionMutationFence;
  readonly #adapters: FoldDecisionAdapters;

  constructor(options: FoldDecisionServiceOptions) {
    this.#store = options.store;
    this.#receipts = options.receipts;
    this.#kernel = options.kernel;
    this.#fence = options.fence;
    this.#adapters = options.adapters;
  }

  /**
   * Approved acts whose execution was interrupted by a crash (marked by the
   * store at open). Recovery reports them — the missing terminal receipt line
   * is the honest interrupted signal — and never replays the mutation;
   * another attempt means restaging, a fresh card, and a fresh click.
   */
  async listInterrupted(): Promise<FoldStagedAct[]> {
    return (await this.#store.list({ state: "approved" }))
      .filter((act) => act.execution?.outcome === "interrupted");
  }

  /**
   * Decides one staged act. This is the only transition out of `staged` a
   * surface can request; it is reached from the desktop renderer surfaces,
   * the approved remote browser, and host-side policy evaluation — never
   * from the act lane.
   */
  async decide(id: string, input: FoldStagedActDecisionInput): Promise<FoldDecisionResult> {
    const inputIssue = decisionShapeIssue(input);
    if (inputIssue) {
      throw new FoldStagedActError("INPUT_INVALID", `work-fold refused this decision: ${inputIssue}`);
    }

    const act = await this.#store.get(id);
    assertStagedForDecision(act);

    this.#assertSurfaceAllowed(act, input);

    const requestId = foldDecisionRequestId(act.id);
    // Journal backstop: an accepted decision line for an act that is still
    // `staged` means a prior decision was interrupted between the journal
    // append and the store commit. That identity is spent — void the card
    // rather than execute anything under a request id the ledger already
    // accepted. An accepted line for a settled act is not the backstop case:
    // it belongs to the decision that completed, so the refusal mirrors the
    // settled outcome, exactly as a concurrent decide's loser is refused.
    if (await this.#receipts.hasAccepted(requestId)) {
      assertStagedForDecision(await this.#store.get(id));
      await this.#store.invalidate(
        act.id,
        "A prior decision for this card was accepted but interrupted before it committed. The card is void; restage to issue a fresh card.",
      );
      throw new FoldDecisionError(
        "DECISION_INTERRUPTED",
        "A prior decision for this staged act was accepted but never committed, so this card is void. Restage to issue a fresh card.",
        { state: "invalidated" },
      );
    }

    if (input.decision === "denied") {
      const denied = await this.#store.decide(act.id, input, { journal: this.#acceptedJournal(requestId) });
      const receipted = await this.#appendTerminal(denied, requestId, {
        outcome: "ok",
        detail: "Denial recorded. work-fold never retries a denied act.",
      });
      return { act: denied, receipted };
    }

    const adapter = this.#adapters[act.kind];
    if (!adapter) {
      throw new FoldDecisionError(
        "EXECUTION_UNAVAILABLE",
        `work-fold cannot execute "${act.kind}" acts in this build yet, so approval is refused before anything is consumed. `
          + "The card stays pending; denying or canceling it remains available.",
      );
    }

    const scope = adapter.fenceScope ? adapter.fenceScope(act) : foldDecisionFenceScope(act);
    if (scope) {
      const busy = await this.#fence.probe(scope);
      if (busy) throw new FoldDecisionError("NOT_ELIGIBLE", busy);
    }
    const eligibility = adapter.eligibilityIssue ? await adapter.eligibilityIssue(act) : null;
    if (eligibility) throw new FoldDecisionError("NOT_ELIGIBLE", eligibility);

    const pinIssue = await adapter.recheckPins(act);
    if (pinIssue) {
      // Invalidation may race a concurrent decide; the store's serialized
      // section settles the record exactly once either way.
      const invalidated = await this.#store.invalidate(act.id, pinIssue);
      throw new FoldDecisionError(
        "PIN_MISMATCH",
        `This card no longer matches live state and was invalidated: ${pinIssue}`,
        { state: invalidated.state },
      );
    }

    // The moment approval is consumed: journal-first, atomic, at most once.
    const approved = await this.#store.decide(act.id, input, { journal: this.#acceptedJournal(requestId) });

    const spaceId = foldStagedActSpaceId(approved);
    const task = this.#kernel.startExperimentalFoldDecisionTask({
      ...(spaceId ? { spaceId } : {}),
      stagedActId: approved.id,
      actor: { kind: "system" },
    });
    let effect: FoldDecisionExecutionEffect | undefined;
    let failure: string | undefined;
    try {
      const outcome = scope
        ? await this.#fence.run(scope, async () => await adapter.execute(approved))
        : await adapter.execute(approved);
      effect = outcome ?? undefined;
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.#kernel.finishTask(task.id);
    }

    if (failure !== undefined) {
      // Approval was consumed at journal time; a failed execution stays
      // `approved` with outcome `failed` and is never auto-retried.
      const failed = await this.#store.recordExecution(approved.id, "failed", failure);
      const receipted = await this.#appendTerminal(failed, requestId, {
        outcome: "error",
        errorCode: "failure",
        detail: failure,
        taskId: task.id,
      });
      return { act: failed, receipted };
    }

    let executed: FoldStagedAct;
    try {
      executed = await this.#store.recordExecution(approved.id, "executed");
    } catch (caught) {
      // The mutation applied; the terminal receipt must say so even when the
      // store could not persist the outcome (the next open marks it
      // interrupted — over-reporting interruption, never replaying).
      await this.#appendTerminal(approved, requestId, {
        outcome: "ok",
        detail: effect?.detail ?? "Executed.",
        taskId: task.id,
        ...(effect?.checkpointId !== undefined ? { checkpointId: effect.checkpointId } : {}),
        ...(effect?.undoRef !== undefined ? { undoRef: effect.undoRef } : {}),
      });
      throw caught;
    }
    const receipted = await this.#appendTerminal(executed, requestId, {
      outcome: "ok",
      detail: effect?.detail ?? "Executed.",
      taskId: effect?.taskId ?? task.id,
      ...(effect?.checkpointId !== undefined ? { checkpointId: effect.checkpointId } : {}),
      ...(effect?.undoRef !== undefined ? { undoRef: effect.undoRef } : {}),
    });
    return { act: executed, receipted };
  }

  #assertSurfaceAllowed(act: FoldStagedAct, input: FoldStagedActDecisionInput): void {
    if (input.surface !== "remote_web") return;
    const restrictions = foldDecisionSurfaceRestrictions(act);
    if (restrictions.stagedByGrantId !== undefined && input.grantId === restrictions.stagedByGrantId) {
      throw new FoldDecisionError(
        "SURFACE_FORBIDDEN",
        "This card was staged at this browser's request, so this browser cannot decide it. "
          + "Decide it on the desktop or from a different approved browser.",
      );
    }
    if (restrictions.desktopOnly) {
      throw new FoldDecisionError(
        "SURFACE_FORBIDDEN",
        "This act loads code into the fold's own runtime (Personal scope), so its decision belongs to a desktop surface.",
      );
    }
  }

  #acceptedJournal(requestId: string): (act: FoldStagedAct, decision: FoldDecisionRecord) => Promise<void> {
    return async (act, decision) => {
      const appended = await this.#receipts.append({
        requestId,
        command: decision.decision === "approved" ? "decision.approve" : "decision.deny",
        outcome: "accepted",
        detail: `${act.kind} (${act.category})`,
        ...decisionIdentityFields(act, decision),
      });
      if (!appended) throw new Error("the decision receipt journal is unavailable");
    };
  }

  async #appendTerminal(
    act: FoldStagedAct,
    requestId: string,
    terminal: Pick<WorkFoldCliActReceiptV2, "outcome" | "errorCode" | "detail" | "checkpointId" | "taskId" | "undoRef">,
  ): Promise<boolean> {
    const decision = act.decision;
    if (!decision) return false;
    return await this.#receipts.append({
      requestId,
      command: decision.decision === "approved" ? "decision.approve" : "decision.deny",
      ...decisionIdentityFields(act, decision),
      ...terminal,
    });
  }
}

function foldStagedActSpaceId(act: FoldStagedAct): string | undefined {
  const value = act.parameters.spaceId ?? act.pins.spaceId;
  return typeof value === "string" ? value : undefined;
}

/** Mirrors the store's own refusals so every caller sees one vocabulary. */
function assertStagedForDecision(act: FoldStagedAct | undefined): asserts act is FoldStagedAct {
  if (!act) {
    throw new FoldStagedActError("NOT_FOUND", "No staged act has this id; approval never survives restaging.");
  }
  if (act.state === "staged") return;
  if (act.state === "expired") {
    throw new FoldStagedActError(
      "EXPIRED",
      "This staged act expired undecided. Expiry is not approval; restaging issues a fresh card.",
      { state: act.state },
    );
  }
  throw new FoldStagedActError(
    "ALREADY_SETTLED",
    `This staged act was already ${act.state}; a staged act is decided at most once.`,
    { state: act.state },
  );
}

/**
 * Light shape validation before any store read; the store re-validates the
 * complete decision input inside its own critical section.
 */
function decisionShapeIssue(input: FoldStagedActDecisionInput): string | null {
  if (input.decision !== "approved" && input.decision !== "denied") {
    return "the decision must be approved or denied.";
  }
  if (!FOLD_DECISION_SURFACES.includes(input.surface)) {
    return "the surface must be a decision surface; the act lane never decides.";
  }
  return null;
}

/** The v2 receipt fields every decision receipt carries, accepted and terminal alike. */
function decisionIdentityFields(
  act: FoldStagedAct,
  decision: FoldDecisionRecord,
): Pick<WorkFoldCliActReceiptV2, "decisionId" | "surface" | "browserId" | "grantId" | "policyId" | "spaceId"> {
  const spaceId = foldStagedActSpaceId(act);
  return {
    decisionId: act.id,
    surface: decision.surface,
    ...(decision.browserId !== undefined ? { browserId: decision.browserId } : {}),
    ...(decision.grantId !== undefined ? { grantId: decision.grantId } : {}),
    ...(decision.policyId !== undefined ? { policyId: decision.policyId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
  };
}

function stringPin(act: FoldStagedAct, name: string): string {
  const value = act.pins[name] ?? act.parameters[name];
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Per-kind execution adapters. Each binds one staged-act kind to the same
// domain path the equivalent desktop ceremony uses. Kinds whose internals
// live behind local API route internals (capability.package.install/update,
// app.connection.save, routing.enable, publish.viewer.expose, app.data.purge,
// app.storage.clear, files.destroy) stay unbound here; the desktop wiring
// binds them through the same FoldStagedActKindAdapter seam.
// ---------------------------------------------------------------------------

export interface RestrictedAppReviewApproveAdapterOptions {
  /** The routed proposal host that owns review records and the digest-checked install. */
  proposals: {
    get(id: string): Promise<RestrictedAppProposalReceipt | undefined>;
    install(id: string): Promise<RestrictedAppInstalled | null>;
  };
}

/**
 * `app.review.approve` — the digest-checked install path desktop approval
 * already uses. The proposal host re-verifies the reviewed digest at install
 * time, so a source changed between recheck and execution surfaces as the
 * existing REVISION_CHANGED refusal, recorded as a failed execution.
 */
export function createRestrictedAppReviewApproveAdapter(
  options: RestrictedAppReviewApproveAdapterOptions,
): FoldStagedActKindAdapter {
  return {
    async recheckPins(act) {
      const proposalId = stringPin(act, "proposalId");
      const proposal = await options.proposals.get(proposalId);
      if (!proposal) return "The pinned app review no longer exists; it was removed or superseded.";
      if (proposal.spaceId !== act.parameters.spaceId) {
        return "The pinned app review belongs to a different Space than this card.";
      }
      if (proposal.review.digest !== act.pins.reviewDigest) {
        return "The reviewed package digest no longer matches the pinned review; the source changed after review.";
      }
      if (proposal.status === "revision-changed") {
        return "The package changed after review; review the new revision before installing it.";
      }
      if (proposal.status === "dismissed") return "The app review was dismissed.";
      return null;
    },
    async execute(act) {
      const app = await options.proposals.install(stringPin(act, "proposalId"));
      if (!app) throw new Error("This app review is no longer available to install.");
      return {
        detail: `Installed ${app.packageName}@${app.version} (digest ${app.digest}).`,
      };
    },
  };
}

export type FoldRestrictedAppGrantKind = "app.grant.network" | "app.grant.files" | "app.grant.notifications";

export interface RestrictedAppGrantAdapterOptions {
  service: Pick<RestrictedAppService, "findByFeatureInstallation" | "grantNetwork" | "grantFiles" | "grantNotifications">;
  /** Resolves the Space root a file grant is validated against. */
  getSpace(spaceId: string): Promise<{ id: string; spaceRoot: string }>;
  /**
   * Space-relative root for a decided file grant. The staged-act record pins
   * the declaration identity only; until the staging contract carries an
   * exact person-visible root, an absent or null resolution keeps
   * `app.grant.files` approvals honestly ineligible instead of silently
   * granting a wide root the card never showed.
   */
  resolveFileGrantRoot?(act: FoldStagedAct): string | null;
}

/**
 * `app.grant.network|files|notifications` — the same grant path Assistant
 * tools uses, addressed by the pinned App Instance identity and re-verified
 * against the installed digest and the exact reviewed declaration.
 */
export function createRestrictedAppGrantAdapter(
  kind: FoldRestrictedAppGrantKind,
  options: RestrictedAppGrantAdapterOptions,
): FoldStagedActKindAdapter {
  // One sentence for the rootless file grant, shared by the eligibility
  // precheck and the execute-time backstop so the refusal always names where
  // the folder choice lives instead of dead-ending.
  const rootlessFileGrantIssue = "A Space file grant binds to a person-chosen folder inside the Space, and this card carries none. "
    + "Approve it from the main window's needs-you flyout, where the folder picker lives, or grant it from Assistant tools.";
  const resolve = async (act: FoldStagedAct): Promise<{ app: RestrictedAppInstalled } | { issue: string }> => {
    const spaceId = String(act.parameters.spaceId);
    const app = await options.service.findByFeatureInstallation(spaceId, stringPin(act, "appInstanceId"));
    if (!app) return { issue: "The pinned App Instance is no longer installed in this Space." };
    const installedDigest = app.releaseDigest ?? app.digest;
    if (installedDigest !== act.pins.releaseDigest) {
      return { issue: "The installed digest no longer matches the pinned release digest; the app changed after staging." };
    }
    const declarationId = stringPin(act, "declarationId");
    const declared = kind === "app.grant.network"
      ? app.manifest.permissions.network.some((item) => item.id === declarationId)
      : kind === "app.grant.files"
        ? app.manifest.permissions.files.some((item) => item.id === declarationId)
        : app.manifest.permissions.notifications.some((item) => item.id === declarationId);
    if (!declared) return { issue: "The app no longer declares the pinned permission." };
    return { app };
  };

  return {
    eligibilityIssue(act) {
      if (kind !== "app.grant.files") return null;
      const root = options.resolveFileGrantRoot?.(act) ?? null;
      return root === null ? rootlessFileGrantIssue : null;
    },
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const { app } = resolved;
      const declarationId = stringPin(act, "declarationId");
      const base = {
        spaceId: app.spaceId,
        appId: app.manifest.id,
        expectedDigest: app.digest,
      };
      if (kind === "app.grant.network") {
        await options.service.grantNetwork({ ...base, destinationId: declarationId });
        return {
          detail: `Granted network destination "${declarationId}" to ${app.manifest.id}.`,
          undoRef: { kind: "declaration", value: declarationId },
        };
      }
      if (kind === "app.grant.notifications") {
        await options.service.grantNotifications({ ...base, permissionId: declarationId });
        return {
          detail: `Granted notification category "${declarationId}" to ${app.manifest.id}.`,
          undoRef: { kind: "declaration", value: declarationId },
        };
      }
      const root = options.resolveFileGrantRoot?.(act) ?? null;
      if (root === null) throw new Error(rootlessFileGrantIssue);
      const space = await options.getSpace(app.spaceId);
      await options.service.grantFiles({ ...base, spaceRoot: space.spaceRoot, permissionId: declarationId, root });
      return {
        detail: `Granted Space file access "${declarationId}" (root "${root}") to ${app.manifest.id}.`,
        undoRef: { kind: "declaration", value: declarationId },
      };
    },
  };
}

export interface RestrictedAppAutomationEnableAdapterOptions {
  service: Pick<RestrictedAppService, "findByFeatureInstallation" | "setAutomationEnabled">;
}

/**
 * `app.automation.enable` — the existing enablement path; runs stay inside
 * the machine-wide scheduler bounds. The reviewed digest and the
 * host-composed schedule summary are pins, so a job whose package or cadence
 * changed since staging invalidates instead of enabling something the card
 * never described.
 */
export function createRestrictedAppAutomationEnableAdapter(
  options: RestrictedAppAutomationEnableAdapterOptions,
): FoldStagedActKindAdapter {
  const resolve = async (act: FoldStagedAct): Promise<{ app: RestrictedAppInstalled } | { issue: string }> => {
    const spaceId = String(act.parameters.spaceId);
    const app = await options.service.findByFeatureInstallation(spaceId, stringPin(act, "appInstanceId"));
    if (!app) return { issue: "The pinned App Instance is no longer installed in this Space." };
    // Automations bind to the package digest they were reviewed under, the
    // same identity automation run receipts capture.
    if (app.digest !== act.pins.reviewedDigest) {
      return { issue: "The installed package digest no longer matches the digest this job was reviewed under." };
    }
    const automationId = stringPin(act, "automationId");
    const declaration = app.manifest.automations.find((item) => item.id === automationId);
    if (!declaration) return { issue: "The app no longer declares the pinned automation." };
    if (restrictedAppAutomationScheduleSummary(declaration) !== act.pins.scheduleSummary) {
      return { issue: "The job's reviewed schedule changed after staging." };
    }
    return { app };
  };

  return {
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const { app } = resolved;
      const automationId = stringPin(act, "automationId");
      await options.service.setAutomationEnabled({
        spaceId: app.spaceId,
        appId: app.manifest.id,
        expectedDigest: app.digest,
        automationId,
        enabled: true,
      });
      return {
        detail: `Enabled automation "${automationId}" (${String(act.pins.scheduleSummary)}) for ${app.manifest.id}.`,
        undoRef: { kind: "automation", value: automationId },
      };
    },
  };
}

export interface SkillImportAdapterOptions {
  /**
   * Re-reads the exact bundle the staging path reviewed. Loading is identity,
   * not trust: the content-digest recheck decides whether these bytes are the
   * reviewed bytes.
   */
  loadBundle(act: FoldStagedAct): Promise<{ fileName: string; bytes: Uint8Array }>;
  /**
   * The root Pi runtime resolution uses. Space scope resolves the Space's
   * folder; Personal scope has no Space, so the binding names a neutral root.
   */
  rootForScope(act: FoldStagedAct): Promise<string> | string;
  runtimeProvider?: PiRuntimeProvider;
}

/**
 * `capability.skills.import` — the existing import path, digest-verified: the
 * pinned content digest names the exact reviewed bytes, and the enumerated
 * skill names are derived from those bytes, so digest equality is the whole
 * identity recheck.
 */
export function createSkillImportAdapter(options: SkillImportAdapterOptions): FoldStagedActKindAdapter {
  const loadVerified = async (act: FoldStagedAct): Promise<
    { bundle: { fileName: string; bytes: Uint8Array } } | { issue: string }
  > => {
    let bundle: { fileName: string; bytes: Uint8Array };
    try {
      bundle = await options.loadBundle(act);
    } catch (caught) {
      return { issue: `The staged skill bundle could not be re-read: ${errorMessage(caught)}` };
    }
    if (piSkillBundleContentDigest(bundle.bytes) !== act.pins.contentDigest) {
      return { issue: "The skill bundle's content no longer matches the pinned digest; the source changed after staging." };
    }
    return { bundle };
  };

  return {
    async recheckPins(act) {
      const loaded = await loadVerified(act);
      return "issue" in loaded ? loaded.issue : null;
    },
    async execute(act) {
      const loaded = await loadVerified(act);
      if ("issue" in loaded) throw new Error(loaded.issue);
      const root = await options.rootForScope(act);
      const result = await importPiSkillBundleVerified(root, {
        fileName: loaded.bundle.fileName,
        bytes: loaded.bundle.bytes,
        scope: act.parameters.scope === "space" ? "project" : "user",
        expectedContentDigest: String(act.pins.contentDigest),
      }, options.runtimeProvider);
      const names = result.skills.map((skill) => skill.name).join(", ");
      return {
        detail: `Imported ${result.skills.length === 1 ? "skill" : "skills"} ${names} at ${result.scope === "user" ? "Personal" : "This Space"} scope.`,
        undoRef: { kind: "skill-bundle-path", value: result.bundlePath },
      };
    },
  };
}

export interface ManagedSpaceDeletionAdapterOptions {
  /**
   * The complete desktop removal orchestration — impact checks, Check and App
   * state removal, claim-verified managed deletion — lives behind the local
   * API's route internals; the desktop wiring injects it. It performs its own
   * capability-mutation reservation across every affected Space, so this
   * adapter opts out of the service-level fence rather than reserving twice.
   */
  executeDeletion(act: FoldStagedAct): Promise<FoldDecisionExecutionEffect | void>;
  /** Test seam; defaults to the live-registry recheck in src/local/space.ts. */
  recheckPins?(pins: { spaceId: string; spaceRoot: string }): Promise<string | null>;
}

/**
 * `space.delete-folder` — the managed removal path. Pin recheck re-verifies
 * the registered identity and canonical root; the `.workspace/` fail-closed
 * rule and managed-root identity claims are re-checked by the removal
 * machinery itself at execution.
 */
export function createManagedSpaceDeletionAdapter(options: ManagedSpaceDeletionAdapterOptions): FoldStagedActKindAdapter {
  const recheck = options.recheckPins ?? managedSpaceDeletionPinIssue;
  return {
    fenceScope: () => null,
    async recheckPins(act) {
      return await recheck({
        spaceId: stringPin(act, "spaceId"),
        spaceRoot: stringPin(act, "spaceRoot"),
      });
    },
    async execute(act) {
      const effect = await options.executeDeletion(act);
      return effect ?? { detail: `Deleted the managed Space folder ${String(act.pins.spaceRoot)}.` };
    },
  };
}
