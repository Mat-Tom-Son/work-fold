/**
 * In-process authority the act-lane executor calls to apply commands. The
 * interactive local API implements this interface inside `startLocalApi`
 * (where the chat runtime state lives) and exposes it on `LocalApiHandle`;
 * the desktop CLI host receives it through a getter that answers null while
 * the interactive app is not running. Methods throw `WorkFoldCliError` so
 * exit codes map without translation.
 */

import type {
  WorkFoldCheckDecision,
  WorkFoldCheckDecisionKind,
  WorkFoldCheckFinding,
  WorkFoldCheckRunRecord,
} from "../checks/check-types.js";
import type {
  FoldDecisionSurface,
  FoldStagedActCategory,
  FoldStagedActExecutionOutcome,
  FoldStagedActFields,
  FoldStagedActKind,
  FoldStagedActStagedVia,
  FoldStagedActState,
} from "../fold-staged-acts.js";
import type { WorkFoldGlanceSnapshot } from "../glance.js";
import type { ManagementAttachmentRef } from "../management-attachments.js";
import type {
  ManagementAttachmentDisposition,
  ManagementRequestAction,
} from "../management-requests.js";
import type { SpaceChatMatch, SpaceFileMatch } from "../search.js";

export interface WorkFoldActSpaceRef {
  id: string;
  name: string;
  spaceRoot: string;
}

export interface WorkFoldActConversationRef {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

export type WorkFoldActChatState = "idle" | "running" | "compacting";

/**
 * Task-scoped view of one accepted Assistant turn. `unknown` means the id was
 * never accepted here or has aged out of the bounded durable turn journal;
 * transcripts remain the long-lived content authority.
 */
export type WorkFoldActTurnState = "running" | "succeeded" | "failed" | "aborted" | "unknown";

export interface WorkFoldActTurnStatus {
  taskId: string;
  state: WorkFoldActTurnState;
  conversationId: string | null;
  messageId: string | null;
  error: string | null;
  endedAt: string | null;
}

export interface WorkFoldActChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  interrupted?: true;
}

/**
 * Lifecycle position of a Chat before a lifecycle act ran. Receipts encode it
 * as the act's undo reference so the inverse verb (re-archive, re-snooze,
 * resume) can be chosen from the receipt alone.
 */
export interface WorkFoldActChatLifecycleState {
  archivedAt: string | null;
  snoozedUntil: string | null;
}

/**
 * Bounded projection of one History restore point. The act lane deliberately
 * returns manifest summaries, never per-file listings — restore-point content
 * stays inspectable on the desktop History pane.
 */
export interface WorkFoldActCheckpointSummary {
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  scope: "full" | "targeted";
  fileCount: number;
  totalBytes: number;
  skippedFileCount: number;
}

/** One captured version of a Space file, addressable by content hash. */
export interface WorkFoldActFileVersionRef {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
}

/**
 * Bounded flat projection of one passive Library entry. The Library is
 * personal and Space-free, so items carry no Space ids and no History
 * references — copying into a Space is the explicit act that gains both.
 */
export interface WorkFoldActLibraryItem {
  path: string;
  kind: "file" | "folder";
  sizeBytes?: number;
}

/**
 * Phase of one management request. `working` is the management turn itself;
 * `handed_off` means the management turn finished but a Space Assistant turn
 * it started is still running — "done" is never claimed while downstream work
 * continues. `needs_you` reflects a completed turn whose reply ends by asking
 * the person a question.
 */
export type WorkFoldActManagementRequestPhase =
  | "working"
  | "needs_you"
  | "handed_off"
  | "done"
  | "failed"
  | "stopped";

export interface WorkFoldActManagementChildStatus {
  taskId: string;
  spaceId: string;
  spaceName: string;
  conversationId: string;
  state: WorkFoldActTurnState;
  error: string | null;
}

/**
 * One attachment's accounted outcome in a request view. The registry's own
 * disposition vocabulary (`placed`, `registered`, `unrecorded`) is widened
 * with `library`: the attachment entered the personal Library through an
 * attributed `library add`. The Library is Space-free, so a library
 * disposition carries the Library-relative destinations and never a Space id
 * or restore point.
 */
export interface WorkFoldActAttachmentDisposition {
  attachment: ManagementAttachmentRef;
  status: ManagementAttachmentDisposition["status"] | "library";
  spaceId?: string;
  spaceName?: string;
  copied?: string[];
  checkpointId?: string | null;
}

export interface WorkFoldActManagementRequest {
  taskId: string;
  conversationId: string;
  phase: WorkFoldActManagementRequestPhase;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  content: string;
  attachments: ManagementAttachmentRef[];
  dispositions: WorkFoldActAttachmentDisposition[];
  actions: ManagementRequestAction[];
  children: WorkFoldActManagementChildStatus[];
  reply: { messageId: string; content: string } | null;
  source: "local" | "remote_web";
  remotePrincipalId: string | null;
  remoteRequestId: string | null;
}

export interface WorkFoldActCheckTaskStatus {
  taskId: string;
  runId: string | null;
  state: WorkFoldCheckRunRecord["state"] | "unknown";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

/** Registered-Space storage kind, mirrored from the Space registry. */
export type WorkFoldActSpaceStorage = "managed" | "linked";

/**
 * App Studio presentation values, exactly the pane's typed form: a title plus
 * optional description and icon id. The act verb reads them from a typed JSON
 * file resolved host-side, never from free-form argv.
 */
export interface WorkFoldActAppPresentation {
  title: string;
  description: string | null;
  icon: string | null;
}

/** Bounded projection of one immutable content-addressed App Release record. */
export interface WorkFoldActAppReleaseRef {
  releaseDigest: string;
  displayVersion: string;
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
  featureCount: number;
}

/**
 * Bounded projection of one prepared App Studio operation. `fromReleaseDigest`
 * is present exactly for update plans, so a receipt can name the transition by
 * content identity instead of inferring an update-versus-rollback label the
 * service does not record.
 */
export interface WorkFoldActAppOperationRef {
  operationId: string;
  kind: "install" | "update";
  releaseDigest: string;
  runtimeInstanceId: string;
  targetSpaceId: string;
  preparedAt: string;
  fromReleaseDigest?: string;
  continuityPolicy?: "eligible" | "reset";
}

/** Bounded projection of one release-backed App Instance. */
export interface WorkFoldActAppInstanceRef {
  runtimeInstanceId: string;
  spaceId: string;
  releaseDigest: string;
  displayVersion: string;
}

/**
 * Bounded projection of one Chat-bound restricted-app proposal receipt. The
 * review's digest and package identity are the fields a staging or dismissal
 * needs; the full review (manifest, permissions, file counts) stays on the
 * desktop review dialog.
 */
export interface WorkFoldActAppProposalRef {
  id: string;
  status: "pending" | "installed" | "dismissed" | "revision-changed";
  sourcePath: string;
  title: string;
  packageName: string;
  version: string;
  digest: string;
  createdAt: string;
  updatedAt: string;
}

/** Bounded projection of one named-automation run receipt. */
export interface WorkFoldActAppAutomationRunRef {
  runId: string;
  outcome: "success" | "failure" | "skipped" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt: string;
  error?: string;
}

/** Bounded projection of a routing's reviewed trigger (docs/fold-routings.md). */
export interface WorkFoldActRoutingTriggerRef {
  kind: "manual" | "interval" | "on-settled";
  intervalMinutes?: number;
  source?: {
    kind: "check-run" | "app-automation-run";
    spaceId: string;
    checkId?: string;
    appId?: string;
    automationId?: string;
    outcomes: string[];
  };
}

/** One enablement consecration in a routing's grant history. */
export interface WorkFoldActRoutingGrantRef {
  digest: string;
  decisionId: string;
  approvedAt: string;
  surface: FoldDecisionSurface;
  browserId?: string;
}

/**
 * One-line projection of a routing for `routings list`. Content-bearing by
 * design (titles, Space ids) and therefore act-lane only, per the Checks rule
 * that keeps the content-free read lane aggregate.
 */
export interface WorkFoldActRoutingSummary {
  routingId: string;
  title: string;
  health: "enabled" | "disabled" | "suspended";
  digest: string;
  trigger: WorkFoldActRoutingTriggerRef;
  stepCount: number;
  referencedSpaceIds: string[];
  /** The live grant's approval time while enabled; absent otherwise. */
  enabledAt?: string;
  disabledAt?: string;
  suspension?: { at: string; missingSpaceIds: string[]; reRegisteredSpaceIds: string[] };
  lastScheduledAt?: string;
  nextScheduledAt?: string;
}

/**
 * A routing step in review form: ids resolved to current Space names where
 * the Space is still registered, the chat message verbatim (it is the text a
 * person reviewed at enablement), and the files source exactly as declared.
 */
export type WorkFoldActRoutingStepView =
  | { id: string; kind: "chat"; spaceId: string; spaceName?: string; message: string }
  | {
    id: string;
    kind: "files";
    fromSpaceId: string;
    fromSpaceName?: string;
    source:
      | { kind: "paths"; paths: string[] }
      | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
      | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number };
    toSpaceId: string;
    toSpaceName?: string;
    to: string;
  }
  | { id: string; kind: "check"; spaceId: string; spaceName?: string; checkId?: string };

/** The full review projection for `routings show`. */
export interface WorkFoldActRoutingDetail extends WorkFoldActRoutingSummary {
  steps: WorkFoldActRoutingStepView[];
  grants: WorkFoldActRoutingGrantRef[];
}

/**
 * Bounded projection of one routing receipts-journal line. Identifiers,
 * digests, paths, and counts only — the journal never holds message text or
 * file contents, and this projection adds nothing to it.
 */
export interface WorkFoldActRoutingReceipt {
  at: string;
  scope: "routing" | "run" | "hop";
  outcome: string;
  routingId: string;
  runId?: string;
  hopId?: string;
  hopKind?: "chat" | "files" | "check";
  title?: string;
  digest?: string;
  detail?: string;
  cause?: unknown;
  spaceId?: string;
  fromSpaceId?: string;
  toSpaceId?: string;
  conversationId?: string;
  taskId?: string;
  checkpointIds?: string[];
  restorePointId?: string;
  sourcePaths?: string[];
  copiedPaths?: string[];
  fileCount?: number;
  totalBytes?: number;
  checkRunId?: string;
  checkIds?: string[];
  findingCount?: number;
  admittedCount?: number;
  failedHopId?: string;
  stoppedHopTaskIds?: string[];
  surface?: string;
  decisionId?: string;
  missingSpaceIds?: string[];
  requestId?: string;
}

/**
 * Bounded projection of one publication grant record (docs/fold-publishing.md).
 * The share link's key and full link never appear anywhere in the act lane;
 * a publication is identified by `publicationId` and its viewer path only.
 */
export interface WorkFoldActPublicationRef {
  publicationId: string;
  kind: "page" | "app";
  spaceId: string;
  /** Resolved current Space name, when the Space is still registered. */
  spaceName?: string;
  /** Page slots only: the one designated Space-relative file. */
  relativePath?: string;
  /** Hosted-app slots only (docs/fold-publishing.md, rung 3): the consecrated exposure pins. */
  appInstanceId?: string;
  releaseDigest?: string;
  viewerEntry?: string;
  viewerSurface?: string[];
  title: string;
  state: "active" | "revoked" | "expired";
  live: boolean;
  serveRatePerMinute: number;
  byteBudgetPerDay: number;
  snapshotEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  expiresAt?: string;
  bridgeSlot: "pending" | "confirmed";
  bridgeCleanup?: "pending" | "ok";
  viewerPath: string;
}

/**
 * The ledger's staged result shape (docs/fold-act-ledger.md,
 * docs/fold-consecrations.md): a consecrated verb always stages a fully
 * prepared, pinned act and returns the decision's identity. The
 * `decisionId` is the staged-act id; the staged act and its decision share one
 * identity by construction, and the staging receipt stamps the same id.
 *
 * `state` is `"staged"` except when an enabled standing policy matches or
 * the machine is in Unrestricted mode. Host-side evaluation then
 * short-circuits into the same decision path, no card appears, and the result
 * reports the basis in `autoApproval` with `state: "approved"`. The act lane
 * still never selects authority; local Settings owns both mechanisms.
 */
export interface WorkFoldActStagedDecision {
  decisionId: string;
  kind: FoldStagedActKind;
  category: FoldStagedActCategory;
  state: "staged" | "approved";
  createdAt: string;
  expiresAt: string;
  /** True when an identical pending act (same kind, same pins) already existed. */
  deduplicated: boolean;
  /** Denial memory: quiet nagging is visible for what it is. */
  priorDenialAt?: string;
  /** Present exactly when a standing policy satisfied the consecration at staging. */
  autoApproval?: WorkFoldActStagedAutoApproval;
}

/**
 * The after-the-fact visibility an exercised standing policy gets
 * (docs/fold-consecrations.md): no card appeared, so the staging verb's
 * response says the act was auto-approved and by which policy, and the
 * decision receipts carry `surface: "policy"`, the policy id, and the label
 * snapshot at exercise time.
 */
export interface WorkFoldActStagedAutoApproval {
  basis: "policy" | "unrestricted";
  policyId?: string;
  /** The policy's person-authored label at exercise time, as on the receipt. */
  policyLabel?: string;
  executionOutcome: FoldStagedActExecutionOutcome;
  /** Host-observed error text when the approved execution failed. */
  detail?: string;
  /** False when the terminal decision receipt could not be appended. */
  receipted: boolean;
}

/** Bounded one-line projection of a staged act for `staged list`. */
export interface WorkFoldActStagedActSummary {
  id: string;
  kind: FoldStagedActKind;
  category: FoldStagedActCategory;
  state: FoldStagedActState;
  createdAt: string;
  expiresAt: string;
  spaceId?: string;
  decidedAt?: string;
  decisionSurface?: FoldDecisionSurface;
  executionOutcome?: FoldStagedActExecutionOutcome;
  priorDenialAt?: string;
}

/**
 * The complete host-composed card facts for `staged show`: exactly the typed
 * record the decision surfaces render — parameters, pins, provenance, the two
 * surface rules, and any settled decision or execution outcome. Model prose
 * never appears here; every line is composed from typed fields.
 */
export interface WorkFoldActStagedActDetail extends WorkFoldActStagedActSummary {
  parameters: FoldStagedActFields;
  pins: FoldStagedActFields;
  provenance: {
    stagedVia: FoldStagedActStagedVia;
    conversationId?: string;
    parentTaskId?: string;
    requestId: string;
    browserId?: string;
    grantId?: string;
  };
  /** The surface rules, stated on the card instead of discovered at refusal time. */
  restrictions: { desktopOnly: boolean; stagedByGrantId?: string };
  decision?: {
    decision: "approved" | "denied";
    surface: FoldDecisionSurface;
    browserId?: string;
    grantId?: string;
    policyId?: string;
    note?: string;
  };
  execution?: { outcome: FoldStagedActExecutionOutcome; at: string; errorDetail?: string };
  invalidationReason?: string;
  cancellationReason?: string;
}

export interface WorkFoldActFacade {
  createConversation(input: { space: string }): Promise<{ space: WorkFoldActSpaceRef; conversation: WorkFoldActConversationRef }>;
  listConversations(input: { space: string }): Promise<{ space: WorkFoldActSpaceRef; conversations: WorkFoldActConversationRef[] }>;
  sendMessage(input: {
    space: string;
    conversationId?: string;
    newConversation?: boolean;
    content: string;
    /** Act-envelope request id reused as the durable Assistant-turn identity. */
    requestId?: string;
    /** Explicit active management request that initiated this action. */
    parentTaskId?: string;
  }): Promise<{ space: WorkFoldActSpaceRef; conversationId: string; messageId: string; taskId: string }>;
  conversationStatus(input: { space: string; conversationId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversation: WorkFoldActConversationRef;
    state: WorkFoldActChatState;
  }>;
  conversationResult(input: { space: string; conversationId: string; messages?: number }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    state: WorkFoldActChatState;
    total: number;
    lastAssistant: string | null;
    messages: WorkFoldActChatMessage[];
  }>;
  abortTurn(input: { space: string; conversationId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    aborted: boolean;
  }>;
  turnStatus(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    task: WorkFoldActTurnStatus;
  }>;
  turnResult(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: WorkFoldActChatMessage;
  }>;

  /**
   * Chat lifecycle verbs (docs/fold-act-ledger.md). Each performs exactly one
   * lifecycle change through the same conversation internals as the desktop
   * PATCH route — append-only lifecycle records in the Chat's portable log,
   * refused while that Chat's Assistant turn or compaction runs — and returns
   * the prior state so the act receipt can carry a typed undo reference.
   */
  chatRename(input: { space: string; conversationId: string; title: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversation: WorkFoldActConversationRef;
    priorTitle: string;
  }>;
  chatSnooze(input: { space: string; conversationId: string; until: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversation: WorkFoldActConversationRef;
    priorLifecycle: WorkFoldActChatLifecycleState;
  }>;
  chatArchive(input: { space: string; conversationId: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversation: WorkFoldActConversationRef;
    priorLifecycle: WorkFoldActChatLifecycleState;
  }>;
  chatResume(input: { space: string; conversationId: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversation: WorkFoldActConversationRef;
    priorLifecycle: WorkFoldActChatLifecycleState;
  }>;
  /**
   * Compacts one Chat through the same internals as the composer's `/compact`:
   * additive summarization, never deletion. It is refused while that Chat's
   * turn or compaction runs and while a capability mutation is active, and it
   * registers the same kernel `compaction` task as the renderer — started
   * before the compaction and finished on every outcome — whose id is the
   * receipt's task reference.
   */
  chatCompact(input: { space: string; conversationId: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    compacted: true;
    taskId: string;
  }>;

  /**
   * History verbs (docs/fold-act-ledger.md). Saving is additive and honestly
   * reports when the Space already matches its latest restore point; both
   * restore verbs record the safety restore point History itself created, so
   * every History act is recoverable through History. Whole-Space restore is
   * refused while Assistant, compaction, or Check work is active in the
   * Space, while a restricted-app automation run whose app holds a file
   * grant into the Space is active, and while a routing run with a files hop
   * targeting the Space is active (the kernel-checked rule) — a deliberate
   * strengthening over the desktop's confirm dialog.
   */
  historyList(input: { space: string }): Promise<{
    space: WorkFoldActSpaceRef;
    checkpoints: WorkFoldActCheckpointSummary[];
  }>;
  historySave(input: { space: string; label?: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    checkpoint: WorkFoldActCheckpointSummary;
    created: boolean;
  }>;
  historyRestore(input: { space: string; checkpointId: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    restored: true;
    checkpointId: string;
    safetyCheckpointId: string;
    restoredFileCount: number;
    deletedFileCount: number;
    movedEntryCount: number;
    unchangedFileCount: number;
    skippedLargeFileCount: number;
  }>;
  historyVersions(input: { space: string; path: string }): Promise<{
    space: WorkFoldActSpaceRef;
    path: string;
    versions: WorkFoldActFileVersionRef[];
  }>;
  historyRestoreFile(input: { space: string; path: string; version: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    restored: true;
    path: string;
    hashSha256: string;
    previousHashSha256: string | null;
    safetyCheckpointId: string;
  }>;

  /**
   * In-Space file verbs (docs/fold-act-ledger.md): the same local-entry
   * mutations as the desktop routes — same path policy (`.work-fold/`,
   * `.pi/`, and `.workspace/` are never valid endpoints), same safety restore
   * points — plus one deliberate strengthening: `filesDelete` refuses
   * whenever its safety restore point skipped a matched file (oversized,
   * unreadable, a symbolic link, or History-excluded), because a delete the
   * restore point cannot cover is a destroy and only the staged
   * `files destroy` consecration may perform it. Creation verbs record the
   * same pre-create restore point as the desktop routes, but their receipts
   * carry the created path as the undo reference — the canonical inverse of
   * creating is `files delete`, and creation destroys nothing.
   */
  filesMove(input: { space: string; fromPath: string; toDir: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    fromPath: string;
    path: string;
    kind: "file" | "folder";
    safetyCheckpointId: string;
  }>;
  filesRename(input: { space: string; path: string; newName: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    fromPath: string;
    path: string;
    priorName: string;
    kind: "file" | "folder";
    safetyCheckpointId: string;
  }>;
  filesDelete(input: { space: string; path: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    deleted: true;
    path: string;
    kind: "file" | "folder";
    safetyCheckpointId: string;
  }>;
  filesMkdir(input: { space: string; path: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    created: true;
    path: string;
    kind: "folder";
    safetyCheckpointId: string;
  }>;
  filesCreate(input: { space: string; path: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    created: true;
    path: string;
    kind: "file";
    safetyCheckpointId: string;
  }>;

  /**
   * Content search over one Space's files and Chats — the same service as
   * `/api/spaces/:id/search`. It honours the person's ignore rules, skips
   * binary and oversized files, and reports when a bound stopped the search
   * rather than implying completeness. The act receipt records the scope
   * only, never the query text.
   */
  search(input: { space: string; query: string; scope?: "files" | "chats" | "all" }): Promise<{
    space: WorkFoldActSpaceRef;
    scope: "files" | "chats" | "all";
    query: string;
    files: SpaceFileMatch[];
    chats: SpaceChatMatch[];
    truncated: boolean;
    scannedFiles: number;
  }>;

  /**
   * Library verbs. Listing is a bounded content-free projection of the
   * personal collection; `libraryCopy` is the explicit independent copy into
   * a Space the product model requires — landing under `From Library` with a
   * restore point recorded in the destination Space, the Library original
   * untouched, and copy and restore point succeeding or failing together.
   */
  libraryList(): Promise<{ items: WorkFoldActLibraryItem[]; truncated: boolean }>;
  libraryCopy(input: { item: string; space: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    item: string;
    copied: string;
    checkpointId: string | null;
  }>;
  /**
   * Copies external files (or folders, walked file-by-file) into the passive
   * personal Library through the same upload internals as the desktop's "Add
   * files to Library". The Library is personal and Space-free: no `--space`,
   * and no restore point — History is a Space concept (docs/fold-act-ledger.md).
   * Sources are read fresh from disk; symbolic links are refused.
   */
  libraryAdd(input: { fromPaths: string[]; toDir?: string; cwd: string; parentTaskId?: string }): Promise<{
    added: Array<{ path: string; sizeBytes: number }>;
  }>;
  /**
   * Creates one new top-level Library folder — the desktop's "New Library
   * folder" control. No in-product removal verb exists on any surface yet, so
   * the receipt carries the created path with no undo reference.
   */
  libraryFolderCreate(input: { name: string; parentTaskId?: string }): Promise<{
    created: true;
    path: string;
  }>;

  createSpace(input: { name: string; parentTaskId?: string }): Promise<{ space: WorkFoldActSpaceRef }>;
  registerSpace(input: { spaceRoot: string; parentTaskId?: string }): Promise<{ space: WorkFoldActSpaceRef }>;
  addFiles(input: { space: string; fromPaths: string[]; toDir?: string; cwd: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    copied: string[];
    checkpointId: string | null;
  }>;

  /**
   * Space lifecycle verbs (docs/fold-act-ledger.md). Renaming refuses a name
   * another registered Space already uses under the CLI selector's
   * case-insensitive match — a duplicate exact name would make `--space`
   * selection ambiguous. Unregistering removes the registration and revokes
   * work-fold's project-runtime authorization while the folder and its
   * portable `.work-fold/` identity remain — for both storage kinds: a
   * managed Space's registration removal records a preserve-disposition
   * intent that provably holds no deletion authority. It runs the same App
   * Studio impact checks, publication blocks, and routing/staged-act
   * revocation cascades as the desktop removal path. Deleting a managed
   * folder is consecration 3 (`spaces delete`) and never reaches this facade.
   */
  spacesRename(input: { space: string; name: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    priorName: string;
  }>;
  spacesUnregister(input: { space: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    storage: WorkFoldActSpaceStorage;
    removed: true;
    cleanupPending: boolean;
  }>;

  /**
   * Space appearance verbs. Apply accepts only the typed `space-appearance`
   * proposal file (the same validation as Customize Space; nothing else is
   * accepted), and every mutation records the displaced customization so undo
   * is one act. Refs are short content digests — identifiers for receipts,
   * never the customization payload. Undo is refused with a typed error when
   * no receipted appearance act recorded a prior customization for the Space
   * in this app run, or when the current appearance was last changed outside
   * the act lane (for example on the desktop), because the recorded prior
   * state then no longer describes what would be displaced.
   */
  spacesAppearanceApply(input: { space: string; proposalPath: string; cwd: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    applied: true;
    proposalName: string;
    appearanceRef: string | null;
    priorAppearanceRef: string | null;
  }>;
  spacesAppearanceReset(input: { space: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    reset: true;
    changed: boolean;
    priorAppearanceRef: string | null;
  }>;
  spacesAppearanceUndo(input: { space: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    restored: true;
    restoredAppearanceRef: string | null;
    displacedAppearanceRef: string | null;
  }>;

  /**
   * Assistant-tools removal — the ledger's one direct tools verb; installs,
   * updates, and skill imports make bytes runnable and stage upstream as
   * consecration 1. Personal scope mutates the same personal Pi settings
   * every Space runtime loads (resolved through the app-owned management
   * root, exactly like the management conversation's own runtime) and is
   * fenced against all running work; Space scope requires the explicit Space
   * and its project trust. Both reuse the desktop's capability-mutation
   * fencing unchanged. A source that is not installed reports `removed:
   * false` honestly.
   */
  toolsRemove(input: { scope: "personal" | "space"; space?: string; source: string; parentTaskId?: string }): Promise<{
    scope: "personal" | "space";
    space?: WorkFoldActSpaceRef;
    source: string;
    removed: boolean;
  }>;

  /**
   * Space-app authority direct verbs (docs/fold-act-ledger.md): the
   * narrowing and neutral side of restricted-app authority, reusing the
   * exact desktop route internals with their capability fencing. Widening —
   * installs, grants, connections, automation enablement — stages upstream
   * as consecrations and never reaches these methods. Verbs that name an app
   * without a digest resolve the installed revision host-side and pin it for
   * the mutation, so a revision change between lookup and act fails instead
   * of acting on different bytes.
   */
  appsProposalsList(input: { space: string; conversationId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    conversationId: string;
    proposals: WorkFoldActAppProposalRef[];
  }>;
  /** Dismissal is not denial-of-review: nothing runnable existed, and the Assistant may propose again. */
  appsProposalsDismiss(input: { space: string; conversationId: string; proposal: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    proposalId: string;
    dismissed: boolean;
  }>;
  /** Removes a reviewed development app; release-backed Instances take `appsUninstall`. Reinstalling is a fresh consecration. */
  appsRemove(input: { space: string; app: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    appId: string;
    digest: string;
    removed: boolean;
  }>;
  /**
   * Revokes one granted declaration on the exact reviewed digest. Revocation
   * stops stale launches before the authority change reads as complete
   * (service-side), and `revoked: false` honestly reports a declaration that
   * was not granted. Re-granting is a fresh consecration.
   */
  appsRevoke(input: {
    space: string;
    app: string;
    digest: string;
    kind: "network" | "files" | "notifications";
    declaration: string;
    parentTaskId?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    appId: string;
    grantKind: "network" | "files" | "notifications";
    declaration: string;
    revoked: boolean;
  }>;
  /**
   * Removes one saved connection's local record. Deleting the local record
   * does not revoke the credential at its provider — the receipt says so.
   */
  appsDisconnect(input: { space: string; app: string; destination: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    appId: string;
    destination: string;
    disconnected: boolean;
  }>;
  appsAutomationDisable(input: { space: string; app: string; automation: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    appId: string;
    automationId: string;
    disabled: true;
    wasEnabled: boolean;
  }>;
  /**
   * Run-now for an enabled named automation, under the machine-wide
   * scheduler's admission rules (two slots, same-job non-overlap). The run's
   * durable, authority-captured receipt is the result; a run the scheduler
   * skipped reports its skipped outcome honestly.
   */
  appsAutomationRun(input: { space: string; app: string; automation: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    appId: string;
    automationId: string;
    run: WorkFoldActAppAutomationRunRef;
  }>;

  /**
   * App Studio's authority-neutral spine (docs/fold-act-ledger.md): these
   * verbs change which local records exist, never what may run with which
   * powers — powers arrive only through staged consecrations. Every method
   * reuses the exact desktop route internals, including the App Studio
   * guards: referenced Releases cannot be deleted, prepared operations
   * recheck at activation, digest identity beats display versions, and
   * install activation starts with every power off.
   */
  appsProjectDeclare(input: { space: string; presentationPath: string; cwd: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    project: { projectId: string; presentation: WorkFoldActAppPresentation };
    priorPresentation: WorkFoldActAppPresentation | null;
    priorPresentationRef: string | null;
  }>;
  appsReleasePrepare(input: { space: string; version: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    release: WorkFoldActAppReleaseRef;
  }>;
  appsReleasePublish(input: { space: string; release: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    release: WorkFoldActAppReleaseRef;
  }>;
  appsReleaseDelete(input: { space: string; release: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    releaseDigest: string;
    deleted: boolean;
    cleanupPending: boolean;
  }>;
  appsInstallPrepare(input: { space: string; release: string; targetSpace: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    targetSpace: WorkFoldActSpaceRef;
    operation: WorkFoldActAppOperationRef;
  }>;
  appsUpdatePrepare(input: { space: string; instance: string; release: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    targetSpace: WorkFoldActSpaceRef;
    operation: WorkFoldActAppOperationRef;
  }>;
  appsOperationActivate(input: { space: string; operation: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    operationId: string;
    operationKind: "install" | "update";
    instance: WorkFoldActAppInstanceRef;
  }>;
  appsOperationCancel(input: { space: string; operation: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    operationId: string;
    cancelled: boolean;
  }>;
  /**
   * Uninstall with the retain-data disposition only. Purging is destroying
   * irreversibly (consecration 3), so the executor stages `--purge-data`
   * upstream and it never reaches this method. Retained namespaces do not
   * remain runnable, and reinstalling creates a new Instance.
   */
  appsUninstall(input: { space: string; instance: string; parentTaskId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    runtimeInstanceId: string;
    removed: boolean;
    retainedNamespaceIds: string[];
    cleanupPending: boolean;
  }>;

  /**
   * The consecrated ledger rows (docs/fold-act-ledger.md; machinery in
   * docs/fold-consecrations.md). Each method composes the act's typed
   * parameters and pins from live state — never from model prose — stages a
   * fully prepared, inert act through the staged-act store, and returns the
   * pending decision's identity. Nothing executes here: the person decides on
   * a needs-you card, and deciding has no facade shape anywhere, permanently.
   * `requestId` is the staging act's journal id, recorded as provenance so
   * the card, the receipt, and the ledger name one request.
   */
  /** Consecration 3: stages managed deletion of one Space's folder, after the same impact checks as unregister. */
  spacesDelete(input: { space: string; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
  }>;
  /** Consecration 3: stages a deletion the restore-point machinery cannot cover, pinning observed content identities. */
  filesDestroy(input: { space: string; paths: string[]; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    paths: string[];
    contentIdentities: string[];
  }>;
  /** Consecration 1: stages one executable skill-bundle import, pinning the exact reviewed bytes. */
  toolsImportSkill(input: {
    scope: "personal" | "space";
    space?: string;
    from: string;
    cwd: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    scope: "personal" | "space";
    space?: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    source: string;
    contentDigest: string;
    skillNames: string[];
  }>;
  /**
   * Consecration 1: stages one Pi package or Extension install (or an
   * official catalog skill bundle, which stages as a skills import). Pins the
   * package id, the exact inspected version, and the inspected resource
   * summary the needs-you card shows; a source whose exact version cannot be
   * pinned is refused honestly rather than staged vaguely.
   */
  toolsInstall(input: {
    scope: "personal" | "space";
    space?: string;
    catalogId?: string;
    source?: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    scope: "personal" | "space";
    space?: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    source: string;
    packageId?: string;
    version?: string;
    resourceSummary?: string;
    contentDigest?: string;
    skillNames?: string[];
  }>;
  /** Consecration 1: stages a Pi package update to the exact inspected next version. */
  toolsUpdate(input: {
    scope: "personal" | "space";
    space?: string;
    source: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    scope: "personal" | "space";
    space?: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    source: string;
    packageId: string;
    version: string;
    resourceSummary: string;
  }>;
  /** Consecration 1: stages approval of one pending Chat app review, pinned to its reviewed digest. */
  appsInstallProposal(input: {
    space: string;
    conversationId: string;
    proposal: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    proposalId: string;
    digest: string;
  }>;
  /**
   * Consecration 1 (the ledger's "Add / update local preview" row): the host
   * inspects the named Space-relative package folder and records a pending
   * review record — the same host-owned review the Chat proposal path
   * produces, with work-fold owning every review field and the digest — then
   * stages the existing `app.review.approve` kind pinned to that review. The
   * closed staged-act vocabulary gains nothing; approval rides the same
   * digest-checked install path as an approved Chat proposal.
   */
  appsInstallPreview(input: {
    space: string;
    packagePath: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    proposalId: string;
    digest: string;
    title: string;
    packageName: string;
    version: string;
    /** True when an app with the same manifest id is already installed: approval replaces it and resets every grant, connection, and automation. */
    replacesInstalled: boolean;
  }>;
  /** Consecration 2: stages one grant of one exact reviewed declaration on the exact installed digest. */
  appsGrant(input: {
    space: string;
    app: string;
    digest: string;
    kind: "network" | "files" | "notifications";
    declaration: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    appId: string;
    grantKind: "network" | "files" | "notifications";
    declaration: string;
  }>;
  /** Consecration 2: stages the connection's shape only — never a secret; the credential is entered in the trusted surface. */
  appsConnect(input: { space: string; app: string; destination: string; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    appId: string;
    destination: string;
    target: string;
    adapterKind: string;
  }>;
  /** Consecration 2: stages enabling one reviewed named job, pinning its digest and schedule summary. */
  appsAutomationEnable(input: { space: string; app: string; automation: string; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    appId: string;
    automationId: string;
    scheduleSummary: string;
  }>;
  /** Consecration 3: stages clearing one installed app's live storage, stating the byte count being destroyed. */
  appsStorageClear(input: { space: string; app: string; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    appId: string;
    observedBytes: number;
  }>;
  /** Consecration 3: stages purging one retained App data record. */
  appsRetainedPurge(input: { space: string; retained: string; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    retainedDataId: string;
    dataNamespaceIds: string[];
  }>;
  /** Consecration 3: stages the purge disposition of `apps uninstall --purge-data`. */
  appsUninstallPurge(input: { space: string; instance: string; parentTaskId?: string; requestId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    runtimeInstanceId: string;
    dataNamespaceIds: string[];
  }>;
  /**
   * Consecration 2 (docs/fold-routings.md): stages enablement of one declared
   * routing from its inert typed proposal file. The declaration is normalized
   * and digest-pinned at staging; approval executes the routing service's
   * enablement with `decisionId` equal to the staged-act id, so the grant, the
   * receipts, and the card all name one identity. Routings are above Spaces:
   * no `--space` exists on this verb.
   */
  routingsStage(input: { proposalPath: string; cwd: string; parentTaskId?: string; requestId?: string }): Promise<{
    staged: WorkFoldActStagedDecision;
    routingId: string;
    declarationDigest: string;
    title: string;
    referencedSpaceIds: string[];
  }>;
  /**
   * Consecration 2 (docs/fold-publishing.md): stages one outward page
   * exposure, pinning the Space id, exact relative path, title, budgets, and
   * snapshot flag per the publishing mutation ledger. Approval activates the
   * publication; nothing is exposed while the card pends.
   */
  pagesStage(input: {
    space: string;
    path: string;
    title: string;
    snapshot?: boolean;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    relativePath: string;
    title: string;
    snapshotEnabled: boolean;
    serveRatePerMinute: number;
    byteBudgetPerDay: number;
  }>;
  /**
   * Consecration 2, hosted-app shape (docs/fold-publishing.md, rung 3):
   * stages putting one installed App Instance at the person's address,
   * pinning the App Instance id, exact Release digest, viewer entry, and the
   * complete viewer-readable surface. Eligibility requires an installed
   * Release-backed Instance whose reviewed manifest declares a viewer
   * surface; approval activates the hosted exposure with kind `app`.
   * Nothing is exposed while the card pends.
   */
  pagesStageApp(input: {
    space: string;
    instance: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    staged: WorkFoldActStagedDecision;
    appId: string;
    title: string;
    appInstanceId: string;
    releaseDigest: string;
    viewerEntry: string;
    viewerSurface: string[];
    serveRatePerMinute: number;
    byteBudgetPerDay: number;
  }>;

  /**
   * Routing management verbs (docs/fold-routings.md). Routings are above
   * Spaces: none of these takes a Space, like the manage group. Listing,
   * showing, and receipts are content-bearing act reads (titles, Space names,
   * the chat message a person reviewed); run-now is a direct verb on an
   * enabled routing only; stop and disable are narrowing and never need a
   * click; delete removes a disabled or suspended declaration while the
   * receipts journal is retained — audit records survive the object.
   * Enabling has no method here: it is consecration 2, staged by
   * `routingsStage` and decided on a needs-you card.
   */
  routingsList(): Promise<{ routings: WorkFoldActRoutingSummary[] }>;
  routingsShow(input: { routing: string }): Promise<{ routing: WorkFoldActRoutingDetail }>;
  /**
   * Manual run-now for an enabled routing: receipted, never a schedule
   * mutation, refused for proposed/disabled/suspended health. The result is
   * the settled scheduler run — the executor's own journal keeps the per-hop
   * evidence, inspectable through `routingsReceipts`.
   */
  routingsRun(input: { routing: string; parentTaskId?: string; requestId?: string }): Promise<{
    routingId: string;
    title: string;
    run: WorkFoldActAppAutomationRunRef;
  }>;
  /** Stops this routing's active run; a routing with no active run refuses with its settled truth. */
  routingsStop(input: { routing: string; parentTaskId?: string }): Promise<{
    routingId: string;
    stopped: true;
    runId: string;
  }>;
  /**
   * Disable narrows standing behavior on the layered-authority order: the
   * disabled intent persists first, pending admissions are cancelled, and the
   * active run (if any) is stopped — the result names what it stopped.
   * Re-enabling is a fresh consecration.
   */
  routingsDisable(input: { routing: string; parentTaskId?: string }): Promise<{
    routingId: string;
    disabled: true;
    digest: string;
    stoppedRunId: string | null;
  }>;
  /** Deletes a disabled or suspended routing; an enabled one must be disabled first so revocation stops stale work. */
  routingsDelete(input: { routing: string; parentTaskId?: string }): Promise<{
    routingId: string;
    deleted: true;
    digest: string;
    finalHealth: "disabled" | "suspended";
  }>;
  /** Bounded read of the routing receipts journal, optionally scoped to one routing id. */
  routingsReceipts(input: { routing?: string }): Promise<{
    receipts: WorkFoldActRoutingReceipt[];
    truncated: boolean;
    damagedLineCount: number;
  }>;

  /**
   * Publication management verbs (docs/fold-publishing.md, plan item 4).
   * Listing and status are content-bearing act reads over the machine-local
   * grant records; revoke, budget narrowing, and snapshot-off are direct
   * verbs — narrowing never needs a click, and raising a budget or turning
   * snapshot caching on is refused here because widening is a fresh
   * consecration. Revocation is desktop-first: the grant dies before bridge
   * cleanup is attempted, and unconfirmed cleanup is reported honestly.
   */
  pagesList(): Promise<{ publications: WorkFoldActPublicationRef[] }>;
  pagesStatus(input: { publication: string }): Promise<{ publication: WorkFoldActPublicationRef }>;
  pagesRevoke(input: { publication: string; parentTaskId?: string; requestId?: string }): Promise<{
    publication: WorkFoldActPublicationRef;
    /** True when the slot was already revoked: revocation is idempotent and the receipt says so. */
    alreadyRevoked: boolean;
  }>;
  pagesNarrow(input: {
    publication: string;
    serveRatePerMinute?: number;
    byteBudgetPerDay?: number;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    publication: WorkFoldActPublicationRef;
    priorServeRatePerMinute: number;
    priorByteBudgetPerDay: number;
  }>;
  pagesSnapshotOff(input: { publication: string; parentTaskId?: string; requestId?: string }): Promise<{
    publication: WorkFoldActPublicationRef;
    /** False when snapshot caching was already off; the narrowing is still receipted. */
    wasEnabled: boolean;
  }>;

  /**
   * Staged-act inspection and cancellation (docs/fold-consecrations.md).
   * Listing and showing are content-bearing act reads over the machine-local
   * store; cancel is the stager withdrawing a pending card — a terminal
   * transition, refused with the settled state when the act is not pending.
   * Deciding a staged act deliberately has no facade shape, permanently.
   */
  stagedList(): Promise<{ acts: WorkFoldActStagedActSummary[] }>;
  stagedShow(input: { id: string }): Promise<{ act: WorkFoldActStagedActDetail }>;
  stagedCancel(input: { id: string; parentTaskId?: string; requestId?: string }): Promise<{
    act: WorkFoldActStagedActSummary;
  }>;

  /**
   * Experimental Checks act surface. All methods resolve an explicit Space;
   * declarations remain inert until `checksEnable` imports one proposal, and
   * runs remain task-scoped so polling and abort never depend on ambient UI
   * state.
   */
  checksEnable(input: { space: string; proposalPath: string; cwd: string }): Promise<{
    space: WorkFoldActSpaceRef;
    check: {
      id: string;
      title: string;
      severity: WorkFoldCheckFinding["severity"];
      sensorId: string;
      sensorRevision: number;
      targetCount: number;
      trigger: "manual";
      targets: Array<{
        kind: "file" | "tree";
        role: "primary" | "reference";
        path: string;
        recursive?: boolean;
        extensions?: string[];
      }>;
    };
    declarationDigest: string;
  }>;
  checksDisable(input: { space: string; checkId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    checkId: string;
    disabled: boolean;
  }>;
  checksRun(input: { space: string; checkId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    taskId: string;
    runId: string;
    checkIds: string[];
  }>;
  checksTask(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    task: WorkFoldActCheckTaskStatus;
  }>;
  checksResult(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    run: WorkFoldCheckRunRecord;
  }>;
  checksAbort(input: { space: string; taskId: string }): Promise<{
    space: WorkFoldActSpaceRef;
    taskId: string;
    aborted: boolean;
  }>;
  checksProblems(input: { space: string; checkId?: string }): Promise<{
    space: WorkFoldActSpaceRef;
    checkId?: string;
    findings: WorkFoldCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }>;
  checksDecide(input: {
    space: string;
    findingId: string;
    decision: WorkFoldCheckDecisionKind;
    deferUntil?: string;
  }): Promise<{
    space: WorkFoldActSpaceRef;
    findingId: string;
    decision: WorkFoldCheckDecision;
  }>;

  /**
   * Management scope: the conversation above all Spaces. It reuses the same
   * turn orchestration and Pi runtime as Space Chats, but its transcript is
   * machine-local application state, it carries no user Space's project
   * configuration (only work-fold's two app-owned management resources), and
   * its cross-Space hands are these same act commands.
   * Omitting conversationId targets the default (most recent active)
   * management conversation, creating it on first send.
   */
  manageList(): Promise<{ conversations: WorkFoldActConversationRef[] }>;
  manageSend(input: {
    conversationId?: string;
    newConversation?: boolean;
    content: string;
    /** Act-envelope request id reused as the durable Assistant-turn identity. */
    requestId?: string;
    /** Raw --attach values: absolute or cwd-relative paths, or http(s) links. */
    attachments?: string[];
    cwd?: string;
  }): Promise<{
    conversationId: string;
    messageId: string;
    taskId: string;
    attachments: ManagementAttachmentRef[];
  }>;
  manageConversationStatus(input: { conversationId?: string }): Promise<{
    conversation: WorkFoldActConversationRef;
    state: WorkFoldActChatState;
  }>;
  manageTurnStatus(input: { taskId: string }): Promise<{
    task: WorkFoldActTurnStatus;
    request: WorkFoldActManagementRequest | null;
  }>;
  /** Request-level stop: aborts the management turn and every recorded child turn still running. */
  manageStop(input: { taskId: string }): Promise<{
    taskId: string;
    managementAborted: boolean;
    children: Array<{ taskId: string; conversationId: string; spaceId: string; aborted: boolean }>;
  }>;
  manageConversationResult(input: { conversationId?: string; messages?: number }): Promise<{
    conversationId: string;
    state: WorkFoldActChatState;
    total: number;
    lastAssistant: string | null;
    messages: WorkFoldActChatMessage[];
  }>;
  manageTurnResult(input: { taskId: string }): Promise<{
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: WorkFoldActChatMessage;
  }>;
  manageAbort(input: { conversationId?: string }): Promise<{ conversationId: string; aborted: boolean }>;
  /**
   * The glance (docs/fold-glance.md): the kernel's deterministic, management-
   * scoped digest of recorded state — running work, needs-you items, changes,
   * and per-Space Check rows, with the per-surface seen markers included as
   * data. Read-only: the act lane renders markers, it never advances one, and
   * this method deliberately does not require management-conversation
   * readiness — the digest reads recorded state, not the Assistant.
   */
  manageGlance(): Promise<WorkFoldGlanceSnapshot>;
}
