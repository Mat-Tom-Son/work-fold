import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream, existsSync, watch } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  PiConversationClient,
  isPiTurnNotRunningError,
  isPiTurnTimeoutError,
  PiTurnFailure,
  isPiTurnCancelledError,
  type PiChatEvent,
  type PiRuntimeProvider,
} from "./agent/pi-client.js";
import {
  maxDurableTurnTextChars,
  WorkFoldTurnReplayConflictError,
  WorkFoldTurnStore,
  type WorkFoldDurableTurnRecord,
} from "./agent/turn-store.js";
import {
  RoutedPiExtensionUiBridge,
  type PiExtensionUiEvent,
  type PiExtensionUiRequest,
  type PiExtensionUiSettled,
} from "./agent/extension-ui.js";
import {
  appendMessage,
  conversationsDir,
  createConversation,
  findRemoteConversationTitleRename,
  listConversations,
  readConversation,
  readConversationSummary,
  renameConversation,
  setGeneratedConversationTitle,
  updateConversationLifecycle,
  type ChatMessage,
  type ConversationSummary,
} from "./agent/chat-store.js";
import {
  RemoteCapabilityRegistry,
  type CapabilityRegistryService,
  type CapabilitySort,
  type CapabilityType,
} from "./agent/capability-registry.js";
import { importPiSkillBundle, piSkillBundleContentDigest, removePiSkill } from "./agent/skill-import.js";
import {
  RegisteredSpaceRuntimeProvider,
  RegisteredSpaceTrustAuthority,
} from "./agent/registered-space-runtime.js";
import { RestrictedAppError } from "./agent/restricted-app-connections.js";
import {
  RoutedRestrictedAppProposalHost,
  type RestrictedAppProposalReceipt,
  type RestrictedAppProposalSettled,
} from "./agent/restricted-app-proposals.js";
import {
  RestrictedAppService,
  restrictedAppAutomationScheduleSummary,
  type LocalAppInstance,
  type LocalAppOperation,
  type LocalAppRelease,
  type RestrictedAppAutomationRunReceipt,
  type RestrictedAppInstalled,
} from "./agent/restricted-app-service.js";
import type { RestrictedAppNetworkDeclaration } from "./agent/restricted-app-manifest.js";
import {
  getPiSetupStatus,
  installPiPackage,
  isPiProjectMutationTrusted,
  listPiModels,
  listPiPackages,
  loginPiOAuth,
  removePiProviderAuth,
  removePiPackage,
  savePiApiKey,
  setPiDefaultModel,
  updatePiPackages,
  type PiOAuthHooks,
  type PiSetupStatus,
} from "./agent/pi-runtime-config.js";
import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment } from "./conversation-context.js";
import {
  classifyManagementAttachments,
  loadManagementAttachmentsForTurn,
  managementAttachmentLinks,
  maxManagementAttachments,
  type ManagementAttachmentRef,
} from "./management-attachments.js";
import {
  ManagementRequestRegistry,
  managementAttachmentDispositions,
  type ManagementRequestAction,
  type ManagementRequestActionCommand,
  type ManagementRequestRecord,
} from "./management-requests.js";
import type {
  WorkFoldRemoteFacade,
  WorkFoldRemoteOperation,
  WorkFoldRemotePrincipal,
  WorkFoldRemoteWatchProgress,
  WorkFoldRemoteTreeResult,
} from "./remote-management.js";
import {
  createSpaceCheckpoint,
  createSpaceMutationCheckpoint,
  discardSpaceCheckpoint,
  getSpaceCheckpoint,
  listFileVersions,
  listSpaceCheckpoints,
  restoreFileVersion,
  restoreSpaceCheckpoint,
  type CheckpointSkippedFile,
  type SpaceCheckpoint,
  type SpaceFileVersion,
} from "./history.js";
import {
  copyResourcesToSpace,
  createResourceFolder,
  listResourceTree,
  uploadResourceFiles,
} from "./resources.js";
import { searchSpace } from "./search.js";
import { SpaceAppearanceStore } from "./space-appearance-store.js";
import { conversationTitleFromFirstUserMessage, normalizeConversationTitle } from "../shared/chat-title.js";
import {
  hasSpaceAppearanceCustomization,
  parseSpaceAppearanceProposal,
  spaceAppearanceBannerNames,
  type SpaceAppearanceCustomization,
  type SpaceAppearanceProposal,
} from "../shared/space-appearance.js";
import type { AppReleasePresentation } from "./agent/app-platform-release.js";
import { WorkFoldCheckOperationConflictError, WorkFoldCheckService } from "./checks/check-service.js";
import type { WorkFoldCheckDecisionKind } from "./checks/check-types.js";
import { purgeWorkFoldCheckState } from "./checks/check-store.js";
import { resolveWorkFoldCheckTargets } from "./checks/target-resolver.js";
import {
  FoldDecisionError,
  FoldDecisionService,
  createManagedSpaceDeletionAdapter,
  createRestrictedAppAutomationEnableAdapter,
  createRestrictedAppGrantAdapter,
  createRestrictedAppReviewApproveAdapter,
  createSkillImportAdapter,
  foldDecisionRequestId,
  foldDecisionSurfaceRestrictions,
  type FoldDecisionAdapters,
  type FoldDecisionFenceScope,
  type FoldDecisionMutationFence,
  type FoldDecisionReceiptsWriter,
  type FoldStagedActKindAdapter,
} from "./fold-decisions.js";
import { foldDecisionCard, type FoldDecisionCard } from "./fold-decision-cards.js";
import {
  FOLD_POLICY_CAP,
  FOLD_POLICY_ELIGIBLE_KINDS,
  FOLD_POLICY_FIRST_PARTY_REGISTRIES,
  FOLD_POLICY_LABEL_MAX_CHARS,
  FOLD_POLICY_MATCHER_DESCRIPTORS,
  FoldPolicyError,
  FoldStandingPolicyStore,
  mintFoldPolicySettingsWriter,
  type FoldPolicyCategory,
  type FoldPolicyEligibleKind,
  type FoldPolicyEvaluation,
  type FoldPolicyMatch,
  type FoldPolicySettingsWriter,
} from "./fold-policies.js";
import {
  FoldStagedActError,
  FoldStagedActStore,
  foldStagedActCategory,
  type FoldStagedAct,
  type FoldStagedActAdmission,
  type FoldStagedActFields,
  type FoldStagedActKind,
  type FoldStagedActProvenance,
} from "./fold-staged-acts.js";
import {
  createWorkFoldGlancePolicyChangeReader,
  createWorkFoldGlanceRoutingRunReader,
  parseWorkFoldGlanceCursor,
  workFoldGlanceChatRecordFromMessages,
  type WorkFoldGlanceAutomationReceiptRecord,
  type WorkFoldGlanceAutomationRunRecord,
  type WorkFoldGlanceCheckSource,
  type WorkFoldGlanceManagementRequestRecord,
  type WorkFoldGlanceSettledTurnRecord,
  type WorkFoldGlanceSourceReaders,
  type WorkFoldGlanceStagedActRecord,
  type WorkFoldGlanceViewerGrantEventRecord,
} from "./glance.js";
import { WorkFoldGlanceSeenStore, workFoldGlanceRemoteSurfaceId } from "./glance-seen-store.js";
import { ensureManagementInstructions } from "./management-instructions.js";
import {
  WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
  WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES,
  WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
  WORKFOLD_PUBLICATION_SOURCE_TYPES,
  WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH,
  WorkFoldPublicationError,
  WorkFoldPublicationService,
  type WorkFoldPublicationBridgeSync,
  type WorkFoldPublicationKeyStore,
  type WorkFoldPublicationView,
} from "./publications.js";
import {
  createRestrictedAppViewerAdapter,
  type RestrictedAppViewerAdapter,
} from "./agent/restricted-app-viewer.js";
import {
  declarationFromWorkFoldRoutingProposal,
  normalizeWorkFoldRoutingDeclaration,
  normalizeWorkFoldRoutingProposal,
  workFoldRoutingBounds,
  workFoldRoutingDeclarationKind,
  workFoldRoutingDigest,
  workFoldRoutingProposalKind,
  workFoldRoutingReferencedSpaceIds,
  type WorkFoldRoutingDeclaration,
  type WorkFoldRoutingFilesStep,
} from "./routings/routing-declarations.js";
import {
  WorkFoldRoutingService,
  WorkFoldRoutingServiceError,
  type WorkFoldRoutingHopPorts,
} from "./routings/routing-service.js";
import {
  WorkFoldRoutingStore,
  WorkFoldRoutingStoreError,
  workFoldRoutingReceiptsFile,
  workFoldRoutingReceiptsRotatedFile,
  type WorkFoldRoutingRecord,
} from "./routings/routing-store.js";
import { WorkFoldSettleSignal } from "./routings/settle-signal.js";
import {
  configureWorkFoldStateRoot,
  restrictedAppRoot,
  workFoldManagementRoot,
  workFoldManagementScopeId,
  workFoldStateRoot,
} from "./state-paths.js";
import { WorkFoldKernel } from "./work-fold-kernel.js";
import { WorkFoldCliActReceipts, type WorkFoldCliActReceipt } from "./cli/act-receipts.js";
import { WorkFoldCliError } from "./cli/protocol.js";
import type {
  WorkFoldActAppAutomationRunRef,
  WorkFoldActAppInstanceRef,
  WorkFoldActAppOperationRef,
  WorkFoldActAppPresentation,
  WorkFoldActAppProposalRef,
  WorkFoldActAppReleaseRef,
  WorkFoldActAttachmentDisposition,
  WorkFoldActChatLifecycleState,
  WorkFoldActChatMessage,
  WorkFoldActChatState,
  WorkFoldActCheckpointSummary,
  WorkFoldActConversationRef,
  WorkFoldActFacade,
  WorkFoldActFileVersionRef,
  WorkFoldActLibraryItem,
  WorkFoldActManagementRequest,
  WorkFoldActManagementRequestPhase,
  WorkFoldActPublicationRef,
  WorkFoldActRoutingDetail,
  WorkFoldActRoutingReceipt,
  WorkFoldActRoutingStepView,
  WorkFoldActRoutingSummary,
  WorkFoldActRoutingTriggerRef,
  WorkFoldActSpaceRef,
  WorkFoldActStagedActDetail,
  WorkFoldActStagedActSummary,
  WorkFoldActStagedAutoApproval,
  WorkFoldActStagedDecision,
  WorkFoldActTurnStatus,
} from "./cli/act-facade.js";
import { resolveWorkFoldCliSpaceSelector } from "./work-fold-cli-adapter.js";
import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
} from "./server-dev-options.js";
import { isAlwaysHiddenSpaceEntry, isSpaceIgnored, readSpaceIgnoreState, setSpaceIgnoreState } from "./space-ignore.js";
import { containsReservedSpacePathSegment } from "./space-path-policy.js";
import { canonicalSpaceWatchRoot } from "./space-watch.js";
import {
  beginSpaceRemoval,
  copyPathIntoSpace,
  createManagedSpace,
  createSpaceFolder,
  createSpaceTextFile,
  deleteSpaceEntry,
  finalizeSpaceRemoval,
  findExistingSpaceFilePaths,
  getSpace,
  getSpaceEntryInfo,
  getSpaceFilePreview,
  listSpaces,
  listPendingSpaceRemovals,
  markSpaceRemovalAppStateRemoved,
  moveSpaceEntry,
  readSpaceTextFile,
  renameSpaceEntry,
  registerLinkedSpace,
  renameSpace,
  resolveSpacePath,
  scanSpaceTree,
  spaceRemovalPendingResult,
  writeSpaceTextFile,
  writeUploadedFiles,
  type SpaceRemovalIo,
  type SpaceRemovalResult,
  type SpaceSummary,
  type TreeEntry,
} from "./space.js";

export interface LocalFolderGrantProvider {
  consumeLocalFolderGrant(input: { spaceRoot: string; grantId: string }): boolean | Promise<boolean>;
}

export interface LocalApiOptions {
  host?: "127.0.0.1";
  port?: number;
  appMode?: "dev" | "desktop";
  /** Root used only for managed space content. */
  spaceBase?: string;
  /** work-fold app data: registry, chats, Pi sessions, resources, history. */
  stateBase?: string;
  allowedOrigins?: string[];
  sessionToken?: string;
  piRuntimeProvider?: PiRuntimeProvider;
  extensionUiBridge?: RoutedPiExtensionUiBridge;
  piOAuthHooks?: PiOAuthHooks;
  capabilityRegistry?: CapabilityRegistryService;
  /** Separate from Pi packages: reviewed, staged apps that execute only in the desktop sandbox host. */
  restrictedAppService?: RestrictedAppService;
  restrictedAppProposalHost?: RoutedRestrictedAppProposalHost;
  /** Machine-local Space appearance state, shared by the renderer and test harnesses. */
  appearanceStore?: SpaceAppearanceStore;
  /** A supplied kernel must use a provider wrapped by the same spaceTrustAuthority. */
  kernel?: WorkFoldKernel;
  /** Shared with the desktop read CLI and interactive act facade. */
  checkService?: WorkFoldCheckService;
  /**
   * The one in-process settle seam between the Check and restricted-app
   * settlement funnels and the routing executor. Supply the same instance to
   * an injected checkService/restrictedAppService so their settles reach
   * routing triggers; when absent, the API creates one for the services it
   * constructs itself.
   */
  settleSignal?: WorkFoldSettleSignal;
  /**
   * The act lane's durable receipts journal (the fold's one ledger). Supply
   * the desktop CLI host's instance so decisions, publications, and CLI acts
   * share one file and one at-most-once gate; when absent, the API constructs
   * one over the same state-root path the host uses.
   */
  actReceipts?: WorkFoldCliActReceipts;
  /** Test seam for the machine-local durable Assistant-turn journal. */
  turnStore?: WorkFoldTurnStore;
  /** Test seam for the staged-act store; defaults to the state-root store. */
  foldStagedActStore?: FoldStagedActStore;
  /** Test seam for the standing-policy store; defaults to the state-root store. */
  foldPolicyStore?: FoldStandingPolicyStore;
  /**
   * Publication page keys. The desktop passes the operating-system-encrypted
   * secure-settings store (`desktop/src/settings.ts`); without one, keys live
   * only in memory for this app run — honest for development, never for a
   * shipped desktop.
   */
  publicationKeys?: WorkFoldPublicationKeyStore;
  /** The bridge slot-sync lane; absent while Remote access is unconfigured. */
  publicationBridge?: WorkFoldPublicationBridgeSync | null;
  /** Shared with the desktop kernel so registry trust changes apply everywhere. */
  spaceTrustAuthority?: RegisteredSpaceTrustAuthority;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  /** Failure-injection seam for the durable Space-removal coordinator. */
  spaceRemovalIo?: Partial<SpaceRemovalIo>;
  /** Failure-injection seam that runs immediately before mandatory post-reservation Space validation. */
  beforeRestrictedAppSpaceRevalidation?: (spaceId: string) => Promise<void>;
  maxBodyBytes?: number;
  loadEnv?: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  /** Failure-injection seam immediately before a Pi prompt starts. */
  beforeAgentPrompt?: (event: { spaceId: string; conversationId: string; taskId: string }) => Promise<void>;
  /** Failure-injection seam after child acceptance but before parent attribution. */
  beforeManagementActionRecord?: (event: { parentTaskId: string; command: "chat.send"; taskId: string }) => Promise<void>;
  onHistoryCheckpoint?: (event: {
    spaceId: string;
    conversationId: string;
    reason: "pre_turn" | "post_turn";
    checkpointId: string;
    skippedLargeFiles: string[];
  }) => void;
}

export interface LocalApiHandle {
  origin: string;
  port: number;
  kernel: WorkFoldKernel;
  /** In-process authority for CLI act-lane commands; see cli/act-facade.ts. */
  actFacade: WorkFoldActFacade;
  /** Narrow Internet-facing semantic adapter. It never exposes the local HTTP session. */
  remoteFacade: WorkFoldRemoteFacade;
  /** Validates an explicitly named management parent while its turn is active. */
  resolveManagementLineageParent: (taskId: string) => { taskId: string } | null;
  /** Staged consecrations awaiting a person's decision (docs/fold-consecrations.md). */
  stagedActs: FoldStagedActStore;
  /**
   * The person-authored standing policies (docs/fold-consecrations.md
   * §Standing policies). Reading and citing is open; every mutation demands
   * the Settings writer, which is minted once inside the API and handed only
   * to the renderer-session Settings routes — never to this handle, the act
   * facade, or the remote facade.
   */
  foldPolicies: FoldStandingPolicyStore;
  /**
   * The consecration decision path, for the desktop renderer/popover session
   * routes and the approved remote browser's signed envelope. Deliberately
   * not an act-lane verb; the act facade never reaches it.
   */
  foldDecisions: FoldDecisionService;
  /** The routing executor (docs/fold-routings.md), for the desktop surfaces and lifecycle wiring. */
  routings: WorkFoldRoutingService;
  /** The publication authority (docs/fold-publishing.md rung 2); the desktop wires it as the remote viewer-page provider. */
  publications: WorkFoldPublicationService;
  close: () => Promise<void>;
}

interface LocalApiState {
  appMode: "dev" | "desktop";
  spaceBase?: string;
  allowedOrigins: string[];
  sessionToken?: string;
  maxBodyBytes: number;
  runtimeProvider: PiRuntimeProvider;
  extensionUi: RoutedPiExtensionUiBridge;
  piOAuthHooks?: PiOAuthHooks;
  capabilityRegistry: CapabilityRegistryService;
  restrictedApps: RestrictedAppService;
  restrictedAppProposals: RoutedRestrictedAppProposalHost;
  appearance: SpaceAppearanceStore;
  kernel: WorkFoldKernel;
  checks: WorkFoldCheckService;
  settleSignal: WorkFoldSettleSignal;
  actReceipts: WorkFoldCliActReceipts;
  turnStore: WorkFoldTurnStore;
  stagedActs: FoldStagedActStore;
  /**
   * Exactly one standing-policy store and exactly one minted Settings writer
   * per API. The writer exists so policy authoring is structurally a
   * desktop-Settings act (never-list entry 4): only the renderer-session
   * Settings routes pass it to the store, the act facade and remote facade
   * have no policy mutation surface at all, and the fold can cite policies
   * through reads that need no writer.
   */
  foldPolicies: FoldStandingPolicyStore;
  foldPolicyWriter: FoldPolicySettingsWriter;
  /**
   * Label snapshots for in-flight policy exercises, keyed by staged-act id:
   * registered immediately before the host-side decision runs so the decision
   * receipts can carry the exercised policy's label exactly as it read at
   * exercise time, and removed when the exercise settles.
   */
  policyLabelSnapshots: Map<string, string>;
  publications: WorkFoldPublicationService;
  /**
   * The rung-3 viewer adapter: exposure resolution for staging and decision
   * recheck, and the viewer-safe serve path the publication service drives.
   */
  restrictedAppViewer: RestrictedAppViewerAdapter;
  /**
   * Person-chosen Space-relative roots for pending `app.grant.files`
   * decisions, keyed by staged-act id: registered by the renderer decide
   * route immediately before the host-side decision runs and removed when it
   * settles. The staged card pins the reviewed declaration only; the root is
   * the decision-time supplement the desktop folder picker supplies
   * (docs/fold-consecrations.md), so the grant adapter's resolver reads it
   * here and an approval that carries none stays honestly ineligible.
   */
  fileGrantRootChoices: Map<string, string>;
  /**
   * The same key store the publication service encrypts with, held so the
   * renderer-session Settings routes can compose a share link on demand
   * (docs/fold-publishing.md: the link is composed from secure settings and
   * shown transiently; it appears in no receipt, journal, log, or glance
   * item). Only the reveal route reads it; nothing else on this state may.
   */
  publicationKeys: WorkFoldPublicationKeyStore;
  glanceSeen: WorkFoldGlanceSeenStore;
  /**
   * Constructed in a second phase after the state object exists, because the
   * decision fence, adapters, and routing hop ports close over this state.
   * Both are assigned before the server accepts a request.
   */
  foldDecisions: FoldDecisionService;
  routings: WorkFoldRoutingService;
  spaceTrustAuthority: RegisteredSpaceTrustAuthority;
  managementInstructionsError: string | null;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  spaceRemovalIo: Partial<SpaceRemovalIo>;
  beforeRestrictedAppSpaceRevalidation?: (spaceId: string) => Promise<void>;
  managementRequests: ManagementRequestRegistry;
  chatStreams: Map<string, Set<ServerResponse>>;
  /** In-process subscribers riding the same publish point as the SSE streams (remote watch). */
  chatEventListeners: Map<string, Set<(event: unknown) => void>>;
  chatEventLogs: Map<string, ChatEventLog>;
  activeTurnIdsByKey: Map<string, string>;
  /** Mid-turn steering messages already appended, keyed by client key + request id, for idempotent retries. */
  steeredMessages: Map<string, ChatMessage>;
  turnCheckpointTimers: Map<string, NodeJS.Timeout>;
  clients: Map<string, PiConversationClient>;
  runningTurns: Set<string>;
  activeTurnPromises: Set<Promise<void>>;
  activeTurnTasks: Map<string, { spaceId: string; conversationId: string }>;
  cancelledTurnTasks: Set<string>;
  settledTurns: Map<string, SettledTurnRecord>;
  compactingConversations: Set<string>;
  capabilityMutations: Set<string>;
  checkRunReservations: Set<string>;
  spaceIdsByRoot: Map<string, string>;
  extensionRequests: Map<string, PiExtensionUiRequest>;
  fileStreams: Set<() => void>;
  /** In-process observers of turn-boundary History checkpoints (routing chat hops). */
  turnCheckpointListeners: Set<(event: TurnCheckpointEvent) => void>;
  activeTurns: number;
  acceptingTurns: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  beforeAgentPrompt?: LocalApiOptions["beforeAgentPrompt"];
  beforeManagementActionRecord?: LocalApiOptions["beforeManagementActionRecord"];
  onHistoryCheckpoint?: LocalApiOptions["onHistoryCheckpoint"];
}

/**
 * Terminal outcome of one accepted Assistant turn, kept (bounded, in memory)
 * so the CLI act lane's task-scoped wait/result can distinguish this turn's
 * outcome from whatever happens to be the newest transcript message. Records
 * live for the app run; the portable transcript remains the durable record.
 */
interface SettledTurnRecord {
  taskId: string;
  spaceId: string;
  conversationId: string;
  status: "succeeded" | "failed" | "aborted";
  endedAt: string;
  messageId?: string;
  error?: string;
}

interface ChatEventLogEntry {
  id: number;
  data: unknown;
  bytes: number;
}

interface ChatEventLog {
  nextId: number;
  events: ChatEventLogEntry[];
  bytes: number;
  assistantText: string;
}

interface TurnCheckpointEvent {
  spaceId: string;
  conversationId: string;
  reason: "pre_turn" | "post_turn";
  checkpointId: string;
}

interface MultipartFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

interface MultipartBody {
  fields: Map<string, string>;
  files: MultipartFile[];
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function startLocalApi(options: LocalApiOptions = {}): Promise<LocalApiHandle> {
  if (options.loadEnv !== false) loadLocalEnvironmentFile(join(repoRoot, ".env"));
  const appMode = options.appMode ?? "dev";
  const developmentDefaults = appMode === "dev"
    && (options.stateBase === undefined || options.port === undefined)
    ? createLocalDevelopmentApiOptions()
    : null;
  configureWorkFoldStateRoot(options.stateBase ?? developmentDefaults?.stateBase);
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? developmentDefaults?.port ?? numberFromEnv("WORKFOLD_LOCAL_API_PORT", 4327);
  const extensionUi = options.extensionUiBridge ?? new RoutedPiExtensionUiBridge();
  const extensionRuntimeProvider: PiRuntimeProvider = {
    async resolveRuntime(spaceRoot) {
      const runtime = await options.piRuntimeProvider?.resolveRuntime(spaceRoot) ?? {};
      return {
        ...runtime,
        extensionUi,
      };
    },
  };
  const restrictedApps = options.restrictedAppService ?? await RestrictedAppService.create({
    rootPath: restrictedAppRoot(),
    deferAutomationStart: true,
  });
  if (options.restrictedAppService?.automationsStarted) {
    throw new Error(
      "The Local API requires an injected restricted App service whose automation startup is still deferred.",
    );
  }
  const restrictedAppProposals = options.restrictedAppProposalHost ?? await RoutedRestrictedAppProposalHost.create({
    service: restrictedApps,
    registryPath: join(restrictedAppRoot(), "proposals.json"),
  });
  const recoveredRemovals = await recoverPendingSpaceRemovals(
    restrictedApps,
    restrictedAppProposals,
    options.spaceRemovalIo ?? {},
  );
  const recoveredSpaceRoots = recoveredRemovals.spaceRoots;
  const pendingSpaceIds = (await listPendingSpaceRemovals()).map((intent) => intent.spaceId);
  const appearance = options.appearanceStore ?? await SpaceAppearanceStore.create({
    normalize: { allowedBannerNames: new Set(spaceAppearanceBannerNames) },
  });
  const spaceTrustAuthority = options.spaceTrustAuthority
    ?? new RegisteredSpaceTrustAuthority((await listSpaces()).map((space) => space.spaceRoot));
  for (const rootPath of recoveredSpaceRoots) spaceTrustAuthority.revoke(rootPath);
  // The management scope's root is app-owned state, so authorizing its
  // runtime is an application decision rather than a registration ceremony.
  // The only project configuration under it is what work-fold itself
  // materializes here: the management AGENTS.md context file and the
  // manage-spaces Skill.
  spaceTrustAuthority.grant(workFoldManagementRoot());
  let managementInstructionsError: string | null = null;
  try {
    await ensureManagementInstructions();
  } catch (error) {
    managementInstructionsError = errorMessage(error);
    console.warn(`work-fold could not materialize the management instructions; the management conversation is unavailable: ${managementInstructionsError}`);
  }
  await pruneRemoteManagementUploads(workFoldManagementRoot()).catch((error) => {
    console.warn(`work-fold could not prune expired remote uploads at startup: ${errorMessage(error)}`);
  });
  const runtimeProvider = new RegisteredSpaceRuntimeProvider(extensionRuntimeProvider, spaceTrustAuthority);
  const kernel = options.kernel ?? new WorkFoldKernel({ runtimeProvider });
  const settleSignal = options.settleSignal ?? new WorkFoldSettleSignal();
  const checks = options.checkService ?? new WorkFoldCheckService({ kernel, settleSignal });
  // The fold's one ledger: the same act-receipts journal the desktop CLI host
  // appends. Both instances write the identical state-root path, so decisions
  // and publications land in the journal the act lane already audits.
  const actReceipts = options.actReceipts ?? new WorkFoldCliActReceipts({ stateRoot: workFoldStateRoot() });
  const turnStore = options.turnStore ?? await WorkFoldTurnStore.create({ stateRoot: workFoldStateRoot() });
  const stagedActs = options.foldStagedActStore ?? await FoldStagedActStore.create();
  const foldPolicies = options.foldPolicyStore ?? await FoldStandingPolicyStore.create();
  const routingStore = await WorkFoldRoutingStore.create();
  const publicationKeys = options.publicationKeys ?? createEphemeralPublicationKeyStore();
  // The rung-3 viewer adapter (docs/fold-publishing.md): the viewer-safe
  // broker subset enforced desktop-side over the same installed-instance
  // authority the sandboxed host uses. Storage reads are the service's
  // bounded read lane; without desktop storage, data reads refuse honestly
  // while reviewed assets keep serving.
  const restrictedAppViewer = createRestrictedAppViewerAdapter({
    resolveInstance: async (appInstanceId) => (await restrictedApps.findByFeatureInstallationAnywhere(appInstanceId)) ?? null,
    storage: restrictedApps.viewerStorageReads() ?? {
      keys: async () => {
        throw new Error("Restricted app storage requires the work-fold desktop host.");
      },
      get: async () => {
        throw new Error("Restricted app storage requires the work-fold desktop host.");
      },
    },
  });
  const publications = await WorkFoldPublicationService.create({
    keys: publicationKeys,
    receipts: actReceipts,
    resolveSpaceRoot: async (spaceId) => {
      try {
        return (await getSpace(spaceId)).spaceRoot;
      } catch {
        return null;
      }
    },
    bridge: options.publicationBridge ?? null,
    apps: restrictedAppViewer,
  });
  const glanceSeen = new WorkFoldGlanceSeenStore();
  const state: LocalApiState = {
    appMode,
    spaceBase: options.spaceBase ? resolve(options.spaceBase) : undefined,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"],
    sessionToken: options.sessionToken,
    maxBodyBytes: options.maxBodyBytes ?? numberFromEnv("WORKFOLD_LOCAL_MAX_BODY_BYTES", 100 * 1024 * 1024),
    runtimeProvider,
    extensionUi,
    piOAuthHooks: options.piOAuthHooks,
    capabilityRegistry: options.capabilityRegistry ?? new RemoteCapabilityRegistry(),
    restrictedApps,
    restrictedAppProposals,
    appearance,
    kernel,
    checks,
    settleSignal,
    actReceipts,
    turnStore,
    stagedActs,
    foldPolicies,
    foldPolicyWriter: mintFoldPolicySettingsWriter(),
    policyLabelSnapshots: new Map(),
    publications,
    restrictedAppViewer,
    fileGrantRootChoices: new Map(),
    publicationKeys,
    glanceSeen,
    // Assigned in the second construction phase below, before the server
    // listens; their fences and hop ports close over this state object.
    foldDecisions: undefined as unknown as FoldDecisionService,
    routings: undefined as unknown as WorkFoldRoutingService,
    spaceTrustAuthority,
    managementInstructionsError,
    localFolderGrantProvider: options.localFolderGrantProvider,
    spaceRemovalIo: options.spaceRemovalIo ?? {},
    beforeRestrictedAppSpaceRevalidation: options.beforeRestrictedAppSpaceRevalidation,
    managementRequests: new ManagementRequestRegistry(),
    chatStreams: new Map(),
    chatEventListeners: new Map(),
    chatEventLogs: new Map(),
    activeTurnIdsByKey: new Map(),
    steeredMessages: new Map(),
    turnCheckpointTimers: new Map(),
    clients: new Map(),
    runningTurns: new Set(),
    activeTurnPromises: new Set(),
    activeTurnTasks: new Map(),
    cancelledTurnTasks: new Set(),
    settledTurns: new Map(),
    compactingConversations: new Set(),
    capabilityMutations: new Set(),
    checkRunReservations: new Set(),
    spaceIdsByRoot: new Map(),
    extensionRequests: new Map(),
    fileStreams: new Set(),
    turnCheckpointListeners: new Set(),
    activeTurns: 0,
    acceptingTurns: true,
    onAgentTurnActivity: options.onAgentTurnActivity,
    beforeAgentPrompt: options.beforeAgentPrompt,
    beforeManagementActionRecord: options.beforeManagementActionRecord,
    onHistoryCheckpoint: options.onHistoryCheckpoint,
  };

  // Second construction phase: the decision path and the routing executor
  // close over the shared state (capability-mutation fences, live route
  // internals), so they are built once it exists and before the server
  // listens.
  state.foldDecisions = new FoldDecisionService({
    store: stagedActs,
    receipts: createPolicyLabelAwareDecisionReceipts(state),
    kernel,
    fence: createFoldDecisionFence(state),
    adapters: createFoldDecisionAdapters(state),
  });
  state.routings = await WorkFoldRoutingService.create({
    store: routingStore,
    ports: createRoutingHopPorts(state),
    settleSignal,
    tasks: {
      start: ({ routingId, runId }) =>
        kernel.startExperimentalRoutingRunTask({ routingId, runId, actor: { kind: "system" } }),
      finish: (taskId) => {
        kernel.finishTask(taskId);
      },
    },
  });
  // Space removals that finalized (or remain pending) while the app was not
  // running still revoke standing authority: suspend routings referencing the
  // removed Spaces and cancel their pending staged cards, best-effort — both
  // stores already fail closed on damage.
  for (const spaceId of new Set([...recoveredRemovals.spaceIds, ...pendingSpaceIds])) {
    await state.routings.handleSpaceRemoved(spaceId).catch(() => undefined);
    await stagedActs.cancelForSpace(spaceId).catch(() => undefined);
  }
  // Complete interrupted publication work (key mints, bridge slot syncs);
  // with no bridge configured everything stays honestly pending.
  await publications.redriveBridgeSync().catch(() => undefined);
  kernel.configureGlance({
    sources: createServerGlanceSources(state),
    readSeen: () => glanceSeen.seenCursors(),
  });
  // History-restore fence readers (docs/fold-act-ledger.md, conflict rule 7):
  // the kernel's routing_run tasks come from this API's own task port, and
  // this reader resolves each active run's declared files-hop targets from
  // the routing store. The restricted-app half reads the registry's durable
  // accepted-run ledger through the machine-wide accessor; a run whose
  // file-grant authority cannot be resolved (fileGrantIds null) blocks too —
  // vanished authority must never read as none while the run is live.
  kernel.configureHistoryRestoreFence({
    sources: {
      routingRunFilesHopTargets: async (routingId) => {
        const routing = await state.routings.getRouting(routingId);
        if (!routing) return null;
        return routing.declaration.steps
          .filter((step): step is WorkFoldRoutingFilesStep => step.kind === "files")
          .map((step) => step.toSpace);
      },
      automationRunsWithFileGrantInto: async (spaceId) =>
        (await state.restrictedApps.listActiveAutomationRuns())
          .filter((run) => run.spaceId === spaceId && (run.fileGrantIds === null || run.fileGrantIds.length > 0))
          .map((run) => ({ appId: run.appId, automationId: run.automationId, runId: run.runId })),
    },
  });
  await recoverDurableTurnState(state);

  const requestListener = (request: PiExtensionUiRequest) => routeExtensionRequest(state, request);
  const eventListener = (event: PiExtensionUiEvent) => routeExtensionEvent(state, event);
  const settledListener = (event: PiExtensionUiSettled) => state.extensionRequests.delete(event.id);
  const proposalListener = (proposal: RestrictedAppProposalReceipt) => routeRestrictedAppProposal(state, proposal);
  const proposalSettledListener = (event: RestrictedAppProposalSettled) => routeRestrictedAppProposalSettled(state, event.proposal);

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(state, request, response);
    } catch (error) {
      sendError(response, error);
    }
  });
  await listen(server, requestedPort, host);
  const remoteUploadPruneTimer = setInterval(() => {
    void pruneRemoteManagementUploads(workFoldManagementRoot()).catch((error) => {
      console.warn(`work-fold could not prune expired remote uploads: ${errorMessage(error)}`);
    });
  }, 60 * 60 * 1_000);
  remoteUploadPruneTimer.unref();
  try {
    restrictedApps.startAutomations(pendingSpaceIds);
  } catch (error) {
    clearInterval(remoteUploadPruneTimer);
    await closeServer(server).catch(() => undefined);
    throw error;
  }
  extensionUi.on("request", requestListener);
  extensionUi.on("event", eventListener);
  extensionUi.on("settled", settledListener);
  restrictedAppProposals.on("request", proposalListener);
  restrictedAppProposals.on("settled", proposalSettledListener);
  const address = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${address.port}`,
    port: address.port,
    kernel,
    actFacade: createWorkFoldActFacade(state),
    remoteFacade: createWorkFoldRemoteFacade(state),
    resolveManagementLineageParent: (taskId) => state.managementRequests.isActive(taskId) ? { taskId } : null,
    stagedActs,
    foldPolicies,
    foldDecisions: state.foldDecisions,
    routings: state.routings,
    publications,
    close: async () => {
      state.acceptingTurns = false;
      clearInterval(remoteUploadPruneTimer);
      extensionUi.off("request", requestListener);
      extensionUi.off("event", eventListener);
      extensionUi.off("settled", settledListener);
      restrictedAppProposals.off("request", proposalListener);
      restrictedAppProposals.off("settled", proposalSettledListener);
      extensionUi.cancelAll();
      // Stop the routing executor first: it aborts active runs (they settle
      // with honest interrupted/stopped receipts through their own domains),
      // and the drained turn promises below carry any aborted chat hops to
      // their settled records.
      state.routings.close();
      for (const streams of state.chatStreams.values()) for (const response of streams) response.end();
      for (const close of [...state.fileStreams]) close();
      await Promise.allSettled([...state.clients.values()].map((client) => client.stop()));
      await Promise.allSettled([...state.activeTurnPromises]);
      await flushAllTurnCheckpoints(state);
      await state.turnStore.flush();
      await state.checks.close();
      await state.appearance.flush();
      await state.restrictedApps.close();
      await closeServer(server);
    },
  };
}

async function handleRequest(state: LocalApiState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(state, req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  authorize(state, req);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(res, { ok: true, app: "work-fold", mode: state.appMode });
    return;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const spaces = (await state.kernel.getSpaces({ kind: "renderer" })).spaces;
    const agent = spaces[0] ? await safeAgentStatus(spaces[0].spaceRoot, state.runtimeProvider) : emptyAgentStatus();
    sendJson(res, { spaces, agent, appearance: state.appearance.snapshot() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/appearance") {
    sendJson(res, { appearance: state.appearance.snapshot() });
    return;
  }

  const checksStatusMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/status$/);
  if (checksStatusMatch && method === "GET") {
    const space = await getSpace(checksStatusMatch[1]);
    sendJson(res, { status: await state.checks.status(space) });
    return;
  }

  const checksDecorationsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/decorations$/);
  if (checksDecorationsMatch && method === "GET") {
    const space = await getSpace(checksDecorationsMatch[1]);
    sendJson(res, { decorations: await state.checks.decorations(space) });
    return;
  }

  const checksOverviewMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/overview$/);
  if (checksOverviewMatch && method === "POST") {
    const space = await getSpace(checksOverviewMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const overview = await runReservedCheckOperation(
      state,
      space.id,
      () => state.checks.overview(space),
    );
    sendJson(res, { overview });
    return;
  }

  const checksRunMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/run$/);
  if (checksRunMatch && method === "POST") {
    const space = await getSpace(checksRunMatch[1]);
    const body = await readJsonBody<{ checkId?: string }>(state, req);
    if (body.checkId !== undefined && typeof body.checkId !== "string") throw badRequest("Check id must be a string.");
    const checkId = body.checkId?.trim();
    const accepted = await runReservedCheckOperation(state, space.id, () => state.checks.run({
      space: space,
      ...(checkId ? { checkId } : {}),
      actor: { kind: "renderer", cwd: space.spaceRoot, spaceId: space.id },
    }));
    sendJson(res, { task: accepted }, 202);
    return;
  }

  const checksTaskMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/tasks\/([^/]+)$/);
  if (checksTaskMatch && method === "GET") {
    const space = await getSpace(checksTaskMatch[1]);
    sendJson(res, { task: await state.checks.taskStatus(space.id, checksTaskMatch[2]) });
    return;
  }

  const checksAbortMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/tasks\/([^/]+)\/abort$/);
  if (checksAbortMatch && method === "POST") {
    const space = await getSpace(checksAbortMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const aborted = await runReservedCheckOperation(
      state,
      space.id,
      () => state.checks.abort(space.id, checksAbortMatch[2]),
    );
    sendJson(res, { taskId: checksAbortMatch[2], aborted });
    return;
  }

  const checksDecisionMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/checks\/findings\/([^/]+)\/decision$/);
  if (checksDecisionMatch && method === "POST") {
    const space = await getSpace(checksDecisionMatch[1]);
    const body = await readJsonBody<{ decision?: WorkFoldCheckDecisionKind; deferUntil?: string }>(state, req);
    const decisionKind = body.decision;
    if (!isWorkFoldCheckDecisionKind(decisionKind)) throw badRequest("Choose a valid Check decision.");
    if (body.deferUntil !== undefined && typeof body.deferUntil !== "string") throw badRequest("Check deferUntil must be a timestamp.");
    const decision = await runReservedCheckOperation(state, space.id, () => state.checks.decide({
      spaceId: space.id,
      findingId: checksDecisionMatch[2],
      decision: decisionKind,
      actor: "renderer",
      ...(body.deferUntil ? { deferUntil: body.deferUntil } : {}),
    }));
    sendJson(res, { findingId: checksDecisionMatch[2], decision });
    return;
  }

  if (method === "POST" && url.pathname === "/api/spaces") {
    const body = await readJsonBody<{ name?: string }>(state, req);
    const space = await runCheckSpaceRegistryMutation(
      state,
      () => createSpaceInternal(state, body.name ?? "Personal Space"),
    );
    sendJson(res, { space }, 201);
    return;
  }

  if (method === "POST" && url.pathname === "/api/spaces/local-folder") {
  const body = await readJsonBody<{ spaceRoot?: string; folderGrantId?: string; providerHint?: "google-drive" }>(state, req);
    if (!body.spaceRoot?.trim()) throw badRequest("Choose a local folder to turn into a Space.");
    if (state.localFolderGrantProvider) {
      if (!body.folderGrantId || !await state.localFolderGrantProvider.consumeLocalFolderGrant({ spaceRoot: body.spaceRoot, grantId: body.folderGrantId })) {
        throw forbidden("The folder selection expired. Choose the folder again to create the Space.");
      }
    } else if (state.appMode === "desktop") {
      throw forbidden("A folder must be selected in the desktop app before it can become a Space.");
    }
    const space = await runCheckSpaceRegistryMutation(
      state,
      () => registerSpaceInternal(state, body.spaceRoot!, body.providerHint),
    );
    sendJson(res, { space }, 201);
    return;
  }

  const spaceMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)$/);
  if (spaceMatch && (method === "PUT" || method === "PATCH")) {
    const body = await readJsonBody<{ name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A Space name is required.");
    sendJson(res, { space: await renameSpace(spaceMatch[1], body.name) });
    return;
  }
  if (spaceMatch && method === "DELETE") {
    const space = await getSpace(spaceMatch[1]);
    sendJson(res, await removeSpaceRegistrationInternal(state, space));
    return;
  }

  const spaceAppearanceMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/appearance$/);
  if (spaceAppearanceMatch && method === "PUT") {
    const space = await getSpace(spaceAppearanceMatch[1]);
    const body = await readJsonBody<{ customization?: unknown }>(state, req);
    if (!body.customization || typeof body.customization !== "object" || Array.isArray(body.customization)) {
      throw badRequest("A Space appearance object is required.");
    }
    const appearance = await state.appearance.replaceSpace(
      space.id,
      body.customization,
    );
    sendJson(res, { appearance });
    return;
  }
  if (spaceAppearanceMatch && method === "DELETE") {
    const space = await getSpace(spaceAppearanceMatch[1]);
    sendJson(res, { appearance: await state.appearance.removeSpace(space.id) });
    return;
  }

  const proposalCollectionMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals$/);
  if (proposalCollectionMatch && method === "GET") {
    const space = await getSpace(proposalCollectionMatch[1]);
    if (!(await readConversation(space.spaceRoot, proposalCollectionMatch[2])).length) throw notFound("Conversation not found.");
    const proposals = await state.restrictedAppProposals.list({ spaceId: space.id, conversationId: proposalCollectionMatch[2] });
    sendJson(res, { proposals: proposals.map(rendererRestrictedAppProposal) });
    return;
  }
  const proposalInstallMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals\/([^/]+)\/install$/);
  if (proposalInstallMatch && method === "POST") {
    const space = await getSpace(proposalInstallMatch[1]);
    const proposal = await state.restrictedAppProposals.get(proposalInstallMatch[3]);
    if (!proposal || proposal.spaceId !== space.id || proposal.conversationId !== proposalInstallMatch[2]) throw notFound("App proposal not found.");
    const app = await runRestrictedAppMutation(state, space.id, () => state.restrictedAppProposals.install(proposal.id));
    if (!app) throw httpError(409, "This app proposal is no longer available to install.");
    sendJson(res, { app, proposal: rendererRestrictedAppProposal((await state.restrictedAppProposals.get(proposal.id))!) }, 201);
    return;
  }
  const proposalMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals\/([^/]+)$/);
  if (proposalMatch && method === "DELETE") {
    const space = await getSpace(proposalMatch[1]);
    const proposal = await state.restrictedAppProposals.get(proposalMatch[3]);
    if (!proposal || proposal.spaceId !== space.id || proposal.conversationId !== proposalMatch[2]) throw notFound("App proposal not found.");
    sendJson(res, { dismissed: await state.restrictedAppProposals.dismiss(proposal.id) });
    return;
  }

  const localAppStudioMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio$/);
  if (localAppStudioMatch && method === "GET") {
    const space = await getSpace(localAppStudioMatch[1]);
    sendJson(res, { studio: await state.restrictedApps.localAppStudio(space.id) });
    return;
  }

  const localAppRemovalImpactMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-removal-impact$/);
  if (localAppRemovalImpactMatch && method === "GET") {
    const space = await getSpace(localAppRemovalImpactMatch[1]);
    sendJson(res, { impact: await state.restrictedApps.spaceRemovalImpact(space.id) });
    return;
  }
  if (localAppStudioMatch && method === "PUT") {
    const space = await getSpace(localAppStudioMatch[1]);
    const body = await readJsonBody<{ title?: unknown; description?: unknown; icon?: unknown }>(state, req);
    if (typeof body.title !== "string"
      || (body.description !== undefined && body.description !== null && typeof body.description !== "string")
      || (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string")) {
      throw badRequest("An App title plus optional text description and icon id are required.");
    }
    const title = body.title;
    const description = body.description === undefined ? null : body.description;
    const icon = body.icon === undefined ? null : body.icon;
    const project = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.declareLocalAppProject({
      spaceId: space.id,
      presentation: { title, description, icon },
    }));
    sendJson(res, { project });
    return;
  }

  const localAppReleasePrepareMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/releases\/prepare$/);
  if (localAppReleasePrepareMatch && method === "POST") {
    const space = await getSpace(localAppReleasePrepareMatch[1]);
    const body = await readJsonBody<{ displayVersion?: unknown }>(state, req);
    if (typeof body.displayVersion !== "string" || !body.displayVersion.trim()) throw badRequest("A Release version is required.");
    const displayVersion = body.displayVersion;
    const prepared = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.prepareLocalAppRelease({
      spaceId: space.id,
      displayVersion,
    }));
    sendJson(res, { release: prepared }, 201);
    return;
  }

  const localAppReleasePublishMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/releases\/publish$/);
  if (localAppReleasePublishMatch && method === "POST") {
    const space = await getSpace(localAppReleasePublishMatch[1]);
    const body = await readJsonBody<{ releaseDigest?: unknown }>(state, req);
    if (typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) throw badRequest("A prepared Release digest is required.");
    const releaseDigest = body.releaseDigest;
    const release = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.publishLocalAppRelease({
      spaceId: space.id,
      releaseDigest,
    }));
    sendJson(res, { release });
    return;
  }

  const localAppReleaseMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/releases\/([^/]+)$/);
  if (localAppReleaseMatch && method === "DELETE") {
    const space = await getSpace(localAppReleaseMatch[1]);
    const releaseDigest = localAppReleaseMatch[2];
    const deletion = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.deleteLocalAppRelease({
      spaceId: space.id,
      releaseDigest,
    }));
    sendJson(res, { deletion });
    return;
  }

  const localAppInstallPrepareMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/installs\/prepare$/);
  if (localAppInstallPrepareMatch && method === "POST") {
    const source = await getSpace(localAppInstallPrepareMatch[1]);
    const body = await readJsonBody<{ targetSpaceId?: unknown; releaseDigest?: unknown }>(state, req);
    if (typeof body.targetSpaceId !== "string" || !body.targetSpaceId.trim()
      || typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) {
      throw badRequest("A target Space and published Release are required.");
    }
    const targetSpaceId = body.targetSpaceId;
    const releaseDigest = body.releaseDigest;
    const target = await getSpace(targetSpaceId);
    const operation = await runRestrictedAppMutations(state, [source.id, target.id], () => state.restrictedApps.prepareLocalAppInstall({
      sourceSpaceId: source.id,
      targetSpaceId: target.id,
      releaseDigest,
    }));
    sendJson(res, { operation }, 201);
    return;
  }

  const localAppOperationActivateMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/operations\/([^/]+)\/activate$/);
  if (localAppOperationActivateMatch && method === "POST") {
    const source = await getSpace(localAppOperationActivateMatch[1]);
    const studio = await state.restrictedApps.localAppStudio(source.id);
    const operation = studio.operations.find((item) => item.operationId === localAppOperationActivateMatch[2]);
    if (!operation) throw notFound("Prepared App operation not found.");
    const target = await getSpace(operation.targetSpaceId);
    const result = await runRestrictedAppMutations(state, [source.id, target.id], () => operation.kind === "install"
      ? state.restrictedApps.activateLocalAppInstall(operation.operationId)
      : state.restrictedApps.activateLocalAppUpdate(operation.operationId));
    sendJson(res, result);
    return;
  }
  const localAppOperationMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/operations\/([^/]+)$/);
  if (localAppOperationMatch && method === "DELETE") {
    const source = await getSpace(localAppOperationMatch[1]);
    const operationId = localAppOperationMatch[2];
    const cancelled = await runRestrictedAppMutation(state, source.id, async () => {
      const studio = await state.restrictedApps.localAppStudio(source.id);
      if (!studio.operations.some((operation) => operation.operationId === operationId)) {
        throw notFound("Prepared App operation not found.");
      }
      return state.restrictedApps.cancelLocalAppOperation(operationId);
    });
    sendJson(res, { cancelled });
    return;
  }

  const localAppUpdatePrepareMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/instances\/([^/]+)\/updates\/prepare$/);
  if (localAppUpdatePrepareMatch && method === "POST") {
    const source = await getSpace(localAppUpdatePrepareMatch[1]);
    const body = await readJsonBody<{ releaseDigest?: unknown; continuityPolicy?: unknown }>(state, req);
    if (typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) throw badRequest("A target published Release is required.");
    if (body.continuityPolicy !== undefined && body.continuityPolicy !== "eligible" && body.continuityPolicy !== "reset") {
      throw badRequest("Update continuity must be eligible or reset.");
    }
    const releaseDigest = body.releaseDigest;
    const continuityPolicy = body.continuityPolicy;
    const studio = await state.restrictedApps.localAppStudio(source.id);
    const instance = studio.instances.find((item) => item.runtimeInstanceId === localAppUpdatePrepareMatch[2]);
    if (!instance) throw notFound("Local App Instance not found.");
    const target = await getSpace(instance.spaceId);
    const operation = await runRestrictedAppMutations(state, [source.id, target.id], () => state.restrictedApps.prepareLocalAppUpdate({
      sourceSpaceId: source.id,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest,
      ...(continuityPolicy ? { continuityPolicy } : {}),
    }));
    sendJson(res, { operation }, 201);
    return;
  }

  const localAppInstanceMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/local-app-instances\/([^/]+)$/);
  if (localAppInstanceMatch && method === "DELETE") {
    const space = await getSpace(localAppInstanceMatch[1]);
    const body = await readJsonBody<{ dataDisposition?: "retain" | "purge" }>(state, req);
    if (body.dataDisposition !== "retain" && body.dataDisposition !== "purge") {
      throw badRequest("Choose whether to retain or purge this App's local data.");
    }
    const installed = (await state.restrictedApps.list(space.id)).find((app) => (
      app.runtimeInstanceKind === "app" && app.runtimeInstanceId === localAppInstanceMatch[2]
    ));
    if (!installed) throw notFound("Local App Instance not found.");
    const result = await runRestrictedAppMutations(state, [installed.sourceSpaceId, space.id], () => state.restrictedApps.uninstallLocalApp({
      runtimeInstanceId: localAppInstanceMatch[2],
      dataDisposition: body.dataDisposition!,
    }), { requiredSpaceIds: [space.id] });
    sendJson(res, result);
    return;
  }

  const localAppRetainedDataMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/app-studio\/retained-data\/([^/]+)$/);
  if (localAppRetainedDataMatch && method === "DELETE") {
    const source = await getSpace(localAppRetainedDataMatch[1]);
    const retainedDataId = localAppRetainedDataMatch[2];
    const result = await runRestrictedAppMutation(state, source.id, async () => {
      const studio = await state.restrictedApps.localAppStudio(source.id);
      if (!studio.retainedData.some((record) => record.retainedDataId === retainedDataId)) {
        throw notFound("Retained Local App data not found.");
      }
      return state.restrictedApps.purgeLocalAppRetainedData(retainedDataId);
    });
    sendJson(res, result);
    return;
  }

  const restrictedCollectionMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps$/);
  if (restrictedCollectionMatch && method === "GET") {
    const space = await getSpace(restrictedCollectionMatch[1]);
    sendJson(res, { apps: await state.restrictedApps.list(space.id) });
    return;
  }
  if (restrictedCollectionMatch && method === "POST") {
    const space = await getSpace(restrictedCollectionMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; expectedDigest?: string }>(state, req);
    if (!body.sourcePath?.trim() || !body.expectedDigest?.trim()) throw badRequest("A reviewed package folder and digest are required.");
    const app = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.install({
      spaceId: space.id,
      spaceRoot: space.spaceRoot,
      sourcePath: body.sourcePath!,
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app }, 201);
    return;
  }

  const restrictedInspectMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/inspect$/);
  if (restrictedInspectMatch && method === "POST") {
    const space = await getSpace(restrictedInspectMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("A Space-relative package folder is required.");
    sendJson(res, { review: await state.restrictedApps.inspect({
      spaceId: space.id,
      spaceRoot: space.spaceRoot,
      sourcePath: body.sourcePath,
    }) });
    return;
  }

  const restrictedItemMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)$/);
  if (restrictedItemMatch && method === "DELETE") {
    const space = await getSpace(restrictedItemMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    const removed = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.remove({
      spaceId: space.id,
      appId: restrictedItemMatch[2],
      ...(body.expectedDigest ? { expectedDigest: body.expectedDigest } : {}),
    }));
    sendJson(res, { removed });
    return;
  }

  const restrictedInvokeMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/invoke$/);
  if (restrictedInvokeMatch && method === "POST") {
    const space = await getSpace(restrictedInvokeMatch[1]);
    assertNoCapabilityMutationForTurn(state, space.id);
    const body = await readJsonBody<{ expectedDigest?: string; action?: string; input?: unknown }>(state, req);
    if (!body.expectedDigest?.trim() || !body.action?.trim()) throw badRequest("An installed revision and action are required.");
    assertNoCapabilityMutationForTurn(state, space.id);
    const result = await state.restrictedApps.invoke({
      spaceId: space.id,
      appId: restrictedInvokeMatch[2],
      expectedDigest: body.expectedDigest,
      action: body.action,
      input: body.input,
    });
    sendJson(res, { result });
    return;
  }

  const restrictedConnectionsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/connections$/);
  if (restrictedConnectionsMatch && method === "GET") {
    const space = await getSpace(restrictedConnectionsMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    sendJson(res, { connections: await state.restrictedApps.connectionStatus(
      space.id,
      restrictedConnectionsMatch[2],
      expectedDigest,
    ) });
    return;
  }

  const restrictedNetworkGrantMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/network\/([^/]+)$/);
  if (restrictedNetworkGrantMatch && (method === "PUT" || method === "DELETE")) {
    const space = await getSpace(restrictedNetworkGrantMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const operation = method === "PUT" ? state.restrictedApps.grantNetwork.bind(state.restrictedApps) : state.restrictedApps.revokeNetwork.bind(state.restrictedApps);
    const app = await runRestrictedAppMutation(state, space.id, () => operation({
      spaceId: space.id,
      appId: restrictedNetworkGrantMatch[2],
      destinationId: restrictedNetworkGrantMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedFileGrantMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/files\/([^/]+)$/);
  if (restrictedFileGrantMatch && (method === "PUT" || method === "DELETE")) {
    const space = await getSpace(restrictedFileGrantMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string; root?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const app = await runRestrictedAppMutation(state, space.id, () => method === "PUT"
      ? state.restrictedApps.grantFiles({
          spaceId: space.id,
          spaceRoot: space.spaceRoot,
          appId: restrictedFileGrantMatch[2],
          permissionId: restrictedFileGrantMatch[3],
          expectedDigest: body.expectedDigest!,
          root: body.root ?? "",
        })
      : state.restrictedApps.revokeFiles({
          spaceId: space.id,
          appId: restrictedFileGrantMatch[2],
          permissionId: restrictedFileGrantMatch[3],
          expectedDigest: body.expectedDigest!,
        }));
    sendJson(res, { app });
    return;
  }

  const restrictedNotificationGrantMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/notifications\/([^/]+)$/);
  if (restrictedNotificationGrantMatch && (method === "PUT" || method === "DELETE")) {
    const space = await getSpace(restrictedNotificationGrantMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const operation = method === "PUT"
      ? state.restrictedApps.grantNotifications.bind(state.restrictedApps)
      : state.restrictedApps.revokeNotifications.bind(state.restrictedApps);
    const app = await runRestrictedAppMutation(state, space.id, () => operation({
      spaceId: space.id,
      appId: restrictedNotificationGrantMatch[2],
      permissionId: restrictedNotificationGrantMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedAutomationRunMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)\/run$/);
  if (restrictedAutomationRunMatch && method === "POST") {
    const space = await getSpace(restrictedAutomationRunMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const result = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.runAutomationNow({
      spaceId: space.id,
      appId: restrictedAutomationRunMatch[2],
      automationId: restrictedAutomationRunMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, result);
    return;
  }

  const restrictedAutomationRunsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)\/runs$/);
  if (restrictedAutomationRunsMatch && method === "GET") {
    const space = await getSpace(restrictedAutomationRunsMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    const runs = await state.restrictedApps.listAutomationRuns(
      space.id,
      restrictedAutomationRunsMatch[2],
      expectedDigest,
      restrictedAutomationRunsMatch[3],
    );
    sendJson(res, { runs });
    return;
  }

  const restrictedAutomationMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)$/);
  if (restrictedAutomationMatch && (method === "PUT" || method === "DELETE")) {
    const space = await getSpace(restrictedAutomationMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const app = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.setAutomationEnabled({
      spaceId: space.id,
      appId: restrictedAutomationMatch[2],
      automationId: restrictedAutomationMatch[3],
      expectedDigest: body.expectedDigest!,
      enabled: method === "PUT",
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedStorageMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/storage$/);
  if (restrictedStorageMatch && (method === "GET" || method === "DELETE")) {
    const space = await getSpace(restrictedStorageMatch[1]);
    const body = method === "DELETE" ? await readJsonBody<{ expectedDigest?: string }>(state, req) : null;
    const expectedDigest = body?.expectedDigest ?? url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    const usage = method === "DELETE"
      ? await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.clearStorage(
          space.id,
          restrictedStorageMatch[2],
          expectedDigest,
        ))
      : await state.restrictedApps.storageUsage(space.id, restrictedStorageMatch[2], expectedDigest);
    sendJson(res, { usage });
    return;
  }

  const restrictedOAuthMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/connections\/([^/]+)\/oauth$/);
  if (restrictedOAuthMatch && method === "POST") {
    const space = await getSpace(restrictedOAuthMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const connection = await runRestrictedAppMutation(state, space.id, () => state.restrictedApps.connectOAuth({
      spaceId: space.id,
      appId: restrictedOAuthMatch[2],
      destinationId: restrictedOAuthMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { connection });
    return;
  }

  const restrictedConnectionMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/restricted-apps\/([^/]+)\/connections\/([^/]+)$/);
  if (restrictedConnectionMatch && (method === "PUT" || method === "DELETE")) {
    const space = await getSpace(restrictedConnectionMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string; credential?: unknown }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const result = await runRestrictedAppMutation(state, space.id, async () => {
      if (method === "DELETE") {
        return { removed: await state.restrictedApps.deleteConnection({
          spaceId: space.id,
          appId: restrictedConnectionMatch[2],
          destinationId: restrictedConnectionMatch[3],
          expectedDigest: body.expectedDigest!,
        }) };
      }
      return { connection: await state.restrictedApps.setConnection({
        spaceId: space.id,
        appId: restrictedConnectionMatch[2],
        destinationId: restrictedConnectionMatch[3],
        expectedDigest: body.expectedDigest!,
        credential: body.credential,
      }) };
    });
    sendJson(res, result);
    return;
  }

  const searchMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/search$/);
  if (method === "GET" && searchMatch) {
    const space = await getSpace(searchMatch[1]);
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "files" && scope !== "chats") throw badRequest("Search scope is unsupported.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const result = await searchSpace(space.spaceRoot, url.searchParams.get("q") ?? "", {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        signal: controller.signal,
      });
      if (!controller.signal.aborted && !res.destroyed) sendJson(res, result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
    return;
  }

  const treeMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/tree$/);
  if (method === "GET" && treeMatch) {
    const space = await getSpace(treeMatch[1]);
    const maxDepthValue = Number(url.searchParams.get("maxDepth") ?? 20);
    const maxDepth = Number.isFinite(maxDepthValue) ? Math.min(Math.max(Math.floor(maxDepthValue), 0), 50) : 20;
    const scan = await scanSpaceTree(
      space.spaceRoot,
      maxDepth,
      url.searchParams.get("path") ?? "",
      { includeIgnored: url.searchParams.get("includeIgnored") !== "0" },
    );
    sendJson(res, { tree: scan.entries, truncated: scan.truncated });
    return;
  }

  const fileMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/file$/);
  if (method === "GET" && fileMatch) {
    const space = await getSpace(fileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    sendJson(res, await readSpaceTextFile(space.spaceRoot, path));
    return;
  }
  if (method === "PUT" && fileMatch) {
    const space = await getSpace(fileMatch[1]);
    const body = await readJsonBody<{ path?: string; text?: string }>(state, req);
    if (!body.path?.trim() || typeof body.text !== "string") throw badRequest("A file path and text are required.");
    const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
      paths: [body.path],
      reason: "pre_edit",
      label: `Before editing ${body.path}`,
    });
    const file = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => writeSpaceTextFile(space.spaceRoot, body.path!, body.text!));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const fileInfoMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/file-info$/);
  if (method === "GET" && fileInfoMatch) {
    const space = await getSpace(fileInfoMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Space item path is required.");
    sendJson(res, await getSpaceEntryInfo(space.spaceRoot, path));
    return;
  }

  const filePreviewMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/file-preview$/);
  if (method === "GET" && filePreviewMatch) {
    const space = await getSpace(filePreviewMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Space item path is required.");
    sendJson(res, { preview: await getSpaceFilePreview(space.spaceRoot, path) });
    return;
  }

  const pathsExistMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/paths-exist$/);
  if (method === "POST" && pathsExistMatch) {
    const space = await getSpace(pathsExistMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) {
      throw badRequest("Space paths must be an array of strings.");
    }
    sendJson(res, { existing: await findExistingSpaceFilePaths(space.spaceRoot, body.paths) });
    return;
  }

  const rawFileMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/raw-file$/);
  if (method === "GET" && rawFileMatch) {
    const space = await getSpace(rawFileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    await sendSpaceRawFile(res, space.spaceRoot, path);
    return;
  }

  const moveMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/move-local-entry$/);
  if (method === "POST" && moveMatch) {
    const space = await getSpace(moveMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; targetFolderPath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("Select a file or folder to move.");
    const moveSource = normalizeSpaceRelativePath(body.sourcePath);
    const moveTargetFolder = normalizeSpaceRelativePath(body.targetFolderPath ?? "");
    const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
    const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
      movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
      reason: "pre_move",
      label: `Before moving ${body.sourcePath}`,
    });
    const moved = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => moveSpaceEntry(space.spaceRoot, {
      sourcePath: moveSource,
      targetFolderPath: body.targetFolderPath ?? "",
    }));
    sendJson(res, { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const renameMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/rename-local-entry$/);
  if (method === "POST" && renameMatch) {
    const space = await getSpace(renameMatch[1]);
    const body = await readJsonBody<{ path?: string; newName?: string }>(state, req);
    if (!body.path?.trim() || !body.newName?.trim()) throw badRequest("A Space item and new name are required.");
    const renameSource = normalizeSpaceRelativePath(body.path);
    const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
    const renameDestination = [renameParent, body.newName].filter(Boolean).join("/");
    const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
      movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
      reason: "pre_rename",
      label: `Before renaming ${body.path}`,
    });
    const renamed = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => renameSpaceEntry(space.spaceRoot, { path: body.path!, newName: body.newName! }));
    sendJson(res, { renamed, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const foldersMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/folders$/);
  if (method === "POST" && foldersMatch) {
    const space = await getSpace(foldersMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A folder name is required.");
    const folderTarget = [normalizeSpaceRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
      deleteOnRestore: [folderTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const folder = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => createSpaceFolder(space.spaceRoot, body.parentPath ?? "", body.name!));
    sendJson(res, { folder, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const filesMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/files$/);
  if (method === "POST" && filesMatch) {
    const space = await getSpace(filesMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string; text?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A file name is required.");
    const fileTarget = [normalizeSpaceRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
      deleteOnRestore: [fileTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const file = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => createSpaceTextFile(space.spaceRoot, body.parentPath ?? "", body.name!, body.text ?? ""));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const deleteMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/local-file$/);
  if (method === "DELETE" && deleteMatch) {
    const space = await getSpace(deleteMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("Select a file or folder to delete.");
    const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
      paths: [body.path],
      reason: "pre_delete",
      label: `Before deleting ${body.path}`,
    });
    const deleted = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => deleteSpaceEntry(space.spaceRoot, body.path!));
    sendJson(res, { ...deleted, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const ignoreMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/ignore-paths$/);
  if (method === "GET" && ignoreMatch) {
    const space = await getSpace(ignoreMatch[1]);
    sendJson(res, await readSpaceIgnoreState(space.spaceRoot));
    return;
  }
  if (method === "POST" && ignoreMatch) {
    const space = await getSpace(ignoreMatch[1]);
    const body = await readJsonBody<{ paths?: unknown; ignored?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || typeof body.ignored !== "boolean") {
      throw badRequest("Space paths and an ignore decision are required.");
    }
    sendJson(res, await setSpaceIgnoreState(space.spaceRoot, body.paths, body.ignored));
    return;
  }

  const fileEventsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/file-events$/);
  if (method === "GET" && fileEventsMatch) {
    const space = await getSpace(fileEventsMatch[1]);
    await openSpaceFileStream(state, req, res, space.spaceRoot);
    return;
  }

  const uploadMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/upload-local-files$/);
  if (method === "POST" && uploadMatch) {
    const space = await getSpace(uploadMatch[1]);
    const multipart = await readMultipartBody(state, req);
    const relativePaths = parseRelativePaths(multipart.fields.get("relativePaths"), multipart.files.length);
    const uploaded = await writeUploadedFiles(
      space.spaceRoot,
      multipart.fields.get("targetFolderPath") ?? "",
      multipart.files.map((file, index) => ({ fileName: file.fileName, relativePath: relativePaths[index], data: file.data })),
    );
    const safety = await checkpointAdditiveWritesOrUndo(space.spaceRoot, uploaded.map((file) => file.path), {
      reason: "pre_upload",
      label: `Before uploading ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`,
    });
    sendJson(res, { uploaded, safetyCheckpointId: safety?.checkpointId ?? null, historySkippedPaths: safety?.skippedLargeFiles ?? [] }, 201);
    return;
  }

  if (method === "GET" && url.pathname === "/api/resources/tree") {
    sendJson(res, { tree: await listResourceTree() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/resources/folders") {
    const body = await readJsonBody<{ parentPath?: string; name?: string }>(state, req);
    if (!body.name) throw badRequest("Folder name is required.");
    sendJson(res, { folder: await createResourceFolder(body.parentPath ?? "", body.name) }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/resources/upload") {
    const multipart = await readMultipartBody(state, req);
    const relativePaths = parseRelativePaths(multipart.fields.get("relativePaths"), multipart.files.length);
    const uploaded = await uploadResourceFiles(
      multipart.fields.get("targetFolderPath") ?? "",
      multipart.files.map((file, index) => ({ fileName: file.fileName, relativePath: relativePaths[index], data: file.data })),
    );
    sendJson(res, { uploaded }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/resources/copy-to-space") {
    const body = await readJsonBody<{ spaceId?: string; paths?: string[]; targetFolder?: string }>(state, req);
    if (!body.spaceId || !Array.isArray(body.paths)) throw badRequest("A Space and Library items are required.");
    const space = await getSpace(body.spaceId);
    const copied = await copyResourcesToSpace(space.spaceRoot, body.paths, body.targetFolder ?? "From Library");
    const safety = await checkpointAdditiveWritesOrUndo(space.spaceRoot, copied, {
      reason: "pre_add",
      label: `Before adding ${copied.length} Library item${copied.length === 1 ? "" : "s"}`,
    });
    sendJson(res, { copied, safetyCheckpointId: safety?.checkpointId ?? null, historySkippedPaths: safety?.skippedLargeFiles ?? [] });
    return;
  }

  const checkpointCollectionMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/history\/checkpoints$/);
  if (checkpointCollectionMatch && method === "GET") {
    const space = await getSpace(checkpointCollectionMatch[1]);
    sendJson(res, { checkpoints: await listSpaceCheckpoints(space.spaceRoot) });
    return;
  }
  if (checkpointCollectionMatch && method === "POST") {
    const space = await getSpace(checkpointCollectionMatch[1]);
    const body = await readJsonBody<{ label?: string }>(state, req);
    const existingIds = new Set((await listSpaceCheckpoints(space.spaceRoot, 1000)).map((checkpoint) => checkpoint.checkpointId));
    const checkpoint = await createSpaceCheckpoint(space.spaceRoot, { label: body.label, reason: "manual" });
    const created = !existingIds.has(checkpoint.checkpointId);
    sendJson(res, { checkpoint, created }, created ? 201 : 200);
    return;
  }
  const checkpointRestoreMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/history\/checkpoints\/([^/]+)\/restore$/);
  if (method === "POST" && checkpointRestoreMatch) {
    const space = await getSpace(checkpointRestoreMatch[1]);
    sendJson(res, await restoreSpaceCheckpoint(space.spaceRoot, checkpointRestoreMatch[2]));
    return;
  }

  const fileVersionsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/history\/file-versions$/);
  if (method === "GET" && fileVersionsMatch) {
    const space = await getSpace(fileVersionsMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A Space-relative file path is required.");
    sendJson(res, { path, versions: await listFileVersions(space.spaceRoot, path) });
    return;
  }
  if (method === "POST" && fileVersionsMatch) {
    const space = await getSpace(fileVersionsMatch[1]);
    const body = await readJsonBody<{ path?: string; hashSha256?: string }>(state, req);
    if (!body.path?.trim() || !body.hashSha256?.trim()) throw badRequest("A file path and version hash are required.");
    sendJson(res, { result: await restoreFileVersion(space.spaceRoot, body.path, body.hashSha256) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/agent/models") {
    const spaceId = url.searchParams.get("spaceId");
    if (!spaceId) throw badRequest("Space id is required.");
    const space = await getSpace(spaceId);
    const models = await listPiModels(space.spaceRoot, state.runtimeProvider);
    sendJson(res, {
      models: models.map((model) => ({
        ...model,
        oauthSupported: model.oauthSupported && Boolean(state.piOAuthHooks),
      })),
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/status") {
    const spaceId = url.searchParams.get("spaceId");
    if (!spaceId) throw badRequest("Space id is required.");
    const space = await getSpace(spaceId);
    sendJson(res, { status: await safeAgentStatus(space.spaceRoot, state.runtimeProvider) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/configure") {
    const body = await readJsonBody<{ spaceId?: string; provider?: string; model?: string; apiKey?: string }>(state, req);
    const space = await configuredSpace(body.spaceId, body.provider, body.model);
    const selected = (await listPiModels(space.spaceRoot, state.runtimeProvider))
      .find((model) => model.provider === body.provider && model.id === body.model);
    if (!selected) throw badRequest("The selected Pi model is not available in this Space.");
    if (!body.apiKey?.trim() && !selected.authConfigured) {
      throw badRequest(`Enter an API key for ${selected.providerName}.`);
    }
    if (body.apiKey?.trim()) {
      await savePiApiKey(space.spaceRoot, body.provider!, body.apiKey, { runtimeProvider: state.runtimeProvider });
    }
    await setPiDefaultModel(space.spaceRoot, { provider: body.provider!, id: body.model! }, state.runtimeProvider);
    await invalidateAllClients(state);
    sendJson(res, { status: normalizeStatus(await getPiSetupStatus(space.spaceRoot, state.runtimeProvider)) });
    return;
  }
  if (method === "DELETE" && url.pathname === "/api/agent/auth") {
    const body = await readJsonBody<{ spaceId?: string; provider?: string }>(state, req);
    if (!body.spaceId || !body.provider?.trim()) throw badRequest("A Space and provider are required.");
    const space = await getSpace(body.spaceId);
    await removePiProviderAuth(space.spaceRoot, body.provider, state.runtimeProvider);
    await invalidateAllClients(state);
    sendJson(res, {
      models: await listPiModels(space.spaceRoot, state.runtimeProvider),
      status: normalizeStatus(await getPiSetupStatus(space.spaceRoot, state.runtimeProvider)),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/oauth") {
    if (!state.piOAuthHooks) throw unavailable("Provider account sign-in requires the Space desktop app. You can use an API key for this provider instead.");
    const body = await readJsonBody<{ spaceId?: string; provider?: string; model?: string }>(state, req);
    const space = await configuredSpace(body.spaceId, body.provider, body.model);
    await loginPiOAuth(space.spaceRoot, body.provider!, state.piOAuthHooks, state.runtimeProvider);
    await setPiDefaultModel(space.spaceRoot, { provider: body.provider!, id: body.model! }, state.runtimeProvider);
    await invalidateAllClients(state);
    sendJson(res, { status: normalizeStatus(await getPiSetupStatus(space.spaceRoot, state.runtimeProvider)) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/capabilities/discover") {
    const result = await state.capabilityRegistry.search({
      query: url.searchParams.get("query") ?? undefined,
      type: capabilityRegistryType(url.searchParams.get("type")),
      sort: capabilityRegistrySort(url.searchParams.get("sort")),
      offset: optionalBoundedInteger(url.searchParams.get("offset"), "offset"),
      limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit"),
    });
    sendJson(res, { ...result, catalogUrl: "https://pi.dev/packages" });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/capabilities/details") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) throw badRequest("Capability id is required.");
    sendJson(res, { item: await state.capabilityRegistry.details(id) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/capabilities/install") {
    const body = await readJsonBody<{ spaceId?: string; id?: string; scope?: "global" | "project" }>(state, req);
    if (!body.spaceId || !body.id?.trim()) throw badRequest("A Space and capability are required.");
    const space = await getSpace(body.spaceId);
    const scope = capabilityScope(body.scope);
    // Remote inspection is read-only and can take several seconds. Complete it
    // before reserving the mutation so discovery never blocks an unrelated turn.
    const item = await state.capabilityRegistry.details(body.id);
    const bundle = item.sourceKind === "bundle"
      ? await state.capabilityRegistry.buildOfficialSkillBundle(item.id)
      : null;
    const installSource = item.installSource;
    if (!bundle && !installSource) throw badRequest("This capability is a reference and cannot be installed directly.");
    const installed = await runCapabilityMutation(state, space, scope, async () => {
      if (bundle) {
        const imported = await importPiSkillBundle(space.spaceRoot, {
          fileName: bundle.fileName,
          bytes: bundle.bytes,
          scope: scope === "project" ? "project" : "user",
        }, state.runtimeProvider);
        return { kind: "skill" as const, item, imported };
      }
      await installPiPackage(space.spaceRoot, installSource!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
      return { kind: "package" as const, item, source: installSource! };
    });
    sendJson(res, { installed }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/install") {
    const body = await readJsonBody<{ spaceId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.spaceId || !body.source?.trim()) throw badRequest("A Space and package source are required.");
    const space = await getSpace(body.spaceId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, space, scope, async () => {
      await installPiPackage(space.spaceRoot, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { installed: true }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/update") {
    const body = await readJsonBody<{ spaceId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.spaceId || !body.source?.trim() || !body.scope) {
      throw badRequest("A Space, package source, and scope are required.");
    }
    const space = await getSpace(body.spaceId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, space, scope, async () => {
      await updatePiPackages(space.spaceRoot, body.source, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { updated: true });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/remove") {
    const body = await readJsonBody<{ spaceId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.spaceId || !body.source?.trim() || !body.scope) {
      throw badRequest("A Space, package source, and scope are required.");
    }
    const space = await getSpace(body.spaceId);
    const scope = capabilityScope(body.scope);
    const removed = await runCapabilityMutation(state, space, scope, async () =>
      await removePiPackage(space.spaceRoot, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      }));
    sendJson(res, { removed });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/remove") {
    const body = await readJsonBody<{ spaceId?: string; path?: string; scope?: "global" | "project" }>(state, req);
    if (!body.spaceId || !body.path?.trim()) throw badRequest("A Space and Skill path are required.");
    const space = await getSpace(body.spaceId);
    const scope = capabilityScope(body.scope);
    const removed = await runCapabilityMutation(state, space, scope, async () =>
      await removePiSkill(space.spaceRoot, {
        skillPath: body.path!,
        scope: scope === "project" ? "project" : "user",
      }, state.runtimeProvider));
    sendJson(res, { removed: true, path: removed.removedPath });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/import") {
    const multipart = await readMultipartBody(state, req);
    const spaceId = multipart.fields.get("spaceId");
    if (!spaceId || !multipart.files.length) throw badRequest("A Space and Skill files are required.");
    const space = await getSpace(spaceId);
    const scope = multipart.fields.get("scope") === "project" ? "project" : "user";
    const imported = await runCapabilityMutation(
      state,
      space,
      scope === "project" ? "project" : "global",
      async () => {
        const results = [];
        for (const file of multipart.files) {
          results.push(await importPiSkillBundle(space.spaceRoot, { fileName: file.fileName, bytes: file.data, scope }, state.runtimeProvider));
        }
        return results;
      },
    );
    sendJson(res, { imported }, 201);
    return;
  }

  const catalogMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/agent\/catalog$/);
  if (method === "GET" && catalogMatch) {
    const snapshot = await state.kernel.getCapabilities({ kind: "renderer", spaceId: catalogMatch[1] });
    sendJson(res, snapshot.catalog);
    return;
  }
  const conversationsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations$/);
  if (conversationsMatch && method === "GET") {
    const space = await getSpace(conversationsMatch[1]);
    sendJson(res, { conversations: await listConversations(space.spaceRoot) });
    return;
  }
  if (conversationsMatch && method === "POST") {
    const space = await getSpace(conversationsMatch[1]);
    const body = await readJsonBody<{ conversationId?: unknown }>(state, req);
    const conversationId = body.conversationId === undefined
      ? undefined
      : conversationIdentity(body.conversationId);
    sendJson(res, { conversation: await createConversation(space.spaceRoot, undefined, conversationId) }, 201);
    return;
  }

  const conversationMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)$/);
  if (conversationMatch && (method === "PUT" || method === "PATCH")) {
    const space = await getSpace(conversationMatch[1]);
    const conversationId = conversationMatch[2];
    const body = await readJsonBody<{ title?: string; archived?: boolean; snoozedUntil?: string | null }>(state, req);
    const changes = [
      body.title !== undefined,
      body.archived !== undefined,
      body.snoozedUntil !== undefined,
    ].filter(Boolean).length;
    if (changes !== 1) throw badRequest("Change exactly one Chat title, archive state, or snooze time.");
    if (body.title !== undefined && typeof body.title !== "string") throw badRequest("Chat title must be text.");
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw badRequest("Archived state must be true or false.");
    if (body.snoozedUntil !== undefined && body.snoozedUntil !== null) {
      if (typeof body.snoozedUntil !== "string" || !Number.isFinite(Date.parse(body.snoozedUntil))) {
        throw badRequest("Snooze time is invalid.");
      }
      if (Date.parse(body.snoozedUntil) <= Date.now()) throw badRequest("Choose a future snooze time.");
    }
    const key = clientKey(space.id, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current Assistant turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    const conversation = body.title !== undefined
      ? await renameConversation(space.spaceRoot, conversationId, body.title)
      : await updateConversationLifecycle(space.spaceRoot, conversationId, {
          ...(body.archived !== undefined ? { archived: body.archived } : {}),
          ...(body.snoozedUntil !== undefined ? { snoozedUntil: body.snoozedUntil } : {}),
        });
    if (body.title !== undefined) state.clients.get(key)?.setSessionName(conversation.title);
    sendJson(res, { conversation });
    return;
  }

  const conversationRuntimeMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/runtime$/);
  if (conversationRuntimeMatch && method === "GET") {
    const space = await getSpace(conversationRuntimeMatch[1]);
    const conversationId = conversationRuntimeMatch[2];
    if (!(await readConversation(space.spaceRoot, conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, space.id, space.spaceRoot, conversationId);
    sendJson(res, { runtime: await client.getState() });
    return;
  }

  const conversationThinkingMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/thinking$/);
  if (conversationThinkingMatch && method === "POST") {
    const space = await getSpace(conversationThinkingMatch[1]);
    const conversationId = conversationThinkingMatch[2];
    if (!(await readConversation(space.spaceRoot, conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(space.id, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish before changing the thinking level.");
    const client = await getClient(state, space.id, space.spaceRoot, conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return;
  }

  const contextAttachmentMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/context-attachments$/);
  if (contextAttachmentMatch && method === "POST") {
    const space = await getSpace(contextAttachmentMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("A file path is required.");
    sendJson(res, { attachment: await previewConversationContextAttachment(space.spaceRoot, { path: body.path }) }, 201);
    return;
  }

  const eventsMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const space = await getSpace(eventsMatch[1]);
    rememberSpaceRoot(state, space.id, space.spaceRoot);
    openChatStream(state, req, res, eventsMatch[1], eventsMatch[2]);
    return;
  }
  const messagesPostMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && messagesPostMatch) {
    const space = await getSpace(messagesPostMatch[1]);
    const conversationId = messagesPostMatch[2];
    const body = await readJsonBody<{
      content?: string;
      contextPaths?: string[];
      selectedPath?: string | null;
      requestId?: unknown;
      userMessageId?: unknown;
      delivery?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    if (body.delivery !== undefined && body.delivery !== "steer") throw badRequest("Message delivery must be \"steer\" when present.");
    if (body.delivery === "steer") {
      const steered = await steerConversationTurn(state, space, conversationId, {
        content,
        requestId: optionalTurnIdentity(body.requestId, "requestId"),
        userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
      });
      sendJson(res, { accepted: true, delivery: "steer", message: steered.message, taskId: steered.taskId, replayed: steered.replayed }, 202);
      return;
    }
    const selectedPath = normalizeSelectedPath(space.spaceRoot, body.selectedPath);
    const contextPaths = normalizeContextPaths(space.spaceRoot, body.contextPaths);
    const { message, taskId, replayed } = await acceptConversationTurn(state, space, conversationId, {
      content,
      contextPaths,
      selectedPath,
      actorKind: "assistant",
      requestId: optionalTurnIdentity(body.requestId, "requestId"),
      userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
    });
    sendJson(res, { accepted: true, message, taskId, replayed }, 202);
    return;
  }
  const abortMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/abort$/);
  if (method === "POST" && abortMatch) {
    const space = await getSpace(abortMatch[1]);
    const key = clientKey(space.id, abortMatch[2]);
    const client = state.clients.get(key);
    sendJson(res, { aborted: client ? await client.abort() : false });
    return;
  }

  const compactMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/compact$/);
  if (method === "POST" && compactMatch) {
    const space = await getSpace(compactMatch[1]);
    if (!(await readConversation(space.spaceRoot, compactMatch[2])).length) throw notFound("Conversation not found.");
    const key = clientKey(space.id, compactMatch[2]);
    const body = await readJsonBody<{ customInstructions?: string }>(state, req);
    assertNoCapabilityMutationForTurn(state, space.id);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    state.compactingConversations.add(key);
    const task = state.kernel.startTask({
      kind: "compaction",
      spaceId: space.id,
      conversationId: compactMatch[2],
      actor: { kind: "assistant", cwd: space.spaceRoot, spaceId: space.id, conversationId: compactMatch[2] },
    });
    try {
      const client = await getClient(state, space.id, space.spaceRoot, compactMatch[2]);
      await client.compact(body.customInstructions?.trim() || undefined);
      broadcast(state, streamKey(space.id, compactMatch[2]), { type: "done", conversationId: compactMatch[2] });
    } finally {
      state.compactingConversations.delete(key);
      state.kernel.finishTask(task.id);
    }
    sendJson(res, { compacted: true });
    return;
  }
  const messagesGetMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)$/);
  if (method === "GET" && messagesGetMatch) {
    const space = await getSpace(messagesGetMatch[1]);
    sendJson(res, { messages: await readConversation(space.spaceRoot, messagesGetMatch[2]) });
    return;
  }
  // Management conversation surface: the same acceptance path, task records,
  // and event stream as Space Chats, exposed for renderer clients (the
  // menu-bar popover) under the management scope id instead of a Space id.
  if (url.pathname === "/api/management/summary" && method === "GET") {
    if (state.managementInstructionsError) {
      sendJson(res, { available: false, reason: state.managementInstructionsError, conversation: null, state: "idle", latestRequest: null });
      return;
    }
    const conversation = await resolveManagementConversation(false).catch(() => null);
    const latest = state.managementRequests.latest();
    sendJson(res, {
      available: true,
      conversation: conversation ? toActConversationRef(conversation) : null,
      state: conversation ? conversationRuntimeState(state, workFoldManagementScopeId, conversation.id) : "idle",
      latestRequest: latest ? await managementRequestView(state, latest.taskId) : null,
    });
    return;
  }
  if (url.pathname === "/api/management/messages" && method === "POST") {
    assertManagementReadyForRoutes(state);
    const body = await readJsonBody<{
      content?: string;
      attachments?: unknown;
      conversationId?: unknown;
      newConversation?: unknown;
      continuationTaskId?: unknown;
      requestId?: unknown;
      userMessageId?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (rawAttachments.length > maxManagementAttachments) {
      throw badRequest(`At most ${maxManagementAttachments} attachments are allowed per request.`);
    }
    if (rawAttachments.some((item) => typeof item !== "string")) {
      throw badRequest("Attachments must be absolute paths or http(s) links.");
    }
    const conversationIdInput = boundedOptionalId(body.conversationId, "conversationId");
    const continuationTaskId = boundedOptionalId(body.continuationTaskId, "continuationTaskId");
    const requestId = optionalTurnIdentity(body.requestId, "requestId");
    const userMessageId = optionalTurnIdentity(body.userMessageId, "userMessageId");
    if (body.newConversation !== undefined && typeof body.newConversation !== "boolean") {
      throw badRequest("newConversation must be a boolean.");
    }
    if (body.newConversation === true && conversationIdInput) {
      throw badRequest("Use either conversationId or newConversation, not both.");
    }
    if (continuationTaskId && (!conversationIdInput || body.newConversation === true)) {
      throw badRequest("A continuation requires the existing conversationId.");
    }
    let attachments: ManagementAttachmentRef[];
    try {
      attachments = await classifyManagementAttachments(rawAttachments as string[], workFoldManagementRoot());
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    const scope = managementScopeForRoutes(state);
    const priorAcceptance = requestId ? state.turnStore.findScopeRequest(scope.id, requestId) : null;
    if (priorAcceptance && conversationIdInput && priorAcceptance.conversationId !== conversationIdInput) {
      throw httpError(409, "This turn request id was already accepted in another management Chat.");
    }
    const conversationId = priorAcceptance?.conversationId
      ?? (body.newConversation === true
        ? (await createConversation(scope.rootPath)).id
        : conversationIdInput ?? (await resolveManagementConversation(true)).id);
    if (continuationTaskId) {
      const previous = await managementRequestView(state, continuationTaskId);
      if (!previous || previous.conversationId !== conversationId || previous.phase !== "needs_you") {
        throw httpError(409, "That management request is no longer waiting for a reply.");
      }
      const combinedAttachmentCount = new Set(
        [...previous.attachments, ...attachments].map((attachment) => `${attachment.kind}:${attachment.target}`),
      ).size;
      if (combinedAttachmentCount > maxManagementAttachments) {
        throw badRequest(`A continued request can reference at most ${maxManagementAttachments} attachments in total.`);
      }
    }
    const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, spaceRoot: scope.rootPath }, conversationId, {
      content,
      contextPaths: [],
      selectedPath: null,
      actorKind: "renderer",
      managementAttachments: attachments,
      ...(continuationTaskId ? { continuedFromManagementTaskId: continuationTaskId } : {}),
      requestId,
      userMessageId,
    });
    sendJson(res, { accepted: true, conversationId, message, taskId, attachments }, 202);
    return;
  }
  const managementRequestMatch = match(url.pathname, /^\/api\/management\/requests\/([^/]+)$/);
  if (managementRequestMatch && method === "GET") {
    assertManagementReadyForRoutes(state);
    const request = await managementRequestView(state, managementRequestMatch[1]);
    if (!request) throw notFound("Request not found. Request records are kept while the Space app stays running.");
    sendJson(res, { request });
    return;
  }
  const managementStopMatch = match(url.pathname, /^\/api\/management\/requests\/([^/]+)\/stop$/);
  if (managementStopMatch && method === "POST") {
    assertManagementReadyForRoutes(state);
    await readJsonBody<Record<string, never>>(state, req);
    try {
      sendJson(res, { stopped: await stopManagementRequest(state, managementStopMatch[1]) });
    } catch (error) {
      if (error instanceof WorkFoldCliError && error.code === "notFound") throw notFound(error.message);
      throw error;
    }
    return;
  }
  const managementConversationMatch = match(url.pathname, /^\/api\/management\/conversations\/([^/]+)$/);
  if (managementConversationMatch && method === "GET") {
    assertManagementReadyForRoutes(state);
    sendJson(res, { messages: await readConversation(workFoldManagementRoot(), managementConversationMatch[1]) });
    return;
  }
  const managementEventsMatch = match(url.pathname, /^\/api\/management\/conversations\/([^/]+)\/events$/);
  if (managementEventsMatch && method === "GET") {
    assertManagementReadyForRoutes(state);
    openChatStream(state, req, res, workFoldManagementScopeId, managementEventsMatch[1]);
    return;
  }

  // Needs-you decision surface (docs/fold-consecrations.md): renderer/popover
  // session routes over the same host-composed card contract every surface
  // renders (fold integration reconciliation 6). Deciding is deliberately NOT
  // an act-lane verb: these routes exist only on the renderer session — the
  // act facade and the act CLI never reach them — and the only decision
  // surfaces they accept are the two desktop ones. The routes stay available
  // while the management conversation is not (a pending card outlives any
  // conversation state), and the glance's needs-you items reference the same
  // pending records by the same ids.
  if (url.pathname === "/api/management/decisions" && method === "GET") {
    try {
      const acts = await state.stagedActs.list({ state: "staged" });
      const cards = await composeDecisionCards(acts);
      // Soonest expiry first, matching the glance's needs-you ordering.
      cards.sort((left, right) =>
        compareIsoStrings(left.expiresAt, right.expiresAt) || compareIsoStrings(left.id, right.id));
      sendJson(res, { decisions: cards });
    } catch (error) {
      sendFoldDecisionError(res, error);
    }
    return;
  }
  const decisionDecideMatch = match(url.pathname, /^\/api\/management\/decisions\/([^/]+)\/decide$/);
  if (decisionDecideMatch && method === "POST") {
    const body = await readJsonBody<{ decision?: unknown; surface?: unknown; note?: unknown; fileGrantRoot?: unknown }>(state, req);
    if (body.decision !== "approved" && body.decision !== "denied") {
      throw badRequest("The decision must be approved or denied.");
    }
    // Surface attribution is the compensating control on decision receipts:
    // this renderer lane records exactly which desktop surface clicked.
    // `remote_web` arrives only through the approved browser's signed
    // envelope, and `policy` only from host-side evaluation — neither is
    // acceptable from a renderer request.
    if (body.surface !== "popover" && body.surface !== "main-window") {
      throw badRequest("The decision surface must be popover or main-window.");
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      throw badRequest("A denial note must be a string.");
    }
    if (body.note !== undefined && body.decision !== "denied") {
      throw badRequest("A note is offered only with a denial.");
    }
    // The app.grant.files decision-time supplement: the person-chosen
    // Space-relative root from the desktop folder picker
    // (docs/fold-consecrations.md). Renderer-session approvals only — the
    // remote decide operation carries no root, so remote approvals of file
    // grants stay honestly ineligible rather than granting a root no card
    // ever showed.
    if (body.fileGrantRoot !== undefined && body.decision !== "approved") {
      throw badRequest("A chosen folder accompanies only an approval.");
    }
    const fileGrantRoot = body.fileGrantRoot !== undefined ? decisionFileGrantRoot(body.fileGrantRoot) : undefined;
    if (fileGrantRoot !== undefined) state.fileGrantRootChoices.set(decisionDecideMatch[1], fileGrantRoot);
    try {
      const result = await state.foldDecisions.decide(decisionDecideMatch[1], {
        decision: body.decision,
        surface: body.surface,
        ...(body.note !== undefined && body.note.trim() ? { note: body.note } : {}),
      });
      sendJson(res, {
        decision: (await composeDecisionCards([result.act]))[0],
        receipted: result.receipted,
      });
    } catch (error) {
      sendFoldDecisionError(res, error);
    } finally {
      if (fileGrantRoot !== undefined) state.fileGrantRootChoices.delete(decisionDecideMatch[1]);
    }
    return;
  }
  const decisionCancelMatch = match(url.pathname, /^\/api\/management\/decisions\/([^/]+)\/cancel$/);
  if (decisionCancelMatch && method === "POST") {
    await readJsonBody<Record<string, never>>(state, req);
    try {
      const act = await state.stagedActs.cancel(decisionCancelMatch[1]);
      sendJson(res, { decision: (await composeDecisionCards([act]))[0] });
    } catch (error) {
      sendFoldDecisionError(res, error);
    }
    return;
  }

  // The glance (docs/fold-glance.md): the app-composed digest for the popover
  // and the main window, on the renderer session. Deliberately no
  // management-readiness gate — the digest reads recorded state, not the
  // management Pi session, so it stays available even when management
  // commands fail closed; only narration needs the conversation.
  if (url.pathname === "/api/management/glance" && method === "GET") {
    sendJson(res, { glance: await state.kernel.getGlance({ kind: "renderer" }) });
    return;
  }
  if (url.pathname === "/api/management/glance/seen" && method === "POST") {
    const body = await readJsonBody<{ surface?: unknown; cursor?: unknown }>(state, req);
    // The renderer lane advances only the two desktop surfaces. Remote
    // `remote:<grantId>` markers advance exclusively through the approved
    // browser's signed envelope (`management.glanceSeen`), so one surface can
    // never acknowledge for another.
    if (body.surface !== "popover" && body.surface !== "main-window") {
      throw badRequest("The glance surface must be popover or main-window.");
    }
    if (typeof body.cursor !== "string" || !parseWorkFoldGlanceCursor(body.cursor)) {
      throw badRequest("A rendered glance cursor is required to mark seen.");
    }
    // Monotonic by construction: fetching never advances a marker, a replayed
    // or backward advance is a no-op, and a failed write only leaves items
    // rendering as new.
    sendJson(res, await state.glanceSeen.advance(body.surface, body.cursor));
    return;
  }

  // Standing policies (docs/fold-consecrations.md §Standing policies):
  // authoring is a desktop-human act in Settings → The fold, so these routes
  // exist only on the renderer session and hold the one minted Settings
  // writer. Refusal elsewhere is by construction, not by filter: the act
  // facade has no policy methods, the act CLI has no policy verbs, and the
  // remote operation vocabulary has no policy operation — standing-policy
  // authoring is never-list entry 4, and the fold may cite policies (reads,
  // exercised receipts) but never write them.
  if (url.pathname === "/api/settings/fold-policies" && method === "GET") {
    try {
      let policies: Awaited<ReturnType<FoldStandingPolicyStore["list"]>> = [];
      try {
        policies = await state.foldPolicies.list();
      } catch (error) {
        // A damaged store still renders in Settings: status says why every
        // policy is disabled, and recovery happens outside the product.
        if (!(error instanceof FoldPolicyError && error.code === "STORE_DAMAGED")) throw error;
      }
      sendJson(res, {
        policies,
        status: state.foldPolicies.status(),
        contract: foldPolicySettingsContract(),
      });
    } catch (error) {
      sendFoldPolicyError(res, error);
    }
    return;
  }
  if (url.pathname === "/api/settings/fold-policies" && method === "POST") {
    const body = await readJsonBody<{ label?: unknown; kind?: unknown; match?: unknown; enabled?: unknown }>(state, req);
    try {
      const policy = await state.foldPolicies.createPolicy(state.foldPolicyWriter, {
        label: String(body.label ?? ""),
        kind: body.kind as FoldPolicyEligibleKind,
        match: foldPolicyMatchInput(body.match),
        ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      });
      sendJson(res, { policy, status: state.foldPolicies.status() }, 201);
    } catch (error) {
      sendFoldPolicyError(res, error);
    }
    return;
  }
  if (url.pathname === "/api/settings/fold-policies/reattest" && method === "POST") {
    await readJsonBody<Record<string, never>>(state, req);
    try {
      sendJson(res, { status: await state.foldPolicies.reattest(state.foldPolicyWriter) });
    } catch (error) {
      sendFoldPolicyError(res, error);
    }
    return;
  }
  const policyEnableMatch = match(url.pathname, /^\/api\/settings\/fold-policies\/([^/]+)\/(enable|disable)$/);
  if (policyEnableMatch && method === "POST") {
    await readJsonBody<Record<string, never>>(state, req);
    try {
      const policy = await state.foldPolicies.setPolicyEnabled(
        state.foldPolicyWriter,
        policyEnableMatch[1],
        policyEnableMatch[2] === "enable",
      );
      sendJson(res, { policy, status: state.foldPolicies.status() });
    } catch (error) {
      sendFoldPolicyError(res, error);
    }
    return;
  }
  const policyMatch = match(url.pathname, /^\/api\/settings\/fold-policies\/([^/]+)$/);
  if (policyMatch && method === "PATCH") {
    const body = await readJsonBody<{ label?: unknown; match?: unknown }>(state, req);
    try {
      const policy = await state.foldPolicies.updatePolicy(state.foldPolicyWriter, policyMatch[1], {
        ...(body.label !== undefined ? { label: String(body.label) } : {}),
        ...(body.match !== undefined ? { match: foldPolicyMatchInput(body.match) } : {}),
      });
      sendJson(res, { policy, status: state.foldPolicies.status() });
    } catch (error) {
      sendFoldPolicyError(res, error);
    }
    return;
  }
  if (policyMatch && method === "DELETE") {
    try {
      const policy = await state.foldPolicies.removePolicy(state.foldPolicyWriter, policyMatch[1]);
      sendJson(res, { policy, status: state.foldPolicies.status() });
    } catch (error) {
      sendFoldPolicyError(res, error);
    }
    return;
  }

  // Pages your fold serves (docs/fold-publishing.md, plan item 5): the
  // desktop Settings surface over the publication authority. Reads list the
  // grant records with their budgets, tallies, and health notes; the
  // narrowing verbs — revoke, cut budgets, snapshot off — are direct
  // receipted acts minted with a per-request id and the main-window surface.
  // Widening has no route here: a new slot, raised budgets, or snapshot-on
  // is a fresh consecration staged through the fold and decided on a
  // needs-you card. The reveal route composes the share link's secret
  // fragment on demand from the key store and returns it transiently — it is
  // never listed, journaled, or logged.
  if (url.pathname === "/api/settings/publications" && method === "GET") {
    try {
      const status = state.publications.status();
      const views = status.damaged ? [] : await state.publications.list();
      const publications = [];
      for (const view of views) {
        const registered = await getSpace(view.spaceId).catch(() => null);
        publications.push({ ...view, ...(registered ? { spaceName: registered.name } : {}) });
      }
      sendJson(res, { publications, status });
    } catch (error) {
      sendFoldPublicationError(res, error);
    }
    return;
  }
  const publicationSettingsMatch = match(url.pathname, /^\/api\/settings\/publications\/([^/]+)\/(reveal-link|revoke|narrow|snapshot-off)$/);
  if (publicationSettingsMatch && method === "POST") {
    const publicationId = publicationSettingsMatch[1];
    const action = publicationSettingsMatch[2];
    try {
      if (action === "reveal-link") {
        await readJsonBody<Record<string, never>>(state, req);
        const view = await state.publications.get(publicationId);
        if (!view || view.state !== "active") {
          sendJson(res, { error: "This page is not shared right now." }, 404);
          return;
        }
        const key = await state.publicationKeys.get(publicationId);
        if (!key) {
          sendJson(res, { error: "The page key is missing from secure settings; stop sharing and share the page again." }, 409);
          return;
        }
        sendJson(res, { viewerPath: view.viewerPath, key });
        return;
      }
      // A per-request id keeps each Settings act its own journal entry;
      // surface main-window records where the human clicked.
      const context = { requestId: `settings:${randomUUID()}`, surface: "main-window" as const };
      if (action === "revoke") {
        await readJsonBody<Record<string, never>>(state, req);
        sendJson(res, { publication: await state.publications.revoke(publicationId, context) });
        return;
      }
      if (action === "snapshot-off") {
        await readJsonBody<Record<string, never>>(state, req);
        sendJson(res, { publication: await state.publications.disableSnapshot(publicationId, context) });
        return;
      }
      const body = await readJsonBody<{ serveRatePerMinute?: unknown; byteBudgetPerDay?: unknown }>(state, req);
      const narrowInput: { serveRatePerMinute?: number; byteBudgetPerDay?: number } = {};
      if (body.serveRatePerMinute !== undefined) narrowInput.serveRatePerMinute = Number(body.serveRatePerMinute);
      if (body.byteBudgetPerDay !== undefined) narrowInput.byteBudgetPerDay = Number(body.byteBudgetPerDay);
      sendJson(res, { publication: await state.publications.narrowBudgets(publicationId, narrowInput, context) });
      return;
    } catch (error) {
      sendFoldPublicationError(res, error);
    }
    return;
  }

  const extensionResponseMatch = match(url.pathname, /^\/api\/spaces\/([^/]+)\/conversations\/([^/]+)\/extension-ui\/([^/]+)$/);
  if (method === "POST" && extensionResponseMatch) {
    const space = await getSpace(extensionResponseMatch[1]);
    const request = state.extensionRequests.get(extensionResponseMatch[3]);
    if (!request || request.spaceRoot !== space.spaceRoot || request.conversationId !== extensionResponseMatch[2]) {
      throw notFound("Extension request not found or already completed.");
    }
    const body = await readJsonBody<{ value?: unknown; cancelled?: boolean }>(state, req);
    const accepted = body.cancelled
      ? state.extensionUi.cancel(request.id)
      : state.extensionUi.respond(request.id, extensionResponse(request, body.value));
    if (accepted) state.extensionRequests.delete(request.id);
    sendJson(res, { accepted });
    return;
  }

  throw notFound("Not found.");
}

/**
 * Shared turn-acceptance path for the renderer route and the CLI act facade.
 * Owns the conflict checks, runningTurns bookkeeping, kernel task record, user
 * message persistence with rollback, and the detached Pi turn start, so every
 * caller obeys identical concurrency and persistence rules.
 */
async function acceptConversationTurn(
  state: LocalApiState,
  space: { id: string; spaceRoot: string },
  conversationId: string,
  input: {
    content: string;
    contextPaths: string[];
    selectedPath: string | null;
    /** `system` marks turns app code dispatches (routing chat hops). */
    actorKind: "assistant" | "cli" | "renderer" | "system";
    /** Management-scope reference attachments; never used for Space Chats. */
    managementAttachments?: ManagementAttachmentRef[];
    /** Previous needs-you request whose audit trail this reply continues. */
    continuedFromManagementTaskId?: string;
    /** Remote provenance is persisted with the message and management request. */
    remotePrincipal?: WorkFoldRemotePrincipal;
    /** Stable caller identity. Replays with the same input return the original acceptance. */
    requestId?: string;
    /** Stable optimistic message identity supplied by renderer clients. */
    userMessageId?: string;
  },
): Promise<{ message: { id: string; role: "user"; content: string; createdAt: string }; taskId: string; replayed: boolean }> {
  if (!state.acceptingTurns) throw httpError(503, "work-fold is closing and cannot accept another Assistant turn.");
  const turnKey = clientKey(space.id, conversationId);
  const existing = await readConversationSummary(space.spaceRoot, conversationId);
  if (!existing) throw notFound("Conversation not found.");
  const requestId = turnIdentity(input.requestId ?? (input.remotePrincipal
    ? `remote-${createHash("sha256").update(`${input.remotePrincipal.browserId}\u0000${input.remotePrincipal.grantId}\u0000${input.remotePrincipal.requestId}`).digest("hex")}`
    : `request-${randomUUID()}`), "request id");
  const requestDigest = assistantTurnRequestDigest(input);
  const prior = state.turnStore.findRequest(space.id, conversationId, requestId);
  let durable: WorkFoldDurableTurnRecord | null = null;
  if (prior) {
    if (prior.requestDigest !== requestDigest) throw httpError(409, "This turn request id was already used for different input.");
    if (!prior.userMessagePersisted) {
      if (state.runningTurns.has(turnKey)) throw httpError(409, "This Assistant turn is still being accepted.");
      durable = await state.turnStore.resumeUnpersisted(prior.turnId);
      if (!durable || durable.userMessagePersisted) throw httpError(409, "This Assistant turn can no longer be resumed safely.");
      state.settledTurns.delete(prior.turnId);
    } else {
      const messages = await readConversation(space.spaceRoot, conversationId);
      const persisted = messages.find((candidate) => candidate.id === prior.userMessageId && candidate.role === "user");
      return {
        message: persisted
          ? { id: persisted.id, role: "user", content: persisted.content, createdAt: persisted.createdAt }
          : { id: prior.userMessageId, role: "user", content: input.content, createdAt: prior.userMessageCreatedAt },
        taskId: prior.turnId,
        replayed: true,
      };
    }
  }
  if (existing.archivedAt) throw httpError(409, "Restore this Chat before sending another message.");
  if (existing.snoozedUntil && Date.parse(existing.snoozedUntil) > Date.now()) {
    throw httpError(409, "Resume this Chat before sending another message.");
  }
  assertNoCapabilityMutationForTurn(state, space.id);
  if (state.compactingConversations.has(turnKey)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  if (state.runningTurns.has(turnKey)) throw httpError(409, "Wait for the current agent turn to finish.");
  state.runningTurns.add(turnKey);
  const userMessageId = turnIdentity(input.userMessageId ?? `message-${randomUUID()}`, "user message id");
  const userMessageCreatedAt = new Date().toISOString();
  try {
    if (durable) {
      // The durable reservation was reopened above after an explicit retry.
    } else {
      const accepted = await state.turnStore.accept({
        requestId,
        requestDigest,
        userMessageId,
        userMessageCreatedAt,
        spaceId: space.id,
        conversationId,
        actorKind: input.actorKind,
      });
      if (accepted.replayed) {
        state.runningTurns.delete(turnKey);
        return {
          message: { id: accepted.record.userMessageId, role: "user", content: input.content, createdAt: accepted.record.userMessageCreatedAt },
          taskId: accepted.record.turnId,
          replayed: true,
        };
      }
      durable = accepted.record;
    }
  } catch (error) {
    state.runningTurns.delete(turnKey);
    if (error instanceof WorkFoldTurnReplayConflictError) throw httpError(409, error.message);
    throw error;
  }
  if (!durable) throw new Error("Assistant turn reservation was not created.");
  const task = state.kernel.startTask({
    id: durable.turnId,
    kind: "assistant_turn",
    spaceId: space.id,
    conversationId,
    actor: { kind: input.actorKind, cwd: space.spaceRoot, spaceId: space.id, conversationId },
  });
  state.activeTurnTasks.set(task.id, { spaceId: space.id, conversationId });
  state.activeTurnIdsByKey.set(turnKey, task.id);
  resetChatEventTurn(state, turnKey);
  const managementAttachments = space.id === workFoldManagementScopeId
    ? input.managementAttachments ?? []
    : undefined;
  if (managementAttachments) {
    state.managementRequests.begin({
      taskId: task.id,
      conversationId,
      content: input.content,
      attachments: managementAttachments,
      ...(input.continuedFromManagementTaskId
        ? { continuedFromTaskId: input.continuedFromManagementTaskId }
        : {}),
      ...(input.remotePrincipal ? {
        source: "remote_web" as const,
        remotePrincipalId: input.remotePrincipal.browserId,
        remoteGrantId: input.remotePrincipal.grantId,
        remoteRequestId: input.remotePrincipal.requestId,
      } : {}),
    });
  }
  broadcast(state, turnKey, turnStateEvent(conversationId, true));
  const message = {
    id: durable.userMessageId,
    role: "user" as const,
    content: input.content,
    createdAt: durable.userMessageCreatedAt,
    turnId: task.id,
    requestId,
    ...(managementAttachments?.length
      ? { attachments: managementAttachments.map((ref) => ({ kind: ref.kind, target: ref.target, name: ref.name })) }
      : {}),
    ...(input.remotePrincipal ? {
      source: "remote_web" as const,
      remotePrincipalId: input.remotePrincipal.browserId,
      remoteGrantId: input.remotePrincipal.grantId,
      remoteRequestId: input.remotePrincipal.requestId,
    } : {}),
  };
  try {
    await appendMessage(space.spaceRoot, conversationId, message);
    await state.turnStore.markRunning(task.id);
  } catch (error) {
    state.runningTurns.delete(turnKey);
    state.activeTurnTasks.delete(task.id);
    state.cancelledTurnTasks.delete(task.id);
    state.activeTurnIdsByKey.delete(turnKey);
    state.kernel.finishTask(task.id);
    await state.turnStore.settle(task.id, { status: "failed", error: "The accepted user message could not be persisted." }).catch(() => undefined);
    if (managementAttachments) state.managementRequests.finish(task.id, "failed");
    broadcast(state, turnKey, turnStateEvent(conversationId, false));
    throw error;
  }
  const turn = runAgentTurn(
    state,
    space.id,
    space.spaceRoot,
    conversationId,
    input.content,
    input.contextPaths,
    input.selectedPath,
    task.id,
    managementAttachments,
  );
  state.activeTurnPromises.add(turn);
  void turn.then(
    () => state.activeTurnPromises.delete(turn),
    (error) => {
      state.activeTurnPromises.delete(turn);
      console.error(`Accepted Assistant turn escaped its settlement path: ${errorMessage(error)}`);
    },
  );
  return { message, taskId: task.id, replayed: false };
}

/**
 * Delivers a message into the Chat's running turn through Pi's steering queue
 * and records it in the transcript as part of that turn. When no turn is
 * running (or it settles first) the caller receives 409 and sends normally;
 * nothing is appended in that case.
 */
async function steerConversationTurn(
  state: LocalApiState,
  space: { id: string; spaceRoot: string },
  conversationId: string,
  input: { content: string; requestId?: string; userMessageId?: string },
): Promise<{ message: ChatMessage; taskId: string; replayed: boolean }> {
  const key = clientKey(space.id, conversationId);
  const taskId = state.activeTurnIdsByKey.get(key);
  const client = state.clients.get(key);
  if (!taskId || !client || !state.runningTurns.has(key)) {
    throw httpError(409, "No Assistant turn is running in this Chat; send the message normally.");
  }
  const requestId = turnIdentity(input.requestId ?? `steer-${randomUUID()}`, "request id");
  const replayKey = `${key}\u0000${requestId}`;
  const prior = state.steeredMessages.get(replayKey);
  if (prior) return { message: prior, taskId, replayed: true };
  const message: ChatMessage = {
    id: turnIdentity(input.userMessageId ?? `message-${randomUUID()}`, "user message id"),
    role: "user",
    content: input.content,
    createdAt: new Date().toISOString(),
    turnId: taskId,
    requestId,
    delivery: "steer",
  };
  try {
    await client.steer(input.content);
  } catch (error) {
    if (isPiTurnNotRunningError(error)) throw httpError(409, errorMessage(error));
    throw error;
  }
  await appendMessage(space.spaceRoot, conversationId, message);
  state.steeredMessages.set(replayKey, message);
  if (state.steeredMessages.size > maxRememberedSteeredMessages) {
    const oldest = state.steeredMessages.keys().next().value;
    if (oldest !== undefined) state.steeredMessages.delete(oldest);
  }
  broadcast(state, streamKey(space.id, conversationId), {
    type: "status",
    conversationId,
    message: "Your message will reach the Assistant after its current step.",
  });
  return { message, taskId, replayed: false };
}

const maxRememberedSteeredMessages = 500;

function assistantTurnRequestDigest(input: {
  content: string;
  contextPaths: string[];
  selectedPath: string | null;
  managementAttachments?: ManagementAttachmentRef[];
  actorKind?: string;
  continuedFromManagementTaskId?: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    content: input.content,
    contextPaths: input.contextPaths,
    selectedPath: input.selectedPath,
    actorKind: input.actorKind ?? null,
    continuedFromManagementTaskId: input.continuedFromManagementTaskId ?? null,
    managementAttachments: (input.managementAttachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      target: attachment.target,
      name: attachment.name,
    })),
  })).digest("hex");
}

function optionalTurnIdentity(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : turnIdentity(value, label);
}

function turnIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest(`${label} is invalid.`);
  }
  return value;
}

function conversationIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw badRequest("conversationId is invalid.");
  }
  return value;
}

async function createSpaceInternal(state: LocalApiState, name: string): Promise<SpaceSummary> {
  const space = await createManagedSpace(name, state.spaceBase);
  state.spaceTrustAuthority.grant(space.spaceRoot);
  return space;
}

async function registerSpaceInternal(state: LocalApiState, rootPath: string, providerHint?: "google-drive"): Promise<SpaceSummary> {
  const space = await registerLinkedSpace(rootPath, providerHint);
  state.spaceTrustAuthority.grant(space.spaceRoot);
  // Copy-level note when a suspended routing's missing Space returns with its
  // portable identity; the routing stays suspended — registration never
  // silently re-arms standing behavior — so a failure to note it is tolerable.
  await state.routings.handleSpaceReRegistered(space.id).catch(() => undefined);
  return space;
}

/**
 * The one Space-removal path, shared by the desktop DELETE route, the staged
 * `space.delete-folder` decision, and the act facade's `spaces unregister`:
 * App Studio impact checks, the durable removal intent, runtime-authorization
 * revocation, per-service app-state cleanup with the crash-safe pending
 * result, and finalization. A linked registration removal always leaves the
 * folder and its portable `.work-fold/` identity in place; a managed Space
 * deletes its folder tree unless the caller passes the preserve disposition
 * (the act lane's `spaces unregister`), which records an intent that provably
 * holds no deletion authority.
 */
async function removeSpaceRegistrationInternal(
  state: LocalApiState,
  space: SpaceSummary,
  options: { managedFolderDisposition?: "delete" | "preserve" } = {},
): Promise<SpaceRemovalResult> {
  const affectedSpaceIds = await state.restrictedApps.spaceRemovalMutationSpaceIds(space.id);
  return runRestrictedAppMutations(state, affectedSpaceIds, async () => {
    const releaseCheckRemoval = state.checks.tryReserveSpaceRemoval(space.id);
    if (!releaseCheckRemoval) throw httpError(409, "Wait for the current Check operation before removing this Space.");
    try {
      const impact = await state.restrictedApps.spaceRemovalImpact(space.id);
      if (impact.activeSourceInstanceCount > 0 || impact.activeTargetInstanceCount > 0) {
        throw badRequest("Uninstall release-backed Apps from this Space before removing it.");
      }
      if (impact.retainedDataCount > 0) {
        throw badRequest("Purge this App Project's retained local data in App Studio before removing its source Space.");
      }
      // Outward exposure blocks removal: a page served from this Space must be
      // revoked first, and a damaged publication store cannot prove the Space
      // is unpublished, so both refuse here before any state changes.
      let livePublications;
      try {
        livePublications = await state.publications.activePublicationsForSpace(space.id);
      } catch (error) {
        throw httpError(409, errorMessage(error));
      }
      if (livePublications.length) {
        const named = livePublications.slice(0, 3).map((publication) => `"${publication.title}"`).join(", ");
        const more = livePublications.length > 3 ? ", …" : "";
        throw badRequest(
          `Stop sharing ${livePublications.length === 1 ? "the page" : `${livePublications.length} pages`} `
            + `served from this Space before removing it: ${named}${more}.`,
        );
      }
      const intent = await beginSpaceRemoval(space.id, state.spaceBase, state.spaceRemovalIo, {
        ...(options.managedFolderDisposition ? { folderDisposition: options.managedFolderDisposition } : {}),
      });
      state.restrictedApps.fenceSpaceRemoval(space.id);
      state.spaceTrustAuthority.revoke(space.spaceRoot);
      state.spaceIdsByRoot.delete(spaceRootKey(space.spaceRoot));
      await invalidateWorkFoldClients(state, space.id);
      closeSpaceStreams(state, space.id);
      for (const request of [...state.extensionRequests.values()]) {
        if (request.spaceRoot !== space.spaceRoot) continue;
        state.extensionUi.cancel(request.id);
        state.extensionRequests.delete(request.id);
      }
      try {
        await state.checks.removeSpace(space.id);
      } catch {
        return spaceRemovalPendingResult(intent);
      }
      // The same revocation moment as Check authority: enabled routings
      // referencing this Space suspend (their active runs stop), and pending
      // staged cards pinned to it are canceled. Suspension failing leaves the
      // durable intent pending — startup retries the cascade; the staged-act
      // cascade is best-effort because a damaged store already fails staging
      // and deciding closed.
      try {
        await state.routings.handleSpaceRemoved(space.id);
      } catch {
        return spaceRemovalPendingResult(intent);
      }
      await state.stagedActs.cancelForSpace(space.id).catch(() => undefined);
      try {
        await state.restrictedApps.removeSpace(space.id);
        await state.restrictedAppProposals.removeSpace(space.id);
      } catch {
        return spaceRemovalPendingResult(intent);
      }
      try {
        await markSpaceRemovalAppStateRemoved(intent.spaceId, state.spaceRemovalIo);
      } catch {
        return spaceRemovalPendingResult(intent);
      }
      const result = await finalizeSpaceRemoval(intent.spaceId, state.spaceRemovalIo);
      if (!result.cleanupPending) await state.appearance.removeSpace(space.id);
      if (!result.cleanupPending) state.restrictedApps.releaseSpaceRemovalFence(space.id);
      return result;
    } finally {
      releaseCheckRemoval();
    }
  }, { requiredSpaceIds: [space.id] });
}

const maxActAddSources = 25;

/**
 * Dedicated remote semantic adapter. The desktop relay can invoke only these
 * bounded operations; it never receives the renderer session token or a
 * generic local-HTTP tunnel. Every Assistant send still enters the canonical
 * management conversation through the shared acceptance path.
 */
function createWorkFoldRemoteFacade(state: LocalApiState): WorkFoldRemoteFacade {
  /**
   * Bounded live watch (management.watch): subscribes to the same in-process
   * publish point the local SSE streams ride, forwards the popover's
   * activity vocabulary as throttled ticks, and resolves on settle or when
   * the watch window closes — always under the remote operation timeout so
   * the browser is never left waiting on a dead watch.
   */
  async function watchManagementTurn(
    rawInput: unknown,
    principal: WorkFoldRemotePrincipal,
    emit: (progress: WorkFoldRemoteWatchProgress) => void,
  ): Promise<unknown> {
    assertRemotePrincipal(principal);
    const input = remoteInput(rawInput);
    assertRemoteKeys(input, ["conversationId"]);
    assertManagementReadyForRoutes(state);
    const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
    const conversation = await readConversationSummary(workFoldManagementRoot(), conversationId);
    if (!conversation) throw notFound("Conversation not found.");
    const key = streamKey(workFoldManagementScopeId, conversationId);
    if (!state.runningTurns.has(key)) return { state: "idle", settled: false };
    return new Promise((resolveWatch) => {
      const watchWindowMs = 90_000;
      const minimumTickMs = 1_000;
      let lastActivity = "";
      let lastEmitAt = 0;
      let pendingActivity: string | null = null;
      let tickTimer: NodeJS.Timeout | null = null;
      let windowTimer: NodeJS.Timeout | null = null;
      const listeners = state.chatEventListeners.get(key) ?? new Set<(event: unknown) => void>();
      state.chatEventListeners.set(key, listeners);
      const finish = (result: { state: "settled" | "running"; settled: boolean }) => {
        listeners.delete(listener);
        if (!listeners.size) state.chatEventListeners.delete(key);
        if (windowTimer) clearTimeout(windowTimer);
        if (tickTimer) clearTimeout(tickTimer);
        resolveWatch(result);
      };
      const flush = () => {
        tickTimer = null;
        if (pendingActivity === null || pendingActivity === lastActivity) { pendingActivity = null; return; }
        lastActivity = pendingActivity;
        pendingActivity = null;
        lastEmitAt = Date.now();
        emit({ activity: lastActivity });
      };
      const queueActivity = (activity: string) => {
        pendingActivity = activity;
        if (tickTimer) return;
        tickTimer = setTimeout(flush, Math.max(0, minimumTickMs - (Date.now() - lastEmitAt)));
      };
      const listener = (event: unknown) => {
        if (!event || typeof event !== "object") return;
        const data = event as { type?: unknown; message?: unknown; toolName?: unknown; running?: unknown };
        if (data.type === "status" || data.type === "tool") {
          const message = typeof data.message === "string" && data.message !== "Connected." ? data.message.trim() : "";
          const tool = data.type === "tool" && typeof data.toolName === "string" ? data.toolName.trim() : "";
          const activity = message || tool;
          if (activity) queueActivity(activity);
          return;
        }
        if (data.type === "done" || data.type === "error" || (data.type === "turn_state" && data.running === false)) {
          finish({ state: "settled", settled: true });
        }
      };
      listeners.add(listener);
      windowTimer = setTimeout(() => finish({ state: "running", settled: false }), watchWindowMs);
      // The turn can settle between the running check and this subscription.
      if (!state.runningTurns.has(key)) finish({ state: "settled", settled: true });
    });
  }
  return {
    async purgeUploads(grantId) {
      const root = remoteManagementUploadRoot(workFoldManagementRoot());
      if (!grantId) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      await rm(join(root, safeRemoteUploadSegment(grantId)), { recursive: true, force: true });
    },
    async revokeGrantAuthority(grantId) {
      // Browser revocation's desktop-local cascade (docs/fold-consecrations.md):
      // pending staged acts whose staging provenance traces to the revoked
      // grant are canceled — a compromised browser cannot leave a card behind
      // as a time bomb — and the grant's `remote:<grantId>` glance marker goes
      // with the rest of its state. Decided acts stand; their receipts name
      // the browser that made them. Every lane is attempted so one failure
      // cannot silently skip the rest.
      const failures: string[] = [];
      try {
        if (grantId !== undefined) {
          await state.stagedActs.cancelForBrowserGrant({ grantId });
        } else {
          const remoteGrantIds = new Set(
            (await state.stagedActs.list({ state: "staged" }))
              .map((act) => act.provenance.grantId)
              .filter((value): value is string => typeof value === "string"),
          );
          for (const staleGrantId of remoteGrantIds) {
            await state.stagedActs.cancelForBrowserGrant({ grantId: staleGrantId });
          }
        }
      } catch (error) {
        failures.push(`Could not cancel the browser's pending staged acts: ${errorMessage(error)}`);
      }
      try {
        if (grantId !== undefined) {
          await state.glanceSeen.removeSurface(workFoldGlanceRemoteSurfaceId(grantId));
        } else {
          const seen = await state.glanceSeen.read();
          for (const surfaceId of Object.keys(seen.surfaces)) {
            if (surfaceId.startsWith("remote:")) await state.glanceSeen.removeSurface(surfaceId);
          }
        }
      } catch (error) {
        failures.push(`Could not remove the browser's glance marker: ${errorMessage(error)}`);
      }
      if (failures.length) throw new Error(failures.join(" "));
    },
    watch: watchManagementTurn,
    async execute(operation, rawInput, principal) {
      assertRemotePrincipal(principal);
      const input = remoteInput(rawInput);
      switch (operation) {
        case "management.summary": {
          assertRemoteKeys(input, ["conversationId"]);
          assertManagementReadyForRoutes(state);
          const requestedConversationId = input.conversationId === undefined
            ? null
            : remoteStableId(input.conversationId, "conversation id", 160);
          const conversation = requestedConversationId
            ? await readConversationSummary(workFoldManagementRoot(), requestedConversationId)
            : await resolveManagementConversation(false).catch(() => null);
          if (requestedConversationId && !conversation) throw notFound("Conversation not found.");
          const latest = conversation
            ? state.managementRequests.latestForConversation(conversation.id)
            : null;
          const owned = latest ? isRemoteManagementRequestOwner(latest, principal) : false;
          return {
            available: true,
            conversation: conversation ? toActConversationRef(conversation) : null,
            state: conversation ? conversationRuntimeState(state, workFoldManagementScopeId, conversation.id) : "idle",
            latestRequest: latest
              ? remoteManagementRequest(await managementRequestView(state, latest.taskId), { owned })
              : null,
            // Capability advertisement: the browser starts a live watch only
            // after seeing this, so an older desktop is never asked for an
            // operation it cannot answer.
            capabilities: { watch: true },
          };
        }
        case "management.chats": {
          assertRemoteKeys(input, []);
          assertManagementReadyForRoutes(state);
          const conversations = await listConversations(workFoldManagementRoot());
          const selected = conversations.slice(0, maxRemoteConversationSummaries);
          return {
            conversations: selected.map((conversation) => ({
              ...toActConversationRef(conversation),
              state: remoteManagementConversationState(state, conversation.id),
            })),
            truncated: selected.length < conversations.length,
          };
        }
        case "management.transcript": {
          assertRemoteKeys(input, ["conversationId"]);
          assertManagementReadyForRoutes(state);
          const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
          const messages = await readConversation(workFoldManagementRoot(), conversationId);
          if (!messages.length) throw notFound("Conversation not found.");
          return remoteTranscript(messages);
        }
        case "management.rename": {
          assertRemoteKeys(input, ["conversationId", "title"]);
          assertManagementReadyForRoutes(state);
          const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
          const title = remoteConversationTitle(input.title);
          const provenance = {
            source: "remote_web" as const,
            remotePrincipalId: principal.browserId,
            remoteGrantId: principal.grantId,
            remoteRequestId: principal.requestId,
          };
          const replay = await findRemoteConversationTitleRename(
            workFoldManagementRoot(),
            conversationId,
            provenance,
          );
          const key = clientKey(workFoldManagementScopeId, conversationId);
          if (!replay && remoteManagementConversationState(state, conversationId) === "running") {
            throw httpError(409, "Wait for the current Assistant turn to finish.");
          }
          if (!replay && state.compactingConversations.has(key)) {
            throw httpError(409, "Wait for the current Chat compaction to finish.");
          }
          const conversation = replay ?? await renameConversation(
            workFoldManagementRoot(),
            conversationId,
            title,
            provenance,
          );
          if (!replay) state.clients.get(key)?.setSessionName(conversation.title);
          return {
            conversation: toActConversationRef(conversation),
            state: conversationRuntimeState(state, workFoldManagementScopeId, conversationId),
          };
        }
        case "management.send": {
          assertRemoteKeys(input, ["content", "conversationId", "newConversation", "attachments"]);
          assertManagementReadyForRoutes(state);
          const content = remoteContent(input.content);
          const scope = managementScopeForRoutes(state);
          const conversationIdInput = input.conversationId === undefined
            ? null
            : remoteStableId(input.conversationId, "conversation id", 160);
          if (input.newConversation !== undefined && typeof input.newConversation !== "boolean") {
            throw badRequest("newConversation must be a boolean.");
          }
          if (input.newConversation === true && conversationIdInput) {
            throw badRequest("Use either conversationId or newConversation, not both.");
          }
          // Idempotency must be checked before creating a requested new
          // conversation. A recovered signed request may arrive after the
          // desktop response cache is gone; creating first would leave an
          // extra empty transcript on every replay.
          const existingRemoteRequest = await findRemoteConversationRequest(scope.rootPath, principal);
          if (existingRemoteRequest) {
            return {
              accepted: true,
              duplicate: true,
              conversationId: existingRemoteRequest.conversationId,
              message: remoteChatMessage(existingRemoteRequest.message),
              taskId: null,
            };
          }
          const conversation = input.newConversation === true
            ? await createConversation(scope.rootPath)
            : conversationIdInput
              ? await readConversationSummary(scope.rootPath, conversationIdInput)
              : await resolveManagementConversation(true);
          if (!conversation) throw notFound("Conversation not found.");
          const latest = state.managementRequests.latestForConversation(conversation.id);
          const latestView = latest && latest.conversationId === conversation.id
            ? await managementRequestView(state, latest.taskId)
            : null;
          const continuedFromManagementTaskId = latestView?.phase === "needs_you" ? latestView.taskId : undefined;
          const staged = await stageRemoteManagementUploads(
            scope.rootPath,
            input.attachments,
            principal.grantId,
            principal.requestId,
          );
          try {
            const { message, taskId } = await acceptConversationTurn(
              state,
              { id: scope.id, spaceRoot: scope.rootPath },
              conversation.id,
              {
                content,
                contextPaths: [],
                selectedPath: null,
                actorKind: "renderer",
                managementAttachments: staged.attachments,
                ...(continuedFromManagementTaskId ? { continuedFromManagementTaskId } : {}),
                remotePrincipal: principal,
              },
            );
            return {
              accepted: true,
              conversationId: conversation.id,
              message: remoteChatMessage(message),
              taskId,
              uploads: staged.uploads,
            };
          } catch (error) {
            await staged.rollback();
            throw error;
          }
        }
        case "management.request": {
          assertRemoteKeys(input, ["taskId"]);
          assertManagementReadyForRoutes(state);
          const taskId = remoteStableId(input.taskId, "task id", 160);
          assertRemoteManagementRequestOwner(state, taskId, principal);
          const request = await managementRequestView(state, taskId);
          if (!request) throw notFound("Request not found. Request details are kept while work-fold stays running.");
          return { request: remoteManagementRequest(request, { owned: true }) };
        }
        case "management.stop": {
          assertRemoteKeys(input, ["taskId"]);
          assertManagementReadyForRoutes(state);
          const taskId = remoteStableId(input.taskId, "task id", 160);
          assertRemoteManagementRequestOwner(state, taskId, principal);
          return { stopped: await stopManagementRequest(state, taskId) };
        }
        case "decisions.list": {
          // The same host-composed card projection every desktop surface
          // renders (docs/fold-consecrations.md): every approved browser sees
          // the same pending cards, soonest expiry first. Cards carry
          // `desktopOnly` and `stagedByGrantId`, so the client states the two
          // surface rules up front instead of discovering refusals. No
          // management-readiness gate: a pending card outlives any
          // conversation state.
          assertRemoteKeys(input, []);
          const acts = await state.stagedActs.list({ state: "staged" });
          const cards = await composeDecisionCards(acts);
          cards.sort((left, right) =>
            compareIsoStrings(left.expiresAt, right.expiresAt) || compareIsoStrings(left.id, right.id));
          return { decisions: cards };
        }
        case "decisions.decide": {
          assertRemoteKeys(input, ["id", "decision", "note"]);
          const id = remoteStableId(input.id, "decision id", 160);
          if (input.decision !== "approved" && input.decision !== "denied") {
            throw badRequest("The decision must be approved or denied.");
          }
          if (input.note !== undefined && typeof input.note !== "string") {
            throw badRequest("A denial note must be a string.");
          }
          if (input.note !== undefined && input.decision !== "denied") {
            throw badRequest("A note is offered only with a denial.");
          }
          // Surface attribution comes from the transport, never the payload:
          // the desktop dispatch re-verified this grant against Remote access
          // settings immediately before execution, and that recheck's
          // browserId/grantId land on the decision receipt — the compensating
          // control the remote-clicks decision recorded. Eligibility, pin
          // recheck, journal-first consumption, and execution all run
          // desktop-side in the shared decision path.
          const result = await state.foldDecisions.decide(id, {
            decision: input.decision,
            surface: "remote_web",
            browserId: principal.browserId,
            grantId: principal.grantId,
            ...(typeof input.note === "string" && input.note.trim() ? { note: input.note } : {}),
          });
          return {
            decision: (await composeDecisionCards([result.act]))[0],
            receipted: result.receipted,
          };
        }
        case "management.glance": {
          // App-composed digest over recorded state (docs/fold-glance.md).
          // Cross-grant hygiene: the projection carries only the requesting
          // grant's own seen marker, so one phone never reads another's
          // acknowledgements. No management-readiness gate — the digest stays
          // available even when management commands fail closed.
          assertRemoteKeys(input, []);
          const snapshot = await state.kernel.getGlance({ kind: "renderer" });
          const surfaceId = workFoldGlanceRemoteSurfaceId(principal.grantId);
          return {
            glance: {
              ...snapshot,
              seen: surfaceId in snapshot.seen ? { [surfaceId]: snapshot.seen[surfaceId] } : {},
            },
          };
        }
        case "management.glanceSeen": {
          // Advances only this grant's own `remote:<grantId>` marker, and only
          // monotonically — a replayed or reordered advance is a no-op, and a
          // refused advance merely leaves items rendering as new.
          assertRemoteKeys(input, ["cursor"]);
          if (typeof input.cursor !== "string" || !parseWorkFoldGlanceCursor(input.cursor)) {
            throw badRequest("A rendered glance cursor is required to mark seen.");
          }
          return await state.glanceSeen.advance(workFoldGlanceRemoteSurfaceId(principal.grantId), input.cursor);
        }
        case "spaces.list": {
          assertRemoteKeys(input, []);
          const spaces = (await state.kernel.getSpaces({ kind: "renderer" })).spaces;
          return { spaces: spaces.map((space) => ({ id: space.id, name: space.name })) };
        }
        case "spaces.tree": {
          assertRemoteKeys(input, ["spaceId", "path"]);
          const spaceId = remoteStableId(input.spaceId, "Space id", 512);
          const path = input.path === undefined ? "" : remoteRelativePath(input.path);
          const space = await getSpace(spaceId);
          const scan = await scanSpaceTree(space.spaceRoot, 0, path, { includeIgnored: false });
          const maximumEntries = 500;
          const tree: WorkFoldRemoteTreeResult["tree"] = scan.entries.slice(0, maximumEntries).map((entry) => ({
            name: entry.name,
            path: entry.path,
            kind: entry.kind,
            ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
            ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
            ...(entry.hasChildren === undefined ? {} : { hasChildren: entry.hasChildren }),
          }));
          return { tree, truncated: scan.truncated || scan.entries.length > maximumEntries } satisfies WorkFoldRemoteTreeResult;
        }
        case "management.watch":
          return watchManagementTurn(rawInput, principal, () => {});
        default:
          return remoteOperationExhaustive(operation);
      }
    },
  };
}

function remoteManagementRequest(
  request: WorkFoldActManagementRequest | null,
  options: { owned: boolean } = { owned: false },
): unknown {
  if (!request) return null;
  if (!options.owned) {
    return {
      conversationId: request.conversationId,
      phase: request.phase,
      startedAt: request.startedAt,
      endedAt: request.endedAt,
      canStop: false,
      children: request.children.map((child) => ({
        spaceName: child.spaceName,
        state: child.state,
      })),
    };
  }
  return {
    taskId: request.taskId,
    conversationId: request.conversationId,
    phase: request.phase,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    error: request.error,
    content: request.content,
    source: request.source,
    canStop: request.phase === "working" || request.phase === "handed_off",
    children: request.children,
    reply: request.reply,
    attachments: request.attachments.map((attachment) => ({ kind: attachment.kind, name: attachment.name })),
    dispositions: request.dispositions.map((disposition) => ({
      attachment: { kind: disposition.attachment.kind, name: disposition.attachment.name },
      status: disposition.status,
      spaceId: disposition.spaceId,
      spaceName: disposition.spaceName,
      copied: disposition.copied,
      checkpointId: disposition.checkpointId,
    })),
    actions: request.actions.map((action) => ({
      command: action.command,
      at: action.at,
      spaceId: action.spaceId,
      spaceName: action.spaceName,
      copied: action.copied,
      checkpointId: action.checkpointId,
      conversationId: action.conversationId,
      taskId: action.taskId,
    })),
  };
}

function remoteManagementConversationState(
  state: LocalApiState,
  conversationId: string,
): WorkFoldActChatState {
  const direct = conversationRuntimeState(state, workFoldManagementScopeId, conversationId);
  if (direct !== "idle") return direct;
  const latest = state.managementRequests.latestForConversation(conversationId);
  return latest?.childTasks.some((child) => turnStatusFor(state, child.spaceId, child.taskId).state === "running")
    ? "running"
    : "idle";
}

function remoteTranscript(messages: ChatMessage[]): { messages: Array<Record<string, unknown>>; truncated: boolean } {
  const maximumMessages = 500;
  const maximumJsonBytes = 1_200_000;
  const tail = messages.slice(-maximumMessages).map(remoteChatMessage);
  const selected: Array<Record<string, unknown>> = [];
  let bytes = 2;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index]!;
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (selected.length && bytes + messageBytes > maximumJsonBytes) break;
    selected.push(message);
    bytes += messageBytes;
  }
  selected.reverse();
  return {
    messages: selected,
    truncated: messages.length > maximumMessages || selected.length < tail.length || selected.some((message) => message.contentTruncated === true),
  };
}

async function findRemoteConversationRequest(
  rootPath: string,
  principal: WorkFoldRemotePrincipal,
): Promise<{ conversationId: string; message: ChatMessage } | null> {
  const conversations = await listConversations(rootPath);
  const cacheKey = resolve(rootPath);
  const previous = remoteConversationRequestIndexes.get(cacheKey);
  const nextConversations = new Map<string, RemoteConversationRequestIndexEntry>();
  let requestCount = 0;
  let cacheable = conversations.length <= maxRemoteRequestIndexConversations;
  let matchedConversationId: string | null = null;

  for (const conversation of conversations) {
    const transcript = join(conversationsDir(rootPath), `${conversation.id}.jsonl`);
    let info;
    try {
      info = await stat(transcript);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const identity = remoteTranscriptIdentity(info);
    const cached = previous?.conversations.get(conversation.id);
    const requests = cached?.identity === identity
      ? cached.requests
      : (await readConversation(rootPath, conversation.id)).flatMap((candidate) => {
          if (candidate.role !== "user"
            || candidate.source !== "remote_web"
            || !candidate.remotePrincipalId
            || !candidate.remoteRequestId) return [];
          return [{
            remotePrincipalId: candidate.remotePrincipalId,
            ...(candidate.remoteGrantId ? { remoteGrantId: candidate.remoteGrantId } : {}),
            remoteRequestId: candidate.remoteRequestId,
          }];
        });
    requestCount += requests.length;
    if (requestCount > maxRemoteRequestIndexEntries) cacheable = false;
    if (cacheable) nextConversations.set(conversation.id, { identity, requests });
    if (!matchedConversationId && requests.some((candidate) => remoteRequestMatches(candidate, principal))) {
      matchedConversationId = conversation.id;
    }
  }

  if (cacheable) {
    rememberRemoteConversationRequestIndex(cacheKey, { conversations: nextConversations });
  } else {
    // The cache is only an optimization. Oversized stores keep the original
    // authoritative scan rather than dropping older idempotency records.
    remoteConversationRequestIndexes.delete(cacheKey);
  }
  if (matchedConversationId) {
    const message = (await readConversation(rootPath, matchedConversationId))
      .find((candidate) => candidate.role === "user" && remoteRequestMatches(candidate, principal));
    if (message) return { conversationId: matchedConversationId, message };
  }
  return null;
}

interface RemoteConversationRequestRef {
  remotePrincipalId: string;
  remoteGrantId?: string;
  remoteRequestId: string;
}

interface RemoteConversationRequestIndexEntry {
  identity: string;
  requests: RemoteConversationRequestRef[];
}

interface RemoteConversationRequestIndex {
  conversations: Map<string, RemoteConversationRequestIndexEntry>;
}

// This complete derived index is trusted only while every current transcript
// retains the same filesystem identity. Appends, replacements, new Chats, and
// deletions are therefore re-read before a negative lookup can admit a turn.
// It is deliberately bounded; a larger store falls back to the authoritative
// append-only logs, and a restart simply rebuilds it from those logs.
const remoteConversationRequestIndexes = new Map<string, RemoteConversationRequestIndex>();
const maxRemoteRequestIndexRoots = 8;
const maxRemoteRequestIndexConversations = 512;
const maxRemoteRequestIndexEntries = 4_096;

function rememberRemoteConversationRequestIndex(
  rootPath: string,
  index: RemoteConversationRequestIndex,
): void {
  remoteConversationRequestIndexes.delete(rootPath);
  remoteConversationRequestIndexes.set(rootPath, index);
  while (remoteConversationRequestIndexes.size > maxRemoteRequestIndexRoots) {
    const oldest = remoteConversationRequestIndexes.keys().next().value as string | undefined;
    if (!oldest) break;
    remoteConversationRequestIndexes.delete(oldest);
  }
}

function remoteTranscriptIdentity(info: Awaited<ReturnType<typeof stat>>): string {
  return [info.size, info.mtime.toISOString(), info.ctime.toISOString(), info.dev, info.ino].join(":");
}

function remoteRequestMatches(
  candidate: RemoteConversationRequestRef | ChatMessage,
  principal: WorkFoldRemotePrincipal,
): boolean {
  return candidate.remotePrincipalId === principal.browserId
    && candidate.remoteRequestId === principal.requestId
    // Version 0.2.2 persisted browser + request provenance but no grant id.
    // Preserve recovery for those shipped records without weakening the exact
    // browser + grant + request match written by current builds.
    && (candidate.remoteGrantId === undefined || candidate.remoteGrantId === principal.grantId);
}

const maxRemoteConversationSummaries = 100;
const maxRemoteUploadFiles = 6;
const maxRemoteUploadFileBytes = 6 * 1024 * 1024;
const maxRemoteUploadTotalBytes = 8 * 1024 * 1024;
const maxRemoteManagementUploadStorageBytes = 64 * 1024 * 1024;
const remoteManagementUploadTtlMs = 24 * 60 * 60 * 1_000;

interface RemoteUploadFile {
  fileName: string;
  data: Buffer;
}

function remoteUploadFiles(value: unknown): RemoteUploadFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxRemoteUploadFiles) {
    throw badRequest(`Remote chat accepts at most ${maxRemoteUploadFiles} uploaded files.`);
  }
  const files: RemoteUploadFile[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw badRequest("Remote upload metadata is invalid.");
    const record = item as Record<string, unknown>;
    const unknown = Object.keys(record).find((key) => key !== "name" && key !== "data");
    if (unknown) throw badRequest(`Remote uploads do not accept ${unknown}.`);
    const fileName = typeof record.name === "string" ? record.name.trim() : "";
    if (!fileName || fileName.length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(fileName) || fileName === "." || fileName === "..") {
      throw badRequest("Remote upload file names must be plain names of at most 180 characters.");
    }
    if (typeof record.data !== "string" || !/^[A-Za-z0-9_-]*$/.test(record.data)) {
      throw badRequest(`Remote upload data for ${fileName} is invalid.`);
    }
    const data = Buffer.from(record.data, "base64url");
    if (data.toString("base64url") !== record.data) throw badRequest(`Remote upload data for ${fileName} is invalid.`);
    if (data.byteLength > maxRemoteUploadFileBytes) {
      throw badRequest(`${fileName} is larger than the 6 MB remote-upload limit.`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > maxRemoteUploadTotalBytes) throw badRequest("Remote uploads are limited to 8 MB per message.");
    files.push({ fileName, data });
  }
  return files;
}

async function stageRemoteManagementUploads(
  managementRoot: string,
  value: unknown,
  grantId: string,
  requestId: string,
): Promise<{
  attachments: ManagementAttachmentRef[];
  uploads: Array<{ name: string; sizeBytes: number }>;
  rollback(): Promise<void>;
}> {
  const files = remoteUploadFiles(value);
  if (!files.length) return { attachments: [], uploads: [], rollback: async () => undefined };
  const retainedBytes = await pruneRemoteManagementUploads(managementRoot);
  const incomingBytes = files.reduce((total, file) => total + file.data.byteLength, 0);
  if (retainedBytes + incomingBytes > maxRemoteManagementUploadStorageBytes) {
    throw badRequest("Remote upload storage is full. Remove older remote attachments or try again later.");
  }
  const targetFolder = `Incoming/Remote/${safeRemoteUploadSegment(grantId)}/${safeRemoteUploadSegment(requestId)}`;
  const absoluteFolder = resolveSpacePath(managementRoot, targetFolder);
  await rm(absoluteFolder, { recursive: true, force: true });
  const uploaded = await writeUploadedFiles(managementRoot, targetFolder, files);
  try {
    const absolutePaths = uploaded.map((file) => resolveSpacePath(managementRoot, file.path));
    const attachments = await classifyManagementAttachments(absolutePaths, managementRoot);
    return {
      attachments,
      uploads: uploaded.map((file, index) => ({ name: files[index]!.fileName, sizeBytes: file.sizeBytes })),
      rollback: async () => { await rm(absoluteFolder, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(absoluteFolder, { recursive: true, force: true });
    throw error;
  }
}

function remoteManagementUploadRoot(managementRoot: string): string {
  return resolveSpacePath(managementRoot, "Incoming/Remote");
}

function safeRemoteUploadSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  if (!segment || segment === "." || segment === "..") throw badRequest("Remote upload identity is invalid.");
  return segment;
}

async function pruneRemoteManagementUploads(managementRoot: string): Promise<number> {
  const root = remoteManagementUploadRoot(managementRoot);
  const grants = await readdir(root, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  let retainedBytes = 0;
  for (const grant of grants) {
    if (!grant.isDirectory() || grant.isSymbolicLink()) {
      await rm(join(root, grant.name), { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const grantRoot = join(root, grant.name);
    const requests = await readdir(grantRoot, { withFileTypes: true }).catch(() => []);
    for (const request of requests) {
      const requestRoot = join(grantRoot, request.name);
      const info = request.isDirectory() && !request.isSymbolicLink() ? await stat(requestRoot).catch(() => null) : null;
      if (!info || now - info.mtimeMs > remoteManagementUploadTtlMs) {
        await rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      const files = await readdir(requestRoot, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink()) continue;
        retainedBytes += (await stat(join(requestRoot, file.name)).catch(() => null))?.size ?? 0;
      }
    }
  }
  return retainedBytes;
}

function remoteChatMessage(message: ChatMessage | { id: string; role: "user"; content: string; createdAt: string }): Record<string, unknown> {
  const maximumContentCharacters = 128_000;
  const contentTruncated = message.content.length > maximumContentCharacters;
  return {
    id: message.id,
    role: message.role,
    content: contentTruncated ? `${message.content.slice(0, maximumContentCharacters)}\n\n[Message truncated for remote display.]` : message.content,
    createdAt: message.createdAt,
    ...(contentTruncated ? { contentTruncated: true } : {}),
    ...("kind" in message && message.kind ? { kind: message.kind } : {}),
    ...("source" in message && message.source ? { source: message.source } : {}),
    ...("interruption" in message && message.interruption ? { interruption: message.interruption } : {}),
    ...("delivery" in message && message.delivery ? { delivery: message.delivery } : {}),
    ...("attachments" in message && message.attachments?.length
      ? { attachments: message.attachments.map((attachment) => ({ kind: attachment.kind, name: attachment.name })) }
      : {}),
  };
}

function remoteInput(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Remote operation input must be an object.");
  return value as Record<string, unknown>;
}

function assertRemoteKeys(input: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unknown) throw badRequest(`Remote operation does not accept ${unknown}.`);
}

function assertRemotePrincipal(principal: WorkFoldRemotePrincipal): void {
  remoteStableId(principal.browserId, "remote browser id", 160);
  remoteStableId(principal.grantId, "remote grant id", 160);
  remoteStableId(principal.requestId, "remote request id", 160);
}

function assertRemoteManagementRequestOwner(
  state: LocalApiState,
  taskId: string,
  principal: WorkFoldRemotePrincipal,
): void {
  const request = state.managementRequests.get(taskId);
  if (!request || !isRemoteManagementRequestOwner(request, principal)) {
    throw notFound("Remote request not found for this browser grant.");
  }
}

function isRemoteManagementRequestOwner(
  request: ManagementRequestRecord,
  principal: WorkFoldRemotePrincipal,
): boolean {
  return request.source === "remote_web"
    && request.remotePrincipalId === principal.browserId
    && request.remoteGrantId === principal.grantId;
}

function remoteStableId(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest(`A valid ${label} is required.`);
  }
  return value;
}

function remoteContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 12_000 || value.includes("\0")) {
    throw badRequest("A message of at most 12,000 characters is required.");
  }
  return value.trim();
}

function remoteConversationTitle(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw badRequest("Chat title must be text.");
  }
  const title = normalizeConversationTitle(value);
  if (!title) throw badRequest("Enter a Chat title.");
  return title;
}

function remoteRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || value.includes("\0") || isAbsolute(value)
    || value.split(/[\\/]/).some((part) => part === "..")) {
    throw badRequest("A valid Space-relative folder path is required.");
  }
  return value;
}

function remoteOperationExhaustive(operation: never): never {
  throw badRequest(`Unsupported remote operation: ${String(operation)}`);
}

/**
 * The act facade is the CLI act lane's in-process authority. Every method
 * reuses the same route internals as the renderer (turn acceptance, trust
 * grants, History-checkpointed additions), so a CLI-initiated action obeys
 * identical conflict, trust, and persistence rules. Registering a folder
 * through the act lane deliberately has no renderer folder-picker grant:
 * possession of the per-launch act token is that caller's authorization.
 */
/**
 * Act-lane marker recorded as the owning conversation of a host-created
 * install-preview review: the same digest-pinned review record the Chat
 * proposal path stores, bound to the act lane instead of a real Chat.
 */
const workFoldActInstallPreviewConversationId = "work-fold.act.install-preview";

function createWorkFoldActFacade(state: LocalApiState): WorkFoldActFacade {
  const resolveSpace = async (selector: string): Promise<SpaceSummary> => {
    const resolved = resolveWorkFoldCliSpaceSelector(await listSpaces(), selector.trim() || undefined);
    if (!resolved) throw new WorkFoldCliError("usage", "Act commands require an explicit --space <id-or-name>.");
    return resolved;
  };
  /**
   * Per-Space appearance undo slot for this app run: the customization a
   * receipted appearance act displaced and the customization it left in
   * place. `spaces appearance undo` swaps them; a desktop-side change makes
   * the recorded slot stale, which the equality check below turns into a
   * typed refusal instead of restoring a state the receipt never described.
   */
  const appearanceUndoSlots = new Map<string, {
    displaced: SpaceAppearanceCustomization | null;
    result: SpaceAppearanceCustomization | null;
  }>();
  const currentAppearanceCustomization = (spaceId: string): SpaceAppearanceCustomization | null =>
    state.appearance.snapshot().customizations[spaceId] ?? null;
  /** The conversation PATCH route's 409s, mapped to CLI conflict errors. */
  const assertChatMutable = (spaceId: string, conversationId: string): void => {
    const key = clientKey(spaceId, conversationId);
    if (state.runningTurns.has(key)) {
      throw new WorkFoldCliError("conflict", "Wait for the current Assistant turn to finish.");
    }
    if (state.compactingConversations.has(key)) {
      throw new WorkFoldCliError("conflict", "Wait for the current Chat compaction to finish.");
    }
  };
  const requireConversationSummary = async (
    spaceRoot: string,
    conversationId: string,
  ): Promise<ConversationSummary> => {
    const summary = await runActOperation(() => readConversationSummary(spaceRoot, conversationId));
    if (!summary) throw new WorkFoldCliError("notFound", "Conversation not found.");
    return summary;
  };
  /**
   * Resolves one installed app by its manifest id so digest-less narrowing
   * verbs can pin the current reviewed revision for their mutation — a
   * revision change between lookup and act then fails with the service's
   * REVISION_CHANGED instead of acting on different bytes.
   */
  const requireInstalledApp = async (space: SpaceSummary, appId: string): Promise<RestrictedAppInstalled> => {
    const id = appId.trim();
    if (!id) throw new WorkFoldCliError("usage", "Provide --app <id>.");
    const app = (await runActOperation(() => state.restrictedApps.list(space.id)))
      .find((item) => item.manifest.id === id);
    if (!app) throw new WorkFoldCliError("notFound", "No app with this id is installed in this Space.");
    return app;
  };
  /**
   * The one staging door for every consecrated verb: typed parameters and
   * pins composed by the calling method from live state, provenance from the
   * validated management lineage, admission through the staged-act store's
   * serialized path, and the ledger's staged result shape back. Nothing here
   * executes anything; deciding has no facade shape, permanently.
   *
   * The one exception a person authored in advance: after a fresh admission,
   * enabled standing policies are evaluated host-side against the act's typed
   * fields (docs/fold-consecrations.md §Standing policies). A match
   * short-circuits into the same decision path as a click — with
   * `surface: "policy"` and the exercised policy's identity — and the staged
   * result reports the auto-approval instead of a pending card. A
   * deduplicated admission returns the existing pending card unevaluated:
   * policies bind acts staged after they were authored, never a card that was
   * already waiting.
   */
  const stageConsecration = async (input: {
    kind: FoldStagedActKind;
    parameters: FoldStagedActFields;
    pins: FoldStagedActFields;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<WorkFoldActStagedDecision> => {
    const admission = await runStagedActStoreOperation(() => state.stagedActs.stage({
      kind: input.kind,
      parameters: input.parameters,
      pins: input.pins,
      provenance: stagingProvenance(state, input.parentTaskId, input.requestId),
    }));
    if (admission.deduplicated) return toStagedDecision(admission);
    const exercised = await exerciseStandingPolicyAtAdmission(state, admission.act);
    if (!exercised) return toStagedDecision(admission);
    return {
      ...toStagedDecision(admission),
      state: "approved",
      autoApproval: exercised,
    };
  };
  /**
   * Whole-Space restore replaces the working set running work may be reading,
   * so the act lane refuses concurrency the desktop still leaves to a confirm
   * dialog (docs/fold-act-ledger.md, conflict rule 7). The live route state
   * covers Assistant turns, compactions, and Check work; the kernel's
   * experimental fence covers active routing runs with files hops into the
   * Space and — once its reader exists — restricted-app automation runs whose
   * apps hold file grants into it (the ledger's item 4).
   */
  const assertSpaceQuietForHistoryRestore = async (spaceId: string): Promise<void> => {
    const prefix = `${spaceId}:`;
    if ([...state.runningTurns].some((key) => key.startsWith(prefix))) {
      throw new WorkFoldCliError("conflict", "Wait for the running Assistant turn in this Space to finish before restoring.");
    }
    if ([...state.compactingConversations].some((key) => key.startsWith(prefix))) {
      throw new WorkFoldCliError("conflict", "Wait for the running Chat compaction in this Space to finish before restoring.");
    }
    if (state.checkRunReservations.has(spaceId) || state.checks.hasActiveRun(spaceId)) {
      throw new WorkFoldCliError("conflict", "Wait for the running Check work in this Space to finish before restoring.");
    }
    const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(spaceId);
    if (blockers.length) throw new WorkFoldCliError("conflict", blockers[0]!);
  };
  return {
    async createConversation(input) {
      const space = await resolveSpace(input.space);
      const conversation = await runActOperation(() => createConversation(space.spaceRoot));
      return { space: toActSpaceRef(space), conversation: toActConversationRef(conversation) };
    },
    async listConversations(input) {
      const space = await resolveSpace(input.space);
      const conversations = await runActOperation(() => listConversations(space.spaceRoot));
      return { space: toActSpaceRef(space), conversations: conversations.map(toActConversationRef) };
    },
    async sendMessage(input) {
      const space = await resolveSpace(input.space);
      const content = input.content.trim();
      if (!content) throw new WorkFoldCliError("usage", "Message content is required.");
      if (!input.conversationId && !input.newConversation) {
        throw new WorkFoldCliError("usage", "Provide --conversation <id> or --new.");
      }
      return runActOperation(async () => {
        assertManagementParentAccepting(state, input.parentTaskId);
        const conversationId = input.newConversation
          ? (await createConversation(space.spaceRoot)).id
          : input.conversationId!;
        const { message, taskId } = await acceptConversationTurn(state, space, conversationId, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
          requestId: input.requestId,
        });
        if (input.parentTaskId) {
          await state.beforeManagementActionRecord?.({ parentTaskId: input.parentTaskId, command: "chat.send", taskId });
        }
        const attributedParent = state.managementRequests.recordAction(input.parentTaskId, {
          command: "chat.send",
          at: new Date().toISOString(),
          spaceId: space.id,
          spaceName: space.name,
          conversationId,
          taskId,
        });
        if (input.parentTaskId && (!attributedParent || !state.managementRequests.isActive(input.parentTaskId))) {
          await cancelAcceptedTurn(state, space.id, conversationId, taskId);
        }
        return { space: toActSpaceRef(space), conversationId, messageId: message.id, taskId };
      });
    },
    async conversationStatus(input) {
      const space = await resolveSpace(input.space);
      const summary = await runActOperation(() => readConversationSummary(space.spaceRoot, input.conversationId));
      if (!summary) throw new WorkFoldCliError("notFound", "Conversation not found.");
      return {
        space: toActSpaceRef(space),
        conversation: toActConversationRef(summary),
        state: conversationRuntimeState(state, space.id, input.conversationId),
      };
    },
    async conversationResult(input) {
      const space = await resolveSpace(input.space);
      const result = await conversationResultForScope(state, space.id, space.spaceRoot, input.conversationId, input.messages);
      return { space: toActSpaceRef(space), ...result };
    },
    async abortTurn(input) {
      const space = await resolveSpace(input.space);
      const client = state.clients.get(clientKey(space.id, input.conversationId));
      return {
        space: toActSpaceRef(space),
        conversationId: input.conversationId,
        aborted: client ? await client.abort() : false,
      };
    },
    async turnStatus(input) {
      const space = await resolveSpace(input.space);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const task = turnStatusFor(state, space.id, taskId);
      return { space: toActSpaceRef(space), task };
    },
    async turnResult(input) {
      const space = await resolveSpace(input.space);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const result = await turnResultForScope(state, space.id, space.spaceRoot, taskId);
      return { space: toActSpaceRef(space), ...result };
    },
    async chatRename(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const title = input.title.trim();
      if (!title) throw new WorkFoldCliError("usage", "Chat title is required.");
      const summary = await requireConversationSummary(space.spaceRoot, input.conversationId);
      assertChatMutable(space.id, input.conversationId);
      const conversation = await runActOperation(() => renameConversation(space.spaceRoot, input.conversationId, title));
      state.clients.get(clientKey(space.id, input.conversationId))?.setSessionName(conversation.title);
      recordFacadeAction(state, input.parentTaskId, { command: "chat.rename", space, conversationId: conversation.id });
      return {
        space: toActSpaceRef(space),
        conversation: toActConversationRef(conversation),
        priorTitle: summary.title,
      };
    },
    async chatSnooze(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const until = input.until.trim();
      if (!Number.isFinite(Date.parse(until))) throw new WorkFoldCliError("usage", "Snooze time is invalid.");
      if (Date.parse(until) <= Date.now()) throw new WorkFoldCliError("usage", "Choose a future snooze time.");
      const summary = await requireConversationSummary(space.spaceRoot, input.conversationId);
      if (summary.archivedAt) throw new WorkFoldCliError("conflict", "Unarchive this Chat before snoozing it.");
      assertChatMutable(space.id, input.conversationId);
      const conversation = await runActOperation(() =>
        updateConversationLifecycle(space.spaceRoot, input.conversationId, { snoozedUntil: until }));
      recordFacadeAction(state, input.parentTaskId, { command: "chat.snooze", space, conversationId: conversation.id });
      return {
        space: toActSpaceRef(space),
        conversation: toActConversationRef(conversation),
        priorLifecycle: toActChatLifecycleState(summary),
      };
    },
    async chatArchive(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const summary = await requireConversationSummary(space.spaceRoot, input.conversationId);
      if (summary.archivedAt) throw new WorkFoldCliError("conflict", "This Chat is already archived.");
      assertChatMutable(space.id, input.conversationId);
      const conversation = await runActOperation(() =>
        updateConversationLifecycle(space.spaceRoot, input.conversationId, { archived: true }));
      recordFacadeAction(state, input.parentTaskId, { command: "chat.archive", space, conversationId: conversation.id });
      return {
        space: toActSpaceRef(space),
        conversation: toActConversationRef(conversation),
        priorLifecycle: toActChatLifecycleState(summary),
      };
    },
    async chatResume(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const summary = await requireConversationSummary(space.spaceRoot, input.conversationId);
      if (!summary.archivedAt && !summary.snoozedUntil) {
        throw new WorkFoldCliError("conflict", "This Chat is already active.");
      }
      assertChatMutable(space.id, input.conversationId);
      // One lifecycle change per act, mirroring the renderer: an archived Chat
      // restores to Active; a snoozed (or snooze-expired) Chat clears its snooze.
      const conversation = await runActOperation(() =>
        updateConversationLifecycle(
          space.spaceRoot,
          input.conversationId,
          summary.archivedAt ? { archived: false } : { snoozedUntil: null },
        ));
      recordFacadeAction(state, input.parentTaskId, { command: "chat.resume", space, conversationId: conversation.id });
      return {
        space: toActSpaceRef(space),
        conversation: toActConversationRef(conversation),
        priorLifecycle: toActChatLifecycleState(summary),
      };
    },
    async chatCompact(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      return runActOperation(async () => {
        // Exactly the composer's /compact route: same not-found check, same
        // capability-mutation fence, same 409s, and the same kernel
        // `compaction` task lifecycle — started before the compaction and
        // finished on every outcome, so no ghost task survives a failure.
        if (!(await readConversation(space.spaceRoot, input.conversationId)).length) {
          throw new WorkFoldCliError("notFound", "Conversation not found.");
        }
        const key = clientKey(space.id, input.conversationId);
        assertNoCapabilityMutationForTurn(state, space.id);
        assertChatMutable(space.id, input.conversationId);
        state.compactingConversations.add(key);
        const task = state.kernel.startTask({
          kind: "compaction",
          spaceId: space.id,
          conversationId: input.conversationId,
          actor: { kind: "cli", cwd: space.spaceRoot, spaceId: space.id, conversationId: input.conversationId },
        });
        try {
          const client = await getClient(state, space.id, space.spaceRoot, input.conversationId);
          await client.compact();
          broadcast(state, streamKey(space.id, input.conversationId), { type: "done", conversationId: input.conversationId });
        } finally {
          state.compactingConversations.delete(key);
          state.kernel.finishTask(task.id);
        }
        recordFacadeAction(state, input.parentTaskId, {
          command: "chat.compact",
          space,
          conversationId: input.conversationId,
          taskId: task.id,
        });
        return {
          space: toActSpaceRef(space),
          conversationId: input.conversationId,
          compacted: true as const,
          taskId: task.id,
        };
      });
    },
    async historyList(input) {
      const space = await resolveSpace(input.space);
      const checkpoints = await runActOperation(() => listSpaceCheckpoints(space.spaceRoot));
      return { space: toActSpaceRef(space), checkpoints: checkpoints.map(toActCheckpointSummary) };
    },
    async historySave(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      return runActOperation(async () => {
        // Same internals as the History pane's save route: an unchanged Space
        // returns the latest matching restore point instead of a duplicate.
        const existingIds = new Set(
          (await listSpaceCheckpoints(space.spaceRoot, 1000)).map((checkpoint) => checkpoint.checkpointId),
        );
        const checkpoint = await createSpaceCheckpoint(space.spaceRoot, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          reason: "manual",
        });
        recordFacadeAction(state, input.parentTaskId, {
          command: "history.save",
          space,
          checkpointId: checkpoint.checkpointId,
        });
        return {
          space: toActSpaceRef(space),
          checkpoint: toActCheckpointSummary(checkpoint),
          created: !existingIds.has(checkpoint.checkpointId),
        };
      });
    },
    async historyRestore(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      await assertSpaceQuietForHistoryRestore(space.id);
      const result = await runActOperation(() => restoreSpaceCheckpoint(space.spaceRoot, input.checkpointId));
      recordFacadeAction(state, input.parentTaskId, {
        command: "history.restore",
        space,
        checkpointId: result.safetyCheckpointId,
      });
      return {
        space: toActSpaceRef(space),
        restored: true,
        checkpointId: result.checkpointId,
        safetyCheckpointId: result.safetyCheckpointId,
        restoredFileCount: result.restoredFiles.length,
        deletedFileCount: result.deletedFiles.length,
        movedEntryCount: result.movedEntries.length,
        unchangedFileCount: result.unchangedFiles,
        skippedLargeFileCount: result.skippedLargeFiles.length,
      };
    },
    async historyVersions(input) {
      const space = await resolveSpace(input.space);
      const path = input.path.trim();
      if (!path) throw new WorkFoldCliError("usage", "A Space-relative file path is required.");
      const versions = await runActOperation(() => listFileVersions(space.spaceRoot, path));
      return { space: toActSpaceRef(space), path, versions: versions.map(toActFileVersionRef) };
    },
    async historyRestoreFile(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      if (!/^[a-f0-9]{64}$/i.test(input.version.trim())) {
        throw new WorkFoldCliError("usage", "Provide --version as the 64-character SHA-256 hash shown by 'history versions'.");
      }
      return runActOperation(async () => {
        const target = await stat(resolveSpacePath(space.spaceRoot, input.path)).catch(() => null);
        if (target && !target.isFile()) {
          throw new WorkFoldCliError("conflict", "The selected path is currently a folder.");
        }
        const result = await restoreFileVersion(space.spaceRoot, input.path, input.version.trim());
        recordFacadeAction(state, input.parentTaskId, {
          command: "history.restore-file",
          space,
          checkpointId: result.safetyCheckpointId,
        });
        return { space: toActSpaceRef(space), ...result };
      });
    },
    async filesMove(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const sourceRaw = input.fromPath.trim();
      if (!sourceRaw) throw new WorkFoldCliError("usage", "Select a file or folder to move.");
      return runActOperation(async () => {
        // Exactly the desktop move route: a targeted restore point that undoes
        // the move, then the mutation, with the unused restore point discarded
        // when the mutation fails.
        const moveSource = normalizeSpaceRelativePath(sourceRaw);
        const moveTargetFolder = normalizeSpaceRelativePath(input.toDir);
        const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
        const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
          movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
          reason: "pre_move",
          label: `Before moving ${sourceRaw}`,
        });
        const moved = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => moveSpaceEntry(space.spaceRoot, {
          sourcePath: moveSource,
          targetFolderPath: input.toDir,
        }));
        recordFacadeAction(state, input.parentTaskId, { command: "files.move", space, checkpointId: safety.checkpointId });
        return {
          space: toActSpaceRef(space),
          fromPath: moved.fromPath,
          path: moved.path,
          kind: moved.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesRename(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const sourceRaw = input.path.trim();
      const newName = input.newName.trim();
      if (!sourceRaw || !newName) throw new WorkFoldCliError("usage", "A Space item and new name are required.");
      return runActOperation(async () => {
        const renameSource = normalizeSpaceRelativePath(sourceRaw);
        const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
        const renameDestination = [renameParent, newName].filter(Boolean).join("/");
        const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
          movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
          reason: "pre_rename",
          label: `Before renaming ${sourceRaw}`,
        });
        const renamed = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => renameSpaceEntry(space.spaceRoot, { path: sourceRaw, newName }));
        recordFacadeAction(state, input.parentTaskId, { command: "files.rename", space, checkpointId: safety.checkpointId });
        return {
          space: toActSpaceRef(space),
          fromPath: renamed.fromPath,
          path: renamed.path,
          priorName: basename(renameSource),
          kind: renamed.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesDelete(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const target = input.path.trim();
      if (!target) throw new WorkFoldCliError("usage", "Select a file or folder to delete.");
      return runActOperation(async () => {
        const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
          paths: [target],
          reason: "pre_delete",
          label: `Before deleting ${target}`,
        });
        // The coverage refusal throws inside runWithHistorySafety so the
        // partial restore point is discarded along with every other failure.
        return runWithHistorySafety(space.spaceRoot, safety.checkpointId, async () => {
          assertDeleteRestoreCoverage(safety);
          const deleted = await deleteSpaceEntry(space.spaceRoot, target);
          recordFacadeAction(state, input.parentTaskId, { command: "files.delete", space, checkpointId: safety.checkpointId });
          return { space: toActSpaceRef(space), ...deleted, safetyCheckpointId: safety.checkpointId };
        });
      });
    },
    async filesMkdir(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A folder path is required.");
      return runActOperation(async () => {
        const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const folder = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => createSpaceFolder(space.spaceRoot, parentPath, name));
        recordFacadeAction(state, input.parentTaskId, { command: "files.mkdir", space, checkpointId: safety.checkpointId });
        return {
          space: toActSpaceRef(space),
          created: true as const,
          path: folder.path,
          kind: "folder" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesCreate(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A file path is required.");
      return runActOperation(async () => {
        const safety = await createSpaceMutationCheckpoint(space.spaceRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const file = await runWithHistorySafety(space.spaceRoot, safety.checkpointId, () => createSpaceTextFile(space.spaceRoot, parentPath, name, ""));
        recordFacadeAction(state, input.parentTaskId, { command: "files.create", space, checkpointId: safety.checkpointId });
        return {
          space: toActSpaceRef(space),
          created: true as const,
          path: file.path,
          kind: "file" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async search(input) {
      const space = await resolveSpace(input.space);
      const query = input.query.trim();
      if (!query) throw new WorkFoldCliError("usage", "Enter something to search for.");
      const scope = input.scope ?? "all";
      const result = await runActOperation(() => searchSpace(space.spaceRoot, query, {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
      }));
      return { space: toActSpaceRef(space), scope, ...result };
    },
    async libraryList() {
      const tree = await runActOperation(() => listResourceTree());
      const items: WorkFoldActLibraryItem[] = [];
      return { items, truncated: flattenLibraryTree(tree, items) };
    },
    async libraryCopy(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const item = input.item.trim();
      if (!item) throw new WorkFoldCliError("usage", "Provide --item <library-path>.");
      return runActOperation(async () => {
        // Exactly the desktop copy-to-space route: an independent copy landing
        // under `From Library`, with copy and restore point succeeding or
        // failing together in the destination Space; the Library original is
        // untouched.
        const copied = await copyResourcesToSpace(space.spaceRoot, [item], "From Library");
        const safety = await checkpointAdditiveWritesOrUndo(space.spaceRoot, copied, {
          reason: "pre_add",
          label: `Before adding ${copied.length} Library item${copied.length === 1 ? "" : "s"}`,
        });
        recordFacadeAction(state, input.parentTaskId, {
          command: "library.copy",
          space,
          copied,
          checkpointId: safety?.checkpointId ?? null,
        });
        return {
          space: toActSpaceRef(space),
          item,
          copied: copied[0]!,
          checkpointId: safety?.checkpointId ?? null,
        };
      });
    },
    async libraryAdd(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      return runActOperation(async () => {
        // The same upload internals as the desktop's "Add files to Library"
        // (`uploadResourceFiles` over `writeUploadedFiles`), fed from
        // host-read source files instead of a multipart body. The Library is
        // personal and Space-free: no restore point is recorded, and the total
        // read is bounded by the same budget as the desktop upload body.
        const files = await collectLibraryUploadFiles(input.fromPaths, input.cwd, state.maxBodyBytes);
        const added = await uploadResourceFiles(input.toDir ?? "", files);
        // Resolved absolute sources are recorded exactly as files.add records
        // them, so attachment dispositions can account for an attachment that
        // entered the Library (`library` status in the request views).
        state.managementRequests.recordAction(input.parentTaskId, {
          command: "library.add",
          at: new Date().toISOString(),
          sources: input.fromPaths.map((raw) => {
            const trimmed = raw.trim();
            return isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
          }),
          copied: added.map((file) => file.path),
        });
        return { added };
      });
    },
    async libraryFolderCreate(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const name = input.name.trim();
      if (!name) throw new WorkFoldCliError("usage", "A Library folder name is required.");
      return runActOperation(async () => {
        const folder = await createResourceFolder("", name);
        recordFacadeAction(state, input.parentTaskId, { command: "library.folder.create" });
        return { created: true as const, path: folder.path };
      });
    },
    async createSpace(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const name = input.name.trim();
      if (!name) throw new WorkFoldCliError("usage", "A Space name is required.");
      const space = await runActOperation(() => runCheckSpaceRegistryMutation(state, () => createSpaceInternal(state, name)));
      state.managementRequests.recordAction(input.parentTaskId, {
        command: "spaces.create",
        at: new Date().toISOString(),
        spaceId: space.id,
        spaceName: space.name,
        spaceRoot: space.spaceRoot,
      });
      return { space: toActSpaceRef(space) };
    },
    async registerSpace(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const rootPath = input.spaceRoot.trim();
      if (!rootPath || !isAbsolute(rootPath)) {
        throw new WorkFoldCliError("usage", "Provide an absolute folder path to register.");
      }
      const space = await runActOperation(() => runCheckSpaceRegistryMutation(state, () => registerSpaceInternal(state, rootPath)));
      state.managementRequests.recordAction(input.parentTaskId, {
        command: "spaces.register",
        at: new Date().toISOString(),
        spaceId: space.id,
        spaceName: space.name,
        spaceRoot: space.spaceRoot,
      });
      return { space: toActSpaceRef(space) };
    },
    async addFiles(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const result = await runActOperation(() => addExternalFilesInternal(space, input));
      state.managementRequests.recordAction(input.parentTaskId, {
        command: "files.add",
        at: new Date().toISOString(),
        spaceId: space.id,
        spaceName: space.name,
        sources: input.fromPaths.map((raw) => {
          const trimmed = raw.trim();
          return isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
        }),
        copied: result.copied,
        checkpointId: result.checkpointId,
      });
      return { space: toActSpaceRef(space), ...result };
    },
    async spacesRename(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const name = input.name.trim();
      if (!name) throw new WorkFoldCliError("usage", "A Space name is required.");
      // The ledger's ambiguous-making rule: a duplicate exact name under the
      // CLI selector's case-insensitive match would break `--space` selection
      // by name, so it is refused here. The comparison folds the same way the
      // selector does; renaming a Space to a case variant of itself stays
      // allowed.
      const folded = name.replace(/\s+/g, " ").slice(0, 80).toLocaleLowerCase("en-US");
      const collision = (await listSpaces()).find((item) =>
        item.id !== space.id && item.name.toLocaleLowerCase("en-US") === folded);
      if (collision) {
        throw new WorkFoldCliError(
          "conflict",
          `Another Space is already named ${collision.name} [${collision.id}]; a duplicate exact name would make --space selection ambiguous.`,
        );
      }
      const renamed = await runActOperation(() => renameSpace(space.id, name));
      recordFacadeAction(state, input.parentTaskId, { command: "spaces.rename", space: renamed });
      return { space: toActSpaceRef(renamed), priorName: space.name };
    },
    async spacesUnregister(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const storage = space.location.storage;
      // Both storage kinds run the same removal orchestration — App Studio
      // impact checks, publication blocks, routing suspension, staged-act
      // cancellation, durable intent, app-state cleanup. A managed Space
      // records a preserve-disposition intent that provably holds no
      // deletion authority, so the folder and its portable `.work-fold/`
      // identity remain exactly as they do for a linked registration;
      // deleting the managed folder stays the staged `spaces delete`
      // consecration.
      const removal = await runActOperation(() =>
        removeSpaceRegistrationInternal(state, space, { managedFolderDisposition: "preserve" }));
      appearanceUndoSlots.delete(space.id);
      recordFacadeAction(state, input.parentTaskId, { command: "spaces.unregister", space });
      return {
        space: toActSpaceRef(space),
        storage,
        removed: true as const,
        cleanupPending: removal.cleanupPending,
      };
    },
    async spacesAppearanceApply(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const proposal = await readSpaceAppearanceProposalFile(input.proposalPath, input.cwd);
      if (proposal.target?.spaceId && proposal.target.spaceId !== space.id) {
        throw new WorkFoldCliError(
          "conflict",
          `This appearance proposal targets a different Space (${proposal.target.spaceId}). Apply it with that --space, or use a proposal authored for this one.`,
        );
      }
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(space.id);
        // Exactly the Customize Space import route's mutation: the store
        // normalizes and persists the typed customization atomically.
        const applied = await state.appearance.replaceSpace(space.id, proposal.customization);
        const result = applied.customizations[space.id] ?? null;
        appearanceUndoSlots.set(space.id, { displaced, result });
        recordFacadeAction(state, input.parentTaskId, { command: "spaces.appearance.apply", space });
        return {
          space: toActSpaceRef(space),
          applied: true as const,
          proposalName: proposal.name,
          appearanceRef: appearanceCustomizationRef(result),
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async spacesAppearanceReset(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(space.id);
        if (displaced === null) {
          // An already-default Space is an honest no-op that arms no undo.
          return {
            space: toActSpaceRef(space),
            reset: true as const,
            changed: false,
            priorAppearanceRef: null,
          };
        }
        await state.appearance.removeSpace(space.id);
        appearanceUndoSlots.set(space.id, { displaced, result: null });
        recordFacadeAction(state, input.parentTaskId, { command: "spaces.appearance.reset", space });
        return {
          space: toActSpaceRef(space),
          reset: true as const,
          changed: true,
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async spacesAppearanceUndo(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const slot = appearanceUndoSlots.get(space.id);
      if (!slot) {
        throw new WorkFoldCliError(
          "conflict",
          "No receipted appearance act recorded a prior customization for this Space in this app run, so there is nothing to undo. Apply a proposal or reset explicitly instead.",
        );
      }
      if (!appearanceCustomizationsEqual(currentAppearanceCustomization(space.id), slot.result)) {
        throw new WorkFoldCliError(
          "conflict",
          "This Space's appearance was changed outside the act lane (for example on the desktop) since the last receipted appearance act, so the recorded prior customization no longer describes what an undo would displace. Apply a proposal or reset explicitly instead.",
        );
      }
      return runActOperation(async () => {
        const next = slot.displaced;
        const stateAfter = next !== null && hasSpaceAppearanceCustomization(next)
          ? await state.appearance.replaceSpace(space.id, next)
          : await state.appearance.removeSpace(space.id);
        const restored = stateAfter.customizations[space.id] ?? null;
        // Undo is its own inverse: the displaced and restored refs swap.
        appearanceUndoSlots.set(space.id, { displaced: slot.result, result: restored });
        recordFacadeAction(state, input.parentTaskId, { command: "spaces.appearance.undo", space });
        return {
          space: toActSpaceRef(space),
          restored: true as const,
          restoredAppearanceRef: appearanceCustomizationRef(restored),
          displacedAppearanceRef: appearanceCustomizationRef(slot.result),
        };
      });
    },
    async toolsRemove(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const source = input.source.trim();
      if (!source) throw new WorkFoldCliError("usage", "A package source is required.");
      if (input.scope === "space") {
        const space = await resolveSpace(input.space ?? "");
        // Exactly the desktop packages/remove route: project scope requires
        // the Space's Pi project trust and the per-Space capability fence.
        const removed = await runActOperation(() => runCapabilityMutation(state, space, "project", () =>
          removePiPackage(space.spaceRoot, source, {
            scope: "project",
            runtimeProvider: state.runtimeProvider,
          })));
        recordFacadeAction(state, input.parentTaskId, { command: "tools.remove", space });
        return { scope: "space" as const, space: toActSpaceRef(space), source, removed };
      }
      // Personal scope mutates the personal (user-scope) Pi settings every
      // Space runtime loads. The app-owned management root is the resolution
      // context — the same root the management conversation's own runtime
      // uses — and the global capability fence refuses while any Assistant,
      // compaction, or Check work is active anywhere.
      const managementRootScope = { id: workFoldManagementScopeId, spaceRoot: workFoldManagementRoot() };
      const removed = await runActOperation(() => runCapabilityMutation(state, managementRootScope, "global", () =>
        removePiPackage(managementRootScope.spaceRoot, source, {
          scope: "user",
          runtimeProvider: state.runtimeProvider,
        })));
      recordFacadeAction(state, input.parentTaskId, { command: "tools.remove" });
      return { scope: "personal" as const, source, removed };
    },
    async appsProposalsList(input) {
      const space = await resolveSpace(input.space);
      // The desktop proposal route's own scope rule: proposals are bound to
      // one Chat, and the Chat must exist in this Space.
      if (!(await runActOperation(() => readConversation(space.spaceRoot, input.conversationId))).length) {
        throw new WorkFoldCliError("notFound", "Conversation not found.");
      }
      const proposals = await runActOperation(() =>
        state.restrictedAppProposals.list({ spaceId: space.id, conversationId: input.conversationId }));
      return {
        space: toActSpaceRef(space),
        conversationId: input.conversationId,
        proposals: proposals.map(toActAppProposalRef),
      };
    },
    async appsProposalsDismiss(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const proposal = await runActOperation(() => state.restrictedAppProposals.get(input.proposal));
      if (!proposal || proposal.spaceId !== space.id || proposal.conversationId !== input.conversationId) {
        throw new WorkFoldCliError("notFound", "App proposal not found.");
      }
      const dismissed = await runActOperation(() => state.restrictedAppProposals.dismiss(proposal.id));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.proposals.dismiss", space, conversationId: input.conversationId });
      return { space: toActSpaceRef(space), proposalId: proposal.id, dismissed };
    },
    async appsRemove(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const app = await requireInstalledApp(space, input.app);
      // The exact desktop DELETE route, with the resolved digest pinned; the
      // service refuses release-backed Instances toward `apps uninstall` and
      // stops the running app host before the registration goes.
      const removed = await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.remove({ spaceId: space.id, appId: app.manifest.id, expectedDigest: app.digest })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.remove", space });
      return { space: toActSpaceRef(space), appId: app.manifest.id, digest: app.digest, removed };
    },
    async appsRevoke(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const digest = input.digest.trim();
      if (!digest) throw new WorkFoldCliError("usage", "Provide --digest <sha256>.");
      const declaration = input.declaration.trim();
      if (!declaration) throw new WorkFoldCliError("usage", "Provide --declaration <id>.");
      const app = await requireInstalledApp(space, input.app);
      // Grants bind to the exact reviewed digest, so revocation names it too.
      const granted = input.kind === "network"
        ? app.networkGrants.includes(declaration)
        : input.kind === "files"
          ? app.fileGrants.some((grant) => grant.declarationId === declaration)
          : app.notificationGrants.includes(declaration);
      await runActOperation(() => runRestrictedAppMutation(state, space.id, () => input.kind === "network"
        ? state.restrictedApps.revokeNetwork({ spaceId: space.id, appId: app.manifest.id, destinationId: declaration, expectedDigest: digest })
        : input.kind === "files"
          ? state.restrictedApps.revokeFiles({ spaceId: space.id, appId: app.manifest.id, permissionId: declaration, expectedDigest: digest })
          : state.restrictedApps.revokeNotifications({ spaceId: space.id, appId: app.manifest.id, permissionId: declaration, expectedDigest: digest })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.revoke", space });
      return {
        space: toActSpaceRef(space),
        appId: app.manifest.id,
        grantKind: input.kind,
        declaration,
        revoked: granted,
      };
    },
    async appsDisconnect(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const destination = input.destination.trim();
      if (!destination) throw new WorkFoldCliError("usage", "Provide --destination <id>.");
      const app = await requireInstalledApp(space, input.app);
      const disconnected = await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.deleteConnection({
          spaceId: space.id,
          appId: app.manifest.id,
          destinationId: destination,
          expectedDigest: app.digest,
        })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.disconnect", space });
      return { space: toActSpaceRef(space), appId: app.manifest.id, destination, disconnected };
    },
    async appsAutomationDisable(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const automationId = input.automation.trim();
      if (!automationId) throw new WorkFoldCliError("usage", "Provide --automation <id>.");
      const app = await requireInstalledApp(space, input.app);
      const wasEnabled = app.automations.some((automation) => automation.id === automationId && automation.enabled);
      await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.setAutomationEnabled({
          spaceId: space.id,
          appId: app.manifest.id,
          automationId,
          expectedDigest: app.digest,
          enabled: false,
        })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.automation.disable", space });
      return {
        space: toActSpaceRef(space),
        appId: app.manifest.id,
        automationId,
        disabled: true as const,
        wasEnabled,
      };
    },
    async appsAutomationRun(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const automationId = input.automation.trim();
      if (!automationId) throw new WorkFoldCliError("usage", "Provide --automation <id>.");
      const app = await requireInstalledApp(space, input.app);
      const result = await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.runAutomationNow({
          spaceId: space.id,
          appId: app.manifest.id,
          automationId,
          expectedDigest: app.digest,
        })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.automation.run", space });
      return {
        space: toActSpaceRef(space),
        appId: app.manifest.id,
        automationId,
        run: toActAppAutomationRunRef(result.run),
      };
    },
    async appsProjectDeclare(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const presentation = await readAppPresentationFile(input.presentationPath, input.cwd);
      return runActOperation(() => runRestrictedAppMutation(state, space.id, async () => {
        const prior = (await state.restrictedApps.localAppStudio(space.id)).project?.presentation ?? null;
        const project = await state.restrictedApps.declareLocalAppProject({ spaceId: space.id, presentation });
        recordFacadeAction(state, input.parentTaskId, { command: "apps.project.declare", space });
        return {
          space: toActSpaceRef(space),
          project: { projectId: project.projectId, presentation: toActAppPresentation(project.presentation) },
          priorPresentation: prior ? toActAppPresentation(prior) : null,
          priorPresentationRef: prior ? shortContentRef(prior) : null,
        };
      }));
    },
    async appsReleasePrepare(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const release = await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.prepareLocalAppRelease({ spaceId: space.id, displayVersion: input.version })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.release.prepare", space });
      return { space: toActSpaceRef(space), release: toActAppReleaseRef(release) };
    },
    async appsReleasePublish(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const release = await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.publishLocalAppRelease({ spaceId: space.id, releaseDigest: input.release })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.release.publish", space });
      return { space: toActSpaceRef(space), release: toActAppReleaseRef(release) };
    },
    async appsReleaseDelete(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const deletion = await runActOperation(() => runRestrictedAppMutation(state, space.id, () =>
        state.restrictedApps.deleteLocalAppRelease({ spaceId: space.id, releaseDigest: input.release })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.release.delete", space });
      return {
        space: toActSpaceRef(space),
        releaseDigest: input.release,
        deleted: deletion.deleted,
        cleanupPending: deletion.cleanupPending,
      };
    },
    async appsInstallPrepare(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const target = await resolveSpace(input.targetSpace);
      const operation = await runActOperation(() => runRestrictedAppMutations(state, [space.id, target.id], () =>
        state.restrictedApps.prepareLocalAppInstall({
          sourceSpaceId: space.id,
          targetSpaceId: target.id,
          releaseDigest: input.release,
        })));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.install.prepare", space });
      return {
        space: toActSpaceRef(space),
        targetSpace: toActSpaceRef(target),
        operation: toActAppOperationRef(operation),
      };
    },
    async appsUpdatePrepare(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      return runActOperation(async () => {
        const studio = await state.restrictedApps.localAppStudio(space.id);
        const instance = studio.instances.find((item) => item.runtimeInstanceId === input.instance);
        if (!instance) throw new WorkFoldCliError("notFound", "Local App Instance not found.");
        const target = await getSpace(instance.spaceId);
        const operation = await runRestrictedAppMutations(state, [space.id, target.id], () =>
          state.restrictedApps.prepareLocalAppUpdate({
            sourceSpaceId: space.id,
            runtimeInstanceId: instance.runtimeInstanceId,
            releaseDigest: input.release,
          }));
        recordFacadeAction(state, input.parentTaskId, { command: "apps.update.prepare", space });
        return {
          space: toActSpaceRef(space),
          targetSpace: toActSpaceRef(target),
          operation: toActAppOperationRef(operation),
        };
      });
    },
    async appsOperationActivate(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      return runActOperation(async () => {
        const studio = await state.restrictedApps.localAppStudio(space.id);
        const operation = studio.operations.find((item) => item.operationId === input.operation);
        if (!operation) throw new WorkFoldCliError("notFound", "Prepared App operation not found.");
        const target = await getSpace(operation.targetSpaceId);
        const result = await runRestrictedAppMutations(state, [space.id, target.id], () => operation.kind === "install"
          ? state.restrictedApps.activateLocalAppInstall(operation.operationId)
          : state.restrictedApps.activateLocalAppUpdate(operation.operationId));
        recordFacadeAction(state, input.parentTaskId, { command: "apps.operation.activate", space });
        return {
          space: toActSpaceRef(space),
          operationId: operation.operationId,
          operationKind: operation.kind,
          instance: toActAppInstanceRef(result.instance),
        };
      });
    },
    async appsOperationCancel(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const cancelled = await runActOperation(() => runRestrictedAppMutation(state, space.id, async () => {
        const studio = await state.restrictedApps.localAppStudio(space.id);
        if (!studio.operations.some((operation) => operation.operationId === input.operation)) {
          throw new WorkFoldCliError("notFound", "Prepared App operation not found.");
        }
        return state.restrictedApps.cancelLocalAppOperation(input.operation);
      }));
      recordFacadeAction(state, input.parentTaskId, { command: "apps.operation.cancel", space });
      return { space: toActSpaceRef(space), operationId: input.operation, cancelled };
    },
    async appsUninstall(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      return runActOperation(async () => {
        const installed = (await state.restrictedApps.list(space.id)).find((app) => (
          app.runtimeInstanceKind === "app" && app.runtimeInstanceId === input.instance
        ));
        if (!installed) throw new WorkFoldCliError("notFound", "Local App Instance not found.");
        const result = await runRestrictedAppMutations(state, [installed.sourceSpaceId, space.id], () =>
          state.restrictedApps.uninstallLocalApp({
            runtimeInstanceId: input.instance,
            // The purge disposition is consecration 3 and stages upstream;
            // this facade method is deliberately retain-only.
            dataDisposition: "retain",
          }), { requiredSpaceIds: [space.id] });
        recordFacadeAction(state, input.parentTaskId, { command: "apps.uninstall", space });
        return {
          space: toActSpaceRef(space),
          runtimeInstanceId: input.instance,
          removed: result.removed,
          retainedNamespaceIds: result.retainedData.map((item) => item.dataNamespaceId),
          cleanupPending: result.cleanupPending,
        };
      });
    },
    async spacesDelete(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      if (space.location.storage !== "managed") {
        throw new WorkFoldCliError(
          "conflict",
          "Only a managed Space's folder can be deleted. Removing a linked registration is 'spaces unregister'; the folder is yours either way.",
        );
      }
      // The same read-only impact checks the removal orchestration runs
      // (docs/fold-act-ledger.md, conflict rule 4): staging refuses what the
      // desktop removal would refuse, including the live-publication block.
      const impact = await runActOperation(() => state.restrictedApps.spaceRemovalImpact(space.id));
      if (impact.activeSourceInstanceCount > 0 || impact.activeTargetInstanceCount > 0) {
        throw new WorkFoldCliError("conflict", "Uninstall release-backed Apps from this Space before staging its deletion.");
      }
      if (impact.retainedDataCount > 0) {
        throw new WorkFoldCliError("conflict", "Purge this App Project's retained local data in App Studio before staging its source Space's deletion.");
      }
      let livePublications;
      try {
        livePublications = await state.publications.activePublicationsForSpace(space.id);
      } catch (error) {
        throw new WorkFoldCliError("conflict", errorMessage(error), { cause: error });
      }
      if (livePublications.length) {
        const named = livePublications.slice(0, 3).map((publication) => `"${publication.title}"`).join(", ");
        const more = livePublications.length > 3 ? ", …" : "";
        throw new WorkFoldCliError(
          "conflict",
          `Stop sharing ${livePublications.length === 1 ? "the page" : `${livePublications.length} pages`} `
            + `served from this Space before staging its deletion: ${named}${more}.`,
        );
      }
      const staged = await stageConsecration({
        kind: "space.delete-folder",
        parameters: { spaceId: space.id },
        pins: { spaceId: space.id, spaceRoot: space.spaceRoot },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "spaces.delete", space, decisionId: staged.decisionId });
      return { space: toActSpaceRef(space), staged };
    },
    async filesDestroy(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      if (!input.paths.length) throw new WorkFoldCliError("usage", "Provide at least one --path <space-path>.");
      const paths: string[] = [];
      const contentIdentities: string[] = [];
      for (const raw of input.paths) {
        let absolute: string;
        try {
          absolute = resolveSpacePath(space.spaceRoot, raw);
        } catch (error) {
          throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
        }
        const normalized = relative(space.spaceRoot, absolute).split(sep).join("/");
        if (!normalized) throw new WorkFoldCliError("usage", "The Space root itself cannot be staged for destruction.");
        try {
          contentIdentities.push(await observedDestroyIdentity(absolute));
        } catch (error) {
          if (error instanceof WorkFoldCliError) throw error;
          throw new WorkFoldCliError("notFound", `Not found in this Space: ${normalized}.`, { cause: error });
        }
        paths.push(normalized);
      }
      const staged = await stageConsecration({
        kind: "files.destroy",
        parameters: { spaceId: space.id, paths },
        pins: { spaceId: space.id, paths, contentIdentities },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "files.destroy", space, decisionId: staged.decisionId });
      return { space: toActSpaceRef(space), staged, paths, contentIdentities };
    },
    async toolsImportSkill(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = input.scope === "space" ? await resolveSpace(input.space ?? "") : undefined;
      const source = isAbsolute(input.from) ? resolve(input.from) : resolve(input.cwd, input.from);
      const info = await lstat(source).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) {
        throw new WorkFoldCliError("notFound", "The skill bundle must be a regular file on this machine.");
      }
      if (info.size > 100 * 1024 * 1024) {
        throw new WorkFoldCliError("usage", "The skill bundle exceeds the 100 MB archive limit.");
      }
      const bytes = await readFile(source);
      const contentDigest = piSkillBundleContentDigest(bytes);
      const skillNames = await enumerateSkillBundleNames(basename(source), bytes);
      const scopedSpace: FoldStagedActFields = space ? { spaceId: space.id } : {};
      const staged = await stageConsecration({
        kind: "capability.skills.import",
        parameters: { source, scope: input.scope, ...scopedSpace },
        pins: { source, contentDigest, skillNames },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, {
        command: "tools.import-skill",
        ...(space ? { space } : {}),
        decisionId: staged.decisionId,
      });
      return {
        scope: input.scope,
        ...(space ? { space: toActSpaceRef(space) } : {}),
        staged,
        source,
        contentDigest,
        skillNames,
      };
    },
    async toolsInstall(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = input.scope === "space" ? await resolveSpace(input.space ?? "") : undefined;
      const scopedSpace: FoldStagedActFields = space ? { spaceId: space.id } : {};
      const record = (staged: WorkFoldActStagedDecision): void =>
        recordFacadeAction(state, input.parentTaskId, {
          command: "tools.install",
          ...(space ? { space } : {}),
          decisionId: staged.decisionId,
        });
      if (input.catalogId !== undefined) {
        // Remote inspection is read-only and can take seconds; it completes
        // before anything is staged, exactly as the desktop review does.
        const details = await runActOperation(() => state.capabilityRegistry.details(input.catalogId!));
        if (details.sourceKind === "reference") {
          throw new WorkFoldCliError("usage", "This capability is a reference and cannot be installed directly.");
        }
        if (details.sourceKind === "bundle") {
          // An official catalog skill bundle makes bytes runnable as a skill
          // import: the exact built bytes are digest-pinned, and approval
          // rebuilds and re-verifies them.
          const bundle = await runActOperation(() => state.capabilityRegistry.buildOfficialSkillBundle(input.catalogId!));
          const contentDigest = piSkillBundleContentDigest(bundle.bytes);
          const skillNames = details.skills?.length
            ? [...details.skills].sort()
            : await enumerateSkillBundleNames(bundle.fileName, bundle.bytes);
          const staged = await stageConsecration({
            kind: "capability.skills.import",
            parameters: { source: input.catalogId, scope: input.scope, ...scopedSpace },
            pins: { source: input.catalogId, contentDigest, skillNames },
            parentTaskId: input.parentTaskId,
            requestId: input.requestId,
          });
          record(staged);
          return {
            scope: input.scope,
            ...(space ? { space: toActSpaceRef(space) } : {}),
            staged,
            source: input.catalogId,
            contentDigest,
            skillNames,
          };
        }
        if (!details.installSource || !details.version) {
          throw new WorkFoldCliError(
            "unavailable",
            "work-fold cannot pin an exact version for this package source yet, so it cannot stage this install. Install it from Assistant tools on the desktop.",
          );
        }
        const resourceSummary = capabilityResourceSummary(details);
        const staged = await stageConsecration({
          kind: "capability.package.install",
          parameters: { catalogId: input.catalogId, scope: input.scope, ...scopedSpace },
          pins: {
            packageId: details.id,
            version: details.version,
            source: details.installSource,
            scope: input.scope,
            resourceSummary,
          },
          parentTaskId: input.parentTaskId,
          requestId: input.requestId,
        });
        record(staged);
        return {
          scope: input.scope,
          ...(space ? { space: toActSpaceRef(space) } : {}),
          staged,
          source: details.installSource,
          packageId: details.id,
          version: details.version,
          resourceSummary,
        };
      }
      const identity = npmSourceIdentity(input.source ?? "");
      if (!identity) {
        throw new WorkFoldCliError(
          "unavailable",
          "work-fold can pin an exact version only for npm package sources yet, so it cannot stage this install. Install it from Assistant tools on the desktop.",
        );
      }
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.installSource || !details.version) {
        throw new WorkFoldCliError("unavailable", "npm did not report an exact installable version for this package.");
      }
      if (identity.pinnedVersion !== undefined && identity.pinnedVersion !== details.version) {
        throw new WorkFoldCliError(
          "conflict",
          `work-fold inspects the latest published version (${details.version}) and can stage only that exact version; `
            + `the source pins ${identity.pinnedVersion}. Stage without a version pin, or use the inspected version.`,
        );
      }
      const resourceSummary = capabilityResourceSummary(details);
      const staged = await stageConsecration({
        kind: "capability.package.install",
        parameters: { source: details.installSource, scope: input.scope, ...scopedSpace },
        pins: {
          packageId: details.id,
          version: details.version,
          source: details.installSource,
          scope: input.scope,
          resourceSummary,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      record(staged);
      return {
        scope: input.scope,
        ...(space ? { space: toActSpaceRef(space) } : {}),
        staged,
        source: details.installSource,
        packageId: details.id,
        version: details.version,
        resourceSummary,
      };
    },
    async toolsUpdate(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = input.scope === "space" ? await resolveSpace(input.space ?? "") : undefined;
      const source = input.source.trim();
      const identity = npmSourceIdentity(source);
      if (!identity) {
        throw new WorkFoldCliError(
          "unavailable",
          "work-fold can pin an exact version only for npm package sources yet, so it cannot stage this update. Update it from Assistant tools on the desktop.",
        );
      }
      // Mirror the update path's configured-scope requirement at staging so
      // the refusal is honest and early; the capability fence is not needed
      // for this read.
      const root = space ? space.spaceRoot : workFoldManagementRoot();
      const piScope = space ? "project" : "user";
      const configured = (await runActOperation(() => listPiPackages(root, state.runtimeProvider)))
        .find((item) => item.source === source && item.scope === piScope);
      if (!configured) {
        throw new WorkFoldCliError("notFound", `Package is not configured in the requested scope: ${source}`);
      }
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.version) {
        throw new WorkFoldCliError("unavailable", "npm did not report an exact version for this package.");
      }
      const resourceSummary = capabilityResourceSummary(details);
      const scopedSpace: FoldStagedActFields = space ? { spaceId: space.id } : {};
      const staged = await stageConsecration({
        kind: "capability.package.update",
        parameters: { source, scope: input.scope, ...scopedSpace },
        pins: {
          packageId: details.id,
          version: details.version,
          source,
          scope: input.scope,
          resourceSummary,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, {
        command: "tools.update",
        ...(space ? { space } : {}),
        decisionId: staged.decisionId,
      });
      return {
        scope: input.scope,
        ...(space ? { space: toActSpaceRef(space) } : {}),
        staged,
        source,
        packageId: details.id,
        version: details.version,
        resourceSummary,
      };
    },
    async appsInstallProposal(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const proposal = await runActOperation(() => state.restrictedAppProposals.get(input.proposal));
      if (!proposal || proposal.spaceId !== space.id || proposal.conversationId !== input.conversationId) {
        throw new WorkFoldCliError("notFound", "App proposal not found.");
      }
      if (proposal.status !== "pending") {
        throw new WorkFoldCliError(
          "conflict",
          proposal.status === "revision-changed"
            ? "The package changed after review; review the new revision before staging its install."
            : `This app review is ${proposal.status}; only a pending review can be staged.`,
        );
      }
      const staged = await stageConsecration({
        kind: "app.review.approve",
        parameters: { spaceId: space.id, proposalId: proposal.id },
        pins: { proposalId: proposal.id, reviewDigest: proposal.review.digest },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.install-proposal", space, decisionId: staged.decisionId });
      return { space: toActSpaceRef(space), staged, proposalId: proposal.id, digest: proposal.review.digest };
    },
    async appsInstallPreview(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const packagePath = input.packagePath.trim();
      if (!packagePath) throw new WorkFoldCliError("usage", "Provide --package <space-path>.");
      // The host inspects the package and owns every review field and the
      // digest — the same review record the Chat proposal path creates, under
      // an act-lane marker instead of a conversation. A repeated stage of the
      // same unchanged package converges on the same pending review, so the
      // staged act dedupes onto one card and denial memory holds.
      const proposal = await runActOperation(async () => {
        const result = await state.restrictedAppProposals.propose({
          spaceId: space.id,
          spaceRoot: space.spaceRoot,
          conversationId: workFoldActInstallPreviewConversationId,
          sourcePath: packagePath,
        });
        if (result.status !== "pending" || !result.proposal) {
          throw new WorkFoldCliError("failure", "The package review could not be recorded.");
        }
        return result.proposal;
      });
      const replacesInstalled = (await runActOperation(() => state.restrictedApps.list(space.id)))
        .some((app) => app.manifest.id === proposal.review.manifest.id);
      // The same staged kind and pins as an approved Chat proposal
      // (docs/fold-consecrations.md keeps the vocabulary closed): approval
      // rides the digest-checked install path, and a package edited after
      // review surfaces as the existing REVISION_CHANGED refusal.
      const staged = await stageConsecration({
        kind: "app.review.approve",
        parameters: { spaceId: space.id, proposalId: proposal.id },
        pins: { proposalId: proposal.id, reviewDigest: proposal.review.digest },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      return {
        space: toActSpaceRef(space),
        staged,
        proposalId: proposal.id,
        digest: proposal.review.digest,
        title: proposal.review.manifest.title,
        packageName: proposal.review.packageName,
        version: proposal.review.version,
        replacesInstalled,
      };
    },
    async appsGrant(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const app = await requireInstalledApp(space, input.app);
      if (input.digest.trim() !== app.digest) {
        throw new WorkFoldCliError(
          "conflict",
          "Grants bind to the exact reviewed digest, and the installed app's digest is different. Read the current revision's review before staging.",
        );
      }
      const declaration = input.declaration.trim();
      const declared = input.kind === "network"
        ? app.manifest.permissions.network.some((item) => item.id === declaration)
        : input.kind === "files"
          ? app.manifest.permissions.files.some((item) => item.id === declaration)
          : app.manifest.permissions.notifications.some((item) => item.id === declaration);
      if (!declared) throw new WorkFoldCliError("notFound", "The app does not declare this permission.");
      const kind = input.kind === "network"
        ? "app.grant.network" as const
        : input.kind === "files"
          ? "app.grant.files" as const
          : "app.grant.notifications" as const;
      const staged = await stageConsecration({
        kind,
        parameters: { spaceId: space.id, appInstanceId: app.featureInstallationId, declarationId: declaration },
        pins: {
          appInstanceId: app.featureInstallationId,
          declarationId: declaration,
          releaseDigest: app.releaseDigest ?? app.digest,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.grant", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        appId: app.manifest.id,
        grantKind: input.kind,
        declaration,
      };
    },
    async appsConnect(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const app = await requireInstalledApp(space, input.app);
      const destination = app.manifest.permissions.network.find((item) => item.id === input.destination.trim());
      if (!destination) throw new WorkFoldCliError("notFound", "The app does not declare this connection destination.");
      const target = destination.target.kind === "public-https"
        ? String(destination.target.origin)
        : `http://${String(destination.target.host)}:${String(destination.target.port)}`;
      // The staged act names the connection's shape only — app, destination,
      // target, adapter — never a secret. The browser sign-in adapter is
      // preferred because it is the one flow approval can open without a
      // person typing a credential.
      const adapterKind = destination.auth.some((item) => item.kind === "oauth2-pkce")
        ? "oauth2-pkce"
        : destination.auth[0]?.kind;
      if (!adapterKind) throw new WorkFoldCliError("conflict", "This destination declares no credential adapter to connect with.");
      const staged = await stageConsecration({
        kind: "app.connection.save",
        parameters: { spaceId: space.id, appInstanceId: app.featureInstallationId, destinationId: destination.id },
        pins: {
          appInstanceId: app.featureInstallationId,
          declarationId: destination.id,
          target,
          adapterKind,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.connect", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        appId: app.manifest.id,
        destination: destination.id,
        target,
        adapterKind,
      };
    },
    async appsAutomationEnable(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const app = await requireInstalledApp(space, input.app);
      const automationId = input.automation.trim();
      const declaration = app.manifest.automations.find((item) => item.id === automationId);
      if (!declaration) throw new WorkFoldCliError("notFound", "The app does not declare this automation.");
      if (app.automations.some((automation) => automation.id === automationId && automation.enabled)) {
        throw new WorkFoldCliError("conflict", "This automation is already enabled; there is nothing to stage.");
      }
      const scheduleSummary = restrictedAppAutomationScheduleSummary(declaration);
      const staged = await stageConsecration({
        kind: "app.automation.enable",
        parameters: { spaceId: space.id, appInstanceId: app.featureInstallationId, automationId },
        pins: {
          appInstanceId: app.featureInstallationId,
          automationId,
          reviewedDigest: app.digest,
          scheduleSummary,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.automation.enable", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        appId: app.manifest.id,
        automationId,
        scheduleSummary,
      };
    },
    async appsStorageClear(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const app = await requireInstalledApp(space, input.app);
      // The card states the byte count being destroyed; without an observable
      // count the act refuses instead of staging a blind destruction.
      const usage = await runActOperation(() => state.restrictedApps.storageUsage(space.id, app.manifest.id, app.digest));
      const staged = await stageConsecration({
        kind: "app.storage.clear",
        parameters: { spaceId: space.id, appInstanceId: app.featureInstallationId },
        pins: {
          appInstanceId: app.featureInstallationId,
          dataNamespaceIds: [app.dataNamespaceId],
          observedBytes: usage.usageBytes,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.storage.clear", space, decisionId: staged.decisionId });
      return { space: toActSpaceRef(space), staged, appId: app.manifest.id, observedBytes: usage.usageBytes };
    },
    async appsRetainedPurge(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const studio = await runActOperation(() => state.restrictedApps.localAppStudio(space.id));
      const retained = studio.retainedData.find((item) => item.retainedDataId === input.retained.trim());
      if (!retained) throw new WorkFoldCliError("notFound", "Retained App data record not found in this Space's App Studio.");
      const staged = await stageConsecration({
        kind: "app.data.purge",
        parameters: { spaceId: space.id, appInstanceId: retained.featureInstallationId },
        pins: {
          appInstanceId: retained.featureInstallationId,
          dataNamespaceIds: [retained.dataNamespaceId],
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.retained.purge", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        retainedDataId: retained.retainedDataId,
        dataNamespaceIds: [retained.dataNamespaceId],
      };
    },
    async appsUninstallPurge(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const installed = (await runActOperation(() => state.restrictedApps.list(space.id))).find((app) => (
        app.runtimeInstanceKind === "app" && app.runtimeInstanceId === input.instance
      ));
      if (!installed) throw new WorkFoldCliError("notFound", "Local App Instance not found.");
      const staged = await stageConsecration({
        kind: "app.data.purge",
        parameters: { spaceId: space.id, appInstanceId: installed.featureInstallationId },
        pins: {
          appInstanceId: installed.featureInstallationId,
          dataNamespaceIds: [installed.dataNamespaceId],
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "apps.uninstall", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        runtimeInstanceId: installed.runtimeInstanceId,
        dataNamespaceIds: [installed.dataNamespaceId],
      };
    },
    async routingsStage(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const { declaration, digest } = await readRoutingStagingFile(input.proposalPath, input.cwd);
      const referencedSpaceIds = workFoldRoutingReferencedSpaceIds(declaration);
      for (const spaceId of referencedSpaceIds) {
        const registered = await getSpace(spaceId).catch(() => null);
        if (!registered) {
          throw new WorkFoldCliError(
            "conflict",
            `The routing references a Space that is not registered on this machine (${spaceId}); the enablement card could not show it by name.`,
          );
        }
      }
      // Hold the exact normalized declaration before the card exists, so a
      // pending card always has its reviewed bytes; pruning afterwards keeps
      // only digests still pinned by pending cards.
      await holdStagedRoutingDeclaration(declaration, digest);
      const staged = await stageConsecration({
        kind: "routing.enable",
        parameters: { routingId: declaration.id },
        pins: { routingId: declaration.id, declarationDigest: digest },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      await pruneStagedRoutingDeclarations(state.stagedActs).catch(() => undefined);
      recordFacadeAction(state, input.parentTaskId, { command: "routings.stage", decisionId: staged.decisionId });
      return {
        staged,
        routingId: declaration.id,
        declarationDigest: digest,
        title: declaration.title,
        referencedSpaceIds,
      };
    },
    async pagesStage(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const title = input.title.trim();
      if (!title || title.length > WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH || /[\r\n]/.test(title)) {
        throw new WorkFoldCliError(
          "usage",
          `A page title of 1 through ${WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH} characters is required.`,
        );
      }
      const status = state.publications.status();
      if (status.damaged) {
        throw new WorkFoldCliError("failure", `work-fold cannot stage a page: ${status.damageReason ?? "the publication store is damaged."}`);
      }
      const source = await stagedPageSource(space.spaceRoot, input.path);
      const snapshotEnabled = input.snapshot === true;
      const staged = await stageConsecration({
        kind: "publish.viewer.expose",
        parameters: { exposure: "page", spaceId: space.id },
        pins: {
          exposure: "page",
          spaceId: space.id,
          relativePath: source.relativePath,
          title,
          snapshotEnabled,
          byteBudget: WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
          serveBudget: WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "pages.stage", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        relativePath: source.relativePath,
        title,
        snapshotEnabled,
        serveRatePerMinute: WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
        byteBudgetPerDay: WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
      };
    },
    async pagesStageApp(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const space = await resolveSpace(input.space);
      const status = state.publications.status();
      if (status.damaged) {
        throw new WorkFoldCliError("failure", `work-fold cannot stage an app exposure: ${status.damageReason ?? "the publication store is damaged."}`);
      }
      // Exposure eligibility and pins come from the viewer adapter: an
      // installed App Instance of a prepared Release whose reviewed manifest
      // declares a viewer surface. The decision-time recheck re-resolves the
      // same identity before anything activates. `--instance` accepts the App
      // Instance id (the pin identity) or, like `apps uninstall`, the
      // Runtime Instance id of an app installed in this Space.
      const requested = input.instance.trim();
      const byRuntimeId = (await runActOperation(() => state.restrictedApps.list(space.id)))
        .find((app) => app.runtimeInstanceKind === "app" && app.runtimeInstanceId === requested);
      const exposure = await state.restrictedAppViewer.resolveExposure(byRuntimeId?.featureInstallationId ?? requested);
      if (!exposure.eligible) throw new WorkFoldCliError("conflict", exposure.issue);
      if (exposure.spaceId !== space.id) {
        throw new WorkFoldCliError("notFound", "This Space has no installed App Instance with this id.");
      }
      const alreadyExposed = (await runActOperation(() => state.publications.list())).some((view) => (
        view.state === "active" && view.kind === "app" && view.app?.appInstanceId === exposure.pins.appInstanceId
      ));
      if (alreadyExposed) {
        throw new WorkFoldCliError("conflict", "This App Instance is already at your address; stop sharing it before exposing it again.");
      }
      const staged = await stageConsecration({
        kind: "publish.viewer.expose",
        parameters: { exposure: "hosted-app", appInstanceId: exposure.pins.appInstanceId },
        pins: {
          exposure: "hosted-app",
          appInstanceId: exposure.pins.appInstanceId,
          releaseDigest: exposure.pins.releaseDigest,
          viewerEntry: exposure.pins.viewerEntry,
          viewerSurface: exposure.pins.viewerSurface,
        },
        parentTaskId: input.parentTaskId,
        requestId: input.requestId,
      });
      recordFacadeAction(state, input.parentTaskId, { command: "pages.stage-app", space, decisionId: staged.decisionId });
      return {
        space: toActSpaceRef(space),
        staged,
        appId: exposure.appId,
        title: exposure.title,
        appInstanceId: exposure.pins.appInstanceId,
        releaseDigest: exposure.pins.releaseDigest,
        viewerEntry: exposure.pins.viewerEntry,
        viewerSurface: exposure.pins.viewerSurface,
        serveRatePerMinute: WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
        byteBudgetPerDay: WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
      };
    },
    async routingsList() {
      const projections = await runActOperation(() => state.routings.listRoutings());
      return { routings: projections.map(toActRoutingSummary) };
    },
    async routingsShow(input) {
      const routingId = input.routing.trim();
      const projection = await runActOperation(() => state.routings.getRouting(routingId));
      if (!projection) throw new WorkFoldCliError("notFound", "No routing has this id on this machine.");
      const spaceNames = new Map<string, string>();
      for (const spaceId of workFoldRoutingReferencedSpaceIds(projection.declaration)) {
        const registered = await getSpace(spaceId).catch(() => null);
        if (registered) spaceNames.set(spaceId, registered.name);
      }
      const named = (spaceId: string) => (spaceNames.has(spaceId) ? { spaceName: spaceNames.get(spaceId)! } : {});
      return {
        routing: {
          ...toActRoutingSummary(projection),
          steps: projection.declaration.steps.map((step) => step.kind === "chat"
            ? { id: step.id, kind: "chat" as const, spaceId: step.space, ...named(step.space), message: step.message }
            : step.kind === "files"
              ? {
                id: step.id,
                kind: "files" as const,
                fromSpaceId: step.fromSpace,
                ...(spaceNames.has(step.fromSpace) ? { fromSpaceName: spaceNames.get(step.fromSpace)! } : {}),
                source: toActRoutingFilesSource(step.from),
                toSpaceId: step.toSpace,
                ...(spaceNames.has(step.toSpace) ? { toSpaceName: spaceNames.get(step.toSpace)! } : {}),
                to: step.to,
              }
              : { id: step.id, kind: "check" as const, spaceId: step.space, ...named(step.space), ...(step.check ? { checkId: step.check } : {}) }),
          grants: projection.grants.map((grant) => ({
            digest: grant.digest,
            decisionId: grant.decisionId,
            approvedAt: grant.approvedAt,
            surface: grant.surface,
            ...(grant.browserId ? { browserId: grant.browserId } : {}),
          })),
        },
      };
    },
    async routingsRun(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const routingId = input.routing.trim();
      const projection = await runActOperation(() => state.routings.getRouting(routingId));
      if (!projection) throw new WorkFoldCliError("notFound", "No routing has this id on this machine.");
      const run = await runActOperation(() => state.routings.runNow(routingId, {
        ...(input.requestId ? { requestId: input.requestId } : {}),
      }));
      return {
        routingId,
        title: projection.declaration.title,
        run: {
          runId: run.runId,
          outcome: run.outcome,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          ...(run.error !== undefined ? { error: run.error } : {}),
        },
      };
    },
    async routingsStop(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const routingId = input.routing.trim();
      const stopped = state.routings.stopRun(routingId);
      if (!stopped) {
        throw new WorkFoldCliError("conflict", "This routing has no active run; its settled state already stands.");
      }
      return { routingId, stopped: true as const, runId: stopped.runId };
    },
    async routingsDisable(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const routingId = input.routing.trim();
      const result = await runActOperation(() => state.routings.disable(routingId));
      return {
        routingId,
        disabled: true as const,
        digest: result.record.digest,
        stoppedRunId: result.stoppedRunId,
      };
    },
    async routingsDelete(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const routingId = input.routing.trim();
      const record = await runActOperation(() => state.routings.deleteRouting(routingId));
      if (record.health !== "disabled" && record.health !== "suspended") {
        throw new WorkFoldCliError("failure", "The routing was deleted in an unexpected health state.");
      }
      return { routingId, deleted: true as const, digest: record.digest, finalHealth: record.health };
    },
    async routingsReceipts(input) {
      const routingFilter = input.routing?.trim();
      const parsed: WorkFoldActRoutingReceipt[] = [];
      let damagedLineCount = 0;
      for (const path of [workFoldRoutingReceiptsRotatedFile(), workFoldRoutingReceiptsFile()]) {
        const text = await readFile(path, "utf8").catch(() => null);
        if (!text) continue;
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line) as Record<string, unknown>;
          } catch {
            damagedLineCount += 1;
            continue;
          }
          const { at, scope, outcome, routingId } = record;
          if (
            typeof at !== "string"
            || typeof outcome !== "string"
            || typeof routingId !== "string"
            || (scope !== "routing" && scope !== "run" && scope !== "hop")
          ) {
            damagedLineCount += 1;
            continue;
          }
          if (routingFilter && routingId !== routingFilter) continue;
          const { v: _version, ...fields } = record;
          parsed.push({ ...fields, at, scope, outcome, routingId } as WorkFoldActRoutingReceipt);
        }
      }
      const receipts = parsed.slice(-500);
      return { receipts, truncated: parsed.length > receipts.length, damagedLineCount };
    },
    async pagesList() {
      const views = await runActOperation(() => state.publications.list());
      const spaceNames = new Map<string, string>();
      for (const view of views) {
        if (spaceNames.has(view.spaceId)) continue;
        const registered = await getSpace(view.spaceId).catch(() => null);
        if (registered) spaceNames.set(view.spaceId, registered.name);
      }
      return { publications: views.map((view) => toActPublicationRef(view, spaceNames.get(view.spaceId))) };
    },
    async pagesStatus(input) {
      const publicationId = input.publication.trim();
      const view = await runActOperation(() => state.publications.get(publicationId));
      if (!view) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const registered = await getSpace(view.spaceId).catch(() => null);
      return { publication: toActPublicationRef(view, registered?.name) };
    },
    async pagesRevoke(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const publicationId = input.publication.trim();
      const prior = await runActOperation(() => state.publications.get(publicationId));
      if (!prior) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const registered = await getSpace(prior.spaceId).catch(() => null);
      if (prior.state !== "active") {
        return { publication: toActPublicationRef(prior, registered?.name), alreadyRevoked: true };
      }
      const view = await runActOperation(() => state.publications.revoke(publicationId, {
        requestId: input.requestId ?? randomUUID(),
        surface: "cli",
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      }));
      return { publication: toActPublicationRef(view, registered?.name), alreadyRevoked: false };
    },
    async pagesNarrow(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const publicationId = input.publication.trim();
      const prior = await runActOperation(() => state.publications.get(publicationId));
      if (!prior) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const view = await runActOperation(() => state.publications.narrowBudgets(publicationId, {
        ...(input.serveRatePerMinute !== undefined ? { serveRatePerMinute: input.serveRatePerMinute } : {}),
        ...(input.byteBudgetPerDay !== undefined ? { byteBudgetPerDay: input.byteBudgetPerDay } : {}),
      }, {
        requestId: input.requestId ?? randomUUID(),
        surface: "cli",
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      }));
      const registered = await getSpace(view.spaceId).catch(() => null);
      return {
        publication: toActPublicationRef(view, registered?.name),
        priorServeRatePerMinute: prior.serveRatePerMinute,
        priorByteBudgetPerDay: prior.byteBudgetPerDay,
      };
    },
    async pagesSnapshotOff(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const publicationId = input.publication.trim();
      const prior = await runActOperation(() => state.publications.get(publicationId));
      if (!prior) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const view = await runActOperation(() => state.publications.disableSnapshot(publicationId, {
        requestId: input.requestId ?? randomUUID(),
        surface: "cli",
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      }));
      const registered = await getSpace(view.spaceId).catch(() => null);
      return { publication: toActPublicationRef(view, registered?.name), wasEnabled: prior.snapshotEnabled };
    },
    async stagedList() {
      const acts = await runStagedActStoreOperation(() => state.stagedActs.list());
      return { acts: acts.map(toStagedActSummary) };
    },
    async stagedShow(input) {
      const act = await runStagedActStoreOperation(() => state.stagedActs.get(input.id.trim()));
      if (!act) throw new WorkFoldCliError("notFound", "No staged act has this id; approval never survives restaging.");
      return { act: toStagedActDetail(act) };
    },
    async stagedCancel(input) {
      assertManagementParentAccepting(state, input.parentTaskId);
      const act = await runStagedActStoreOperation(() => state.stagedActs.cancel(input.id.trim()));
      recordFacadeAction(state, input.parentTaskId, { command: "staged.cancel", decisionId: act.id });
      return { act: toStagedActSummary(act) };
    },
    async checksEnable(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => {
        const proposalPath = isAbsolute(input.proposalPath)
          ? resolve(input.proposalPath)
          : resolve(input.cwd, input.proposalPath);
        const enabled = await runActOperation(() => state.checks.enable({
          space: space,
          proposalPath,
          actor: "cli",
        }));
        return {
          space: toActSpaceRef(space),
          check: {
            id: enabled.declaration.id,
            title: enabled.declaration.title,
            severity: enabled.declaration.severity,
            sensorId: enabled.declaration.sensor.id,
            sensorRevision: enabled.declaration.sensor.revision,
            targetCount: enabled.declaration.targets.length,
            trigger: enabled.declaration.trigger,
            targets: enabled.declaration.targets.map((target) => ({ ...target })),
          },
          declarationDigest: enabled.digest,
        };
      });
    },
    async checksDisable(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => ({
        space: toActSpaceRef(space),
        checkId: input.checkId,
        disabled: await runActOperation(() => state.checks.disable(space, input.checkId)),
      }));
    },
    async checksRun(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => {
        const accepted = await runActOperation(() => state.checks.run({
          space: space,
          ...(input.checkId ? { checkId: input.checkId } : {}),
          actor: { kind: "cli", cwd: space.spaceRoot, spaceId: space.id },
        }));
        return { space: toActSpaceRef(space), ...accepted };
      });
    },
    async checksTask(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => ({
        space: toActSpaceRef(space),
        task: await state.checks.taskStatus(space.id, input.taskId),
      }));
    },
    async checksResult(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => {
        const run = await runActOperation(() => state.checks.taskResult(space.id, input.taskId));
        if (run.state === "aborted" || run.state === "interrupted") {
          throw new WorkFoldCliError("conflict", run.error ?? "The Check run did not finish.");
        }
        if (run.state === "failed") throw new WorkFoldCliError("failure", run.error ?? "The Check run failed.");
        return { space: toActSpaceRef(space), run };
      });
    },
    async checksAbort(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => ({
        space: toActSpaceRef(space),
        taskId: input.taskId,
        aborted: await state.checks.abort(space.id, input.taskId),
      }));
    },
    async checksProblems(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => {
        const result = await runActOperation(() => state.checks.problems(space, input.checkId));
        return {
          space: toActSpaceRef(space),
          ...(input.checkId ? { checkId: input.checkId } : {}),
          ...result,
        };
      });
    },
    async checksDecide(input) {
      const space = await resolveSpace(input.space);
      return runReservedCheckOperation(state, space.id, async () => {
        const decision = await runActOperation(() => state.checks.decide({
          spaceId: space.id,
          findingId: input.findingId,
          decision: input.decision,
          actor: "cli",
          ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
        }));
        return { space: toActSpaceRef(space), findingId: input.findingId, decision };
      });
    },
    async manageList() {
      const scope = managementScope(state);
      const conversations = await runActOperation(() => listConversations(scope.rootPath));
      return { conversations: conversations.map(toActConversationRef) };
    },
    async manageSend(input) {
      const content = input.content.trim();
      if (!content) throw new WorkFoldCliError("usage", "Message content is required.");
      const scope = managementScope(state);
      const attachments = await classifyActManagementAttachments(input.attachments ?? [], input.cwd);
      return runActOperation(async () => {
        const conversationId = input.newConversation
          ? (await createConversation(scope.rootPath)).id
          : input.conversationId ?? (await resolveManagementConversation(true)).id;
        const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, spaceRoot: scope.rootPath }, conversationId, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
          managementAttachments: attachments,
          requestId: input.requestId,
        });
        return { conversationId, messageId: message.id, taskId, attachments };
      });
    },
    async manageConversationStatus(input) {
      const scope = managementScope(state);
      const conversation = input.conversationId
        ? await runActOperation(() => readConversationSummary(scope.rootPath, input.conversationId!))
        : await runActOperation(() => resolveManagementConversation(false).catch(() => null));
      if (!conversation) {
        throw new WorkFoldCliError(
          "notFound",
          input.conversationId ? "Conversation not found." : "No management conversation exists yet. Send a message to start one.",
        );
      }
      return {
        conversation: toActConversationRef(conversation),
        state: conversationRuntimeState(state, scope.id, conversation.id),
      };
    },
    async manageTurnStatus(input) {
      assertManagementInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      return {
        task: turnStatusFor(state, workFoldManagementScopeId, taskId),
        request: await managementRequestView(state, taskId),
      };
    },
    async manageStop(input) {
      assertManagementInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      return stopManagementRequest(state, taskId);
    },
    async manageConversationResult(input) {
      const scope = managementScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveManagementConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new WorkFoldCliError("notFound", "No management conversation exists yet. Send a message to start one.");
      }
      return conversationResultForScope(state, scope.id, scope.rootPath, conversationId, input.messages);
    },
    async manageTurnResult(input) {
      assertManagementInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const scope = managementScope(state);
      return turnResultForScope(state, scope.id, scope.rootPath, taskId);
    },
    async manageAbort(input) {
      const scope = managementScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveManagementConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new WorkFoldCliError("notFound", "No management conversation exists yet. Send a message to start one.");
      }
      const client = state.clients.get(clientKey(scope.id, conversationId));
      return { conversationId, aborted: client ? await client.abort() : false };
    },
    async manageGlance() {
      // Deliberately no management-readiness gate: the glance reads recorded
      // state through the kernel, never the Assistant, and stays available
      // while the management conversation is not.
      return runActOperation(() => state.kernel.getGlance({ kind: "cli" }));
    },
  };
}

/** The management scope shaped like the space refs the turn internals take. */
function managementScope(state?: LocalApiState): { id: string; rootPath: string } {
  if (state) assertManagementInstructionsReady(state);
  return { id: workFoldManagementScopeId, rootPath: workFoldManagementRoot() };
}

function assertManagementInstructionsReady(state: LocalApiState): void {
  if (!state.managementInstructionsError) return;
  throw new WorkFoldCliError(
    "unavailable",
    "The management conversation is unavailable because Space could not prepare its required instructions. Restart Space; if this continues, check the app-data management folder.",
  );
}

/** HTTP mirror of the fail-closed instructions gate: 503 instead of a CLI error. */
function assertManagementReadyForRoutes(state: LocalApiState): void {
  if (!state.managementInstructionsError) return;
  throw httpError(503, "The management conversation is unavailable because Space could not prepare its required instructions. Restart Space; if this continues, check the app-data management folder.");
}

function managementScopeForRoutes(state: LocalApiState): { id: string; rootPath: string } {
  assertManagementReadyForRoutes(state);
  return { id: workFoldManagementScopeId, rootPath: workFoldManagementRoot() };
}

/**
 * The default management conversation is the most recent active one; the
 * management surface is "one conversation" unless the caller asks for more.
 */
async function resolveManagementConversation(create: boolean): Promise<ConversationSummary> {
  const scope = managementScope();
  const conversations = await listConversations(scope.rootPath);
  const active = conversations.find((item) =>
    !item.archivedAt && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= Date.now()));
  if (active) return active;
  if (!create) throw new WorkFoldCliError("notFound", "No management conversation exists yet. Send a message to start one.");
  return createConversation(scope.rootPath);
}

async function classifyActManagementAttachments(raw: string[], cwd: string | undefined): Promise<ManagementAttachmentRef[]> {
  if (!raw.length) return [];
  try {
    return await classifyManagementAttachments(raw, cwd ?? workFoldManagementRoot());
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
}

/**
 * Rich, honest view of one management request. `done` is claimed only when
 * the management turn succeeded AND no recorded child turn is still running;
 * downstream work keeps the request in `handed_off`. A reply whose final
 * non-empty line asks a question surfaces as `needs_you` — the Assistant is
 * taught to put its question on its own closing line, and a missed detection
 * degrades to `done` with the question still fully visible in the reply.
 */
async function managementRequestView(
  state: LocalApiState,
  taskId: string,
): Promise<WorkFoldActManagementRequest | null> {
  const record = state.managementRequests.get(taskId);
  if (!record) return null;
  const turn = turnStatusFor(state, workFoldManagementScopeId, taskId);
  const children = record.childTasks.map((child) => {
    const status = turnStatusFor(state, child.spaceId, child.taskId);
    return {
      taskId: child.taskId,
      spaceId: child.spaceId,
      spaceName: child.spaceName,
      conversationId: child.conversationId,
      state: status.state,
      error: status.error,
    };
  });
  let reply: { messageId: string; content: string } | null = null;
  const replyMessageId = turn.state === "succeeded" || turn.state === "failed" ? turn.messageId : null;
  if (replyMessageId) {
    const messages = await readConversation(workFoldManagementRoot(), record.conversationId).catch(() => []);
    const message = messages.find((item) => item.id === replyMessageId);
    if (message) reply = { messageId: message.id, content: message.content };
  }
  const effectiveOutcome = turn.state === "unknown" ? record.outcome : turn.state;
  const failedChild = children.find((child) => child.state === "failed" || child.state === "unknown");
  const stoppedChild = children.find((child) => child.state === "aborted");
  let phase: WorkFoldActManagementRequestPhase;
  if (turn.state === "running" || effectiveOutcome === null) phase = "working";
  else if (effectiveOutcome === "failed") phase = "failed";
  else if (effectiveOutcome === "aborted" || record.stopRequestedAt) phase = "stopped";
  else if (children.some((child) => child.state === "running")) phase = "handed_off";
  else if (failedChild) phase = "failed";
  else if (stoppedChild) phase = "stopped";
  else if (reply && managementReplyAsksQuestion(reply.content)) phase = "needs_you";
  else phase = "done";
  return {
    taskId: record.taskId,
    conversationId: record.conversationId,
    phase,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? turn.endedAt,
    error: turn.error ?? failedChild?.error ?? (failedChild?.state === "unknown"
      ? `Space lost track of work started in ${failedChild.spaceName}.`
      : null),
    content: record.content,
    attachments: record.attachments,
    dispositions: withLibraryDispositions(record),
    actions: record.actions,
    children,
    reply,
    source: record.source,
    remotePrincipalId: record.remotePrincipalId,
    remoteRequestId: record.remoteRequestId,
  };
}

/**
 * The registry's mechanical disposition accounting, widened with the
 * Space-free `library` outcome: an attachment whose resolved path matches an
 * attributed `library add`'s recorded sources entered the personal Library.
 * Space placements keep precedence — the registry reports those first and
 * only `unrecorded` attachments are upgraded here, so one attachment never
 * tells two stories.
 */
function withLibraryDispositions(record: ManagementRequestRecord): WorkFoldActAttachmentDisposition[] {
  return managementAttachmentDispositions(record).map((disposition): WorkFoldActAttachmentDisposition => {
    if (disposition.status !== "unrecorded" || disposition.attachment.kind === "url") return disposition;
    const added = record.actions.find((action) =>
      action.command === "library.add" && action.sources?.includes(disposition.attachment.target));
    if (!added) return disposition;
    return {
      attachment: disposition.attachment,
      status: "library",
      copied: added.copied ?? [],
    };
  });
}

function managementReplyAsksQuestion(content: string): boolean {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").endsWith("?");
}

/**
 * Request-level stop. Aborting the management turn does not implicitly stop a
 * review already running in a Space — only recorded child turns are aborted,
 * each explicitly, and the result names every turn it touched.
 */
async function stopManagementRequest(
  state: LocalApiState,
  taskId: string,
): Promise<{ taskId: string; managementAborted: boolean; children: Array<{ taskId: string; conversationId: string; spaceId: string; aborted: boolean }> }> {
  const record = state.managementRequests.get(taskId);
  if (!record) {
    throw new WorkFoldCliError("notFound", "Request not found. Request records are kept while the Space app stays running.");
  }
  const managementWasRunning = turnStatusFor(state, workFoldManagementScopeId, taskId).state === "running";
  const initiallyRunningChildren = record.childTasks.filter((child) =>
    turnStatusFor(state, child.spaceId, child.taskId).state === "running");
  if (managementWasRunning || initiallyRunningChildren.length) state.managementRequests.markStopRequested(taskId);
  const runningChildren = record.childTasks.filter((child) =>
    turnStatusFor(state, child.spaceId, child.taskId).state === "running");
  let managementAborted = false;
  if (managementWasRunning) {
    managementAborted = await cancelAcceptedTurn(state, workFoldManagementScopeId, record.conversationId, taskId);
  }
  const children: Array<{ taskId: string; conversationId: string; spaceId: string; aborted: boolean }> = [];
  for (const child of runningChildren) {
    const aborted = await cancelAcceptedTurn(state, child.spaceId, child.conversationId, child.taskId);
    children.push({
      taskId: child.taskId,
      conversationId: child.conversationId,
      spaceId: child.spaceId,
      aborted,
    });
  }
  return { taskId, managementAborted, children };
}

function assertManagementParentAccepting(state: LocalApiState, parentTaskId: string | undefined): void {
  if (!parentTaskId) return;
  if (!state.managementRequests.isActive(parentTaskId)) {
    throw new WorkFoldCliError("conflict", "The management request is stopping or has already finished.");
  }
}

/**
 * Attributes one applied facade mutation to its explicitly named management
 * request, so the request's recorded story stays complete across every landed
 * verb. Space-free acts (the personal Library, personal-scope tools) record
 * no Space fields. `chat.send` keeps its own inline recording because it also
 * threads child-task bookkeeping and post-acceptance cancellation.
 */
function recordFacadeAction(
  state: LocalApiState,
  parentTaskId: string | undefined,
  input: {
    command: ManagementRequestActionCommand;
    space?: SpaceSummary;
    conversationId?: string;
    checkpointId?: string | null;
    taskId?: string;
    copied?: string[];
    /** Staged-act id for staging verbs and `staged cancel`, so the request trail points at the card. */
    decisionId?: string;
  },
): void {
  if (!parentTaskId) return;
  state.managementRequests.recordAction(parentTaskId, {
    command: input.command,
    at: new Date().toISOString(),
    ...(input.space ? { spaceId: input.space.id, spaceName: input.space.name } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.copied ? { copied: input.copied } : {}),
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
  });
}

async function cancelAcceptedTurn(
  state: LocalApiState,
  spaceId: string,
  conversationId: string,
  taskId: string,
): Promise<boolean> {
  if (turnStatusFor(state, spaceId, taskId).state !== "running") return false;
  state.cancelledTurnTasks.add(taskId);
  const client = state.clients.get(clientKey(spaceId, conversationId));
  await client?.abort().catch(() => false);
  return true;
}

async function turnResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  taskId: string,
): Promise<{ conversationId: string; task: { taskId: string; state: "succeeded"; endedAt: string }; message: WorkFoldActChatMessage }> {
  const task = turnStatusFor(state, scopeId, taskId);
  if (task.state === "running") {
    throw new WorkFoldCliError("conflict", "The turn is still running. Use chat wait or chat status --task.");
  }
  if (task.state === "unknown") {
    throw new WorkFoldCliError("notFound", "Task not found. Recent turn outcomes are kept in a bounded durable journal.");
  }
  if (task.state === "aborted") throw new WorkFoldCliError("conflict", "The turn was aborted before it finished.");
  if (task.state === "failed") throw new WorkFoldCliError("failure", task.error ?? "The turn failed.");
  const conversationId = task.conversationId!;
  const messages = await runActOperation(() => readConversation(rootPath, conversationId));
  const message = messages.find((item) => item.id === task.messageId);
  if (!message) throw new WorkFoldCliError("failure", "The turn's response message could not be found in the transcript.");
  return {
    conversationId,
    task: { taskId, state: "succeeded" as const, endedAt: task.endedAt! },
    message: toActChatMessage(message),
  };
}

async function conversationResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  conversationId: string,
  messageLimit?: number,
): Promise<{
  conversationId: string;
  state: WorkFoldActChatState;
  total: number;
  lastAssistant: string | null;
  messages: WorkFoldActChatMessage[];
}> {
  const all = await runActOperation(() => readConversation(rootPath, conversationId));
  if (!all.length) throw new WorkFoldCliError("notFound", "Conversation not found.");
  const visible = all.filter((message) => message.role === "user" || message.role === "assistant");
  const limit = Math.min(Math.max(Math.floor(messageLimit ?? 10), 1), 500);
  const lastAssistant = [...visible].reverse().find((message) => message.role === "assistant")?.content ?? null;
  return {
    conversationId,
    state: conversationRuntimeState(state, scopeId, conversationId),
    total: visible.length,
    lastAssistant,
    messages: visible.slice(-limit).map(toActChatMessage),
  };
}

async function addExternalFilesInternal(
  space: SpaceSummary,
  input: { fromPaths: string[]; toDir?: string; cwd: string },
): Promise<{ copied: string[]; checkpointId: string | null }> {
  if (!input.fromPaths.length) throw new WorkFoldCliError("usage", "Provide at least one --from <path> to add.");
  if (input.fromPaths.length > maxActAddSources) {
    throw new WorkFoldCliError("usage", `At most ${maxActAddSources} sources can be added at once.`);
  }
  const toDir = normalizeSpaceRelativePath(input.toDir ?? "");
  const sources: string[] = [];
  for (const raw of input.fromPaths) {
    const trimmed = raw.trim();
    if (!trimmed) throw new WorkFoldCliError("usage", "Source paths cannot be empty.");
    const source = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
    const info = await lstat(source).catch(() => null);
    if (!info) throw new WorkFoldCliError("notFound", `Source not found: ${trimmed}.`);
    if (info.isSymbolicLink()) throw new WorkFoldCliError("usage", `Symbolic-link sources cannot be added: ${trimmed}.`);
    if (!info.isFile() && !info.isDirectory()) {
      throw new WorkFoldCliError("usage", `Only files and folders can be added: ${trimmed}.`);
    }
    if (pathContainsPath(space.spaceRoot, source)) {
      throw new WorkFoldCliError("usage", `Source is already inside this Space: ${trimmed}. Move it in Files instead.`);
    }
    if (pathContainsPath(source, space.spaceRoot)) {
      throw new WorkFoldCliError("usage", `Source contains this Space and cannot be copied into it: ${trimmed}.`);
    }
    sources.push(source);
  }
  const copied: string[] = [];
  try {
    for (const source of sources) copied.push(await copyPathIntoSpace(source, space.spaceRoot, toDir));
  } catch (error) {
    // A mid-batch failure must not strand earlier copies without a restore
    // point: undo them best-effort, then surface the failure.
    await Promise.all(copied.map((path) =>
      rm(resolveSpacePath(space.spaceRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw error;
  }
  const safety = await checkpointAdditiveWritesOrUndo(space.spaceRoot, copied, {
    reason: "pre_add",
    label: `Before adding ${copied.length} item${copied.length === 1 ? "" : "s"}`,
  });
  return { copied, checkpointId: safety?.checkpointId ?? null };
}

const maxActLibraryUploadFiles = 500;

/**
 * Reads `library add` sources into the exact upload shape the desktop's
 * Library upload route feeds `uploadResourceFiles`: files carry their bytes,
 * folder sources walk file-by-file with the folder's name preserved as the
 * relative-path prefix (the desktop's folder-upload behavior). Symbolic links
 * are refused anywhere, nothing is skipped silently, and the total read is
 * bounded by the same budget the desktop upload body enforces.
 */
async function collectLibraryUploadFiles(
  fromPaths: string[],
  cwd: string,
  maxTotalBytes: number,
): Promise<Array<{ fileName: string; relativePath?: string; data: Buffer }>> {
  if (!fromPaths.length) throw new WorkFoldCliError("usage", "Provide at least one --from <path> to add.");
  if (fromPaths.length > maxActAddSources) {
    throw new WorkFoldCliError("usage", `At most ${maxActAddSources} sources can be added at once.`);
  }
  const files: Array<{ fileName: string; relativePath?: string; data: Buffer }> = [];
  let totalBytes = 0;
  const readBounded = async (path: string, label: string): Promise<Buffer> => {
    const data = await readFile(path);
    totalBytes += data.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new WorkFoldCliError("usage", `The sources exceed the ${maxTotalBytes}-byte Library upload budget at ${label}.`);
    }
    return data;
  };
  const visitFolder = async (root: string, relativePrefix: string): Promise<void> => {
    for (const name of (await readdir(root)).sort()) {
      const path = join(root, name);
      const relativePath = `${relativePrefix}/${name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new WorkFoldCliError("usage", `Symbolic-link sources cannot be added to the Library: ${relativePath}.`);
      }
      if (info.isDirectory()) {
        await visitFolder(path, relativePath);
        continue;
      }
      if (!info.isFile()) {
        throw new WorkFoldCliError("usage", `Only files and folders can be added to the Library: ${relativePath}.`);
      }
      if (files.length >= maxActLibraryUploadFiles) {
        throw new WorkFoldCliError("usage", `At most ${maxActLibraryUploadFiles} files can be added to the Library at once.`);
      }
      files.push({ fileName: name, relativePath, data: await readBounded(path, relativePath) });
    }
  };
  for (const raw of fromPaths) {
    const trimmed = raw.trim();
    if (!trimmed) throw new WorkFoldCliError("usage", "Source paths cannot be empty.");
    const source = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    const info = await lstat(source).catch(() => null);
    if (!info) throw new WorkFoldCliError("notFound", `Source not found: ${trimmed}.`);
    if (info.isSymbolicLink()) {
      throw new WorkFoldCliError("usage", `Symbolic-link sources cannot be added to the Library: ${trimmed}.`);
    }
    if (info.isDirectory()) {
      await visitFolder(source, basename(source));
      continue;
    }
    if (!info.isFile()) {
      throw new WorkFoldCliError("usage", `Only files and folders can be added to the Library: ${trimmed}.`);
    }
    if (files.length >= maxActLibraryUploadFiles) {
      throw new WorkFoldCliError("usage", `At most ${maxActLibraryUploadFiles} files can be added to the Library at once.`);
    }
    files.push({ fileName: basename(source), data: await readBounded(source, trimmed) });
  }
  if (!files.length) {
    throw new WorkFoldCliError("usage", "The sources contain no files to add to the Library.");
  }
  return files;
}

const maxActDeleteRefusalPaths = 5;

const actDeleteSkipReasonLabels: Record<CheckpointSkippedFile["reason"], string> = {
  too_large: "oversized",
  unreadable: "unreadable",
  symbolic_link: "symbolic link",
  excluded: "excluded from History",
};

/**
 * The act lane's deliberate strengthening over the desktop delete route
 * (docs/fold-act-ledger.md, conflict rule 10): the route takes its safety
 * restore point and proceeds even when the capture skipped a file it could
 * not cover, which for the act lane would mean irreversible loss with no
 * click. A delete the restore point cannot cover is a destroy, so it is
 * refused here — naming the uncoverable paths — into the staged
 * `files destroy` consecration.
 */
function assertDeleteRestoreCoverage(safety: SpaceCheckpoint): void {
  if (!safety.skippedFiles.length) return;
  const named = safety.skippedFiles
    .slice(0, maxActDeleteRefusalPaths)
    .map((file) => `${file.path} (${actDeleteSkipReasonLabels[file.reason]})`);
  const more = safety.skippedFiles.length - named.length;
  const count = safety.skippedFiles.length;
  throw new WorkFoldCliError(
    "conflict",
    `This delete is refused because its restore point could not cover ${count} matched file${count === 1 ? "" : "s"}: `
    + `${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}. `
    + "Deleting content History cannot restore is irreversible — 'files destroy' stages that decision for a person to approve.",
  );
}

/**
 * Splits one Space-relative act path into the desktop create routes' parent
 * and name inputs, so `files mkdir`/`files create` run the exact same
 * `createSpaceFolder`/`createSpaceTextFile` internals as the renderer.
 */
function splitActEntryPath(rawPath: string, missingMessage: string): { target: string; parentPath: string; name: string } {
  const target = normalizeSpaceRelativePath(rawPath);
  if (!target) throw new WorkFoldCliError("usage", missingMessage);
  const lastSlash = target.lastIndexOf("/");
  return {
    target,
    parentPath: lastSlash === -1 ? "" : target.slice(0, lastSlash),
    name: lastSlash === -1 ? target : target.slice(lastSlash + 1),
  };
}

const maxActLibraryItems = 500;

/** Bounded depth-first flattening of the Library tree; true when the bound cut it short. */
function flattenLibraryTree(entries: TreeEntry[], items: WorkFoldActLibraryItem[]): boolean {
  for (const entry of entries) {
    if (items.length >= maxActLibraryItems) return true;
    items.push({
      path: entry.path,
      kind: entry.kind,
      ...(entry.kind === "file" ? { sizeBytes: entry.sizeBytes ?? 0 } : {}),
    });
    if (entry.children?.length && flattenLibraryTree(entry.children, items)) return true;
  }
  return false;
}

/** Banner-image data URLs dominate a proposal's size; anything past this bound is not a typed proposal. */
const maxActAppearanceProposalBytes = 1_048_576;
/** A typed presentation file is a small JSON object; larger inputs are refused unread. */
const maxActPresentationFileBytes = 65_536;

/**
 * Reads and validates one typed `space-appearance` proposal file, resolved
 * host-side against the caller's working directory — the same file-borne
 * input pattern as `checks enable --proposal`. Nothing but the typed proposal
 * is accepted: no free-form argv colors, no other JSON shapes.
 */
async function readSpaceAppearanceProposalFile(rawPath: string, cwd: string): Promise<SpaceAppearanceProposal> {
  const parsed = await readBoundedActJsonFile(rawPath, cwd, maxActAppearanceProposalBytes, "appearance proposal");
  try {
    return parseSpaceAppearanceProposal(parsed);
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
}

/**
 * Reads one typed App Studio presentation file and applies exactly the
 * desktop pane's shape validation; the service's own value bounds still run
 * inside `declareLocalAppProject`.
 */
async function readAppPresentationFile(rawPath: string, cwd: string): Promise<AppReleasePresentation> {
  const parsed = await readBoundedActJsonFile(rawPath, cwd, maxActPresentationFileBytes, "App presentation");
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as { title?: unknown; description?: unknown; icon?: unknown }
    : {};
  if (typeof body.title !== "string"
    || (body.description !== undefined && body.description !== null && typeof body.description !== "string")
    || (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string")) {
    throw new WorkFoldCliError("usage", "An App title plus optional text description and icon id are required.");
  }
  return {
    title: body.title,
    description: body.description === undefined ? null : body.description,
    icon: body.icon === undefined ? null : body.icon,
  };
}

async function readBoundedActJsonFile(
  rawPath: string,
  cwd: string,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new WorkFoldCliError("usage", `A ${label} file path is required.`);
  const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new WorkFoldCliError("notFound", `The ${label} file was not found: ${trimmed}.`);
  if (info.size > maximumBytes) {
    throw new WorkFoldCliError("usage", `The ${label} file is larger than ${maximumBytes} bytes and cannot be a typed work-fold file.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new WorkFoldCliError("usage", `The ${label} file is not valid JSON.`, { cause: error });
  }
}

/**
 * Short content digest used as a receipt-safe reference: receipts and act
 * output carry identifiers and digests, never customization or presentation
 * payloads. Store-normalized values serialize deterministically, so equal
 * content yields equal refs.
 */
function shortContentRef(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function appearanceCustomizationRef(customization: SpaceAppearanceCustomization | null): string | null {
  return customization === null ? null : shortContentRef(customization);
}

function appearanceCustomizationsEqual(
  left: SpaceAppearanceCustomization | null,
  right: SpaceAppearanceCustomization | null,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function toActAppPresentation(presentation: AppReleasePresentation): WorkFoldActAppPresentation {
  return { title: presentation.title, description: presentation.description, icon: presentation.icon };
}

function toActAppReleaseRef(release: LocalAppRelease): WorkFoldActAppReleaseRef {
  return {
    releaseDigest: release.releaseDigest,
    displayVersion: release.displayVersion,
    state: release.state,
    preparedAt: release.preparedAt,
    publishedAt: release.publishedAt,
    featureCount: release.featureIds.length,
  };
}

function toActAppOperationRef(operation: LocalAppOperation): WorkFoldActAppOperationRef {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    releaseDigest: operation.releaseDigest,
    runtimeInstanceId: operation.runtimeInstanceId,
    targetSpaceId: operation.targetSpaceId,
    preparedAt: operation.preparedAt,
    ...(operation.kind === "update"
      ? { fromReleaseDigest: operation.plan.fromReleaseDigest, continuityPolicy: operation.continuityPolicy }
      : {}),
  };
}

function toActAppInstanceRef(instance: LocalAppInstance): WorkFoldActAppInstanceRef {
  return {
    runtimeInstanceId: instance.runtimeInstanceId,
    spaceId: instance.spaceId,
    releaseDigest: instance.releaseDigest,
    displayVersion: instance.displayVersion,
  };
}

function toActAppProposalRef(proposal: RestrictedAppProposalReceipt): WorkFoldActAppProposalRef {
  return {
    id: proposal.id,
    status: proposal.status,
    sourcePath: proposal.sourcePath,
    title: proposal.review.manifest.title,
    packageName: proposal.review.packageName,
    version: proposal.review.version,
    digest: proposal.review.digest,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

function toActAppAutomationRunRef(run: RestrictedAppAutomationRunReceipt): WorkFoldActAppAutomationRunRef {
  return {
    runId: run.runId,
    outcome: run.outcome,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function toActRoutingTriggerRef(trigger: WorkFoldRoutingDeclaration["trigger"]): {
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
} {
  if (trigger.kind === "interval") return { kind: "interval", intervalMinutes: trigger.intervalMinutes };
  if (trigger.kind === "on-settled") {
    const source = trigger.source;
    if (source.kind === "check-run") {
      return {
        kind: "on-settled",
        source: {
          kind: "check-run",
          spaceId: source.space,
          ...(source.check ? { checkId: source.check } : {}),
          outcomes: [...source.outcomes],
        },
      };
    }
    return {
      kind: "on-settled",
      source: {
        kind: "app-automation-run",
        spaceId: source.space,
        appId: source.appId,
        automationId: source.automationId,
        outcomes: [...source.outcomes],
      },
    };
  }
  return { kind: "manual" };
}

function toActRoutingSummary(projection: {
  declaration: WorkFoldRoutingDeclaration;
  digest: string;
  health: "enabled" | "disabled" | "suspended";
  grants: Array<{ approvedAt: string }>;
  lastScheduledAt?: string;
  disabledAt?: string;
  suspension?: { at: string; missingSpaceIds: string[]; reRegisteredSpaceIds: string[] };
  nextScheduledAt?: string;
}) {
  return {
    routingId: projection.declaration.id,
    title: projection.declaration.title,
    health: projection.health,
    digest: projection.digest,
    trigger: toActRoutingTriggerRef(projection.declaration.trigger),
    stepCount: projection.declaration.steps.length,
    referencedSpaceIds: workFoldRoutingReferencedSpaceIds(projection.declaration),
    ...(projection.health === "enabled" && projection.grants.length > 0
      ? { enabledAt: projection.grants[projection.grants.length - 1]!.approvedAt }
      : {}),
    ...(projection.disabledAt ? { disabledAt: projection.disabledAt } : {}),
    ...(projection.suspension
      ? {
        suspension: {
          at: projection.suspension.at,
          missingSpaceIds: [...projection.suspension.missingSpaceIds],
          reRegisteredSpaceIds: [...projection.suspension.reRegisteredSpaceIds],
        },
      }
      : {}),
    ...(projection.lastScheduledAt ? { lastScheduledAt: projection.lastScheduledAt } : {}),
    ...(projection.nextScheduledAt ? { nextScheduledAt: projection.nextScheduledAt } : {}),
  };
}

function toActRoutingFilesSource(
  source: Extract<WorkFoldRoutingDeclaration["steps"][number], { kind: "files" }>["from"],
): { kind: "paths"; paths: string[] }
  | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
  | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number } {
  if (source.kind === "paths") return { kind: "paths", paths: [...source.paths] };
  if (source.kind === "tree") return { kind: "tree", path: source.path, recursive: source.recursive, extensions: [...source.extensions] };
  return {
    kind: "step-created-files",
    step: source.step,
    ...(source.extensions ? { extensions: [...source.extensions] } : {}),
    maxFiles: source.maxFiles,
    maxTotalBytes: source.maxTotalBytes,
  };
}

function toActPublicationRef(view: WorkFoldPublicationView, spaceName?: string) {
  return {
    publicationId: view.publicationId,
    kind: view.kind,
    spaceId: view.spaceId,
    ...(spaceName ? { spaceName } : {}),
    ...(view.relativePath !== undefined ? { relativePath: view.relativePath } : {}),
    ...(view.app
      ? {
        appInstanceId: view.app.appInstanceId,
        releaseDigest: view.app.releaseDigest,
        viewerEntry: view.app.viewerEntry,
        viewerSurface: [...view.app.viewerSurface],
      }
      : {}),
    title: view.title,
    state: view.state,
    live: view.live,
    serveRatePerMinute: view.serveRatePerMinute,
    byteBudgetPerDay: view.byteBudgetPerDay,
    snapshotEnabled: view.snapshotEnabled,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.revokedAt ? { revokedAt: view.revokedAt } : {}),
    ...(view.expiresAt ? { expiresAt: view.expiresAt } : {}),
    bridgeSlot: view.bridgeSlot,
    ...(view.bridgeCleanup ? { bridgeCleanup: view.bridgeCleanup } : {}),
    viewerPath: view.viewerPath,
  };
}

async function runActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkFoldCliError) throw error;
    // Exactly the HTTP boundary's status translation (sendError), so a
    // restricted-app or route error means the same thing on both surfaces.
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : restrictedAppErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error ?? "Space act command failed.");
    if (statusCode === 400) throw new WorkFoldCliError("usage", message, { cause: error });
    if (statusCode === 403) throw new WorkFoldCliError("permissionDenied", message, { cause: error });
    if (statusCode === 404) throw new WorkFoldCliError("notFound", message, { cause: error });
    if (statusCode === 409) throw new WorkFoldCliError("conflict", message, { cause: error });
    throw new WorkFoldCliError("failure", message, { cause: error });
  }
}

function turnStatusFor(state: LocalApiState, spaceId: string, taskId: string): WorkFoldActTurnStatus {
  const active = state.activeTurnTasks.get(taskId);
  if (active && active.spaceId === spaceId) {
    return { taskId, state: "running", conversationId: active.conversationId, messageId: null, error: null, endedAt: null };
  }
  const settled = state.settledTurns.get(taskId);
  if (settled && settled.spaceId === spaceId) {
    return {
      taskId,
      state: settled.status,
      conversationId: settled.conversationId,
      messageId: settled.messageId ?? null,
      error: settled.error ?? null,
      endedAt: settled.endedAt,
    };
  }
  return { taskId, state: "unknown", conversationId: null, messageId: null, error: null, endedAt: null };
}

function conversationRuntimeState(state: LocalApiState, spaceId: string, conversationId: string): WorkFoldActChatState {
  const key = clientKey(spaceId, conversationId);
  if (state.runningTurns.has(key)) return "running";
  if (state.compactingConversations.has(key)) return "compacting";
  return "idle";
}

function toActSpaceRef(space: SpaceSummary): WorkFoldActSpaceRef {
  return { id: space.id, name: space.name, spaceRoot: space.spaceRoot };
}

function toActConversationRef(conversation: ConversationSummary): WorkFoldActConversationRef {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

function toActChatLifecycleState(conversation: ConversationSummary): WorkFoldActChatLifecycleState {
  return {
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

/** Manifest-summary projection: counts and identifiers, never per-file listings. */
function toActCheckpointSummary(checkpoint: SpaceCheckpoint): WorkFoldActCheckpointSummary {
  return {
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.label ? { label: checkpoint.label } : {}),
    reason: checkpoint.reason,
    scope: checkpoint.scope,
    fileCount: checkpoint.fileCount,
    totalBytes: checkpoint.totalBytes,
    skippedFileCount: checkpoint.skippedFiles.length,
  };
}

function toActFileVersionRef(version: SpaceFileVersion): WorkFoldActFileVersionRef {
  return {
    path: version.path,
    hashSha256: version.hashSha256,
    sizeBytes: version.sizeBytes,
    modifiedAt: version.modifiedAt,
    capturedAt: version.capturedAt,
    checkpointId: version.checkpointId,
    ...(version.checkpointLabel ? { checkpointLabel: version.checkpointLabel } : {}),
  };
}

function toActChatMessage(message: ChatMessage): WorkFoldActChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    createdAt: message.createdAt,
    ...(message.interruption ? { interrupted: true } : {}),
  };
}

function pathContainsPath(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function runAgentTurn(
  state: LocalApiState,
  spaceId: string,
  spaceRoot: string,
  conversationId: string,
  content: string,
  contextPaths: string[],
  selectedPath: string | null,
  taskId: string,
  managementAttachments?: ManagementAttachmentRef[],
): Promise<void> {
  const key = clientKey(spaceId, conversationId);
  let client: PiConversationClient | null = null;
  let promptStarted = false;
  let settledStatus: SettledTurnRecord["status"] = "succeeded";
  let settledMessageId: string | undefined;
  let settledError: string | undefined;
  changeTurnCount(state, 1);
  try {
    client = await getClient(state, spaceId, spaceRoot, conversationId);
    const contextAttachments = managementAttachments
      ? await loadManagementAttachmentsForTurn(managementAttachments)
      : await loadConversationContextAttachmentsForTurn(spaceRoot, contextPaths);
    const attachedLinks = managementAttachments ? managementAttachmentLinks(managementAttachments) : [];
    const managementSpaces = spaceId === workFoldManagementScopeId
      ? (await state.kernel.getSpaces({ kind: "renderer" })).spaces.map((space) => ({
          id: space.id,
          name: space.name,
          spaceRoot: space.spaceRoot,
        }))
      : undefined;
    await captureTurnCheckpointSafe(state, spaceId, spaceRoot, conversationId, "pre_turn");
    await state.beforeAgentPrompt?.({ spaceId, conversationId, taskId });
    throwIfTurnCancelled(state, taskId);
    promptStarted = true;
    const finalText = await client.prompt(content, {
      contextAttachments,
      selectedPath,
      ...(spaceId === workFoldManagementScopeId ? { managementTaskId: taskId } : {}),
      ...(managementSpaces ? { managementSpaces } : {}),
      ...(attachedLinks.length ? { attachedLinks } : {}),
    });
    promptStarted = false;
    await captureTurnCheckpointSafe(state, spaceId, spaceRoot, conversationId, "post_turn");
    try {
      const firstUserMessage = (await readConversation(spaceRoot, conversationId))
        .find((message) => message.role === "user")
        ?.content;
      const generatedTitle = conversationTitleFromFirstUserMessage(firstUserMessage);
      if (generatedTitle) {
        const conversation = await setGeneratedConversationTitle(spaceRoot, conversationId, generatedTitle);
        client.setSessionName(conversation.title);
      }
    } catch (error) {
      // A derived title must never turn an otherwise persisted successful
      // Assistant response into a failed turn.
      console.warn(`Could not persist a generated Chat title: ${errorMessage(error)}`);
    }
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: finalText,
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
    };
    await appendMessage(spaceRoot, conversationId, assistantMessage);
    settledMessageId = assistantMessage.id;
  } catch (error) {
    const cancelled = isPiTurnCancelledError(error);
    if (promptStarted) {
      promptStarted = false;
      await captureTurnCheckpointSafe(state, spaceId, spaceRoot, conversationId, "post_turn");
    }
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    let failureResultPreserved = false;
    if (!cancelled) {
      console.warn(`Assistant turn failed in ${spaceId}/${conversationId}: ${errorMessage(error)}`);
    }
    const publicDetail = cancelled
      ? "The Assistant was stopped before it completed this response."
      : assistantFailurePublicDetail(error);
    const interruptedMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: assistantFailureTranscriptContent(error, durable?.assistantText ?? "", cancelled),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      interruption: {
        reason: cancelled ? "cancelled" as const : assistantFailureReason(error),
        message: publicDetail,
        retryAttempts: error instanceof PiTurnFailure ? error.retryAttempts : 0,
        provider: error instanceof PiTurnFailure ? error.provider : null,
        model: error instanceof PiTurnFailure ? error.model : null,
        activities: error instanceof PiTurnFailure ? error.activities : [],
      },
    };
    try {
      await appendMessage(spaceRoot, conversationId, interruptedMessage);
      failureResultPreserved = true;
      settledMessageId = interruptedMessage.id;
    } catch (preservationError) {
      console.error(`Could not preserve an interrupted Assistant result: ${errorMessage(preservationError)}`);
    }
    const message = assistantTurnFailureMessage(error, failureResultPreserved);
    settledStatus = cancelled ? "aborted" : "failed";
    settledError = message;
    // A provider failure settles the Pi session cleanly after its bounded retry
    // path. Keep that live session so the next user message can continue from
    // completed tool results. Unexpected runtime failures still rebuild the
    // client from the durable Pi session on the next turn.
    if (!(error instanceof PiTurnFailure)) {
      await client?.stop().catch(() => undefined);
      state.clients.delete(key);
    }
  } finally {
    if (promptStarted) await captureTurnCheckpointSafe(state, spaceId, spaceRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durableText = state.turnStore.get(taskId)?.assistantText ?? "";
    await state.turnStore.settle(taskId, {
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      assistantText: durableText,
    }).catch((error) => {
      console.error(`Could not persist Assistant turn settlement: ${errorMessage(error)}`);
      return null;
    });
    state.runningTurns.delete(key);
    state.cancelledTurnTasks.delete(taskId);
    state.activeTurnIdsByKey.delete(key);
    state.kernel.finishTask(taskId);
    if (spaceId === workFoldManagementScopeId) state.managementRequests.finish(taskId, settledStatus);
    settleTurnTask(state, taskId, {
      spaceId,
      conversationId,
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
    });
    broadcast(state, key, settledStatus === "succeeded"
      ? { type: "done", conversationId }
      : { type: "error", conversationId, message: settledError ?? "The Assistant turn did not finish." });
    broadcast(state, key, turnStateEvent(conversationId, false));
    changeTurnCount(state, -1);
  }
}

const maxSettledTurnRecords = 500;

async function recoverDurableTurnState(state: LocalApiState): Promise<void> {
  const records = state.turnStore.list().sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  for (const record of records.filter((candidate) => candidate.status !== "accepted" && candidate.status !== "running").slice(-maxSettledTurnRecords)) {
    rememberDurableSettledTurn(state, record);
  }
  for (const record of records.filter((candidate) => candidate.status === "accepted" || candidate.status === "running")) {
    const rootPath = record.spaceId === workFoldManagementScopeId
      ? workFoldManagementRoot()
      : await getSpace(record.spaceId).then((space) => space.spaceRoot).catch(() => null);
    if (!rootPath) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "The app closed before this Assistant turn finished, and its Space is no longer registered.",
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const messages = await readConversation(rootPath, record.conversationId).catch(() => []);
    const existingResponse = messages.find((message) => message.role === "assistant" && message.turnId === record.turnId);
    if (existingResponse) {
      const status = existingResponse.interruption?.reason === "cancelled"
        ? "aborted" as const
        : existingResponse.interruption ? "failed" as const : "succeeded" as const;
      const settled = await state.turnStore.settle(record.turnId, {
        status,
        messageId: existingResponse.id,
        ...(existingResponse.interruption ? { error: existingResponse.interruption.message } : {}),
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const userMessage = messages.find((message) => message.role === "user" && message.id === record.userMessageId);
    if (!userMessage) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "Turn acceptance was interrupted before the user message was saved.",
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const detail = "work-fold closed before this Assistant turn finished. It was not run again because completed tools may already have changed something.";
    const recoveredMessage: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: record.assistantText.trim() || detail,
      createdAt: new Date().toISOString(),
      turnId: record.turnId,
      requestId: record.requestId,
      interruption: {
        reason: "app_interrupted",
        message: detail,
        retryAttempts: 0,
        provider: null,
        model: null,
        activities: [],
      },
    };
    let messageId: string | undefined;
    try {
      await appendMessage(rootPath, record.conversationId, recoveredMessage);
      messageId = recoveredMessage.id;
    } catch (error) {
      console.error(`Could not append an interrupted Assistant result during startup recovery: ${errorMessage(error)}`);
    }
    const settled = await state.turnStore.settle(record.turnId, {
      status: "interrupted",
      ...(messageId ? { messageId } : {}),
      error: detail,
    });
    if (settled) rememberDurableSettledTurn(state, settled);
  }
}

function rememberDurableSettledTurn(state: LocalApiState, record: WorkFoldDurableTurnRecord): void {
  const status: SettledTurnRecord["status"] = record.status === "succeeded"
    ? "succeeded"
    : record.status === "aborted" ? "aborted" : "failed";
  state.settledTurns.set(record.turnId, {
    taskId: record.turnId,
    spaceId: record.spaceId,
    conversationId: record.conversationId,
    status,
    endedAt: record.updatedAt,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.error ? { error: record.error } : {}),
  });
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function settleTurnTask(
  state: LocalApiState,
  taskId: string,
  record: Omit<SettledTurnRecord, "taskId" | "endedAt">,
): void {
  state.activeTurnTasks.delete(taskId);
  state.cancelledTurnTasks.delete(taskId);
  state.settledTurns.set(taskId, { taskId, endedAt: new Date().toISOString(), ...record });
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function throwIfTurnCancelled(state: LocalApiState, taskId: string): void {
  if (!state.cancelledTurnTasks.has(taskId)) return;
  const error = new Error("Agent turn cancelled by the user.");
  error.name = "PiTurnCancelledError";
  throw error;
}

function assistantTurnFailureMessage(error: unknown, partialResponsePreserved: boolean): string {
  if (isPiTurnCancelledError(error)) return "Assistant turn cancelled.";
  if (!(error instanceof PiTurnFailure)) return assistantFailurePublicDetail(error);
  const retrySummary = error.retryAttempts > 0
    ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
    : "";
  return partialResponsePreserved
    ? `The model stopped responding${retrySummary}. work-fold saved the partial response and completed activity below.`
    : `The model stopped responding${retrySummary}, and work-fold could not save the partial response.`;
}

function assistantFailureReason(error: unknown): "provider_error" | "setup_error" | "assistant_error" {
  if (error instanceof PiTurnFailure) return "provider_error";
  return isAssistantSetupError(error) ? "setup_error" : "assistant_error";
}

function assistantFailureTranscriptContent(error: unknown, checkpointText = "", cancelled = false): string {
  const checkpoint = checkpointText.trim();
  if (error instanceof PiTurnFailure) {
    return error.partialText || checkpoint || "The model stopped responding before it could finish a response.";
  }
  if (checkpoint) return checkpoint;
  if (cancelled) return "The Assistant was stopped before it completed a response.";
  return assistantFailurePublicDetail(error);
}

function assistantFailurePublicDetail(error: unknown): string {
  if (error instanceof PiTurnFailure) {
    const retrySummary = error.retryAttempts > 0
      ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
      : "";
    return `The model stopped responding${retrySummary}.`;
  }
  if (isAssistantSetupError(error)) {
    return "The Assistant isn’t set up yet. Open Settings → Assistant to choose a provider and model, then try again.";
  }
  if (isPiTurnTimeoutError(error)) {
    return `${errorMessage(error)} Raise or clear that limit to let long turns finish.`;
  }
  if (/timed?\s*out|timeout/i.test(errorMessage(error))) {
    return "The Assistant took too long to respond. Try again when you’re ready.";
  }
  return "The Assistant couldn’t complete this request. Try again. If it keeps happening, check Settings → Assistant.";
}

function isAssistantSetupError(error: unknown): boolean {
  return /api[- ]?key|credential|auth(?:entication|orization)?|no (?:available |configured )?models?|model (?:was )?not (?:found|available|configured)|select (?:a )?model|choose (?:a )?(?:provider|model)|provider .{0,40}(?:not configured|unavailable)/i
    .test(errorMessage(error));
}

async function getClient(
  state: LocalApiState,
  spaceId: string,
  spaceRoot: string,
  conversationId: string,
): Promise<PiConversationClient> {
  if (spaceId === workFoldManagementScopeId) assertManagementInstructionsReady(state);
  const key = clientKey(spaceId, conversationId);
  rememberSpaceRoot(state, spaceId, spaceRoot);
  const existing = state.clients.get(key);
  if (existing) return existing;
  // The management scope loads personal Pi capabilities and its two app-owned
  // project instructions. It belongs to no Space, so Space-bound restricted-
  // app proposal and invocation bridges stay disconnected.
  const hostCapabilities = spaceId === workFoldManagementScopeId
    ? undefined
    : {
        spaceId,
        restrictedAppProposals: state.restrictedAppProposals,
        restrictedApps: state.restrictedApps,
      };
  const client = new PiConversationClient(conversationId, spaceRoot, state.runtimeProvider, hostCapabilities);
  client.on("event", (event: PiChatEvent) => {
    broadcast(state, streamKey(spaceId, conversationId), assistantEventForRenderer(event));
  });
  state.clients.set(key, client);
  return client;
}

function assistantEventForRenderer(event: PiChatEvent): Omit<PiChatEvent, "raw"> {
  const { raw: _raw, ...safeEvent } = event;
  if (!safeEvent.message) return safeEvent;
  if (safeEvent.type === "error") {
    return { ...safeEvent, message: assistantFailurePublicDetail(new Error(safeEvent.message)) };
  }
  if (safeEvent.type === "status" && isAssistantSetupError(safeEvent.message)) {
    return { ...safeEvent, message: "Assistant setup is needed. Open Settings → Assistant." };
  }
  return safeEvent;
}

async function invalidateWorkFoldClients(state: LocalApiState, spaceId: string): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${spaceId}:`)) continue;
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
}

async function invalidateAllClients(state: LocalApiState): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
}

type CapabilityScope = "global" | "project";
const globalCapabilityMutationKey = "*";

function capabilityRegistryType(value: string | null): "all" | CapabilityType | undefined {
  if (!value) return undefined;
  if (value === "all" || value === "skill" || value === "extension") return value;
  throw badRequest("Capability type must be all, skill, or extension.");
}

function capabilityRegistrySort(value: string | null): CapabilitySort | undefined {
  if (!value) return undefined;
  if (value === "official" || value === "downloads" || value === "recent" || value === "name") return value;
  throw badRequest("Capability sort must be official, downloads, recent, or name.");
}

function optionalBoundedInteger(value: string | null, label: "offset" | "limit"): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  const minimum = label === "limit" ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < minimum) throw badRequest(`Capability ${label} is invalid.`);
  return parsed;
}

function capabilityScope(value: unknown): CapabilityScope {
  if (value === undefined || value === null || value === "global") return "global";
  if (value === "project") return "project";
  throw badRequest("Capability scope must be global or project.");
}

async function runCapabilityMutation<T>(
  state: LocalApiState,
  space: { id: string; spaceRoot: string },
  scope: CapabilityScope,
  operation: () => Promise<T>,
  options: { requireProjectTrust?: boolean } = {},
): Promise<T> {
  const key = scope === "global" ? globalCapabilityMutationKey : space.id;
  reserveCapabilityMutation(state, space.id, scope, key);
  try {
    if (
      scope === "project"
      && options.requireProjectTrust !== false
      && !await isPiProjectMutationTrusted(space.spaceRoot, state.runtimeProvider)
    ) {
      throw forbidden("Trust this Space before changing Space-scoped capabilities.");
    }
    const result = await operation();
    if (scope === "global") await invalidateAllClients(state);
    else await invalidateWorkFoldClients(state, space.id);
    return result;
  } finally {
    state.capabilityMutations.delete(key);
  }
}

async function runRestrictedAppMutation<T>(
  state: LocalApiState,
  spaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCapabilityMutation(state, spaceId, "project", spaceId);
  try {
    await revalidateRestrictedAppSpace(state, spaceId);
    const result = await operation();
    await invalidateWorkFoldClients(state, spaceId);
    return result;
  } finally {
    state.capabilityMutations.delete(spaceId);
  }
}

async function recoverPendingSpaceRemovals(
  restrictedApps: RestrictedAppService,
  restrictedAppProposals: RoutedRestrictedAppProposalHost,
  io: Partial<SpaceRemovalIo>,
): Promise<{ spaceRoots: string[]; spaceIds: string[] }> {
  const pendingRemovals = await listPendingSpaceRemovals();
  for (const pending of pendingRemovals) {
    try {
      let intent = pending;
      if (intent.phase === "requested") {
        await restrictedApps.removeSpace(intent.spaceId);
        await restrictedAppProposals.removeSpace(intent.spaceId);
        intent = await markSpaceRemovalAppStateRemoved(intent.spaceId, io);
      }
      // The durable removal intent must remain until Check authority is gone.
      // This removal-only path never parses possibly damaged/future state.
      await purgeWorkFoldCheckState(intent.spaceId);
      await finalizeSpaceRemoval(intent.spaceId, io);
    } catch {
      // The durable intent keeps this Space hidden and untrusted. Recovery of
      // other Spaces and normal startup can proceed; a later startup retries it.
    }
  }
  return {
    spaceRoots: pendingRemovals.map((intent) => intent.spaceRoot),
    spaceIds: pendingRemovals.map((intent) => intent.spaceId),
  };
}

async function runRestrictedAppMutations<T>(
  state: LocalApiState,
  spaceIds: readonly string[],
  operation: () => Promise<T>,
  options: { requiredSpaceIds?: readonly string[] } = {},
): Promise<T> {
  const ids = [...new Set(spaceIds)].sort();
  if (ids.length === 0) throw badRequest("A Space is required for this App change.");
  const requiredSpaceIds = [...new Set(options.requiredSpaceIds ?? ids)].sort();
  if (requiredSpaceIds.length === 0 || requiredSpaceIds.some((spaceId) => !ids.includes(spaceId))) {
    throw new Error("Restricted App mutation validation must name one or more reserved Spaces.");
  }
  if (state.capabilityMutations.has(globalCapabilityMutationKey)
    || ids.some((spaceId) => state.capabilityMutations.has(spaceId))) {
    throw httpError(409, "Wait for the current capability change to finish.");
  }
  if (ids.some((spaceId) => hasActiveCapabilityWorkForSpace(state, spaceId))) {
    throw httpError(409, "Wait for affected work to finish before changing capabilities.");
  }
  for (const spaceId of ids) state.capabilityMutations.add(spaceId);
  try {
    for (const spaceId of requiredSpaceIds) {
      await revalidateRestrictedAppSpace(state, spaceId);
    }
    const result = await operation();
    await Promise.all(ids.map((spaceId) => invalidateWorkFoldClients(state, spaceId)));
    return result;
  } finally {
    for (const spaceId of ids) state.capabilityMutations.delete(spaceId);
  }
}

async function revalidateRestrictedAppSpace(state: LocalApiState, spaceId: string): Promise<void> {
  await state.beforeRestrictedAppSpaceRevalidation?.(spaceId);
  await getSpace(spaceId);
}

function reserveCapabilityMutation(
  state: LocalApiState,
  spaceId: string,
  scope: CapabilityScope,
  key: string,
): void {
  const mutationConflict = scope === "global"
    ? state.capabilityMutations.size > 0
    : state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(spaceId);
  if (mutationConflict) throw httpError(409, "Wait for the current capability change to finish.");

  const runningConflict = scope === "global"
    ? state.runningTurns.size > 0 || state.compactingConversations.size > 0 || state.checkRunReservations.size > 0 || state.checks.hasActiveRun()
    : hasActiveCapabilityWorkForSpace(state, spaceId);
  if (runningConflict) {
    throw httpError(409, "Wait for affected Assistant work to finish before changing capabilities.");
  }
  state.capabilityMutations.add(key);
}

function assertNoCapabilityMutationForTurn(state: LocalApiState, spaceId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(spaceId)) {
    throw httpError(409, "Wait for the current capability change to finish before starting an Assistant turn.");
  }
}

function assertNoCapabilityMutationForCheck(state: LocalApiState, spaceId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(spaceId)) {
    throw new WorkFoldCliError("conflict", "Wait for the current capability change to finish before running or changing Checks.");
  }
}

function reserveCheckOperation(state: LocalApiState, spaceId: string): void {
  assertNoCapabilityMutationForCheck(state, spaceId);
  if (state.checkRunReservations.has(spaceId)) {
    throw new WorkFoldCliError("conflict", "Wait for the current Check operation to finish.");
  }
  state.checkRunReservations.add(spaceId);
}

async function runReservedCheckOperation<T>(
  state: LocalApiState,
  spaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCheckOperation(state, spaceId);
  try {
    return await operation();
  } finally {
    state.checkRunReservations.delete(spaceId);
  }
}

async function runCheckSpaceRegistryMutation<T>(state: LocalApiState, operation: () => Promise<T>): Promise<T> {
  const release = state.checks.tryReserveSpaceRegistryMutation();
  if (!release) throw httpError(409, "Wait for current Check work to finish before changing registered Spaces.");
  try {
    return await operation();
  } finally {
    release();
  }
}

function hasActiveCapabilityWorkForSpace(state: LocalApiState, spaceId: string): boolean {
  const prefix = `${spaceId}:`;
  return [...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix))
    || state.checkRunReservations.has(spaceId)
    || state.checks.hasActiveRun(spaceId);
}

// ---------------------------------------------------------------------------
// Fold wiring: the consecration decision path, the routing executor's hop
// ports, the publication key fallback, and the glance's live-registry source
// readers. All of it is constructed by startLocalApi over the same shared
// state (and the same fences) the HTTP routes and the act facade use.
// ---------------------------------------------------------------------------

/**
 * Development fallback only: keys live for this app run and pages served
 * under them stop decrypting after restart until the redrive lane mints a
 * fresh key. The desktop always injects the operating-system-encrypted
 * secure-settings store (`desktop/src/settings.ts`), where publication keys
 * durably belong as Remote access material.
 */
function createEphemeralPublicationKeyStore(): WorkFoldPublicationKeyStore {
  const keys = new Map<string, string>();
  return {
    async get(publicationId) {
      return keys.get(publicationId) ?? null;
    },
    async set(publicationId, keyBase64Url) {
      keys.set(publicationId, keyBase64Url);
    },
    async remove(publicationId) {
      keys.delete(publicationId);
    },
  };
}

/** The neutral app-owned root global capability mutations resolve against. */
function capabilityGlobalMutationScope(): { id: string; spaceRoot: string } {
  return { id: workFoldManagementScopeId, spaceRoot: workFoldManagementRoot() };
}

/**
 * The consecration execution fence over the exact reservation state the
 * desktop routes use: `probe` answers, without reserving, whether the scope
 * could be reserved right now (so an ineligible click consumes nothing), and
 * `run` reserves with runRestrictedAppMutation semantics for a Space scope
 * and runCapabilityMutation's global branch for the global scope. Project
 * trust checks stay with the per-kind adapters, mirroring the routes each
 * kind reuses.
 */
// ---------------------------------------------------------------------------
// Consecration staging (docs/fold-consecrations.md; verb rows in
// docs/fold-act-ledger.md). The facade composes each staged act's typed
// parameters and pins from live state, admits it through the staged-act
// store's journaled path, and returns the ledger's staged result shape. The
// helpers below are the shared plumbing: error translation into the CLI's
// typed vocabulary, provenance from the validated management lineage, the
// bounded projections `staged list|show` render, and the digest-addressed
// holding area a staged routing declaration waits in until its decision.
// ---------------------------------------------------------------------------

/**
 * Cards for the needs-you surfaces, host-composed from the typed staged-act
 * records with registered Space names resolved. One card contract for every
 * surface; nothing here reads model prose.
 */
async function composeDecisionCards(acts: FoldStagedAct[]): Promise<FoldDecisionCard[]> {
  const spaceNames = new Map((await listSpaces()).map((space) => [space.id, space.name]));
  return acts.map((act) => foldDecisionCard(act, { spaceNames }));
}

function compareIsoStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const maxDecisionFileGrantRootLength = 512;

/**
 * The person-chosen root accompanying an `app.grant.files` approval: "." for
 * the whole Space, otherwise a plain Space-relative path. Mirrors the file
 * broker's safe-relative-path rules (`src/local/agent/restricted-app-files.ts`)
 * so a root this route accepts is one the grant path will accept too — a typo
 * refuses here, before the approval is consumed, never as a failed execution.
 */
function decisionFileGrantRoot(value: unknown): string {
  if (typeof value !== "string") throw badRequest("The chosen folder must be a string path.");
  const root = value.trim();
  if (!root || root.length > maxDecisionFileGrantRootLength) {
    throw badRequest("Choose a folder inside the Space for this grant.");
  }
  if (root === ".") return root;
  if (isAbsolute(root) || root.startsWith("/") || root.includes("\\") || root.includes(":") || root.includes("\0")) {
    throw badRequest("The chosen folder must be a Space-relative path.");
  }
  if (root.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw badRequest("The chosen folder must be a plain Space-relative path.");
  }
  if (containsReservedSpacePathSegment(root)) {
    throw badRequest("work-fold metadata folders cannot be granted to an app.");
  }
  return root;
}

/**
 * Decision-path refusals for the renderer decision routes, with the typed
 * code and (when the refusal settled the record) the resulting state, so the
 * surfaces can say exactly what happened instead of guessing from prose.
 */
function sendFoldDecisionError(res: ServerResponse, error: unknown): void {
  if (error instanceof FoldDecisionError) {
    sendJson(res, {
      error: error.message,
      code: error.code,
      ...(error.state !== undefined ? { state: error.state } : {}),
    }, error.code === "SURFACE_FORBIDDEN" ? 403 : 409);
    return;
  }
  if (error instanceof FoldStagedActError) {
    const status = error.code === "INPUT_INVALID" || error.code === "KIND_UNKNOWN"
      ? 400
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "STORE_DAMAGED" || error.code === "JOURNAL_UNAVAILABLE"
          ? 500
          : 409;
    sendJson(res, {
      error: error.message,
      code: error.code,
      ...(error.state !== undefined ? { state: error.state } : {}),
    }, status);
    return;
  }
  sendError(res, error);
}

/** Standing-policy route refusals, with the store's typed code preserved. */
function sendFoldPublicationError(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkFoldPublicationError) {
    const status = error.code === "INPUT_INVALID" || error.code === "WIDEN_REFUSED" || error.code === "SOURCE_INVALID"
      ? 400
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "ALREADY_REVOKED" || error.code === "PUBLICATION_CAP"
          ? 409
          : error.code === "STORE_DAMAGED" || error.code === "JOURNAL_UNAVAILABLE"
            ? 503
            : 500;
    sendJson(res, { error: error.message, code: error.code }, status);
    return;
  }
  sendError(res, error);
}

function sendFoldPolicyError(res: ServerResponse, error: unknown): void {
  if (error instanceof FoldPolicyError) {
    const status = error.code === "INPUT_INVALID" || error.code === "KIND_INELIGIBLE" || error.code === "OPEN_REGISTRY"
      ? 400
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "SETTINGS_ONLY"
          ? 403
          : error.code === "POLICY_CAP"
            ? 409
            : 500;
    sendJson(res, { error: error.message, code: error.code }, status);
    return;
  }
  sendError(res, error);
}

/** Light route-shape pass; the store's matcher validation is the authority. */
function foldPolicyMatchInput(value: unknown): FoldPolicyMatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // The store refuses non-object matchers with its own precise message.
    return value as FoldPolicyMatch;
  }
  const match: Record<string, string> = {};
  for (const [name, field] of Object.entries(value as Record<string, unknown>)) {
    if (field === undefined || field === null) continue;
    if (typeof field === "string" && !field.trim()) continue;
    match[name] = field as string;
  }
  return match;
}

/**
 * The Settings section's authoring metadata: the policy-eligible kind set and
 * the typed matcher fields each kind accepts, rendered by
 * DesktopSettingsModal so the pickers offer eligible kinds only. The field
 * structure — names, required flags, value enums — derives from the store's
 * own exported matcher vocabulary (`FOLD_POLICY_MATCHER_DESCRIPTORS`), so the
 * pickers can never drift from what the store accepts at write; this module
 * adds only person-facing presentation, keyed exhaustively over
 * {@link FoldPolicyEligibleKind} — adding an eligible kind without presenting
 * it here is a compile error — while the store's own matcher validation stays
 * the one write-time authority. Categories use the working card copy from
 * docs/fold-consecrations.md; destroy has no entry because it has no policy
 * vocabulary.
 */
interface FoldPolicySettingsFieldDescriptor {
  name: string;
  label: string;
  required: boolean;
  values?: readonly string[];
  hint?: string;
}

interface FoldPolicySettingsKindDescriptor {
  kind: FoldPolicyEligibleKind;
  category: FoldPolicyCategory;
  categoryLabel: string;
  label: string;
  fields: FoldPolicySettingsFieldDescriptor[];
}

function foldPolicySettingsContract(): {
  cap: number;
  labelMaxChars: number;
  firstPartyRegistries: readonly string[];
  kinds: FoldPolicySettingsKindDescriptor[];
} {
  const fieldLabels: Record<string, string> = {
    reviewDigest: "Reviewed content digest",
    source: "Source",
    packageId: "Package id",
    version: "Exact version",
    scope: "Scope",
    spaceId: "Space id",
    contentDigest: "Content digest",
    appInstanceId: "App Instance id",
    declarationId: "Declaration id",
    target: "Connection target",
    adapterKind: "Adapter kind",
    automationId: "Automation id",
  };
  const packageSourceHint = "Pin a packageId, or name a first-party curated registry; open registries are refused.";
  const presentation: Record<FoldPolicyEligibleKind, {
    label: string;
    fieldLabels?: Record<string, string>;
    hints?: Record<string, string>;
  }> = {
    "app.review.approve": { label: "Approve an app review" },
    "capability.package.install": {
      label: "Install a package or Extension",
      fieldLabels: { source: "Package source" },
      hints: { source: packageSourceHint },
    },
    "capability.package.update": {
      label: "Update a package or Extension",
      fieldLabels: { source: "Package source" },
      hints: { source: packageSourceHint },
    },
    "capability.skills.import": {
      label: "Import a skill bundle",
      hints: { contentDigest: "Pin a contentDigest, or name a first-party curated registry source." },
    },
    "app.grant.network": { label: "Grant a network destination" },
    "app.grant.files": { label: "Grant Space file access" },
    "app.grant.notifications": { label: "Grant a notification category" },
    "app.connection.save": { label: "Save an app connection" },
    "app.automation.enable": { label: "Enable a named automation" },
  };
  return {
    cap: FOLD_POLICY_CAP,
    labelMaxChars: FOLD_POLICY_LABEL_MAX_CHARS,
    firstPartyRegistries: FOLD_POLICY_FIRST_PARTY_REGISTRIES,
    kinds: FOLD_POLICY_ELIGIBLE_KINDS.map((kind) => {
      const category = foldStagedActCategory(kind) as FoldPolicyCategory;
      return {
        kind,
        category,
        categoryLabel: category === "make-runnable"
          ? "Installs code that can run as you"
          : "Grants a standing power",
        label: presentation[kind].label,
        fields: Object.entries(FOLD_POLICY_MATCHER_DESCRIPTORS[kind].fields).map(([name, spec]) => {
          const hint = presentation[kind].hints?.[name];
          return {
            name,
            label: presentation[kind].fieldLabels?.[name] ?? fieldLabels[name] ?? name,
            required: spec.required,
            ...(spec.values !== undefined ? { values: spec.values } : {}),
            ...(hint !== undefined ? { hint } : {}),
          };
        }),
      };
    }),
  };
}

function mapFoldStagedActError(error: FoldStagedActError): WorkFoldCliError {
  switch (error.code) {
    case "INPUT_INVALID":
    case "KIND_UNKNOWN":
      return new WorkFoldCliError("usage", error.message, { cause: error });
    case "NOT_FOUND":
      return new WorkFoldCliError("notFound", error.message, { cause: error });
    case "PENDING_CAP":
    case "ALREADY_SETTLED":
    case "EXPIRED":
    case "EXECUTION_INVALID":
      return new WorkFoldCliError("conflict", error.message, { cause: error });
    default:
      // STORE_DAMAGED and JOURNAL_UNAVAILABLE: honest failures, never guessed.
      return new WorkFoldCliError("failure", error.message, { cause: error });
  }
}

async function runStagedActStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FoldStagedActError) throw mapFoldStagedActError(error);
    throw error;
  }
}

/**
 * The receipts writer the decision path journals through, extending the
 * composition the policies module documents: when the decision being
 * journaled is an exercised standing policy, both the accepted and terminal
 * receipt lines carry the policy's label snapshot at exercise time in their
 * host-composed detail, beside the `surface: "policy"` and `policyId` columns
 * receipts v2 already records. Every other decision passes through unchanged.
 */
function createPolicyLabelAwareDecisionReceipts(state: LocalApiState): FoldDecisionReceiptsWriter {
  return {
    async append(entry) {
      const label = entry.policyId !== undefined && typeof entry.decisionId === "string"
        ? state.policyLabelSnapshots.get(entry.decisionId)
        : undefined;
      if (label === undefined) return await state.actReceipts.append(entry);
      const suffix = `auto-approved by standing policy "${label}"`;
      return await state.actReceipts.append({
        ...entry,
        detail: entry.detail !== undefined ? `${entry.detail} — ${suffix}` : suffix,
      });
    },
    hasAccepted: (requestId) => state.actReceipts.hasAccepted(requestId),
  };
}

/**
 * Host-side standing-policy evaluation at staged-act admission
 * (docs/fold-consecrations.md §Standing policies): never in the model, never
 * over prose, and never for a deduplicated card. A match short-circuits into
 * the same decision path as a click — eligibility precheck, pin recheck,
 * journal-first consumption, execution, terminal receipt — so an exercised
 * policy's receipts contain everything a clicked decision's receipts contain,
 * with `surface: "policy"`, the policy id, and the label snapshot.
 *
 * Everything here fails closed to a click: a damaged or unattested policy
 * store, a non-matching act, or a decision-path refusal that consumed nothing
 * (a busy fence, an ineligible act) returns null and leaves the pending card
 * waiting for a person. Only a refusal that settled the record — a pin
 * mismatch or the interrupted-decision backstop, both practically unreachable
 * this close to admission — surfaces as a typed conflict, because reporting a
 * pending card for a settled act would be a lie.
 */
async function exerciseStandingPolicyAtAdmission(
  state: LocalApiState,
  act: FoldStagedAct,
): Promise<WorkFoldActStagedAutoApproval | null> {
  let evaluation: FoldPolicyEvaluation;
  try {
    evaluation = await state.foldPolicies.evaluate(act);
  } catch {
    // Evaluation never throws by contract; an unexpected failure still means
    // no auto-approval, which is the fail-closed direction.
    return null;
  }
  if (!evaluation.matched) return null;
  state.policyLabelSnapshots.set(act.id, evaluation.labelSnapshot);
  try {
    const result = await state.foldDecisions.decide(act.id, evaluation.decisionInput);
    return {
      policyId: evaluation.policy.id,
      policyLabel: evaluation.labelSnapshot,
      executionOutcome: result.act.execution?.outcome ?? "executed",
      ...(result.act.execution?.errorDetail !== undefined ? { detail: result.act.execution.errorDetail } : {}),
      receipted: result.receipted,
    };
  } catch (error) {
    const current = await state.stagedActs.get(act.id).catch(() => undefined);
    if (!current || current.state === "staged") return null;
    if (current.state === "approved" && current.decision?.policyId !== undefined) {
      // The decision committed but its outcome could not be reported cleanly
      // (for example the execution-record write failed); the approval stands
      // and the response must say so.
      return {
        policyId: current.decision.policyId,
        policyLabel: evaluation.labelSnapshot,
        executionOutcome: current.execution?.outcome ?? "interrupted",
        ...(current.execution?.errorDetail !== undefined ? { detail: current.execution.errorDetail } : {}),
        receipted: false,
      };
    }
    throw new WorkFoldCliError(
      "conflict",
      `A standing policy matched this act, but the decision could not complete and the staged act is now ${current.state}: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    state.policyLabelSnapshots.delete(act.id);
  }
}

/**
 * Provenance for one staged act. `requestId` is the staging act's journal id.
 * When the act carries explicit management lineage, the staged card records
 * the management conversation that holds the fold's reasoning — and, when
 * that request arrived through Remote access, the exact browser identity, so
 * the no-self-approval rule and browser-revocation cascades bind to real
 * data.
 */
function stagingProvenance(
  state: LocalApiState,
  parentTaskId: string | undefined,
  requestId: string | undefined,
): FoldStagedActProvenance {
  const record = parentTaskId ? state.managementRequests.get(parentTaskId) : null;
  return {
    stagedVia: record ? "management-conversation" : "act-cli",
    requestId: requestId?.trim() || randomUUID(),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(record ? { conversationId: record.conversationId } : {}),
    ...(record?.remotePrincipalId && record.remoteGrantId
      ? { browserId: record.remotePrincipalId, grantId: record.remoteGrantId }
      : {}),
  };
}

function toStagedDecision(admission: FoldStagedActAdmission): WorkFoldActStagedDecision {
  const { act } = admission;
  return {
    decisionId: act.id,
    kind: act.kind,
    category: act.category,
    state: "staged",
    createdAt: act.createdAt,
    expiresAt: act.expiresAt,
    deduplicated: admission.deduplicated,
    ...(act.priorDenialAt !== undefined ? { priorDenialAt: act.priorDenialAt } : {}),
  };
}

function stagedActSpaceIdOf(act: FoldStagedAct): string | undefined {
  const value = act.parameters.spaceId ?? act.pins.spaceId;
  return typeof value === "string" ? value : undefined;
}

function toStagedActSummary(act: FoldStagedAct): WorkFoldActStagedActSummary {
  const spaceId = stagedActSpaceIdOf(act);
  return {
    id: act.id,
    kind: act.kind,
    category: act.category,
    state: act.state,
    createdAt: act.createdAt,
    expiresAt: act.expiresAt,
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(act.decidedAt !== undefined ? { decidedAt: act.decidedAt } : {}),
    ...(act.decision !== undefined ? { decisionSurface: act.decision.surface } : {}),
    ...(act.execution !== undefined ? { executionOutcome: act.execution.outcome } : {}),
    ...(act.priorDenialAt !== undefined ? { priorDenialAt: act.priorDenialAt } : {}),
  };
}

function toStagedActDetail(act: FoldStagedAct): WorkFoldActStagedActDetail {
  const restrictions = foldDecisionSurfaceRestrictions(act);
  return {
    ...toStagedActSummary(act),
    parameters: structuredClone(act.parameters),
    pins: structuredClone(act.pins),
    provenance: structuredClone(act.provenance),
    restrictions: {
      desktopOnly: restrictions.desktopOnly,
      ...(restrictions.stagedByGrantId !== undefined ? { stagedByGrantId: restrictions.stagedByGrantId } : {}),
    },
    ...(act.decision !== undefined ? { decision: structuredClone(act.decision) } : {}),
    ...(act.execution !== undefined ? { execution: structuredClone(act.execution) } : {}),
    ...(act.invalidationReason !== undefined ? { invalidationReason: act.invalidationReason } : {}),
    ...(act.cancellationReason !== undefined ? { cancellationReason: act.cancellationReason } : {}),
  };
}

/**
 * Digest-addressed holding area for staged routing declarations: the exact
 * normalized declaration a `routings stage` reviewed, waiting inert until its
 * decision. Machine-local application state beside the staged-act store —
 * never a Space folder — and content-addressed, so the decision-time reload
 * is identity, not trust: bytes that no longer hash to the pinned digest
 * invalidate the card instead of enabling something the person never saw.
 */
function stagedRoutingDeclarationsDir(): string {
  return join(workFoldStateRoot(), "fold", "staged-routings");
}

function stagedRoutingDeclarationFile(digest: string): string {
  if (!/^[a-f0-9]{16,128}$/.test(digest)) throw new WorkFoldCliError("usage", "The routing declaration digest is malformed.");
  return join(stagedRoutingDeclarationsDir(), `${digest}.json`);
}

async function holdStagedRoutingDeclaration(declaration: WorkFoldRoutingDeclaration, digest: string): Promise<void> {
  const directory = stagedRoutingDeclarationsDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${digest}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(declaration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, stagedRoutingDeclarationFile(digest));
}

/** Bounded by the pending cap: only digests a pending routing.enable act still pins are kept. */
async function pruneStagedRoutingDeclarations(store: FoldStagedActStore): Promise<void> {
  const pending = await store.list({ state: "staged", kind: "routing.enable" }).catch(() => [] as FoldStagedAct[]);
  const keep = new Set(
    pending
      .map((act) => act.pins.declarationDigest)
      .filter((digest): digest is string => typeof digest === "string"),
  );
  const directory = stagedRoutingDeclarationsDir();
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    if (!entry.endsWith(".json")) continue;
    if (keep.has(entry.slice(0, -".json".length))) continue;
    await rm(join(directory, entry), { force: true }).catch(() => undefined);
  }
}

async function loadStagedRoutingDeclaration(digest: string): Promise<WorkFoldRoutingDeclaration | null> {
  let text: string;
  try {
    text = await readFile(stagedRoutingDeclarationFile(digest), "utf8");
  } catch {
    return null;
  }
  const declaration = normalizeWorkFoldRoutingDeclaration(JSON.parse(text));
  return workFoldRoutingDigest(declaration) === digest ? declaration : null;
}

/**
 * Reads one inert typed routing file — a proposal or a full declaration —
 * and normalizes it into the declaration enablement will verify. A proposal
 * gains a deterministic content-derived routing id, so restaging identical
 * content dedupes onto one card and denial memory holds.
 */
async function readRoutingStagingFile(
  proposalPath: string,
  cwd: string,
): Promise<{ declaration: WorkFoldRoutingDeclaration; digest: string }> {
  const path = isAbsolute(proposalPath) ? resolve(proposalPath) : resolve(cwd, proposalPath);
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new WorkFoldCliError("notFound", "The routing proposal must be a regular file on this machine.");
  }
  if (info.size > 256 * 1024) throw new WorkFoldCliError("usage", "The routing proposal exceeds the 256 KiB bound.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new WorkFoldCliError("usage", `The routing proposal is not readable JSON: ${errorMessage(error)}`, { cause: error });
  }
  const kind = (parsed as { kind?: unknown } | null)?.kind;
  try {
    if (kind === workFoldRoutingProposalKind) {
      const proposal = normalizeWorkFoldRoutingProposal(parsed);
      const contentId = `routing-${workFoldRoutingDigest(proposal).slice(0, 16)}`;
      const declaration = declarationFromWorkFoldRoutingProposal(proposal, contentId);
      return { declaration, digest: workFoldRoutingDigest(declaration) };
    }
    if (kind === workFoldRoutingDeclarationKind) {
      const declaration = normalizeWorkFoldRoutingDeclaration(parsed);
      return { declaration, digest: workFoldRoutingDigest(declaration) };
    }
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
  throw new WorkFoldCliError(
    "usage",
    `The file is not a typed routing proposal (${workFoldRoutingProposalKind}) or declaration (${workFoldRoutingDeclarationKind}); nothing else is accepted.`,
  );
}

/**
 * Enumerates a skill bundle's SKILL.md names for the staged card without
 * installing anything, on the import path's own bounds. Digest equality
 * remains the whole identity recheck at decision time; these names are the
 * card's inspection facts, derived from the exact staged bytes.
 */
async function enumerateSkillBundleNames(fileName: string, bytes: Uint8Array): Promise<string[]> {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".md") {
    const markdown = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? "";
    const rawName = /^name\s*:\s*(.+?)\s*$/im.exec(frontmatter)?.[1]?.trim();
    const unquoted = rawName?.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, d, s) => (d ?? s ?? "")).trim();
    if (!unquoted) throw new WorkFoldCliError("usage", "SKILL.md must declare a name in YAML frontmatter.");
    return [unquoted];
  }
  if (extension !== ".zip" && extension !== ".skill") {
    throw new WorkFoldCliError("usage", "Skills must be a SKILL.md file or use a .zip or .skill bundle.");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new WorkFoldCliError("usage", `Could not read the skill bundle: ${errorMessage(error)}`, { cause: error });
  }
  const bundleStem = basename(fileName, extname(fileName));
  const names = Object.values(archive.files)
    .filter((entry) => !entry.dir && basename(entry.name.replace(/\\/g, "/")).toLowerCase() === "skill.md")
    .map((entry) => {
      const parent = entry.name.replace(/\\/g, "/").replace(/\/?skill\.md$/i, "").replace(/\/$/, "");
      const segments = parent.split("/").filter((segment) => segment && segment !== ".");
      return segments.length ? segments[segments.length - 1]! : bundleStem;
    })
    .slice(0, 256);
  if (!names.length) throw new WorkFoldCliError("usage", "The bundle does not contain a SKILL.md file.");
  return [...new Set(names)].sort();
}

/** Parses an npm package source into its identity; null for non-npm sources. */
function npmSourceIdentity(source: string): { packageName: string; pinnedVersion?: string } | null {
  if (!source.startsWith("npm:")) return null;
  const rest = source.slice("npm:".length);
  const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
  if (at === -1) return { packageName: rest };
  const packageName = rest.slice(0, at);
  const pinnedVersion = rest.slice(at + 1);
  return pinnedVersion ? { packageName, pinnedVersion } : { packageName };
}

/**
 * The inspected resource summary the needs-you card shows for a package
 * install or update. Extensions and install scripts are named for what they
 * are — a code-execution decision — exactly as the desktop review does.
 */
function capabilityResourceSummary(details: {
  skills?: string[];
  extensions?: string[];
  prompts?: string[];
  themes?: string[];
  installScripts?: Array<{ name: string }>;
  dependencyCount?: number;
}): string {
  const parts = [
    `${details.skills?.length ?? 0} skill(s)`,
    `${details.extensions?.length ?? 0} extension(s)${(details.extensions?.length ?? 0) > 0 ? " — executable Pi capability" : ""}`,
  ];
  if (details.prompts?.length) parts.push(`${details.prompts.length} prompt(s)`);
  if (details.themes?.length) parts.push(`${details.themes.length} theme(s)`);
  if (details.installScripts?.length) {
    parts.push(`${details.installScripts.length} install script(s) — runs code at install (${details.installScripts.map((script) => script.name).join(", ")})`);
  }
  if (details.dependencyCount) parts.push(`${details.dependencyCount} runtime dependencies`);
  return parts.join(", ").slice(0, 2000);
}

/**
 * Observed content identity for one staged `files destroy` target, pinned so
 * the decision-time recheck can refuse changed content: a content hash where
 * readable, sizes always, bounded folder measurements for trees.
 */
async function observedDestroyIdentity(absolutePath: string): Promise<string> {
  const info = await lstat(absolutePath);
  if (info.isDirectory()) {
    let fileCount = 0;
    let totalBytes = 0;
    let visited = 0;
    const visit = async (path: string): Promise<void> => {
      if (visited >= maxRoutingMeasureEntries) return;
      visited += 1;
      const entryInfo = await lstat(path).catch(() => null);
      if (!entryInfo || entryInfo.isSymbolicLink()) return;
      if (entryInfo.isFile()) {
        fileCount += 1;
        totalBytes += entryInfo.size;
        return;
      }
      if (!entryInfo.isDirectory()) return;
      for (const entry of await readdir(path).catch(() => [] as string[])) await visit(join(path, entry));
    };
    await visit(absolutePath);
    return `folder:files=${fileCount}:bytes=${totalBytes}`;
  }
  if (!info.isFile()) throw new WorkFoldCliError("usage", "Only files and folders can be staged for destruction.");
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
    return `file:sha256:${hash.digest("hex")}:${info.size}`;
  } catch {
    return `file:unreadable:${info.size}`;
  }
}

/**
 * Staging-time source verification for one page exposure, mirroring the
 * publication service's own inspection: the exact normalized relative path
 * the pins carry, an allowed media type, a regular file, and the shareable
 * size bound. The service re-verifies for real at decision time and again at
 * every serve.
 */
async function stagedPageSource(spaceRoot: string, relativePath: string): Promise<{ relativePath: string; byteSize: number }> {
  let path: string;
  try {
    path = resolveSpacePath(spaceRoot, relativePath);
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
  // Canonical Space-relative form from the resolved path, so identical
  // designations ("./weekly.md", "weekly.md") pin one identity and dedupe
  // onto one card.
  const normalized = relative(resolve(spaceRoot), path).split(sep).join("/");
  if (!normalized) throw new WorkFoldCliError("usage", "A Space-relative file path is required.");
  const extension = extname(normalized).toLowerCase();
  if (!WORKFOLD_PUBLICATION_SOURCE_TYPES[extension]) {
    throw new WorkFoldCliError("usage", "Only Markdown, plain text, PNG, JPEG, and PDF files can be shared as a page in this slice.");
  }
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile()) throw new WorkFoldCliError("notFound", "The designated file does not exist as a regular file.");
  if (info.size > WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES) {
    throw new WorkFoldCliError("usage", "The designated file is larger than a shareable page (8 MiB).");
  }
  return { relativePath: normalized, byteSize: info.size };
}

function createFoldDecisionFence(state: LocalApiState): FoldDecisionMutationFence {
  return {
    probe(scope) {
      return capabilityFenceBusyReason(state, scope);
    },
    run(scope, operation) {
      return scope.scope === "space"
        ? runRestrictedAppMutation(state, scope.spaceId, operation)
        : runCapabilityMutation(state, capabilityGlobalMutationScope(), "global", operation);
    },
  };
}

/** Mirrors reserveCapabilityMutation's conflict checks without reserving. */
function capabilityFenceBusyReason(state: LocalApiState, scope: FoldDecisionFenceScope): string | null {
  if (scope.scope === "global") {
    if (state.capabilityMutations.size > 0) return "Wait for the current capability change to finish.";
    if (state.runningTurns.size > 0 || state.compactingConversations.size > 0
      || state.checkRunReservations.size > 0 || state.checks.hasActiveRun()) {
      return "Wait for affected Assistant work to finish before changing capabilities.";
    }
    return null;
  }
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(scope.spaceId)) {
    return "Wait for the current capability change to finish.";
  }
  if (hasActiveCapabilityWorkForSpace(state, scope.spaceId)) {
    return "Wait for affected Assistant work to finish before changing capabilities.";
  }
  return null;
}

/**
 * Per-kind execution adapters for the decision path: each binds one staged-act
 * kind to the same domain internals the equivalent desktop ceremony uses.
 * `app.data.purge`, `app.storage.clear`, `files.destroy`, and hosted-app
 * `publish.viewer.expose` exposure stay deliberately unbound in this build —
 * staging, denying, and canceling them works, and approving them is refused
 * honestly (EXECUTION_UNAVAILABLE or a pending eligibility reason) before
 * anything is consumed.
 */
function createFoldDecisionAdapters(state: LocalApiState): FoldDecisionAdapters {
  const spaceRefById = async (spaceId: string): Promise<{ id: string; spaceRoot: string }> => {
    const space = await getSpace(spaceId);
    return { id: space.id, spaceRoot: space.spaceRoot };
  };
  const grantOptions = {
    service: state.restrictedApps,
    getSpace: spaceRefById,
    // The decision-time person-chosen root the renderer decide route
    // registered for exactly this staged act (desktop folder picker,
    // docs/fold-consecrations.md). Absent means the app.grant.files card is
    // honestly ineligible on this decide — including every remote decide,
    // whose operation carries no root by design.
    resolveFileGrantRoot: (act: FoldStagedAct) => state.fileGrantRootChoices.get(act.id) ?? null,
  };
  return {
    "app.review.approve": createRestrictedAppReviewApproveAdapter({ proposals: state.restrictedAppProposals }),
    "app.grant.network": createRestrictedAppGrantAdapter("app.grant.network", grantOptions),
    "app.grant.files": createRestrictedAppGrantAdapter("app.grant.files", grantOptions),
    "app.grant.notifications": createRestrictedAppGrantAdapter("app.grant.notifications", grantOptions),
    "app.automation.enable": createRestrictedAppAutomationEnableAdapter({ service: state.restrictedApps }),
    "capability.skills.import": createSkillImportAdapter({
      loadBundle: (act) => loadStagedSkillBundle(state, act),
      // Space scope resolves the Space's folder; Personal scope has no Space,
      // so it names the same app-owned neutral root the act facade's
      // Personal-scope tools verbs resolve against.
      rootForScope: async (act) => act.parameters.scope === "space"
        ? (await getSpace(String(act.parameters.spaceId))).spaceRoot
        : workFoldManagementRoot(),
      runtimeProvider: state.runtimeProvider,
    }),
    "routing.enable": createRoutingEnableDecisionAdapter(state),
    "publish.viewer.expose": createViewerExposeDecisionAdapter(state),
    "capability.package.install": createCapabilityPackageDecisionAdapter(state, "install"),
    "capability.package.update": createCapabilityPackageDecisionAdapter(state, "update"),
    "app.connection.save": createAppConnectionSaveDecisionAdapter(state),
    "space.delete-folder": createManagedSpaceDeletionAdapter({
      // The complete desktop removal orchestration — impact checks, Check,
      // routing, staged-act, and app-state revocation, claim-verified managed
      // deletion — shared with DELETE /api/spaces/:id and `spaces unregister`.
      // It reserves its own capability fences across every affected Space, so
      // the adapter's null fenceScope keeps the service from reserving twice.
      executeDeletion: async (act) => {
        const space = await getSpace(String(act.pins.spaceId ?? act.parameters.spaceId));
        const result = await removeSpaceRegistrationInternal(state, space);
        return {
          detail: result.cleanupPending
            ? `Deleted the managed Space folder ${space.spaceRoot}; final cleanup completes at the next start.`
            : `Deleted the managed Space folder ${space.spaceRoot}.`,
        };
      },
    }),
  };
}

/**
 * Re-reads the exact staged bundle bytes for `capability.skills.import`.
 * Loading is identity, not trust: the adapter's content-digest recheck
 * decides whether these are the reviewed bytes. An absolute path is a
 * file-borne bundle; any other source is an official catalog bundle id,
 * rebuilt through the same registry path the desktop install uses and then
 * digest-checked like every other reload.
 */
async function loadStagedSkillBundle(
  state: LocalApiState,
  act: FoldStagedAct,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const source = String(act.pins.source ?? act.parameters.source ?? "").trim();
  if (!source) throw new Error("the staged bundle source is missing");
  if (!isAbsolute(source)) {
    const bundle = await state.capabilityRegistry.buildOfficialSkillBundle(source);
    return { fileName: bundle.fileName, bytes: bundle.bytes };
  }
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("the staged bundle source must be a regular file");
  }
  return { fileName: basename(source), bytes: await readFile(source) };
}

/**
 * `routing.enable` — the enablement grant of docs/fold-routings.md. The
 * staged declaration is reloaded from the digest-addressed holding area and
 * re-verified against the pinned digest and routing id; every referenced
 * Space must still be registered. Execution commits the declaration and the
 * exact-authority grant through the routing service with `decisionId` equal
 * to the staged-act id — the staged act and its decision share one identity —
 * and the store itself re-refuses a declaration that no longer hashes to the
 * reviewed digest, so an edited routing never coasts on a stale approval.
 */
function createRoutingEnableDecisionAdapter(state: LocalApiState): FoldStagedActKindAdapter {
  const load = async (act: FoldStagedAct): Promise<{ declaration: WorkFoldRoutingDeclaration } | { issue: string }> => {
    const digest = String(act.pins.declarationDigest);
    let declaration: WorkFoldRoutingDeclaration | null;
    try {
      declaration = await loadStagedRoutingDeclaration(digest);
    } catch {
      declaration = null;
    }
    if (!declaration) {
      return { issue: "The staged routing declaration no longer matches the reviewed digest or is no longer held; restage it from the proposal." };
    }
    if (declaration.id !== act.pins.routingId) {
      return { issue: "The staged declaration names a different routing than this card pinned." };
    }
    for (const spaceId of workFoldRoutingReferencedSpaceIds(declaration)) {
      const registered = await getSpace(spaceId).catch(() => null);
      if (!registered) return { issue: `The routing references a Space that is no longer registered (${spaceId}).` };
    }
    return { declaration };
  };
  return {
    // Enablement is a routing-store commit under its own serialization; it
    // mutates no capability state, so it reserves no capability fence.
    fenceScope: () => null,
    async recheckPins(act) {
      const loaded = await load(act);
      return "issue" in loaded ? loaded.issue : null;
    },
    async execute(act) {
      const loaded = await load(act);
      if ("issue" in loaded) throw new Error(loaded.issue);
      const decision = act.decision;
      if (!decision || decision.decision !== "approved") throw new Error("Execution requires a consumed approval.");
      const record = await state.routings.enable({
        declaration: loaded.declaration,
        expectedDigest: String(act.pins.declarationDigest),
        decision: {
          decisionId: act.id,
          surface: decision.surface,
          ...(decision.browserId !== undefined ? { browserId: decision.browserId } : {}),
          ...(decision.grantId !== undefined ? { browserGrantId: decision.grantId } : {}),
        },
      });
      await rm(stagedRoutingDeclarationFile(record.digest), { force: true }).catch(() => undefined);
      return {
        detail: `Enabled routing "${record.declaration.title}" (${record.declaration.id}) at digest ${record.digest}.`,
        undoRef: { kind: "routing-id", value: record.declaration.id },
      };
    },
  };
}

/**
 * `publish.viewer.expose` — the activation paths of docs/fold-publishing.md,
 * executed with the approving surface, browser identity, and `decisionId`
 * threaded into the publication service's own journaled act context. Page
 * exposure re-verifies the designated source; hosted-app exposure (rung 3)
 * re-resolves the pinned App Instance and requires the exact pinned Release
 * digest and viewer surface — an app that updated or widened its viewer
 * surface after staging invalidates instead of exposing something the card
 * never showed.
 */
function createViewerExposeDecisionAdapter(state: LocalApiState): FoldStagedActKindAdapter {
  const recheckPage = async (act: FoldStagedAct): Promise<string | null> => {
    const space = await getSpace(String(act.pins.spaceId)).catch(() => null);
    if (!space) return "The pinned Space is no longer registered.";
    try {
      const source = await stagedPageSource(space.spaceRoot, String(act.pins.relativePath));
      if (source.relativePath !== act.pins.relativePath) {
        return "The designated file's normalized path no longer matches the pinned path.";
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  };
  const resolveHostedApp = async (act: FoldStagedAct): Promise<
    | { exposure: Extract<Awaited<ReturnType<RestrictedAppViewerAdapter["resolveExposure"]>>, { eligible: true }> }
    | { issue: string }
  > => {
    const exposure = await state.restrictedAppViewer.resolveExposure(stringPinValue(act, "appInstanceId"));
    if (!exposure.eligible) return { issue: exposure.issue };
    if (exposure.pins.releaseDigest !== act.pins.releaseDigest) {
      return { issue: "The installed Release digest no longer matches the pinned digest; the app updated after staging." };
    }
    if (exposure.pins.viewerEntry !== act.pins.viewerEntry) {
      return { issue: "The app's viewer entry no longer matches the pinned entry." };
    }
    const pinnedSurface = Array.isArray(act.pins.viewerSurface) ? act.pins.viewerSurface.map(String) : [];
    if (JSON.stringify(exposure.pins.viewerSurface) !== JSON.stringify(pinnedSurface)) {
      return { issue: "The app's viewer-readable surface no longer matches the pinned surface." };
    }
    return { exposure };
  };
  return {
    // Activation is publication-service work under its own journal and
    // serialization; it is not a capability mutation.
    fenceScope: () => null,
    async recheckPins(act) {
      if (act.pins.exposure === "page") return await recheckPage(act);
      const resolved = await resolveHostedApp(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act) {
      const decision = act.decision;
      if (!decision || decision.decision !== "approved") throw new Error("Execution requires a consumed approval.");
      const context = {
        // A distinct deterministic request id: the decision path owns
        // `fold-decision:<id>`, and the activation journals its own
        // accepted/terminal pair under the same single-use identity family.
        requestId: `${foldDecisionRequestId(act.id)}:activate`,
        surface: decision.surface,
        decisionId: act.id,
        ...(decision.browserId !== undefined ? { browserId: decision.browserId } : {}),
        ...(decision.grantId !== undefined ? { grantId: decision.grantId } : {}),
      };
      if (act.pins.exposure === "page") {
        const view = await state.publications.activate({
          spaceId: String(act.pins.spaceId),
          relativePath: String(act.pins.relativePath),
          title: String(act.pins.title),
          serveRatePerMinute: Number(act.pins.serveBudget),
          byteBudgetPerDay: Number(act.pins.byteBudget),
          snapshotEnabled: act.pins.snapshotEnabled === true,
        }, context);
        return {
          detail: `Shared "${view.title}" (${view.spaceId}:${view.relativePath}) as /p/${view.publicationId}; `
            + `bridgeSync=${view.bridgeSlot === "confirmed" ? "confirmed" : "pending"}.`,
          undoRef: { kind: "publicationId", value: view.publicationId },
        };
      }
      const resolved = await resolveHostedApp(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const view = await state.publications.activateApp({
        spaceId: resolved.exposure.spaceId,
        title: resolved.exposure.title,
        app: {
          appInstanceId: resolved.exposure.pins.appInstanceId,
          releaseDigest: resolved.exposure.pins.releaseDigest,
          viewerEntry: resolved.exposure.pins.viewerEntry,
          viewerSurface: resolved.exposure.pins.viewerSurface,
        },
      }, context);
      return {
        detail: `Put "${view.title}" (App Instance ${resolved.exposure.pins.appInstanceId}, `
          + `Release ${resolved.exposure.pins.releaseDigest}) at your address as /a/${view.publicationId}; `
          + `bridgeSync=${view.bridgeSlot === "confirmed" ? "confirmed" : "pending"}.`,
        undoRef: { kind: "publicationId", value: view.publicationId },
      };
    },
  };
}

/** The staged-act pin as bounded text, tolerating the parameter mirror. */
function stringPinValue(act: FoldStagedAct, name: string): string {
  const value = act.pins[name] ?? act.parameters[name];
  return typeof value === "string" ? value : "";
}

/**
 * `capability.package.install|update` — the same capability-mutation
 * internals as the desktop package routes, executed inside the decision
 * fence's reservation (Space scope for a Space-scoped package, global for
 * Personal scope) instead of reserving twice. Project trust is an
 * eligibility precheck so an untrusted Space keeps the card pending rather
 * than consuming approval.
 */
function createCapabilityPackageDecisionAdapter(
  state: LocalApiState,
  operation: "install" | "update",
): FoldStagedActKindAdapter {
  const scopeOf = (act: FoldStagedAct): "personal" | "space" =>
    (act.pins.scope ?? act.parameters.scope) === "space" ? "space" : "personal";
  const spaceOf = async (act: FoldStagedAct): Promise<SpaceSummary | null> => {
    const spaceId = act.parameters.spaceId;
    if (typeof spaceId !== "string") return null;
    try {
      return await getSpace(spaceId);
    } catch {
      return null;
    }
  };
  return {
    async eligibilityIssue(act) {
      if (scopeOf(act) !== "space") return null;
      const space = await spaceOf(act);
      if (!space) return null; // the pin recheck reports the missing Space
      return await isPiProjectMutationTrusted(space.spaceRoot, state.runtimeProvider)
        ? null
        : "Trust this Space before changing Space-scoped capabilities.";
    },
    async recheckPins(act) {
      if (scopeOf(act) !== "space") return null;
      return (await spaceOf(act)) ? null : "The pinned Space is no longer registered.";
    },
    async execute(act) {
      const scope = scopeOf(act);
      const space = scope === "space" ? await spaceOf(act) : null;
      if (scope === "space" && !space) throw new Error("The pinned Space is no longer registered.");
      const root = space?.spaceRoot ?? workFoldManagementRoot();
      const source = String(act.pins.source);
      const piScope = scope === "space" ? "project" as const : "user" as const;
      if (operation === "install") {
        await installPiPackage(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      } else {
        await updatePiPackages(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      }
      return {
        detail: `${operation === "install" ? "Installed" : "Updated"} ${String(act.pins.packageId)}@${String(act.pins.version)} `
          + `from ${source} at ${piScope === "user" ? "Personal" : "This Space"} scope.`,
        undoRef: { kind: "package-source", value: source },
      };
    },
  };
}

/**
 * `app.connection.save` — approval opens the existing host connection flow
 * scoped to the pinned declaration. Only the browser OAuth flow can run
 * without a person typing a secret, so form-credential shapes stay honestly
 * ineligible: the secret is entered in Assistant tools, never through the
 * fold, and the staged act carries only the connection's shape.
 */
function createAppConnectionSaveDecisionAdapter(state: LocalApiState): FoldStagedActKindAdapter {
  const targetLabel = (target: { kind: string; origin?: string; host?: string; port?: number }): string =>
    target.kind === "public-https" ? String(target.origin) : `http://${String(target.host)}:${String(target.port)}`;
  const resolve = async (act: FoldStagedAct): Promise<
    | { issue: string }
    | { app: RestrictedAppInstalled; destination: RestrictedAppNetworkDeclaration }
  > => {
    const spaceId = String(act.parameters.spaceId);
    const appInstanceId = String(act.pins.appInstanceId ?? act.parameters.appInstanceId);
    const app = await state.restrictedApps.findByFeatureInstallation(spaceId, appInstanceId);
    if (!app) return { issue: "The pinned App Instance is no longer installed in this Space." };
    const declarationId = String(act.pins.declarationId);
    const destination = app.manifest.permissions.network.find((item) => item.id === declarationId);
    if (!destination) return { issue: "The app no longer declares the pinned connection destination." };
    if (targetLabel(destination.target) !== act.pins.target) {
      return { issue: "The destination's reviewed target changed after staging." };
    }
    if (!destination.auth.some((item) => item.kind === act.pins.adapterKind)) {
      return { issue: "The destination no longer declares the pinned credential adapter." };
    }
    return { app, destination };
  };
  return {
    eligibilityIssue(act) {
      return act.pins.adapterKind === "oauth2-pkce"
        ? null
        : "This connection takes a secret typed into the host connection form; enter it in Assistant tools. Approval here can open only the browser sign-in flow.";
    },
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      await state.restrictedApps.connectOAuth({
        spaceId: resolved.app.spaceId,
        appId: resolved.app.manifest.id,
        destinationId: resolved.destination.id,
        expectedDigest: resolved.app.digest,
      });
      return {
        detail: `Connected ${resolved.app.manifest.id} to ${String(act.pins.target)} through the browser sign-in flow.`,
        undoRef: { kind: "declaration", value: resolved.destination.id },
      };
    },
  };
}

/**
 * The routing executor's hop ports: the same in-process internals the act
 * facade uses — turn acceptance in a fresh Chat, the files-add copy with its
 * restore point, reserved Check runs — honoring aborts through each domain's
 * own abort path, and returning identifiers and counts only.
 */
function createRoutingHopPorts(state: LocalApiState): WorkFoldRoutingHopPorts {
  return {
    async chat(step, context) {
      const space = await getSpace(step.space);
      const conversation = await createConversation(space.spaceRoot);
      const checkpoints: { pre?: string; post?: string } = {};
      const observer = (event: TurnCheckpointEvent): void => {
        if (event.spaceId !== space.id || event.conversationId !== conversation.id) return;
        if (event.reason === "pre_turn") checkpoints.pre ??= event.checkpointId;
        else checkpoints.post = event.checkpointId;
      };
      state.turnCheckpointListeners.add(observer);
      try {
        const { taskId } = await acceptConversationTurn(state, space, conversation.id, {
          content: step.message,
          contextPaths: [],
          selectedPath: null,
          actorKind: "system",
        });
        const settled = await waitForSettledTurn(state, space.id, conversation.id, taskId, context.signal);
        return {
          conversationId: conversation.id,
          turnTaskId: taskId,
          outcome: settled.status,
          ...(settled.error !== undefined ? { error: settled.error } : {}),
          ...(checkpoints.pre !== undefined ? { preCheckpointId: checkpoints.pre } : {}),
          ...(checkpoints.post !== undefined ? { postCheckpointId: checkpoints.post } : {}),
        };
      } finally {
        state.turnCheckpointListeners.delete(observer);
      }
    },
    async files(step, source, context) {
      // A files hop is deliberately not interruptible mid-copy: it completes
      // with its restore point or fails as one unit, so the signal is only a
      // pre-flight refusal here.
      if (context.signal.aborted) throw new Error("The run was aborted before this hop copied anything.");
      const from = await getSpace(step.fromSpace);
      const to = await getSpace(step.toSpace);
      const absoluteSources = await resolveRoutingFilesSources(from.spaceRoot, source);
      const copied: string[] = [];
      try {
        for (const sourcePath of absoluteSources) {
          copied.push(await copyPathIntoSpace(sourcePath, to.spaceRoot, step.to));
        }
      } catch (error) {
        // A mid-batch failure must not strand earlier copies without a
        // restore point: undo them best-effort, then surface the failure.
        await Promise.all(copied.map((path) =>
          rm(resolveSpacePath(to.spaceRoot, path), { recursive: true, force: true }).catch(() => undefined)));
        throw error;
      }
      const safety = await checkpointAdditiveWritesOrUndo(to.spaceRoot, copied, {
        reason: "pre_add",
        label: `Before routing hop ${step.id} added ${copied.length} item${copied.length === 1 ? "" : "s"}`,
      });
      const measured = await measureSpaceEntries(to.spaceRoot, copied);
      return {
        ...(safety ? { restorePointId: safety.checkpointId } : {}),
        copiedPaths: copied,
        fileCount: measured.fileCount,
        totalBytes: measured.totalBytes,
      };
    },
    async check(step, context) {
      const space = await getSpace(step.space);
      const accepted = await runReservedCheckOperation(state, space.id, () => state.checks.run({
        space,
        ...(step.check !== undefined ? { checkId: step.check } : {}),
        actor: { kind: "system", spaceId: space.id },
        // Lineage stamps the settle record so routing-caused runs never fire
        // on-settled triggers — chains stay structurally impossible.
        lineage: context.lineage,
      }));
      const requestAbort = (): void => {
        void state.checks.abort(space.id, accepted.taskId).catch(() => undefined);
      };
      if (context.signal.aborted) requestAbort();
      context.signal.addEventListener("abort", requestAbort, { once: true });
      try {
        for (;;) {
          const status = await state.checks.taskStatus(space.id, accepted.taskId);
          if (status.state === "unknown") throw new Error("work-fold lost track of this Check run.");
          if (status.state !== "accepted" && status.state !== "running") break;
          await settleDelay(50);
        }
        const run = await state.checks.taskResult(space.id, accepted.taskId);
        if (run.state === "accepted" || run.state === "running") {
          throw new Error("The Check run has not settled.");
        }
        return {
          runId: run.id,
          taskId: accepted.taskId,
          state: run.state,
          checkIds: [...run.checkIds],
          findingCount: run.findings.length,
          admittedCount: run.admittedCount,
          ...(run.error !== undefined ? { error: run.error } : {}),
        };
      } finally {
        context.signal.removeEventListener("abort", requestAbort);
      }
    },
    async checkpointManifest(spaceId, checkpointId) {
      const space = await getSpace(spaceId).catch(() => null);
      if (!space) return null;
      const checkpoint = await getSpaceCheckpoint(space.spaceRoot, checkpointId);
      if (!checkpoint) return null;
      return {
        files: checkpoint.files.map((file) => ({
          path: file.path,
          hashSha256: file.hashSha256,
          sizeBytes: file.sizeBytes,
        })),
        skippedFilePaths: checkpoint.skippedFiles.map((file) => file.path),
      };
    },
  };
}

/**
 * Resolves a routing files hop's source selection inside the source Space:
 * exact paths under the ordinary Space path policy (no symbolic links, no
 * reserved segments), or the bounded tree selector through the Check target
 * resolver's discipline and the routing handoff bounds.
 */
async function resolveRoutingFilesSources(
  fromSpaceRoot: string,
  source: Parameters<WorkFoldRoutingHopPorts["files"]>[1],
): Promise<string[]> {
  if (source.kind === "paths") {
    if (source.paths.length === 0) throw new Error("The files hop resolved no source paths.");
    if (source.paths.length > workFoldRoutingBounds.maxHandoffFiles) {
      throw new Error(`The files hop names ${source.paths.length} paths, more than the ${workFoldRoutingBounds.maxHandoffFiles}-file bound.`);
    }
    const absolute: string[] = [];
    for (const raw of source.paths) {
      const path = resolveSpacePath(fromSpaceRoot, raw);
      const info = await lstat(path).catch(() => null);
      if (!info) throw new Error(`Source not found in the source Space: ${raw}.`);
      if (info.isSymbolicLink()) throw new Error(`Symbolic-link sources cannot be copied: ${raw}.`);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Only files and folders can be copied: ${raw}.`);
      absolute.push(path);
    }
    return absolute;
  }
  const resolution = await resolveWorkFoldCheckTargets(fromSpaceRoot, [{
    kind: "tree",
    role: "primary",
    path: source.path,
    recursive: source.recursive,
    extensions: [...source.extensions],
  }], {
    limits: {
      maxFiles: workFoldRoutingBounds.maxHandoffFiles,
      maxTotalBytes: workFoldRoutingBounds.maxHandoffTotalBytes,
    },
  });
  return resolution.files.map((file) => file.absolutePath);
}

const maxRoutingMeasureEntries = 10_000;

/** Bounded evidence measurement of copied destinations: files and bytes. */
async function measureSpaceEntries(
  spaceRoot: string,
  relativePaths: string[],
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  let visited = 0;
  const visit = async (path: string): Promise<void> => {
    if (visited >= maxRoutingMeasureEntries) return;
    visited += 1;
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) {
      fileCount += 1;
      totalBytes += info.size;
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(path).catch(() => [] as string[])) {
      await visit(join(path, entry));
    }
  };
  for (const relativePath of relativePaths) {
    await visit(resolveSpacePath(spaceRoot, relativePath));
  }
  return { fileCount, totalBytes };
}

/**
 * Follows one accepted turn to its settled record, honoring the routing
 * run's abort signal through the same cancellation path `manage stop` uses.
 * The accepted turn always settles (its runner records an outcome in a
 * finally block), so the wait terminates; a record evicted by the bounded
 * settled-turn history reports honestly as lost.
 */
async function waitForSettledTurn(
  state: LocalApiState,
  spaceId: string,
  conversationId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<SettledTurnRecord> {
  let abortRequested = false;
  const requestAbort = (): void => {
    if (abortRequested) return;
    abortRequested = true;
    void cancelAcceptedTurn(state, spaceId, conversationId, taskId).catch(() => undefined);
  };
  const onAbort = (): void => requestAbort();
  if (signal.aborted) requestAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const settled = state.settledTurns.get(taskId);
      if (settled && settled.spaceId === spaceId) return { ...settled };
      if (!state.activeTurnTasks.has(taskId)) {
        const late = state.settledTurns.get(taskId);
        if (late && late.spaceId === spaceId) return { ...late };
        return {
          taskId,
          spaceId,
          conversationId,
          status: "failed",
          endedAt: new Date().toISOString(),
          error: "work-fold lost track of this turn.",
        };
      }
      await settleDelay(25);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function settleDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const maxGlanceConversationsPerSpace = 64;
const maxGlanceCheckpointsPerSpace = 24;
const maxGlanceActReceiptLines = 512;
const maxGlanceAutomationReceipts = 200;

/**
 * The glance's live-registry source readers (docs/fold-glance.md): recorded
 * state only — the settled-turn records, the management-request registry, the
 * chat store and History per registered Space, the Check service's status and
 * content-free settled runs, the act-receipts ledger, the staged-act store,
 * the routing receipts journal, the publication grant records, and the
 * restricted-app registry's machine-wide automation ledgers (active accepted
 * runs and settled receipts). The kernel's own task registry supplies running
 * tasks.
 */
function createServerGlanceSources(state: LocalApiState): WorkFoldGlanceSourceReaders {
  const routingRunReader = createWorkFoldGlanceRoutingRunReader();
  // The policy store's own change journal, read tolerantly from the same
  // state-root files the store appends (docs/fold-consecrations.md: the
  // glance reports policy-store changes, including the attestation mismatch
  // that disables every policy until a person re-saves them in Settings).
  const policyChangeReader = createWorkFoldGlancePolicyChangeReader();
  return {
    policyChanges: policyChangeReader,
    settledTurns: async (): Promise<WorkFoldGlanceSettledTurnRecord[]> =>
      [...state.settledTurns.values()].map((turn) => ({
        taskId: turn.taskId,
        // The management scope is not a Space; its settled turns carry no
        // Space id instead of rendering as a removed Space.
        ...(turn.spaceId === workFoldManagementScopeId ? {} : { spaceId: turn.spaceId }),
        conversationId: turn.conversationId,
        outcome: turn.status,
        endedAt: turn.endedAt,
      })),
    managementRequests: () => glanceManagementRequestRecords(state),
    chats: async (space) => {
      const summaries = await listConversations(space.spaceRoot);
      const records = [];
      for (const summary of summaries.slice(0, maxGlanceConversationsPerSpace)) {
        records.push(workFoldGlanceChatRecordFromMessages(summary, await readConversation(space.spaceRoot, summary.id)));
      }
      return records;
    },
    checkpoints: async (space) =>
      (await listSpaceCheckpoints(space.spaceRoot, maxGlanceCheckpointsPerSpace)).map((checkpoint) => ({
        checkpointId: checkpoint.checkpointId,
        createdAt: checkpoint.createdAt,
        ...(checkpoint.label !== undefined ? { label: checkpoint.label } : {}),
        reason: checkpoint.reason,
        scope: checkpoint.scope,
      })),
    checks: async (space): Promise<WorkFoldGlanceCheckSource | null> => {
      const ref = { id: space.id, spaceRoot: space.spaceRoot };
      return {
        status: await state.checks.status(ref),
        settledRuns: (await state.checks.settledRuns(ref)).map((run) => ({
          runId: run.runId,
          taskId: run.taskId,
          state: run.state,
          startedAt: run.startedAt,
          ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
          admittedCount: run.admittedCount,
        })),
      };
    },
    actReceipts: () => readActReceiptJournal(state),
    // The restricted-app registry's machine-wide ledgers: accepted-but-not-
    // settled runs render as running work, durable settled receipts as
    // what-changed items. Both are recorded state; no run is executed or
    // polled to compose the digest.
    automationRuns: async (): Promise<WorkFoldGlanceAutomationRunRecord[]> =>
      (await state.restrictedApps.listActiveAutomationRuns()).map((run) => ({
        runId: run.runId,
        automationId: run.automationId,
        spaceId: run.spaceId,
        startedAt: run.acceptedAt,
      })),
    automationRunReceipts: async (): Promise<WorkFoldGlanceAutomationReceiptRecord[]> =>
      (await state.restrictedApps.listAutomationRunHistory(maxGlanceAutomationReceipts)).map((receipt) => ({
        receiptId: receipt.receiptId,
        runId: receipt.runId,
        automationId: receipt.automationId,
        spaceId: receipt.spaceId,
        outcome: receipt.outcome,
        finishedAt: receipt.finishedAt,
      })),
    stagedActs: async (): Promise<WorkFoldGlanceStagedActRecord[]> =>
      (await state.stagedActs.list()).map((act) => ({
        id: act.id,
        category: act.category,
        kind: act.kind,
        state: act.state,
        createdAt: act.createdAt,
        expiresAt: act.expiresAt,
        ...(act.decidedAt !== undefined ? { decidedAt: act.decidedAt } : {}),
        ...(act.decision !== undefined ? { decisionSurface: act.decision.surface } : {}),
      })),
    routingRuns: routingRunReader,
    viewerGrants: async (): Promise<WorkFoldGlanceViewerGrantEventRecord[]> => {
      const events: WorkFoldGlanceViewerGrantEventRecord[] = [];
      for (const view of await state.publications.list()) {
        events.push({ publicationId: view.publicationId, event: "created", at: view.createdAt, spaceId: view.spaceId });
        if (view.revokedAt !== undefined) {
          events.push({ publicationId: view.publicationId, event: "revoked", at: view.revokedAt, spaceId: view.spaceId });
        }
        // The record's bounded health note: the publisher-facing reason
        // behind a vague not-available or resting viewer page
        // (docs/fold-publishing.md, "Honest states").
        if (view.lastProblem !== undefined) {
          events.push({
            publicationId: view.publicationId,
            event: view.lastProblem.state,
            at: view.lastProblem.at,
            spaceId: view.spaceId,
            title: view.title,
            reason: view.lastProblem.reason,
          });
        }
      }
      return events;
    },
  };
}

/** Management-request records with the same phase truth the act lane reports. */
async function glanceManagementRequestRecords(state: LocalApiState): Promise<WorkFoldGlanceManagementRequestRecord[]> {
  const records: WorkFoldGlanceManagementRequestRecord[] = [];
  for (const record of state.managementRequests.list()) {
    const view = await managementRequestView(state, record.taskId);
    if (!view) continue;
    records.push({
      taskId: view.taskId,
      conversationId: view.conversationId,
      phase: view.phase,
      startedAt: view.startedAt,
      endedAt: view.endedAt,
      childTaskIds: record.childTasks.map((child) => child.taskId),
    });
  }
  return records;
}

/**
 * Tolerant bounded read of the act-receipts ledger for the glance: the same
 * live and rotated files the executor appends. A damaged line is omitted —
 * the glance is a projection, never the journal's authority.
 */
async function readActReceiptJournal(state: LocalApiState): Promise<WorkFoldCliActReceipt[]> {
  const receipts: WorkFoldCliActReceipt[] = [];
  for (const path of [state.actReceipts.rotatedPath, state.actReceipts.path]) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const lines = text.split("\n").filter((line) => line.trim());
    for (const line of lines.slice(-maxGlanceActReceiptLines)) {
      try {
        const record = JSON.parse(line) as Partial<WorkFoldCliActReceipt>;
        if ((record.v !== 1 && record.v !== 2)
          || typeof record.at !== "string"
          || typeof record.requestId !== "string"
          || typeof record.command !== "string"
          || typeof record.outcome !== "string") continue;
        receipts.push(record as WorkFoldCliActReceipt);
      } catch {
        // Omitted, never fatal.
      }
    }
  }
  return receipts.slice(-maxGlanceActReceiptLines);
}

function closeSpaceStreams(state: LocalApiState, spaceId: string): void {
  const prefix = `${spaceId}:`;
  for (const [key, streams] of [...state.chatStreams]) {
    if (!key.startsWith(prefix)) continue;
    for (const response of streams) response.end();
    state.chatStreams.delete(key);
  }
}

function routeExtensionRequest(state: LocalApiState, request: PiExtensionUiRequest): void {
  state.extensionRequests.set(request.id, request);
  const spaceId = spaceIdForRoot(state, request.spaceRoot);
  if (!spaceId) {
    state.extensionUi.cancel(request.id);
    state.extensionRequests.delete(request.id);
    return;
  }
  const rendererRequest = {
    id: request.id,
    method: request.method,
    title: request.title,
    ...(request.method === "confirm" ? { message: request.message } : {}),
    ...(request.method === "select" ? { options: request.options } : {}),
    ...(request.method === "input" && request.placeholder ? { placeholder: request.placeholder } : {}),
    ...(request.method === "input" && request.secret ? { secret: true } : {}),
    ...(request.method === "editor" && request.prefill ? { initialValue: request.prefill } : {}),
  };
  broadcast(state, streamKey(spaceId, request.conversationId), {
    type: "extension_ui_request",
    conversationId: request.conversationId,
    request: rendererRequest,
  });
}

function routeRestrictedAppProposal(state: LocalApiState, proposal: RestrictedAppProposalReceipt): void {
  broadcast(state, streamKey(proposal.spaceId, proposal.conversationId), {
    type: "restricted_app_proposal",
    conversationId: proposal.conversationId,
    proposal: rendererRestrictedAppProposal(proposal),
  });
}

function routeRestrictedAppProposalSettled(state: LocalApiState, proposal: RestrictedAppProposalReceipt): void {
  broadcast(state, streamKey(proposal.spaceId, proposal.conversationId), {
    type: "restricted_app_proposal_settled",
    conversationId: proposal.conversationId,
    proposal: rendererRestrictedAppProposal(proposal),
  });
}

function rendererRestrictedAppProposal(proposal: RestrictedAppProposalReceipt): Record<string, unknown> {
  return {
    id: proposal.id,
    spaceId: proposal.spaceId,
    conversationId: proposal.conversationId,
    sourcePath: proposal.sourcePath,
    review: proposal.review,
    status: proposal.status,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...(proposal.installedApp ? { installedApp: proposal.installedApp } : {}),
  };
}

function routeExtensionEvent(state: LocalApiState, event: PiExtensionUiEvent): void {
  const spaceId = spaceIdForRoot(state, event.spaceRoot);
  if (!spaceId) return;
  if (event.method === "notify") {
    broadcast(state, streamKey(spaceId, event.conversationId), {
      type: "extension_ui_request",
      conversationId: event.conversationId,
      request: { id: event.id, method: "notify", message: event.message },
    });
    return;
  }
  if (event.method === "setEditorText" || event.method === "pasteToEditor") {
    broadcast(state, streamKey(spaceId, event.conversationId), {
      type: "editor",
      conversationId: event.conversationId,
      editorMode: event.method === "setEditorText" ? "replace" : "append",
      text: event.text,
    });
    return;
  }
  const message = extensionEventMessage(event);
  if (message) broadcast(state, streamKey(spaceId, event.conversationId), { type: "status", conversationId: event.conversationId, message });
}

function extensionResponse(request: PiExtensionUiRequest, value: unknown): { value: string } | { confirmed: boolean } {
  if (request.method === "confirm") return { confirmed: Boolean(value) };
  return { value: typeof value === "string" ? value : String(value ?? "") };
}

function extensionEventMessage(event: PiExtensionUiEvent): string | null {
  if (event.method === "setStatus") return event.text ?? null;
  if (event.method === "setWorkingMessage") return event.message ?? null;
  if (event.method === "setWorkingVisible") return event.visible ? "Extension is working…" : null;
  if (event.method === "setWorkingIndicator") return event.options ? "Extension is working…" : null;
  if (event.method === "setTitle") return event.title;
  if (event.method === "openExternal") return `Extension requested: ${event.url}`;
  if (event.method === "oauthDeviceCode") return `Open ${event.verificationUri} and enter ${event.userCode}.`;
  if (event.method === "unsupported") return `Extension UI feature is not available here: ${event.feature}`;
  return null;
}

function normalizeStatus(status: PiSetupStatus): Record<string, unknown> {
  return {
    ready: status.ready,
    configured: status.configured,
    provider: status.provider ?? null,
    model: status.model ?? null,
    piVersion: status.piVersion,
    projectTrusted: status.projectTrusted,
    error: status.error,
  };
}

function emptyAgentStatus(): Record<string, unknown> {
  return { ready: true, configured: false, provider: null, model: null, piVersion: null, projectTrusted: false, error: null };
}

async function safeAgentStatus(spaceRoot: string, provider: PiRuntimeProvider): Promise<Record<string, unknown>> {
  try {
    return normalizeStatus(await getPiSetupStatus(spaceRoot, provider));
  } catch (error) {
    return { ...emptyAgentStatus(), ready: false, error: errorMessage(error) };
  }
}

async function configuredSpace(spaceId?: string, provider?: string, model?: string) {
  if (!spaceId || !provider?.trim() || !model?.trim()) throw badRequest("A Space, provider, and model are required.");
  return getSpace(spaceId);
}

function openChatStream(
  state: LocalApiState,
  req: IncomingMessage,
  res: ServerResponse,
  spaceId: string,
  conversationId: string,
): void {
  const key = streamKey(spaceId, conversationId);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  writeSseData(res, { type: "status", conversationId, message: "Connected." });
  const log = chatEventLog(state, key);
  const cursor = parseSseCursor(req.headers["last-event-id"]);
  const firstRetainedId = log.events[0]?.id ?? log.nextId;
  const canReplay = cursor !== null && cursor >= firstRetainedId - 1 && cursor < log.nextId;
  if (canReplay) {
    for (const event of log.events) if (event.id > cursor) writeSseEntry(res, event);
  } else {
    const snapshotId = log.nextId - 1;
    writeSseData(res, {
      type: "turn_snapshot",
      conversationId,
      running: state.runningTurns.has(key),
      turnId: state.activeTurnIdsByKey.get(key) ?? null,
      text: log.assistantText,
    }, snapshotId > 0 ? snapshotId : undefined);
  }
  // Keep the original handshake event for older local consumers while the
  // richer snapshot provides cursor/text reconciliation to newer renderers.
  const handshakeId = log.nextId - 1;
  writeSseData(res, turnStateEvent(conversationId, state.runningTurns.has(key)), handshakeId > 0 ? handshakeId : undefined);
  const streams = state.chatStreams.get(key) ?? new Set<ServerResponse>();
  streams.add(res);
  state.chatStreams.set(key, streams);
  void state.restrictedAppProposals.list({ spaceId, conversationId }).then(async (proposals) => {
    for (const proposal of proposals) {
      if (proposal.status !== "pending" || res.writableEnded) continue;
      const current = await state.restrictedAppProposals.get(proposal.id);
      if (!current || current.status !== "pending" || current.updatedAt !== proposal.updatedAt || res.writableEnded) continue;
      res.write(`data: ${JSON.stringify({ type: "restricted_app_proposal", conversationId, proposal: rendererRestrictedAppProposal(current) })}\n\n`);
    }
  }).catch(() => undefined);
  const heartbeat = setInterval(() => {
    try {
      if (res.writableLength > maxChatStreamQueuedBytes) res.end();
      else res.write(": keepalive\n\n");
    } catch { /* disconnected */ }
  }, 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    streams.delete(res);
    if (!streams.size) state.chatStreams.delete(key);
  });
}

async function openSpaceFileStream(
  state: LocalApiState,
  req: IncomingMessage,
  res: ServerResponse,
  spaceRoot: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let recursive = true;
  let watcher: ReturnType<typeof watch>;
  const sendEvent = (event: unknown) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* disconnected */ }
  };
  const onChange = (eventType: string, fileName: string | Buffer | null) => {
    const rawName = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
    if (!rawName) {
      sendEvent({ type: "file_event", eventType, path: null });
      return;
    }
    const path = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || isAlwaysHiddenSpaceEntry(basename(path))) return;
    void readSpaceIgnoreState(spaceRoot).then((ignoreState) => {
      if (isSpaceIgnored(path, ignoreState.patterns)) return;
      try { resolveSpacePath(spaceRoot, path); } catch { return; }
      sendEvent({ type: "file_event", eventType, path });
    });
  };
  const watchRoot = await canonicalSpaceWatchRoot(spaceRoot);
  try {
    watcher = watch(watchRoot, { recursive: true }, onChange);
  } catch {
    recursive = false;
    watcher = watch(watchRoot, onChange);
  }
  sendEvent({ type: "ready", recursive });
  const heartbeat = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* disconnected */ }
  }, 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    if (!res.writableEnded) res.end();
    state.fileStreams.delete(close);
  };
  state.fileStreams.add(close);
  watcher.on("error", (error) => sendEvent({ type: "error", message: errorMessage(error) }));
  req.on("close", close);
}

async function sendSpaceRawFile(res: ServerResponse, spaceRoot: string, relativePath: string): Promise<void> {
  const path = resolveSpacePath(spaceRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": info.size,
    "content-disposition": "inline",
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("end", resolvePromise);
    stream.pipe(res);
  });
}

function normalizeSelectedPath(spaceRoot: string, value: string | null | undefined): string | null {
  const path = typeof value === "string" ? normalizeSpaceRelativePath(value) : "";
  if (!path) return null;
  let absolutePath: string;
  try {
    absolutePath = resolveSpacePath(spaceRoot, path);
  } catch (error) {
    throw badRequest(errorMessage(error));
  }
  if (!existsSync(absolutePath)) throw badRequest("The selected Space item no longer exists.");
  return path;
}

function normalizeContextPaths(spaceRoot: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw badRequest("Chat context paths must be an array of strings.");
  const paths = [...new Set(value.map((item) => normalizeSpaceRelativePath(item)).filter(Boolean))].slice(0, 32);
  for (const path of paths) {
    try { resolveSpacePath(spaceRoot, path); } catch (error) { throw badRequest(errorMessage(error)); }
  }
  return paths;
}

async function captureTurnCheckpointSafe(
  state: LocalApiState,
  spaceId: string,
  spaceRoot: string,
  conversationId: string,
  reason: "pre_turn" | "post_turn",
): Promise<void> {
  // History is a Space concept. The management scope's root holds only
  // conversation records in app state, so turn checkpoints do not apply.
  if (spaceId === workFoldManagementScopeId) return;
  try {
    const checkpoint = await createSpaceCheckpoint(spaceRoot, {
      reason,
      label: reason === "pre_turn" ? "Before Assistant turn" : "After Assistant turn",
    });
    state.onHistoryCheckpoint?.({
      spaceId,
      conversationId,
      reason,
      checkpointId: checkpoint.checkpointId,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    });
    for (const listener of [...state.turnCheckpointListeners]) {
      try {
        listener({ spaceId, conversationId, reason, checkpointId: checkpoint.checkpointId });
      } catch {
        // Observers never affect the turn.
      }
    }
    if (checkpoint.skippedLargeFiles.length) {
      broadcast(state, streamKey(spaceId, conversationId), {
        type: "status",
        conversationId,
        message: `History skipped ${checkpoint.skippedLargeFiles.length} oversized file${checkpoint.skippedLargeFiles.length === 1 ? "" : "s"}.`,
      });
    }
  } catch (error) {
    broadcast(state, streamKey(spaceId, conversationId), {
      type: "status",
      conversationId,
      message: `History checkpoint warning: ${errorMessage(error)}`,
    });
  }
}

async function runWithHistorySafety<T>(spaceRoot: string, checkpointId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await discardSpaceCheckpoint(spaceRoot, checkpointId).catch(() => undefined);
    throw error;
  }
}

/**
 * Uploads and copy-ins only add files, so restoring to the pre-mutation state
 * means deleting exactly the written paths. The checkpoint is created after
 * the write so deleteOnRestore can name collision-renamed destinations
 * instead of intended paths that may belong to pre-existing files. Placement
 * and its restore record succeed or fail together: when the checkpoint cannot
 * be recorded, the written paths are removed again and the operation fails.
 */
async function checkpointAdditiveWritesOrUndo(
  spaceRoot: string,
  writtenPaths: string[],
  options: { reason: string; label: string },
): Promise<SpaceCheckpoint | null> {
  if (!writtenPaths.length) return null;
  try {
    return await createSpaceMutationCheckpoint(spaceRoot, { deleteOnRestore: writtenPaths, ...options });
  } catch (error) {
    await Promise.all(writtenPaths.map((path) =>
      rm(resolveSpacePath(spaceRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw httpError(500, `The added files were removed because Space could not record a restore point: ${errorMessage(error)}`);
  }
}

function normalizeSpaceRelativePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".txt": return "text/plain; charset=utf-8";
    case ".md": case ".markdown": return "text/markdown; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

const maxChatEventEntries = 512;
const maxChatEventBytes = 1024 * 1024;
const maxIdleChatEventLogs = 200;
const maxChatStreamQueuedBytes = 512 * 1024;
const turnCheckpointDelayMs = 500;

function resetChatEventTurn(state: LocalApiState, key: string): void {
  const log = chatEventLog(state, key);
  log.events = [];
  log.bytes = 0;
  log.assistantText = "";
}

function chatEventLog(state: LocalApiState, key: string): ChatEventLog {
  let log = state.chatEventLogs.get(key);
  if (log) {
    state.chatEventLogs.delete(key);
    state.chatEventLogs.set(key, log);
    return log;
  }
  while (state.chatEventLogs.size >= maxIdleChatEventLogs) {
    const removable = [...state.chatEventLogs.keys()].find((candidate) =>
      !state.runningTurns.has(candidate) && !state.chatStreams.has(candidate));
    if (!removable) break;
    state.chatEventLogs.delete(removable);
  }
  log = { nextId: 1, events: [], bytes: 0, assistantText: "" };
  state.chatEventLogs.set(key, log);
  return log;
}

function appendChatEvent(state: LocalApiState, key: string, data: unknown): ChatEventLogEntry {
  const log = chatEventLog(state, key);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const event = data as { type?: unknown; text?: unknown };
    if (event.type === "assistant_delta" && typeof event.text === "string") {
      const remaining = maxDurableTurnTextChars - log.assistantText.length;
      if (remaining > 0) log.assistantText += event.text.slice(0, remaining);
    }
    if (event.type === "assistant_message" && typeof event.text === "string") {
      log.assistantText = event.text.slice(0, maxDurableTurnTextChars);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(data));
  const entry = { id: log.nextId++, data, bytes };
  log.events.push(entry);
  log.bytes += bytes;
  while (log.events.length > maxChatEventEntries || log.bytes > maxChatEventBytes) {
    const removed = log.events.shift();
    if (!removed) break;
    log.bytes -= removed.bytes;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const type = (data as { type?: unknown }).type;
    if (type === "assistant_delta" || type === "assistant_message") scheduleTurnCheckpoint(state, key);
  }
  return entry;
}

function scheduleTurnCheckpoint(state: LocalApiState, key: string): void {
  if (!state.activeTurnIdsByKey.has(key) || state.turnCheckpointTimers.has(key)) return;
  const timer = setTimeout(() => {
    state.turnCheckpointTimers.delete(key);
    const taskId = state.activeTurnIdsByKey.get(key);
    if (!taskId) return;
    void state.turnStore.checkpoint(taskId, chatEventLog(state, key).assistantText).catch((error) => {
      console.error(`Could not persist Assistant stream checkpoint: ${errorMessage(error)}`);
    });
  }, turnCheckpointDelayMs);
  timer.unref();
  state.turnCheckpointTimers.set(key, timer);
}

async function flushTurnCheckpoint(state: LocalApiState, key: string, taskId: string): Promise<void> {
  const timer = state.turnCheckpointTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    state.turnCheckpointTimers.delete(key);
  }
  await state.turnStore.checkpoint(taskId, chatEventLog(state, key).assistantText).catch((error) => {
    console.error(`Could not flush Assistant stream checkpoint: ${errorMessage(error)}`);
    return null;
  });
}

async function flushAllTurnCheckpoints(state: LocalApiState): Promise<void> {
  await Promise.all([...state.activeTurnIdsByKey].map(([key, taskId]) => flushTurnCheckpoint(state, key, taskId)));
}

function parseSseCursor(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function writeSseEntry(response: ServerResponse, entry: ChatEventLogEntry): void {
  writeSseData(response, entry.data, entry.id);
}

function writeSseData(response: ServerResponse, data: unknown, id?: number): void {
  response.write(`${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(state: LocalApiState, key: string, event: unknown): void {
  const entry = appendChatEvent(state, key, event);
  const listeners = state.chatEventListeners.get(key);
  if (listeners) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { listeners.delete(listener); }
    }
  }
  const streams = state.chatStreams.get(key);
  if (!streams) return;
  for (const response of [...streams]) {
    try {
      if (response.writableEnded || response.destroyed || response.writableLength > maxChatStreamQueuedBytes) {
        response.end();
        streams.delete(response);
        continue;
      }
      writeSseEntry(response, entry);
    } catch {
      streams.delete(response);
    }
  }
  if (!streams.size) state.chatStreams.delete(key);
}

async function readJsonBody<T>(state: LocalApiState, req: IncomingMessage): Promise<T> {
  const bytes = await readBody(state, req);
  if (!bytes.length) return {} as T;
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw badRequest("Request body must be valid JSON."); }
}

async function readMultipartBody(state: LocalApiState, req: IncomingMessage): Promise<MultipartBody> {
  const contentType = req.headers["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw badRequest("File upload must use multipart/form-data.");
  const body = await readBody(state, req);
  const encoded = body.toString("latin1");
  const fields = new Map<string, string>();
  const files: MultipartFile[] = [];
  for (const rawPart of encoded.split(`--${boundary}`).slice(1)) {
    if (rawPart.startsWith("--")) break;
    const part = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const data = Buffer.from(part.slice(headerEnd + 4), "latin1");
    const disposition = /^content-disposition:\s*form-data;([^\r\n]+)$/im.exec(headers)?.[1] ?? "";
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const fileName = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1];
    if (fileName !== undefined) {
      files.push({
        fieldName: name,
        fileName: basename(fileName.replace(/\\/g, "/")),
        contentType: /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? "application/octet-stream",
        data,
      });
    } else {
      fields.set(name, data.toString("utf8"));
    }
  }
  return { fields, files };
}

async function readBody(state: LocalApiState, req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > state.maxBodyBytes) throw tooLarge("Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > state.maxBodyBytes) throw tooLarge("Request body is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseRelativePaths(value: string | undefined, fileCount: number): Array<string | undefined> {
  if (!value) return Array.from({ length: fileCount }, () => undefined);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
    return Array.from({ length: fileCount }, (_, index) => parsed[index] as string | undefined);
  } catch {
    throw badRequest("Upload relative paths are invalid.");
  }
}

function authorize(state: LocalApiState, req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin && !state.allowedOrigins.includes(origin)) throw forbidden("Origin is not allowed.");
  if (state.sessionToken && req.headers["x-work-fold-session"] !== state.sessionToken) throw unauthorized("Unauthorized.");
}

function setCorsHeaders(state: LocalApiState, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && state.allowedOrigins.includes(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,last-event-id,x-work-fold-session");
  res.setHeader("vary", "Origin");
  res.setHeader("x-content-type-options", "nosniff");
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const explicit = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
  const status = explicit
    ?? workFoldCliErrorStatus(error)
    ?? (error instanceof WorkFoldCheckOperationConflictError ? 409 : null)
    ?? restrictedAppErrorStatus(error)
    ?? 500;
  sendJson(res, {
    error: errorMessage(error),
    ...(error instanceof RestrictedAppError ? { code: error.code } : {}),
  }, status);
}

function workFoldCliErrorStatus(error: unknown): number | null {
  if (!(error instanceof WorkFoldCliError)) return null;
  switch (error.code) {
    case "usage":
    case "protocolError": return 400;
    case "permissionDenied": return 403;
    case "notFound": return 404;
    case "conflict": return 409;
    case "unavailable": return 503;
    case "timeout": return 504;
    case "failure": return 500;
  }
}

function restrictedAppErrorStatus(error: unknown): number | null {
  if (!(error instanceof RestrictedAppError)) return null;
  switch (error.code) {
    case "INPUT_INVALID": return 400;
    case "ACTION_UNKNOWN": return 404;
    case "NETWORK_DENIED":
    case "FILE_DENIED": return 403;
    case "AUTH_REQUIRED":
    case "AUTHORITY_STALE":
    case "REVISION_CHANGED": return 409;
    case "APP_TIMEOUT": return 504;
    case "APP_CRASHED":
    case "APP_ERROR": return 502;
    case "NETWORK_REQUEST_TOO_LARGE": return 413;
    case "NETWORK_RESPONSE_TOO_LARGE": return 502;
    case "NETWORK_FAILED":
    case "FILE_FAILED":
    case "STORAGE_FAILED":
    case "APP_UNAVAILABLE": return 503;
    case "OUTPUT_INVALID": return 500;
  }
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
function boundedOptionalId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${name} must be a string.`);
  const id = value.trim();
  if (!id || id.length > 256) throw badRequest(`${name} must be between 1 and 256 characters.`);
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(id)) {
    throw badRequest(`${name} contains unsupported control characters.`);
  }
  return id;
}

function badRequest(message: string): Error { return httpError(400, message); }
function unauthorized(message: string): Error { return httpError(401, message); }
function forbidden(message: string): Error { return httpError(403, message); }
function notFound(message: string): Error { return httpError(404, message); }
function tooLarge(message: string): Error { return httpError(413, message); }
function unavailable(message: string): Error { return httpError(503, message); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isWorkFoldCheckDecisionKind(value: unknown): value is WorkFoldCheckDecisionKind {
  return value === "accept" || value === "reject" || value === "resolve" || value === "defer";
}

function match(path: string, pattern: RegExp): string[] | null {
  const result = pattern.exec(path);
  return result ? result.map((value) => decodeURIComponent(value)) : null;
}

function streamKey(spaceId: string, conversationId: string): string { return `${spaceId}:${conversationId}`; }
function clientKey(spaceId: string, conversationId: string): string { return streamKey(spaceId, conversationId); }

function rememberSpaceRoot(state: LocalApiState, spaceId: string, rootPath: string): void {
  state.spaceIdsByRoot.set(spaceRootKey(rootPath), spaceId);
}

function spaceIdForRoot(state: LocalApiState, rootPath: string): string | null {
  return state.spaceIdsByRoot.get(spaceRootKey(rootPath)) ?? null;
}

function spaceRootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function changeTurnCount(state: LocalApiState, delta: number): void {
  state.activeTurns = Math.max(0, state.activeTurns + delta);
  try {
    state.onAgentTurnActivity?.(state.activeTurns);
  } catch {
    // Desktop power/tray integration must never be able to strand a turn in
    // the server's running set if its observer fails.
  }
}

function turnStateEvent(conversationId: string, running: boolean): { type: "turn_state"; conversationId: string; running: boolean } {
  return { type: "turn_state", conversationId, running };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolvePromise(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
