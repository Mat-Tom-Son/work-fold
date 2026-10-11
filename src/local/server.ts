import { boundedLiveTurnPresentation } from "./agent/turn-live-presentation.js";
import { createLocalEventSink, createLocalEventChannel, localEventTarget, parseLocalEventSubscriptions, type LocalEventSink } from "./local-event-stream.js";
import { localEventStreamLimits, type LocalEventEnvelope } from "../shared/local-event-stream.js";
import { createIncludedMcpSetup } from "./agent/included-mcp-setup.js";
import { prepareResourceEnable, resourceEnableAdapter } from "./agent/resource-enable-act.js";
import { listIncludedToolStatus, setupIncludedTool, shutdownIncludedToolHost, type IncludedSetupAction } from "./agent/included-tool-setup.js";
import { includedToolDefinitions, type IncludedToolId } from "../shared/included-tools.js";
import { RestrictedAppTaskService, RestrictedAppTaskError, restrictedAppTaskAuthorityDigest, restrictedAppTaskPrompt, restrictedAppTaskTurnRequestId, type RestrictedAppAssistantActivity } from "./agent/restricted-app-tasks.js";
import { RestrictedAppInferenceService, RestrictedAppInferenceError, type RestrictedAppInferenceActivity } from "./agent/restricted-app-inference.js";
import { BrowserAppActionService } from "./agent/restricted-app-browser-actions.js";
import { ModelContextInspector } from "./agent/model-context-inspector.js";
import { type NativeResourceKind } from "./agent/resource-lifecycle.js";
import { observeWorkFoldAutomationFiles } from "./automations/automation-file-observer.js";
import { isRemoteFileVisible, readRemoteFilePreview } from "./remote-file-preview.js";
import { turnFileChanges } from "./agent/turn-file-changes.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { workRequestLabel, type WorkRequestView } from "../shared/request-presentation.js";
import { childFolderPaths } from "../shared/folder-nesting.js";
import {
  automationTriggerSummary,
  type FolderAutomationState,
  type FolderAutomationsResponse,
  type FolderAutomationView,
  type AutomationTriggerView,
} from "../shared/automation-presentation.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream, existsSync, watch } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  PiConversationClient,
  isPiTurnNotRunningError,
  isPiTurnTimeoutError,
  PiTurnFailure,
  PiTurnDrainingError,
  isPiTurnCancelledError,
  type PiChatEvent,
  type PiRuntimeProvider,
} from "./agent/pi-client.js";
import { parseAssistantPresentation } from "./agent/turn-presentation.js";
import {
  maxDurableTurnTextChars,
  WorkFoldTurnReplayConflictError,
  WorkFoldTurnStore,
  type WorkFoldDurableTurnRecord,
} from "./agent/turn-store.js";
import { TurnCheckpointWriter } from "./agent/turn-checkpoint-writer.js";
import {
  RoutedPiExtensionUiBridge,
  type PiExtensionUiEvent,
  type PiExtensionUiRequest,
  type PiExtensionUiSettled,
  type PiExtensionUiScope,
  type PiExtensionUiResponse,
  validateExtensionUiResponse,
} from "./agent/extension-ui.js";
import {
  appendMessage,
  conversationNeedsGeneratedTitle,
  conversationsDir,
  createConversation,
  findRemoteConversationTitleRename,
  listConversations,
  markConversationTitleAttempted,
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
import {
  importPiSkillBundle,
  importPiSkillBundleVerified,
  piSkillBundleContentDigest,
  removePiSkill,
  type PiSkillBundleImportResult,
} from "./agent/skill-import.js";
import { normalizeWorkerInstructions } from "./agent/model-preferences.js";
import {
  RegisteredWorkFolderRuntimeProvider,
  RegisteredWorkFolderTrustAuthority,
} from "./agent/registered-work-folder-runtime.js";
import { RestrictedAppError } from "./agent/restricted-app-connections.js";
import { RestrictedAppStorageError } from "./agent/restricted-app-storage.js";
import { materializeRestrictedAppWorkingCopy } from "./agent/restricted-app-working-copy.js";
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
  type LocalAppRetainedData,
  type RestrictedAppAutomationRunReceipt,
  type RestrictedAppInstallationNeeds,
  type RestrictedAppInstalled,
} from "./agent/restricted-app-service.js";
import type { RestrictedAppNetworkDeclaration } from "./agent/restricted-app-manifest.js";
import type { RestrictedAppConnectionStatus } from "./agent/restricted-app-connections.js";
import type { RestrictedAppDataBackup } from "./agent/restricted-app-storage.js";
import {
  getPiComposerState,
  getPiWorkerInstructions,
  getPiSetupStatus,
  installPiPackage,
  isPiProjectMutationTrusted,
  listPiModelCatalogs,
  listPiModels,
  listPiPackages,
  loginPiProvider,
  removePiProviderAuth,
  removePiPackage,
  refreshPiModelCatalog,
  savePiApiKey,
  resolvePiRuntime,
  setPiDefaultModel,
  setPiDefaultThinkingLevel,
  setPiWorkerInstructions,
  updatePiPackages,
  type PiOAuthHooks,
  type PiSetupStatus,
} from "./agent/pi-runtime-config.js";
import { getAzureOpenAIConnection, saveAzureOpenAIConnection } from "./agent/azure-openai-connection.js";
import { AZURE_OPENAI_PROVIDER, normalizeAzureOpenAIConnection, type AzureOpenAIConnection } from "../shared/azure-openai.js";
import { loadConversationContextReferencesForTurn, previewConversationContextReference } from "./conversation-context.js";
import {
  classifyWorkFoldAgentAttachments,
  loadWorkFoldAgentAttachmentsForTurn,
  workFoldAgentAttachmentDispositions,
  workFoldAgentAttachmentLinks,
  maxWorkFoldAgentAttachments,
  type WorkFoldAgentAttachmentRef,
} from "./work-fold-agent-attachments.js";
import {
  WorkFoldRequestLimitError,
  WorkFoldRequestLineageError,
  isWorkFoldRequestTerminalState,
  workFoldRequestLimitMessage,
  workFoldRequestLimitsSection,
  workFoldRequestSource,
  workFoldRequestStateToAgentPhase,
  type WorkFoldRequestAction,
  type WorkFoldRequestActionCommand,
  type WorkFoldRequestAppRef,
  type WorkFoldRequestKind,
  type WorkFoldRequestLimitName,
  type WorkFoldRequestRecord,
  type WorkFoldRequestSurface,
  type WorkFoldQuestionRecord,
  type WorkFoldResultEnvelope,
} from "./requests/request-records.js";
import { WorkFoldRequestStore } from "./requests/request-store.js";
import { workFoldRequestLimits, workFoldAutomationDeclarationBounds } from "../shared/work-fold-limits.js";
import { workFolderOperationsGuideForScope } from "./agent/work-folder-operations-guide.js";
import { buildWorkFolderTurnContext, workFolderTurnHistory, workFolderTurnParentHandle, type PiWorkFolderTurnContext } from "./agent/work-folder-turn-context.js";
import type {
  WorkFoldRemoteFacade,
  WorkFoldRemoteOperation,
  WorkFoldRemotePrincipal,
  WorkFoldRemoteWatchProgress,
  WorkFoldRemoteTreeResult,
} from "./remote-work-fold-agent.js";
import {
  createWorkFolderCheckpoint,
  createWorkFolderMutationCheckpoint,
  discardWorkFolderCheckpoint,
  getWorkFolderCheckpoint,
  listWorkFolderCheckpoints,
  listWorkFolderCheckpointPage,
  listFileVersionPage,
  restoreFileVersion,
  restoreWorkFolderCheckpoint,
  previewWorkFolderCheckpointRestore,
  type WorkFolderCheckpoint,
  type WorkFolderFileVersion,
} from "./history.js";
import { compareHistoryFile, readHistoryFile } from "./history-review.js";
import { searchWorkFolder } from "./search.js";
import { WorkFolderAppearanceStore } from "./work-folder-appearance-store.js";
import { normalizeConversationTitle, normalizeGeneratedConversationTitle } from "../shared/chat-title.js";
import {
  hasWorkFolderAppearanceCustomization,
  parseWorkFolderAppearanceProposal,
  workFolderAppearanceBannerNames,
  type WorkFolderAppearanceCustomization,
  type WorkFolderAppearanceProposal,
} from "../shared/work-folder-appearance.js";
import type { AppReleasePresentation } from "./agent/app-platform-release.js";
import { WorkFoldCheckOperationConflictError, WorkFoldCheckService } from "./checks/check-service.js";
import type { WorkFoldCheckDecisionKind } from "./checks/check-types.js";
import { purgeWorkFoldCheckState } from "./checks/check-store.js";
import { resolveWorkFoldCheckTargets } from "./checks/target-resolver.js";
import {
  PreparedActError,
  PreparedActExecutor,
  prepareAct,
  type PreparedActFence,
  type PreparedAct,
  type PreparedActAdapter,
  type PreparedActAdapters,
  type PreparedActFields,
  type PreparedActKind,
} from "./prepared-acts.js";
import { removeRetiredGateState } from "./retired-gate-state.js";
import {
  createWorkFoldOverviewAutomationRunReader,
  parseWorkFoldOverviewCursor,
  workFoldOverviewChatRecordFromMessages,
  type WorkFoldOverviewAppAutomationReceiptRecord,
  type WorkFoldOverviewAppAutomationRunRecord,
  type WorkFoldOverviewCheckSource,
  type WorkFoldOverviewAgentRequestRecord,
  type WorkFoldOverviewSettledTurnRecord,
  type WorkFoldOverviewSourceReaders,
  type WorkFoldOverviewViewerGrantEventRecord,
} from "./overview.js";
import { WorkFoldOverviewSeenStore, workFoldOverviewRemoteSurfaceId } from "./overview-seen-store.js";
import { ensureWorkFoldAgentInstructions } from "./work-fold-agent-instructions.js";
import {
  WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
  WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES,
  WORKFOLD_PUBLICATION_NO_ADDRESS_MESSAGE,
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
  assertWorkFoldAutomationAtAdmissionHorizon,
  contentAddressedWorkFoldAutomationDeclaration,
  normalizeWorkFoldAutomationDeclaration,
  normalizeWorkFoldAutomationProposal,
  readWorkFoldAutomationDocument,
  workFoldAutomationBounds,
  workFoldAutomationDeclarationKind,
  workFoldAutomationDigest,
  workFoldAutomationProposalKind,
  workFoldAutomationReferencedWorkFolderIds,
  workFoldAutomationWorkFolderRoles,
  type WorkFoldAutomationDeclaration,
  type WorkFoldAutomationFilesStep,
} from "./automations/automation-declarations.js";
import {
  resolveWorkFoldAutomationProposalPath,
  scanWorkFoldAutomationProposals,
} from "./automations/automation-proposal-scan.js";
import {
  WorkFoldAutomationService,
  WorkFoldAutomationServiceError,
  type WorkFoldAutomationHopPorts,
  type WorkFoldAutomationProjection,
  type WorkFoldAutomationServiceStatus,
} from "./automations/automation-service.js";
import {
  WorkFoldAutomationStore,
  WorkFoldAutomationStoreError,
  workFoldAutomationReceiptsFile,
  workFoldAutomationReceiptsRotatedFile,
  type WorkFoldAutomationReceiptV1,
  type WorkFoldAutomationRecord,
} from "./automations/automation-store.js";
import { WorkFoldSettleSignal } from "./automations/settle-signal.js";
import {
  configureWorkFoldStateRoot,
  restrictedAppRoot,
  workFolderStateDir,
  workFoldAgentRoot,
  workFoldAgentScopeId,
  workFoldStateRoot,
  workFoldRequestsRoot,
  workFoldRecentlyDeletedRoot,
} from "./state-paths.js";
import { migrateVocabularyState } from "./vocabulary-migration.js";
import {
  WorkFoldRecentlyDeletedError,
  WorkFoldRecentlyDeletedStore,
  workFoldRecentlyDeletedEntryIdPattern,
  type WorkFoldRecentlyDeletedEntry,
  type WorkFoldRecentlyDeletedKind,
  type WorkFoldRecentlyDeletedReason,
  type WorkFoldRecentlyDeletedUncoveredPath,
} from "./recently-deleted-store.js";
import { WorkFoldKernel } from "./work-fold-kernel.js";
import {
  WORKFOLD_CLI_ACT_SURFACES,
  WorkFoldCliActReceipts,
  type WorkFoldCliActReceipt,
  type WorkFoldCliActSurface,
} from "./cli/act-receipts.js";
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
  WorkFoldActAgentRequest,
  WorkFoldActPublicationRef,
  WorkFoldActQuestionRef,
  WorkFoldActRequestDetail,
  WorkFoldActRequestRef,
  WorkFoldActRequestResult,
  WorkFoldActRequestSummary,
  WorkFoldActWaitingRef,
  WorkFoldActAutomationDetail,
  WorkFoldActAutomationReceipt,
  WorkFoldActAutomationStepView,
  WorkFoldActAutomationSummary,
  WorkFoldActAutomationTriggerRef,
  WorkFoldActWorkFolderRef,
  WorkFoldActRecentlyDeletedEntry,
  WorkFoldActTurnState,
  WorkFoldActTurnStatus,
} from "./cli/act-facade.js";
import { resolveWorkFoldCliWorkFolderSelector } from "./work-fold-cli-adapter.js";
import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
} from "./server-dev-options.js";
import { isAlwaysHiddenWorkFolderEntry, isWorkFolderIgnored, readWorkFolderIgnoreState, setWorkFolderIgnoreState } from "./work-folder-ignore.js";
import { containsReservedWorkFolderPathSegment } from "./work-folder-path-policy.js";
import { canonicalWorkFolderWatchRoot } from "./work-folder-watch.js";
import {
  beginWorkFolderRemoval,
  copyPathIntoWorkFolder,
  createManagedWorkFolder,
  createWorkFolderFolder,
  createWorkFolderTextFile,
  deleteWorkFolderEntry,
  finalizeWorkFolderRemoval,
  findExistingWorkFolderFilePaths,
  getWorkFolder,
  getWorkFolderEntryInfo,
  getWorkFolderFilePreview,
  listWorkFolders,
  listPendingWorkFolderRemovals,
  managedWorkFolderDeletionPinIssue,
  markWorkFolderRemovalAppStateRemoved,
  moveWorkFolderEntry,
  readWorkFolderTextFile,
  renameWorkFolderEntry,
  registerLinkedWorkFolder,
  registerManagedWorkFolder,
  renameWorkFolder,
  resolveWorkFolderDeleteTarget,
  resolveWorkFolderPath,
  scanWorkFolderTree,
  nestedRegisteredWorkFolderPaths,
  registeredWorkFolderOutline,
  resolveNestableFolderPath,
  workFolderRemovalPendingResult,
  touchWorkFolderRoot,
  writeWorkFolderTextFile,
  writeUploadedFiles,
  type WorkFolderRemovalIo,
  type WorkFolderRemovalResult,
  type WorkFolderSummary,
  type TreeEntry,
} from "./work-folder.js";

export interface LocalFolderGrantProvider {
  consumeLocalFolderGrant(input: { workFolderRoot: string; grantId: string }): boolean | Promise<boolean>;
}

export interface LocalApiOptions {
  host?: "127.0.0.1";
  port?: number;
  appMode?: "dev" | "desktop";
  /** Root used only for managed work-folder content. */
  workFolderBase?: string;
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
  /** Machine-local work-folder appearance state, shared by the renderer and test harnesses. */
  appearanceStore?: WorkFolderAppearanceStore;
  /** A supplied kernel must use a provider wrapped by the same spaceTrustAuthority. */
  kernel?: WorkFoldKernel;
  /** Shared with the desktop read CLI and interactive act facade. */
  checkService?: WorkFoldCheckService;
  /**
   * The one in-process settle seam between the Check and restricted-app
   * settlement funnels and the automation executor. Supply the same instance to
   * an injected checkService/restrictedAppService so their settles reach
   * automation triggers; when absent, the API creates one for the services it
   * constructs itself.
   */
  settleSignal?: WorkFoldSettleSignal;
  /**
   * The act lane's durable receipts journal (the work-fold agent's one ledger). Supply
   * the desktop CLI host's instance so decisions, publications, and CLI acts
   * share one file and one at-most-once gate; when absent, the API constructs
   * one over the same state-root path the host uses.
   */
  actReceipts?: WorkFoldCliActReceipts;
  /** Test seam for the machine-local durable agent-turn journal. */
  turnStore?: WorkFoldTurnStore;
  /** Test seam for the durable request graph (docs/collaboration-contract.md, F25). */
  requestStore?: WorkFoldRequestStore;
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
  workFolderTrustAuthority?: RegisteredWorkFolderTrustAuthority;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  /** Failure-injection seam for the durable work-folder-removal coordinator. */
  workFolderRemovalIo?: Partial<WorkFolderRemovalIo>;
  /** Test seam for the machine-local trash behind Recently deleted (docs/receipts-not-gates.md, F20). */
  recentlyDeletedStore?: WorkFoldRecentlyDeletedStore;
  /** Failure-injection seam that runs immediately before mandatory post-reservation work-folder validation. */
  beforeRestrictedAppWorkFolderRevalidation?: (workFolderId: string) => Promise<void>;
  maxBodyBytes?: number;
  loadEnv?: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  /**
   * One installation's own Worker tasks or inference receipts moved. The
   * desktop turns this into a bounded `bridge.tasks.onChanged` hint; a host
   * without app views ignores it (docs/collaboration-contract.md, F30).
   */
  onAppAssistantActivity?: (activity: RestrictedAppAssistantActivity) => void;
  /**
   * Failure-injection seam immediately before a Pi prompt starts. A work-folder
   * turn's event carries the host-composed turn context (F26) so a test can
   * observe it without a second option.
   */
  beforeAgentPrompt?: (event: { workFolderId: string; conversationId: string; taskId: string; workFolderTurn?: PiWorkFolderTurnContext }) => Promise<void>;
  /**
   * Failure-injection seam between the parent check and child acceptance of
   * a delegated `chat send`. The child is not accepted yet when it runs, so
   * a parent stop inside it refuses the child at acceptance.
   */
  beforeWorkFoldAgentActionRecord?: (event: { parentTaskId: string; command: "chat.send"; taskId: string }) => Promise<void>;
  onHistoryCheckpoint?: (event: {
    workFolderId: string;
    conversationId: string;
    reason: "pre_turn" | "post_turn";
    checkpointId: string;
    skippedLargeFiles: string[];
  }) => void;
}

export type WorkFoldAutomationSettingsOutcome =
  | "accepted"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped"
  | "lapsed";

export interface WorkFoldAutomationSettingsWorkFolderRef {
  workFolderId: string;
  workFolderName?: string;
}

export interface WorkFoldAutomationSettingsRunView {
  runId: string;
  outcome: WorkFoldAutomationSettingsOutcome;
  startedAt: string;
  finishedAt?: string;
  cause?: string;
  detail?: string;
  hops: Array<{
    hopId: string;
    kind: "chat" | "files" | "check" | "agent";
    outcome: WorkFoldAutomationSettingsOutcome;
    workFolderName?: string;
    detail?: string;
    evidence?: Array<{ label: string; value: string }>;
  }>;
}

export interface WorkFoldAutomationSettingsSummary {
  automationId: string;
  title: string;
  health: "enabled" | "disabled" | "suspended" | "completed";
  trigger: WorkFoldActAutomationTriggerRef;
  fileWatch?: import("./automations/automation-file-observer.js").WorkFoldAutomationFileWatchStatus;
  stepCount: number;
  /** Every work-folder the trigger or a step names, for the Settings work-folder filter. */
  workFolders: WorkFoldAutomationSettingsWorkFolderRef[];
  nextScheduledAt?: string;
  lastScheduledAt?: string;
  activeRun?: { runId: string; startedAt: string };
  lastRun?: Omit<WorkFoldAutomationSettingsRunView, "hops" | "cause" | "detail">;
  suspension?: { at: string; reason?: string; missingWorkFolders?: WorkFoldAutomationSettingsWorkFolderRef[] };
}

/**
 * One `*.work-fold-automation.json` file at the top level of the work-fold
 * agent's working folder that is not already a stored automation
 * (docs/automations.md, "Where automations live in the product").
 */
export type WorkFoldAutomationSettingsProposalView =
  | {
    valid: true;
    path: string;
    fileName: string;
    automationId: string;
    digest: string;
    title: string;
    trigger: WorkFoldActAutomationTriggerRef;
  }
  | { valid: false; path: string; fileName: string; problem: string };

export interface WorkFoldAutomationSettingsFacade {
  list(): Promise<{ automations: WorkFoldAutomationSettingsSummary[]; status: WorkFoldAutomationServiceStatus }>;
  proposals(): Promise<{ proposals: WorkFoldAutomationSettingsProposalView[]; truncated: boolean }>;
  /** Turns on one pending proposal by its absolute path, through the CLI's enable path. */
  enableProposal(path: string): Promise<{
    automationId: string;
    requestId: string;
    enabled: true;
    alreadyEnabled: boolean;
    automation: WorkFoldAutomationSettingsSummary;
  }>;
  show(automationId: string): Promise<{
    automation: WorkFoldAutomationSettingsSummary & {
      createdAt: string;
      workFolders: WorkFoldAutomationSettingsWorkFolderRef[];
      steps: Array<
        | { id: string; kind: "chat"; workFolder: WorkFoldAutomationSettingsWorkFolderRef; message: string }
        | {
          id: string;
          kind: "files";
          fromWorkFolder: WorkFoldAutomationSettingsWorkFolderRef;
          toWorkFolder: WorkFoldAutomationSettingsWorkFolderRef;
          to: string;
          source: ReturnType<typeof toActAutomationFilesSource>;
        }
        | { id: string; kind: "check"; workFolder: WorkFoldAutomationSettingsWorkFolderRef; checkId?: string }
        | { id: string; kind: "agent"; message: string }
      >;
      completedAt?: string;
    };
  }>;
  history(automationId: string): Promise<{ runs: WorkFoldAutomationSettingsRunView[]; truncated: boolean; damagedLineCount: number }>;
  enable(automationId: string): Promise<{ automationId: string; requestId: string; enabled: true; alreadyEnabled: boolean }>;
  run(automationId: string): Promise<{ automationId: string; requestId: string; runId: string; accepted: true }>;
  stop(automationId: string): Promise<{ automationId: string; requestId: string; runId: string; stopped: true }>;
  disable(automationId: string): Promise<{ automationId: string; requestId: string; disabled: true; stoppedRunId: string | null }>;
  delete(automationId: string): Promise<{ automationId: string; requestId: string; deleted: true }>;
  /**
   * The work-folder-owned Automations view (docs/automations.md, F15 as amended
   * 2026-09-24): the automations whose trigger or any step names this work-folder,
   * with what each does there. Served at `GET /api/work-folders/:id/automations`.
   */
  forWorkFolder(workFolderId: string): Promise<FolderAutomationsResponse>;
  /** Refuses with notFound unless the automation names this work-folder; the gate for the work-folder view's actions. */
  requireWorkFolderAutomation(workFolderId: string, automationId: string): Promise<void>;
}

export interface LocalApiHandle {
  /** Native app bridge reads and stops its own immediately dispatched requests. */
  appAssistantTasks: RestrictedAppTaskService;
  /**
   * Bounded app inference (docs/receipts-not-gates.md, F22): the desktop host
   * hands an active view's or a running worker's call here, and every call
   * appends a receipt Settings → Apps can list.
   */
  appInference: Pick<RestrictedAppInferenceService, "infer" | "list">;
  origin: string;
  port: number;
  kernel: WorkFoldKernel;
  /** In-process bounded model transport for the desktop's shared Check service. */
  reviewCheck: import("./checks/model-review-sensor.js").WorkFoldModelCheckReviewer;
  /** In-process authority for CLI act-lane commands; see cli/act-facade.ts. */
  actFacade: WorkFoldActFacade;
  /** Narrow Internet-facing semantic adapter. It never exposes the local HTTP session. */
  remoteFacade: WorkFoldRemoteFacade;
  /**
   * Validates an explicitly named work-fold agent parent while its turn is active
   * and, when that request arrived through Remote access, the approved
   * browser identity the act receipts stamp (docs/receipts-not-gates.md).
   */
  resolveWorkFoldAgentLineageParent: (taskId: string) => { taskId: string; browserId?: string; grantId?: string } | null;
  /** The durable request graph every accepted turn belongs to (docs/collaboration-contract.md, F25). */
  requests: WorkFoldRequestStore;
  /** The automation executor (docs/automations.md), for the desktop surfaces and lifecycle wiring. */
  automations: WorkFoldAutomationService;
  /**
   * Main-window Settings capability; never exposed on the remote facade. The
   * local HTTP API serves only its work-folder-scoped subset — `forWorkFolder` and the
   * enable, disable, and run of an automation that names that work-folder — at
   * `/api/work-folders/:id/automations` (docs/automations.md, F15 as amended).
   */
  automationSettings: WorkFoldAutomationSettingsFacade;
  /** The publication authority (docs/shared-pages.md rung 2); the desktop wires it as the remote viewer-page provider. */
  publications: WorkFoldPublicationService;
  /** Recently deleted: the machine-local trash every destructive verb writes to first. */
  recentlyDeleted: WorkFoldRecentlyDeletedStore;
  close: () => Promise<void>;
}

interface LocalApiState {
  browserAppActions: BrowserAppActionService;
  appAssistantTasks: RestrictedAppTaskService;
  appInference: RestrictedAppInferenceService;
  appMode: "dev" | "desktop";
  workFolderBase?: string;
  allowedOrigins: string[];
  sessionToken?: string;
  maxBodyBytes: number;
  runtimeProvider: PiRuntimeProvider;
  extensionUi: RoutedPiExtensionUiBridge;
  modelContextInspector: ModelContextInspector;
  piOAuthHooks?: PiOAuthHooks;
  capabilityRegistry: CapabilityRegistryService;
  restrictedApps: RestrictedAppService;
  restrictedAppProposals: RoutedRestrictedAppProposalHost;
  appearance: WorkFolderAppearanceStore;
  kernel: WorkFoldKernel;
  checks: WorkFoldCheckService;
  settleSignal: WorkFoldSettleSignal;
  actReceipts: WorkFoldCliActReceipts;
  turnStore: WorkFoldTurnStore;
  publications: WorkFoldPublicationService;
  /**
   * The rung-3 viewer adapter: exposure resolution for the exposure verbs'
   * effect-time recheck, and the viewer-safe serve path the publication
   * service drives.
   */
  restrictedAppViewer: RestrictedAppViewerAdapter;
  /**
   * The same key store the publication service encrypts with, held so the
   * renderer-session Settings routes can compose a share link on demand
   * (docs/shared-pages.md: the link is composed from secure settings and
   * shown transiently; it appears in no receipt, journal, log, or overview
   * item). Only the reveal route reads it; nothing else on this state may.
   */
  publicationKeys: WorkFoldPublicationKeyStore;
  overviewSeen: WorkFoldOverviewSeenStore;
  /**
   * Constructed in a second phase after the state object exists, because the
   * prepared-act fence, adapters, and automation hop ports close over this
   * state. Both are assigned before the server accepts a request.
   */
  preparedActs: PreparedActExecutor;
  automations: WorkFoldAutomationService;
  workFolderTrustAuthority: RegisteredWorkFolderTrustAuthority;
  workFoldAgentInstructionsError: string | null;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  workFolderRemovalIo: Partial<WorkFolderRemovalIo>;
  /** Recently deleted (docs/receipts-not-gates.md, F20). */
  recentlyDeleted: WorkFoldRecentlyDeletedStore;
  beforeRestrictedAppWorkFolderRevalidation?: (workFolderId: string) => Promise<void>;
  /** Every accepted turn's request record (docs/collaboration-contract.md, F25). */
  requests: WorkFoldRequestStore;
  /**
   * Turns that settled in this app run, as opposed to ones startup recovery
   * settled from the journal. A root continuation (F28) narrates only settles
   * from this set, which is what makes "a restart never starts a
   * continuation" hold without a second durable marker. Bounded.
   */
  turnsSettledThisRun: Set<string>;
  /** Serializes request-graph settle evaluations so two settles never race one continuation. */
  requestSettleChain: Promise<void>;
  /** Per-launch salt behind the opaque parent handle a delegated work-folder turn sees (F26). */
  workFolderTurnHandleSalt: string;
  chatStreams: Map<string, Set<LocalEventSink>>;
  controlStreams: Set<LocalEventSink>;
  localEventStreams: Set<LocalEventSink>;
  /** In-process subscribers riding the same publish point as the SSE streams (remote watch). */
  chatEventListeners: Map<string, Set<(event: unknown) => void>>;
  chatEventLogs: Map<string, ChatEventLog>;
  activeTurnIdsByKey: Map<string, string>;
  /** Mid-turn steering messages already appended, keyed by client key + request id, for idempotent retries. */
  steeredMessages: Map<string, ChatMessage>;
  turnCheckpointWriter: TurnCheckpointWriter;
  clients: Map<string, PiConversationClient>;
  runningTurns: Set<string>;
  activeTurnPromises: Set<Promise<void>>;
  activeTurnTasks: Map<string, { workFolderId: string; conversationId: string }>;
  cancelledTurnTasks: Set<string>;
  settledTurns: Map<string, SettledTurnRecord>;
  compactingConversations: Set<string>;
  capabilityMutations: Set<string>;
  /** Turn clients whose work-folder changed under them; rebuilt when their turn settles. */
  clientsToRefresh: Set<string>;
  checkRunReservations: Set<string>;
  workFolderIdsByRoot: Map<string, string>;
  extensionRequests: Map<string, PiExtensionUiRequest>;
  fileStreams: Map<() => void, string>;
  /** In-process observers of turn-boundary History checkpoints (automation chat hops). */
  turnCheckpointListeners: Set<(event: TurnCheckpointEvent) => void>;
  activeTurns: number;
  acceptingTurns: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  beforeAgentPrompt?: LocalApiOptions["beforeAgentPrompt"];
  beforeWorkFoldAgentActionRecord?: LocalApiOptions["beforeWorkFoldAgentActionRecord"];
  onHistoryCheckpoint?: LocalApiOptions["onHistoryCheckpoint"];
}

/**
 * Terminal outcome of one accepted turn, kept (bounded, in memory)
 * so the CLI act lane's task-scoped wait/result can distinguish this turn's
 * outcome from whatever happens to be the newest transcript message. Records
 * live for the app run; the portable transcript remains the durable record.
 */
interface SettledTurnRecord {
  taskId: string;
  workFolderId: string;
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
  turnId?: string;
  events: ChatEventLogEntry[];
  bytes: number;
  assistantText: string;
}

interface TurnCheckpointEvent {
  workFolderId: string;
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
  await migrateVocabularyState(workFoldStateRoot());
  // Recently deleted opens before anything can destroy: an interrupted work-folder
  // deletion finished by startup recovery below must reach Recently deleted rather
  // than an erase (docs/receipts-not-gates.md, F20).
  const recentlyDeleted = options.recentlyDeletedStore ?? await WorkFoldRecentlyDeletedStore.open({ rootPath: workFoldRecentlyDeletedRoot() });
  // Retention is background work, exactly as the hourly path treats it: one
  // expired work-folder entry can hold a large tree, and walking plus
  // deleting it must not sit between the process starting and the port being
  // bound. Nothing a task needs is behind this purge.
  void recentlyDeleted.purgeExpired().catch((error: unknown) => {
    console.warn(`work-fold could not clean Recently deleted at startup: ${errorMessage(error)}`);
  });
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? developmentDefaults?.port ?? numberFromEnv("WORKFOLD_LOCAL_API_PORT", 4327);
  const extensionUi = options.extensionUiBridge ?? new RoutedPiExtensionUiBridge();
  const modelContextInspector = new ModelContextInspector();
  const extensionRuntimeProvider: PiRuntimeProvider = {
    async resolveRuntime(workFolderRoot) {
      const runtime = await options.piRuntimeProvider?.resolveRuntime(workFolderRoot) ?? {};
      return {
        ...runtime,
        extensionUi,
        modelContextInspector,
      };
    },
    ...(options.piRuntimeProvider?.setPreferredModel ? {
      setPreferredModel: (workFolderRoot, model) => options.piRuntimeProvider!.setPreferredModel!(workFolderRoot, model),
    } : {}),
    ...(options.piRuntimeProvider?.getWorkerInstructions ? {
      getWorkerInstructions: (workFolderRoot) => options.piRuntimeProvider!.getWorkerInstructions!(workFolderRoot),
    } : {}),
    ...(options.piRuntimeProvider?.setWorkerInstructions ? {
      setWorkerInstructions: (workFolderRoot, instructions) => options.piRuntimeProvider!.setWorkerInstructions!(workFolderRoot, instructions),
    } : {}),
    ...(options.piRuntimeProvider?.refreshModelCatalog ? {
      refreshModelCatalog: (providerId) => options.piRuntimeProvider!.refreshModelCatalog!(providerId),
    } : {}),
    ...(options.piRuntimeProvider?.listModelCatalogs ? {
      listModelCatalogs: () => options.piRuntimeProvider!.listModelCatalogs!(),
    } : {}),
  };
  const restrictedApps = options.restrictedAppService ?? await RestrictedAppService.create({
    rootPath: restrictedAppRoot(),
    readCheckResult: async (workFolderId, checkId, digest) => checks.selectedResult(await getWorkFolder(workFolderId), checkId, digest),
    // An install binds a declared Check slot only when the work-folder has exactly one Check.
    listChecks: async (workFolderId) => (await checks.overview(await getWorkFolder(workFolderId))).checks
      .filter((item): item is typeof item & { digest: string } => typeof item.digest === "string")
      .map((item) => ({ checkId: item.id, declarationDigest: item.digest, title: item.title })),
    deferAppAutomationStart: true,
  });
  if (options.restrictedAppService?.appAutomationsStarted) {
    throw new Error(
      "The Local API requires an injected restricted App service whose automation startup is still deferred.",
    );
  }
  // propose_space_app installs the local preview inside the proposing turn's
  // own tool call. That install waits for other work-folder work instead of refusing
  // it and never stops the proposing turn's own Pi client.
  let proposalState: LocalApiState | undefined;
  const restrictedAppProposals = options.restrictedAppProposalHost ?? await RoutedRestrictedAppProposalHost.create({
    service: restrictedApps,
    registryPath: join(restrictedAppRoot(), "proposals.json"),
    installNow: async (id, context) => {
      if (!proposalState) throw new Error("work-fold is still starting.");
      const current = proposalState;
      const proposal = await current.restrictedAppProposals.get(id);
      if (proposal?.status === "installed") return current.restrictedAppProposals.install(id);
      return runRestrictedAppMutationFromTurn(current, context.workFolderId, clientKey(context.workFolderId, context.conversationId),
        () => current.restrictedAppProposals.install(id));
    },
  });
  const recoveredRemovals = await recoverPendingWorkFolderRemovals(
    restrictedApps,
    restrictedAppProposals,
    options.workFolderRemovalIo ?? {},
    recentlyDeleted,
  );
  const recoveredWorkFolderRoots = recoveredRemovals.workFolderRoots;
  const pendingWorkFolderIds = (await listPendingWorkFolderRemovals()).map((intent) => intent.workFolderId);
  const appearance = options.appearanceStore ?? await WorkFolderAppearanceStore.create({
    normalize: { allowedBannerNames: new Set(workFolderAppearanceBannerNames) },
  });
  const workFolderTrustAuthority = options.workFolderTrustAuthority
    ?? new RegisteredWorkFolderTrustAuthority((await listWorkFolders()).map((workFolder) => workFolder.workFolderRoot));
  for (const rootPath of recoveredWorkFolderRoots) workFolderTrustAuthority.revoke(rootPath);
  // The work-fold agent scope's root is app-owned state, so authorizing its
  // runtime is an application decision rather than a registration ceremony.
  // The only project configuration under it is what work-fold itself
  // materializes here: the work-fold agent's AGENTS.md context file and the
  // manage-work-folders Skill.
  workFolderTrustAuthority.grant(workFoldAgentRoot());
  let workFoldAgentInstructionsError: string | null = null;
  try {
    await ensureWorkFoldAgentInstructions();
  } catch (error) {
    workFoldAgentInstructionsError = errorMessage(error);
    console.warn(`work-fold could not materialize the work-fold agent instructions; the work-fold agent is unavailable: ${workFoldAgentInstructionsError}`);
  }
  await pruneRemoteWorkFoldAgentUploads(workFoldAgentRoot()).catch((error) => {
    console.warn(`work-fold could not prune expired remote uploads at startup: ${errorMessage(error)}`);
  });
  const runtimeProvider = new RegisteredWorkFolderRuntimeProvider(extensionRuntimeProvider, workFolderTrustAuthority);
  const kernel = options.kernel ?? new WorkFoldKernel({ runtimeProvider });
  const settleSignal = options.settleSignal ?? new WorkFoldSettleSignal();
  // Model reviews run side by side up to a provider-friendly ceiling; the rest wait their turn.
  const maxConcurrentModelReviews = 8;
  let activeModelReviews = 0;
  const waitingModelReviews: Array<() => void> = [];
  const reviewCheck: LocalApiHandle["reviewCheck"] = async (request) => {
    // A finishing review hands its slot straight to the next waiter, so the
    // count never overshoots the ceiling.
    if (activeModelReviews < maxConcurrentModelReviews) activeModelReviews += 1;
    else await new Promise<void>((resolve) => { waitingModelReviews.push(resolve); });
    try {
      request.signal.throwIfAborted();
      if (!state.acceptingTurns) throw new Error("The Check runtime is closing.");
      const client = await getClient(state, workFoldAgentScopeId, workFoldAgentRoot(), "check-review");
      return await client.reviewCheck(request);
    } finally {
      const next = waitingModelReviews.shift();
      if (next) next();
      else activeModelReviews -= 1;
    }
  };
  const checks = options.checkService ?? new WorkFoldCheckService({ kernel, settleSignal, reviewModel: reviewCheck });
  // The work-fold agent's one ledger: the same act-receipts journal the desktop CLI host
  // appends. Both instances write the identical state-root path, so prepared
  // acts and publications land in the journal the act lane already audits.
  const actReceipts = options.actReceipts ?? new WorkFoldCliActReceipts({ stateRoot: workFoldStateRoot() });
  const turnStore = options.turnStore ?? await WorkFoldTurnStore.create({ stateRoot: workFoldStateRoot() });
  // The durable request graph beside the turn journal it aggregates. It is
  // reconciled against that journal after startup recovery below.
  const requestStore = options.requestStore ?? await WorkFoldRequestStore.open({ rootPath: workFoldRequestsRoot() });
  // Gate state an older build left behind is removed unread before any
  // facade exists: a pending record there is an intent nobody confirmed
  // (docs/receipts-not-gates.md, F19).
  await removeRetiredGateState();
  const automationStore = await WorkFoldAutomationStore.create();
  const publicationKeys = options.publicationKeys ?? createEphemeralPublicationKeyStore();
  // The rung-3 viewer adapter (docs/shared-pages.md): the viewer-safe
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
    resolveWorkFolderRoot: async (workFolderId) => {
      try {
        return (await getWorkFolder(workFolderId)).workFolderRoot;
      } catch {
        return null;
      }
    },
    bridge: options.publicationBridge ?? null,
    apps: restrictedAppViewer,
  });
  const overviewSeen = new WorkFoldOverviewSeenStore();
  const state: LocalApiState = {
    browserAppActions: undefined as unknown as BrowserAppActionService,
    appAssistantTasks: undefined as unknown as RestrictedAppTaskService,
    appInference: undefined as unknown as RestrictedAppInferenceService,
    appMode,
    workFolderBase: options.workFolderBase ? resolve(options.workFolderBase) : undefined,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"],
    sessionToken: options.sessionToken,
    maxBodyBytes: options.maxBodyBytes ?? numberFromEnv("WORKFOLD_LOCAL_MAX_BODY_BYTES", 100 * 1024 * 1024),
    runtimeProvider,
    extensionUi,
    modelContextInspector,
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
    publications,
    restrictedAppViewer,
    publicationKeys,
    overviewSeen,
    // Assigned in the second construction phase below, before the server
    // listens; their fences and hop ports close over this state object.
    preparedActs: undefined as unknown as PreparedActExecutor,
    automations: undefined as unknown as WorkFoldAutomationService,
    workFolderTrustAuthority,
    workFoldAgentInstructionsError,
    localFolderGrantProvider: options.localFolderGrantProvider,
    workFolderRemovalIo: options.workFolderRemovalIo ?? {},
    recentlyDeleted,
    beforeRestrictedAppWorkFolderRevalidation: options.beforeRestrictedAppWorkFolderRevalidation,
    requests: requestStore,
    turnsSettledThisRun: new Set(),
    requestSettleChain: Promise.resolve(),
    workFolderTurnHandleSalt: randomBytes(16).toString("hex"),
    chatStreams: new Map(),
    controlStreams: new Set(),
    localEventStreams: new Set(),
    chatEventListeners: new Map(),
    chatEventLogs: new Map(),
    activeTurnIdsByKey: new Map(),
    steeredMessages: new Map(),
    turnCheckpointWriter: new TurnCheckpointWriter({
      activeTask: (key) => state.activeTurnIdsByKey.get(key),
      activeTasks: () => state.activeTurnIdsByKey,
      currentText: (key) => chatEventLog(state, key).assistantText,
      writeCheckpoint: (taskId, text) => turnStore.checkpoint(taskId, text),
      reportFailure: (error, operation) => {
        console.error(`Could not ${operation === "checkpoint" ? "persist" : "flush"} agent stream checkpoint: ${errorMessage(error)}`);
      },
    }),
    clients: new Map(),
    runningTurns: new Set(),
    activeTurnPromises: new Set(),
    activeTurnTasks: new Map(),
    cancelledTurnTasks: new Set(),
    settledTurns: new Map(),
    compactingConversations: new Set(),
    capabilityMutations: new Set(),
    clientsToRefresh: new Set(),
    checkRunReservations: new Set(),
    workFolderIdsByRoot: new Map(),
    extensionRequests: new Map(),
    fileStreams: new Map(),
    turnCheckpointListeners: new Set(),
    activeTurns: 0,
    acceptingTurns: true,
    onAgentTurnActivity: options.onAgentTurnActivity,
    beforeAgentPrompt: options.beforeAgentPrompt,
    beforeWorkFoldAgentActionRecord: options.beforeWorkFoldAgentActionRecord,
    onHistoryCheckpoint: options.onHistoryCheckpoint,
  };

  // Second construction phase: the prepared-act executor and the automation
  // executor close over the shared state (capability-mutation fences, live
  // route internals), so they are built once it exists and before the
  // server listens.
  state.preparedActs = new PreparedActExecutor({
    adapters: createPreparedActAdapters(state),
    fence: createPreparedActFence(state),
    kernel,
  });
  state.browserAppActions = await BrowserAppActionService.create({
    path: join(workFoldStateRoot(), "restricted-apps", "browser-actions.json"),
    ports: {
      withApp: (scope, operation) => restrictedApps.withBrowserActionApp(scope, async (app) => {
        await getWorkFolder(scope.workFolderId);
        if (!state.acceptingTurns) throw new Error("work-fold is closing.");
        return operation(app);
      }),
      invoke: async (scope, action, input, execution) => {
        await getWorkFolder(scope.workFolderId);
        return restrictedApps.invokeBrowserAction(scope, action, input, execution);
      },
    },
  });
  state.appAssistantTasks = await RestrictedAppTaskService.create({
    path: join(workFoldStateRoot(), "restricted-apps", "assistant-tasks.json"),
    ports: {
      withApp: (scope, operation) => restrictedApps.withAssistantTaskApp(scope, async (actions, app) => {
        await getWorkFolder(scope.workFolderId);
        if (!state.acceptingTurns) throw new RestrictedAppTaskError("TASK_UNAVAILABLE", "work-fold is closing.");
        return operation(actions, app);
      }),
      dispatch: async (receipt, app) => {
        const workFolder = await getWorkFolder(receipt.scope.workFolderId);
        await createConversation(workFolder.workFolderRoot, receipt.title, receipt.conversationId);
        await acceptConversationTurn(state, workFolder, receipt.conversationId, {
          content: restrictedAppTaskPrompt(receipt, app.title), contextPaths: [], selectedPath: null, actorKind: "system",
          requestId: restrictedAppTaskTurnRequestId(receipt), userMessageId: `message-app-${receipt.id}`,
          // An app-requested task is its own root request, owned by the app
          // installation that asked (docs/collaboration-contract.md, F25).
          request: {
            kind: "app",
            app: {
              workFolderId: receipt.scope.workFolderId,
              appId: receipt.scope.appId,
              featureInstallationId: receipt.scope.featureInstallationId,
              digest: receipt.scope.digest,
            },
          },
        });
      },
      findTurn: (receipt) => turnStore.findRequest(receipt.scope.workFolderId, receipt.conversationId, restrictedAppTaskTurnRequestId(receipt)),
      cancelTurn: async (_receipt, turnId) => { await stopWorkFoldAgentRequest(state, turnId); },
      findRequest: (receipt) => {
        const origin = turnStore.findRequest(receipt.scope.workFolderId, receipt.conversationId, restrictedAppTaskTurnRequestId(receipt));
        const request = origin ? state.requests.byTaskId(origin.turnId) : null;
        const turn = request ? turnStore.get(request.turns.at(-1)!.taskId) : null;
        if (!request || !turn) return null;
        const family = [request, ...state.requests.subtree(request.requestId)];
        return {
          state: request.state,
          taskIds: request.turns.map((item) => item.taskId),
          turn,
          usage: {
            turns: family.reduce((n, item) => n + item.usage.turns, 0),
            inputTokens: family.reduce((n, item) => n + item.usage.inputTokens, 0),
            outputTokens: family.reduce((n, item) => n + item.usage.outputTokens, 0),
            amountUsdComplete: family.every((item) => item.usage.amountUsdComplete),
            ...(family.some((item) => item.usage.amountUsd !== undefined)
              ? { amountUsd: family.reduce((n, item) => n + (item.usage.amountUsd ?? 0), 0) } : {}),
          },
        };
      },
      // The envelope the Worker filed for this task with `chat report`
      // (docs/collaboration-contract.md, F29). The request store stays the
      // authority; the newest report for the latest own turn wins, and a turn that
      // reported nothing falls back to its final reply as the summary.
      findReport: async (receipt) => {
        const turn = turnStore.findRequest(receipt.scope.workFolderId, receipt.conversationId, restrictedAppTaskTurnRequestId(receipt));
        const request = turn ? state.requests.byTaskId(turn.turnId) : null;
        const ref = [...(request?.results ?? [])].reverse().find((item) => item.taskId === request!.turns.at(-1)!.taskId);
        const read = ref ? await state.requests.result(ref.resultId) : null;
        if (!ref) return null;
        if (read?.state !== "ok") throw new RestrictedAppTaskError("TASK_UNAVAILABLE", "The selected Worker result could not be read. Try reading it again.");
        const { summary, outcome, data, files } = read.record.envelope;
        return {
          summary,
          truncated: false,
          outcome,
          ...(data === undefined ? {} : { data }),
          ...(files?.length ? { files: files.map((file) => ({ ...file })) } : {}),
        };
      },
    },
  });
  // Bounded app inference (docs/receipts-not-gates.md, F22). The transport is
  // the owning work-folder's own configured session, reached through a client whose
  // conversation is never prompted, so it stays at zero messages and re-reads
  // the work-folder's saved model whenever a capability or model change rebuilds it.
  state.appInference = await RestrictedAppInferenceService.create({
    path: join(workFoldStateRoot(), "restricted-apps", "inference-receipts.jsonl"),
    ports: {
      pin: (scope) => restrictedApps.withAssistantTaskApp(scope, async () => {
        await getWorkFolder(scope.workFolderId);
        if (!state.acceptingTurns) throw new RestrictedAppInferenceError("INFER_UNAVAILABLE", "work-fold is closing.");
      }),
      infer: async (workFolderId, request) => {
        const workFolder = await getWorkFolder(workFolderId);
        const client = await getClient(state, workFolder.id, workFolder.workFolderRoot, workFoldAppInferenceConversationId);
        return client.infer(request);
      },
    },
  });
  proposalState = state;
  // Ids only, forwarded to whatever host wants to turn owned-app activity into
  // a bounded view hint (docs/collaboration-contract.md, F30). The control hint
  // behaviour is unchanged: every change still refreshes Settings → Apps.
  const appTasksChanged = (change?: { tasks?: RestrictedAppAssistantActivity[] }) => {
    publishControlHint(state, "apps");
    for (const activity of change?.tasks ?? []) options.onAppAssistantActivity?.(activity);
  };
  state.appAssistantTasks.on("changed", appTasksChanged);
  const appInferenceChanged = (change?: RestrictedAppInferenceActivity) => {
    publishControlHint(state, "apps");
    if (!change?.terminal) return;
    options.onAppAssistantActivity?.({
      workFolderId: change.receipt.workFolderId,
      appId: change.receipt.appId,
      featureInstallationId: change.receipt.featureInstallationId,
      taskIds: [],
      receiptIds: [change.receipt.id],
    });
  };
  state.appInference.on("changed", appInferenceChanged);
  const unsubscribeAppCatalog = restrictedApps.subscribeCatalog(() => publishControlHint(state, "apps"));
  state.automations = await WorkFoldAutomationService.create({
    store: automationStore,
    ports: createAutomationHopPorts(state),
    observeFiles: observeWorkFoldAutomationFiles,
    settleSignal,
    tasks: {
      start: ({ automationId, runId }) =>
        kernel.startExperimentalAutomationRunTask({ automationId, runId, actor: { kind: "system" } }),
      finish: (taskId) => {
        kernel.finishTask(taskId);
      },
    },
  });
  // work-folder removals that finalized (or remain pending) while the app was not
  // running still revoke standing authority: suspend automations referencing the
  // removed work-folders, best-effort — the store already fails closed on damage.
  for (const workFolderId of new Set([...recoveredRemovals.workFolderIds, ...pendingWorkFolderIds])) {
    await state.automations.handleWorkFolderRemoved(workFolderId).catch(() => undefined);
  }
  // Complete interrupted publication work (key mints, bridge slot syncs);
  // with no bridge configured everything stays honestly pending.
  await publications.redriveBridgeSync().catch(() => undefined);
  kernel.configureOverview({
    sources: createServerOverviewSources(state),
    readSeen: () => overviewSeen.seenCursors(),
  });
  // History-restore fence readers (docs/act-ledger.md, conflict rule 7):
  // the kernel's routing_run tasks come from this API's own task port, and
  // this reader resolves each active run's declared files-hop targets from
  // the automation store. The restricted-app half reads the registry's durable
  // accepted-run ledger through the machine-wide accessor; a run whose
  // file-grant authority cannot be resolved (fileGrantIds null) blocks too —
  // vanished authority must never read as none while the run is live.
  kernel.configureHistoryRestoreFence({
    sources: {
      automationRunFilesHopTargets: async (automationId) => {
        const automation = await state.automations.getAutomation(automationId);
        if (!automation) return null;
        return automation.declaration.steps
          .filter((step): step is WorkFoldAutomationFilesStep => step.kind === "files")
          .map((step) => step.toWorkFolder);
      },
      appAutomationRunsWithFileGrantInto: async (workFolderId) =>
        (await state.restrictedApps.listActiveAppAutomationRuns())
          .filter((run) => run.workFolderId === workFolderId && (run.fileGrantIds === null || run.fileGrantIds.length > 0))
          .map((run) => ({ appId: run.appId, appAutomationId: run.appAutomationId, runId: run.runId })),
    },
  });
  await recoverDurableTurnState(state);
  // Strictly after turn recovery: reconciliation consumes the journal's
  // already-repaired outcomes. It settles requests; it never dispatches one.
  const reconciled = await state.requests.reconcile({ turns: state.turnStore.list() });
  if (reconciled.settled || reconciled.expired) {
    console.info(`work-fold reconciled ${reconciled.settled} request turn${reconciled.settled === 1 ? "" : "s"} against the turn journal (${reconciled.expired} ran out of time).`);
  }
  // Retention is background work, as for Recently deleted: nothing a task
  // needs sits behind it, and it never runs twice in one day.
  const retentionTasks = new Set<Promise<unknown>>();
  const trackRetention = (operation: Promise<unknown>, failure: string): void => {
    const task = operation.catch((error: unknown) => {
      console.warn(`${failure}: ${errorMessage(error)}`);
    });
    retentionTasks.add(task);
    void task.then(() => retentionTasks.delete(task));
  };
  const drainRetention = () => Promise.allSettled([...retentionTasks]);
  trackRetention(state.requests.purgeExpiredIfDue(), "work-fold could not tidy its request records at startup");

  const requestListener = (request: PiExtensionUiRequest) => routeExtensionRequest(state, request);
  const eventListener = (event: PiExtensionUiEvent) => routeExtensionEvent(state, event);
  const settledListener = (event: PiExtensionUiSettled) => {
    const request = state.extensionRequests.get(event.id);
    state.extensionRequests.delete(event.id);
    if (request) publishExtensionSnapshot(state, request);
  };
  const proposalListener = (proposal: RestrictedAppProposalReceipt) => routeRestrictedAppProposal(state, proposal);
  const proposalSettledListener = (event: RestrictedAppProposalSettled) => routeRestrictedAppProposalSettled(state, event.proposal);

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(state, request, response);
    } catch (error) {
      sendError(response, error);
    }
  });
  try {
    await listen(server, requestedPort, host);
  } catch (error) {
    await drainRetention();
    throw error;
  }
  const remoteUploadPruneTimer = setInterval(() => {
    trackRetention(pruneRemoteWorkFoldAgentUploads(workFoldAgentRoot()), "work-fold could not prune expired remote uploads");
    // Retention runs "daily while awake": the store compares its own durable
    // lastPurgeAt, so sleeping past a deadline purges within the hour and
    // never twice in one day.
    trackRetention(state.recentlyDeleted.purgeExpiredIfDue(), "work-fold could not clean Recently deleted");
    // Requests past their window close, and settled graphs older than the
    // retention window leave, on the same cadence.
    trackRetention(state.requests.expireDue().then(() => state.requests.purgeExpiredIfDue()), "work-fold could not tidy its request records");
  }, 60 * 60 * 1_000);
  remoteUploadPruneTimer.unref();
  try {
    restrictedApps.startAppAutomations(pendingWorkFolderIds);
  } catch (error) {
    clearInterval(remoteUploadPruneTimer);
    await closeServer(server).catch(() => undefined);
    await drainRetention();
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
    reviewCheck,
    appAssistantTasks: state.appAssistantTasks,
    appInference: state.appInference,
    actFacade: createWorkFoldActFacade(state),
    remoteFacade: createWorkFoldRemoteFacade(state),
    resolveWorkFoldAgentLineageParent: (taskId) => resolveWorkFoldAgentLineageParent(state, taskId),
    requests: state.requests,
    automations: state.automations,
    automationSettings: createWorkFoldAutomationSettingsFacade(state),
    publications,
    recentlyDeleted,
    close: async () => {
      state.acceptingTurns = false;
      // Withdraw the cadence before any await; already-admitted filesystem
      // cleanup remains owned until the close promise settles below.
      clearInterval(remoteUploadPruneTimer);
      state.modelContextInspector.setEnabled(false);
      await closeMcpSetups(state);
      const browserActionsClosed = state.browserAppActions.close();
      unsubscribeAppCatalog();
      state.appAssistantTasks.off("changed", appTasksChanged);
      state.appInference.off("changed", appInferenceChanged);
      for (const response of state.localEventStreams) response.close();
      for (const response of state.controlStreams) response.close();
      extensionUi.off("request", requestListener);
      extensionUi.off("event", eventListener);
      extensionUi.off("settled", settledListener);
      restrictedAppProposals.off("request", proposalListener);
      restrictedAppProposals.off("settled", proposalSettledListener);
      extensionUi.cancelAll();
      // Stop the automation executor first: it aborts active runs (they settle
      // with honest interrupted/stopped receipts through their own domains),
      // and the drained turn promises below carry any aborted chat hops to
      // their settled records.
      state.automations.close();
      for (const streams of state.chatStreams.values()) for (const response of streams) response.close();
      for (const close of [...state.fileStreams.keys()]) close();
      // A settle evaluation in flight (F28) may be accepting a continuation
      // turn this instant; let it finish so that turn is in the drained set
      // below or was refused by the flag above, never left running unseen.
      await state.requestSettleChain.catch(() => undefined);
      await Promise.allSettled([...state.clients.values()].map((client) => client.stop()));
      await Promise.allSettled([...state.activeTurnPromises]);
      await shutdownIncludedToolHost(workFoldAgentRoot(), state.runtimeProvider).catch((error) => console.warn("Computer helper shutdown:", errorMessage(error)));
      await state.requestSettleChain.catch(() => undefined);
      await flushAllTurnCheckpoints(state);
      await state.turnStore.flush();
      await state.checks.close();
      await state.appearance.flush();
      await state.appAssistantTasks.flush();
      await state.appInference.flush();
      await browserActionsClosed;
      await state.restrictedApps.close();
      await closeServer(server);
      // In particular, startup request retention may still be writing its
      // durable lastPurgeAt even when no turn has ever run.
      await drainRetention();
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

  // Trusted local diagnostics only. These routes read retained snapshots and
  // never create clients/sessions or enter the CLI/paired-browser facade.
  const contextInspectionMatch = match(url.pathname, /^\/api\/model-context(?:\/([^/]+))?$/);
  if (contextInspectionMatch && (method === "GET" || method === "POST")) {
    const workFolderId = url.searchParams.get("workFolderId");
    const conversationId = url.searchParams.get("conversationId");
    if (conversationId && !workFolderId) throw badRequest("Choose the Chat's work-folder when inspecting its context.");
    const filter = workFolderId ? {
      workFolderRoot: workFolderId === workFoldAgentScopeId ? workFoldAgentRoot() : (await getWorkFolder(workFolderId)).workFolderRoot,
      ...(conversationId ? { conversationId } : {}),
    } : undefined;
    const id = contextInspectionMatch[1];
    if (method === "GET") {
      if (id) {
        const record = state.modelContextInspector.get(id, filter);
        if (!record) throw notFound("This context capture is unavailable. It may have expired, been cleared, or belong to another Chat.");
        sendJson(res, { record });
      } else {
        sendJson(res, state.modelContextInspector.inspect(filter));
      }
      return;
    }
    if (id) throw badRequest("Context captures are read-only.");
    const body = await readJsonBody<{ enabled?: unknown; clear?: unknown }>(state, req);
    if (Object.keys(body).length !== 1) throw badRequest("Choose recording or clear captures.");
    if (typeof body.enabled === "boolean") state.modelContextInspector.setEnabled(body.enabled);
    else if (body.clear === true) state.modelContextInspector.clear();
    else throw badRequest("Specify enabled as a boolean or clear as true.");
    sendJson(res, state.modelContextInspector.inspect(filter));
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(res, { ok: true, app: "work-fold", mode: state.appMode });
    return;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const workFolders = (await state.kernel.getWorkFolders({ kind: "renderer" })).workFolders;
    const agent = workFolders[0] ? await safeAgentStatus(workFolders[0].workFolderRoot, state.runtimeProvider) : emptyAgentStatus();
    sendJson(res, { workFolders, agent, appearance: state.appearance.snapshot() });
    return;
  }

  // Which work-folder Workers are mid-turn right now, including turns no Chat tab
  // is showing (a handoff into a nested work-folder). Content-free: ids only. The
  // renderer requeries on the "activity" control hint.
  // The registered work-folders' ids, names, and roots for the @ menus: read from
  // the registry alone, with no manifest writes or setup checks, so a
  // popover can ask on every show.
  if (method === "GET" && url.pathname === "/api/work-folders/outline") {
    const workFolders = (await registeredWorkFolderOutline()).filter((workFolder) => existsSync(workFolder.workFolderRoot));
    sendJson(res, { workFolders });
    return;
  }

  if (method === "GET" && url.pathname === "/api/work-folders/activity") {
    const running = [...state.activeTurnTasks.values()]
      .filter((task) => task.workFolderId !== workFoldAgentScopeId)
      .map((task) => ({ workFolderId: task.workFolderId, conversationId: task.conversationId }));
    sendJson(res, { running });
    return;
  }

  if (method === "GET" && url.pathname === "/api/appearance") {
    sendJson(res, { appearance: state.appearance.snapshot() });
    return;
  }

  const checksStatusMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/status$/);
  if (checksStatusMatch && method === "GET") {
    const workFolder = await getWorkFolder(checksStatusMatch[1]);
    sendJson(res, { status: await state.checks.status(workFolder) });
    return;
  }

  const checksDecorationsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/decorations$/);
  if (checksDecorationsMatch && method === "GET") {
    const workFolder = await getWorkFolder(checksDecorationsMatch[1]);
    sendJson(res, { decorations: await state.checks.decorations(workFolder) });
    return;
  }

  const checksOverviewMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/overview$/);
  if (checksOverviewMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksOverviewMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const overview = await runReservedCheckOperation(
      state,
      workFolder.id,
      () => state.checks.overview(workFolder),
    );
    sendJson(res, { overview });
    return;
  }

  const checksConfigureMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/configure$/);
  if (checksConfigureMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksConfigureMatch[1]);
    const body = await readJsonBody<{ proposal?: unknown }>(state, req);
    const enabled = await runReservedCheckOperation(state, workFolder.id, () => state.checks.enable({ workFolder, proposal: body.proposal, actor: "human", proposeOnly: true }));
    sendJson(res, enabled);
    return;
  }
  const checksTrialMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/([^/]+)\/try$/);
  if (checksTrialMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksTrialMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: unknown }>(state, req);
    if (typeof body.expectedDigest !== "string") throw badRequest("Review the proposal before trying it.");
    const task = await runReservedCheckOperation(state, workFolder.id, () => state.checks.run({
      workFolder, checkId: checksTrialMatch[2], trialDigest: body.expectedDigest as string,
      actor: { kind: "renderer", cwd: workFolder.workFolderRoot, workFolderId: workFolder.id },
    }));
    sendJson(res, { task }, 202);
    return;
  }
  const checksResultMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/tasks\/([^/]+)\/result$/);
  if (checksResultMatch && method === "GET") {
    const workFolder = await getWorkFolder(checksResultMatch[1]);
    sendJson(res, { run: await state.checks.taskResult(workFolder.id, checksResultMatch[2]) });
    return;
  }
  const checksEnableMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/([^/]+)\/enable$/);
  if (checksEnableMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksEnableMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    const enabled = await runReservedCheckOperation(state, workFolder.id, () => state.checks.enable({ workFolder, checkId: checksEnableMatch[2], expectedDigest: body.expectedDigest, actor: "human" }));
    sendJson(res, enabled);
    return;
  }
  const checksDisableMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/([^/]+)\/disable$/);
  if (checksDisableMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksDisableMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const disabled = await runReservedCheckOperation(state, workFolder.id, () => state.checks.disable(workFolder, checksDisableMatch[2]));
    sendJson(res, { disabled });
    return;
  }

  const checksRunMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/run$/);
  if (checksRunMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksRunMatch[1]);
    const body = await readJsonBody<{ checkId?: string }>(state, req);
    if (body.checkId !== undefined && typeof body.checkId !== "string") throw badRequest("Check id must be a string.");
    const checkId = body.checkId?.trim();
    const accepted = await runReservedCheckOperation(state, workFolder.id, () => state.checks.run({
      workFolder: workFolder,
      ...(checkId ? { checkId } : {}),
      actor: { kind: "renderer", cwd: workFolder.workFolderRoot, workFolderId: workFolder.id },
    }));
    sendJson(res, { task: accepted }, 202);
    return;
  }

  const checksTaskMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/tasks\/([^/]+)$/);
  if (checksTaskMatch && method === "GET") {
    const workFolder = await getWorkFolder(checksTaskMatch[1]);
    sendJson(res, { task: await state.checks.taskStatus(workFolder.id, checksTaskMatch[2]) });
    return;
  }

  const checksAbortMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/tasks\/([^/]+)\/abort$/);
  if (checksAbortMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksAbortMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const aborted = await runReservedCheckOperation(
      state,
      workFolder.id,
      () => state.checks.abort(workFolder.id, checksAbortMatch[2]),
    );
    sendJson(res, { taskId: checksAbortMatch[2], aborted });
    return;
  }

  const checksCorrectionMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/corrections\/([^/]+)\/(review|apply|dismiss)$/);
  if (checksCorrectionMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksCorrectionMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const id = checksCorrectionMatch[2]!;
    if (checksCorrectionMatch[3] === "review") {
      sendJson(res, await runReservedCheckOperation(state, workFolder.id, () => state.checks.reviewCorrection(workFolder, id)));
    } else if (checksCorrectionMatch[3] === "dismiss") {
      await runReservedCheckOperation(state, workFolder.id, () => state.checks.dismissCorrection(workFolder, id));
      sendJson(res, { dismissed: true });
    } else {
      const result = await runHistoryRestore(state, workFolder.id, () => state.checks.applyCorrection(workFolder, id));
      // Applying is durable before a separate Check task starts. A provider or
      // launch error must never make the correction look unapplied or clear.
      let task: Awaited<ReturnType<WorkFoldCheckService["run"]>> | undefined;
      let rerunError: string | undefined;
      try { task = await runReservedCheckOperation(state, workFolder.id, () => state.checks.run({ workFolder, checkId: result.checkId, actor: { kind: "renderer", cwd: workFolder.workFolderRoot, workFolderId: workFolder.id } })); }
      catch (error) { rerunError = errorMessage(error); }
      sendJson(res, { ...result, task, rerunError });
    }
    return;
  }
  const checksHelpMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/findings\/([^/]+)\/help$/);
  if (checksHelpMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksHelpMatch[1]);
    const body = await readJsonBody<{ fingerprint?: string }>(state, req);
    const overview = await runReservedCheckOperation(state, workFolder.id, () => state.checks.overview(workFolder));
    const finding = overview.findings.find((item) => item.id === checksHelpMatch[2] && item.fingerprint === body.fingerprint);
    if (!finding) throw new WorkFoldCheckOperationConflictError("This finding changed or is no longer current. Refresh Checks before asking for help.");
    const nextStep = finding.evidence.some((item) => item.kind === "text-span")
      ? `Prepare a correction for review in Checks; leave the original unchanged. Read \`work-fold help checks\` for the correction format, then use \`work-fold checks problems --work-folder ${workFolder.id} --json\` and \`work-fold checks propose-fix --work-folder ${workFolder.id} --proposal <absolute-json-path> --json\`.`
      : "Explain what is needed and propose a next step. We can rerun the Check afterward.";
    const draft = `Help me review ${JSON.stringify(finding.title)} in ${JSON.stringify(finding.targetPath)}. ${nextStep}\n\nFinding reference: ${finding.id}\nFingerprint: ${finding.fingerprint}\n\n${finding.detail ?? ""}`;
    sendJson(res, { draft });
    return;
  }
  const checksDecisionMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/checks\/findings\/([^/]+)\/decision$/);
  if (checksDecisionMatch && method === "POST") {
    const workFolder = await getWorkFolder(checksDecisionMatch[1]);
    const body = await readJsonBody<{ decision?: WorkFoldCheckDecisionKind; deferUntil?: string }>(state, req);
    const decisionKind = body.decision;
    if (!isWorkFoldCheckDecisionKind(decisionKind)) throw badRequest("Choose a valid Check decision.");
    if (body.deferUntil !== undefined && typeof body.deferUntil !== "string") throw badRequest("Check deferUntil must be a timestamp.");
    const decision = await runReservedCheckOperation(state, workFolder.id, () => state.checks.decide({
      workFolderId: workFolder.id,
      findingId: checksDecisionMatch[2],
      decision: decisionKind,
      actor: "renderer",
      ...(body.deferUntil ? { deferUntil: body.deferUntil } : {}),
    }));
    sendJson(res, { findingId: checksDecisionMatch[2], decision });
    return;
  }

  if (method === "POST" && url.pathname === "/api/work-folders") {
    const body = await readJsonBody<{ name?: string }>(state, req);
    const workFolder = await runCheckWorkFolderRegistryMutation(
      state,
      () => createWorkFolderInternal(state, body.name ?? "Personal work-folder"),
    );
    sendJson(res, { workFolder }, 201);
    return;
  }

  if (method === "POST" && url.pathname === "/api/work-folders/local-folder") {
  const body = await readJsonBody<{ workFolderRoot?: string; folderGrantId?: string; providerHint?: "google-drive" }>(state, req);
    if (!body.workFolderRoot?.trim()) throw badRequest("Choose a local folder to turn into a work-folder.");
    if (state.localFolderGrantProvider) {
      if (!body.folderGrantId || !await state.localFolderGrantProvider.consumeLocalFolderGrant({ workFolderRoot: body.workFolderRoot, grantId: body.folderGrantId })) {
        throw forbidden("The folder selection expired. Choose the folder again to add it.");
      }
    } else if (state.appMode === "desktop") {
      throw forbidden("A folder must be selected in the desktop app before it can become a work-folder.");
    }
    const workFolder = await runCheckWorkFolderRegistryMutation(
      state,
      () => registerWorkFolderInternal(state, body.workFolderRoot!, body.providerHint),
    );
    sendJson(res, { workFolder }, 201);
    return;
  }

  // "Make a work-folder" (2026-10-01): a person registers a folder inside
  // a work-folder they already registered, from Files. The parent's registration
  // is the trust root for the path, so no fresh folder picker grant is asked
  // for; the explicit click is this work-folder's registration act, exactly as
  // choosing a folder in the picker is.
  const nestedFolderMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/nested-folders$/);
  if (method === "POST" && nestedFolderMatch) {
    const parent = await getWorkFolder(nestedFolderMatch[1]);
    const body = await readJsonBody<{ path?: unknown }>(state, req);
    if (typeof body.path !== "string" || !body.path.trim()) throw badRequest("Choose a folder inside this work-folder.");
    const target = await resolveNestableFolderPath(parent.workFolderRoot, body.path);
    const workFolder = await runCheckWorkFolderRegistryMutation(state, () => registerWorkFolderInternal(state, target));
    sendJson(res, { workFolder }, 201);
    return;
  }

  const workFolderMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)$/);
  if (workFolderMatch && (method === "PUT" || method === "PATCH")) {
    const body = await readJsonBody<{ name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A work-folder name is required.");
    sendJson(res, { workFolder: await renameWorkFolder(workFolderMatch[1], body.name) });
    publishControlHint(state, "work-folders");
    return;
  }
  if (workFolderMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(workFolderMatch[1]);
    // Every deletion the desktop performs leaves a receipt
    // (docs/receipts-not-gates.md): the same journal the act lane writes,
    // stamped with the main-window surface. Removing a linked registration
    // destroys nothing, so it is journaled as the unregister it is.
    const command = workFolder.location.storage === "managed" ? "work-folders.delete" : "work-folders.unregister";
    const removal = await runDesktopSettingsAct(state, command, async (requestId) => {
      const value = await removeWorkFolderRegistrationInternal(state, workFolder, { receiptId: requestId });
      return {
        value,
        detail: `work-folder ${workFolder.id}${value.recentlyDeleted ? `; trash ${value.recentlyDeleted.entryId}` : ""}`
          + (value.appRecentlyDeletedEntries.length ? `; app data ${value.appRecentlyDeletedEntries.map((item) => item.entryId).join(", ")}` : ""),
      };
    });
    sendJson(res, removal.value);
    return;
  }

  // The work-folder-owned Automations view (docs/automations.md, F15 as amended
  // 2026-09-24): a read of the automations that name this work-folder, and the same
  // Settings enable/disable/run acts — same facade, same receipts — refused
  // for an automation that does not name it.
  const spaceAutomationsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/automations$/);
  if (spaceAutomationsMatch && method === "GET") {
    const workFolder = await getWorkFolder(spaceAutomationsMatch[1]);
    sendJson(res, await createWorkFoldAutomationSettingsFacade(state).forWorkFolder(workFolder.id));
    return;
  }
  const spaceAutomationActMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/automations\/([^/]+)\/(enable|disable|run)$/);
  if (spaceAutomationActMatch && method === "POST") {
    const workFolder = await getWorkFolder(spaceAutomationActMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const automationId = spaceAutomationActMatch[2];
    const facade = createWorkFoldAutomationSettingsFacade(state);
    await facade.requireWorkFolderAutomation(workFolder.id, automationId);
    const action = spaceAutomationActMatch[3];
    sendJson(res, action === "enable"
      ? await facade.enable(automationId)
      : action === "disable"
        ? await facade.disable(automationId)
        : await facade.run(automationId));
    return;
  }

  const workFolderAppearanceMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/appearance$/);
  if (workFolderAppearanceMatch && method === "PUT") {
    const workFolder = await getWorkFolder(workFolderAppearanceMatch[1]);
    const body = await readJsonBody<{ customization?: unknown }>(state, req);
    if (!body.customization || typeof body.customization !== "object" || Array.isArray(body.customization)) {
      throw badRequest("A work-folder appearance object is required.");
    }
    const appearance = await state.appearance.replaceWorkFolder(
      workFolder.id,
      body.customization,
    );
    sendJson(res, { appearance });
    return;
  }
  if (workFolderAppearanceMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(workFolderAppearanceMatch[1]);
    sendJson(res, { appearance: await state.appearance.removeWorkFolder(workFolder.id) });
    return;
  }

  const proposalCollectionMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals$/);
  if (proposalCollectionMatch && method === "GET") {
    const workFolder = await getWorkFolder(proposalCollectionMatch[1]);
    if (!(await readConversation(workFolder.workFolderRoot, proposalCollectionMatch[2])).length) throw notFound("Conversation not found.");
    const proposals = await state.restrictedAppProposals.list({ workFolderId: workFolder.id, conversationId: proposalCollectionMatch[2] });
    sendJson(res, { proposals: proposals.map(rendererRestrictedAppProposal) });
    return;
  }
  const proposalInstallMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals\/([^/]+)\/install$/);
  if (proposalInstallMatch && method === "POST") {
    const workFolder = await getWorkFolder(proposalInstallMatch[1]);
    const proposal = await state.restrictedAppProposals.get(proposalInstallMatch[3]);
    if (!proposal || proposal.workFolderId !== workFolder.id || proposal.conversationId !== proposalInstallMatch[2]) throw notFound("App proposal not found.");
    const app = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedAppProposals.install(proposal.id));
    if (!app) throw httpError(409, "This app proposal is no longer available to install.");
    sendJson(res, { app, proposal: rendererRestrictedAppProposal((await state.restrictedAppProposals.get(proposal.id))!) }, 201);
    return;
  }
  const proposalMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals\/([^/]+)$/);
  if (proposalMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(proposalMatch[1]);
    const proposal = await state.restrictedAppProposals.get(proposalMatch[3]);
    if (!proposal || proposal.workFolderId !== workFolder.id || proposal.conversationId !== proposalMatch[2]) throw notFound("App proposal not found.");
    sendJson(res, { dismissed: await state.restrictedAppProposals.dismiss(proposal.id) });
    return;
  }

  const localAppStudioMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio$/);
  if (localAppStudioMatch && method === "GET") {
    const workFolder = await getWorkFolder(localAppStudioMatch[1]);
    sendJson(res, { studio: await state.restrictedApps.localAppStudio(workFolder.id) });
    return;
  }

  const localAppRemovalImpactMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-removal-impact$/);
  if (localAppRemovalImpactMatch && method === "GET") {
    const workFolder = await getWorkFolder(localAppRemovalImpactMatch[1]);
    sendJson(res, { impact: await state.restrictedApps.workFolderRemovalImpact(workFolder.id) });
    return;
  }
  if (localAppStudioMatch && method === "PUT") {
    const workFolder = await getWorkFolder(localAppStudioMatch[1]);
    const body = await readJsonBody<{ title?: unknown; description?: unknown; icon?: unknown }>(state, req);
    if (typeof body.title !== "string"
      || (body.description !== undefined && body.description !== null && typeof body.description !== "string")
      || (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string")) {
      throw badRequest("An App title plus optional text description and icon id are required.");
    }
    const title = body.title;
    const description = body.description === undefined ? null : body.description;
    const icon = body.icon === undefined ? null : body.icon;
    const project = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.declareLocalAppProject({
      workFolderId: workFolder.id,
      presentation: { title, description, icon },
    }));
    sendJson(res, { project });
    return;
  }

  const localAppReleasePrepareMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/releases\/prepare$/);
  if (localAppReleasePrepareMatch && method === "POST") {
    const workFolder = await getWorkFolder(localAppReleasePrepareMatch[1]);
    const body = await readJsonBody<{ displayVersion?: unknown }>(state, req);
    if (typeof body.displayVersion !== "string" || !body.displayVersion.trim()) throw badRequest("A Release version is required.");
    const displayVersion = body.displayVersion;
    const prepared = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.prepareLocalAppRelease({
      workFolderId: workFolder.id,
      displayVersion,
    }));
    sendJson(res, { release: prepared }, 201);
    return;
  }

  const localAppReleasePublishMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/releases\/publish$/);
  if (localAppReleasePublishMatch && method === "POST") {
    const workFolder = await getWorkFolder(localAppReleasePublishMatch[1]);
    const body = await readJsonBody<{ releaseDigest?: unknown }>(state, req);
    if (typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) throw badRequest("A prepared Release digest is required.");
    const releaseDigest = body.releaseDigest;
    const release = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.publishLocalAppRelease({
      workFolderId: workFolder.id,
      releaseDigest,
    }));
    sendJson(res, { release });
    return;
  }

  const localAppReleaseMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/releases\/([^/]+)$/);
  if (localAppReleaseMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(localAppReleaseMatch[1]);
    const releaseDigest = localAppReleaseMatch[2];
    const deletion = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.deleteLocalAppRelease({
      workFolderId: workFolder.id,
      releaseDigest,
    }));
    sendJson(res, { deletion });
    return;
  }

  const localAppInstallPrepareMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/installs\/prepare$/);
  if (localAppInstallPrepareMatch && method === "POST") {
    const source = await getWorkFolder(localAppInstallPrepareMatch[1]);
    const body = await readJsonBody<{ targetWorkFolderId?: unknown; releaseDigest?: unknown }>(state, req);
    if (typeof body.targetWorkFolderId !== "string" || !body.targetWorkFolderId.trim()
      || typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) {
      throw badRequest("A target work-folder and published Release are required.");
    }
    const targetWorkFolderId = body.targetWorkFolderId;
    const releaseDigest = body.releaseDigest;
    const target = await getWorkFolder(targetWorkFolderId);
    const operation = await runRestrictedAppMutations(state, [source.id, target.id], () => state.restrictedApps.prepareLocalAppInstall({
      sourceWorkFolderId: source.id,
      targetWorkFolderId: target.id,
      releaseDigest,
    }));
    sendJson(res, { operation }, 201);
    return;
  }

  const localAppOperationActivateMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/operations\/([^/]+)\/activate$/);
  if (localAppOperationActivateMatch && method === "POST") {
    const source = await getWorkFolder(localAppOperationActivateMatch[1]);
    const studio = await state.restrictedApps.localAppStudio(source.id);
    const operation = studio.operations.find((item) => item.operationId === localAppOperationActivateMatch[2]);
    if (!operation) throw notFound("Prepared App operation not found.");
    const target = await getWorkFolder(operation.targetWorkFolderId);
    const result = await runRestrictedAppMutations(state, [source.id, target.id], () => operation.kind === "install"
      ? state.restrictedApps.activateLocalAppInstall(operation.operationId)
      : state.restrictedApps.activateLocalAppUpdate(operation.operationId));
    sendJson(res, result);
    return;
  }
  const localAppOperationMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/operations\/([^/]+)$/);
  if (localAppOperationMatch && method === "DELETE") {
    const source = await getWorkFolder(localAppOperationMatch[1]);
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

  const localAppUpdatePrepareMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/instances\/([^/]+)\/updates\/prepare$/);
  if (localAppUpdatePrepareMatch && method === "POST") {
    const source = await getWorkFolder(localAppUpdatePrepareMatch[1]);
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
    const target = await getWorkFolder(instance.workFolderId);
    const operation = await runRestrictedAppMutations(state, [source.id, target.id], () => state.restrictedApps.prepareLocalAppUpdate({
      sourceWorkFolderId: source.id,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest,
      ...(continuityPolicy ? { continuityPolicy } : {}),
    }));
    sendJson(res, { operation }, 201);
    return;
  }

  const localAppInstanceMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/local-app-instances\/([^/]+)$/);
  if (localAppInstanceMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(localAppInstanceMatch[1]);
    const body = await readJsonBody<{ dataDisposition?: "retain" | "purge" }>(state, req);
    if (body.dataDisposition !== "retain" && body.dataDisposition !== "purge") {
      throw badRequest("Choose whether to retain or purge this App's local data.");
    }
    const installed = (await state.restrictedApps.list(workFolder.id)).find((app) => (
      app.runtimeInstanceKind === "app" && app.runtimeInstanceId === localAppInstanceMatch[2]
    ));
    if (!installed) throw notFound("Local App Instance not found.");
    if (body.dataDisposition === "retain") {
      const result = await runRestrictedAppMutations(state, [installed.sourceWorkFolderId, workFolder.id], () => state.restrictedApps.uninstallLocalApp({
        runtimeInstanceId: localAppInstanceMatch[2],
        dataDisposition: "retain",
      }), { requiredWorkFolderIds: [workFolder.id] });
      sendJson(res, { ...result, recentlyDeleted: [] });
      return;
    }
    // Purging carries copies of every affected namespace into Recently
    // deleted first (docs/receipts-not-gates.md, F20).
    const uninstalled = await runDesktopSettingsAct(state, "apps.uninstall", async (requestId) => (
      runRestrictedAppMutations(state, [installed.sourceWorkFolderId, workFolder.id], async () => {
        const entries = await moveUninstallPurgeExportsToRecentlyDeleted(state, localAppInstanceMatch[2], [workFolder.id, installed.sourceWorkFolderId], requestId);
        const result = await state.restrictedApps.uninstallLocalApp({
          runtimeInstanceId: localAppInstanceMatch[2],
          dataDisposition: "purge",
        });
        return {
          value: { ...result, recentlyDeleted: entries.map((entry) => ({ entryId: entry.id, restoreBy: entry.restoreBy })) },
          detail: `instance ${localAppInstanceMatch[2]}; trash ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
        };
      }, { requiredWorkFolderIds: [workFolder.id] })
    ));
    sendJson(res, uninstalled.value);
    return;
  }

  const localAppRetainedDataMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/app-studio\/retained-data\/([^/]+)$/);
  if (localAppRetainedDataMatch && method === "GET") {
    const source = await getWorkFolder(localAppRetainedDataMatch[1]);
    sendJson(res, { backup: await state.restrictedApps.exportRetainedStorage(source.id, localAppRetainedDataMatch[2]) });
    return;
  }
  if (localAppRetainedDataMatch && method === "DELETE") {
    const source = await getWorkFolder(localAppRetainedDataMatch[1]);
    const retainedDataId = localAppRetainedDataMatch[2];
    const purged = await runDesktopSettingsAct(state, "apps.retained.purge", async (requestId) => (
      runRestrictedAppMutation(state, source.id, async () => {
        const studio = await state.restrictedApps.localAppStudio(source.id);
        const record = studio.retainedData.find((item) => item.retainedDataId === retainedDataId);
        if (!record) throw notFound("Retained Local App data not found.");
        const entry = await moveRetainedExportToRecentlyDeleted(state, source.id, record, "apps.retained.purge", requestId);
        const result = await state.restrictedApps.purgeLocalAppRetainedData(retainedDataId);
        return {
          value: { ...result, recentlyDeleted: [{ entryId: entry.id, restoreBy: entry.restoreBy }] },
          detail: `retained ${retainedDataId}; trash ${entry.id}`,
        };
      })
    ));
    sendJson(res, purged.value);
    return;
  }

  const restrictedCollectionMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps$/);
  if (restrictedCollectionMatch && method === "GET") {
    const workFolder = await getWorkFolder(restrictedCollectionMatch[1]);
    sendJson(res, { apps: await state.restrictedApps.list(workFolder.id) });
    return;
  }
  if (restrictedCollectionMatch && method === "POST") {
    const workFolder = await getWorkFolder(restrictedCollectionMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; expectedDigest?: string }>(state, req);
    if (!body.sourcePath?.trim() || !body.expectedDigest?.trim()) throw badRequest("A reviewed package folder and digest are required.");
    const app = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.install({
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      sourcePath: body.sourcePath!,
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app }, 201);
    return;
  }

  const restrictedInspectMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/inspect$/);
  if (restrictedInspectMatch && method === "POST") {
    const workFolder = await getWorkFolder(restrictedInspectMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("A work-folder-relative package folder is required.");
    sendJson(res, { review: await state.restrictedApps.inspect({
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      sourcePath: body.sourcePath,
    }) });
    return;
  }

  const restrictedItemMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)$/);
  if (restrictedItemMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(restrictedItemMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req);
    // Removing a preview takes its data with it, so a copy lands in Recently
    // deleted first (docs/receipts-not-gates.md, F20) — the same
    // export-then-destroy order "Clear data" and uninstall-with-purge use, and
    // the removal leaves a receipt naming the entry.
    const outcome = await runDesktopSettingsAct(state, "apps.remove", async (requestId) => (
      runRestrictedAppMutation(state, workFolder.id, async () => {
        const entry = await moveRemovedAppStorageToRecentlyDeleted(state, workFolder.id, restrictedItemMatch[2], "apps.remove", requestId, body);
        const removed = await state.restrictedApps.remove({
          workFolderId: workFolder.id,
          appId: restrictedItemMatch[2],
          featureInstallationId: body.featureInstallationId,
          ...(body.expectedDigest ? { expectedDigest: body.expectedDigest } : {}),
        });
        return {
          value: { removed, recentlyDeleted: entry ? { entryId: entry.id, restoreBy: entry.restoreBy } : null },
          detail: `app ${restrictedItemMatch[2]}${entry ? `; trash ${entry.id}` : ""}`,
        };
      })
    ));
    sendJson(res, outcome.value);
    return;
  }

  const restrictedBuildContextMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/build-context$/);
  if (restrictedBuildContextMatch && method === "GET") {
    const workFolder = await getWorkFolder(restrictedBuildContextMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest");
    if (!expectedDigest) throw badRequest("An exact app revision is required.");
    sendJson(res, { context: await state.restrictedAppProposals.buildContext(workFolder.id, restrictedBuildContextMatch[2], expectedDigest, url.searchParams.get("featureInstallationId") ?? undefined) });
    return;
  }

  const restrictedChangeMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/change$/);
  if (restrictedChangeMatch && method === "POST") {
    const workFolder = await getWorkFolder(restrictedChangeMatch[1]);
    const body = await readJsonBody<{ requestId?: string; featureInstallationId?: string; expectedDigest?: string }>(state, req);
    if (typeof body.requestId !== "string" || typeof body.expectedDigest !== "string") throw badRequest("An exact app revision and change request are required.");
    const app = await state.restrictedApps.runtimeDescriptor(workFolder.id, restrictedChangeMatch[2], body.expectedDigest, body.featureInstallationId);
    const source = await getWorkFolder(app.sourceWorkFolderId);
    const change = await runRestrictedAppMutations(state, [workFolder.id, source.id], () => state.restrictedAppProposals.prepareChange({
      id: body.requestId!, workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, expectedDigest: body.expectedDigest!,
    }, async (receipt, files) => {
      if (receipt.sourceWorkFolderId !== source.id) throw httpError(409, "The app source changed. Refresh before starting an edit.");
      await materializeRestrictedAppWorkingCopy(source.workFolderRoot, receipt, files, (paths) => createWorkFolderMutationCheckpoint(source.workFolderRoot, {
        deleteOnRestore: paths, reason: "app-change", label: `Change ${app.manifest.title}`,
      }));
    }));
    // The Chat draft receives source/build context only, never target Instance data or authority.
    sendJson(res, { change: {
      id: change.id, sourceWorkFolderId: change.sourceWorkFolderId, sourcePath: change.sourcePath,
      appId: change.appId, title: change.title, version: change.version, baseDigest: change.baseDigest,
      buildConversationId: change.buildConversationId,
    } }, 201);
    return;
  }

  const restrictedInvokeMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/invoke$/);
  if (restrictedInvokeMatch && method === "POST") {
    const workFolder = await getWorkFolder(restrictedInvokeMatch[1]);
    assertNoCapabilityMutationForTurn(state, workFolder.id);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string; action?: string; input?: unknown }>(state, req);
    if (!body.expectedDigest?.trim() || !body.action?.trim()) throw badRequest("An installed revision and action are required.");
    assertNoCapabilityMutationForTurn(state, workFolder.id);
    const result = await state.restrictedApps.invoke({
      workFolderId: workFolder.id,
      appId: restrictedInvokeMatch[2],
      featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest,
      action: body.action,
      input: body.input,
    });
    sendJson(res, { result });
    return;
  }

  const restrictedConnectionsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/connections$/);
  if (restrictedConnectionsMatch && method === "GET") {
    const workFolder = await getWorkFolder(restrictedConnectionsMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    sendJson(res, { connections: await state.restrictedApps.connectionStatus(
      workFolder.id,
      restrictedConnectionsMatch[2],
      expectedDigest,
      url.searchParams.get("featureInstallationId") ?? undefined,
    ) });
    return;
  }

  const restrictedNetworkGrantMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/network\/([^/]+)$/);
  if (restrictedNetworkGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedNetworkGrantMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const operation = method === "PUT" ? state.restrictedApps.grantNetwork.bind(state.restrictedApps) : state.restrictedApps.revokeNetwork.bind(state.restrictedApps);
    const app = await runRestrictedAppMutation(state, workFolder.id, () => operation({
      workFolderId: workFolder.id,
      appId: restrictedNetworkGrantMatch[2],
      destinationId: restrictedNetworkGrantMatch[3],
      featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedFileGrantMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/files\/([^/]+)$/);
  if (restrictedFileGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedFileGrantMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string; root?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const app = await runRestrictedAppMutation(state, workFolder.id, () => method === "PUT"
      ? state.restrictedApps.grantFiles({
          workFolderId: workFolder.id,
          workFolderRoot: workFolder.workFolderRoot,
          appId: restrictedFileGrantMatch[2],
          permissionId: restrictedFileGrantMatch[3],
          featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
          root: body.root ?? "",
        })
      : state.restrictedApps.revokeFiles({
          workFolderId: workFolder.id,
          appId: restrictedFileGrantMatch[2],
          permissionId: restrictedFileGrantMatch[3],
          featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
        }));
    sendJson(res, { app });
    return;
  }

  // The trusted Apps tab lists an installation's requests across code changes
  // (Details, Open Chat, Stop); the app bridge stays pinned to its own revision.
  const appTaskMatch = /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/assistant-tasks(?:\/([^/]+))?(?:\/(cancel))?$/.exec(url.pathname)
    ?.map((value) => value === undefined ? "" : decodeURIComponent(value));
  if (appTaskMatch && (method === "GET" || method === "POST")) {
    const workFolder = await getWorkFolder(appTaskMatch[1]);
    const body = method === "POST" ? await readJsonBody<Record<string, unknown>>(state, req) : Object.fromEntries(url.searchParams);
    if (typeof body.featureInstallationId !== "string" || typeof body.expectedDigest !== "string") throw badRequest("An exact app installation and revision are required.");
    const allowed = ["featureInstallationId", "expectedDigest"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw badRequest("Worker request fields are invalid.");
    const app = await state.restrictedApps.runtimeDescriptor(workFolder.id, appTaskMatch[2], body.expectedDigest, body.featureInstallationId);
    const scope = { workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId,
      digest: app.digest, authorityDigest: restrictedAppTaskAuthorityDigest(app.authority) };
    if (method === "GET" && !appTaskMatch[4]) {
      sendJson(res, appTaskMatch[3] ? { detail: await state.appAssistantTasks.detail(scope, appTaskMatch[3], "installation") }
        : { tasks: await state.appAssistantTasks.list(scope, "installation", "summary") });
    } else if (method === "POST" && appTaskMatch[3] && appTaskMatch[4] === "cancel") {
      sendJson(res, { task: await state.appAssistantTasks.cancel(scope, appTaskMatch[3], () => {}, "installation") });
    } else throw badRequest("Choose an Worker request.");
    return;
  }

  // Bounded inference receipts for Settings → Apps: the installation's calls
  // across code changes, with the effective model and its usage.
  const appInferenceMatch = /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/inference-receipts$/.exec(url.pathname)
    ?.map((value) => value === undefined ? "" : decodeURIComponent(value));
  if (appInferenceMatch && method === "GET") {
    const workFolder = await getWorkFolder(appInferenceMatch[1]);
    const query = Object.fromEntries(url.searchParams);
    if (typeof query.featureInstallationId !== "string" || typeof query.expectedDigest !== "string") {
      throw badRequest("An exact app installation and revision are required.");
    }
    const allowed = ["featureInstallationId", "expectedDigest"];
    if (Object.keys(query).some((key) => !allowed.includes(key))) throw badRequest("Inference receipt fields are invalid.");
    const app = await state.restrictedApps.runtimeDescriptor(workFolder.id, appInferenceMatch[2], query.expectedDigest, query.featureInstallationId);
    const scope = { workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId,
      digest: app.digest, authorityDigest: restrictedAppTaskAuthorityDigest(app.authority) };
    sendJson(res, { receipts: await state.appInference.list(scope, { ownership: "installation" }) });
    return;
  }

  const restrictedCheckGrantMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/checks\/([^/]+)$/);
  if (restrictedCheckGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedCheckGrantMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string; checkId?: string; declarationDigest?: string }>(state, req);
    if (typeof body.featureInstallationId !== "string" || typeof body.expectedDigest !== "string") throw badRequest("An exact app installation and revision are required.");
    if (method === "PUT" && (typeof body.checkId !== "string" || typeof body.declarationDigest !== "string")) throw badRequest("Choose an exact Check revision.");
    const app = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.setCheckGrant({
      workFolderId: workFolder.id, appId: restrictedCheckGrantMatch[2], featureInstallationId: body.featureInstallationId!, expectedDigest: body.expectedDigest!,
      permissionId: restrictedCheckGrantMatch[3], selection: method === "PUT" ? { checkId: body.checkId!, declarationDigest: body.declarationDigest! } : null,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedNotificationGrantMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/notifications\/([^/]+)$/);
  if (restrictedNotificationGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedNotificationGrantMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const operation = method === "PUT"
      ? state.restrictedApps.grantNotifications.bind(state.restrictedApps)
      : state.restrictedApps.revokeNotifications.bind(state.restrictedApps);
    const app = await runRestrictedAppMutation(state, workFolder.id, () => operation({
      workFolderId: workFolder.id,
      appId: restrictedNotificationGrantMatch[2],
      permissionId: restrictedNotificationGrantMatch[3],
      featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedAppAutomationRunMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)\/run$/);
  if (restrictedAppAutomationRunMatch && method === "POST") {
    const workFolder = await getWorkFolder(restrictedAppAutomationRunMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const result = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.runAppAutomationNow({
      workFolderId: workFolder.id,
      appId: restrictedAppAutomationRunMatch[2],
      appAutomationId: restrictedAppAutomationRunMatch[3],
      featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, result);
    return;
  }

  const restrictedAppAutomationRunsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)\/runs$/);
  if (restrictedAppAutomationRunsMatch && method === "GET") {
    const workFolder = await getWorkFolder(restrictedAppAutomationRunsMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    const runs = await state.restrictedApps.listAppAutomationRuns(
      workFolder.id,
      restrictedAppAutomationRunsMatch[2],
      expectedDigest,
      restrictedAppAutomationRunsMatch[3],
      url.searchParams.get("featureInstallationId") ?? undefined,
    );
    sendJson(res, { runs });
    return;
  }

  const restrictedAppAutomationMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)$/);
  if (restrictedAppAutomationMatch && (method === "PUT" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedAppAutomationMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const app = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.setAppAutomationEnabled({
      workFolderId: workFolder.id,
      appId: restrictedAppAutomationMatch[2],
      appAutomationId: restrictedAppAutomationMatch[3],
      featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
      enabled: method === "PUT",
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedStorageMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/storage$/);
  if (restrictedStorageMatch && (method === "GET" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedStorageMatch[1]);
    const body = method === "DELETE" ? await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req) : null;
    const expectedDigest = body?.expectedDigest ?? url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    const featureInstallationId = method === "DELETE" ? body!.featureInstallationId : url.searchParams.get("featureInstallationId") ?? undefined;
    if (method !== "DELETE") {
      sendJson(res, { usage: await state.restrictedApps.storageUsage(workFolder.id, restrictedStorageMatch[2], expectedDigest, featureInstallationId) });
      return;
    }
    // A copy of the app's data lands in Recently deleted before the live data
    // goes (docs/receipts-not-gates.md, F20). The service stays the identity
    // authority: a stale installation or a changed revision is refused by its
    // own read before anything is exported or cleared.
    const cleared = await runDesktopSettingsAct(state, "apps.storage.clear", async (requestId) => (
      runRestrictedAppMutation(state, workFolder.id, async () => {
        const app = await requireInstalledAppForStorage(state, workFolder.id, restrictedStorageMatch[2], expectedDigest, featureInstallationId);
        const entry = await moveAppStorageExportToRecentlyDeleted(state, app, "apps.storage.clear", requestId);
        const usage = await state.restrictedApps.clearStorage(workFolder.id, restrictedStorageMatch[2], expectedDigest, featureInstallationId);
        return {
          value: { usage, recentlyDeleted: entry ? { entryId: entry.id, restoreBy: entry.restoreBy } : null },
          detail: `app ${app.manifest.id}${entry ? `; trash ${entry.id}` : ""}`,
        };
      })
    ));
    sendJson(res, cleared.value);
    return;
  }

  const restrictedDataMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/storage\/(export|recovery|restore)$/);
  if (restrictedDataMatch && ((method === "GET" && restrictedDataMatch[3] !== "restore") || (method === "POST" && restrictedDataMatch[3] === "restore"))) {
    const workFolder = await getWorkFolder(restrictedDataMatch[1]);
    const appId = restrictedDataMatch[2];
    if (method === "POST") {
      const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest: string; expectedRevision: number; backup?: unknown; recoveryId?: string }>(state, req, 6 * 1024 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("A backup or recovery point is required.");
      const usage = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.restoreStorage({
        workFolderId: workFolder.id, appId, featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest, expectedRevision: body.expectedRevision,
        backup: body.backup, recoveryId: body.recoveryId,
      }));
      sendJson(res, { usage });
    } else {
      const digest = url.searchParams.get("expectedDigest") ?? "";
      sendJson(res, restrictedDataMatch[3] === "export"
        ? { backup: await state.restrictedApps.exportStorage(workFolder.id, appId, digest, url.searchParams.get("featureInstallationId") ?? undefined) }
        : { recovery: await state.restrictedApps.storageRecovery(workFolder.id, appId, digest, url.searchParams.get("featureInstallationId") ?? undefined) });
    }
    return;
  }

  const restrictedOAuthMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/connections\/([^/]+)\/oauth$/);
  if (restrictedOAuthMatch && method === "POST") {
    const workFolder = await getWorkFolder(restrictedOAuthMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const connection = await runRestrictedAppMutation(state, workFolder.id, () => state.restrictedApps.connectOAuth({
      workFolderId: workFolder.id,
      appId: restrictedOAuthMatch[2],
      destinationId: restrictedOAuthMatch[3],
      featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { connection });
    return;
  }

  const restrictedConnectionMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/restricted-apps\/([^/]+)\/connections\/([^/]+)$/);
  if (restrictedConnectionMatch && (method === "PUT" || method === "DELETE")) {
    const workFolder = await getWorkFolder(restrictedConnectionMatch[1]);
    const body = await readJsonBody<{ featureInstallationId?: string; expectedDigest?: string; credential?: unknown }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const result = await runRestrictedAppMutation(state, workFolder.id, async () => {
      if (method === "DELETE") {
        return { removed: await state.restrictedApps.deleteConnection({
          workFolderId: workFolder.id,
          appId: restrictedConnectionMatch[2],
          destinationId: restrictedConnectionMatch[3],
          featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
        }) };
      }
      return { connection: await state.restrictedApps.setConnection({
        workFolderId: workFolder.id,
        appId: restrictedConnectionMatch[2],
        destinationId: restrictedConnectionMatch[3],
        featureInstallationId: body.featureInstallationId, expectedDigest: body.expectedDigest!,
        credential: body.credential,
      }) };
    });
    sendJson(res, result);
    return;
  }

  const searchMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/search$/);
  if (method === "GET" && searchMatch) {
    const workFolder = await getWorkFolder(searchMatch[1]);
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "files" && scope !== "chats") throw badRequest("Search scope is unsupported.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const result = await searchWorkFolder(workFolder.workFolderRoot, url.searchParams.get("q") ?? "", {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        signal: controller.signal,
        path: url.searchParams.get("path") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        maxMatches: optionalBoundedInteger(url.searchParams.get("limit"), "limit"),
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

  const treeMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/tree$/);
  if (method === "GET" && treeMatch) {
    const workFolder = await getWorkFolder(treeMatch[1]);
    const maxDepthValue = Number(url.searchParams.get("maxDepth") ?? 20);
    const maxDepth = Number.isFinite(maxDepthValue) ? Math.min(Math.max(Math.floor(maxDepthValue), 0), 50) : 20;
    const scan = await scanWorkFolderTree(
      workFolder.workFolderRoot,
      maxDepth,
      url.searchParams.get("path") ?? "",
      { includeIgnored: url.searchParams.get("includeIgnored") !== "0", nestedFolderPaths: await nestedRegisteredWorkFolderPaths(workFolder.workFolderRoot) },
    );
    sendJson(res, { tree: scan.entries, truncated: scan.truncated });
    return;
  }

  const fileMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/file$/);
  if (method === "GET" && fileMatch) {
    const workFolder = await getWorkFolder(fileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    sendJson(res, await readWorkFolderTextFile(workFolder.workFolderRoot, path));
    return;
  }
  if (method === "PUT" && fileMatch) {
    const workFolder = await getWorkFolder(fileMatch[1]);
    const body = await readJsonBody<{ path?: string; text?: string }>(state, req);
    if (!body.path?.trim() || typeof body.text !== "string") throw badRequest("A file path and text are required.");
    const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
      paths: [body.path],
      reason: "pre_edit",
      label: `Before editing ${body.path}`,
    });
    const file = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => writeWorkFolderTextFile(workFolder.workFolderRoot, body.path!, body.text!));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const fileInfoMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/file-info$/);
  if (method === "GET" && fileInfoMatch) {
    const workFolder = await getWorkFolder(fileInfoMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("work-folder item path is required.");
    sendJson(res, await getWorkFolderEntryInfo(workFolder.workFolderRoot, path));
    return;
  }

  const filePreviewMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/file-preview$/);
  if (method === "GET" && filePreviewMatch) {
    const workFolder = await getWorkFolder(filePreviewMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("work-folder item path is required.");
    sendJson(res, { preview: await getWorkFolderFilePreview(workFolder.workFolderRoot, path) });
    return;
  }

  const pathsExistMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/paths-exist$/);
  if (method === "POST" && pathsExistMatch) {
    const workFolder = await getWorkFolder(pathsExistMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) {
      throw badRequest("work-folder paths must be an array of strings.");
    }
    sendJson(res, { existing: await findExistingWorkFolderFilePaths(workFolder.workFolderRoot, body.paths) });
    return;
  }

  const rawFileMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/raw-file$/);
  if (method === "GET" && rawFileMatch) {
    const workFolder = await getWorkFolder(rawFileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    await sendWorkFolderRawFile(res, workFolder.workFolderRoot, path);
    return;
  }

  const moveMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/move-local-entry$/);
  if (method === "POST" && moveMatch) {
    const workFolder = await getWorkFolder(moveMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; targetFolderPath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("Select a file or folder to move.");
    const moveSource = normalizeWorkFolderRelativePath(body.sourcePath);
    const moveTargetFolder = normalizeWorkFolderRelativePath(body.targetFolderPath ?? "");
    const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
    const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
      movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
      reason: "pre_move",
      label: `Before moving ${body.sourcePath}`,
    });
    const moved = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => moveWorkFolderEntry(workFolder.workFolderRoot, {
      sourcePath: moveSource,
      targetFolderPath: body.targetFolderPath ?? "",
    }));
    sendJson(res, { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const renameMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/rename-local-entry$/);
  if (method === "POST" && renameMatch) {
    const workFolder = await getWorkFolder(renameMatch[1]);
    const body = await readJsonBody<{ path?: string; newName?: string }>(state, req);
    if (!body.path?.trim() || !body.newName?.trim()) throw badRequest("A work-folder item and new name are required.");
    const renameSource = normalizeWorkFolderRelativePath(body.path);
    const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
    const renameDestination = [renameParent, body.newName].filter(Boolean).join("/");
    const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
      movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
      reason: "pre_rename",
      label: `Before renaming ${body.path}`,
    });
    const renamed = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => renameWorkFolderEntry(workFolder.workFolderRoot, { path: body.path!, newName: body.newName! }));
    sendJson(res, { renamed, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const foldersMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/folders$/);
  if (method === "POST" && foldersMatch) {
    const workFolder = await getWorkFolder(foldersMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A folder name is required.");
    const folderTarget = [normalizeWorkFolderRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
      deleteOnRestore: [folderTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const folder = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => createWorkFolderFolder(workFolder.workFolderRoot, body.parentPath ?? "", body.name!));
    sendJson(res, { folder, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const filesMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/files$/);
  if (method === "POST" && filesMatch) {
    const workFolder = await getWorkFolder(filesMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string; text?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A file name is required.");
    const fileTarget = [normalizeWorkFolderRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
      deleteOnRestore: [fileTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const file = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => createWorkFolderTextFile(workFolder.workFolderRoot, body.parentPath ?? "", body.name!, body.text ?? ""));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const deleteMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/local-file$/);
  if (method === "DELETE" && deleteMatch) {
    const workFolder = await getWorkFolder(deleteMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("Select a file or folder to delete.");
    // Every deletion the desktop performs leaves a receipt, and a delete
    // History cannot fully keep a copy of lands in Recently deleted rather
    // than being refused (docs/receipts-not-gates.md, F20).
    const removal = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
      const value = await deleteWorkFolderEntryWithRecovery(state, workFolder, body.path!, { receiptId: requestId });
      return {
        value,
        detail: value.recovery.kind === "recently-deleted"
          ? `work-folder ${workFolder.id}; trash ${value.recovery.entryId}`
          : `work-folder ${workFolder.id}; checkpoint ${value.safetyCheckpointId}`,
      };
    });
    const { recovery, ...deleted } = removal.value;
    sendJson(res, {
      ...deleted,
      historySkippedPaths: recovery.kind === "recently-deleted" ? recovery.uncovered.map((file) => file.path) : [],
      ...(recovery.kind === "recently-deleted"
        ? { recentlyDeleted: { entryId: recovery.entryId, restoreBy: recovery.restoreBy, uncoveredCount: recovery.uncovered.length } }
        : {}),
    });
    return;
  }

  const ignoreMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/ignore-paths$/);
  if (method === "GET" && ignoreMatch) {
    const workFolder = await getWorkFolder(ignoreMatch[1]);
    sendJson(res, await readWorkFolderIgnoreState(workFolder.workFolderRoot));
    return;
  }
  if (method === "POST" && ignoreMatch) {
    const workFolder = await getWorkFolder(ignoreMatch[1]);
    const body = await readJsonBody<{ paths?: unknown; ignored?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || typeof body.ignored !== "boolean") {
      throw badRequest("work-folder paths and an ignore decision are required.");
    }
    sendJson(res, await setWorkFolderIgnoreState(workFolder.workFolderRoot, body.paths, body.ignored));
    return;
  }

  const fileEventsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/file-events$/);
  if (method === "GET" && fileEventsMatch) {
    const workFolder = await getWorkFolder(fileEventsMatch[1]);
    await openWorkFolderFileStream(state, createLocalEventSink(res), workFolder.workFolderRoot, fileEventsMatch[1]);
    return;
  }

  const uploadMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/upload-local-files$/);
  if (method === "POST" && uploadMatch) {
    const workFolder = await getWorkFolder(uploadMatch[1]);
    const multipart = await readMultipartBody(state, req);
    const relativePaths = parseRelativePaths(multipart.fields.get("relativePaths"), multipart.files.length);
    const uploaded = await writeUploadedFiles(
      workFolder.workFolderRoot,
      multipart.fields.get("targetFolderPath") ?? "",
      multipart.files.map((file, index) => ({ fileName: file.fileName, relativePath: relativePaths[index], data: file.data })),
    );
    const safety = await checkpointAdditiveWritesOrUndo(workFolder.workFolderRoot, uploaded.map((file) => file.path), {
      reason: "pre_upload",
      label: `Before uploading ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`,
    });
    sendJson(res, { uploaded, safetyCheckpointId: safety?.checkpointId ?? null, historySkippedPaths: safety?.skippedLargeFiles ?? [] }, 201);
    return;
  }

  const checkpointCollectionMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/history\/checkpoints$/);
  if (checkpointCollectionMatch && method === "GET") {
    const workFolder = await getWorkFolder(checkpointCollectionMatch[1]);
    sendJson(res, await listWorkFolderCheckpointPage(workFolder.workFolderRoot, { cursor: url.searchParams.get("cursor") ?? undefined, limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit") }));
    return;
  }
  if (checkpointCollectionMatch && method === "POST") {
    const workFolder = await getWorkFolder(checkpointCollectionMatch[1]);
    const body = await readJsonBody<{ label?: string }>(state, req);
    const existingIds = new Set((await listWorkFolderCheckpoints(workFolder.workFolderRoot, 1000)).map((checkpoint) => checkpoint.checkpointId));
    const checkpoint = await createWorkFolderCheckpoint(workFolder.workFolderRoot, { label: body.label, reason: "manual" });
    const created = !existingIds.has(checkpoint.checkpointId);
    sendJson(res, { checkpoint, created }, created ? 201 : 200);
    return;
  }
  const checkpointRestoreMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/history\/checkpoints\/([^/]+)\/restore$/);
  if (method === "POST" && checkpointRestoreMatch) {
    const workFolder = await getWorkFolder(checkpointRestoreMatch[1]);
    sendJson(res, await runHistoryRestore(state, workFolder.id, () => restoreWorkFolderCheckpoint(workFolder.workFolderRoot, checkpointRestoreMatch[2])));
    return;
  }

  const checkpointPreviewMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/history\/checkpoints\/([^/]+)\/preview$/);
  if (method === "GET" && checkpointPreviewMatch) {
    const workFolder = await getWorkFolder(checkpointPreviewMatch[1]);
    sendJson(res, { preview: await previewWorkFolderCheckpointRestore(workFolder.workFolderRoot, checkpointPreviewMatch[2]) });
    return;
  }

  const historyReviewMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/history\/(read|diff)$/);
  if (method === "GET" && historyReviewMatch) {
    const workFolder = await getWorkFolder(historyReviewMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A work-folder-relative file path is required.");
    if (historyReviewMatch[2] === "read") {
      const checkpointId = url.searchParams.get("checkpointId")?.trim();
      if (!checkpointId) throw badRequest("A checkpointId is required.");
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort); res.once("close", abort);
      try {
        const review = await readHistoryFile(workFolder.workFolderRoot, {
          path, checkpointId, signal: controller.signal,
          offsetBytes: optionalBoundedInteger(url.searchParams.get("offsetBytes"), "offsetBytes"),
          lengthBytes: optionalBoundedInteger(url.searchParams.get("lengthBytes"), "lengthBytes"),
          expectedSha256: url.searchParams.get("expectedSha256") ?? undefined,
        });
        if (!controller.signal.aborted && !res.destroyed) sendJson(res, { review });
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { req.off("aborted", abort); res.off("close", abort); }
    } else {
      const fromCheckpointId = url.searchParams.get("fromCheckpointId")?.trim();
      if (!fromCheckpointId) throw badRequest("A fromCheckpointId is required.");
      const toCheckpointId = url.searchParams.get("toCheckpointId")?.trim();
      sendJson(res, { comparison: await compareHistoryFile(workFolder.workFolderRoot, {
        path, fromCheckpointId, ...(toCheckpointId ? { toCheckpointId } : {}),
      }) });
    }
    return;
  }

  const fileVersionsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/history\/file-versions$/);
  if (method === "GET" && fileVersionsMatch) {
    const workFolder = await getWorkFolder(fileVersionsMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A work-folder-relative file path is required.");
    sendJson(res, { path, ...await listFileVersionPage(workFolder.workFolderRoot, path, { cursor: url.searchParams.get("cursor") ?? undefined, limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit") }) });
    return;
  }
  if (method === "POST" && fileVersionsMatch) {
    const workFolder = await getWorkFolder(fileVersionsMatch[1]);
    const body = await readJsonBody<{ path?: string; hashSha256?: string }>(state, req);
    if (!body.path?.trim() || !body.hashSha256?.trim()) throw badRequest("A file path and version hash are required.");
    sendJson(res, { result: await runHistoryRestore(state, workFolder.id, () => restoreFileVersion(workFolder.workFolderRoot, body.path!, body.hashSha256!)) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/agent/models") {
    const workFolderId = url.searchParams.get("workFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), workFolderId);
    const models = await listPiModels(scope.workFolderRoot, state.runtimeProvider);
    const status = await getPiSetupStatus(scope.workFolderRoot, state.runtimeProvider);
    sendJson(res, {
      models: models.map((model) => ({
        ...model,
        oauthSupported: model.oauthSupported && Boolean(state.piOAuthHooks),
      })),
      status: normalizeStatus(status),
      providers: providerSetupResponse(status, Boolean(state.piOAuthHooks)),
      catalogs: await listPiModelCatalogs(state.runtimeProvider),
      azure: await getAzureOpenAIConnection(scope.workFolderRoot, state.runtimeProvider),
      instructions: scope.id === workFoldAgentScopeId
        ? null
        : await getPiWorkerInstructions(scope.workFolderRoot, state.runtimeProvider),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/models/refresh") {
    const body = await readJsonBody<{ workFolderId?: string; scope?: string; provider?: string }>(state, req);
    const scope = await modelScope(body.scope, body.workFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    const refresh = await refreshPiModelCatalog(body.provider, state.runtimeProvider);
    sendJson(res, {
      refresh,
      models: await listPiModels(scope.workFolderRoot, state.runtimeProvider),
      status: normalizeStatus(await getPiSetupStatus(scope.workFolderRoot, state.runtimeProvider)),
      catalogs: await listPiModelCatalogs(state.runtimeProvider),
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/status") {
    const workFolderId = url.searchParams.get("workFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), workFolderId);
    sendJson(res, { status: await safeAgentStatus(scope.workFolderRoot, state.runtimeProvider) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/composer") {
    const workFolderId = url.searchParams.get("workFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), workFolderId);
    sendJson(res, { composer: await getPiComposerState(scope.workFolderRoot, state.runtimeProvider) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/instructions") {
    const body = await readJsonBody<{ workFolderId?: string; scope?: string; instructions?: unknown }>(state, req);
    const scope = await modelScope(body.scope, body.workFolderId);
    if (scope.id === workFoldAgentScopeId) throw badRequest("Worker instructions require a work-folder.");
    if (typeof body.instructions !== "string") throw badRequest("Worker instructions must be text.");
    let instructions: string;
    try {
      instructions = normalizeWorkerInstructions(body.instructions);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    await runCapabilityMutation(
      state,
      scope,
      "project",
      () => setPiWorkerInstructions(scope.workFolderRoot, instructions, state.runtimeProvider),
      { requireProjectTrust: false },
    );
    sendJson(res, { instructions });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/thinking") {
    const body = await readJsonBody<{ workFolderId?: string; scope?: string; level?: unknown }>(state, req);
    const scope = await modelScope(body.scope, body.workFolderId);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    try {
      sendJson(res, { composer: await setPiDefaultThinkingLevel(scope.workFolderRoot, body.level, state.runtimeProvider) });
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/configure") {
    const body = await readJsonBody<{ workFolderId?: string; scope?: string; provider?: string; model?: string; apiKey?: string; azure?: unknown }>(state, req);
    const scope = await modelScope(body.scope, body.workFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    if (!body.model?.trim() && !body.apiKey?.trim() && body.azure === undefined) throw badRequest("A model or API key is required.");
    let azure: AzureOpenAIConnection | undefined;
    if (body.azure !== undefined) {
      if (body.provider !== AZURE_OPENAI_PROVIDER) throw badRequest("Azure settings require the Azure OpenAI provider.");
      try { azure = normalizeAzureOpenAIConnection(body.azure); } catch (error) { throw badRequest(errorMessage(error)); }
    }
    const available = await listPiModels(scope.workFolderRoot, state.runtimeProvider);
    const selected = available.find((model) => model.provider === body.provider && model.id === body.model);
    if (azure) {
      if (body.model && !azure.deployments.includes(body.model)) throw badRequest("Choose one of the Azure deployment names you entered.");
    } else if (body.model && !selected) throw badRequest(`The selected Pi model is not available for ${scope.label}.`);
    const providerAuth = azure
      ? available.some((model) => model.provider === body.provider && model.authConfigured)
      : selected?.authConfigured;
    if (!body.apiKey?.trim() && !providerAuth) {
      throw badRequest(`Enter an API key for ${selected?.providerName ?? "Azure OpenAI"}.`);
    }
    await runCapabilityMutation(state, scope, "global", async () => {
      if (azure) {
        await saveAzureOpenAIConnection(scope.workFolderRoot, azure, body.apiKey, state.runtimeProvider);
      } else if (body.apiKey?.trim()) {
        await savePiApiKey(scope.workFolderRoot, body.provider!, body.apiKey, { runtimeProvider: state.runtimeProvider });
      }
      if (body.model) await setPiDefaultModel(scope.workFolderRoot, { provider: body.provider!, id: body.model }, state.runtimeProvider);
    }, { requireProjectTrust: false });
    const status = await getPiSetupStatus(scope.workFolderRoot, state.runtimeProvider);
    sendJson(res, {
      status: normalizeStatus(status),
      providers: providerSetupResponse(status, Boolean(state.piOAuthHooks)),
      models: (await listPiModels(scope.workFolderRoot, state.runtimeProvider)).map((model) => ({
        ...model, oauthSupported: model.oauthSupported && Boolean(state.piOAuthHooks),
      })),
      ...(azure ? { azure: await getAzureOpenAIConnection(scope.workFolderRoot, state.runtimeProvider) } : {}),
    });
    return;
  }
  if (method === "DELETE" && url.pathname === "/api/agent/auth") {
    const body = await readJsonBody<{ workFolderId?: string; scope?: string; provider?: string }>(state, req);
    const scope = await modelScope(body.scope, body.workFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    await runCapabilityMutation(state, scope, "global", async () => {
      await removePiProviderAuth(scope.workFolderRoot, body.provider!, state.runtimeProvider);
    }, { requireProjectTrust: false });
    const status = await getPiSetupStatus(scope.workFolderRoot, state.runtimeProvider);
    sendJson(res, {
      models: await listPiModels(scope.workFolderRoot, state.runtimeProvider),
      status: normalizeStatus(status),
      providers: providerSetupResponse(status, Boolean(state.piOAuthHooks)),
      ...(body.provider === AZURE_OPENAI_PROVIDER ? { azure: await getAzureOpenAIConnection(scope.workFolderRoot, state.runtimeProvider) } : {}),
    });
    return;
  }
  if (method === "POST" && ["/api/agent/oauth", "/api/agent/login"].includes(url.pathname)) {
    if (!state.piOAuthHooks) throw unavailable("Guided provider setup requires the work-fold desktop app.");
    const body = await readJsonBody<{ workFolderId?: string; scope?: string; provider?: string; model?: string; method?: string }>(state, req);
    const scope = await modelScope(body.scope, body.workFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    const authMethod = url.pathname === "/api/agent/oauth" ? "oauth" : body.method;
    if (authMethod !== "oauth" && authMethod !== "api_key") throw badRequest("Choose account sign-in or API-key setup.");
    if (body.model && !(await listPiModels(scope.workFolderRoot, state.runtimeProvider)).some((item) => item.provider === body.provider && item.id === body.model)) {
      throw badRequest(`The selected Pi model is not available for ${scope.label}.`);
    }
    await runCapabilityMutation(state, scope, "global", async () => {
      await loginPiProvider(scope.workFolderRoot, body.provider!, authMethod, state.piOAuthHooks!, state.runtimeProvider);
      if (body.model) await setPiDefaultModel(scope.workFolderRoot, { provider: body.provider!, id: body.model }, state.runtimeProvider);
    }, { requireProjectTrust: false });
    const status = await getPiSetupStatus(scope.workFolderRoot, state.runtimeProvider);
    sendJson(res, {
      status: normalizeStatus(status), providers: providerSetupResponse(status, true),
      models: await listPiModels(scope.workFolderRoot, state.runtimeProvider),
    });
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
    const body = await readJsonBody<{ workFolderId?: string; id?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workFolderId || !body.id?.trim()) throw badRequest("A work-folder and capability are required.");
    const workFolder = await getWorkFolder(body.workFolderId);
    const scope = capabilityScope(body.scope);
    // Remote inspection is read-only and can take several seconds. Complete it
    // before reserving the mutation so discovery never blocks an unrelated turn.
    const item = await state.capabilityRegistry.details(body.id);
    const bundle = item.sourceKind === "bundle"
      ? await state.capabilityRegistry.buildOfficialSkillBundle(item.id)
      : null;
    const installSource = item.installSource;
    if (!bundle && !installSource) throw badRequest("This capability is a reference and cannot be installed directly.");
    const installed = await runCapabilityMutation(state, workFolder, scope, async () => {
      if (bundle) {
        const imported = await importPiSkillBundle(workFolder.workFolderRoot, {
          fileName: bundle.fileName,
          bytes: bundle.bytes,
          scope: scope === "project" ? "project" : "user",
        }, state.runtimeProvider);
        return { kind: "skill" as const, item, imported };
      }
      await installPiPackage(workFolder.workFolderRoot, installSource!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
      return { kind: "package" as const, item, source: installSource! };
    });
    sendJson(res, { installed }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/mcp-setup") {
    const body = await readJsonBody<{ workFolderId?: string; sessionId?: string; operation?: string; scope?: "global" | "project"; name?: string; definition?: unknown; token?: string; jobId?: string; expectedRevision?: string; enabled?: unknown }>(state, req);
    if (!body.workFolderId || !body.operation) throw badRequest("A work-folder and setup operation are required.");
    let sessions = mcpSetupSessions.get(state);
    if (!sessions) { sessions = new Map(); mcpSetupSessions.set(state, sessions); }
    if (body.operation === "close") {
      const entry = body.sessionId ? sessions.get(body.sessionId) : undefined;
      if (!entry || entry.workFolderId !== body.workFolderId) { sendJson(res, { closed: true }); return; }
      clearTimeout(entry.timer); sessions.delete(body.sessionId!); await entry.service.dispose(); sendJson(res, { closed: true }); return;
    }
    const workFolder = await getWorkFolder(body.workFolderId);
    if (body.operation === "open") {
      const runtime = await resolvePiRuntime(workFolder.workFolderRoot, state.runtimeProvider, { requestProjectTrust: false });
      if (!runtime.config.includedTools) throw badRequest("Included service connections are unavailable in this host.");
      if (sessions.size >= 16) throw httpError(409, "Close another service setup before opening one.");
      const id = randomUUID();
      const assertCurrentOwner = async () => {
        const current = await getWorkFolder(workFolder.id);
        if (current.workFolderRoot !== workFolder.workFolderRoot) throw badRequest("This work-folder moved. Open connection setup again.");
        const currentRuntime = await resolvePiRuntime(current.workFolderRoot, state.runtimeProvider, { requestProjectTrust: false });
        if (currentRuntime.agentDir !== runtime.agentDir || !currentRuntime.projectTrust.trusted) throw badRequest("The agent resource scope changed. Open connection setup again.");
      };
      const service = createIncludedMcpSetup({ agentDir: runtime.agentDir, mcpCredentialBackend: runtime.config.mcpCredentialBackend, credentials: runtime.credentials, providerToken: async (id) => (await runtime.modelRuntime.getAuth(id))?.auth.apiKey, ...(runtime.projectTrust.trusted ? { cwd: workFolder.workFolderRoot } : {}),
        openAuthorizationUrl: async (url) => {
          await assertCurrentOwner();
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw badRequest("This service returned an unsupported authorization URL.");
          if (!state.piOAuthHooks) throw badRequest("Open this setup in the desktop app to sign in.");
          await state.piOAuthHooks.openUrl({ url });
        },
        withMutation: async (selection, operation) => {
          const mutation = await runDesktopSettingsAct(state, "tools.connection.configure", async () => ({
            value: await runCapabilityMutation(state, workFolder, selection.scope, async () => {
              await assertCurrentOwner();
              // Drain and revoke native session credentials before changing standing auth.
              if (selection.scope === "global") await invalidateAllClients(state);
              else await invalidateWorkFoldClients(state, workFolder.id);
              return operation();
            }), detail: `Updated service connection ${selection.name} (${selection.scope}).`,
          }));
          return mutation.value;
        },
      });
      const entry = { workFolderId: workFolder.id, service, timer: setTimeout(() => undefined, 0) };
      sessions.set(id, entry); resetMcpSetupExpiry(state, id, entry);
      try { sendJson(res, { sessionId: id, servers: await service.list() }); }
      catch (error) { clearTimeout(entry.timer); sessions.delete(id); await service.dispose().catch(() => undefined); throw error; }
      return;
    }
    const entry = body.sessionId ? sessions.get(body.sessionId) : undefined;
    if (!entry || entry.workFolderId !== workFolder.id) throw badRequest("This connection setup has closed. Open it again.");
    resetMcpSetupExpiry(state, body.sessionId!, entry);
    if (body.operation === "list") { sendJson(res, { servers: await entry.service.list({ inspectCredentials: true }) }); return; }
    if (body.operation === "oauth-status") { sendJson(res, { job: entry.service.oauthStatus(body.jobId ?? "") }); return; }
    if (body.operation === "oauth-cancel") { await entry.service.cancelOAuth(body.jobId ?? ""); sendJson(res, { cancelled: true }); return; }
    if (!body.name || !["global", "project"].includes(body.scope ?? "")) throw badRequest("Choose a service and scope.");
    if (["check", "remove", "enabled", "bearer", "disconnect", "oauth"].includes(body.operation) && !body.expectedRevision) throw badRequest("Refresh service setup before changing this connection.");
    if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision))) throw badRequest("Invalid service configuration revision.");
    const selection = { name: body.name, scope: body.scope!, ...(body.expectedRevision ? { expectedRevision: body.expectedRevision } : {}) };
    switch (body.operation) {
      case "check": {
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", close);
        try { sendJson(res, { probe: await entry.service.probe(selection, { signal: controller.signal }) }); }
        finally { res.off("close", close); }
        return;
      }
      case "save": await entry.service.saveServer({ ...selection, definition: body.definition as never }); break;
      case "enabled": {
        if (typeof body.enabled !== "boolean") throw badRequest("Choose whether the service is enabled.");
        await entry.service.setEnabled(selection, body.enabled); break;
      }
      case "remove": await entry.service.removeServer(selection); break;
      case "bearer": await entry.service.saveBearer({ ...selection, token: body.token! }); break;
      case "disconnect": await entry.service.disconnect(selection); break;
      case "oauth": sendJson(res, { job: await entry.service.startOAuth(selection) }); return;
      default: throw badRequest("Unknown service setup operation.");
    }
    sendJson(res, { servers: await entry.service.list({ inspectCredentials: true }) }); return;
  }
  if (method === "GET" && url.pathname === "/api/agent/included-tools") {
    const workFolderId = url.searchParams.get("workFolderId");
    if (!workFolderId) throw badRequest("A work-folder is required.");
    const workFolder = await getWorkFolder(workFolderId);
    sendJson(res, { tools: await listIncludedToolStatus(workFolder.workFolderRoot, state.runtimeProvider) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/included-tools/setup") {
    const body = await readJsonBody<{ workFolderId?: string; id?: IncludedToolId; action?: IncludedSetupAction; secret?: string }>(state, req);
    if (!body.workFolderId || !includedToolDefinitions.some((item) => item.id === body.id) || typeof body.action !== "string") throw badRequest("A work-folder, included tool, and setup action are required.");
    if (body.secret !== undefined && typeof body.secret !== "string") throw badRequest("The connection key must be text.");
    const workFolder = await getWorkFolder(body.workFolderId);
    const signal = new AbortController();
    const closed = () => { if (!res.writableEnded) signal.abort(); };
    res.once("close", closed);
    try {
      const operation = () => setupIncludedTool(workFolder.workFolderRoot, body.id!, body.action!, { secret: body.secret }, state.runtimeProvider, signal.signal);
      // Observation and deliberate start never repair or dispose peer Chats.
      // Repair/permission setup keeps the mutation fence and idle-client reset.
      const result = body.action === "check" || body.id === "computer" && body.action === "start-check" ? await operation() : await runCapabilityMutation(state, workFolder, "global", operation);
      sendJson(res, result);
    } finally { res.off("close", closed); }
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/resources/enabled") {
    const body = await readJsonBody<{ workFolderId?: string; path?: string; kind?: NativeResourceKind; enabled?: boolean; scope?: "global" | "project" }>(state, req);
    if (!body.workFolderId || !body.path || !body.kind || !["extensions", "skills", "prompts", "themes"].includes(body.kind)
      || typeof body.enabled !== "boolean" || !["global", "project"].includes(body.scope ?? "")) {
      throw badRequest("A work-folder, resource, kind, enabled state, and scope are required.");
    }
    const workFolder = await getWorkFolder(body.workFolderId);
    const scope = capabilityScope(body.scope);
    const result = await runDesktopSettingsAct(state, "tools.enabled", async (requestId) => {
      const value = await createWorkFoldActFacade(state).toolsSetEnabled({
        path: body.path!, kind: body.kind!, enabled: body.enabled!, scope: scope === "project" ? "work-folder" : "everywhere",
        ...(scope === "project" ? { workFolder: workFolder.id } : {}), requestId,
      });
      return { value, detail: `Turned ${body.enabled ? "on" : "off"} ${body.kind} resource ${body.path}.` };
    });
    sendJson(res, { ...result.value, requestId: result.requestId });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/install") {
    const body = await readJsonBody<{ workFolderId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workFolderId || !body.source?.trim()) throw badRequest("A work-folder and package source are required.");
    const workFolder = await getWorkFolder(body.workFolderId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, workFolder, scope, async () => {
      await installPiPackage(workFolder.workFolderRoot, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { installed: true }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/update") {
    const body = await readJsonBody<{ workFolderId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workFolderId || !body.source?.trim() || !body.scope) {
      throw badRequest("A work-folder, package source, and scope are required.");
    }
    const workFolder = await getWorkFolder(body.workFolderId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, workFolder, scope, async () => {
      await updatePiPackages(workFolder.workFolderRoot, body.source, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { updated: true });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/remove") {
    const body = await readJsonBody<{ workFolderId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workFolderId || !body.source?.trim() || !body.scope) {
      throw badRequest("A work-folder, package source, and scope are required.");
    }
    const workFolder = await getWorkFolder(body.workFolderId);
    const scope = capabilityScope(body.scope);
    const removed = await runCapabilityMutation(state, workFolder, scope, async () =>
      await removePiPackage(workFolder.workFolderRoot, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      }));
    sendJson(res, { removed });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/remove") {
    const body = await readJsonBody<{ workFolderId?: string; path?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workFolderId || !body.path?.trim()) throw badRequest("A work-folder and Skill path are required.");
    const workFolder = await getWorkFolder(body.workFolderId);
    const scope = capabilityScope(body.scope);
    const removed = await runCapabilityMutation(state, workFolder, scope, async () =>
      await removePiSkill(workFolder.workFolderRoot, {
        skillPath: body.path!,
        scope: scope === "project" ? "project" : "user",
      }, state.runtimeProvider));
    sendJson(res, { removed: true, path: removed.removedPath });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/import") {
    const multipart = await readMultipartBody(state, req);
    const workFolderId = multipart.fields.get("workFolderId");
    if (!workFolderId || !multipart.files.length) throw badRequest("A work-folder and Skill files are required.");
    const workFolder = await getWorkFolder(workFolderId);
    const scope = multipart.fields.get("scope") === "project" ? "project" : "user";
    const imported = await runCapabilityMutation(
      state,
      workFolder,
      scope === "project" ? "project" : "global",
      async () => {
        const results = [];
        for (const file of multipart.files) {
          results.push(await importPiSkillBundle(workFolder.workFolderRoot, { fileName: file.fileName, bytes: file.data, scope }, state.runtimeProvider));
        }
        return results;
      },
    );
    sendJson(res, { imported }, 201);
    return;
  }

  const catalogMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/agent\/catalog$/);
  if (method === "GET" && catalogMatch) {
    const snapshot = await state.kernel.getCapabilities({ kind: "renderer", workFolderId: catalogMatch[1] });
    sendJson(res, snapshot.catalog);
    return;
  }
  const conversationsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations$/);
  if (conversationsMatch && method === "GET") {
    const workFolder = await getWorkFolder(conversationsMatch[1]);
    sendJson(res, { conversations: await listConversations(workFolder.workFolderRoot) });
    return;
  }
  if (conversationsMatch && method === "POST") {
    const workFolder = await getWorkFolder(conversationsMatch[1]);
    const body = await readJsonBody<{ conversationId?: unknown }>(state, req);
    const conversationId = body.conversationId === undefined
      ? undefined
      : conversationIdentity(body.conversationId);
    const conversation = conversationId === undefined
      ? await createConversation(workFolder.workFolderRoot)
      : await runConversationMutation(state, workFolder.id, conversationId, () =>
        createConversation(workFolder.workFolderRoot, undefined, conversationId));
    sendJson(res, { conversation }, 201);
    return;
  }

  const conversationMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)$/);
  if (conversationMatch && (method === "PUT" || method === "PATCH")) {
    const workFolder = await getWorkFolder(conversationMatch[1]);
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
    const conversation = await runConversationMutation(state, workFolder.id, conversationId, async () => {
      const updated = body.title !== undefined
        ? await renameConversation(workFolder.workFolderRoot, conversationId, body.title)
        : await updateConversationLifecycle(workFolder.workFolderRoot, conversationId, {
            ...(body.archived !== undefined ? { archived: body.archived } : {}),
            ...(body.snoozedUntil !== undefined ? { snoozedUntil: body.snoozedUntil } : {}),
          });
      if (body.title !== undefined) state.clients.get(clientKey(workFolder.id, conversationId))?.setSessionName(updated.title);
      return updated;
    });
    sendJson(res, { conversation });
    return;
  }
  if (conversationMatch && method === "DELETE") {
    const workFolder = await getWorkFolder(conversationMatch[1]);
    const deleted = await runDesktopSettingsAct(state, "chats.delete", async (requestId) => {
      const value = await deleteWorkFolderConversation(state, workFolder, conversationMatch[2], { receiptId: requestId });
      return { value, detail: `work-folder ${workFolder.id}; conversation ${value.conversationId}; trash ${value.recentlyDeleted.entryId}` };
    });
    sendJson(res, { deleted: deleted.value });
    return;
  }

  const conversationRuntimeMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/runtime$/);
  if (conversationRuntimeMatch && method === "GET") {
    const workFolder = await getWorkFolder(conversationRuntimeMatch[1]);
    const conversationId = conversationRuntimeMatch[2];
    if (!(await readConversation(workFolder.workFolderRoot, conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, workFolder.id, workFolder.workFolderRoot, conversationId);
    sendJson(res, { runtime: await client.getState() });
    return;
  }

  const conversationThinkingMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/thinking$/);
  if (conversationThinkingMatch && method === "POST") {
    const workFolder = await getWorkFolder(conversationThinkingMatch[1]);
    const conversationId = conversationThinkingMatch[2];
    if (!(await readConversation(workFolder.workFolderRoot, conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(workFolder.id, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish before changing the thinking level.");
    const client = await getClient(state, workFolder.id, workFolder.workFolderRoot, conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return;
  }

  const contextAttachmentMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/context-attachments$/);
  if (contextAttachmentMatch && method === "POST") {
    const workFolder = await getWorkFolder(contextAttachmentMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("A file path is required.");
    sendJson(res, { attachment: await previewConversationContextReference(workFolder.workFolderRoot, { path: body.path }) }, 201);
    return;
  }

  const eventsMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const workFolder = await getWorkFolder(eventsMatch[1]);
    rememberWorkFolderRoot(state, workFolder.id, workFolder.workFolderRoot);
    openChatStream(state, createLocalEventSink(res), eventsMatch[1], eventsMatch[2], req.headers["last-event-id"]);
    return;
  }
  const messagesPostMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && messagesPostMatch) {
    const workFolder = await getWorkFolder(messagesPostMatch[1]);
    const conversationId = messagesPostMatch[2];
    const body = await readJsonBody<{
      content?: string;
      contextPaths?: string[];
      selectedPath?: string | null;
      requestId?: unknown;
      userMessageId?: unknown;
      delivery?: unknown;
      addressedWorkFolderIds?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    if (body.delivery !== undefined && body.delivery !== "steer") throw badRequest("Message delivery must be \"steer\" when present.");
    if (body.delivery === "steer") {
      const steered = await steerConversationTurn(state, workFolder, conversationId, {
        content,
        requestId: optionalTurnIdentity(body.requestId, "requestId"),
        userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
      });
      sendJson(res, { accepted: true, delivery: "steer", message: steered.message, taskId: steered.taskId, replayed: steered.replayed }, 202);
      return;
    }
    const selectedPath = normalizeSelectedPath(workFolder.workFolderRoot, body.selectedPath);
    const contextPaths = normalizeContextPaths(workFolder.workFolderRoot, body.contextPaths);
    const addressedWorkFolderIds = await normalizeAddressedWorkFolderIds(body.addressedWorkFolderIds, workFolder.id);
    const { message, taskId, replayed } = await acceptConversationTurn(state, workFolder, conversationId, {
      content,
      contextPaths,
      selectedPath,
      actorKind: "assistant",
      ...(addressedWorkFolderIds.length ? { addressedWorkFolderIds } : {}),
      requestId: optionalTurnIdentity(body.requestId, "requestId"),
      userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
    });
    sendJson(res, { accepted: true, message, taskId, replayed }, 202);
    return;
  }
  const abortMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/abort$/);
  if (method === "POST" && abortMatch) {
    const workFolder = await getWorkFolder(abortMatch[1]);
    const key = clientKey(workFolder.id, abortMatch[2]);
    const client = state.clients.get(key);
    const request = state.requests.latestForConversation(abortMatch[2], { workFolderId: workFolder.id });
    if (request) {
      const stopped = await stopWorkFoldAgentRequest(state, request.turns.at(-1)!.taskId);
      sendJson(res, { aborted: stopped.workFoldAgentAborted || stopped.children.some((child) => child.aborted), stopped });
    } else sendJson(res, { aborted: client ? await client.abort() : false });
    return;
  }

  const compactMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/compact$/);
  if (method === "POST" && compactMatch) {
    const workFolder = await getWorkFolder(compactMatch[1]);
    if (!(await readConversation(workFolder.workFolderRoot, compactMatch[2])).length) throw notFound("Conversation not found.");
    const key = clientKey(workFolder.id, compactMatch[2]);
    const body = await readJsonBody<{ customInstructions?: string }>(state, req);
    assertNoCapabilityMutationForTurn(state, workFolder.id);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    state.compactingConversations.add(key);
    const task = state.kernel.startTask({
      kind: "compaction",
      workFolderId: workFolder.id,
      conversationId: compactMatch[2],
      actor: { kind: "assistant", cwd: workFolder.workFolderRoot, workFolderId: workFolder.id, conversationId: compactMatch[2] },
    });
    try {
      const client = await getClient(state, workFolder.id, workFolder.workFolderRoot, compactMatch[2]);
      await client.compact(body.customInstructions?.trim() || undefined);
      broadcast(state, streamKey(workFolder.id, compactMatch[2]), { type: "done", conversationId: compactMatch[2] });
    } finally {
      state.compactingConversations.delete(key);
      state.kernel.finishTask(task.id);
      queueConversationRequestEvaluation(state, workFolder.id, compactMatch[2]);
    }
    sendJson(res, { compacted: true });
    return;
  }
  const messagesGetMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)$/);
  if (method === "GET" && messagesGetMatch) {
    const workFolder = await getWorkFolder(messagesGetMatch[1]);
    sendJson(res, { messages: await readConversation(workFolder.workFolderRoot, messagesGetMatch[2]) });
    return;
  }
  // Management conversation surface: the same acceptance path, task records,
  // and event stream as work-folder Chats, exposed for renderer clients (the
  // menu-bar popover) under the work-fold agent scope id instead of a work-folder id.
  if (url.pathname === "/api/work-fold-agent/summary" && method === "GET") {
    if (state.workFoldAgentInstructionsError) {
      sendJson(res, { available: false, reason: state.workFoldAgentInstructionsError, conversation: null, state: "idle", latestRequest: null });
      return;
    }
    const selectedId = url.searchParams.get("conversationId");
    const conversation = selectedId
      ? (await listConversations(workFoldAgentRoot())).find((item) => item.id === selectedId)
      : await resolveWorkFoldAgentConversation(false).catch(() => null);
    if (selectedId && !conversation) throw notFound("This work-fold agent chat is no longer available.");
    // The selected transcript and its request must describe the same work,
    // even when another surface has started a newer work-fold agent.
    const latest = conversation ? state.requests.latestForConversation(conversation.id) : null;
    sendJson(res, {
      available: true,
      conversation: conversation ? toActConversationRef(conversation) : null,
      state: conversation ? conversationRuntimeState(state, workFoldAgentScopeId, conversation.id) : "idle",
      latestRequest: latest ? await workFoldAgentRequestView(state, latest.turns.at(-1)!.taskId) : null,
    });
    return;
  }
  if (url.pathname === "/api/work-fold-agent/conversations" && method === "GET") {
    assertWorkFoldAgentReadyForRoutes(state);
    const conversations = await listConversations(workFoldAgentRoot());
    sendJson(res, { conversations: await Promise.all(conversations.map(async (conversation) => ({
      ...toActConversationRef(conversation),
      ...await workFoldAgentConversationAttention(state, conversation.id),
    }))) });
    return;
  }
  if (url.pathname === "/api/work-fold-agent/messages" && method === "POST") {
    assertWorkFoldAgentReadyForRoutes(state);
    const body = await readJsonBody<{
      content?: string;
      attachments?: unknown;
      conversationId?: unknown;
      newConversation?: unknown;
      continuationTaskId?: unknown;
      requestId?: unknown;
      userMessageId?: unknown;
      addressedWorkFolderIds?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const addressedWorkFolderIds = await normalizeAddressedWorkFolderIds(body.addressedWorkFolderIds, workFoldAgentScopeId);
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (rawAttachments.length > maxWorkFoldAgentAttachments) {
      throw badRequest(`At most ${maxWorkFoldAgentAttachments} attachments are allowed per request.`);
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
    let attachments: WorkFoldAgentAttachmentRef[];
    try {
      attachments = await classifyWorkFoldAgentAttachments(rawAttachments as string[], workFoldAgentRoot());
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    const scope = workFoldAgentScopeForRoutes(state);
    const priorAcceptance = requestId ? state.turnStore.findScopeRequest(scope.id, requestId) : null;
    if (priorAcceptance && conversationIdInput && priorAcceptance.conversationId !== conversationIdInput) {
      throw httpError(409, "This turn request id was already accepted in another work-fold agent Chat.");
    }
    const conversationId = priorAcceptance?.conversationId
      ?? (body.newConversation === true
        ? (await createConversation(scope.rootPath)).id
        : conversationIdInput ?? (await resolveWorkFoldAgentConversation(true)).id);
    if (continuationTaskId) {
      const previous = await workFoldAgentRequestView(state, continuationTaskId);
      if (!previous || previous.conversationId !== conversationId || previous.phase !== "needs_you") {
        throw httpError(409, "That work-fold agent request is no longer waiting for a reply.");
      }
      const combinedAttachmentCount = new Set(
        [...previous.attachments, ...attachments].map((attachment) => `${attachment.kind}:${attachment.target}`),
      ).size;
      if (combinedAttachmentCount > maxWorkFoldAgentAttachments) {
        throw badRequest(`A continued request can reference at most ${maxWorkFoldAgentAttachments} attachments in total.`);
      }
    }
    // A reply to a waiting request joins that request (F25): one record, one
    // story, a further turn — never a second record copying the trail.
    const continuedRequestId = continuationTaskId ? state.requests.byTaskId(continuationTaskId)?.requestId : undefined;
    const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, workFolderRoot: scope.rootPath }, conversationId, {
      content,
      contextPaths: [],
      selectedPath: null,
      actorKind: "renderer",
      workFoldAgentAttachments: attachments,
      ...(addressedWorkFolderIds.length ? { addressedWorkFolderIds } : {}),
      ...(continuationTaskId ? { continuedFromWorkFoldAgentTaskId: continuationTaskId } : {}),
      ...(continuedRequestId ? { request: { joinRequestId: continuedRequestId } } : {}),
      requestId,
      userMessageId,
    });
    sendJson(res, { accepted: true, conversationId, message, taskId, attachments }, 202);
    return;
  }
  const workFoldAgentRequestMatch = match(url.pathname, /^\/api\/work-fold-agent\/requests\/([^/]+)$/);
  if (workFoldAgentRequestMatch && method === "GET") {
    assertWorkFoldAgentReadyForRoutes(state);
    const request = await workFoldAgentRequestView(state, workFoldAgentRequestMatch[1]);
    if (!request) throw notFound(`Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
    sendJson(res, { request });
    return;
  }
  const workFoldAgentStopMatch = match(url.pathname, /^\/api\/work-fold-agent\/requests\/([^/]+)\/stop$/);
  if (workFoldAgentStopMatch && method === "POST") {
    assertWorkFoldAgentReadyForRoutes(state);
    await readJsonBody<Record<string, never>>(state, req);
    try {
      sendJson(res, { stopped: await stopWorkFoldAgentRequest(state, workFoldAgentStopMatch[1]) });
    } catch (error) {
      if (error instanceof WorkFoldCliError && error.code === "notFound") throw notFound(error.message);
      throw error;
    }
    return;
  }
  const workFoldAgentConversationMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)$/);
  if (workFoldAgentConversationMatch && method === "GET") {
    assertWorkFoldAgentReadyForRoutes(state);
    sendJson(res, { messages: await readConversation(workFoldAgentRoot(), workFoldAgentConversationMatch[1]) });
    return;
  }
  const workFoldAgentConversationTitleMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)\/title$/);
  if (workFoldAgentConversationTitleMatch && method === "POST") {
    assertWorkFoldAgentReadyForRoutes(state);
    const conversationId = workFoldAgentConversationTitleMatch[1];
    const body = await readJsonBody<{ title?: unknown }>(state, req);
    if (typeof body.title !== "string") throw badRequest("Chat title must be text.");
    const title = normalizeConversationTitle(body.title);
    if (!title) throw badRequest("Enter a Chat title.");
    const conversation = await renameWorkFoldAgentConversation(state, conversationId, title);
    state.clients.get(clientKey(workFoldAgentScopeId, conversationId))?.setSessionName(conversation.title);
    sendJson(res, {
      conversation: toActConversationRef(conversation),
      state: conversationRuntimeState(state, workFoldAgentScopeId, conversationId),
    });
    return;
  }
  if (workFoldAgentConversationMatch && method === "DELETE") {
    assertWorkFoldAgentReadyForRoutes(state);
    const deleted = await deleteWorkFoldAgentConversation(state, workFoldAgentConversationMatch[1], { receiptId: null });
    sendJson(res, { deleted });
    return;
  }
  const workFoldAgentRuntimeMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)\/runtime$/);
  if (workFoldAgentRuntimeMatch && method === "GET") {
    assertWorkFoldAgentReadyForRoutes(state);
    const conversationId = workFoldAgentRuntimeMatch[1];
    if (!(await readConversation(workFoldAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, workFoldAgentScopeId, workFoldAgentRoot(), conversationId);
    sendJson(res, { runtime: await client.getState() });
    return;
  }
  const workFoldAgentThinkingMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)\/thinking$/);
  if (workFoldAgentThinkingMatch && method === "POST") {
    assertWorkFoldAgentReadyForRoutes(state);
    const conversationId = workFoldAgentThinkingMatch[1];
    if (!(await readConversation(workFoldAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(workFoldAgentScopeId, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current work-fold agent turn to finish before changing the thinking level.");
    const client = await getClient(state, workFoldAgentScopeId, workFoldAgentRoot(), conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return;
  }
  const workFoldAgentEventsMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)\/events$/);
  if (workFoldAgentEventsMatch && method === "GET") {
    assertWorkFoldAgentReadyForRoutes(state);
    openChatStream(state, createLocalEventSink(res), workFoldAgentScopeId, workFoldAgentEventsMatch[1], req.headers["last-event-id"]);
    return;
  }

  const workFolderWorkMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/work$/);
  const workFoldAgentWorkMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)\/work$/);
  const taskWorkMatch = match(url.pathname, /^\/api\/tasks\/([^/]+)\/work$/);
  if (method === "GET" && (workFolderWorkMatch || workFoldAgentWorkMatch || taskWorkMatch)) {
    if (workFolderWorkMatch) await getWorkFolder(workFolderWorkMatch[1]);
    const record = taskWorkMatch ? state.requests.byTaskId(taskWorkMatch[1])
      : state.requests.latestForConversation(workFolderWorkMatch?.[2] ?? workFoldAgentWorkMatch![1],
        workFolderWorkMatch ? { workFolderId: workFolderWorkMatch[1] } : {});
    sendJson(res, { work: record ? await requestPresentation(state, record) : null });
    return;
  }
  const workActionMatch = match(url.pathname, /^\/api\/requests\/([^/]+)\/(answer|stop|continue)$/);
  if (method === "POST" && workActionMatch) {
    const record = state.requests.get(workActionMatch[1]);
    if (!record) throw notFound("This work is no longer on record.");
    const input = await readJsonBody<Record<string, unknown>>(state, req);
    await performWorkAction(state, record, workActionMatch[2], input);
    sendJson(res, { work: await requestPresentation(state, state.requests.get(record.requestId)!) });
    return;
  }

  // One renderer connection carries only its explicitly subscribed read streams.
  // The same local session/origin authorization above protects this endpoint.
  if (url.pathname === "/api/events" && method === "POST") {
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const input = await readJsonBody<unknown>(state, req, localEventStreamLimits.bodyBytes);
    let subscriptions: ReturnType<typeof parseLocalEventSubscriptions>;
    try { subscriptions = parseLocalEventSubscriptions(input); }
    catch (error) { throw badRequest(errorMessage(error)); }
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const connection = createLocalEventSink(res);
    state.localEventStreams.add(connection);
    const heartbeat = setInterval(() => connection.heartbeat(), 15_000);
    heartbeat.unref();
    connection.onClose(() => { clearInterval(heartbeat); state.localEventStreams.delete(connection); });
    await Promise.all(subscriptions.map(async (subscription) => {
      const channel = createLocalEventChannel(connection, subscription.id);
      try {
        const target = localEventTarget(subscription.path)!;
        if (target.kind === "control") {
          if (state.controlStreams.size >= 64) throw httpError(429, "Too many control event connections.");
          openControlEventStream(state, channel);
        } else if (target.kind === "agent") {
          assertWorkFoldAgentReadyForRoutes(state);
          if (!await readConversationSummary(workFoldAgentRoot(), target.conversationId)) throw notFound("Conversation not found.");
          if (channel.closed) return;
          openChatStream(state, channel, workFoldAgentScopeId, target.conversationId, subscription.lastEventId);
        } else {
          const workFolder = await getWorkFolder(target.workFolderId);
          if (channel.closed) return;
          if (target.kind === "files") await openWorkFolderFileStream(state, channel, workFolder.workFolderRoot, target.workFolderId);
          else {
            if (!await readConversationSummary(workFolder.workFolderRoot, target.conversationId)) throw notFound("Conversation not found.");
            const registered = await getWorkFolder(target.workFolderId);
            if (registered.workFolderRoot !== workFolder.workFolderRoot) throw notFound("work-folder changed while opening this Chat.");
            if (channel.closed) return;
            rememberWorkFolderRoot(state, registered.id, registered.workFolderRoot);
            openChatStream(state, channel, target.workFolderId, target.conversationId, subscription.lastEventId);
          }
        }
        if (!channel.closed) connection.send({ subscriptionId: subscription.id, ready: true } satisfies LocalEventEnvelope);
      } catch (error) {
        const code = (error as { statusCode?: unknown })?.statusCode;
        const status = typeof code === "number" && code >= 400 && code <= 599 ? code : 500;
        if (!channel.closed) connection.send({ subscriptionId: subscription.id, error: {
          status, message: status < 500 ? errorMessage(error) : "This local event stream is unavailable. Refresh to reconnect.",
        } } satisfies LocalEventEnvelope);
        channel.close();
      }
    }));
    return;
  }

  // Content-free control hints for the renderer: which registry changed, so
  // the surfaces requery instead of accumulating an event queue.
  if (url.pathname === "/api/work-fold-agent/control-events" && method === "GET") {
    if (state.controlStreams.size >= 64) throw httpError(429, "Too many control event connections.");
    openControlEventStream(state, createLocalEventSink(res));
    return;
  }
  // The overview (docs/work-fold-agent-overview.md): the app-composed digest for the popover
  // and the main window, on the renderer session. Deliberately no
  // management-readiness gate — the digest reads recorded state, not the
  // management Pi session, so it stays available even when management
  // commands fail closed; only narration needs the conversation.
  if (url.pathname === "/api/work-fold-agent/overview" && method === "GET") {
    sendJson(res, { overview: await state.kernel.getOverview({ kind: "renderer" }) });
    return;
  }
  if (url.pathname === "/api/work-fold-agent/overview/seen" && method === "POST") {
    const body = await readJsonBody<{ surface?: unknown; cursor?: unknown }>(state, req);
    // The renderer lane advances only the two desktop surfaces. Remote
    // `remote:<grantId>` markers advance exclusively through the approved
    // browser's signed envelope (`management.glanceSeen`), so one surface can
    // never acknowledge for another.
    if (body.surface !== "popover" && body.surface !== "main-window") {
      throw badRequest("The overview surface must be popover or main-window.");
    }
    if (typeof body.cursor !== "string" || !parseWorkFoldOverviewCursor(body.cursor)) {
      throw badRequest("A rendered overview cursor is required to mark seen.");
    }
    // Monotonic by construction: fetching never advances a marker, a replayed
    // or backward advance is a no-op, and a failed write only leaves items
    // rendering as new.
    sendJson(res, await state.overviewSeen.advance(body.surface, body.cursor));
    return;
  }

  // Shared pages (docs/shared-pages.md, plan item 5): the
  // desktop Settings surface over the publication authority. Reads list the
  // grant records with their budgets, tallies, health notes, and page state;
  // the narrowing verbs — revoke, cut budgets, snapshot off — are direct
  // receipted acts minted with a per-request id and the main-window surface.
  // Sharing a file from its tab and widening a page in place (raised
  // budgets, sleep copy on) run the same domain paths as `pages share` and
  // `pages widen`, receipted through the Settings act wrapper — a share
  // executes on the click and leaves a receipt (docs/receipts-not-gates.md,
  // F19). These routes sit behind the renderer session; the paired browser's
  // closed remote operation set has no settings endpoint. The reveal route
  // composes the share link's secret fragment on demand from the key store
  // and returns it transiently — it is never listed, journaled, or logged.
  if (url.pathname === "/api/settings/publications" && method === "GET") {
    try {
      const status = state.publications.status();
      const views = status.damaged ? [] : await state.publications.list();
      const publications = [];
      for (const view of views) {
        const registered = await getWorkFolder(view.workFolderId).catch(() => null);
        publications.push({ ...view, ...(registered ? { workFolderName: registered.name } : {}) });
      }
      sendJson(res, { publications, status });
    } catch (error) {
      sendPublicationError(res, error);
    }
    return;
  }
  if (url.pathname === "/api/settings/publications/share" && method === "POST") {
    try {
      const body = await readJsonBody<{ workFolderId?: unknown; path?: unknown; title?: unknown; snapshot?: unknown }>(state, req);
      if (typeof body.workFolderId !== "string" || !body.workFolderId || typeof body.path !== "string" || typeof body.title !== "string") {
        sendJson(res, { error: "A work-folder id, a file path, and a title are required to share a page." }, 400);
        return;
      }
      const workFolder = await getWorkFolder(body.workFolderId).catch(() => null);
      if (!workFolder) {
        sendJson(res, { error: "That work-folder is not registered on this machine.", code: "WORK_FOLDER_NOT_REGISTERED" }, 404);
        return;
      }
      const path = body.path;
      const title = body.title;
      const shared = await runDesktopSettingsAct(state, "pages.share", async (requestId) => {
        const view = await sharePageFromDesktop(state, { workFolder, path, title, snapshot: body.snapshot === true }, {
          surface: "main-window",
          requestId,
        });
        return {
          value: view,
          detail: `Shared "${view.title}" (${view.workFolderId}:${view.relativePath}) as ${view.viewerPath}; `
            + `bridgeSync=${view.bridgeSlot === "confirmed" ? "confirmed" : "pending"}.`,
        };
      });
      const view = shared.value;
      const revealable = view.state === "active" && Boolean(await state.publicationKeys.get(view.publicationId).catch(() => null));
      sendJson(res, { publication: { ...view, workFolderName: workFolder.name }, revealable });
    } catch (error) {
      if (error instanceof WorkFoldCliError && error.message === WORKFOLD_PUBLICATION_NO_ADDRESS_MESSAGE) {
        sendJson(res, { error: error.message, code: "NO_ADDRESS" }, 409);
        return;
      }
      sendPublicationError(res, error);
    }
    return;
  }
  const publicationSettingsMatch = match(url.pathname, /^\/api\/settings\/publications\/([^/]+)\/(reveal-link|revoke|narrow|widen|snapshot-off)$/);
  if (publicationSettingsMatch && method === "POST") {
    const publicationId = publicationSettingsMatch[1];
    const action = publicationSettingsMatch[2];
    try {
      if (action === "reveal-link") {
        await readJsonBody<Record<string, never>>(state, req);
        sendJson(res, await state.publications.revealLink(publicationId));
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
      if (action === "widen") {
        const body = await readJsonBody<{ serveRatePerMinute?: unknown; byteBudgetPerDay?: unknown; snapshotEnabled?: unknown }>(state, req);
        if (body.snapshotEnabled !== undefined && body.snapshotEnabled !== true) {
          sendJson(res, { error: "Widening can only turn the sleep copy on; turning it off is snapshot-off.", code: "INPUT_INVALID" }, 400);
          return;
        }
        const widenInput: { serveRatePerMinute?: number; byteBudgetPerDay?: number; snapshotEnabled?: true } = {};
        if (body.serveRatePerMinute !== undefined) widenInput.serveRatePerMinute = Number(body.serveRatePerMinute);
        if (body.byteBudgetPerDay !== undefined) widenInput.byteBudgetPerDay = Number(body.byteBudgetPerDay);
        if (body.snapshotEnabled === true) widenInput.snapshotEnabled = true;
        // The same slot, key, and link: the widening is the service's own
        // journaled verb, run under the Settings act's minted id.
        const widened = await runDesktopSettingsAct(state, "pages.widen", async (requestId) => {
          const publication = await state.publications.widen(publicationId, widenInput, { requestId, surface: "main-window" });
          return {
            value: publication,
            detail: `Widened ${publication.viewerPath}: serveRatePerMinute=${publication.serveRatePerMinute} `
              + `byteBudgetPerDay=${publication.byteBudgetPerDay} snapshot=${publication.snapshotEnabled ? "on" : "off"}.`,
          };
        });
        sendJson(res, { publication: widened.value });
        return;
      }
      const body = await readJsonBody<{ serveRatePerMinute?: unknown; byteBudgetPerDay?: unknown }>(state, req);
      const narrowInput: { serveRatePerMinute?: number; byteBudgetPerDay?: number } = {};
      if (body.serveRatePerMinute !== undefined) narrowInput.serveRatePerMinute = Number(body.serveRatePerMinute);
      if (body.byteBudgetPerDay !== undefined) narrowInput.byteBudgetPerDay = Number(body.byteBudgetPerDay);
      sendJson(res, { publication: await state.publications.narrowBudgets(publicationId, narrowInput, context) });
      return;
    } catch (error) {
      sendPublicationError(res, error);
    }
    return;
  }

  // Settings → Recently deleted (docs/receipts-not-gates.md, F20).
  // Listing is a plain read; restoring, removing one item, and changing how
  // long items are kept are journaled acts with the main-window surface, like
  // every other trusted-Settings mutation. Nothing here empties the store.
  if (url.pathname === "/api/settings/recently-deleted" && method === "GET") {
    const listing = await state.recentlyDeleted.list();
    const registered = new Set((await listWorkFolders()).map((workFolder) => workFolder.id));
    const entries = [];
    for (const entry of listing.entries) entries.push(await recentlyDeletedEntryView(state, entry, registered));
    sendJson(res, { entries, damaged: listing.damaged, retentionDays: listing.retentionDays });
    return;
  }
  if (url.pathname === "/api/settings/recently-deleted/retention" && method === "PUT") {
    const body = await readJsonBody<{ retentionDays?: unknown }>(state, req);
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw badRequest("Keep deleted items for between 1 and 365 days.");
    }
    const updated = await runDesktopSettingsAct(state, "recently-deleted.retention", async () => {
      await state.recentlyDeleted.setRetentionDays(days);
      return { value: { retentionDays: state.recentlyDeleted.retentionDays() }, detail: `days ${days}` };
    });
    sendJson(res, updated.value);
    return;
  }
  // Settings → Automations → Limits: the one adjustable request setting (F28).
  // Turning follow-up turns off changes nothing about what is recorded; it
  // only stops the host from bringing the results back as a turn.
  if (url.pathname === "/api/settings/requests" && method === "GET") {
    sendJson(res, { continuationsEnabled: state.requests.continuationsEnabled() });
    return;
  }
  if (url.pathname === "/api/settings/requests/continuations" && method === "PUT") {
    const body = await readJsonBody<{ enabled?: unknown }>(state, req);
    if (typeof body.enabled !== "boolean") throw badRequest("Say whether follow-up turns are on or off.");
    const enabled = body.enabled;
    const updated = await runDesktopSettingsAct(state, "requests.continuations", async () => {
      await state.requests.setContinuationsEnabled(enabled);
      return { value: { continuationsEnabled: state.requests.continuationsEnabled() }, detail: enabled ? "on" : "off" };
    });
    sendJson(res, updated.value);
    return;
  }
  const recentlyDeletedEntryMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)$/);
  if (recentlyDeletedEntryMatch && method === "DELETE") {
    const entryId = recentlyDeletedEntryMatch[1];
    if (!workFoldRecentlyDeletedEntryIdPattern.test(entryId)) throw notFound("That item is no longer in Recently deleted.");
    try {
      const removed = await runDesktopSettingsAct(state, "recently-deleted.delete-now", async () => ({
        value: await state.recentlyDeleted.remove(entryId),
        detail: `entry ${entryId}`,
      }));
      sendJson(res, removed.value);
    } catch (error) {
      if (error instanceof WorkFoldRecentlyDeletedError && error.code === "HELD") {
        sendJson(res, { error: error.message }, 409);
        return;
      }
      throw error;
    }
    return;
  }
  const recentlyDeletedRestoreMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)\/restore$/);
  if (recentlyDeletedRestoreMatch && method === "POST") {
    await readJsonBody<Record<string, never>>(state, req);
    const restored = await runDesktopSettingsAct(state, "recently-deleted.restore", async (requestId) => {
      const value = await restoreRecentlyDeletedEntry(state, recentlyDeletedRestoreMatch[1], { receiptId: requestId });
      return { value, detail: `entry ${recentlyDeletedRestoreMatch[1]}; kind ${value.kind}` };
    });
    sendJson(res, { restored: restored.value });
    return;
  }
  const recentlyDeletedExportMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)\/export$/);
  if (recentlyDeletedExportMatch && method === "GET") {
    const entryId = recentlyDeletedExportMatch[1];
    if (!workFoldRecentlyDeletedEntryIdPattern.test(entryId)) throw notFound("That item is no longer in Recently deleted.");
    const entry = await state.recentlyDeleted.get(entryId);
    if (!entry || (entry.kind !== "app-storage" && entry.kind !== "app-retained")) {
      throw notFound("Only kept app data can be saved as a copy.");
    }
    sendJson(res, { backup: await state.recentlyDeleted.readAppData(entryId) });
    return;
  }

  const extensionResponseMatch = match(url.pathname, /^\/api\/work-folders\/([^/]+)\/conversations\/([^/]+)\/extension-ui(?:\/([^/]+))?$/);
  const workFoldAgentExtensionMatch = match(url.pathname, /^\/api\/work-fold-agent\/conversations\/([^/]+)\/extension-ui(?:\/([^/]+))?$/);
  if ((extensionResponseMatch || workFoldAgentExtensionMatch) && (method === "GET" || method === "POST")) {
    const scope: PiExtensionUiScope = extensionResponseMatch
      ? { workFolderRoot: (await getWorkFolder(extensionResponseMatch[1])).workFolderRoot, conversationId: extensionResponseMatch[2] }
      : { workFolderRoot: workFoldAgentRoot(), conversationId: workFoldAgentExtensionMatch![1] };
    const id = extensionResponseMatch?.[3] ?? workFoldAgentExtensionMatch?.[2];
    if (!id && method === "GET") {
      sendJson(res, { requests: extensionSnapshot(state, scope) });
      return;
    }
    if (!id || method !== "POST") throw notFound("Extension request not found.");
    const body = await readJsonBody<{ value?: unknown; cancelled?: boolean }>(state, req);
    const accepted = answerExtensionRequest(state, scope, id, body);
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
/**
 * F25 lineage for one accepted turn. Absent means "a work-folder turn with no
 * parent": the turn is its own root. `parentTaskId` makes it a child request
 * under the request that task belongs to; `joinRequestId` makes it a further
 * turn of an existing request (a reply to a question, a follow-up turn).
 */
interface AcceptedTurnRequestInput {
  kind?: WorkFoldRequestKind;
  surface?: WorkFoldRequestSurface;
  parentTaskId?: string;
  joinRequestId?: string;
  app?: WorkFoldRequestAppRef;
  /** The assignment text when it differs from this turn's message (an answer continuation). */
  assignment?: string;
  /**
   * `chat answer`: the one question this turn answers, already flipped to
   * `answered` before acceptance. The free-text reply path then leaves every
   * other open question alone rather than answering it with the same text.
   */
  answeringQuestionId?: string;
}

async function acceptConversationTurn(
  state: LocalApiState,
  workFolder: { id: string; workFolderRoot: string; name?: string },
  conversationId: string,
  input: {
    content: string;
    contextPaths: string[];
    selectedPath: string | null;
    /** `system` marks turns app code dispatches (automation chat hops). */
    actorKind: "assistant" | "cli" | "renderer" | "system";
    /** Management-scope reference attachments; never used for work-folder Chats. */
    workFoldAgentAttachments?: WorkFoldAgentAttachmentRef[];
    /** Previous needs-you request whose audit trail this reply continues. */
    continuedFromWorkFoldAgentTaskId?: string;
    /** Remote provenance is persisted with the message and work-fold agent request. */
    remotePrincipal?: WorkFoldRemotePrincipal;
    /** Stable caller identity. Replays with the same input return the original acceptance. */
    requestId?: string;
    /** Stable optimistic message identity supplied by renderer clients. */
    userMessageId?: string;
    /** Host-composed selected reports already present in this continuation message. */
    releasedChildTaskIds?: string[];
    /** Which durable request this turn creates or joins (docs/collaboration-contract.md, F25). */
    request?: AcceptedTurnRequestInput;
    /** work-folder Workers the person addressed with @ (2026-10-01); registered ids, never this scope's own. */
    addressedWorkFolderIds?: string[];
  },
): Promise<{ message: { id: string; role: "user"; content: string; createdAt: string }; taskId: string; replayed: boolean }> {
  if (!state.acceptingTurns) throw httpError(503, "work-fold is closing and cannot accept another turn.");
  const turnKey = clientKey(workFolder.id, conversationId);
  const existing = await readConversationSummary(workFolder.workFolderRoot, conversationId);
  if (!existing) throw notFound("Conversation not found.");
  const requestId = turnIdentity(input.requestId ?? (input.remotePrincipal
    ? `remote-${createHash("sha256").update(`${input.remotePrincipal.browserId}\u0000${input.remotePrincipal.grantId}\u0000${input.remotePrincipal.requestId}`).digest("hex")}`
    : `request-${randomUUID()}`), "request id");
  const requestDigest = assistantTurnRequestDigest(input);
  const prior = state.turnStore.findRequest(workFolder.id, conversationId, requestId);
  let durable: WorkFoldDurableTurnRecord | null = null;
  if (prior) {
    if (prior.requestDigest !== requestDigest) throw httpError(409, "This turn request id was already used for different input.");
    if (!prior.userMessagePersisted) {
      if (state.runningTurns.has(turnKey)) throw httpError(409, "This turn is still being accepted.");
      durable = await state.turnStore.resumeUnpersisted(prior.turnId);
      if (!durable || durable.userMessagePersisted) throw httpError(409, "This turn can no longer be resumed safely.");
      state.settledTurns.delete(prior.turnId);
    } else {
      const messages = await readConversation(workFolder.workFolderRoot, conversationId);
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
  assertNoCapabilityMutationForTurn(state, workFolder.id);
  if (state.compactingConversations.has(turnKey)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  if (state.runningTurns.has(turnKey)) throw httpError(409, "Wait for the current agent turn to finish.");
  if (input.request?.joinRequestId) {
    try { state.requests.assertCanContinue(input.request.joinRequestId); }
    catch (error) { throw requestRefusal(error); }
  }
  // A delegated child is refused by name before anything durable exists for
  // it: the parent must still be accepting, and every request bound is
  // checked here rather than after a turn was already accepted.
  if (input.request?.parentTaskId && !durable) {
    try {
      state.requests.assertCanAddChild(input.request.parentTaskId);
    } catch (error) {
      throw requestRefusal(error);
    }
  }
  // The summary read above can overlap a completed deletion. Recheck the
  // transcript synchronously at admission so accepting a stale send cannot
  // recreate the Chat after its recoverable copy has moved into Recently deleted.
  if (!existsSync(join(conversationsDir(workFolder.workFolderRoot), `${conversationId}.jsonl`))) {
    throw notFound("Conversation not found.");
  }
  state.runningTurns.add(turnKey);
  // Clear the settled turn's retained stream state in the same synchronous
  // admission step that marks this Chat running. A reconnect can never observe
  // `running: true` paired with the previous reply's text.
  resetChatEventTurn(state, turnKey);
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
        workFolderId: workFolder.id,
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
  if (!durable) throw new Error("Turn reservation was not created.");
  const task = state.kernel.startTask({
    id: durable.turnId,
    kind: "assistant_turn",
    workFolderId: workFolder.id,
    conversationId,
    actor: { kind: input.actorKind, cwd: workFolder.workFolderRoot, workFolderId: workFolder.id, conversationId },
  });
  state.activeTurnTasks.set(task.id, { workFolderId: workFolder.id, conversationId });
  state.activeTurnIdsByKey.set(turnKey, task.id);
  publishControlHint(state, "activity");
  const workFoldAgentAttachments = workFolder.id === workFoldAgentScopeId
    ? input.workFoldAgentAttachments ?? []
    : undefined;
  const message = {
    id: durable.userMessageId,
    role: "user" as const,
    content: input.content,
    ...(input.actorKind === "system" && input.request?.joinRequestId ? { kind: "assistant_continuation" as const } : {}),
    createdAt: durable.userMessageCreatedAt,
    turnId: task.id,
    requestId,
    ...(workFoldAgentAttachments?.length
      ? { attachments: workFoldAgentAttachments.map((ref) => ({ kind: ref.kind, target: ref.target, name: ref.name })) }
      : {}),
    ...(input.remotePrincipal ? {
      source: "remote_web" as const,
      remotePrincipalId: input.remotePrincipal.browserId,
      remoteGrantId: input.remotePrincipal.grantId,
      remoteRequestId: input.remotePrincipal.requestId,
    } : {}),
  };
  let answeredQuestionIds: string[] = [];
  try {
    // Every accepted turn belongs to exactly one request record (F25). The
    // record is created before the user message lands so a refused child
    // never leaves a message behind; a failure here rolls back with the rest.
    const lineage = await recordAcceptedTurnRequest(state, workFolder, conversationId, task.id, input, workFoldAgentAttachments);
    answeredQuestionIds = lineage.answers;
    await appendMessage(workFolder.workFolderRoot, conversationId, message);
    await state.turnStore.markRunning(task.id);
    await state.requests.markTurnRunning(task.id);
    // A person's free-text reply is a supported way to answer (F27): once
    // the message is the transcript's, it answers each open question that
    // was waiting on the person and is that answer's one continuation.
    await answerPersonQuestionsWithReply(state, lineage.answers, task.id, input.content);
    if (input.request?.joinRequestId && input.releasedChildTaskIds?.length) {
      await state.requests.noteChildDelivery(input.request.joinRequestId, input.releasedChildTaskIds);
    }
  } catch (error) {
    state.runningTurns.delete(turnKey);
    state.activeTurnTasks.delete(task.id);
    state.cancelledTurnTasks.delete(task.id);
    state.activeTurnIdsByKey.delete(turnKey);
    state.kernel.finishTask(task.id);
    publishControlHint(state, "activity");
    const detail = error instanceof WorkFoldRequestLimitError || error instanceof WorkFoldRequestLineageError
      ? error.message
      : "The accepted user message could not be persisted.";
    await state.turnStore.settle(task.id, { status: "failed", error: detail }).catch(() => undefined);
    await state.requests.settleTurn(task.id, { status: "failed", error: detail }).catch(() => undefined);
    broadcast(state, turnKey, turnStateEvent(conversationId, false));
    throw requestRefusal(error);
  }
  const answeredQuestionId = input.request?.answeringQuestionId ?? answeredQuestionIds[0];
  // A live surface may re-read the transcript on this transition. Publish it
  // only after its accepted user message is durable, including answer turns.
  broadcast(state, turnKey, turnStateEvent(conversationId, true));
  const turn = runAgentTurn(
    state,
    workFolder.id,
    workFolder.workFolderRoot,
    conversationId,
    input.content,
    input.contextPaths,
    input.selectedPath,
    task.id,
    {
      ...(workFoldAgentAttachments ? { workFoldAgentAttachments } : {}),
      ...(input.request?.parentTaskId ? { parentTaskId: input.request.parentTaskId } : {}),
      ...(input.request?.assignment !== undefined ? { assignment: input.request.assignment } : {}),
      // The continuation's own link to the question it answers (F27), built
      // by the host rather than read back out of the travelling transcript:
      // `chat answer` names the question, and a person's free-text reply
      // answers whichever of this request's questions were waiting on them.
      ...(answeredQuestionId ? { answeredQuestionId } : {}),
      ...(input.addressedWorkFolderIds?.length ? { addressedWorkFolderIds: input.addressedWorkFolderIds } : {}),
    },
  );
  state.activeTurnPromises.add(turn);
  void turn.then(
    () => state.activeTurnPromises.delete(turn),
    (error) => {
      state.activeTurnPromises.delete(turn);
      console.error(`Accepted turn escaped its settlement path: ${errorMessage(error)}`);
    },
  );
  return { message, taskId: task.id, replayed: false };
}

/**
 * A request bound or lineage refusal reaches the caller verbatim as a
 * conflict, so the limit's own text — number and Settings section — is what
 * the person or agent reads. Anything else passes through unchanged.
 */
function requestRefusal(error: unknown): unknown {
  if (error instanceof WorkFoldRequestLimitError || error instanceof WorkFoldRequestLineageError) {
    return httpError(409, error.message);
  }
  return error;
}

/**
 * Creates or joins the durable request record for one accepted turn. Kind
 * and surface default from the scope and actor when the caller names none:
 *
 *   work-fold agent scope, renderer, remote principal → management / remote_web
 *   work-fold agent scope, renderer                    → management / popover
 *   work-fold agent scope, cli                         → management / cli
 *   work-fold agent scope, system (automation agent hop)   → automation / system
 *   work-folder scope, system, app dispatch             → app / system
 *   work-folder scope, system (automation chat hop)        → automation / system
 *   work-folder scope, cli                              → cli / cli
 *   work-folder scope, assistant (renderer work-folder Chat)  → work-folder / renderer
 *
 * A child of an explicit parent keeps the parent's root; a needs-you reply
 * joins its earlier request instead of copying its trail into a second one.
 */
async function recordAcceptedTurnRequest(
  state: LocalApiState,
  workFolder: { id: string; workFolderRoot: string; name?: string },
  conversationId: string,
  taskId: string,
  input: {
    content: string;
    actorKind: "assistant" | "cli" | "renderer" | "system";
    continuedFromWorkFoldAgentTaskId?: string;
    remotePrincipal?: WorkFoldRemotePrincipal;
    request?: AcceptedTurnRequestInput;
  },
  workFoldAgentAttachments: WorkFoldAgentAttachmentRef[] | undefined,
): Promise<{ record: WorkFoldRequestRecord; answers: string[] }> {
  const isWorkFoldAgent = workFolder.id === workFoldAgentScopeId;
  // This Chat's newest request is waiting on the person and no parent was
  // named: the reply joins that request rather than opening a second root,
  // whether the caller named the request it continues or not.
  const pending = input.request?.parentTaskId || input.request?.answeringQuestionId
    ? null
    : pendingPersonQuestions(state, conversationId, isWorkFoldAgent ? {} : { workFolderId: workFolder.id });
  const joinRequestId = input.request?.joinRequestId ?? pending?.requestId;
  const answers = pending && pending.requestId === joinRequestId ? pending.questionIds : [];
  const request: AcceptedTurnRequestInput | undefined = joinRequestId
    ? { ...input.request, joinRequestId }
    : input.request;
  input = { ...input, request };
  const owner = isWorkFoldAgent
    ? { conversationId }
    : { workFolderId: workFolder.id, ...(workFolder.name ? { workFolderName: workFolder.name } : {}), conversationId };
  const kind: WorkFoldRequestKind = input.request?.kind
    ?? (isWorkFoldAgent
      ? (input.actorKind === "system" ? "automation" : "agent")
      : input.actorKind === "system"
        ? (input.request?.app ? "app" : "automation")
        : input.actorKind === "cli"
          ? "cli"
          : "work-folder");
  const surface: WorkFoldRequestSurface = input.request?.surface
    ?? (input.actorKind === "system"
      ? "system"
      : input.actorKind === "cli"
        ? "cli"
        : isWorkFoldAgent
          ? (input.remotePrincipal ? "remote_web" : "popover")
          : "renderer");
  const attachments = workFoldAgentAttachments ?? [];
  const record = input.request?.joinRequestId
    ? await state.requests.joinTurn({
      requestId: input.request.joinRequestId,
      taskId,
      role: "continuation",
      content: input.content,
      attachments,
    })
    : input.request?.parentTaskId
      ? await state.requests.beginChild({
        parentTaskId: input.request.parentTaskId,
        kind,
        owner,
        surface,
        taskId,
        content: input.content,
        attachments,
        ...(input.request.app ? { app: input.request.app } : {}),
      })
      : await state.requests.beginRoot({
        kind,
        owner,
        surface,
        taskId,
        content: input.content,
        attachments,
        ...(input.request?.app ? { app: input.request.app } : {}),
        ...(input.continuedFromWorkFoldAgentTaskId ? { continuedFromTaskId: input.continuedFromWorkFoldAgentTaskId } : {}),
        ...(input.remotePrincipal ? {
          remote: {
            principalId: input.remotePrincipal.browserId,
            grantId: input.remotePrincipal.grantId,
            requestId: input.remotePrincipal.requestId,
          },
        } : {}),
      });
  // A retried acceptance whose earlier attempt could not persist its message
  // reopens the same turn: a task id belongs to exactly one request.
  const turn = record.turns.find((candidate) => candidate.taskId === taskId);
  if (turn && turn.state !== "accepted" && turn.state !== "running") {
    return { record: (await state.requests.reopenTurn(taskId)) ?? record, answers };
  }
  return { record, answers };
}

/**
 * The open questions addressed to the person on this Chat's newest request,
 * if it is waiting on them. Scoped to the owner: a conversation id lives in
 * the work-folder's folder and travels with it, so two registered work-folders can hold the
 * same id and a reply must never join the other one's request.
 */
function pendingPersonQuestions(
  state: LocalApiState,
  conversationId: string,
  owner: { workFolderId?: string },
): { requestId: string; questionIds: string[] } | null {
  const latest = state.requests.latestForConversation(conversationId, owner);
  if (!latest || latest.state !== "waiting") return null;
  const open = state.requests.questions(latest.requestId)
    .filter((question) => question.state === "open" && question.respondent === "person");
  return open.length ? { requestId: latest.requestId, questionIds: open.map((question) => question.questionId) } : null;
}

/**
 * Records the person's reply as the one answer to each question it was
 * waiting on and links this turn as that answer's continuation. Attribution
 * only: a question that can no longer take an answer (expired, withdrawn,
 * answered meanwhile) is left as it is, and the turn still runs.
 */
async function answerPersonQuestionsWithReply(state: LocalApiState, questionIds: string[], taskId: string, content: string): Promise<void> {
  const answer = Buffer.byteLength(content, "utf8") > workFoldRequestLimits.maxAnswerTextBytes
    ? Buffer.from(content, "utf8").subarray(0, workFoldRequestLimits.maxAnswerTextBytes).toString("utf8").replace(/\uFFFD+$/u, "")
    : content;
  for (const questionId of questionIds) {
    try {
      await state.requests.answer({ questionId, answer });
      await state.requests.linkContinuation(questionId, taskId);
    } catch (error) {
      console.warn(`A reply could not be recorded as the answer to question ${questionId}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Delivers a message into the Chat's running turn through Pi's steering queue
 * and records it in the transcript as part of that turn. When no turn is
 * running (or it settles first) the caller receives 409 and sends normally;
 * nothing is appended in that case.
 */
async function steerConversationTurn(
  state: LocalApiState,
  workFolder: { id: string; workFolderRoot: string },
  conversationId: string,
  input: { content: string; requestId?: string; userMessageId?: string },
): Promise<{ message: ChatMessage; taskId: string; replayed: boolean }> {
  const key = clientKey(workFolder.id, conversationId);
  const taskId = state.activeTurnIdsByKey.get(key);
  const client = state.clients.get(key);
  if (!taskId || !client || !state.runningTurns.has(key)) {
    throw httpError(409, "No turn is running in this Chat; send the message normally.");
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
  await appendMessage(workFolder.workFolderRoot, conversationId, message);
  state.steeredMessages.set(replayKey, message);
  if (state.steeredMessages.size > maxRememberedSteeredMessages) {
    const oldest = state.steeredMessages.keys().next().value;
    if (oldest !== undefined) state.steeredMessages.delete(oldest);
  }
  broadcast(state, streamKey(workFolder.id, conversationId), {
    type: "status",
    conversationId,
    message: "Your message will reach the agent after its current step.",
  });
  return { message, taskId, replayed: false };
}

const maxRememberedSteeredMessages = 500;

function assistantTurnRequestDigest(input: {
  content: string;
  contextPaths: string[];
  selectedPath: string | null;
  workFoldAgentAttachments?: WorkFoldAgentAttachmentRef[];
  actorKind?: string;
  continuedFromWorkFoldAgentTaskId?: string;
}): string {
  // Addressed Workers are deliberately outside the digest: they are a hint for
  // this turn's context, and a retry must replay even if one of them was
  // removed in between.
  return createHash("sha256").update(JSON.stringify({
    content: input.content,
    contextPaths: input.contextPaths,
    selectedPath: input.selectedPath,
    actorKind: input.actorKind ?? null,
    continuedFromWorkFoldAgentTaskId: input.continuedFromWorkFoldAgentTaskId ?? null,
    workFoldAgentAttachments: (input.workFoldAgentAttachments ?? []).map((attachment) => ({
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

async function createWorkFolderInternal(state: LocalApiState, name: string): Promise<WorkFolderSummary> {
  const workFolder = await createManagedWorkFolder(name, state.workFolderBase);
  state.workFolderTrustAuthority.grant(workFolder.workFolderRoot);
  publishControlHint(state, "work-folders");
  return workFolder;
}

async function registerWorkFolderInternal(state: LocalApiState, rootPath: string, providerHint?: "google-drive"): Promise<WorkFolderSummary> {
  const workFolder = await registerLinkedWorkFolder(rootPath, providerHint);
  state.workFolderTrustAuthority.grant(workFolder.workFolderRoot);
  // Copy-level note when a suspended automation's missing work-folder returns with its
  // portable identity; the automation stays suspended — registration never
  // silently re-arms standing behavior — so a failure to note it is tolerable.
  await state.automations.handleWorkFolderReRegistered(workFolder.id).catch(() => undefined);
  publishControlHint(state, "work-folders");
  return workFolder;
}

/** What a Recently deleted entry can still do, and why when it cannot go back. */
export interface WorkFoldRecentlyDeletedEntryView {
  id: string;
  kind: WorkFoldRecentlyDeletedKind;
  reason: WorkFoldRecentlyDeletedReason;
  workFolderId: string;
  workFolderName?: string;
  originalPath: string;
  name: string;
  sizeBytes: number;
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  receiptId: string | null;
  uncovered?: WorkFoldRecentlyDeletedUncoveredPath[];
  held?: { reason: "legacy-metadata" | "unreadable"; noticedAt: string };
  /**
   * `in-place` goes back where it came from; `save-only` can only be written
   * out as a file (app data whose app is gone); `blocked` cannot be brought
   * back at all right now, and `note` says why.
   */
  restorable: "in-place" | "save-only" | "blocked";
  note?: string;
}

export type WorkFoldRecentlyDeletedRestoreResult =
  /**
   * `safetyCheckpointId` is null when History could not record the restore
   * point. The content is back either way, and the entry is already gone, so
   * reporting the restore as a failure would be a lie that also removes the
   * thing the person would retry from.
   */
  | { kind: "file" | "folder"; entryId: string; workFolder: WorkFoldActWorkFolderRef; path: string; renamed: boolean; safetyCheckpointId: string | null }
  | { kind: "work-folder"; entryId: string; workFolder: WorkFoldActWorkFolderRef; workFolderRoot: string; renamed: boolean }
  | { kind: "app-storage"; entryId: string; workFolder: WorkFoldActWorkFolderRef; appId: string; usage: { revision: number; usageBytes: number } }
  | { kind: "saved-copy"; entryId: string; path: string };

/**
 * Whether an entry can go back where it came from, and the plain reason when
 * it cannot. App data only goes back into the same installation at the same
 * revision — work-fold never adopts one app's data into another
 * (docs/app-data-recovery.md) — so everything else is "save a copy".
 */
async function recentlyDeletedEntryView(
  state: LocalApiState,
  entry: WorkFoldRecentlyDeletedEntry,
  registered?: ReadonlySet<string>,
): Promise<WorkFoldRecentlyDeletedEntryView> {
  const base: WorkFoldRecentlyDeletedEntryView = {
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason,
    workFolderId: entry.workFolderId,
    ...(entry.workFolderName === undefined ? {} : { workFolderName: entry.workFolderName }),
    originalPath: entry.originalPath,
    name: entry.displayName ?? (entry.payload.kind === "tree" ? entry.payload.name : entry.payload.appId),
    sizeBytes: entry.sizeBytes,
    ...(entry.sizeApproximate ? { sizeApproximate: true as const } : {}),
    deletedAt: entry.deletedAt,
    restoreBy: entry.restoreBy,
    receiptId: entry.receiptId,
    ...(entry.uncovered ? { uncovered: entry.uncovered } : {}),
    ...(entry.held ? { held: entry.held } : {}),
    restorable: "in-place",
  };
  if (entry.kind === "file" || entry.kind === "folder") {
    if (isWorkFoldAgentConversationRecentlyDeletedEntry(entry)) return base;
    const present = registered ? registered.has(entry.workFolderId) : Boolean(await getWorkFolder(entry.workFolderId).catch(() => null));
    // A file or folder goes back into its own work-folder or nowhere: work-fold
    // never guesses another work-folder for someone's content.
    return present
      ? base
      : { ...base, restorable: "blocked", note: "The work-folder this came from is no longer registered." };
  }
  if (entry.kind === "work-folder") return base;
  if (entry.kind === "app-retained") {
    return { ...base, restorable: "save-only", note: "Retained app data has no app to go back into." };
  }
  const payload = entry.payload;
  if (payload.kind !== "app-data") return { ...base, restorable: "blocked" };
  const app = await state.restrictedApps.findByFeatureInstallation(entry.workFolderId, payload.featureInstallationId).catch(() => undefined);
  if (!app) return { ...base, restorable: "save-only", note: "That app is no longer installed." };
  if (app.digest !== payload.appDigest || app.dataNamespaceId !== payload.dataNamespaceId) {
    return { ...base, restorable: "save-only", note: "That app changed since this copy was kept." };
  }
  return base;
}

/**
 * Brings one Recently deleted entry back (docs/receipts-not-gates.md, F20).
 * A file or folder returns to its work-folder at its original path, renamed when
 * something else took the name, and the restore itself is History-undoable.
 * A work-folder's folder returns to the managed base and is re-registered with its
 * portable identity, so its Chats and History come with it. App data goes
 * back into the same installation at the same revision, or is saved as a
 * plain export file at an explicitly named path outside every work-folder.
 */
async function restoreRecentlyDeletedEntry(
  state: LocalApiState,
  id: string,
  context: { receiptId: string | null; toPath?: string },
): Promise<WorkFoldRecentlyDeletedRestoreResult> {
  if (!workFoldRecentlyDeletedEntryIdPattern.test(id)) {
    throw new WorkFoldCliError("usage", "That is not a Recently deleted item id.");
  }
  const entry = await state.recentlyDeleted.get(id).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  if (!entry) throw new WorkFoldCliError("notFound", "That item is no longer in Recently deleted.");
  if (entry.kind === "app-storage" || entry.kind === "app-retained") {
    return restoreRecentlyDeletedAppData(state, entry, context);
  }
  if (context.toPath !== undefined) {
    throw new WorkFoldCliError("usage", "'--to' saves a copy of app data; files, folders, and work-folders go back where they came from.");
  }
  if (entry.kind === "work-folder") return restoreRecentlyDeletedWorkFolder(state, entry);
  if (isWorkFoldAgentConversationRecentlyDeletedEntry(entry)) return restoreWorkFoldAgentConversationRecentlyDeletedEntry(state, entry);
  if (isWorkFolderConversationRecentlyDeletedEntry(entry)) return restoreWorkFolderConversationRecentlyDeletedEntry(state, entry);
  const workFolder = await getWorkFolder(entry.workFolderId).catch(() => null);
  if (!workFolder) {
    throw new WorkFoldCliError(
      "conflict",
      "The work-folder this came from is no longer registered, so there is nowhere to put it back. Register that work-folder again first.",
    );
  }
  const destination = resolveWorkFolderPath(workFolder.workFolderRoot, entry.originalPath);
  const restored = await state.recentlyDeleted.restoreTree(id, { absolutePath: destination }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  const relativePath = normalizeWorkFolderRelativePath(relative(workFolder.workFolderRoot, restored.restoredPath));
  // Restoring is additive, so its own undo is a restore point that removes
  // what came back — the same shape `files add` records. The tree is already
  // back and the entry is already gone by now, so a History failure here is
  // reported as a missing undo point, never as a failed restore: the
  // additive-write rollback helper is the wrong shape, because its rollback
  // would delete exactly the content just restored.
  const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
    deleteOnRestore: [relativePath],
    reason: "post_restore",
    label: `Before restoring ${basename(restored.restoredPath)} from Recently deleted`,
  }).catch(() => null);
  await touchWorkFolderRoot(workFolder.workFolderRoot).catch(() => undefined);
  publishControlHint(state, "work-folders");
  return {
    kind: entry.kind,
    entryId: entry.id,
    workFolder: toActWorkFolderRef(workFolder),
    path: relativePath,
    renamed: restored.renamed,
    safetyCheckpointId: safety?.checkpointId ?? null,
  };
}

function isWorkFoldAgentConversationRecentlyDeletedEntry(entry: WorkFoldRecentlyDeletedEntry): boolean {
  return entry.kind === "file"
    && entry.reason === "agent.chat.delete"
    && entry.workFolderId === workFoldAgentScopeId
    && /^\.work-fold\/conversations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(entry.originalPath);
}

function isWorkFolderConversationRecentlyDeletedEntry(entry: WorkFoldRecentlyDeletedEntry): boolean {
  return entry.kind === "file"
    && entry.reason === "chats.delete"
    && entry.workFolderId !== workFoldAgentScopeId
    && /^\.work-fold\/conversations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(entry.originalPath);
}

/**
 * A Worker Chat goes back into its own work-folder's `.work-fold/conversations/`
 * under the same transcript name, or nowhere: work-fold never guesses another
 * work-folder, and never collision-renames a transcript into a different identity.
 */
async function restoreWorkFolderConversationRecentlyDeletedEntry(
  state: LocalApiState,
  entry: WorkFoldRecentlyDeletedEntry,
): Promise<WorkFoldRecentlyDeletedRestoreResult> {
  const workFolder = await getWorkFolder(entry.workFolderId).catch(() => null);
  if (!workFolder) {
    throw new WorkFoldCliError(
      "conflict",
      "The folder this Chat came from is no longer registered, so there is nowhere to put it back. Add that folder again first.",
    );
  }
  const conversationId = basename(entry.originalPath, ".jsonl");
  return runActOperation(() => runConversationMutation(state, workFolder.id, conversationId, async () => {
    const destination = resolve(workFolder.workFolderRoot, entry.originalPath);
    if (!pathContainsPath(conversationsDir(workFolder.workFolderRoot), destination)) {
      throw new WorkFoldCliError("failure", "This Chat recovery item has an invalid destination.");
    }
    if (existsSync(destination)) {
      throw new WorkFoldCliError("conflict", "A Chat with this identity already exists. Remove that Chat before restoring this one.");
    }
    await mkdir(conversationsDir(workFolder.workFolderRoot), { recursive: true });
    const restored = await state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }).catch((error: unknown) => {
      throw recentlyDeletedCliError(error);
    });
    publishControlHint(state, "work-folders");
    return {
      kind: "file",
      entryId: entry.id,
      workFolder: toActWorkFolderRef(workFolder),
      path: `.work-fold/conversations/${basename(restored.restoredPath)}`,
      renamed: restored.renamed,
      // `.work-fold/` is excluded from History capture, so there is no restore point.
      safetyCheckpointId: null,
    };
  }));
}

async function restoreWorkFoldAgentConversationRecentlyDeletedEntry(
  state: LocalApiState,
  entry: WorkFoldRecentlyDeletedEntry,
): Promise<WorkFoldRecentlyDeletedRestoreResult> {
  const root = workFoldAgentRoot();
  const destination = resolve(root, entry.originalPath);
  if (!pathContainsPath(root, destination)) {
    throw new WorkFoldCliError("failure", "This work-fold agent Chat recovery item has an invalid destination.");
  }
  // A transcript filename is the Chat identity. Unlike ordinary work-folder files,
  // collision-renaming it would create an invalid or different conversation,
  // so leave the recovery item intact until the current Chat is removed.
  if (existsSync(destination)) {
    throw new WorkFoldCliError("conflict", "A Chat with this identity already exists. Remove that Chat before restoring this one.");
  }
  const restored = await state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  return {
    kind: "file",
    entryId: entry.id,
    workFolder: { id: workFoldAgentScopeId, name: "work-fold agent", workFolderRoot: root },
    path: `.work-fold/conversations/${basename(restored.restoredPath)}`,
    renamed: restored.renamed,
    // Management Chats are machine-local and never belong to work-folder History.
    safetyCheckpointId: null,
  };
}

async function restoreRecentlyDeletedWorkFolder(state: LocalApiState, entry: WorkFoldRecentlyDeletedEntry): Promise<WorkFoldRecentlyDeletedRestoreResult> {
  // A portable identity that is registered somewhere else is a real conflict:
  // work-fold never adopts one work-folder's records into another folder.
  if ((await listWorkFolders()).some((workFolder) => workFolder.id === entry.workFolderId)) {
    throw new WorkFoldCliError(
      "conflict",
      `A work-folder with this identity is already registered. Remove that registration before restoring "${entry.workFolderName ?? entry.originalPath}".`,
    );
  }
  const restored = await state.recentlyDeleted.restoreTree(entry.id, {
    absolutePath: entry.originalPath,
    stateDirFor: (finalPath) => workFolderStateDir(finalPath),
  }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  let workFolder: WorkFolderSummary;
  try {
    workFolder = await registerManagedWorkFolder(
      restored.restoredPath,
      entry.workFolderName ?? basename(restored.restoredPath),
      state.workFolderBase,
    );
  } catch (error) {
    // The folder is back on disk with its portable identity; only the
    // registration failed, so say where it is instead of implying it is lost.
    throw new WorkFoldCliError(
      "conflict",
      `The folder is back at ${restored.restoredPath}, but work-fold could not register it as a work-folder: ${errorMessage(error)} `
        + "Use existing folder in Manage work-folders to finish bringing it back.",
      { cause: error },
    );
  }
  state.workFolderTrustAuthority.grant(workFolder.workFolderRoot);
  await state.automations.handleWorkFolderReRegistered(workFolder.id).catch(() => undefined);
  publishControlHint(state, "work-folders");
  return {
    kind: "work-folder",
    entryId: entry.id,
    workFolder: toActWorkFolderRef(workFolder),
    workFolderRoot: workFolder.workFolderRoot,
    renamed: restored.renamed,
  };
}

async function restoreRecentlyDeletedAppData(
  state: LocalApiState,
  entry: WorkFoldRecentlyDeletedEntry,
  context: { toPath?: string },
): Promise<WorkFoldRecentlyDeletedRestoreResult> {
  const payload = entry.payload;
  if (payload.kind !== "app-data") throw new WorkFoldCliError("failure", "This item is not app data.");
  const backup = await state.recentlyDeleted.readAppData(entry.id).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  if (context.toPath !== undefined) {
    const saved = await saveRecentlyDeletedAppDataCopy(backup, context.toPath);
    await state.recentlyDeleted.remove(entry.id).catch(() => undefined);
    return { kind: "saved-copy", entryId: entry.id, path: saved };
  }
  const view = await recentlyDeletedEntryView(state, entry);
  if (view.restorable === "save-only") {
    throw new WorkFoldCliError(
      "conflict",
      `${view.note ?? "This app's data has no app to go back into."} `
        + "Save a copy from Settings → Recently deleted, or with 'recently-deleted restore --entry "
        + `${entry.id} --to <absolute-file-path>'.`,
    );
  }
  const workFolder = await getWorkFolder(entry.workFolderId);
  const app = await state.restrictedApps.findByFeatureInstallation(entry.workFolderId, payload.featureInstallationId);
  if (!app) throw new WorkFoldCliError("conflict", "That app is no longer installed.");
  const usage = await runRestrictedAppMutation(state, workFolder.id, async () => {
    const current = await state.restrictedApps.storageUsage(workFolder.id, app.manifest.id, app.digest, app.featureInstallationId);
    return state.restrictedApps.restoreStorage({
      workFolderId: workFolder.id,
      appId: app.manifest.id,
      featureInstallationId: app.featureInstallationId,
      expectedDigest: app.digest,
      expectedRevision: current.revision,
      backup,
    });
  });
  await state.recentlyDeleted.remove(entry.id).catch(() => undefined);
  return {
    kind: "app-storage",
    entryId: entry.id,
    workFolder: toActWorkFolderRef(workFolder),
    appId: app.manifest.id,
    usage: { revision: usage.revision, usageBytes: usage.usageBytes },
  };
}

/**
 * "Save a copy": the verified export is written to an absolute path the
 * person named, deliberately outside every work-folder and outside work-fold's own
 * state, so a recovery file never becomes agent context by accident.
 */
async function saveRecentlyDeletedAppDataCopy(backup: RestrictedAppDataBackup, toPath: string): Promise<string> {
  const destination = resolve(toPath.trim());
  if (!isAbsolute(toPath.trim())) throw new WorkFoldCliError("usage", "'--to' needs an absolute file path.");
  const stateRoot = resolve(workFoldStateRoot());
  if (destination === stateRoot || destination.startsWith(`${stateRoot}${sep}`)) {
    throw new WorkFoldCliError("usage", "Save the copy somewhere of your own, not inside work-fold's own files.");
  }
  for (const workFolder of await listWorkFolders()) {
    const root = resolve(workFolder.workFolderRoot);
    if (destination === root || destination.startsWith(`${root}${sep}`)) {
      throw new WorkFoldCliError(
        "usage",
        `Save the copy outside your work-folders; ${workFolder.name} would pick it up as content. Use 'files add' if you want it in a work-folder.`,
      );
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(backup, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return destination;
}

/** Store failures become the act lane's typed errors; nothing leaks a stack. */
function recentlyDeletedCliError(error: unknown): WorkFoldCliError {
  if (!(error instanceof WorkFoldRecentlyDeletedError)) {
    return new WorkFoldCliError("failure", errorMessage(error), { cause: error });
  }
  const code = error.code === "NOT_FOUND"
    ? "notFound"
    : error.code === "INPUT_INVALID"
      ? "usage"
      : error.code === "HELD"
        ? "conflict"
        : "failure";
  return new WorkFoldCliError(code, error.message, { cause: error });
}

/**
 * The one work-folder-removal path, shared by the desktop DELETE route, the
 * `work-folder.delete-folder` prepared act behind `work-folders delete`, and the act
 * facade's `work-folders unregister`:
 * App Studio impact checks, the durable removal intent, runtime-authorization
 * revocation, per-service app-state cleanup with the crash-safe pending
 * result, and finalization. A linked registration removal always leaves the
 * folder and its portable `.work-fold/` identity in place; a managed work-folder
 * deletes its folder tree unless the caller passes the preserve disposition
 * (the act lane's `work-folders unregister`), which records an intent that provably
 * holds no deletion authority.
 */
/**
 * The managed-deletion seam of docs/receipts-not-gates.md F20: the folder the
 * removal machinery has already claimed by exact identity is *moved* into
 * Recently deleted with the work-folder's machine-local History state, never
 * erased. Everything about the claim-verified removal above it is unchanged —
 * this only replaces the final erase.
 *
 * An injected `removeClaimedManagedRoot`/`removeWorkFolderState` still wins, so
 * the removal-atomicity failure-injection seams keep working, and a preserve
 * removal (`work-folders unregister`) never reaches the claim path at all: its
 * state directory is removed exactly as before.
 */
function managedWorkFolderRemovalIo(
  recentlyDeleted: WorkFoldRecentlyDeletedStore,
  overrides: Partial<WorkFolderRemovalIo>,
  context: { workFolderId: string; workFolderRoot: string; workFolderName?: string; receiptId: string | null; managedDeletion: boolean },
): { io: Partial<WorkFolderRemovalIo>; entry: () => WorkFoldRecentlyDeletedEntry | null } {
  let entry: WorkFoldRecentlyDeletedEntry | null = null;
  const io: Partial<WorkFolderRemovalIo> = {
    ...overrides,
    removeClaimedManagedRoot: overrides.removeClaimedManagedRoot ?? (async (claimPath) => {
      const workFolderName = context.workFolderName ?? await claimedWorkFolderName(claimPath) ?? basename(context.workFolderRoot);
      entry = await recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "work-folder",
        reason: "work-folders.delete",
        sourcePath: claimPath,
        workFolderId: context.workFolderId,
        workFolderName,
        originalPath: context.workFolderRoot,
        receiptId: context.receiptId,
        stateDirPath: workFolderStateDir(context.workFolderRoot),
      });
    }),
    removeWorkFolderState: async (workFolderRoot) => {
      // The folder's move already carried the History state into the entry.
      if (entry) return;
      if (overrides.removeWorkFolderState) return overrides.removeWorkFolderState(workFolderRoot);
      // On restart the claimed folder may already have reached Recently
      // deleted while its History directory is still at the old state path.
      // Recover that second move before committing removal; never erase the
      // remaining History when its destination cannot be proved.
      if (context.managedDeletion && !overrides.removeClaimedManagedRoot && existsSync(workFolderStateDir(workFolderRoot))) {
        const listing = await recentlyDeleted.list();
        const matching = listing.entries.filter((item) => item.kind === "work-folder"
          && item.reason === "work-folders.delete"
          && item.workFolderId === context.workFolderId
          && workFolderRootKey(item.originalPath) === workFolderRootKey(context.workFolderRoot));
        if (matching.length !== 1 || listing.damaged.length) {
          throw new Error("The deleted work-folder's History could not be matched to one intact Recently deleted entry. It was kept at its original state path.");
        }
        entry = await recentlyDeleted.attachWorkFolderState(matching[0]!.id, workFolderStateDir(workFolderRoot));
        return;
      }
      await rm(workFolderStateDir(workFolderRoot), { recursive: true, force: true });
    },
  };
  return { io, entry: () => entry };
}

/** Best-effort display name for a folder already claimed for removal. */
async function claimedWorkFolderName(claimPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(claimPath, ".work-fold", "work-folder.json"), "utf8")
      .catch(() => readFile(join(claimPath, ".work-fold", "space.json"), "utf8"));
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function removeWorkFolderRegistrationInternal(
  state: LocalApiState,
  workFolder: WorkFolderSummary,
  options: { managedFolderDisposition?: "delete" | "preserve"; receiptId?: string | null } = {},
): Promise<WorkFolderRemovalResult & {
  recentlyDeleted: { entryId: string; restoreBy: string } | null;
  appRecentlyDeletedEntries: Array<{ entryId: string; restoreBy: string }>;
}> {
  const affectedWorkFolderIds = await state.restrictedApps.workFolderRemovalMutationWorkFolderIds(workFolder.id);
  // A preserve removal keeps the folder, so it keeps the plain state-directory
  // removal; a delete removal sends the claimed folder to Recently deleted.
  const removal = options.managedFolderDisposition === "preserve"
    ? { io: state.workFolderRemovalIo, entry: () => null as WorkFoldRecentlyDeletedEntry | null }
    : managedWorkFolderRemovalIo(state.recentlyDeleted, state.workFolderRemovalIo, {
      workFolderId: workFolder.id,
      workFolderRoot: workFolder.workFolderRoot,
      workFolderName: workFolder.name,
      receiptId: options.receiptId ?? null,
      managedDeletion: workFolder.location.storage === "managed",
    });
  // Removing the work-folder removes every preview app installed in it, and that
  // takes each app's data with it. A copy of each reaches Recently deleted
  // before the registry drops them (docs/receipts-not-gates.md, F20), so
  // restoring the folder never restores a work-folder whose app data is gone. The
  // entry ids ride on the result so the `work-folders delete` receipt names them.
  const appEntries: WorkFoldRecentlyDeletedEntry[] = [];
  const withRecentlyDeleted = <T extends WorkFolderRemovalResult>(result: T): T & {
    recentlyDeleted: { entryId: string; restoreBy: string } | null;
    appRecentlyDeletedEntries: Array<{ entryId: string; restoreBy: string }>;
  } => {
    const entry = removal.entry();
    return {
      ...result,
      recentlyDeleted: entry ? { entryId: entry.id, restoreBy: entry.restoreBy } : null,
      appRecentlyDeletedEntries: appEntries.map((item) => ({ entryId: item.id, restoreBy: item.restoreBy })),
    };
  };
  return runRestrictedAppMutations(state, affectedWorkFolderIds, () => runSettledWorkFolderDeletion(state, workFolder.id, async () => {
    const releaseCheckRemoval = state.checks.tryReserveWorkFolderRemoval(workFolder.id);
    if (!releaseCheckRemoval) throw httpError(409, "Wait for the current Check operation before removing this work-folder.");
    try {
      const impact = await state.restrictedApps.workFolderRemovalImpact(workFolder.id);
      if (impact.activeSourceInstanceCount > 0 || impact.activeTargetInstanceCount > 0) {
        throw badRequest("Uninstall release-backed Apps from this work-folder before removing it.");
      }
      if (impact.retainedDataCount > 0) {
        throw badRequest("Purge this App Project's retained local data in App Studio before removing its source work-folder.");
      }
      // Outward exposure blocks removal: a page served from this work-folder must be
      // revoked first, and a damaged publication store cannot prove the work-folder
      // is unpublished, so both refuse here before any state changes.
      let livePublications;
      try {
        livePublications = await state.publications.activePublicationsForWorkFolder(workFolder.id);
      } catch (error) {
        throw httpError(409, errorMessage(error));
      }
      if (livePublications.length) {
        const named = livePublications.slice(0, 3).map((publication) => `"${publication.title}"`).join(", ");
        const more = livePublications.length > 3 ? ", …" : "";
        throw badRequest(
          `Stop sharing ${livePublications.length === 1 ? "the page" : `${livePublications.length} pages`} `
            + `served from this work-folder before removing it: ${named}${more}.`,
        );
      }
      const intent = await beginWorkFolderRemoval(workFolder.id, state.workFolderBase, removal.io, {
        ...(options.managedFolderDisposition ? { folderDisposition: options.managedFolderDisposition } : {}),
      });
      state.restrictedApps.fenceWorkFolderRemoval(workFolder.id);
      state.workFolderTrustAuthority.revoke(workFolder.workFolderRoot);
      state.workFolderIdsByRoot.delete(workFolderRootKey(workFolder.workFolderRoot));
      await invalidateWorkFoldClients(state, workFolder.id);
      closeWorkFolderStreams(state, workFolder.id);
      for (const request of [...state.extensionRequests.values()]) {
        if (request.workFolderRoot !== workFolder.workFolderRoot) continue;
        state.extensionUi.cancel(request.id);
        state.extensionRequests.delete(request.id);
      }
      try {
        await state.checks.removeWorkFolder(workFolder.id);
      } catch {
        return withRecentlyDeleted(await workFolderRemovalPendingResult(intent));
      }
      // The same revocation moment as Check authority: enabled automations
      // referencing this work-folder suspend (their active runs stop). Suspension
      // failing leaves the durable intent pending — startup retries the
      // cascade.
      try {
        await state.automations.handleWorkFolderRemoved(workFolder.id);
      } catch {
        return withRecentlyDeleted(await workFolderRemovalPendingResult(intent));
      }
      try {
        for (const app of await state.restrictedApps.list(workFolder.id)) {
          const entry = await moveAppStorageExportToRecentlyDeleted(state, app, "apps.work-folder.removed", options.receiptId ?? null, { skipWhenStorageUnavailable: true });
          if (entry) appEntries.push(entry);
        }
        await state.restrictedApps.removeWorkFolder(workFolder.id);
        await state.restrictedAppProposals.removeWorkFolder(workFolder.id);
      } catch {
        return withRecentlyDeleted(await workFolderRemovalPendingResult(intent));
      }
      try {
        await markWorkFolderRemovalAppStateRemoved(intent.workFolderId, removal.io);
      } catch {
        return withRecentlyDeleted(await workFolderRemovalPendingResult(intent));
      }
      const result = await finalizeWorkFolderRemoval(intent.workFolderId, removal.io);
      if (!result.cleanupPending) await state.appearance.removeWorkFolder(workFolder.id);
      if (!result.cleanupPending) state.restrictedApps.releaseWorkFolderRemovalFence(workFolder.id);
      return withRecentlyDeleted(result);
    } finally {
      releaseCheckRemoval();
      publishControlHint(state, "work-folders");
    }
  }), { requiredWorkFolderIds: [workFolder.id] });
}

/**
 * Dedicated remote semantic adapter. The desktop relay can invoke only these
 * bounded operations; it never receives the renderer session token or a
 * generic local-HTTP tunnel. Every agent send still enters the canonical
 * work-fold agent through the shared acceptance path.
 */
function createWorkFoldRemoteFacade(state: LocalApiState): WorkFoldRemoteFacade {
  const maximumRemoteLiveAssistantChars = 256 * 1024;
  /**
   * Bounded live watch (management.watch): subscribes to the same in-process
   * publish point the local SSE streams ride, forwards the popover's activity
   * vocabulary plus a bounded live agent-text projection, and resolves on
   * settle or when the watch window closes — always under the remote operation
   * timeout so the browser is never left waiting on a dead watch.
   */
  async function watchWorkFoldAgentTurn(
    rawInput: unknown,
    principal: WorkFoldRemotePrincipal,
    emit: (progress: WorkFoldRemoteWatchProgress) => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertRemotePrincipal(principal);
    const input = remoteInput(rawInput);
    assertRemoteKeys(input, ["conversationId"]);
    assertWorkFoldAgentReadyForRoutes(state);
    const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
    const conversation = await readConversationSummary(workFoldAgentRoot(), conversationId);
    if (!conversation) throw notFound("Conversation not found.");
    const key = streamKey(workFoldAgentScopeId, conversationId);
    if (signal?.aborted) return { state: "cancelled", settled: false };
    if (!state.runningTurns.has(key)) return { state: "idle", settled: false };
    return new Promise((resolveWatch) => {
      const watchWindowMs = 90_000;
      const minimumActivityTickMs = 1_000;
      const minimumTextTickMs = 100;
      let lastActivity = "";
      let lastActivityEmitAt = 0;
      let lastTextEmitAt = 0;
      let pendingActivity: string | null = null;
      let pendingAssistantDelta = "";
      let emittedAssistantChars = 0;
      let activityTimer: NodeJS.Timeout | null = null;
      let textTimer: NodeJS.Timeout | null = null;
      let windowTimer: NodeJS.Timeout | null = null;
      const listeners = state.chatEventListeners.get(key) ?? new Set<(event: unknown) => void>();
      state.chatEventListeners.set(key, listeners);
      let finished = false;
      const finish = (result: { state: "settled" | "running" | "cancelled"; settled: boolean }) => {
        if (finished) return;
        finished = true;
        listeners.delete(listener);
        if (!listeners.size) state.chatEventListeners.delete(key);
        signal?.removeEventListener("abort", onAbort);
        if (windowTimer) clearTimeout(windowTimer);
        if (activityTimer) clearTimeout(activityTimer);
        if (textTimer) clearTimeout(textTimer);
        resolveWatch(result);
      };
      const onAbort = () => finish({ state: "cancelled", settled: false });
      const flushActivity = () => {
        activityTimer = null;
        if (pendingActivity === null || pendingActivity === lastActivity) { pendingActivity = null; return; }
        lastActivity = pendingActivity;
        pendingActivity = null;
        lastActivityEmitAt = Date.now();
        emit({ activity: lastActivity });
      };
      const queueActivity = (activity: string) => {
        pendingActivity = activity;
        if (activityTimer) return;
        activityTimer = setTimeout(flushActivity, Math.max(0, minimumActivityTickMs - (Date.now() - lastActivityEmitAt)));
      };
      const flushAssistantDelta = () => {
        textTimer = null;
        if (!pendingAssistantDelta) return;
        const assistantDelta = pendingAssistantDelta;
        pendingAssistantDelta = "";
        lastTextEmitAt = Date.now();
        emit({
          assistantDelta,
          ...(emittedAssistantChars >= maximumRemoteLiveAssistantChars ? { assistantTextTruncated: true } : {}),
        });
      };
      const queueAssistantDelta = (delta: string) => {
        const remaining = maximumRemoteLiveAssistantChars - emittedAssistantChars;
        if (remaining <= 0) return;
        const admitted = delta.slice(0, remaining);
        if (!admitted) return;
        pendingAssistantDelta += admitted;
        emittedAssistantChars += admitted.length;
        if (textTimer) return;
        textTimer = setTimeout(flushAssistantDelta, Math.max(0, minimumTextTickMs - (Date.now() - lastTextEmitAt)));
      };
      const listener = (event: unknown) => {
        if (!event || typeof event !== "object") return;
        const data = event as { type?: unknown; message?: unknown; text?: unknown; toolName?: unknown; running?: unknown };
        if (data.type === "status" || data.type === "tool") {
          const message = typeof data.message === "string" && data.message !== "Connected." ? data.message.trim() : "";
          const tool = data.type === "tool" && typeof data.toolName === "string" ? data.toolName.trim() : "";
          const activity = message || tool;
          if (activity) queueActivity(activity);
          return;
        }
        if (data.type === "assistant_delta" && typeof data.text === "string") {
          queueAssistantDelta(data.text);
          return;
        }
        if (data.type === "assistant_message" && typeof data.text === "string") {
          const assistantText = data.text.slice(0, maximumRemoteLiveAssistantChars);
          emittedAssistantChars = assistantText.length;
          pendingAssistantDelta = "";
          if (textTimer) { clearTimeout(textTimer); textTimer = null; }
          lastTextEmitAt = Date.now();
          emit({
            assistantText,
            ...(data.text.length > assistantText.length ? { assistantTextTruncated: true } : {}),
          });
          return;
        }
        if (data.type === "done" || data.type === "error" || (data.type === "turn_state" && data.running === false)) {
          if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
          if (textTimer) { clearTimeout(textTimer); textTimer = null; }
          flushActivity();
          flushAssistantDelta();
          finish({ state: "settled", settled: true });
        }
      };
      listeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      windowTimer = setTimeout(() => finish({ state: "running", settled: false }), watchWindowMs);
      const initialAssistantText = chatEventLog(state, key).assistantText;
      if (initialAssistantText) {
        const assistantText = initialAssistantText.slice(0, maximumRemoteLiveAssistantChars);
        emittedAssistantChars = assistantText.length;
        lastTextEmitAt = Date.now();
        emit({
          assistantText,
          ...(initialAssistantText.length > assistantText.length ? { assistantTextTruncated: true } : {}),
        });
      }
      // The turn can settle between the running check and this subscription.
      if (!state.runningTurns.has(key)) finish({ state: "settled", settled: true });
    });
  }
  return {
    async purgeUploads(grantId) {
      const root = remoteWorkFoldAgentUploadRoot(workFoldAgentRoot());
      if (!grantId) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      await rm(join(root, safeRemoteUploadSegment(grantId)), { recursive: true, force: true });
    },
    async revokeGrantAuthority(grantId) {
      // Browser revocation's desktop-local cascade: the browser's app actions
      // settle, and the grant's `remote:<grantId>` overview marker goes with the
      // rest of its state (docs/work-fold-agent-overview.md). Acts the browser already
      // performed stand; their receipts name the browser that made them.
      // Every lane is attempted so one failure cannot silently skip the rest.
      const failures: string[] = [];
      try { await state.browserAppActions.revoke(grantId); }
      catch { failures.push("Could not settle the browser's app actions."); }
      try {
        if (grantId !== undefined) {
          await state.overviewSeen.removeSurface(workFoldOverviewRemoteSurfaceId(grantId));
        } else {
          const seen = await state.overviewSeen.read();
          for (const surfaceId of Object.keys(seen.surfaces)) {
            if (surfaceId.startsWith("remote:")) await state.overviewSeen.removeSurface(surfaceId);
          }
        }
      } catch (error) {
        failures.push(`Could not remove the browser's overview marker: ${errorMessage(error)}`);
      }
      if (failures.length) throw new Error(failures.join(" "));
    },
    watch: watchWorkFoldAgentTurn,
    async execute(operation, rawInput, principal, authority) {
      assertRemotePrincipal(principal);
      const input = remoteInput(rawInput);
      switch (operation) {
        case "management.summary": {
          assertRemoteKeys(input, ["conversationId"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const requestedConversationId = input.conversationId === undefined
            ? null
            : remoteStableId(input.conversationId, "conversation id", 160);
          const conversation = requestedConversationId
            ? await readConversationSummary(workFoldAgentRoot(), requestedConversationId)
            : await resolveWorkFoldAgentConversation(false).catch(() => null);
          if (requestedConversationId && !conversation) throw notFound("Conversation not found.");
          const latest = conversation
            ? state.requests.latestForConversation(conversation.id)
            : null;
          const owned = latest ? isRemoteWorkFoldAgentRequestOwner(latest, principal) : false;
          return {
            available: true,
            conversation: conversation ? toActConversationRef(conversation) : null,
            state: conversation ? conversationRuntimeState(state, workFoldAgentScopeId, conversation.id) : "idle",
            latestRequest: latest
              ? remoteWorkFoldAgentRequest(await workFoldAgentRequestView(state, latest.turns.at(-1)!.taskId), { owned })
              : null,
            // Capability advertisement: the browser starts a live watch only
            // after seeing this, so an older desktop is never asked for an
            // operation it cannot answer.
            capabilities: { watch: true, work: true, extensionUi: true, delete: true, sharedPages: true, filePreview: true, appViews: true },
            extensionRequests: owned && latest ? remoteExtensionRequests(state, latest) : [],
          };
        }
        case "management.chats": {
          assertRemoteKeys(input, []);
          assertWorkFoldAgentReadyForRoutes(state);
          const conversations = await listConversations(workFoldAgentRoot());
          const selected = conversations.slice(0, maxRemoteConversationSummaries);
          return {
            conversations: await Promise.all(selected.map(async (conversation) => {
              const record = state.requests.latestForConversation(conversation.id);
              return {
                ...toActConversationRef(conversation),
                state: remoteWorkFoldAgentConversationState(state, conversation.id),
                ...(record && isRemoteWorkFoldAgentRequestOwner(record, principal)
                  ? await workFoldAgentConversationAttention(state, conversation.id) : {}),
              };
            })),
            truncated: selected.length < conversations.length,
            capabilities: { sharedPages: true, filePreview: true, appViews: true },
          };
        }
        case "management.transcript": {
          assertRemoteKeys(input, ["conversationId"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
          const messages = await readConversation(workFoldAgentRoot(), conversationId);
          if (!messages.length) throw notFound("Conversation not found.");
          return remoteTranscript(messages);
        }
        case "management.rename": {
          assertRemoteKeys(input, ["conversationId", "title"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
          const key = clientKey(workFoldAgentScopeId, conversationId);
          const title = remoteConversationTitle(input.title);
          const provenance = {
            source: "remote_web" as const,
            remotePrincipalId: principal.browserId,
            remoteGrantId: principal.grantId,
            remoteRequestId: principal.requestId,
          };
          const replay = await findRemoteConversationTitleRename(
            workFoldAgentRoot(),
            conversationId,
            provenance,
          );
          const conversation = replay ?? await renameWorkFoldAgentConversation(state, conversationId, title, provenance);
          if (!replay) state.clients.get(key)?.setSessionName(conversation.title);
          return {
            conversation: toActConversationRef(conversation),
            state: conversationRuntimeState(state, workFoldAgentScopeId, conversationId),
          };
        }
        case "management.delete": {
          assertRemoteKeys(input, ["conversationId"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const conversationId = remoteStableId(input.conversationId, "conversation id", 160);
          const receiptId = remoteWorkFoldAgentDeleteReceiptId(principal);
          const replay = await findRemoteWorkFoldAgentDeleteReplay(state, conversationId, receiptId);
          if (replay) return { deleted: replay };
          if (!await state.actReceipts.append({
            requestId: receiptId,
            command: "management.delete",
            conversationId,
            outcome: "accepted",
            surface: "remote_web",
            browserId: principal.browserId,
            grantId: principal.grantId,
          })) throw httpError(503, "Could not record this deletion. Please try again.");
          let deleted: { conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } };
          try {
            deleted = await deleteWorkFoldAgentConversation(state, conversationId, { receiptId });
          } catch (error) {
            await state.actReceipts.append({
              requestId: receiptId,
              command: "management.delete",
              conversationId,
              outcome: "error",
              detail: errorMessage(error),
              surface: "remote_web",
              browserId: principal.browserId,
              grantId: principal.grantId,
            }).catch(() => false);
            throw error;
          }
          await state.actReceipts.append({
            requestId: receiptId,
            command: "management.delete",
            conversationId,
            outcome: "ok",
            detail: JSON.stringify(deleted),
            surface: "remote_web",
            browserId: principal.browserId,
            grantId: principal.grantId,
          }).catch(() => false);
          return { deleted };
        }
        case "management.send": {
          assertRemoteKeys(input, ["content", "conversationId", "newConversation", "attachments"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const content = remoteContent(input.content);
          const scope = workFoldAgentScopeForRoutes(state);
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
              : await resolveWorkFoldAgentConversation(true);
          if (!conversation) throw notFound("Conversation not found.");
          const latest = state.requests.latestForConversation(conversation.id);
          const latestView = latest ? await workFoldAgentRequestView(state, latest.turns.at(-1)!.taskId) : null;
          const continuedFromWorkFoldAgentTaskId = latestView?.phase === "needs_you" ? latestView.taskId : undefined;
          const continuedRequestId = continuedFromWorkFoldAgentTaskId ? latest?.requestId : undefined;
          const staged = await stageRemoteWorkFoldAgentUploads(
            scope.rootPath,
            input.attachments,
            principal.grantId,
            principal.requestId,
          );
          try {
            const { message, taskId } = await acceptConversationTurn(
              state,
              { id: scope.id, workFolderRoot: scope.rootPath },
              conversation.id,
              {
                content,
                contextPaths: [],
                selectedPath: null,
                actorKind: "renderer",
                workFoldAgentAttachments: staged.attachments,
                ...(continuedFromWorkFoldAgentTaskId ? { continuedFromWorkFoldAgentTaskId } : {}),
                ...(continuedRequestId ? { request: { joinRequestId: continuedRequestId } } : {}),
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
        case "management.extensionAnswer": {
          assertRemoteKeys(input, ["taskId", "id", "value", "cancelled"]);
          const taskId = remoteStableId(input.taskId, "task id", 160);
          const id = remoteStableId(input.id, "Extension question id", 160);
          assertRemoteWorkFoldAgentRequestOwner(state, taskId, principal);
          const record = state.requests.byTaskId(taskId)!;
          if (!remoteExtensionRequests(state, record).some((item) => item.id === id && item.taskId === taskId)) {
            throw notFound("This Extension question has ended or is available only on the desktop.");
          }
          authority?.assertCurrent();
          return { accepted: answerExtensionRequest(state, { workFolderRoot: workFoldAgentRoot(), conversationId: record.owner.conversationId }, id, input) };
        }
        case "management.work":
        case "management.answer":
        case "management.continue": {
          assertRemoteKeys(input, operation === "management.work" ? ["taskId"]
            : operation === "management.answer" ? ["taskId", "questionId", "answer"] : ["taskId", "deliveryId"]);
          const taskId = remoteStableId(input.taskId, "task id", 160);
          const record = state.requests.byTaskId(taskId);
          if (!record) throw notFound("This work is no longer on record.");
          assertRemoteWorkOwner(state, record, principal);
          if (operation !== "management.work") {
            authority?.assertCurrent();
            await performWorkAction(state, record, operation === "management.answer" ? "answer" : "continue", input, principal);
          }
          return { work: await requestPresentation(state, state.requests.get(record.requestId)!, true) };
        }
        case "management.request": {
          assertRemoteKeys(input, ["taskId"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const taskId = remoteStableId(input.taskId, "task id", 160);
          assertRemoteWorkFoldAgentRequestOwner(state, taskId, principal);
          const request = await workFoldAgentRequestView(state, taskId);
          if (!request) throw notFound(`Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
          return { request: remoteWorkFoldAgentRequest(request, { owned: true }) };
        }
        case "management.stop": {
          assertRemoteKeys(input, ["taskId"]);
          assertWorkFoldAgentReadyForRoutes(state);
          const taskId = remoteStableId(input.taskId, "task id", 160);
          const record = state.requests.byTaskId(taskId);
          if (!record) throw notFound("This work is no longer on record.");
          assertRemoteWorkOwner(state, record, principal);
          return { stopped: await stopWorkFoldAgentRequest(state, taskId) };
        }
        case "management.glance": {
          // App-composed digest over recorded state (docs/work-fold-agent-overview.md).
          // Cross-grant hygiene: the projection carries only the requesting
          // grant's own seen marker, so one phone never reads another's
          // acknowledgements. No management-readiness gate — the digest stays
          // available even when management commands fail closed.
          assertRemoteKeys(input, []);
          const snapshot = await state.kernel.getOverview({ kind: "renderer" });
          const surfaceId = workFoldOverviewRemoteSurfaceId(principal.grantId);
          return {
            overview: {
              ...snapshot,
              needsYou: snapshot.needsYou.map((item) => {
                const request = item.ref?.requestId ? state.requests.get(item.ref.requestId) : null;
                const root = request ? state.requests.get(request.rootId) : null;
                return { ...item, canOpenWork: Boolean(root && !root.owner.workFolderId && isRemoteWorkFoldAgentRequestOwner(root, principal)) };
              }),
              seen: surfaceId in snapshot.seen ? { [surfaceId]: snapshot.seen[surfaceId] } : {},
            },
          };
        }
        case "management.glanceSeen": {
          // Advances only this grant's own `remote:<grantId>` marker, and only
          // monotonically — a replayed or reordered advance is a no-op, and a
          // refused advance merely leaves items rendering as new.
          assertRemoteKeys(input, ["cursor"]);
          if (typeof input.cursor !== "string" || !parseWorkFoldOverviewCursor(input.cursor)) {
            throw badRequest("A rendered overview cursor is required to mark seen.");
          }
          return await state.overviewSeen.advance(workFoldOverviewRemoteSurfaceId(principal.grantId), input.cursor);
        }
        case "pages.list": {
          assertRemoteKeys(input, []);
          const pages = (await state.publications.list()).filter((page) => page.state === "active").slice(0, 32);
          return { pages: pages.map(({ publicationId, title, kind, health, snapshotEnabled }) => ({ publicationId, title, kind, health, snapshotEnabled })) };
        }
        case "pages.link": {
          assertRemoteKeys(input, ["publicationId"]);
          const publicationId = remoteStableId(input.publicationId, "Publication id", 128);
          return state.publications.revealLink(publicationId);
        }
        case "work-folders.list": {
          assertRemoteKeys(input, []);
          const workFolders = (await state.kernel.getWorkFolders({ kind: "renderer" })).workFolders;
          return { workFolders: workFolders.map((workFolder) => ({ id: workFolder.id, name: workFolder.name })), capabilities: { filePreview: true, appViews: true } };
        }
        case "apps.list": {
          assertRemoteKeys(input, ["workFolderId"]);
          const workFolderId = remoteStableId(input.workFolderId, "work-folder id", 512);
          await getWorkFolder(workFolderId);
          const apps = await state.restrictedApps.list(workFolderId);
          await getWorkFolder(workFolderId);
          return { apps: apps.slice(0, 64).map((app) => ({
            workFolderId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId,
            digest: app.digest, authorityDigest: restrictedAppTaskAuthorityDigest(app.authority),
            title: app.manifest.title, version: app.version, preview: app.runtimeInstanceKind === "development",
            webView: Boolean(app.manifest.viewer),
            actions: Boolean(app.manifest.viewer && app.manifest.runtime.worker && app.manifest.tools.length),
          })), truncated: apps.length > 64 };
        }
        case "apps.read": {
          assertRemoteKeys(input, ["workFolderId", "appId", "featureInstallationId", "digest", "authorityDigest", "call"]);
          const scope = {
            workFolderId: remoteStableId(input.workFolderId, "work-folder id", 512),
            appId: remoteStableId(input.appId, "App id", 160),
            featureInstallationId: remoteStableId(input.featureInstallationId, "App installation", 160),
            digest: remoteStableId(input.digest, "App revision", 64),
            authorityDigest: remoteStableId(input.authorityDigest, "App authority", 64),
          };
          const workFolder = await getWorkFolder(scope.workFolderId);
          const result = await state.restrictedApps.readBrowserView(scope, input.call);
          if ((await getWorkFolder(scope.workFolderId)).workFolderRoot !== workFolder.workFolderRoot) throw httpError(409, "This work-folder changed. Open the app again.");
          return result;
        }
        case "apps.actions.request":
        case "apps.actions.get":
        case "apps.actions.list":
        case "apps.actions.cancel": {
          // A paired browser's app view runs its declared actions the way the
          // desktop does: the request is admitted, journaled, and dispatched in
          // one step under the live grant fence. Nothing waits for a click.
          if (!authority) throw httpError(403, "App actions require a live paired browser.");
          const extra = operation === "apps.actions.request" ? ["request"] : operation === "apps.actions.list" ? [] : ["requestId"];
          assertRemoteKeys(input, ["workFolderId", "appId", "featureInstallationId", "digest", "authorityDigest", ...extra]);
          const scope = {
            workFolderId: remoteStableId(input.workFolderId, "work-folder id", 200), appId: remoteStableId(input.appId, "App id", 160),
            featureInstallationId: remoteStableId(input.featureInstallationId, "App installation", 160),
            digest: remoteStableId(input.digest, "App revision", 64), authorityDigest: remoteStableId(input.authorityDigest, "App authority", 64),
          };
          const owner = { browserId: principal.browserId, grantId: principal.grantId };
          const assertCurrent = () => { if (!state.acceptingTurns) throw new Error("work-fold is closing."); authority.assertCurrent(); };
          assertCurrent();
          const workFolder = await getWorkFolder(scope.workFolderId);
          const service = state.browserAppActions;
          const requestId = extra.includes("requestId") ? remoteStableId(input.requestId, "App request id", 36) : "";
          const result = operation === "apps.actions.request" ? { action: await service.request(scope, owner, input.request, assertCurrent) }
            : operation === "apps.actions.get" ? { action: await service.get(scope, owner, requestId, assertCurrent) }
            : operation === "apps.actions.list" ? { actions: await service.list(scope, owner, assertCurrent) }
            : { action: await service.cancel(scope, owner, requestId, assertCurrent) };
          assertCurrent();
          if ((await getWorkFolder(scope.workFolderId)).workFolderRoot !== workFolder.workFolderRoot) throw httpError(409, "This work-folder changed. Open the app again.");
          return result;
        }
        case "work-folders.filePreview": {
          assertRemoteKeys(input, ["workFolderId", "path"]);
          const workFolderId = remoteStableId(input.workFolderId, "work-folder id", 512);
          return { preview: await readRemoteFilePreview(workFolderId, remoteRelativePath(input.path)) };
        }
        case "work-folders.tree": {
          assertRemoteKeys(input, ["workFolderId", "path"]);
          const workFolderId = remoteStableId(input.workFolderId, "work-folder id", 512);
          const path = input.path === undefined ? "" : remoteRelativePath(input.path);
          const workFolder = await getWorkFolder(workFolderId);
          const scan = await scanWorkFolderTree(workFolder.workFolderRoot, 0, path, { includeIgnored: false, nestedFolderPaths: await nestedRegisteredWorkFolderPaths(workFolder.workFolderRoot) });
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
          return watchWorkFoldAgentTurn(rawInput, principal, () => {});
        default:
          return remoteOperationExhaustive(operation);
      }
    },
  };
}

function remoteWorkFoldAgentRequest(
  request: WorkFoldActAgentRequest | null,
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
        workFolderName: child.workFolderName,
        state: child.state,
      })),
    };
  }
  return {
    taskId: request.taskId,
    conversationId: request.conversationId,
    phase: request.phase,
    state: request.state,
    requestId: request.requestId,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    error: request.error,
    content: request.content,
    source: request.source,
    canStop: request.phase === "working" || request.phase === "handed_off" || request.phase === "needs_you",
    children: request.children,
    reply: request.reply,
    attachments: request.attachments.map((attachment) => ({ kind: attachment.kind, name: attachment.name })),
    dispositions: request.dispositions.map((disposition) => ({
      attachment: { kind: disposition.attachment.kind, name: disposition.attachment.name },
      status: disposition.status,
      workFolderId: disposition.workFolderId,
      workFolderName: disposition.workFolderName,
      copied: disposition.copied,
      checkpointId: disposition.checkpointId,
    })),
    actions: request.actions.map((action) => ({
      command: action.command,
      at: action.at,
      workFolderId: action.workFolderId,
      workFolderName: action.workFolderName,
      copied: action.copied,
      checkpointId: action.checkpointId,
      conversationId: action.conversationId,
      taskId: action.taskId,
      apps: action.apps,
    })),
  };
}

function remoteWorkFoldAgentConversationState(
  state: LocalApiState,
  conversationId: string,
): WorkFoldActChatState {
  const direct = conversationRuntimeState(state, workFoldAgentScopeId, conversationId);
  if (direct !== "idle") return direct;
  const latest = state.requests.latestForConversation(conversationId);
  return latest && state.requests.children(latest.requestId).some((child) =>
    child.state === "working" || child.state === "handed_off")
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

const maxRemoteConversationSummaries = 500;
const maxRemoteUploadFiles = 64;
const maxRemoteUploadFileBytes = 6 * 1024 * 1024;
const maxRemoteUploadTotalBytes = 8 * 1024 * 1024;
const maxRemoteWorkFoldAgentUploadStorageBytes = 64 * 1024 * 1024;
const remoteWorkFoldAgentUploadTtlMs = 24 * 60 * 60 * 1_000;

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

async function stageRemoteWorkFoldAgentUploads(
  workFoldAgentRootPath: string,
  value: unknown,
  grantId: string,
  requestId: string,
): Promise<{
  attachments: WorkFoldAgentAttachmentRef[];
  uploads: Array<{ name: string; sizeBytes: number }>;
  rollback(): Promise<void>;
}> {
  const files = remoteUploadFiles(value);
  if (!files.length) return { attachments: [], uploads: [], rollback: async () => undefined };
  const retainedBytes = await pruneRemoteWorkFoldAgentUploads(workFoldAgentRootPath);
  const incomingBytes = files.reduce((total, file) => total + file.data.byteLength, 0);
  if (retainedBytes + incomingBytes > maxRemoteWorkFoldAgentUploadStorageBytes) {
    throw badRequest("Remote upload storage is full. Remove older remote attachments or try again later.");
  }
  const targetFolder = `Incoming/Remote/${safeRemoteUploadSegment(grantId)}/${safeRemoteUploadSegment(requestId)}`;
  const absoluteFolder = resolveWorkFolderPath(workFoldAgentRootPath, targetFolder);
  await rm(absoluteFolder, { recursive: true, force: true });
  const uploaded = await writeUploadedFiles(workFoldAgentRootPath, targetFolder, files);
  try {
    const absolutePaths = uploaded.map((file) => resolveWorkFolderPath(workFoldAgentRootPath, file.path));
    const attachments = await classifyWorkFoldAgentAttachments(absolutePaths, workFoldAgentRootPath);
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

function remoteWorkFoldAgentUploadRoot(workFoldAgentRootPath: string): string {
  return resolveWorkFolderPath(workFoldAgentRootPath, "Incoming/Remote");
}

function safeRemoteUploadSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  if (!segment || segment === "." || segment === "..") throw badRequest("Remote upload identity is invalid.");
  return segment;
}

async function pruneRemoteWorkFoldAgentUploads(workFoldAgentRootPath: string): Promise<number> {
  const root = remoteWorkFoldAgentUploadRoot(workFoldAgentRootPath);
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
      if (!info || now - info.mtimeMs > remoteWorkFoldAgentUploadTtlMs) {
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

function assertRemoteWorkFoldAgentRequestOwner(
  state: LocalApiState,
  taskId: string,
  principal: WorkFoldRemotePrincipal,
): void {
  const request = state.requests.byTaskId(taskId);
  if (!request || !isRemoteWorkFoldAgentRequestOwner(request, principal)) {
    throw notFound("Remote request not found for this browser grant.");
  }
}

function isRemoteWorkFoldAgentRequestOwner(
  request: WorkFoldRequestRecord,
  principal: WorkFoldRemotePrincipal,
): boolean {
  return request.remote !== null
    && request.remote.principalId === principal.browserId
    && request.remote.grantId === principal.grantId;
}

function remoteStableId(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest(`A valid ${label} is required.`);
  }
  return value;
}

function remoteContent(value: unknown): string {
  // Sized to fit the relay's encrypted routine envelope; the context window is the practical bound.
  if (typeof value !== "string" || !value.trim() || value.length > 256_000 || value.includes("\0")) {
    throw badRequest("A message of at most 256,000 characters is required.");
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
    throw badRequest("A valid work-folder-relative folder path is required.");
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
/** One `apps list` response stays a readable projection, not a package dump. */
const maxActAppListings = 64;

const workFoldActInstallPreviewConversationId = "work-fold.act.install-preview";

/**
 * The per-work-folder client that carries bounded app inference. It is streamed,
 * never prompted, so no Chat is created and no transcript exists; the name
 * only keeps it separate from the work-folder's real conversations.
 */
const workFoldAppInferenceConversationId = "work-fold.app-inference";

function createWorkFoldActFacade(state: LocalApiState): WorkFoldActFacade {
  const resolveWorkFolder = async (selector: string): Promise<WorkFolderSummary> => {
    const resolved = resolveWorkFoldCliWorkFolderSelector(await listWorkFolders(), selector.trim() || undefined);
    if (!resolved) throw new WorkFoldCliError("usage", "Act commands require an explicit --work-folder <id-or-name>.");
    return resolved;
  };
  /**
   * Per-work-folder appearance undo slot for this app run: the customization a
   * receipted appearance act displaced and the customization it left in
   * place. `work-folders appearance undo` swaps them; a desktop-side change makes
   * the recorded slot stale, which the equality check below turns into a
   * typed refusal instead of restoring a state the receipt never described.
   */
  const appearanceUndoSlots = new Map<string, {
    displaced: WorkFolderAppearanceCustomization | null;
    result: WorkFolderAppearanceCustomization | null;
  }>();
  const currentAppearanceCustomization = (workFolderId: string): WorkFolderAppearanceCustomization | null =>
    state.appearance.snapshot().customizations[workFolderId] ?? null;
  /** The conversation PATCH route's 409s, mapped to CLI conflict errors. */
  const assertChatMutable = (workFolderId: string, conversationId: string): void => {
    const key = clientKey(workFolderId, conversationId);
    if (state.runningTurns.has(key)) {
      throw new WorkFoldCliError("conflict", "Wait for the current turn to finish.");
    }
    if (state.compactingConversations.has(key)) {
      throw new WorkFoldCliError("conflict", "Wait for the current Chat compaction to finish.");
    }
  };
  const requireConversationSummary = async (
    workFolderRoot: string,
    conversationId: string,
  ): Promise<ConversationSummary> => {
    const summary = await runActOperation(() => readConversationSummary(workFolderRoot, conversationId));
    if (!summary) throw new WorkFoldCliError("notFound", "Conversation not found.");
    return summary;
  };
  const chatAsk = async (workFolder: Pick<WorkFolderSummary, "id" | "name" | "workFolderRoot">, input: Omit<Parameters<WorkFoldActFacade["chatAsk"]>[0], "workFolder">) => {
    assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
    const taskId = input.taskId.trim();
    if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <own-task-id>.");
    return runActOperation(async () => {
      const record = assertOwnTask(state, workFolder.id, taskId);
      // A root has nothing above it, so `parent` reaches the person and the
      // result says so (contract bullet 2). The asking turn is never
      // suspended: the turn goes on or ends as it likes; the request waits.
      const redirectedToPerson = input.respondent === "parent" && record.parentRequestId === null;
      const respondent = redirectedToPerson ? "person" : input.respondent;
      let question: WorkFoldQuestionRecord;
      try {
        question = await state.requests.ask({ requestId: record.requestId, taskId, respondent, text: input.question });
      } catch (error) {
        throw collaborationRefusal(error);
      }
      await recordFacadeAction(state, input.parentTaskId, { command: "chat.ask", workFolder, taskId });
      publishControlHint(state, "work-folders");
      void state.appAssistantTasks.refresh().catch((error) => console.error(errorMessage(error)));
      return {
        workFolder: toActWorkFolderRef(workFolder),
        taskId,
        question: toActQuestionRef(question),
        request: toActRequestRefForWorkFolder(state, state.requests.get(record.requestId) ?? record),
        redirectedToPerson,
      };
    });
  };
  const chatAnswer = async (workFolder: Pick<WorkFolderSummary, "id" | "name" | "workFolderRoot">, input: Omit<Parameters<WorkFoldActFacade["chatAnswer"]>[0], "workFolder">) => {
    assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
    const questionId = input.questionId.trim();
    if (!questionId) throw new WorkFoldCliError("usage", "Provide --question <id>.");
    const answer = input.answer.trim();
    if (!answer) throw new WorkFoldCliError("usage", "Provide --answer <text>.");
    return runActOperation(async () => {
      const question = state.requests.question(questionId);
      if (!question) {
        throw new WorkFoldCliError("notFound", `Question not found. Requests are kept for ${state.requests.retentionDays()} days.`);
      }
      const record = state.requests.get(question.requestId);
      if (!record) throw new WorkFoldCliError("notFound", "The request that asked this question is no longer on record.");
      // An answer is recorded before its continuation starts. Every fence
      // acceptance applies is checked first, but a turn can still start in
      // that Chat between the two, and a crash can land between them, so
      // "answered with no follow-up" is a reachable state. Sending the same
      // answer again resumes from exactly there — the recorded answer
      // stands and its one continuation starts now — rather than refusing
      // and leaving the answer with nowhere to go (F27: one accepted answer
      // starts exactly one linked continuation).
      const resuming = question.state === "answered" && question.continuationTaskId === null;
      // Every other refusal is named before anything changes: a second
      // answer, an expired question, a closed request, the wrong work-folder, a
      // busy Chat.
      if (question.state === "answered" && !resuming) {
        throw new WorkFoldCliError("conflict", "That question already has an answer.");
      }
      if (question.state === "cancelled") throw new WorkFoldCliError("conflict", "That request was stopped, so its question is closed.");
      if (!resuming && (question.state === "expired" || (question.expiresAt !== null && Date.now() >= Date.parse(question.expiresAt)))) {
        throw new WorkFoldCliError("conflict", requestLimitRefusalMessage("questionLifetime"));
      }
      if ((record.owner.workFolderId ?? workFoldAgentScopeId) !== workFolder.id) {
        const owner = record.owner.workFolderName ?? record.owner.workFolderId ?? "the work-fold agent";
        throw new WorkFoldCliError("conflict", `Question ${questionId} belongs to ${owner}; answer it there.`);
      }
      const root = state.requests.get(record.rootId) ?? record;
      if (root.stopRequestedAt !== null || record.stopRequestedAt !== null) {
        throw new WorkFoldCliError("conflict", "That request was stopped, so its question is closed.");
      }
      if (root.state === "expired" || record.state === "expired") {
        throw new WorkFoldCliError("conflict", requestLimitRefusalMessage("questionLifetime"));
      }
      // Every fence acceptance would apply is checked before the question
      // flips, so a refusal leaves it open and answerable later: a busy
      // Chat, a capability change in flight, an archived or snoozed Chat.
      assertChatMutable(workFolder.id, record.owner.conversationId);
      assertNoCapabilityMutationForTurn(state, workFolder.id);
      const summary = await requireConversationSummary(workFolder.workFolderRoot, record.owner.conversationId);
      if (summary.archivedAt) throw new WorkFoldCliError("conflict", "Restore this Chat before answering its question.");
      if (summary.snoozedUntil && Date.parse(summary.snoozedUntil) > Date.now()) {
        throw new WorkFoldCliError("conflict", "Resume this Chat before answering its question.");
      }
      let answered: WorkFoldQuestionRecord = question;
      if (!resuming) {
        try {
          answered = await state.requests.answer({ questionId, answer, ...(workFolder.id === workFoldAgentScopeId ? {} : { answeredByWorkFolderId: workFolder.id }) });
        } catch (error) {
          throw collaborationRefusal(error);
        }
      }
      // Journal-first: the question is answered; now exactly one linked
      // continuation turn, deduplicated by the turn store under a request
      // id derived from the question so a replay returns the same turn.
      // The transcript gets an ordinary user message — the question id
      // stays in machine-local records (F25/F27). A resumed answer carries
      // the text already on record, so the Chat and the record say the same
      // thing. Should acceptance still fail here, the answer stays recorded
      // and sending it again picks up exactly where this left off.
      const delivered = resuming ? answered.answer ?? answer : answer;
      let accepted: Awaited<ReturnType<typeof acceptConversationTurn>>;
      try {
        accepted = await acceptConversationTurn(state, workFolder, record.owner.conversationId, {
          content: delivered,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
          requestId: `answer-${questionId}`,
          request: { joinRequestId: record.requestId, answeringQuestionId: questionId },
        });
      } catch (error) {
        throw new WorkFoldCliError(
          "failure",
          `The answer to question ${questionId} is recorded, but the Chat could not continue: ${errorMessage(error)}. Send the same answer again to continue it.`,
          { cause: error },
        );
      }
      const { message, taskId } = accepted;
      let linked = answered;
      try {
        linked = await state.requests.linkContinuation(questionId, taskId);
      } catch (error) {
        // The turn store already returned the one continuation for this
        // answer; a second link attempt (a replayed answer) is a no-op.
        if (!(error instanceof WorkFoldRequestLineageError)) throw error;
        linked = state.requests.question(questionId) ?? answered;
      }
      await recordFacadeAction(state, input.parentTaskId, {
        command: "chat.answer",
        workFolder,
        conversationId: record.owner.conversationId,
        taskId,
      });
      publishControlHint(state, "work-folders");
      void state.appAssistantTasks.refresh().catch((error) => console.error(errorMessage(error)));
      return {
        workFolder: toActWorkFolderRef(workFolder),
        question: toActQuestionRef(linked),
        continuation: { taskId, messageId: message.id, conversationId: record.owner.conversationId },
        request: toActRequestRefForWorkFolder(state, state.requests.get(record.requestId) ?? record),
      };
    });
  };

  /**
   * Resolves one installed app by its manifest id so digest-less narrowing
   * verbs can pin the current reviewed revision for their mutation — a
   * revision change between lookup and act then fails with the service's
   * REVISION_CHANGED instead of acting on different bytes.
   */
  const requireInstalledApp = async (workFolder: WorkFolderSummary, appId: string): Promise<RestrictedAppInstalled> => {
    const id = appId.trim();
    if (!id) throw new WorkFoldCliError("usage", "Provide --app <id>.");
    const matches = (await runActOperation(() => state.restrictedApps.list(workFolder.id)))
      .filter((item) => item.manifest.id === id || item.featureInstallationId === id);
    if (matches.length > 1) throw new WorkFoldCliError("usage", `More than one installation matches. Use --app with an exact installation: ${matches.map((app) => `${app.runtimeInstanceKind === "development" ? "preview" : "installed App"} ${app.featureInstallationId}`).join(", ")}.`);
    const app = matches[0];
    if (!app) throw new WorkFoldCliError("notFound", "No app with this id is installed in this work-folder.");
    return app;
  };
  /**
   * The one door for every verb that installs code, widens a power, or
   * destroys data (docs/receipts-not-gates.md, F19): typed parameters and
   * pins composed by the calling method from live state, then the prepared-
   * act path — pin recheck inside the capability fence, one internal kernel
   * task, the same domain internals the desktop uses — run at once under the
   * act request's journaled id. The act executor wrote the accepted receipt
   * before this method was reached and writes the terminal line after;
   * nothing here waits on a person. Returns the request id the act ran under.
   */
  const runPreparedAct = async (input: {
    kind: PreparedActKind;
    parameters: PreparedActFields;
    pins: PreparedActFields;
    requestId?: string;
    context?: unknown;
  }): Promise<string> => {
    const requestId = input.requestId?.trim() || randomUUID();
    // The journaled request id is the receipt id a Recently deleted entry records
    // (docs/receipts-not-gates.md, F20), so the destroying adapters can read
    // it back off the same context slot they report their outcome through.
    if (input.context && typeof input.context === "object") {
      (input.context as { requestId?: string }).requestId ??= requestId;
    }
    await runActOperation(() => runPreparedActOperation(async () => {
      const act = prepareAct({ kind: input.kind, parameters: input.parameters, pins: input.pins });
      await state.preparedActs.run({ act, requestId, context: input.context });
    }));
    return requestId;
  };
  /** work-folder-scoped capability changes require the work-folder's project trust, exactly as the desktop routes do. */
  const assertWorkFolderCapabilityTrust = async (workFolder: WorkFolderSummary): Promise<void> => {
    if (!await isPiProjectMutationTrusted(workFolder.workFolderRoot, state.runtimeProvider)) {
      throw new WorkFoldCliError("permissionDenied", "Trust this work-folder before changing work-folder-scoped capabilities.");
    }
  };
  /**
   * Whole-work-folder restore replaces the working set running work may be reading,
   * so the act lane refuses concurrency the desktop still leaves to a confirm
   * dialog (docs/act-ledger.md, conflict rule 7). The live route state
   * covers turns, compactions, and Check work; the kernel's
   * experimental fence covers active automation runs with files hops into the
   * work-folder and — once its reader exists — restricted-app automation runs whose
   * apps hold file grants into it (the ledger's item 4).
   */
  const assertWorkFolderQuietForHistoryRestore = async (workFolderId: string): Promise<void> => {
    const prefix = `${workFolderId}:`;
    if ([...state.runningTurns].some((key) => key.startsWith(prefix))) {
      throw new WorkFoldCliError("conflict", "Wait for the running turn in this work-folder to finish before restoring.");
    }
    if ([...state.compactingConversations].some((key) => key.startsWith(prefix))) {
      throw new WorkFoldCliError("conflict", "Wait for the running Chat compaction in this work-folder to finish before restoring.");
    }
    if (state.checkRunReservations.has(workFolderId) || state.checks.hasActiveRun(workFolderId)) {
      throw new WorkFoldCliError("conflict", "Wait for the running Check work in this work-folder to finish before restoring.");
    }
    const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(workFolderId);
    if (blockers.length) throw new WorkFoldCliError("conflict", blockers[0]!);
  };
  return {
    async workerShow(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const [status, instructions, models] = await Promise.all([
        runActOperation(() => getPiSetupStatus(workFolder.workFolderRoot, state.runtimeProvider)),
        runActOperation(() => getPiWorkerInstructions(workFolder.workFolderRoot, state.runtimeProvider)),
        runActOperation(() => listPiModels(workFolder.workFolderRoot, state.runtimeProvider)),
      ]);
      return {
        workFolder: toActWorkFolderRef(workFolder),
        model: status.provider && status.model ? { provider: status.provider, id: status.model } : null,
        availableModels: models
          .filter((model) => model.authConfigured)
          .map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning })),
        instructions,
      };
    },
    async workerSetModel(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const selected = await runActOperation(() => runCapabilityMutation(state, workFolder, "project", async () => {
        const match = (await listPiModels(workFolder.workFolderRoot, state.runtimeProvider))
          .find((model) => model.provider === input.provider.trim() && model.id === input.model.trim());
        if (!match) throw new WorkFoldCliError("usage", "The selected model is not available in this work-folder.");
        if (!match.authConfigured) {
          throw new WorkFoldCliError("permissionDenied", "Connect this provider in Settings → AI Models before assigning its model.");
        }
        await setPiDefaultModel(
          workFolder.workFolderRoot,
          { provider: match.provider, id: match.id },
          state.runtimeProvider,
        );
        return match;
      }, { requireProjectTrust: false }));
      await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.worker.model", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), model: { provider: selected.provider, id: selected.id } };
    },
    async workerSetInstructions(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      let instructions: string;
      try {
        instructions = normalizeWorkerInstructions(input.instructions);
      } catch (error) {
        throw new WorkFoldCliError("usage", errorMessage(error));
      }
      await runActOperation(() => runCapabilityMutation(
        state,
        workFolder,
        "project",
        () => setPiWorkerInstructions(workFolder.workFolderRoot, instructions, state.runtimeProvider),
        { requireProjectTrust: false },
      ));
      await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.worker.instructions", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), instructions };
    },
    async createConversation(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const conversation = await runActOperation(() => createConversation(workFolder.workFolderRoot));
      return { workFolder: toActWorkFolderRef(workFolder), conversation: toActConversationRef(conversation) };
    },
    async listConversations(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const conversations = await runActOperation(() => listConversations(workFolder.workFolderRoot));
      return { workFolder: toActWorkFolderRef(workFolder), conversations: conversations.map(toActConversationRef) };
    },
    async sendMessage(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const content = input.content.trim();
      if (!content) throw new WorkFoldCliError("usage", "Message content is required.");
      if (!input.conversationId && !input.newConversation) {
        throw new WorkFoldCliError("usage", "Provide --conversation <id> or --new.");
      }
      return runActOperation(async () => {
        assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
        if (input.parentTaskId) {
          await state.beforeWorkFoldAgentActionRecord?.({ parentTaskId: input.parentTaskId, command: "chat.send", taskId: "" });
        }
        const conversationId = input.newConversation
          ? (await createConversation(workFolder.workFolderRoot)).id
          : input.conversationId!;
        // A delegated send is a child request under the named parent (F25).
        // The parent check and every request bound run inside acceptance,
        // before the user message lands, so a refused child is never
        // accepted and then cancelled.
        const { message, taskId } = await acceptConversationTurn(state, workFolder, conversationId, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
          requestId: input.requestId,
          ...(input.parentTaskId ? { request: { parentTaskId: input.parentTaskId } } : {}),
        });
        await state.requests.recordAction(input.parentTaskId, {
          command: "chat.send",
          at: new Date().toISOString(),
          workFolderId: workFolder.id,
          workFolderName: workFolder.name,
          conversationId,
          taskId,
        });
        return { workFolder: toActWorkFolderRef(workFolder), conversationId, messageId: message.id, taskId };
      });
    },
    async conversationStatus(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const summary = await runActOperation(() => readConversationSummary(workFolder.workFolderRoot, input.conversationId));
      if (!summary) throw new WorkFoldCliError("notFound", "Conversation not found.");
      return {
        workFolder: toActWorkFolderRef(workFolder),
        conversation: toActConversationRef(summary),
        state: conversationRuntimeState(state, workFolder.id, input.conversationId),
      };
    },
    async conversationResult(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const result = await conversationResultForScope(state, workFolder.id, workFolder.workFolderRoot, input.conversationId, input.messages);
      return { workFolder: toActWorkFolderRef(workFolder), ...result };
    },
    async abortTurn(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const client = state.clients.get(clientKey(workFolder.id, input.conversationId));
      return {
        workFolder: toActWorkFolderRef(workFolder),
        conversationId: input.conversationId,
        aborted: client ? await client.abort() : false,
      };
    },
    async turnStatus(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const task = turnStatusFor(state, workFolder.id, taskId);
      const record = state.requests.byTaskId(taskId);
      // Both fields are scoped to the named work-folder: a task id is easy to come
      // by, and a question another work-folder's agent asked is that work-folder's
      // content, never this caller's (F9 as amended, F26).
      const owned = record !== null && record.owner.workFolderId === workFolder.id;
      return {
        workFolder: toActWorkFolderRef(workFolder),
        task,
        waiting: owned ? waitingRefForTask(state, taskId) : null,
        request: owned ? toActRequestRefForWorkFolder(state, record) : null,
      };
    },
    async turnResult(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const result = await turnResultForScope(state, workFolder.id, workFolder.workFolderRoot, taskId);
      return { workFolder: toActWorkFolderRef(workFolder), ...result };
    },
    // --- the collaboration verbs (docs/collaboration-contract.md, F27) ---
    async chatReport(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <own-task-id>.");
      return runActOperation(async () => {
        const record = assertOwnTask(state, workFolder.id, taskId);
        const data = input.dataPath !== undefined
          ? await readReportDataFile(input.dataPath, input.cwd ?? workFolder.workFolderRoot)
          : input.data;
        const files = await resolveReportFiles(workFolder, input.files);
        // When an app asked for this work and declared a shape for the
        // details, the report is checked against that shape here, while the
        // turn is still running and can correct it (F29: validated when the
        // request declared a schema). The app's own projection checks it
        // again, so a report that got past this one can never reach the app
        // as matching details.
        const schema = record.kind === "app" && record.app
          ? state.appAssistantTasks.outputSchemaForTurn({
            workFolderId: record.app.workFolderId,
            conversationId: record.owner.conversationId,
            taskId,
          })
          : null;
        let result;
        try {
          result = await state.requests.recordResult({
            requestId: record.requestId,
            taskId,
            receiptId: input.requestId ?? `direct-${randomUUID()}`,
            envelope: {
              summary: input.summary,
              ...(data !== undefined ? { data } : {}),
              ...(files.length ? { files } : {}),
              outcome: input.outcome,
            },
            ...(schema ? { schema } : {}),
          });
        } catch (error) {
          const refusal = collaborationRefusal(error);
          if (refusal !== error) throw refusal;
          // A shape the report does not fit is the agent's to correct, so
          // it reads as a usage refusal naming the property, not a failure.
          throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
        }
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.report", workFolder, taskId });
        publishControlHint(state, "work-folders");
        return {
          workFolder: toActWorkFolderRef(workFolder),
          taskId,
          resultId: result.resultId,
          result: result.envelope,
          request: toActRequestRefForWorkFolder(state, state.requests.get(record.requestId) ?? record),
        };
      });
    },
    async chatAsk(input) { return chatAsk(await resolveWorkFolder(input.workFolder), input); },
    async chatAnswer(input) { return chatAnswer(await resolveWorkFolder(input.workFolder), input); },
    async agentAsk(input) {
      const scope = workFoldAgentScope(state);
      const { workFolder: _workFolder, ...result } = await chatAsk({ id: scope.id, workFolderRoot: scope.rootPath, name: "work-fold agent" }, { ...input, respondent: "person" });
      return result;
    },
    async agentAnswer(input) {
      const scope = workFoldAgentScope(state);
      const { workFolder: _workFolder, ...result } = await chatAnswer({ id: scope.id, workFolderRoot: scope.rootPath, name: "work-fold agent" }, input);
      return result;
    },
    async chatHandoff(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const destination = await resolveWorkFolder(input.toWorkFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <own-task-id>.");
      const content = input.message.trim();
      if (!content) throw new WorkFoldCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        const record = assertOwnTask(state, workFolder.id, taskId);
        // Every bound that could refuse the child is checked before a single
        // byte is copied, naming the limit.
        try {
          state.requests.assertCanAddChild(taskId);
        } catch (error) {
          throw collaborationRefusal(error);
        }
        if (destination.id === workFolder.id && input.files.length) {
          throw new WorkFoldCliError(
            "usage",
            "A handoff to the same work-folder needs no copies: the files are already there, so leave --file off.",
          );
        }
        const sources = input.files.map((file) => resolveHandoffSource(workFolder, file));
        // Copy first, through the same additive, restore-pointed path as
        // `files add`, so a refused copy never leaves a started Chat behind.
        const copy = sources.length
          ? await addExternalFilesInternal(destination, { fromPaths: sources, cwd: destination.workFolderRoot })
          : { copied: [], checkpointId: null };
        const conversation = await createConversation(destination.workFolderRoot);
        const { message, taskId: childTaskId } = await acceptConversationTurn(state, destination, conversation.id, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
          requestId: input.requestId,
          request: { parentTaskId: taskId, kind: "work-folder" },
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.handoff",
          workFolder: destination,
          conversationId: conversation.id,
          taskId: childTaskId,
          checkpointId: copy.checkpointId,
          copied: copy.copied,
        });
        publishControlHint(state, "work-folders");
        const child = state.requests.byTaskId(childTaskId);
        return {
          workFolder: toActWorkFolderRef(workFolder),
          toWorkFolder: toActWorkFolderRef(destination),
          conversationId: conversation.id,
          messageId: message.id,
          taskId: childTaskId,
          copied: copy.copied,
          checkpointId: copy.checkpointId,
          request: toActRequestRefForWorkFolder(state, child ?? record),
        };
      });
    },
    async requestsList(input) {
      await assertRequestsAboveWorkFolders(input?.cwd);
      const roots = state.requests.list()
        .filter((record) => record.requestId === record.rootId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        requests: roots.map((record) => requestSummaryView(state, record)),
        truncated: false,
      };
    },
    async requestsShow(input) {
      await assertRequestsAboveWorkFolders(input.cwd);
      const requestId = input.request.trim();
      const record = requestId ? state.requests.get(requestId) : null;
      if (!record) {
        throw new WorkFoldCliError("notFound", `Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
      }
      return { request: await requestDetailView(state, record) };
    },
    async chatRename(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const title = input.title.trim();
      if (!title) throw new WorkFoldCliError("usage", "Chat title is required.");
      return runActOperation(() => runConversationMutation(state, workFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(workFolder.workFolderRoot, input.conversationId);
        const conversation = await runActOperation(() => renameConversation(workFolder.workFolderRoot, input.conversationId, title));
        state.clients.get(clientKey(workFolder.id, input.conversationId))?.setSessionName(conversation.title);
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.rename", workFolder, conversationId: conversation.id });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          conversation: toActConversationRef(conversation),
          priorTitle: summary.title,
        };
      }));
    },
    async chatSnooze(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const until = input.until.trim();
      if (!Number.isFinite(Date.parse(until))) throw new WorkFoldCliError("usage", "Snooze time is invalid.");
      if (Date.parse(until) <= Date.now()) throw new WorkFoldCliError("usage", "Choose a future snooze time.");
      return runActOperation(() => runConversationMutation(state, workFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(workFolder.workFolderRoot, input.conversationId);
        if (summary.archivedAt) throw new WorkFoldCliError("conflict", "Unarchive this Chat before snoozing it.");
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(workFolder.workFolderRoot, input.conversationId, { snoozedUntil: until }));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.snooze", workFolder, conversationId: conversation.id });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatArchive(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(() => runConversationMutation(state, workFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(workFolder.workFolderRoot, input.conversationId);
        if (summary.archivedAt) throw new WorkFoldCliError("conflict", "This Chat is already archived.");
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(workFolder.workFolderRoot, input.conversationId, { archived: true }));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.archive", workFolder, conversationId: conversation.id });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatResume(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(() => runConversationMutation(state, workFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(workFolder.workFolderRoot, input.conversationId);
        if (!summary.archivedAt && !summary.snoozedUntil) {
          throw new WorkFoldCliError("conflict", "This Chat is already active.");
        }
        // One lifecycle change per act, mirroring the renderer: an archived Chat
        // restores to Active; a snoozed (or snooze-expired) Chat clears its snooze.
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(
            workFolder.workFolderRoot,
            input.conversationId,
            summary.archivedAt ? { archived: false } : { snoozedUntil: null },
          ));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.resume", workFolder, conversationId: conversation.id });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatCompact(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(async () => {
        // Exactly the composer's /compact route: same not-found check, same
        // capability-mutation fence, same 409s, and the same kernel
        // `compaction` task lifecycle — started before the compaction and
        // finished on every outcome, so no ghost task survives a failure.
        if (!(await readConversation(workFolder.workFolderRoot, input.conversationId)).length) {
          throw new WorkFoldCliError("notFound", "Conversation not found.");
        }
        const key = clientKey(workFolder.id, input.conversationId);
        assertNoCapabilityMutationForTurn(state, workFolder.id);
        assertChatMutable(workFolder.id, input.conversationId);
        state.compactingConversations.add(key);
        const task = state.kernel.startTask({
          kind: "compaction",
          workFolderId: workFolder.id,
          conversationId: input.conversationId,
          actor: { kind: "cli", cwd: workFolder.workFolderRoot, workFolderId: workFolder.id, conversationId: input.conversationId },
        });
        try {
          const client = await getClient(state, workFolder.id, workFolder.workFolderRoot, input.conversationId);
          await client.compact();
          broadcast(state, streamKey(workFolder.id, input.conversationId), { type: "done", conversationId: input.conversationId });
        } finally {
          state.compactingConversations.delete(key);
          state.kernel.finishTask(task.id);
          queueConversationRequestEvaluation(state, workFolder.id, input.conversationId);
        }
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.compact",
          workFolder,
          conversationId: input.conversationId,
          taskId: task.id,
        });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          conversationId: input.conversationId,
          compacted: true as const,
          taskId: task.id,
        };
      });
    },
    async historyList(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const page = await runActOperation(() => listWorkFolderCheckpointPage(workFolder.workFolderRoot, input));
      return { workFolder: toActWorkFolderRef(workFolder), ...page, checkpoints: page.checkpoints.map(toActCheckpointSummary) };
    },
    async historySave(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(async () => {
        // Same internals as the History pane's save route: an unchanged work-folder
        // returns the latest matching restore point instead of a duplicate.
        const existingIds = new Set(
          (await listWorkFolderCheckpoints(workFolder.workFolderRoot, 1000)).map((checkpoint) => checkpoint.checkpointId),
        );
        const checkpoint = await createWorkFolderCheckpoint(workFolder.workFolderRoot, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          reason: "manual",
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "history.save",
          workFolder,
          checkpointId: checkpoint.checkpointId,
        });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          checkpoint: toActCheckpointSummary(checkpoint),
          created: !existingIds.has(checkpoint.checkpointId),
        };
      });
    },
    async historyRestore(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      await assertWorkFolderQuietForHistoryRestore(workFolder.id);
      const result = await runActOperation(() => runHistoryRestore(state, workFolder.id, () => restoreWorkFolderCheckpoint(workFolder.workFolderRoot, input.checkpointId)));
      await recordFacadeAction(state, input.parentTaskId, {
        command: "history.restore",
        workFolder,
        checkpointId: result.safetyCheckpointId,
      });
      return {
        workFolder: toActWorkFolderRef(workFolder),
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
      const workFolder = await resolveWorkFolder(input.workFolder);
      const path = input.path.trim();
      if (!path) throw new WorkFoldCliError("usage", "A work-folder-relative file path is required.");
      const page = await runActOperation(() => listFileVersionPage(workFolder.workFolderRoot, path, input));
      return { workFolder: toActWorkFolderRef(workFolder), path, ...page, versions: page.versions.map(toActFileVersionRef) };
    },
    async historyRead(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const review = await runActOperation(() => readHistoryFile(workFolder.workFolderRoot, input));
      return { workFolder: toActWorkFolderRef(workFolder), review };
    },
    async historyDiff(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const comparison = await runActOperation(() => compareHistoryFile(workFolder.workFolderRoot, input));
      return { workFolder: toActWorkFolderRef(workFolder), comparison };
    },
    async historyRestoreFile(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      if (!/^[a-f0-9]{64}$/i.test(input.version.trim())) {
        throw new WorkFoldCliError("usage", "Provide --version as the 64-character SHA-256 hash shown by 'history versions'.");
      }
      return runActOperation(async () => {
        const target = await stat(resolveWorkFolderPath(workFolder.workFolderRoot, input.path)).catch(() => null);
        if (target && !target.isFile()) {
          throw new WorkFoldCliError("conflict", "The selected path is currently a folder.");
        }
        const result = await runHistoryRestore(state, workFolder.id, () => restoreFileVersion(workFolder.workFolderRoot, input.path, input.version.trim()));
        await recordFacadeAction(state, input.parentTaskId, {
          command: "history.restore-file",
          workFolder,
          checkpointId: result.safetyCheckpointId,
        });
        return { workFolder: toActWorkFolderRef(workFolder), ...result };
      });
    },
    async filesMove(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const sourceRaw = input.fromPath.trim();
      if (!sourceRaw) throw new WorkFoldCliError("usage", "Select a file or folder to move.");
      return runActOperation(async () => {
        // Exactly the desktop move route: a targeted restore point that undoes
        // the move, then the mutation, with the unused restore point discarded
        // when the mutation fails.
        const moveSource = normalizeWorkFolderRelativePath(sourceRaw);
        const moveTargetFolder = normalizeWorkFolderRelativePath(input.toDir);
        const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
        const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
          movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
          reason: "pre_move",
          label: `Before moving ${sourceRaw}`,
        });
        const moved = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => moveWorkFolderEntry(workFolder.workFolderRoot, {
          sourcePath: moveSource,
          targetFolderPath: input.toDir,
        }));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.move", workFolder, checkpointId: safety.checkpointId });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          fromPath: moved.fromPath,
          path: moved.path,
          kind: moved.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesRename(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const sourceRaw = input.path.trim();
      const newName = input.newName.trim();
      if (!sourceRaw || !newName) throw new WorkFoldCliError("usage", "A work-folder item and new name are required.");
      return runActOperation(async () => {
        const renameSource = normalizeWorkFolderRelativePath(sourceRaw);
        const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
        const renameDestination = [renameParent, newName].filter(Boolean).join("/");
        const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
          movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
          reason: "pre_rename",
          label: `Before renaming ${sourceRaw}`,
        });
        const renamed = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => renameWorkFolderEntry(workFolder.workFolderRoot, { path: sourceRaw, newName }));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.rename", workFolder, checkpointId: safety.checkpointId });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          fromPath: renamed.fromPath,
          path: renamed.path,
          priorName: basename(renameSource),
          kind: renamed.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesDelete(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const target = input.path.trim();
      if (!target) throw new WorkFoldCliError("usage", "Select a file or folder to delete.");
      return runActOperation(async () => {
        const deleted = await deleteWorkFolderEntryWithRecovery(state, workFolder, target, {
          receiptId: input.requestId ?? null,
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "files.delete",
          workFolder,
          checkpointId: deleted.safetyCheckpointId,
        });
        return { workFolder: toActWorkFolderRef(workFolder), ...deleted };
      });
    },
    async filesMkdir(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A folder path is required.");
      return runActOperation(async () => {
        const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const folder = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => createWorkFolderFolder(workFolder.workFolderRoot, parentPath, name));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.mkdir", workFolder, checkpointId: safety.checkpointId });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          created: true as const,
          path: folder.path,
          kind: "folder" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesCreate(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A file path is required.");
      return runActOperation(async () => {
        const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const file = await runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, () => createWorkFolderTextFile(workFolder.workFolderRoot, parentPath, name, ""));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.create", workFolder, checkpointId: safety.checkpointId });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          created: true as const,
          path: file.path,
          kind: "file" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async search(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const query = input.query.trim();
      if (!query) throw new WorkFoldCliError("usage", "Enter something to search for.");
      const scope = input.scope ?? "all";
      const result = await runActOperation(() => searchWorkFolder(workFolder.workFolderRoot, query, {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        path: input.path, cursor: input.cursor, maxMatches: input.limit,
      }));
      return { workFolder: toActWorkFolderRef(workFolder), scope, ...result };
    },
    async createWorkFolder(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const name = input.name.trim();
      if (!name) throw new WorkFoldCliError("usage", "A work-folder name is required.");
      const workFolder = await runActOperation(() => runCheckWorkFolderRegistryMutation(state, () => createWorkFolderInternal(state, name)));
      await state.requests.recordAction(input.parentTaskId, {
        command: "work-folders.create",
        at: new Date().toISOString(),
        workFolderId: workFolder.id,
        workFolderName: workFolder.name,
        workFolderRoot: workFolder.workFolderRoot,
      });
      return { workFolder: toActWorkFolderRef(workFolder) };
    },
    async registerWorkFolder(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const rootPath = input.workFolderRoot.trim();
      if (!rootPath || !isAbsolute(rootPath)) {
        throw new WorkFoldCliError("usage", "Provide an absolute folder path to register.");
      }
      const workFolder = await runActOperation(() => runCheckWorkFolderRegistryMutation(state, () => registerWorkFolderInternal(state, rootPath)));
      await state.requests.recordAction(input.parentTaskId, {
        command: "work-folders.register",
        at: new Date().toISOString(),
        workFolderId: workFolder.id,
        workFolderName: workFolder.name,
        workFolderRoot: workFolder.workFolderRoot,
      });
      return { workFolder: toActWorkFolderRef(workFolder) };
    },
    async addFiles(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const result = await runActOperation(() => addExternalFilesInternal(workFolder, input));
      await state.requests.recordAction(input.parentTaskId, {
        command: "files.add",
        at: new Date().toISOString(),
        workFolderId: workFolder.id,
        workFolderName: workFolder.name,
        sources: input.fromPaths.map((raw) => {
          const trimmed = raw.trim();
          return isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
        }),
        copied: result.copied,
        checkpointId: result.checkpointId,
      });
      return { workFolder: toActWorkFolderRef(workFolder), ...result };
    },
    async workFoldersRename(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const name = input.name.trim();
      if (!name) throw new WorkFoldCliError("usage", "A work-folder name is required.");
      // The ledger's ambiguous-making rule: a duplicate exact name under the
      // CLI selector's case-insensitive match would break `--work-folder` selection
      // by name, so it is refused here. The comparison folds the same way the
      // selector does; renaming a work-folder to a case variant of itself stays
      // allowed.
      const folded = name.replace(/\s+/g, " ").slice(0, 80).toLocaleLowerCase("en-US");
      const collision = (await listWorkFolders()).find((item) =>
        item.id !== workFolder.id && item.name.toLocaleLowerCase("en-US") === folded);
      if (collision) {
        throw new WorkFoldCliError(
          "conflict",
          `Another work-folder is already named ${collision.name} [${collision.id}]; a duplicate exact name would make --work-folder selection ambiguous.`,
        );
      }
      const renamed = await runActOperation(() => renameWorkFolder(workFolder.id, name));
      publishControlHint(state, "work-folders");
      await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.rename", workFolder: renamed });
      return { workFolder: toActWorkFolderRef(renamed), priorName: workFolder.name };
    },
    async workFoldersUnregister(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const storage = workFolder.location.storage;
      // Both storage kinds run the same removal orchestration — App Studio
      // impact checks, publication blocks, automation suspension, durable
      // intent, app-state cleanup. A managed work-folder records a
      // preserve-disposition intent that provably holds no deletion
      // authority, so the folder and its portable `.work-fold/` identity
      // remain exactly as they do for a linked registration; deleting the
      // managed folder is `work-folders delete`, a receipted act of its own.
      const removal = await runActOperation(() =>
        removeWorkFolderRegistrationInternal(state, workFolder, { managedFolderDisposition: "preserve" }));
      appearanceUndoSlots.delete(workFolder.id);
      await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.unregister", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        storage,
        removed: true as const,
        cleanupPending: removal.cleanupPending,
      };
    },
    async workFoldersAppearanceApply(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const proposal = await readWorkFolderAppearanceProposalFile(input.proposalPath, input.cwd);
      if (proposal.target?.workFolderId && proposal.target.workFolderId !== workFolder.id) {
        throw new WorkFoldCliError(
          "conflict",
          `This appearance proposal targets a different work-folder (${proposal.target.workFolderId}). Apply it with that --work-folder, or use a proposal authored for this one.`,
        );
      }
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(workFolder.id);
        // Exactly the Customize work-folder import route's mutation: the store
        // normalizes and persists the typed customization atomically.
        const applied = await state.appearance.replaceWorkFolder(workFolder.id, proposal.customization);
        const result = applied.customizations[workFolder.id] ?? null;
        appearanceUndoSlots.set(workFolder.id, { displaced, result });
        await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.appearance.apply", workFolder });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          applied: true as const,
          proposalName: proposal.name,
          appearanceRef: appearanceCustomizationRef(result),
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async workFoldersAppearanceReset(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(workFolder.id);
        if (displaced === null) {
          // An already-default work-folder is an honest no-op that arms no undo.
          return {
            workFolder: toActWorkFolderRef(workFolder),
            reset: true as const,
            changed: false,
            priorAppearanceRef: null,
          };
        }
        await state.appearance.removeWorkFolder(workFolder.id);
        appearanceUndoSlots.set(workFolder.id, { displaced, result: null });
        await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.appearance.reset", workFolder });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          reset: true as const,
          changed: true,
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async workFoldersAppearanceUndo(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const slot = appearanceUndoSlots.get(workFolder.id);
      if (!slot) {
        throw new WorkFoldCliError(
          "conflict",
          "No receipted appearance act recorded a prior customization for this work-folder in this app run, so there is nothing to undo. Apply a proposal or reset explicitly instead.",
        );
      }
      if (!appearanceCustomizationsEqual(currentAppearanceCustomization(workFolder.id), slot.result)) {
        throw new WorkFoldCliError(
          "conflict",
          "This work-folder's appearance was changed outside the act lane (for example on the desktop) since the last receipted appearance act, so the recorded prior customization no longer describes what an undo would displace. Apply a proposal or reset explicitly instead.",
        );
      }
      return runActOperation(async () => {
        const next = slot.displaced;
        const stateAfter = next !== null && hasWorkFolderAppearanceCustomization(next)
          ? await state.appearance.replaceWorkFolder(workFolder.id, next)
          : await state.appearance.removeWorkFolder(workFolder.id);
        const restored = stateAfter.customizations[workFolder.id] ?? null;
        // Undo is its own inverse: the displaced and restored refs swap.
        appearanceUndoSlots.set(workFolder.id, { displaced: slot.result, result: restored });
        await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.appearance.undo", workFolder });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          restored: true as const,
          restoredAppearanceRef: appearanceCustomizationRef(restored),
          displacedAppearanceRef: appearanceCustomizationRef(slot.result),
        };
      });
    },
    async toolsRemove(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const source = input.source.trim();
      if (!source) throw new WorkFoldCliError("usage", "A package source is required.");
      if (input.scope === "work-folder") {
        const workFolder = await resolveWorkFolder(input.workFolder ?? "");
        // Exactly the desktop packages/remove route: project scope requires
        // the work-folder's Pi project trust and the per-work-folder capability fence.
        const removed = await runActOperation(() => runCapabilityMutation(state, workFolder, "project", () =>
          removePiPackage(workFolder.workFolderRoot, source, {
            scope: "project",
            runtimeProvider: state.runtimeProvider,
          })));
        await recordFacadeAction(state, input.parentTaskId, { command: "tools.remove", workFolder });
        return { scope: "work-folder" as const, workFolder: toActWorkFolderRef(workFolder), source, removed };
      }
      // Everywhere scope mutates the user-scope Pi settings every
      // work-folder runtime loads. The app-owned management root is the resolution
      // context — the same root the work-fold agent's own runtime
      // uses — and the global capability fence refuses while any agent,
      // compaction, or Check work is active anywhere.
      const workFoldAgentRootScope = { id: workFoldAgentScopeId, workFolderRoot: workFoldAgentRoot() };
      const removed = await runActOperation(() => runCapabilityMutation(state, workFoldAgentRootScope, "global", () =>
        removePiPackage(workFoldAgentRootScope.workFolderRoot, source, {
          scope: "user",
          runtimeProvider: state.runtimeProvider,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.remove" });
      return { scope: "everywhere" as const, source, removed };
    },
    async appsList(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const apps = await runActOperation(() => state.restrictedApps.list(workFolder.id));
      const listed = apps.slice(0, maxActAppListings);
      const listing = await Promise.all(listed.map(async (app) => ({
        appId: app.manifest.id,
        featureInstallationId: app.featureInstallationId,
        digest: app.digest,
        title: app.manifest.title,
        description: app.manifest.description ?? null,
        version: app.version,
        kind: app.runtimeInstanceKind === "development" ? "preview" as const : "installed" as const,
        // The exact schemas the tool declares, so a caller can build --input
        // without opening the package.
        tools: app.manifest.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          action: tool.action,
          inputSchema: structuredClone(tool.inputSchema) as unknown,
          resultSchema: structuredClone(tool.resultSchema) as unknown,
        })),
        assistantActions: (app.manifest.assistantActions ?? []).map((action) => ({ id: action.id, title: action.title })),
        grants: {
          network: [...app.networkGrants],
          files: app.fileGrants.map((grant) => ({ declarationId: grant.declarationId, root: grant.root, access: grant.access })),
          notifications: [...app.notificationGrants],
          checks: (app.checkGrants ?? []).map((grant) => ({ permissionId: grant.permissionId, checkId: grant.checkId })),
        },
        connections: (await runActOperation(() =>
          state.restrictedApps.connectionStatus(workFolder.id, app.manifest.id, app.digest, app.featureInstallationId)))
          .map((connection) => ({ destinationId: connection.destinationId, kind: connection.kind, configured: connection.configured })),
        automations: app.automations.map((automation) => ({
          id: automation.id,
          title: app.manifest.automations.find((item) => item.id === automation.id)?.title ?? automation.id,
          enabled: automation.enabled,
          nextRunAt: automation.nextRunAt ?? null,
          lastRunAt: automation.lastRunAt ?? null,
        })),
      })));
      return { workFolder: toActWorkFolderRef(workFolder), apps: listing, truncated: apps.length > listed.length };
    },
    async appsInvoke(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const app = await requireInstalledApp(workFolder, input.app);
      const toolName = input.tool.trim();
      if (!toolName) throw new WorkFoldCliError("usage", "Provide --tool <name>.");
      const tool = app.manifest.tools.find((item) => item.name === toolName);
      if (!tool) {
        throw new WorkFoldCliError("notFound", `${app.manifest.title} has no tool named ${toolName}. Run apps list --json to see its tools.`);
      }
      // The same service path a Chat tool call takes: the revision resolved
      // above is pinned, and the runtime validates input and result against
      // the tool's own declared schemas.
      const result = await runActOperation(() => state.restrictedApps.invoke({
        workFolderId: workFolder.id,
        appId: app.manifest.id,
        featureInstallationId: app.featureInstallationId,
        expectedDigest: app.digest,
        action: tool.action,
        input: input.input,
      }));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.invoke", workFolder, apps: [workFoldAgentAppResultRef(app)] });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        featureInstallationId: app.featureInstallationId,
        digest: app.digest,
        tool: tool.name,
        action: tool.action,
        result,
      };
    },
    async appsProposalsList(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      // The desktop proposal route's own scope rule: proposals are bound to
      // one Chat, and the Chat must exist in this work-folder.
      if (!(await runActOperation(() => readConversation(workFolder.workFolderRoot, input.conversationId))).length) {
        throw new WorkFoldCliError("notFound", "Conversation not found.");
      }
      const proposals = await runActOperation(() =>
        state.restrictedAppProposals.list({ workFolderId: workFolder.id, conversationId: input.conversationId }));
      return {
        workFolder: toActWorkFolderRef(workFolder),
        conversationId: input.conversationId,
        proposals: proposals.map(toActAppProposalRef),
      };
    },
    async appsProposalsDismiss(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const proposal = await runActOperation(() => state.restrictedAppProposals.get(input.proposal));
      if (!proposal || proposal.workFolderId !== workFolder.id || proposal.conversationId !== input.conversationId) {
        throw new WorkFoldCliError("notFound", "App proposal not found.");
      }
      const dismissed = await runActOperation(() => state.restrictedAppProposals.dismiss(proposal.id));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.proposals.dismiss", workFolder, conversationId: input.conversationId });
      return { workFolder: toActWorkFolderRef(workFolder), proposalId: proposal.id, dismissed };
    },
    async appsRemove(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const app = await requireInstalledApp(workFolder, input.app);
      // The exact desktop DELETE route, with the resolved digest pinned; the
      // service refuses release-backed Instances toward `apps uninstall` and
      // stops the running app host before the registration goes. A copy of the
      // app's data reaches Recently deleted first (F20), the same order the
      // clear and uninstall-with-purge paths use.
      const outcome = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, async () => {
        const entry = await moveAppStorageExportToRecentlyDeleted(state, app, "apps.remove", input.requestId ?? null, { skipWhenStorageUnavailable: true });
        const removed = await state.restrictedApps.remove({
          workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, expectedDigest: app.digest,
        });
        return { removed, entry };
      }));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.remove", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        digest: app.digest,
        removed: outcome.removed,
        recentlyDeleted: outcome.entry ? { entryId: outcome.entry.id, restoreBy: outcome.entry.restoreBy } : null,
      };
    },
    async appsRevoke(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const digest = input.digest.trim();
      if (!digest) throw new WorkFoldCliError("usage", "Provide --digest <sha256>.");
      const declaration = input.declaration.trim();
      if (!declaration) throw new WorkFoldCliError("usage", "Provide --declaration <id>.");
      const app = await requireInstalledApp(workFolder, input.app);
      // Grants bind to the exact reviewed digest, so revocation names it too.
      const granted = input.kind === "network"
        ? app.networkGrants.includes(declaration)
        : input.kind === "files"
          ? app.fileGrants.some((grant) => grant.declarationId === declaration)
          : app.notificationGrants.includes(declaration);
      await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () => input.kind === "network"
        ? state.restrictedApps.revokeNetwork({ workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, destinationId: declaration, expectedDigest: digest })
        : input.kind === "files"
          ? state.restrictedApps.revokeFiles({ workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, permissionId: declaration, expectedDigest: digest })
          : state.restrictedApps.revokeNotifications({ workFolderId: workFolder.id, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, permissionId: declaration, expectedDigest: digest })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.revoke", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        grantKind: input.kind,
        declaration,
        revoked: granted,
      };
    },
    async appsDisconnect(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const destination = input.destination.trim();
      if (!destination) throw new WorkFoldCliError("usage", "Provide --destination <id>.");
      const app = await requireInstalledApp(workFolder, input.app);
      const disconnected = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () =>
        state.restrictedApps.deleteConnection({
          workFolderId: workFolder.id,
          appId: app.manifest.id,
          destinationId: destination,
          featureInstallationId: app.featureInstallationId,
          expectedDigest: app.digest,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.disconnect", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), appId: app.manifest.id, destination, disconnected };
    },
    async appsAutomationDisable(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const appAutomationId = input.automation.trim();
      if (!appAutomationId) throw new WorkFoldCliError("usage", "Provide --automation <id>.");
      const app = await requireInstalledApp(workFolder, input.app);
      const wasEnabled = app.automations.some((automation) => automation.id === appAutomationId && automation.enabled);
      await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () =>
        state.restrictedApps.setAppAutomationEnabled({
          workFolderId: workFolder.id,
          appId: app.manifest.id,
          appAutomationId,
          featureInstallationId: app.featureInstallationId,
          expectedDigest: app.digest,
          enabled: false,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.automation.disable", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        appAutomationId,
        disabled: true as const,
        wasEnabled,
      };
    },
    async appsAutomationRun(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const appAutomationId = input.automation.trim();
      if (!appAutomationId) throw new WorkFoldCliError("usage", "Provide --automation <id>.");
      const app = await requireInstalledApp(workFolder, input.app);
      const result = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () =>
        state.restrictedApps.runAppAutomationNow({
          workFolderId: workFolder.id,
          appId: app.manifest.id,
          appAutomationId,
          featureInstallationId: app.featureInstallationId,
          expectedDigest: app.digest,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.automation.run", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        appAutomationId,
        run: toActAppAutomationRunRef(result.run),
      };
    },
    async appsProjectDeclare(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const presentation = await readAppPresentationFile(input.presentationPath, input.cwd);
      return runActOperation(() => runRestrictedAppMutation(state, workFolder.id, async () => {
        const prior = (await state.restrictedApps.localAppStudio(workFolder.id)).project?.presentation ?? null;
        const project = await state.restrictedApps.declareLocalAppProject({ workFolderId: workFolder.id, presentation });
        await recordFacadeAction(state, input.parentTaskId, { command: "apps.project.declare", workFolder });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          project: { projectId: project.projectId, presentation: toActAppPresentation(project.presentation) },
          priorPresentation: prior ? toActAppPresentation(prior) : null,
          priorPresentationRef: prior ? shortContentRef(prior) : null,
        };
      }));
    },
    async appsReleasePrepare(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const release = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () =>
        state.restrictedApps.prepareLocalAppRelease({ workFolderId: workFolder.id, displayVersion: input.version })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.release.prepare", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), release: toActAppReleaseRef(release) };
    },
    async appsReleasePublish(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const release = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () =>
        state.restrictedApps.publishLocalAppRelease({ workFolderId: workFolder.id, releaseDigest: input.release })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.release.publish", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), release: toActAppReleaseRef(release) };
    },
    async appsReleaseDelete(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const deletion = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, () =>
        state.restrictedApps.deleteLocalAppRelease({ workFolderId: workFolder.id, releaseDigest: input.release })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.release.delete", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        releaseDigest: input.release,
        deleted: deletion.deleted,
        cleanupPending: deletion.cleanupPending,
      };
    },
    async appsInstallPrepare(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const target = await resolveWorkFolder(input.targetWorkFolder);
      const operation = await runActOperation(() => runRestrictedAppMutations(state, [workFolder.id, target.id], () =>
        state.restrictedApps.prepareLocalAppInstall({
          sourceWorkFolderId: workFolder.id,
          targetWorkFolderId: target.id,
          releaseDigest: input.release,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.install.prepare", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        targetWorkFolder: toActWorkFolderRef(target),
        operation: toActAppOperationRef(operation),
      };
    },
    async appsUpdatePrepare(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(async () => {
        const studio = await state.restrictedApps.localAppStudio(workFolder.id);
        const instance = studio.instances.find((item) => item.runtimeInstanceId === input.instance);
        if (!instance) throw new WorkFoldCliError("notFound", "Local App Instance not found.");
        const target = await getWorkFolder(instance.workFolderId);
        const operation = await runRestrictedAppMutations(state, [workFolder.id, target.id], () =>
          state.restrictedApps.prepareLocalAppUpdate({
            sourceWorkFolderId: workFolder.id,
            runtimeInstanceId: instance.runtimeInstanceId,
            releaseDigest: input.release,
          }));
        await recordFacadeAction(state, input.parentTaskId, { command: "apps.update.prepare", workFolder });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          targetWorkFolder: toActWorkFolderRef(target),
          operation: toActAppOperationRef(operation),
        };
      });
    },
    async appsOperationActivate(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(async () => {
        const studio = await state.restrictedApps.localAppStudio(workFolder.id);
        const operation = studio.operations.find((item) => item.operationId === input.operation);
        if (!operation) throw new WorkFoldCliError("notFound", "Prepared App operation not found.");
        const target = await getWorkFolder(operation.targetWorkFolderId);
        const result = await runRestrictedAppMutations(state, [workFolder.id, target.id], () => operation.kind === "install"
          ? state.restrictedApps.activateLocalAppInstall(operation.operationId)
          : state.restrictedApps.activateLocalAppUpdate(operation.operationId));
        await recordFacadeAction(state, input.parentTaskId, { command: "apps.operation.activate", workFolder,
          apps: result.apps.map(workFoldAgentAppResultRef) });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          operationId: operation.operationId,
          operationKind: operation.kind,
          instance: toActAppInstanceRef(result.instance),
        };
      });
    },
    async appsOperationCancel(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const cancelled = await runActOperation(() => runRestrictedAppMutation(state, workFolder.id, async () => {
        const studio = await state.restrictedApps.localAppStudio(workFolder.id);
        if (!studio.operations.some((operation) => operation.operationId === input.operation)) {
          throw new WorkFoldCliError("notFound", "Prepared App operation not found.");
        }
        return state.restrictedApps.cancelLocalAppOperation(input.operation);
      }));
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.operation.cancel", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), operationId: input.operation, cancelled };
    },
    async appsUninstall(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runActOperation(async () => {
        const installed = (await state.restrictedApps.list(workFolder.id)).find((app) => (
          app.runtimeInstanceKind === "app" && app.runtimeInstanceId === input.instance
        ));
        if (!installed) throw new WorkFoldCliError("notFound", "Local App Instance not found.");
        const result = await runRestrictedAppMutations(state, [installed.sourceWorkFolderId, workFolder.id], () =>
          state.restrictedApps.uninstallLocalApp({
            runtimeInstanceId: input.instance,
            // The purge disposition is `appsUninstallPurge` on the prepared-act
            // path; this facade method is deliberately retain-only.
            dataDisposition: "retain",
          }), { requiredWorkFolderIds: [workFolder.id] });
        await recordFacadeAction(state, input.parentTaskId, { command: "apps.uninstall", workFolder });
        return {
          workFolder: toActWorkFolderRef(workFolder),
          runtimeInstanceId: input.instance,
          removed: result.removed,
          retainedNamespaceIds: result.retainedData.map((item) => item.dataNamespaceId),
          cleanupPending: result.cleanupPending,
        };
      });
    },
    async workFoldersDelete(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      if (workFolder.location.storage !== "managed") {
        throw new WorkFoldCliError(
          "conflict",
          "Only a managed work-folder's folder can be deleted. Removing a linked registration is 'work-folders unregister'; the folder is yours either way.",
        );
      }
      // The same read-only impact checks the removal orchestration runs
      // (docs/act-ledger.md, conflict rule 4): the verb refuses what the
      // desktop removal would refuse, including the live-publication block.
      const impact = await runActOperation(() => state.restrictedApps.workFolderRemovalImpact(workFolder.id));
      if (impact.activeSourceInstanceCount > 0 || impact.activeTargetInstanceCount > 0) {
        throw new WorkFoldCliError("conflict", "Uninstall release-backed Apps from this work-folder before deleting it.");
      }
      if (impact.retainedDataCount > 0) {
        throw new WorkFoldCliError("conflict", "Purge this App Project's retained local data in App Studio before deleting its source work-folder.");
      }
      let livePublications;
      try {
        livePublications = await state.publications.activePublicationsForWorkFolder(workFolder.id);
      } catch (error) {
        throw new WorkFoldCliError("conflict", errorMessage(error), { cause: error });
      }
      if (livePublications.length) {
        const named = livePublications.slice(0, 3).map((publication) => `"${publication.title}"`).join(", ");
        const more = livePublications.length > 3 ? ", …" : "";
        throw new WorkFoldCliError(
          "conflict",
          `Stop sharing ${livePublications.length === 1 ? "the page" : `${livePublications.length} pages`} `
            + `served from this work-folder before deleting it: ${named}${more}.`,
        );
      }
      const context: PreparedActOutcome<WorkFolderRemovalResult & {
        recentlyDeleted: { entryId: string; restoreBy: string } | null;
        appRecentlyDeletedEntries: Array<{ entryId: string; restoreBy: string }>;
      }> = {};
      await runPreparedAct({
        kind: "work-folder.delete-folder",
        parameters: { workFolderId: workFolder.id },
        pins: { workFolderId: workFolder.id, workFolderRoot: workFolder.workFolderRoot },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "work-folders.delete", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        storage: "managed" as const,
        removed: true as const,
        cleanupPending: context.outcome?.cleanupPending ?? false,
        recentlyDeleted: context.outcome?.recentlyDeleted ?? null,
        appRecentlyDeletedEntries: context.outcome?.appRecentlyDeletedEntries ?? [],
      };
    },
    async toolsImportSkill(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = input.scope === "work-folder" ? await resolveWorkFolder(input.workFolder ?? "") : undefined;
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
      if (workFolder) await assertWorkFolderCapabilityTrust(workFolder);
      const scopedWorkFolder: PreparedActFields = workFolder ? { workFolderId: workFolder.id } : {};
      const context: PreparedActOutcome<PiSkillBundleImportResult> = {};
      await runPreparedAct({
        kind: "capability.skills.import",
        parameters: { source, scope: input.scope, ...scopedWorkFolder },
        pins: { source, contentDigest, skillNames },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.import-skill", ...(workFolder ? { workFolder } : {}) });
      return {
        scope: input.scope,
        ...(workFolder ? { workFolder: toActWorkFolderRef(workFolder) } : {}),
        source,
        contentDigest,
        skillNames,
        bundlePath: context.outcome?.bundlePath ?? "",
      };
    },
    async toolsInstall(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = input.scope === "work-folder" ? await resolveWorkFolder(input.workFolder ?? "") : undefined;
      if (workFolder) await assertWorkFolderCapabilityTrust(workFolder);
      const scopedWorkFolder: PreparedActFields = workFolder ? { workFolderId: workFolder.id } : {};
      const record = async (): Promise<void> => {
        await recordFacadeAction(state, input.parentTaskId, { command: "tools.install", ...(workFolder ? { workFolder } : {}) });
      };
      const installBundle = async (source: string, contentDigest: string, skillNames: string[]) => {
        const context: PreparedActOutcome<PiSkillBundleImportResult> = {};
        await runPreparedAct({
          kind: "capability.skills.import",
          parameters: { source, scope: input.scope, ...scopedWorkFolder },
          pins: { source, contentDigest, skillNames },
          requestId: input.requestId,
          context,
        });
        await record();
        return {
          scope: input.scope,
          ...(workFolder ? { workFolder: toActWorkFolderRef(workFolder) } : {}),
          source,
          contentDigest,
          skillNames,
          bundlePath: context.outcome?.bundlePath ?? "",
        };
      };
      const installPackage = async (
        parameters: PreparedActFields,
        details: { id: string; version: string; installSource: string },
        resourceSummary: string,
      ) => {
        await runPreparedAct({
          kind: "capability.package.install",
          parameters,
          pins: {
            packageId: details.id,
            version: details.version,
            source: details.installSource,
            scope: input.scope,
            resourceSummary,
          },
          requestId: input.requestId,
        });
        await record();
        return {
          scope: input.scope,
          ...(workFolder ? { workFolder: toActWorkFolderRef(workFolder) } : {}),
          source: details.installSource,
          packageId: details.id,
          version: details.version,
          resourceSummary,
          installed: true as const,
        };
      };
      if (input.catalogId !== undefined) {
        // Remote inspection is read-only and can take seconds; it completes
        // before anything is pinned, exactly as the desktop review does.
        const details = await runActOperation(() => state.capabilityRegistry.details(input.catalogId!));
        if (details.sourceKind === "reference") {
          throw new WorkFoldCliError("usage", "This capability is a reference and cannot be installed directly.");
        }
        if (details.sourceKind === "bundle") {
          // An official catalog skill bundle makes bytes runnable as a skill
          // import: the exact built bytes are digest-pinned, and execution
          // rebuilds and re-verifies them.
          const bundle = await runActOperation(() => state.capabilityRegistry.buildOfficialSkillBundle(input.catalogId!));
          const contentDigest = piSkillBundleContentDigest(bundle.bytes);
          const skillNames = details.skills?.length
            ? [...details.skills].sort()
            : await enumerateSkillBundleNames(bundle.fileName, bundle.bytes);
          return installBundle(input.catalogId, contentDigest, skillNames);
        }
        if (!details.installSource || !details.version) {
          throw new WorkFoldCliError(
            "unavailable",
            "work-fold cannot pin an exact version for this package source yet, so it cannot install it from here. Install it from Skills & Extensions on the desktop.",
          );
        }
        return installPackage(
          { catalogId: input.catalogId, scope: input.scope, ...scopedWorkFolder },
          { id: details.id, version: details.version, installSource: details.installSource },
          capabilityResourceSummary(details),
        );
      }
      const identity = npmSourceIdentity(input.source ?? "");
      if (!identity) {
        throw new WorkFoldCliError(
          "unavailable",
          "work-fold can pin an exact version only for npm package sources yet, so it cannot install this source from here. Install it from Skills & Extensions on the desktop.",
        );
      }
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.installSource || !details.version) {
        throw new WorkFoldCliError("unavailable", "npm did not report an exact installable version for this package.");
      }
      if (identity.pinnedVersion !== undefined && identity.pinnedVersion !== details.version) {
        throw new WorkFoldCliError(
          "conflict",
          `work-fold inspects the latest published version (${details.version}) and installs only that exact version; `
            + `the source pins ${identity.pinnedVersion}. Install without a version pin, or use the inspected version.`,
        );
      }
      return installPackage(
        { source: details.installSource, scope: input.scope, ...scopedWorkFolder },
        { id: details.id, version: details.version, installSource: details.installSource },
        capabilityResourceSummary(details),
      );
    },
    async toolsSetEnabled(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = input.scope === "work-folder" ? await resolveWorkFolder(input.workFolder ?? "") : undefined;
      const root = workFolder?.workFolderRoot ?? workFoldAgentRoot();
      if (workFolder) await assertWorkFolderCapabilityTrust(workFolder);
      const act = await prepareResourceEnable(root, { path: input.path, kind: input.kind, enabled: input.enabled, scope: input.scope, ...(workFolder ? { workFolderId: workFolder.id } : {}) }, state.runtimeProvider);
      await runPreparedAct({ ...act, requestId: input.requestId });
      await recordFacadeAction(state, input.parentTaskId, { command: input.enabled ? "tools.enable" : "tools.disable", ...(workFolder ? { workFolder } : {}) });
      return { scope: input.scope, ...(workFolder ? { workFolder: toActWorkFolderRef(workFolder) } : {}), path: String(act.parameters.path), enabled: input.enabled };
    },
    async toolsUpdate(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = input.scope === "work-folder" ? await resolveWorkFolder(input.workFolder ?? "") : undefined;
      const source = input.source.trim();
      const identity = npmSourceIdentity(source);
      if (!identity) {
        throw new WorkFoldCliError(
          "unavailable",
          "work-fold can pin an exact version only for npm package sources yet, so it cannot update this source from here. Update it from Skills & Extensions on the desktop.",
        );
      }
      // Mirror the update path's configured-scope requirement early so the
      // refusal is honest; the capability fence is not needed for this read.
      const root = workFolder ? workFolder.workFolderRoot : workFoldAgentRoot();
      const piScope = workFolder ? "project" : "user";
      const configured = (await runActOperation(() => listPiPackages(root, state.runtimeProvider)))
        .find((item) => item.source === source && item.scope === piScope);
      if (!configured) {
        throw new WorkFoldCliError("notFound", `Package is not configured in the requested scope: ${source}`);
      }
      if (workFolder) await assertWorkFolderCapabilityTrust(workFolder);
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.version) {
        throw new WorkFoldCliError("unavailable", "npm did not report an exact version for this package.");
      }
      const resourceSummary = capabilityResourceSummary(details);
      const scopedWorkFolder: PreparedActFields = workFolder ? { workFolderId: workFolder.id } : {};
      await runPreparedAct({
        kind: "capability.package.update",
        parameters: { source, scope: input.scope, ...scopedWorkFolder },
        pins: {
          packageId: details.id,
          version: details.version,
          source,
          scope: input.scope,
          resourceSummary,
        },
        requestId: input.requestId,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.update", ...(workFolder ? { workFolder } : {}) });
      return {
        scope: input.scope,
        ...(workFolder ? { workFolder: toActWorkFolderRef(workFolder) } : {}),
        source,
        packageId: details.id,
        version: details.version,
        resourceSummary,
        updated: true as const,
      };
    },
    async appsInstallProposal(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const proposal = await runActOperation(() => state.restrictedAppProposals.get(input.proposal));
      if (!proposal || proposal.workFolderId !== workFolder.id || proposal.conversationId !== input.conversationId) {
        throw new WorkFoldCliError("notFound", "App proposal not found.");
      }
      if (proposal.status !== "pending" && proposal.status !== "failed") {
        throw new WorkFoldCliError(
          "conflict",
          proposal.status === "revision-changed"
            ? "The package changed after review; review the new revision before installing it."
            : `This app proposal is ${proposal.status}; only a pending or failed one can be installed.`,
        );
      }
      const context: PreparedActOutcome<RestrictedAppInstalled> = {};
      await runPreparedAct({
        kind: "app.review.install",
        parameters: { workFolderId: workFolder.id, proposalId: proposal.id },
        pins: { proposalId: proposal.id, reviewDigest: proposal.review.digest },
        requestId: input.requestId,
        context,
      });
      if (!context.outcome) throw new WorkFoldCliError("failure", "The app review did not report an installed app.");
      const app = workFoldAgentAppResultRef(context.outcome);
      const settled = await runActOperation(() => state.restrictedAppProposals.get(proposal.id));
      const outcome = workFoldAgentInstallOutcome(context.outcome, settled?.needs);
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.install-proposal", workFolder, apps: [app] });
      return { workFolder: toActWorkFolderRef(workFolder), proposalId: proposal.id, digest: proposal.review.digest, app, ...outcome };
    },
    async appsInstallPreview(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const packagePath = input.packagePath.trim();
      if (!packagePath) throw new WorkFoldCliError("usage", "Provide --package <work-folder-path>.");
      // The host inspects the package and owns every review field and the
      // digest — the same review record the Chat proposal path creates, under
      // an act-lane marker instead of a conversation — and installs it at
      // once through the same digest-checked path as a Chat proposal.
      const proposal = await runActOperation(async () => {
        const result = await state.restrictedAppProposals.propose({
          workFolderId: workFolder.id,
          workFolderRoot: workFolder.workFolderRoot,
          conversationId: workFoldActInstallPreviewConversationId,
          sourcePath: packagePath,
        });
        if (!result.proposal || result.status === "cancelled") {
          throw new WorkFoldCliError("failure", "The package review could not be recorded.");
        }
        if (result.status === "failed") {
          throw new WorkFoldCliError("failure", result.proposal.error ?? "The package could not be added.");
        }
        return result.proposal;
      });
      const replacesInstalled = (await runActOperation(() => state.restrictedApps.list(workFolder.id)))
        .some((app) => app.manifest.id === proposal.review.manifest.id);
      const context: PreparedActOutcome<RestrictedAppInstalled> = {};
      await runPreparedAct({
        kind: "app.review.install",
        parameters: { workFolderId: workFolder.id, proposalId: proposal.id },
        pins: { proposalId: proposal.id, reviewDigest: proposal.review.digest },
        requestId: input.requestId,
        context,
      });
      if (!context.outcome) throw new WorkFoldCliError("failure", "The package review did not report an installed app.");
      const app = workFoldAgentAppResultRef(context.outcome);
      const settled = await runActOperation(() => state.restrictedAppProposals.get(proposal.id));
      const outcome = workFoldAgentInstallOutcome(context.outcome, settled?.needs);
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.install-preview", workFolder, apps: [app] });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        proposalId: proposal.id,
        digest: proposal.review.digest,
        title: proposal.review.manifest.title,
        packageName: proposal.review.packageName,
        version: proposal.review.version,
        replacesInstalled,
        app,
        ...outcome,
      };
    },
    async appsGrant(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const app = await requireInstalledApp(workFolder, input.app);
      if (input.digest.trim() !== app.digest) {
        throw new WorkFoldCliError(
          "conflict",
          "Grants bind to the exact reviewed digest, and the installed app's digest is different. Read the current revision's review first.",
        );
      }
      const declaration = input.declaration.trim();
      const filePermission = input.kind === "files"
        ? app.manifest.permissions.files.find((item) => item.id === declaration)
        : undefined;
      const declared = input.kind === "network"
        ? app.manifest.permissions.network.some((item) => item.id === declaration)
        : input.kind === "files"
          ? Boolean(filePermission)
          : app.manifest.permissions.notifications.some((item) => item.id === declaration);
      if (!declared) throw new WorkFoldCliError("notFound", "The app does not declare this permission.");
      // A folder permission binds to the whole work-folder (docs/receipts-not-gates.md,
      // F21) and takes no file. A permission that names a single file binds to
      // the exact work-folder-relative file named here; without one there is nothing
      // to hand the broker but a work-folder root it would reject.
      const requestedPath = input.path?.trim();
      if (requestedPath !== undefined && requestedPath !== "" && (input.kind !== "files" || filePermission?.target === "directory")) {
        throw new WorkFoldCliError(
          "usage",
          "Only a permission that names a single file takes a file; a folder permission covers the whole work-folder.",
        );
      }
      if (filePermission && filePermission.target !== "directory" && !requestedPath) {
        throw new WorkFoldCliError(
          "usage",
          `This permission needs one file. Name it with --path <work-folder-path>, or pick it for “${declaration}” in Settings → Apps, under work-folder files.`,
        );
      }
      const kind = input.kind === "network"
        ? "app.grant.network" as const
        : input.kind === "files"
          ? "app.grant.files" as const
          : "app.grant.notifications" as const;
      const root = input.kind !== "files"
        ? undefined
        : requestedPath
          ? await grantedWorkFolderFile(workFolder.workFolderRoot, requestedPath)
          : ".";
      await runPreparedAct({
        kind,
        parameters: { workFolderId: workFolder.id, appInstanceId: app.featureInstallationId, declarationId: declaration },
        pins: {
          appInstanceId: app.featureInstallationId,
          declarationId: declaration,
          releaseDigest: app.releaseDigest ?? app.digest,
        },
        requestId: input.requestId,
        ...(root !== undefined ? { context: { root } } : {}),
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.grant", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        grantKind: input.kind,
        declaration,
        granted: true as const,
        ...(root !== undefined ? { root } : {}),
      };
    },
    async appsConnect(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const app = await requireInstalledApp(workFolder, input.app);
      const destination = app.manifest.permissions.network.find((item) => item.id === input.destination.trim());
      if (!destination) throw new WorkFoldCliError("notFound", "The app does not declare this connection destination.");
      const target = destination.target.kind === "public-https"
        ? String(destination.target.origin)
        : `http://${String(destination.target.host)}:${String(destination.target.port)}`;
      // The act names the connection's shape only — app, destination, target,
      // adapter — never a secret. Only the browser sign-in flow can run
      // without a person typing a credential.
      const adapterKind = destination.auth.some((item) => item.kind === "oauth2-pkce")
        ? "oauth2-pkce"
        : destination.auth[0]?.kind;
      if (!adapterKind) throw new WorkFoldCliError("conflict", "This destination declares no credential adapter to connect with.");
      if (adapterKind !== "oauth2-pkce") {
        throw new WorkFoldCliError(
          "permissionDenied",
          "This destination takes a secret typed on the desktop. Connect it from Settings → Apps.",
        );
      }
      const context: PreparedActOutcome<RestrictedAppConnectionStatus> = {};
      await runPreparedAct({
        kind: "app.connection.save",
        parameters: { workFolderId: workFolder.id, appInstanceId: app.featureInstallationId, destinationId: destination.id },
        pins: {
          appInstanceId: app.featureInstallationId,
          declarationId: destination.id,
          target,
          adapterKind,
        },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.connect", workFolder });
      const connection = context.outcome;
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        destination: destination.id,
        target,
        adapterKind,
        connection: {
          destinationId: connection?.destinationId ?? destination.id,
          kind: connection?.kind ?? adapterKind,
          configured: connection?.configured ?? true,
        },
      };
    },
    async appsAutomationEnable(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const app = await requireInstalledApp(workFolder, input.app);
      const appAutomationId = input.automation.trim();
      const declaration = app.manifest.automations.find((item) => item.id === appAutomationId);
      if (!declaration) throw new WorkFoldCliError("notFound", "The app does not declare this automation.");
      if (app.automations.some((automation) => automation.id === appAutomationId && automation.enabled)) {
        throw new WorkFoldCliError("conflict", "This automation is already enabled.");
      }
      const scheduleSummary = restrictedAppAutomationScheduleSummary(declaration);
      await runPreparedAct({
        kind: "app.automation.enable",
        parameters: { workFolderId: workFolder.id, appInstanceId: app.featureInstallationId, appAutomationId },
        pins: {
          appInstanceId: app.featureInstallationId,
          appAutomationId,
          reviewedDigest: app.digest,
          scheduleSummary,
        },
        requestId: input.requestId,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.automation.enable", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        appAutomationId,
        scheduleSummary,
        enabled: true as const,
      };
    },
    async appsStorageClear(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const app = await requireInstalledApp(workFolder, input.app);
      // The receipt states the byte count being cleared; without an
      // observable count the act refuses instead of clearing blind, and a
      // count that changes before the effect is a conflict.
      const usage = await runActOperation(() => state.restrictedApps.storageUsage(workFolder.id, app.manifest.id, app.digest, app.featureInstallationId));
      const context: PreparedActOutcome<{ remainingBytes: number; recentlyDeleted: RecentlyDeletedRef | null }> = {};
      await runPreparedAct({
        kind: "app.storage.clear",
        parameters: { workFolderId: workFolder.id, appInstanceId: app.featureInstallationId },
        pins: {
          appInstanceId: app.featureInstallationId,
          dataNamespaceIds: [app.dataNamespaceId],
          observedBytes: usage.usageBytes,
        },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.storage.clear", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        appId: app.manifest.id,
        clearedBytes: usage.usageBytes,
        remainingBytes: context.outcome?.remainingBytes ?? 0,
        recentlyDeleted: context.outcome?.recentlyDeleted ?? null,
      };
    },
    async appsRetainedPurge(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const studio = await runActOperation(() => state.restrictedApps.localAppStudio(workFolder.id));
      const retained = studio.retainedData.find((item) => item.retainedDataId === input.retained.trim());
      if (!retained) throw new WorkFoldCliError("notFound", "Retained App data record not found in this work-folder's App Studio.");
      const context: PreparedActOutcome<{ cleanupPending: boolean; recentlyDeleted: RecentlyDeletedRef[] }> = {};
      await runPreparedAct({
        kind: "app.data.purge",
        parameters: { workFolderId: workFolder.id, appInstanceId: retained.featureInstallationId, purgeTarget: "retained" },
        pins: {
          appInstanceId: retained.featureInstallationId,
          dataNamespaceIds: [retained.dataNamespaceId],
          retainedDataId: retained.retainedDataId,
          sourceWorkFolderId: workFolder.id,
        },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.retained.purge", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        retainedDataId: retained.retainedDataId,
        dataNamespaceIds: [retained.dataNamespaceId],
        purged: true as const,
        cleanupPending: context.outcome?.cleanupPending ?? false,
        recentlyDeleted: context.outcome?.recentlyDeleted ?? [],
      };
    },
    async appsUninstallPurge(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const installed = (await runActOperation(() => state.restrictedApps.list(workFolder.id))).find((app) => (
        app.runtimeInstanceKind === "app" && app.runtimeInstanceId === input.instance
      ));
      if (!installed) throw new WorkFoldCliError("notFound", "Local App Instance not found.");
      const context: PreparedActOutcome<{ cleanupPending: boolean; recentlyDeleted: RecentlyDeletedRef[] }> = {};
      await runPreparedAct({
        kind: "app.data.purge",
        parameters: { workFolderId: workFolder.id, appInstanceId: installed.featureInstallationId, purgeTarget: "runtime-instance" },
        pins: {
          appInstanceId: installed.featureInstallationId,
          dataNamespaceIds: [installed.dataNamespaceId],
          runtimeInstanceId: installed.runtimeInstanceId,
          sourceWorkFolderId: installed.sourceWorkFolderId,
        },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "apps.uninstall", workFolder });
      return {
        workFolder: toActWorkFolderRef(workFolder),
        runtimeInstanceId: installed.runtimeInstanceId,
        purgedNamespaceIds: [installed.dataNamespaceId],
        removed: true as const,
        cleanupPending: context.outcome?.cleanupPending ?? false,
        recentlyDeleted: context.outcome?.recentlyDeleted ?? [],
      };
    },
    async automationsEnable(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const { declaration, digest } = await readAutomationStagingFile(input.proposalPath, input.cwd);
      const enabled = await enableStoredAutomationDeclaration(state, declaration, digest, {
        surface: "cli",
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "automations.enable" });
      return enabled;
    },
    async pagesShare(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const view = await sharePageFromDesktop(state, {
        workFolder,
        path: input.path,
        title: input.title,
        snapshot: input.snapshot === true,
      }, {
        surface: "cli",
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "pages.share", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), publication: toActPublicationRef(view, workFolder.name) };
    },
    async pagesShareApp(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const workFolder = await resolveWorkFolder(input.workFolder);
      const status = state.publications.status();
      if (status.damaged) {
        throw new WorkFoldCliError("failure", `work-fold cannot share an app: ${status.damageReason ?? "the publication store is damaged."}`);
      }
      // Exposure eligibility and pins come from the viewer adapter: an
      // installed App Instance of a prepared Release whose reviewed manifest
      // declares a viewer surface. The effect-time recheck re-resolves the
      // same identity before anything activates. `--instance` accepts the App
      // Instance id (the pin identity) or, like `apps uninstall`, the
      // Runtime Instance id of an app installed in this work-folder.
      const requested = input.instance.trim();
      const byRuntimeId = (await runActOperation(() => state.restrictedApps.list(workFolder.id)))
        .find((app) => app.runtimeInstanceKind === "app" && app.runtimeInstanceId === requested);
      const exposure = await state.restrictedAppViewer.resolveExposure(byRuntimeId?.featureInstallationId ?? requested);
      if (!exposure.eligible) throw new WorkFoldCliError("conflict", exposure.issue);
      if (exposure.workFolderId !== workFolder.id) {
        throw new WorkFoldCliError("notFound", "This work-folder has no installed App Instance with this id.");
      }
      const alreadyExposed = (await runActOperation(() => state.publications.list())).some((view) => (
        view.state === "active" && view.kind === "app" && view.app?.appInstanceId === exposure.pins.appInstanceId
      ));
      if (alreadyExposed) {
        throw new WorkFoldCliError("conflict", "This App Instance is already at your address; stop sharing it before exposing it again.");
      }
      const requestId = input.requestId?.trim() || randomUUID();
      const context: ViewerExposeContext = {
        requestId,
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        attribution: preparedActAttribution(state, "cli", input.parentTaskId),
      };
      await runPreparedAct({
        kind: "publish.viewer.expose",
        parameters: { exposure: "hosted-app", appInstanceId: exposure.pins.appInstanceId },
        pins: {
          exposure: "hosted-app",
          appInstanceId: exposure.pins.appInstanceId,
          releaseDigest: exposure.pins.releaseDigest,
          viewerEntry: exposure.pins.viewerEntry,
          viewerSurface: exposure.pins.viewerSurface,
        },
        requestId,
        context,
      });
      if (!context.outcome) throw new WorkFoldCliError("failure", "The app was not put at your address.");
      await recordFacadeAction(state, input.parentTaskId, { command: "pages.share-app", workFolder });
      return { workFolder: toActWorkFolderRef(workFolder), publication: toActPublicationRef(context.outcome, workFolder.name) };
    },
    async recentlyDeletedList() {
      const listing = await runActOperation(() => state.recentlyDeleted.list());
      const registered = new Set((await listWorkFolders()).map((workFolder) => workFolder.id));
      const entries: WorkFoldActRecentlyDeletedEntry[] = [];
      for (const entry of listing.entries) entries.push(await recentlyDeletedEntryView(state, entry, registered));
      return { entries, retentionDays: listing.retentionDays, damagedCount: listing.damaged.length };
    },
    async recentlyDeletedRestore(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const entryId = input.entry.trim();
      if (!workFoldRecentlyDeletedEntryIdPattern.test(entryId)) {
        throw new WorkFoldCliError("usage", "'--entry' takes a Recently deleted item id from 'recently-deleted list'.");
      }
      const before = await runActOperation(() => state.recentlyDeleted.get(entryId).catch(() => null));
      const restored = await runActOperation(() => restoreRecentlyDeletedEntry(state, entryId, {
        receiptId: input.requestId ?? null,
        ...(input.toPath === undefined ? {} : { toPath: input.toPath }),
      }));
      const workFolder = "workFolder" in restored ? await getWorkFolder(restored.workFolder.id).catch(() => null) : null;
      await recordFacadeAction(state, input.parentTaskId, {
        command: "recently-deleted.restore",
        ...(workFolder ? { workFolder } : {}),
      });
      // The entry id is the request's own input; the result reports what came
      // back, with the entry it came from alongside.
      const effect = restored.kind === "saved-copy"
        ? { kind: restored.kind, path: restored.path }
        : restored.kind === "work-folder"
          ? { kind: restored.kind, workFolder: restored.workFolder, workFolderRoot: restored.workFolderRoot, renamed: restored.renamed }
          : restored.kind === "app-storage"
            ? { kind: restored.kind, workFolder: restored.workFolder, appId: restored.appId, usage: restored.usage }
            : {
              kind: restored.kind,
              workFolder: restored.workFolder,
              path: restored.path,
              renamed: restored.renamed,
              safetyCheckpointId: restored.safetyCheckpointId,
            };
      return {
        entry: before ? await recentlyDeletedEntryView(state, before) : null,
        restored: effect,
      };
    },
    async automationsList() {
      const projections = await runActOperation(() => state.automations.listAutomations());
      return { automations: projections.map(toActAutomationSummary) };
    },
    async automationsShow(input) {
      const automationId = input.automation.trim();
      const projection = await runActOperation(() => state.automations.getAutomation(automationId));
      if (!projection) throw new WorkFoldCliError("notFound", "No automation has this id on this machine.");
      const workFolderNames = new Map<string, string>();
      for (const workFolderId of workFoldAutomationReferencedWorkFolderIds(projection.declaration)) {
        const registered = await getWorkFolder(workFolderId).catch(() => null);
        if (registered) workFolderNames.set(workFolderId, registered.name);
      }
      const named = (workFolderId: string) => (workFolderNames.has(workFolderId) ? { workFolderName: workFolderNames.get(workFolderId)! } : {});
      return {
        automation: {
          ...toActAutomationSummary(projection),
          steps: projection.declaration.steps.map((step) => step.kind === "chat"
            ? { id: step.id, kind: "chat" as const, workFolderId: step.workFolder, ...named(step.workFolder), message: step.message }
            : step.kind === "files"
              ? {
                id: step.id,
                kind: "files" as const,
                fromWorkFolderId: step.fromWorkFolder,
                ...(workFolderNames.has(step.fromWorkFolder) ? { fromWorkFolderName: workFolderNames.get(step.fromWorkFolder)! } : {}),
                source: toActAutomationFilesSource(step.from),
                toWorkFolderId: step.toWorkFolder,
                ...(workFolderNames.has(step.toWorkFolder) ? { toWorkFolderName: workFolderNames.get(step.toWorkFolder)! } : {}),
                to: step.to,
              }
              : step.kind === "check"
                ? { id: step.id, kind: "check" as const, workFolderId: step.workFolder, ...named(step.workFolder), ...(step.check ? { checkId: step.check } : {}) }
                : { id: step.id, kind: "agent" as const, message: step.message }),
          grants: projection.grants.map((grant) => ({
            digest: grant.digest,
            requestId: grant.requestId,
            enabledAt: grant.enabledAt,
            surface: grant.surface,
            ...(grant.browserId ? { browserId: grant.browserId } : {}),
          })),
        },
      };
    },
    async automationsRun(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const projection = await runActOperation(() => state.automations.getAutomation(automationId));
      if (!projection) throw new WorkFoldCliError("notFound", "No automation has this id on this machine.");
      const run = await runActOperation(() => state.automations.runNow(automationId, {
        ...(input.requestId ? { requestId: input.requestId } : {}),
      }));
      return {
        automationId,
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
    async automationsStop(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const stopped = state.automations.stopRun(automationId);
      if (!stopped) {
        throw new WorkFoldCliError("conflict", "This automation has no active run; its settled state already stands.");
      }
      return { automationId, stopped: true as const, runId: stopped.runId };
    },
    async automationsDisable(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const result = await runActOperation(() => state.automations.disable(automationId));
      return {
        automationId,
        disabled: true as const,
        digest: result.record.digest,
        stoppedRunId: result.stoppedRunId,
      };
    },
    async automationsDelete(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const record = await runActOperation(() => state.automations.deleteAutomation(automationId));
      if (record.health !== "disabled" && record.health !== "suspended" && record.health !== "completed") {
        throw new WorkFoldCliError("failure", "The automation was deleted in an unexpected health state.");
      }
      return { automationId, deleted: true as const, digest: record.digest, finalHealth: record.health };
    },
    async automationsReceipts(input) {
      const projection = await readAutomationReceiptProjection(input.automation?.trim());
      return { ...projection, receipts: [...projection.receipts].reverse() };
    },
    async pagesList() {
      const views = await runActOperation(() => state.publications.list());
      const workFolderNames = new Map<string, string>();
      for (const view of views) {
        if (workFolderNames.has(view.workFolderId)) continue;
        const registered = await getWorkFolder(view.workFolderId).catch(() => null);
        if (registered) workFolderNames.set(view.workFolderId, registered.name);
      }
      return { publications: views.map((view) => toActPublicationRef(view, workFolderNames.get(view.workFolderId))) };
    },
    async pagesStatus(input) {
      const publicationId = input.publication.trim();
      const view = await runActOperation(() => state.publications.get(publicationId));
      if (!view) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const registered = await getWorkFolder(view.workFolderId).catch(() => null);
      return { publication: toActPublicationRef(view, registered?.name) };
    },
    async pagesRevoke(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const publicationId = input.publication.trim();
      const prior = await runActOperation(() => state.publications.get(publicationId));
      if (!prior) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const registered = await getWorkFolder(prior.workFolderId).catch(() => null);
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
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
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
      const registered = await getWorkFolder(view.workFolderId).catch(() => null);
      return {
        publication: toActPublicationRef(view, registered?.name),
        priorServeRatePerMinute: prior.serveRatePerMinute,
        priorByteBudgetPerDay: prior.byteBudgetPerDay,
      };
    },
    async pagesWiden(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const publicationId = input.publication.trim();
      const prior = await runActOperation(() => state.publications.get(publicationId));
      if (!prior) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const view = await runPublicationActOperation(() => state.publications.widen(publicationId, {
        ...(input.serveRatePerMinute !== undefined ? { serveRatePerMinute: input.serveRatePerMinute } : {}),
        ...(input.byteBudgetPerDay !== undefined ? { byteBudgetPerDay: input.byteBudgetPerDay } : {}),
        ...(input.snapshot === true ? { snapshotEnabled: true as const } : {}),
      }, {
        requestId: input.requestId ?? randomUUID(),
        surface: "cli",
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      }));
      const registered = await getWorkFolder(view.workFolderId).catch(() => null);
      return {
        publication: toActPublicationRef(view, registered?.name),
        priorServeRatePerMinute: prior.serveRatePerMinute,
        priorByteBudgetPerDay: prior.byteBudgetPerDay,
        priorSnapshotEnabled: prior.snapshotEnabled,
      };
    },
    async pagesSnapshotOff(input) {
      assertWorkFoldAgentParentAccepting(state, input.parentTaskId);
      const publicationId = input.publication.trim();
      const prior = await runActOperation(() => state.publications.get(publicationId));
      if (!prior) throw new WorkFoldCliError("notFound", "No publication has this id on this machine.");
      const view = await runActOperation(() => state.publications.disableSnapshot(publicationId, {
        requestId: input.requestId ?? randomUUID(),
        surface: "cli",
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      }));
      const registered = await getWorkFolder(view.workFolderId).catch(() => null);
      return { publication: toActPublicationRef(view, registered?.name), wasEnabled: prior.snapshotEnabled };
    },
    async checksEnable(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => {
        const proposalPath = isAbsolute(input.proposalPath)
          ? resolve(input.proposalPath)
          : resolve(input.cwd, input.proposalPath);
        const enabled = await runActOperation(() => state.checks.enable({
          workFolder: workFolder,
          proposalPath,
          actor: "cli",
          ...(input.proposeOnly ? { proposeOnly: true } : {}),
        }));
        return {
          workFolder: toActWorkFolderRef(workFolder),
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
    async checksProposeFix(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      const proposalPath = isAbsolute(input.proposalPath) ? resolve(input.proposalPath) : resolve(input.cwd, input.proposalPath);
      const correction = await runReservedCheckOperation(state, workFolder.id, () => state.checks.proposeCorrection({ workFolder, proposalPath }));
      return { workFolder: toActWorkFolderRef(workFolder), correction };
    },
    async checksDisable(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => ({
        workFolder: toActWorkFolderRef(workFolder),
        checkId: input.checkId,
        disabled: await runActOperation(() => state.checks.disable(workFolder, input.checkId)),
      }));
    },
    async checksRun(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => {
        const accepted = await runActOperation(() => state.checks.run({
          workFolder: workFolder,
          ...(input.checkId ? { checkId: input.checkId } : {}),
          actor: { kind: "cli", cwd: workFolder.workFolderRoot, workFolderId: workFolder.id },
        }));
        return { workFolder: toActWorkFolderRef(workFolder), ...accepted };
      });
    },
    async checksTask(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => ({
        workFolder: toActWorkFolderRef(workFolder),
        task: await state.checks.taskStatus(workFolder.id, input.taskId),
      }));
    },
    async checksResult(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => {
        const run = await runActOperation(() => state.checks.taskResult(workFolder.id, input.taskId));
        if (run.state === "aborted" || run.state === "interrupted") {
          throw new WorkFoldCliError("conflict", run.error ?? "The Check run did not finish.");
        }
        if (run.state === "failed") throw new WorkFoldCliError("failure", run.error ?? "The Check run failed.");
        return { workFolder: toActWorkFolderRef(workFolder), run };
      });
    },
    async checksAbort(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => ({
        workFolder: toActWorkFolderRef(workFolder),
        taskId: input.taskId,
        aborted: await state.checks.abort(workFolder.id, input.taskId),
      }));
    },
    async checksProblems(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => {
        const result = await runActOperation(() => state.checks.problems(workFolder, input.checkId));
        return {
          workFolder: toActWorkFolderRef(workFolder),
          ...(input.checkId ? { checkId: input.checkId } : {}),
          ...result,
        };
      });
    },
    async checksDecide(input) {
      const workFolder = await resolveWorkFolder(input.workFolder);
      return runReservedCheckOperation(state, workFolder.id, async () => {
        const decision = await runActOperation(() => state.checks.decide({
          workFolderId: workFolder.id,
          findingId: input.findingId,
          decision: input.decision,
          actor: "cli",
          ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
        }));
        return { workFolder: toActWorkFolderRef(workFolder), findingId: input.findingId, decision };
      });
    },
    async agentList() {
      const scope = workFoldAgentScope(state);
      const conversations = await runActOperation(() => listConversations(scope.rootPath));
      return { conversations: conversations.map(toActConversationRef) };
    },
    async agentSend(input) {
      const content = input.content.trim();
      if (!content) throw new WorkFoldCliError("usage", "Message content is required.");
      const scope = workFoldAgentScope(state);
      const attachments = await classifyActWorkFoldAgentAttachments(input.attachments ?? [], input.cwd);
      return runActOperation(async () => {
        const conversationId = input.newConversation
          ? (await createConversation(scope.rootPath)).id
          : input.conversationId ?? (await resolveWorkFoldAgentConversation(true)).id;
        const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, workFolderRoot: scope.rootPath }, conversationId, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
          workFoldAgentAttachments: attachments,
          requestId: input.requestId,
        });
        return { conversationId, messageId: message.id, taskId, attachments };
      });
    },
    async agentConversationStatus(input) {
      const scope = workFoldAgentScope(state);
      const conversation = input.conversationId
        ? await runActOperation(() => readConversationSummary(scope.rootPath, input.conversationId!))
        : await runActOperation(() => resolveWorkFoldAgentConversation(false).catch(() => null));
      if (!conversation) {
        throw new WorkFoldCliError(
          "notFound",
          input.conversationId ? "Conversation not found." : "No work-fold agent exists yet. Send a message to start one.",
        );
      }
      return {
        conversation: toActConversationRef(conversation),
        state: conversationRuntimeState(state, scope.id, conversation.id),
      };
    },
    async agentTurnStatus(input) {
      assertWorkFoldAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const record = state.requests.byTaskId(taskId);
      return {
        task: turnStatusFor(state, workFoldAgentScopeId, taskId),
        request: await workFoldAgentRequestView(state, taskId),
        waiting: waitingRefForTask(state, taskId),
        requestGraph: record ? toActRequestRef(state, record) : null,
      };
    },
    async agentStop(input) {
      assertWorkFoldAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      return stopWorkFoldAgentRequest(state, taskId);
    },
    async agentConversationResult(input) {
      const scope = workFoldAgentScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveWorkFoldAgentConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new WorkFoldCliError("notFound", "No work-fold agent exists yet. Send a message to start one.");
      }
      return conversationResultForScope(state, scope.id, scope.rootPath, conversationId, input.messages);
    },
    async agentTurnResult(input) {
      assertWorkFoldAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkFoldCliError("usage", "Provide --task <id>.");
      const scope = workFoldAgentScope(state);
      return turnResultForScope(state, scope.id, scope.rootPath, taskId);
    },
    async agentAbort(input) {
      const scope = workFoldAgentScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveWorkFoldAgentConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new WorkFoldCliError("notFound", "No work-fold agent exists yet. Send a message to start one.");
      }
      const client = state.clients.get(clientKey(scope.id, conversationId));
      return { conversationId, aborted: client ? await client.abort() : false };
    },
    async agentOverview() {
      // Deliberately no management-readiness gate: the overview reads recorded
      // state through the kernel, never the agent, and stays available
      // while the work-fold agent is not.
      return runActOperation(() => state.kernel.getOverview({ kind: "cli" }));
    },
  };
}

/** The work-fold agent scope shaped like the work-folder refs the turn internals take. */
function workFoldAgentScope(state?: LocalApiState): { id: string; rootPath: string } {
  if (state) assertWorkFoldAgentInstructionsReady(state);
  return { id: workFoldAgentScopeId, rootPath: workFoldAgentRoot() };
}

function assertWorkFoldAgentInstructionsReady(state: LocalApiState): void {
  if (!state.workFoldAgentInstructionsError) return;
  throw new WorkFoldCliError(
    "unavailable",
    "The work-fold agent is unavailable because work-fold could not prepare its required instructions. Restart work-fold; if this continues, check the app-data work-fold agent folder.",
  );
}

/** HTTP mirror of the fail-closed instructions gate: 503 instead of a CLI error. */
function assertWorkFoldAgentReadyForRoutes(state: LocalApiState): void {
  if (!state.workFoldAgentInstructionsError) return;
  throw httpError(503, "The work-fold agent is unavailable because work-folder could not prepare its required instructions. Restart work-folder; if this continues, check the app-data work-fold agent folder.");
}

function workFoldAgentScopeForRoutes(state: LocalApiState): { id: string; rootPath: string } {
  assertWorkFoldAgentReadyForRoutes(state);
  return { id: workFoldAgentScopeId, rootPath: workFoldAgentRoot() };
}

/**
 * The default work-fold agent is the most recent active one; the
 * work-fold agent surface is "one conversation" unless the caller asks for more.
 */
async function resolveWorkFoldAgentConversation(create: boolean): Promise<ConversationSummary> {
  const scope = workFoldAgentScope();
  const conversations = await listConversations(scope.rootPath);
  const active = conversations.find((item) =>
    !item.archivedAt && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= Date.now()));
  if (active) return active;
  if (!create) throw new WorkFoldCliError("notFound", "No work-fold agent exists yet. Send a message to start one.");
  return createConversation(scope.rootPath);
}

/**
 * The work-fold agent transcript lives outside every work-folder, so it has no History
 * checkpoint to hold it. Its only deletion path moves the exact validated
 * transcript into Recently deleted. It deliberately never accepts a path.
 */
async function deleteWorkFoldAgentConversation(
  state: LocalApiState,
  conversationId: string,
  context: { receiptId: string | null },
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const root = workFoldAgentRoot();
  const key = clientKey(workFoldAgentScopeId, conversationId);
  assertWorkFoldAgentConversationMutable(state, conversationId);
  // This reservation uses the same conflict fence as compaction because a
  // transcript move must not race a new turn, rename, or real compaction.
  state.compactingConversations.add(key);
  try {
    const summary = await readConversationSummary(root, conversationId).catch((error) => {
      throw badRequest(errorMessage(error));
    });
    if (!summary) throw notFound("Conversation not found.");
    if (state.requests.list().some((request) =>
      request.owner.workFolderId === undefined
      && request.owner.conversationId === conversationId
      && requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Chat's outstanding work before deleting it.");
    }
    // An idle client can still hold the Pi session and extension callbacks.
    // Stop disposes that session before its transcript leaves the live root.
    await state.clients.get(key)?.stop();
    // `readConversationSummary` validated the id before this join. The source
    // remains a single known transcript below the app-owned management root.
    const relativePath = `.work-fold/conversations/${conversationId}.jsonl`;
    const sourcePath = join(root, relativePath);
    let entry: WorkFoldRecentlyDeletedEntry;
    try {
      entry = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "file",
        reason: "agent.chat.delete",
        sourcePath,
        workFolderId: workFoldAgentScopeId,
        workFolderName: "work-fold agent",
        displayName: summary.title,
        originalPath: relativePath,
        receiptId: context.receiptId,
      });
    } catch (error) {
      throw new WorkFoldCliError(
        "failure",
        `work-fold could not move this Chat to Recently deleted: ${errorMessage(error)}. Nothing was deleted.`,
        { cause: error },
      );
    }
    state.clients.delete(key);
    return { conversationId, recentlyDeleted: { entryId: entry.id, restoreBy: entry.restoreBy } };
  } finally {
    state.compactingConversations.delete(key);
  }
}

/**
 * A Worker Chat's transcript is portable `.work-fold/` metadata, which History
 * never captures, so deletion moves the exact validated transcript into
 * Recently deleted. The Pi session stays in machine-local state, so a restored
 * Chat resumes where it was. It deliberately never accepts a path.
 */
async function deleteWorkFolderConversation(
  state: LocalApiState,
  workFolder: WorkFolderSummary,
  conversationId: string,
  context: { receiptId: string | null },
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const key = clientKey(workFolder.id, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  // The same conflict fence compaction uses: a transcript move must not race
  // a new turn, rename, lifecycle change, or real compaction.
  state.compactingConversations.add(key);
  try {
    const summary = await readConversationSummary(workFolder.workFolderRoot, conversationId).catch((error) => {
      throw badRequest(errorMessage(error));
    });
    if (!summary) throw notFound("Conversation not found.");
    if (state.requests.list().some((request) =>
      request.owner.workFolderId === workFolder.id
      && request.owner.conversationId === conversationId
      && requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Chat's outstanding work before deleting it.");
    }
    await state.clients.get(key)?.stop();
    // `readConversationSummary` validated the id before this join.
    const relativePath = `.work-fold/conversations/${conversationId}.jsonl`;
    const sourcePath = join(conversationsDir(workFolder.workFolderRoot), `${conversationId}.jsonl`);
    let entry: WorkFoldRecentlyDeletedEntry;
    try {
      entry = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "file",
        reason: "chats.delete",
        sourcePath,
        workFolderId: workFolder.id,
        workFolderName: workFolder.name,
        displayName: summary.title,
        originalPath: relativePath,
        receiptId: context.receiptId,
      });
    } catch (error) {
      throw new WorkFoldCliError(
        "failure",
        `work-fold could not move this Chat to Recently deleted: ${errorMessage(error)}. Nothing was deleted.`,
        { cause: error },
      );
    }
    state.clients.delete(key);
    return { conversationId, recentlyDeleted: { entryId: entry.id, restoreBy: entry.restoreBy } };
  } finally {
    state.compactingConversations.delete(key);
  }
}

/** Reserve every transcript mutation through its final write, including CLI writes and restores. */
async function runConversationMutation<T>(
  state: LocalApiState,
  workFolderId: string,
  conversationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = clientKey(workFolderId, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  state.compactingConversations.add(key);
  try {
    return await operation();
  } finally {
    state.compactingConversations.delete(key);
  }
}

function assertWorkFoldAgentConversationMutable(state: LocalApiState, conversationId: string): void {
  const key = clientKey(workFoldAgentScopeId, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
}

async function renameWorkFoldAgentConversation(
  state: LocalApiState,
  conversationId: string,
  title: string,
  provenance?: Parameters<typeof renameConversation>[3],
): Promise<ConversationSummary> {
  const key = clientKey(workFoldAgentScopeId, conversationId);
  assertWorkFoldAgentConversationMutable(state, conversationId);
  // Renaming appends a transcript event, so reserve the same fence deletion
  // and compaction use before awaiting that write.
  state.compactingConversations.add(key);
  try {
    return await renameConversation(workFoldAgentRoot(), conversationId, title, provenance);
  } finally {
    state.compactingConversations.delete(key);
  }
}

function remoteWorkFoldAgentDeleteReceiptId(principal: WorkFoldRemotePrincipal): string {
  // Recently deleted receipts accept bounded plain text, while the three remote ids can
  // each be 160 characters. The digest preserves exact principal/request
  // identity without ever exposing it in the recovery listing.
  return `remote-agent-delete:${createHash("sha256")
    .update(`${principal.browserId}\0${principal.grantId}\0${principal.requestId}`)
    .digest("hex")}`;
}

async function findRemoteWorkFoldAgentDeleteReplay(
  state: LocalApiState,
  conversationId: string,
  receiptId: string,
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } } | null> {
  const receipts = await readActReceiptJournal(state);
  const prior = receipts.filter((record) => record.requestId === receiptId && record.command === "management.delete");
  const completed = [...prior].reverse().find((record) => record.outcome === "ok");
  if (completed) {
    const deleted = parseRemoteWorkFoldAgentDeleteReceipt(completed.detail);
    if (!deleted || deleted.conversationId !== conversationId) {
      throw httpError(409, "This remote request id was already used to delete another Chat.");
    }
    return deleted;
  }
  if (prior.some((record) => record.outcome === "accepted")) {
    throw httpError(409, "This remote deletion was already accepted, but its result is unavailable. Start a new delete request if the Chat is still present.");
  }
  const listing = await state.recentlyDeleted.list();
  const entry = listing.entries.find((candidate) => candidate.receiptId === receiptId);
  if (!entry) return null;
  const expectedPath = `.work-fold/conversations/${conversationId}.jsonl`;
  if (!isWorkFoldAgentConversationRecentlyDeletedEntry(entry) || entry.originalPath !== expectedPath) {
    throw httpError(409, "This remote request id was already used to delete another Chat.");
  }
  return { conversationId, recentlyDeleted: { entryId: entry.id, restoreBy: entry.restoreBy } };
}

function parseRemoteWorkFoldAgentDeleteReceipt(value: string | undefined): { conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { conversationId?: unknown; recentlyDeleted?: { entryId?: unknown; restoreBy?: unknown } };
    if (typeof parsed.conversationId !== "string"
      || typeof parsed.recentlyDeleted?.entryId !== "string"
      || typeof parsed.recentlyDeleted.restoreBy !== "string") return null;
    return { conversationId: parsed.conversationId, recentlyDeleted: { entryId: parsed.recentlyDeleted.entryId, restoreBy: parsed.recentlyDeleted.restoreBy } };
  } catch {
    return null;
  }
}

async function classifyActWorkFoldAgentAttachments(raw: string[], cwd: string | undefined): Promise<WorkFoldAgentAttachmentRef[]> {
  if (!raw.length) return [];
  try {
    return await classifyWorkFoldAgentAttachments(raw, cwd ?? workFoldAgentRoot());
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
}

/**
 * Rich, honest view of one request, keyed by any of its task ids. The phase
 * is the durable record's state mapped onto the vocabulary `agent status`
 * and the popover already speak (docs/collaboration-contract.md, F25): `done`
 * is claimed only when the request's own turn succeeded AND no child it
 * started is still running; downstream work keeps it in `handed_off`, and an
 * open question puts it in `needs_you`. A reply whose final non-empty line
 * asks a question also surfaces as `needs_you` — the agent is taught to
 * put its question on its own closing line, and a missed detection degrades
 * to `done` with the question still fully visible in the reply.
 *
 * The view names the newest turn of the request, so a task id whose request
 * was continued resolves to the continued story rather than a stale copy.
 */
async function workFoldAgentRequestView(
  state: LocalApiState,
  taskId: string,
): Promise<WorkFoldActAgentRequest | null> {
  const record = state.requests.byTaskId(taskId);
  if (!record) return null;
  const scopeId = record.owner.workFolderId ?? workFoldAgentScopeId;
  const newestTurn = record.turns.at(-1)!;
  const turn = turnStatusFor(state, scopeId, newestTurn.taskId);
  const children = state.requests.children(record.requestId).map((child): {
    taskId: string;
    workFolderId: string;
    workFolderName: string;
    conversationId: string;
    state: WorkFoldActTurnState;
    error: string | null;
    files: string[];
  } => {
    const childTurn = child.turns.at(-1)!;
    const live = child.owner.workFolderId ? turnStatusFor(state, child.owner.workFolderId, childTurn.taskId) : null;
    // A live turn's own status is sharper than the record's; a settled one
    // reads the record, which the turn journal already reconciled.
    const childState: WorkFoldActTurnState = live && live.state !== "unknown"
      ? live.state
      : childTurn.state === "accepted" || childTurn.state === "running"
        ? "running"
        : childTurn.state === "interrupted"
          ? "failed"
          : childTurn.state;
    return {
      taskId: childTurn.taskId,
      workFolderId: child.owner.workFolderId ?? workFoldAgentScopeId,
      workFolderName: child.owner.workFolderName ?? child.owner.workFolderId ?? "the work-fold agent",
      conversationId: child.owner.conversationId,
      state: childState,
      error: live?.error ?? childTurn.error,
      files: [],
    };
  });
  // Every changed file the children recorded, checked for visibility. No
  // prose parsing or folder scan; every candidate comes from the child's journal.
  const candidates = children.flatMap((child) => {
    const durable = state.turnStore.get(child.taskId);
    if (child.state === "running" || !durable || durable.workFolderId !== child.workFolderId || durable.conversationId !== child.conversationId) return [];
    return (durable.fileChanges?.files ?? []).map((file) => ({ child, path: file.path }));
  });
  const visible = await Promise.all(candidates.map(async (item) => await isRemoteFileVisible(item.child.workFolderId, item.path) ? item : null));
  for (const item of visible.filter((item) => item !== null)) item.child.files.push(item.path);
  const actions = record.actions;
  let reply: { messageId: string; content: string } | null = null;
  const replyMessageId = turn.state === "succeeded" || turn.state === "failed"
    ? turn.messageId
    : turn.state === "unknown" && (newestTurn.state === "succeeded" || newestTurn.state === "failed")
      ? newestTurn.messageId
      : null;
  if (replyMessageId) {
    const transcriptRoot = record.owner.workFolderId
      ? await getWorkFolder(record.owner.workFolderId).then((workFolder) => workFolder.workFolderRoot).catch(() => null)
      : workFoldAgentRoot();
    const messages = transcriptRoot ? await readConversation(transcriptRoot, record.owner.conversationId).catch(() => []) : [];
    const message = messages.find((item) => item.id === replyMessageId);
    if (message) reply = { messageId: message.id, content: message.content };
  }
  const failedChild = children.find((child) => child.state === "failed" || child.state === "unknown");
  // The durable record already knows whether a child is still live; the
  // in-memory task view only sharpens what a live turn reports.
  const phase = workFoldRequestStateToAgentPhase(record.state);
  const settledAt = record.settledAt ?? newestTurn.settledAt ?? turn.endedAt;
  const questions = state.requests.questions(record.requestId).map((question) => ({
    questionId: question.questionId,
    taskId: question.taskId,
    respondent: question.respondent,
    state: question.state,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
  }));
  return {
    taskId: newestTurn.taskId,
    conversationId: record.owner.conversationId,
    phase,
    startedAt: record.createdAt,
    endedAt: phase === "working" || phase === "handed_off" ? null : settledAt,
    error: turn.error ?? newestTurn.error ?? failedChild?.error ?? (failedChild?.state === "unknown"
      ? `work-folder lost track of work started in ${failedChild.workFolderName}.`
      : record.limitHit ? requestLimitStopMessage(record.limitHit.limit) : null),
    content: record.content,
    attachments: record.attachments,
    dispositions: workFoldAgentAttachmentDispositions({ attachments: record.attachments, actions: record.actions }),
    actions,
    children: children.map(({ files, ...child }) => files.length ? { ...child, files } : child),
    reply,
    source: workFoldRequestSource(record),
    remotePrincipalId: record.remote?.principalId ?? null,
    remoteRequestId: record.remote?.requestId ?? null,
    requestId: record.requestId,
    kind: record.kind,
    rootId: record.rootId,
    state: record.state,
    deadline: record.deadline,
    limitHit: record.limitHit,
    questions,
    results: record.results.map((result) => ({
      resultId: result.resultId,
      taskId: result.taskId,
      outcome: result.outcome,
      recordedAt: result.recordedAt,
      fileCount: result.fileCount,
    })),
  };
}

/** The person-facing sentence for a bound a request stopped at; it names the Settings section like every refusal. */
function requestLimitStopMessage(limit: WorkFoldRequestLimitName): string {
  const shows = `${workFoldRequestLimitsSection} shows this number.`;
  switch (limit) {
    case "providerBudget":
      return `This request reached its model spending limit, so work-fold stopped it. ${shows}`;
    case "deadline":
      return `This request passed its time window, so work-fold stopped it. ${shows}`;
    default:
      return `This request reached one of its limits, so work-fold stopped it. ${shows}`;
  }
}



/**
 * Request-level stop. Aborting the request's own turn does not implicitly
 * stop a review already running in a work-folder — only turns recorded under this
 * request are aborted, each explicitly, and the result names every turn it
 * touched. The stop cascades through the whole owned graph: every descendant
 * request is marked, its open questions are withdrawn, and its running turn
 * is cancelled (docs/collaboration-contract.md, F25).
 */
async function stopWorkFoldAgentRequest(
  state: LocalApiState,
  taskId: string,
): Promise<{ taskId: string; workFoldAgentAborted: boolean; children: Array<{ taskId: string; conversationId: string; workFolderId: string; aborted: boolean }> }> {
  const record = state.requests.byTaskId(taskId);
  if (!record) {
    throw new WorkFoldCliError("notFound", `Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
  }
  const scopeId = record.owner.workFolderId ?? workFoldAgentScopeId;
  const ownTurn = record.turns.at(-1)!;
  const workFoldAgentWasRunning = turnStatusFor(state, scopeId, ownTurn.taskId).state === "running";
  // The whole graph below this request, not only a root's: `agent stop`
  // takes any task id, so a mid-graph request must still close everything it
  // handed on (docs/collaboration-contract.md, F25).
  const descendants = state.requests.subtree(record.requestId);
  const runningChildren = descendants.flatMap((descendant) => {
    if (descendant.owner.workFolderId === undefined) return [];
    const turn = descendant.turns.at(-1)!;
    return turnStatusFor(state, descendant.owner.workFolderId, turn.taskId).state === "running"
      ? [{ taskId: turn.taskId, conversationId: descendant.owner.conversationId, workFolderId: descendant.owner.workFolderId, requestId: descendant.requestId }]
      : [];
  });
  // A stop reaches everything still open under this request, not only the
  // turns running this instant: a child whose turn ended while waiting on an
  // answer is closed too, so a late `chat answer` is refused and no
  // continuation turn can follow (docs/collaboration-contract.md, F28).
  const openBelow = !isWorkFoldRequestTerminalState(record.state)
    || descendants.some((descendant) => !isWorkFoldRequestTerminalState(descendant.state));
  if (workFoldAgentWasRunning || runningChildren.length || openBelow) {
    await state.requests.markStopRequested(record.requestId);
    await state.requests.cancelQuestions(record.requestId, "stopped");
    for (const descendant of descendants) {
      await state.requests.markStopRequested(descendant.requestId);
      await state.requests.cancelQuestions(descendant.requestId, "stopped");
    }
  }
  let workFoldAgentAborted = false;
  if (workFoldAgentWasRunning) {
    workFoldAgentAborted = await cancelAcceptedTurn(state, scopeId, record.owner.conversationId, ownTurn.taskId);
  }
  const children: Array<{ taskId: string; conversationId: string; workFolderId: string; aborted: boolean }> = [];
  for (const child of runningChildren) {
    const aborted = await cancelAcceptedTurn(state, child.workFolderId, child.conversationId, child.taskId);
    children.push({
      taskId: child.taskId,
      conversationId: child.conversationId,
      workFolderId: child.workFolderId,
      aborted,
    });
  }
  return { taskId, workFoldAgentAborted, children };
}

function assertWorkFoldAgentParentAccepting(state: LocalApiState, parentTaskId: string | undefined): void {
  if (!parentTaskId) return;
  if (!state.requests.isAccepting(parentTaskId)) {
    throw new WorkFoldCliError("conflict", "The work-fold agent request is stopping or has already finished.");
  }
}

/**
 * Attributes one applied facade mutation to its explicitly named management
 * request, so the request's recorded story stays complete across every landed
 * verb. work-folder-free acts (Everywhere-scope tools) record
 * no work-folder fields. `chat.send` keeps its own inline recording because it also
 * threads child-task bookkeeping and post-acceptance cancellation.
 */
async function recordFacadeAction(
  state: LocalApiState,
  parentTaskId: string | undefined,
  input: {
    command: WorkFoldRequestActionCommand;
    workFolder?: Pick<WorkFolderSummary, "id" | "name" | "workFolderRoot">;
    conversationId?: string;
    checkpointId?: string | null;
    taskId?: string;
    copied?: string[];
    apps?: WorkFoldRequestAction["apps"];
  },
): Promise<void> {
  if (!parentTaskId) return;
  await state.requests.recordAction(parentTaskId, {
    command: input.command,
    at: new Date().toISOString(),
    ...(input.workFolder ? { workFolderId: input.workFolder.id, workFolderName: input.workFolder.name } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.copied ? { copied: input.copied } : {}),
    ...(input.apps ? { apps: input.apps.slice(0, 64) } : {}),
  });
}

/**
 * "On now" and "Still needs you" for an act-lane install, the same two halves
 * the Chat path reports (`restrictedAppProposalResultText` in
 * src/local/agent/pi-client.ts). F21 puts the work-fold agent on the same footing as a
 * work-folder Chat, so an install that reports only "Installed" leaves the work-fold agent
 * unable to tell the person what is missing.
 */
function workFoldAgentInstallOutcome(
  app: RestrictedAppInstalled,
  needs: RestrictedAppInstallationNeeds | undefined,
): {
  granted: { destinations: number; wholeWorkFolderFolders: number; notifications: number; checks: number; automations: number };
  needs: RestrictedAppInstallationNeeds;
} {
  return {
    granted: {
      destinations: app.networkGrants.length,
      wholeWorkFolderFolders: app.fileGrants.filter((grant) => grant.root === ".").length,
      notifications: app.notificationGrants.length,
      checks: app.checkGrants?.length ?? 0,
      automations: app.automations.filter((automation) => automation.enabled).length,
    },
    needs: needs ?? { connections: [], files: [], checks: [] },
  };
}

function workFoldAgentAppResultRef(app: import("./agent/restricted-app-service.js").RestrictedAppInstalled): NonNullable<WorkFoldRequestAction["apps"]>[number] {
  return { workFolderId: app.workFolderId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, digest: app.digest, title: app.manifest.title, version: app.version };
}

async function cancelAcceptedTurn(
  state: LocalApiState,
  workFolderId: string,
  conversationId: string,
  taskId: string,
): Promise<boolean> {
  if (turnStatusFor(state, workFolderId, taskId).state !== "running") return false;
  state.cancelledTurnTasks.add(taskId);
  const client = state.clients.get(clientKey(workFolderId, conversationId));
  await client?.abort().catch(() => false);
  return true;
}

async function turnResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  taskId: string,
): ReturnType<WorkFoldActFacade["agentTurnResult"]> {
  const request = state.requests.byTaskId(taskId);
  if (request && (request.owner.workFolderId ?? workFoldAgentScopeId) === scopeId) {
    if (!isWorkFoldRequestTerminalState(request.state)) throw new WorkFoldCliError("conflict", "The request is still outstanding. Use chat wait or chat status --task.");
    taskId = request.turns.at(-1)!.taskId;
  }
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
    request: state.requests.byTaskId(taskId) ? toActRequestRefForWorkFolder(state, state.requests.byTaskId(taskId)!) : null,
    result: await completedRequestEnvelope(state, taskId),
  };
}

/** Only a request's selected report/final reply, never its transcript or graph. */
async function completedRequestEnvelope(state: LocalApiState, taskId: string): Promise<WorkFoldResultEnvelope | null> {
  const request = state.requests.byTaskId(taskId);
  if (!request || !isWorkFoldRequestTerminalState(request.state)) return null;
  const latest = request.turns.at(-1)!;
  const ref = [...request.results].reverse().find((item) => item.taskId === latest.taskId);
  if (ref) {
    const read = await state.requests.result(ref.resultId);
    if (read?.state !== "ok") throw new WorkFoldCliError("failure", "The selected result is unavailable; its receipt remains on record.");
    return { ...read.record.envelope,
      ...(request.state === "partial" && read.record.envelope.outcome === "succeeded" ? { outcome: "partial" as const } : {}) };
  }
  const turn = state.turnStore.get(latest.taskId);
  return {
    summary: clampUtf8(turn?.assistantText || latest.error || "The request ended without a reported result.", workFoldRequestLimits.maxResultSummaryBytes),
    outcome: request.state === "done" ? "succeeded" : request.state === "partial" ? "partial" : "failed",
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
  const limit = Math.max(Math.floor(messageLimit ?? 10), 1);
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
  workFolder: WorkFolderSummary,
  input: { fromPaths: string[]; toDir?: string; cwd: string },
): Promise<{ copied: string[]; checkpointId: string | null }> {
  if (!input.fromPaths.length) throw new WorkFoldCliError("usage", "Provide at least one --from <path> to add.");
  const toDir = normalizeWorkFolderRelativePath(input.toDir ?? "");
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
    if (pathContainsPath(workFolder.workFolderRoot, source)) {
      throw new WorkFoldCliError("usage", `Source is already inside this work-folder: ${trimmed}. Move it in Files instead.`);
    }
    if (pathContainsPath(source, workFolder.workFolderRoot)) {
      throw new WorkFoldCliError("usage", `Source contains this work-folder and cannot be copied into it: ${trimmed}.`);
    }
    sources.push(source);
  }
  const copied: string[] = [];
  try {
    for (const source of sources) copied.push(await copyPathIntoWorkFolder(source, workFolder.workFolderRoot, toDir));
  } catch (error) {
    // A mid-batch failure must not strand earlier copies without a restore
    // point: undo them best-effort, then surface the failure.
    await Promise.all(copied.map((path) =>
      rm(resolveWorkFolderPath(workFolder.workFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw error;
  }
  const safety = await checkpointAdditiveWritesOrUndo(workFolder.workFolderRoot, copied, {
    reason: "pre_add",
    label: `Before adding ${copied.length} item${copied.length === 1 ? "" : "s"}`,
  });
  return { copied, checkpointId: safety?.checkpointId ?? null };
}

export type WorkFoldDeleteRecovery =
  | { kind: "history" }
  | { kind: "recently-deleted"; entryId: string; restoreBy: string; uncovered: WorkFoldRecentlyDeletedUncoveredPath[] };

export interface WorkFoldDeleteResult {
  deleted: true;
  path: string;
  kind: "file" | "folder";
  safetyCheckpointId: string;
  recovery: WorkFoldDeleteRecovery;
}

/**
 * The one delete both the desktop route and `files delete` run
 * (docs/receipts-not-gates.md, F20). A delete never refuses for lack of
 * coverage: History keeps what it can, and when the restore point could not
 * cover every matched file the selected entry is *moved* into Recently
 * deleted instead of erased, so one delete keeps one undo reference.
 *
 * `.work-fold/`, `.pi/`, and `.workspace/` remain invalid endpoints, and the
 * work-folder root still cannot be deleted: the path policy runs first, unchanged.
 */
async function deleteWorkFolderEntryWithRecovery(
  state: LocalApiState,
  workFolder: WorkFolderSummary,
  target: string,
  context: { receiptId: string | null },
): Promise<WorkFoldDeleteResult> {
  reserveCapabilityMutation(state, workFolder.id, "project", workFolder.id);
  try {
    return await runSettledWorkFolderDeletion(state, workFolder.id, () => deleteSettledWorkFolderEntryWithRecovery(state, workFolder, target, context));
  } finally {
    state.capabilityMutations.delete(workFolder.id);
  }
}

async function deleteSettledWorkFolderEntryWithRecovery(
  state: LocalApiState,
  workFolder: WorkFolderSummary,
  target: string,
  context: { receiptId: string | null },
): Promise<WorkFoldDeleteResult> {
  const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, {
    paths: [target],
    reason: "pre_delete",
    label: `Before deleting ${target}`,
  });
  return runWithHistorySafety(workFolder.workFolderRoot, safety.checkpointId, async () => {
    if (!safety.skippedFiles.length) {
      const deleted = await deleteWorkFolderEntry(workFolder.workFolderRoot, target);
      return { ...deleted, safetyCheckpointId: safety.checkpointId, recovery: { kind: "history" as const } };
    }
    const entry = await resolveWorkFolderDeleteTarget(workFolder.workFolderRoot, target);
    const uncovered: WorkFoldRecentlyDeletedUncoveredPath[] = safety.skippedFiles.map((file) => ({
      path: file.path,
      reason: file.reason,
    }));
    let trashed: WorkFoldRecentlyDeletedEntry;
    try {
      trashed = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: entry.kind,
        reason: "files.delete",
        sourcePath: entry.absolutePath,
        workFolderId: workFolder.id,
        workFolderName: workFolder.name,
        originalPath: entry.path,
        receiptId: context.receiptId,
        uncovered,
      });
    } catch (error) {
      throw new WorkFoldCliError(
        "failure",
        `work-fold could not move ${entry.path} to Recently deleted: ${errorMessage(error)}. Nothing was deleted.`,
        { cause: error },
      );
    }
    await touchWorkFolderRoot(workFolder.workFolderRoot).catch(() => undefined);
    return {
      deleted: true as const,
      path: entry.path,
      kind: entry.kind,
      safetyCheckpointId: safety.checkpointId,
      recovery: { kind: "recently-deleted" as const, entryId: trashed.id, restoreBy: trashed.restoreBy, uncovered },
    };
  });
}

/**
 * App data is destroyed only after a complete, verified copy of it is in
 * Recently deleted (docs/receipts-not-gates.md, F20). The restricted-app
 * service is deliberately not given a Recently deleted dependency: the host composes
 * export → keep → destroy, so the export path stays the one Settings → Apps
 * already uses and the copy is a plain `work-fold.app-data` envelope.
 *
 * Clearing storage that holds nothing writes no entry: there is nothing to
 * bring back, and an empty shell in Recently deleted would only be noise.
 */
async function moveAppStorageExportToRecentlyDeleted(
  state: LocalApiState,
  app: RestrictedAppInstalled,
  reason: WorkFoldRecentlyDeletedReason,
  receiptId: string | null,
  options: { skipWhenStorageUnavailable?: boolean } = {},
): Promise<WorkFoldRecentlyDeletedEntry | null> {
  // Removal paths must never fail because this process has no storage host:
  // without one there is no live app data in it to lose, so there is nothing
  // to export and the removal proceeds. Every other failure still fails the
  // removal, so data is never destroyed without a recoverable copy.
  const usage = await state.restrictedApps
    .storageUsage(app.workFolderId, app.manifest.id, app.digest, app.featureInstallationId)
    .catch((error: unknown) => {
      if (options.skipWhenStorageUnavailable && error instanceof RestrictedAppError && error.code === "APP_UNAVAILABLE") return null;
      throw error;
    });
  if (!usage || usage.usageBytes === 0) return null;
  const backup = await state.restrictedApps.exportStorage(app.workFolderId, app.manifest.id, app.digest, app.featureInstallationId);
  return state.recentlyDeleted.moveAppDataToRecentlyDeleted({
    kind: "app-storage",
    reason,
    backup,
    workFolderId: app.workFolderId,
    ...(await workFolderDisplayName(app.workFolderId)),
    receiptId,
    identity: {
      kind: "app-data",
      appId: backup.appId,
      appDigest: backup.appDigest,
      featureInstallationId: app.featureInstallationId,
      runtimeInstanceId: app.runtimeInstanceId,
      dataNamespaceId: app.dataNamespaceId,
      sourceWorkFolderId: app.sourceWorkFolderId,
      projectId: app.projectId,
      releaseDigest: app.releaseDigest,
    },
  });
}

/**
 * The recovery export a removal owes its app's data before the namespace goes
 * (docs/receipts-not-gates.md, F20). Resolution is deliberately tolerant: the
 * removal itself stays the identity authority, so a missing or mismatched
 * installation returns null here and is refused by `remove` with its own
 * message rather than by a second, differently worded error.
 */
async function moveRemovedAppStorageToRecentlyDeleted(
  state: LocalApiState,
  workFolderId: string,
  appId: string,
  reason: WorkFoldRecentlyDeletedReason,
  receiptId: string | null,
  selector: { featureInstallationId?: string; expectedDigest?: string } = {},
): Promise<WorkFoldRecentlyDeletedEntry | null> {
  const app = (await state.restrictedApps.list(workFolderId)).find((item) => (
    item.manifest.id === appId
    && (selector.featureInstallationId === undefined || item.featureInstallationId === selector.featureInstallationId)
    && (selector.expectedDigest === undefined || item.digest === selector.expectedDigest)
  ));
  if (!app) return null;
  return await moveAppStorageExportToRecentlyDeleted(state, app, reason, receiptId, { skipWhenStorageUnavailable: true });
}

async function moveRetainedExportToRecentlyDeleted(
  state: LocalApiState,
  sourceWorkFolderId: string,
  retained: LocalAppRetainedData,
  reason: WorkFoldRecentlyDeletedReason,
  receiptId: string | null,
): Promise<WorkFoldRecentlyDeletedEntry> {
  const backup = await state.restrictedApps.exportRetainedStorage(sourceWorkFolderId, retained.retainedDataId);
  return state.recentlyDeleted.moveAppDataToRecentlyDeleted({
    kind: "app-retained",
    reason,
    backup,
    workFolderId: sourceWorkFolderId,
    ...(await workFolderDisplayName(sourceWorkFolderId)),
    receiptId,
    identity: {
      kind: "app-data",
      appId: backup.appId,
      appDigest: backup.appDigest,
      featureInstallationId: retained.featureInstallationId,
      runtimeInstanceId: retained.runtimeInstanceId,
      dataNamespaceId: retained.dataNamespaceId,
      sourceWorkFolderId,
      projectId: retained.projectId,
      releaseDigest: retained.releaseDigest,
      retainedDataId: retained.retainedDataId,
    },
  });
}

/**
 * Everything an uninstall-with-purge is about to destroy: the live storage of
 * every installation of that instance, and every record its Project already
 * retained for it. Each becomes its own entry, so a single record can come
 * back on its own.
 */
async function moveUninstallPurgeExportsToRecentlyDeleted(
  state: LocalApiState,
  runtimeInstanceId: string,
  workFolderIds: readonly string[],
  receiptId: string | null,
): Promise<WorkFoldRecentlyDeletedEntry[]> {
  const entries: WorkFoldRecentlyDeletedEntry[] = [];
  const sourceWorkFolderIds = new Set<string>();
  for (const workFolderId of new Set(workFolderIds)) {
    for (const app of await state.restrictedApps.list(workFolderId)) {
      if (app.runtimeInstanceId !== runtimeInstanceId) continue;
      sourceWorkFolderIds.add(app.sourceWorkFolderId);
      const entry = await moveAppStorageExportToRecentlyDeleted(state, app, "apps.uninstall.purge", receiptId);
      if (entry) entries.push(entry);
    }
  }
  for (const sourceWorkFolderId of sourceWorkFolderIds) {
    const studio = await state.restrictedApps.localAppStudio(sourceWorkFolderId).catch(() => null);
    for (const retained of studio?.retainedData ?? []) {
      if (retained.runtimeInstanceId !== runtimeInstanceId) continue;
      entries.push(await moveRetainedExportToRecentlyDeleted(state, sourceWorkFolderId, retained, "apps.uninstall.purge", receiptId));
    }
  }
  return entries;
}

/**
 * The installation a storage act names, resolved through the service's own
 * identity read first, so a stale installation id or a changed revision is
 * refused exactly as it was before anything is exported or cleared.
 */
async function requireInstalledAppForStorage(
  state: LocalApiState,
  workFolderId: string,
  appId: string,
  expectedDigest: string,
  featureInstallationId?: string,
): Promise<RestrictedAppInstalled> {
  await state.restrictedApps.storageUsage(workFolderId, appId, expectedDigest, featureInstallationId);
  const app = (await state.restrictedApps.list(workFolderId)).find((item) => (
    item.manifest.id === appId
    && item.digest === expectedDigest
    && (featureInstallationId === undefined || item.featureInstallationId === featureInstallationId)
  ));
  if (!app) throw notFound("This app is not installed in this work-folder at that revision.");
  return app;
}

/** The work-folder's display name for a trash entry, when it is still registered. */
async function workFolderDisplayName(workFolderId: string): Promise<{ workFolderName?: string }> {
  const workFolder = await getWorkFolder(workFolderId).catch(() => null);
  return workFolder ? { workFolderName: workFolder.name } : {};
}

/**
 * Splits one work-folder-relative act path into the desktop create routes' parent
 * and name inputs, so `files mkdir`/`files create` run the exact same
 * `createWorkFolderFolder`/`createWorkFolderTextFile` internals as the renderer.
 */
function splitActEntryPath(rawPath: string, missingMessage: string): { target: string; parentPath: string; name: string } {
  const target = normalizeWorkFolderRelativePath(rawPath);
  if (!target) throw new WorkFoldCliError("usage", missingMessage);
  const lastSlash = target.lastIndexOf("/");
  return {
    target,
    parentPath: lastSlash === -1 ? "" : target.slice(0, lastSlash),
    name: lastSlash === -1 ? target : target.slice(lastSlash + 1),
  };
}

/** Banner-image data URLs dominate a proposal's size; anything past this bound is not a typed proposal. */
const maxActAppearanceProposalBytes = 1_048_576;
/** A typed presentation file is a small JSON object; larger inputs are refused unread. */
const maxActPresentationFileBytes = 65_536;

/**
 * Reads and validates one typed `work-folder-appearance` proposal file, resolved
 * host-side against the caller's working directory — the same file-borne
 * input pattern as `checks enable --proposal`. Nothing but the typed proposal
 * is accepted: no free-form argv colors, no other JSON shapes.
 */
async function readWorkFolderAppearanceProposalFile(rawPath: string, cwd: string): Promise<WorkFolderAppearanceProposal> {
  const parsed = await readBoundedActJsonFile(rawPath, cwd, maxActAppearanceProposalBytes, "appearance proposal");
  try {
    return parseWorkFolderAppearanceProposal(parsed);
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

function appearanceCustomizationRef(customization: WorkFolderAppearanceCustomization | null): string | null {
  return customization === null ? null : shortContentRef(customization);
}

function appearanceCustomizationsEqual(
  left: WorkFolderAppearanceCustomization | null,
  right: WorkFolderAppearanceCustomization | null,
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
    targetWorkFolderId: operation.targetWorkFolderId,
    preparedAt: operation.preparedAt,
    ...(operation.kind === "update"
      ? { fromReleaseDigest: operation.plan.fromReleaseDigest, continuityPolicy: operation.continuityPolicy }
      : {}),
  };
}

function toActAppInstanceRef(instance: LocalAppInstance): WorkFoldActAppInstanceRef {
  return {
    runtimeInstanceId: instance.runtimeInstanceId,
    workFolderId: instance.workFolderId,
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

function toActAutomationTriggerRef(trigger: WorkFoldAutomationDeclaration["trigger"]): WorkFoldActAutomationTriggerRef {
  if (trigger.kind === "files-changed") return { kind: trigger.kind, workFolderId: trigger.workFolder, watch: structuredClone(trigger.watch), debounceSeconds: trigger.debounceSeconds, cooldownMinutes: trigger.cooldownMinutes };
  if (trigger.kind === "interval") return { kind: "interval", intervalMinutes: trigger.intervalMinutes };
  if (trigger.kind === "at") return { kind: "at", at: trigger.at, ifMissed: trigger.ifMissed };
  if (trigger.kind === "on-settled") {
    const source = trigger.source;
    if (source.kind === "check-run") {
      return {
        kind: "on-settled",
        source: {
          kind: "check-run",
          workFolderId: source.workFolder,
          ...(source.check ? { checkId: source.check } : {}),
          outcomes: [...source.outcomes],
        },
      };
    }
    return {
      kind: "on-settled",
      source: {
        kind: "app-automation-run",
        workFolderId: source.workFolder,
        appId: source.appId,
        appAutomationId: source.appAutomationId,
        outcomes: [...source.outcomes],
      },
    };
  }
  return { kind: "manual" };
}

function toActAutomationSummary(projection: WorkFoldAutomationProjection): WorkFoldActAutomationSummary {
  return {
    automationId: projection.declaration.id,
    title: projection.declaration.title,
    health: projection.health,
    digest: projection.digest,
    trigger: toActAutomationTriggerRef(projection.declaration.trigger),
    ...(projection.fileWatch ? { fileWatch: projection.fileWatch } : {}),
    stepCount: projection.declaration.steps.length,
    referencedWorkFolderIds: workFoldAutomationReferencedWorkFolderIds(projection.declaration),
    ...(projection.health === "enabled" && projection.grants.length > 0
      ? { enabledAt: projection.grants[projection.grants.length - 1]!.enabledAt }
      : {}),
    ...(projection.disabledAt ? { disabledAt: projection.disabledAt } : {}),
    ...(projection.suspension
      ? {
        suspension: {
          at: projection.suspension.at,
          missingWorkFolderIds: [...projection.suspension.missingWorkFolderIds],
          reRegisteredWorkFolderIds: [...projection.suspension.reRegisteredWorkFolderIds],
        },
      }
      : {}),
    ...(projection.lastScheduledAt ? { lastScheduledAt: projection.lastScheduledAt } : {}),
    ...(projection.nextScheduledAt ? { nextScheduledAt: projection.nextScheduledAt } : {}),
    ...(projection.atOccurrence?.finishedAt
      ? { completedAt: projection.atOccurrence.finishedAt }
      : projection.atOccurrence?.consumedAt
        ? { completedAt: projection.atOccurrence.consumedAt }
        : {}),
  };
}

function toActAutomationFilesSource(
  source: Extract<WorkFoldAutomationDeclaration["steps"][number], { kind: "files" }>["from"],
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

const automationReceiptProjectionLimit = 500;
const automationReceiptTextLimit = 4_096;
const automationReceiptListLimit = 128;

async function readAutomationReceiptProjection(automationId?: string): Promise<{
  receipts: WorkFoldActAutomationReceipt[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const matching: WorkFoldActAutomationReceipt[] = [];
  const damagedLineCount = await visitAutomationReceipts((projected) => {
    if (automationId === undefined || projected.automationId === automationId) matching.push(projected);
  });
  return {
    receipts: matching.slice(-automationReceiptProjectionLimit).reverse(),
    truncated: matching.length > automationReceiptProjectionLimit,
    damagedLineCount,
  };
}

async function readAutomationReceiptProjectionsByAutomation(): Promise<{
  receipts: WorkFoldActAutomationReceipt[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const matchingByAutomation = new Map<string, WorkFoldActAutomationReceipt[]>();
  let truncated = false;
  const damagedLineCount = await visitAutomationReceipts((projected) => {
    const bucket = matchingByAutomation.get(projected.automationId) ?? [];
    bucket.push(projected);
    if (bucket.length > automationReceiptProjectionLimit) {
      bucket.shift();
      truncated = true;
    }
    matchingByAutomation.set(projected.automationId, bucket);
  });
  return {
    receipts: [...matchingByAutomation.values()].flat().sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
    truncated,
    damagedLineCount,
  };
}

async function visitAutomationReceipts(visitor: (receipt: WorkFoldActAutomationReceipt) => void): Promise<number> {
  let damagedLineCount = 0;
  for (const path of [workFoldAutomationReceiptsRotatedFile(), workFoldAutomationReceiptsFile()]) {
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WorkFoldCliError("failure", "work-fold could not read the automation run history.", { cause: error });
    });
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        damagedLineCount += 1;
        continue;
      }
      const projected = projectAutomationReceipt(parsed);
      if (!projected) {
        damagedLineCount += 1;
        continue;
      }
      visitor(projected);
    }
  }
  return damagedLineCount;
}

function projectAutomationReceipt(value: unknown): WorkFoldActAutomationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Partial<WorkFoldAutomationReceiptV1>;
  const at = automationReceiptTimestamp(receipt.at);
  const automationId = automationReceiptText(receipt.automationId);
  const outcome = automationReceiptText(receipt.outcome);
  if (!at || !automationId || !outcome || (receipt.scope !== "automation" && receipt.scope !== "run" && receipt.scope !== "hop")) {
    return null;
  }
  const projected: WorkFoldActAutomationReceipt = { at, scope: receipt.scope, outcome, automationId };
  const addText = (key: keyof WorkFoldActAutomationReceipt, candidate: unknown) => {
    const text = automationReceiptText(candidate);
    if (text !== undefined) (projected as unknown as Record<string, unknown>)[key] = text;
  };
  addText("runId", receipt.runId);
  addText("hopId", receipt.hopId);
  if (receipt.hopKind === "chat" || receipt.hopKind === "files" || receipt.hopKind === "check" || receipt.hopKind === "agent") {
    projected.hopKind = receipt.hopKind;
  }
  addText("title", receipt.title);
  addText("digest", receipt.digest);
  addText("detail", receipt.detail);
  const cause = projectAutomationReceiptCause(receipt.cause);
  if (cause !== undefined) projected.cause = cause;
  addText("workFolderId", receipt.workFolderId);
  addText("fromWorkFolderId", receipt.fromWorkFolderId);
  addText("toWorkFolderId", receipt.toWorkFolderId);
  addText("conversationId", receipt.conversationId);
  addText("taskId", receipt.taskId);
  addText("restorePointId", receipt.restorePointId);
  addText("checkRunId", receipt.checkRunId);
  addText("failedHopId", receipt.failedHopId);
  addText("surface", receipt.surface);
  addText("decisionId", receipt.decisionId);
  addText("requestId", receipt.requestId);
  addText("occurrenceId", receipt.occurrenceId);
  addText("scheduledRunId", receipt.scheduledRunId);
  const addList = (key: keyof WorkFoldActAutomationReceipt, candidate: unknown) => {
    const list = automationReceiptTextList(candidate);
    if (list !== undefined) (projected as unknown as Record<string, unknown>)[key] = list;
  };
  addList("checkpointIds", receipt.checkpointIds);
  addList("sourcePaths", receipt.sourcePaths);
  addList("copiedPaths", receipt.copiedPaths);
  addList("checkIds", receipt.checkIds);
  addList("stoppedHopTaskIds", receipt.stoppedHopTaskIds);
  addList("missingWorkFolderIds", receipt.missingWorkFolderIds);
  const addCount = (key: keyof WorkFoldActAutomationReceipt, candidate: unknown) => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      (projected as unknown as Record<string, unknown>)[key] = Math.floor(candidate);
    }
  };
  addCount("fileCount", receipt.fileCount);
  addCount("totalBytes", receipt.totalBytes);
  addCount("findingCount", receipt.findingCount);
  addCount("admittedCount", receipt.admittedCount);
  addCount("messageBytes", receipt.messageBytes);
  const placeholders = projectAutomationReceiptPlaceholders(receipt.placeholders);
  if (placeholders) projected.placeholders = placeholders;
  return projected;
}

/**
 * What work-fold filled into a hop's message, bounded exactly as the executor
 * bounded it. Text keeps its newlines — it is a list — so it is length-bounded
 * rather than run through the single-line text projector.
 */
function projectAutomationReceiptPlaceholders(
  value: unknown,
): Array<{ name: string; text: string; bytes: number; truncated: boolean }> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const projected: Array<{ name: string; text: string; bytes: number; truncated: boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const placeholder = entry as Record<string, unknown>;
    const name = automationReceiptText(placeholder.name);
    if (!name || name.length > 128) return undefined;
    if (typeof placeholder.text !== "string" || placeholder.text.length > workFoldAutomationBounds.maxPlaceholderTextBytes) {
      return undefined;
    }
    if (!Number.isSafeInteger(placeholder.bytes) || (placeholder.bytes as number) < 0) return undefined;
    if (typeof placeholder.truncated !== "boolean") return undefined;
    projected.push({
      name,
      text: placeholder.text,
      bytes: placeholder.bytes as number,
      truncated: placeholder.truncated,
    });
  }
  return projected;
}

function projectAutomationReceiptCause(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if ((cause.kind === "scheduled" || cause.kind === "resume") && automationReceiptTimestamp(cause.slotAt)) {
    return { kind: cause.kind, slotAt: automationReceiptTimestamp(cause.slotAt)! };
  }
  if (cause.kind === "files-changed" && typeof cause.snapshotDigest === "string" && /^[a-f0-9]{64}$/.test(cause.snapshotDigest) && Number.isSafeInteger(cause.changedCount) && (cause.changedCount as number) > 0 && (cause.changedCount as number) <= 1024 && automationReceiptText(cause.workFolderId)) {
    const changedPaths = automationReceiptTextList(cause.changedPaths);
    return {
      kind: cause.kind,
      workFolderId: automationReceiptText(cause.workFolderId),
      snapshotDigest: cause.snapshotDigest,
      changedCount: cause.changedCount,
      ...(changedPaths?.length ? { changedPaths } : {}),
    };
  }
  if (cause.kind === "run-now") {
    const surface = typeof cause.surface === "string" && WORKFOLD_CLI_ACT_SURFACES.includes(cause.surface as never)
      ? cause.surface
      : undefined;
    return {
      kind: "run-now",
      ...(automationReceiptText(cause.requestId) ? { requestId: automationReceiptText(cause.requestId) } : {}),
      ...(surface ? { surface } : {}),
    };
  }
  if (cause.kind !== "on-settled" || !cause.source || typeof cause.source !== "object" || Array.isArray(cause.source)) {
    return undefined;
  }
  const source = cause.source as Record<string, unknown>;
  const workFolderId = automationReceiptText(source.workFolderId);
  const runId = automationReceiptText(source.runId);
  // A Check-run settle records `state`; an app-automation settle records
  // `outcome`. Both read as the settled result here.
  const outcome = automationReceiptText(source.outcome) ?? automationReceiptText(source.state);
  if (!workFolderId || !runId || !outcome) return undefined;
  if (source.kind === "check-run") {
    const checkIds = automationReceiptTextList(source.checkIds);
    return {
      kind: "on-settled",
      source: {
        kind: "check-run",
        workFolderId,
        runId,
        outcome,
        ...(automationReceiptText(source.taskId) ? { taskId: automationReceiptText(source.taskId) } : {}),
        ...(checkIds?.length ? { checkIds } : {}),
        ...(automationReceiptText(source.checkId) ? { checkId: automationReceiptText(source.checkId) } : {}),
      },
    };
  }
  if (source.kind === "app-automation-run") {
    const appId = automationReceiptText(source.appId);
    const appAutomationId = automationReceiptText(source.appAutomationId);
    if (!appId || !appAutomationId) return undefined;
    return { kind: "on-settled", source: { kind: "app-automation-run", workFolderId, appId, appAutomationId, runId, outcome } };
  }
  return undefined;
}

function automationReceiptText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > automationReceiptTextLimit) return undefined;
  if (/\p{Cc}|\p{Cf}/u.test(value)) return undefined;
  return value;
}

function automationReceiptTimestamp(value: unknown): string | undefined {
  const text = automationReceiptText(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}

function automationReceiptTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > automationReceiptListLimit) return undefined;
  const values = value.map(automationReceiptText);
  return values.every((item): item is string => item !== undefined) ? values : undefined;
}

function createWorkFoldAutomationSettingsFacade(state: LocalApiState): WorkFoldAutomationSettingsFacade {
  return {
    async list() {
      const projections = await runActOperation(() => state.automations.listAutomations());
      const receiptProjection = await readAutomationReceiptProjectionsByAutomation();
      const historyByAutomation = new Map<string, WorkFoldAutomationSettingsRunView[]>();
      for (const projection of projections) {
        const history = await automationSettingsHistoryFromProjection(
          projection.declaration.id,
          receiptProjection,
        );
        historyByAutomation.set(projection.declaration.id, history.runs);
      }
      return {
        automations: await Promise.all(projections.map(async (projection) =>
          await automationSettingsSummary(projection, historyByAutomation.get(projection.declaration.id) ?? []))),
        status: state.automations.status(),
      };
    },
    async proposals() {
      const scan = await scanWorkFoldAutomationProposals(workFoldAgentRoot());
      // A proposal already stored at the same digest shows once, in the main
      // list, whatever its health.
      const stored = new Set((await runActOperation(() => state.automations.listAutomations()))
        .map((projection) => `${projection.declaration.id}\n${projection.digest}`));
      const proposals: WorkFoldAutomationSettingsProposalView[] = [];
      for (const entry of scan.entries) {
        const normalized = entry.valid ? entry : entry.normalized;
        if (normalized && stored.has(`${normalized.declaration.id}\n${normalized.digest}`)) continue;
        if (!entry.valid) {
          proposals.push({ valid: false, path: entry.path, fileName: entry.fileName, problem: entry.problem });
          continue;
        }
        const missing: string[] = [];
        for (const workFolderId of workFoldAutomationReferencedWorkFolderIds(entry.declaration)) {
          if (!await getWorkFolder(workFolderId).catch(() => null)) missing.push(workFolderId);
        }
        if (missing.length) {
          proposals.push({
            valid: false,
            path: entry.path,
            fileName: entry.fileName,
            problem: `Names a work-folder that is not on this computer (${missing.join(", ")}).`,
          });
          continue;
        }
        proposals.push({
          valid: true,
          path: entry.path,
          fileName: entry.fileName,
          automationId: entry.declaration.id,
          digest: entry.digest,
          title: entry.declaration.title,
          trigger: toActAutomationTriggerRef(entry.declaration.trigger),
        });
      }
      return { proposals, truncated: scan.truncated };
    },
    async enableProposal(path) {
      let proposalPath: string;
      try {
        proposalPath = resolveWorkFoldAutomationProposalPath(workFoldAgentRoot(), path);
      } catch (error) {
        throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
      }
      // The exact CLI enable path: read and digest the file now, then the
      // journaled prepared-act enablement pinned to that digest.
      const result = await runDesktopSettingsAct(state, "automations.enable", async (requestId) => {
        const { declaration, digest } = await readAutomationStagingFile(proposalPath, workFoldAgentRoot());
        const enabled = await enableStoredAutomationDeclaration(state, declaration, digest, {
          requestId,
          surface: "main-window",
        });
        return { value: enabled, detail: `Enabled automation ${enabled.automationId} from ${basename(proposalPath)}.` };
      });
      const projection = await requireSettingsAutomation(state, result.value.automationId);
      const history = await automationSettingsHistory(projection.declaration.id);
      return {
        automationId: result.value.automationId,
        requestId: result.requestId,
        enabled: true as const,
        alreadyEnabled: result.value.alreadyEnabled,
        automation: await automationSettingsSummary(projection, history.runs),
      };
    },
    async show(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      const history = await automationSettingsHistory(projection.declaration.id);
      const summary = await automationSettingsSummary(projection, history.runs);
      const workFolders = summary.workFolders;
      const byId = new Map(workFolders.map((workFolder) => [workFolder.workFolderId, workFolder]));
      const named = (workFolderId: string): WorkFoldAutomationSettingsWorkFolderRef => byId.get(workFolderId) ?? { workFolderId };
      return {
        automation: {
          ...summary,
          createdAt: projection.declaration.createdAt,
          workFolders,
          steps: projection.declaration.steps.map((step) => step.kind === "chat"
            ? { id: step.id, kind: "chat" as const, workFolder: named(step.workFolder), message: step.message }
            : step.kind === "files"
              ? {
                id: step.id,
                kind: "files" as const,
                fromWorkFolder: named(step.fromWorkFolder),
                toWorkFolder: named(step.toWorkFolder),
                to: step.to,
                source: toActAutomationFilesSource(step.from),
              }
              : step.kind === "check"
                ? {
                  id: step.id,
                  kind: "check" as const,
                  workFolder: named(step.workFolder),
                  ...(step.check ? { checkId: step.check } : {}),
                }
                : { id: step.id, kind: "agent" as const, message: step.message }),
          ...(projection.atOccurrence?.finishedAt
            ? { completedAt: projection.atOccurrence.finishedAt }
            : projection.atOccurrence?.consumedAt
              ? { completedAt: projection.atOccurrence.consumedAt }
              : {}),
        },
      };
    },
    async history(automationId) {
      await requireSettingsAutomation(state, automationId);
      return await automationSettingsHistory(automationId);
    },
    async enable(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (projection.health === "enabled") {
        throw new WorkFoldCliError("conflict", "This automation is already on.");
      }
      if (projection.health === "completed") {
        throw new WorkFoldCliError(
          "conflict",
          "This one-time automation is complete. Ask the work-fold agent to set up a new automation for another time.",
        );
      }
      const result = await runDesktopSettingsAct(state, "automations.enable", async (requestId) => {
        const enabled = await enableStoredAutomationDeclaration(state, projection.declaration, projection.digest, {
          requestId,
          surface: "main-window",
        });
        return {
          value: {
            automationId: enabled.automationId,
            requestId,
            enabled: true as const,
            alreadyEnabled: enabled.alreadyEnabled,
          },
          detail: `Enabled automation ${enabled.automationId}.`,
        };
      });
      return result.value;
    },
    async run(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (projection.health !== "enabled") throw automationHealthConflict(projection.health);
      const requestId = `settings:${randomUUID()}`;
      const receipt = { requestId, command: "automations.run", surface: "main-window" as const };
      if (!await state.actReceipts.append({ ...receipt, outcome: "accepted" })) {
        throw new WorkFoldCliError(
          "failure",
          "work-fold could not journal this Settings action, so nothing was changed.",
        );
      }
      let admission;
      try {
        admission = await runActOperation(() => state.automations.runNowAdmission(projection.declaration.id, {
          requestId,
          surface: "main-window",
        }));
      } catch (error) {
        await state.actReceipts.append({
          ...receipt,
          outcome: "error",
          ...(error instanceof WorkFoldCliError ? { errorCode: error.code } : {}),
          detail: errorMessage(error),
        }).catch(() => false);
        throw error;
      }
      void admission.result.then(async (result) => {
        await state.actReceipts.append({
          ...receipt,
          outcome: "ok",
          detail: `Automation ${projection.declaration.id} settled ${result.outcome} as run ${result.runId}.`,
        }).catch(() => false);
      });
      return {
        automationId: projection.declaration.id,
        requestId,
        runId: admission.runId,
        accepted: true,
      };
    },
    async stop(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      const result = await runDesktopSettingsAct(state, "automations.stop", async (requestId) => {
        const stopped = state.automations.stopRun(projection.declaration.id, { requestId, surface: "main-window" });
        if (!stopped) throw new WorkFoldCliError("conflict", "This automation has no active run.");
        return {
          value: stopped,
          detail: `Stopped automation ${projection.declaration.id} run ${stopped.runId}.`,
        };
      });
      return {
        automationId: projection.declaration.id,
        requestId: result.requestId,
        runId: result.value.runId,
        stopped: true,
      };
    },
    async disable(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      const result = await runDesktopSettingsAct(state, "automations.disable", async (requestId) => {
        const disabled = await runActOperation(() => state.automations.disable(projection.declaration.id, {
          requestId,
          surface: "main-window",
        }));
        return {
          value: disabled,
          detail: `Disabled automation ${projection.declaration.id}.`,
        };
      });
      return {
        automationId: projection.declaration.id,
        requestId: result.requestId,
        disabled: true,
        stoppedRunId: result.value.stoppedRunId,
      };
    },
    async delete(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (projection.health === "enabled") {
        throw new WorkFoldCliError("conflict", "Turn this automation off before deleting it.");
      }
      if (projection.activeRunId) {
        throw new WorkFoldCliError("conflict", "Stop this automation's active run before deleting it.");
      }
      const result = await runDesktopSettingsAct(state, "automations.delete", async (requestId) => {
        await runActOperation(() => state.automations.deleteAutomation(projection.declaration.id, {
          requestId,
          surface: "main-window",
        }));
        return { value: true, detail: `Deleted automation ${projection.declaration.id}; its run history was retained.` };
      });
      return { automationId: projection.declaration.id, requestId: result.requestId, deleted: true };
    },
    async forWorkFolder(workFolderId) {
      const projections = (await runActOperation(() => state.automations.listAutomations()))
        .filter((projection) => workFoldAutomationReferencedWorkFolderIds(projection.declaration).includes(workFolderId));
      if (!projections.length) return { automations: [] };
      const receiptProjection = await readAutomationReceiptProjectionsByAutomation();
      const automations: FolderAutomationView[] = [];
      for (const projection of projections) {
        const history = await automationSettingsHistoryFromProjection(projection.declaration.id, receiptProjection);
        const summary = await automationSettingsSummary(projection, history.runs);
        automations.push(folderAutomationView(projection, summary, workFolderId));
      }
      return { automations };
    },
    async requireWorkFolderAutomation(workFolderId, automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (!workFoldAutomationReferencedWorkFolderIds(projection.declaration).includes(workFolderId)) {
        throw new WorkFoldCliError("notFound", "This automation does not touch this folder.");
      }
    },
  };
}

function folderAutomationView(
  projection: WorkFoldAutomationProjection,
  summary: WorkFoldAutomationSettingsSummary,
  workFolderId: string,
): FolderAutomationView {
  // The act-lane trigger ref is the loose superset of the discriminated view
  // Settings already renders over IPC; the settled source gains its name.
  const view = summary.trigger as AutomationTriggerView;
  const sourceName = view.kind === "on-settled"
    ? summary.workFolders.find((workFolder) => workFolder.workFolderId === view.source.workFolderId)?.workFolderName
    : undefined;
  const trigger: AutomationTriggerView = view.kind === "on-settled" && sourceName
    ? { ...view, source: { ...view.source, workFolderName: sourceName } }
    : view;
  const state: FolderAutomationState = summary.activeRun
    ? "running"
    : ({ enabled: "on", disabled: "off", suspended: "suspended", completed: "completed" } as const)[summary.health];
  return {
    automationId: summary.automationId,
    title: summary.title,
    state,
    triggerSummary: automationTriggerSummary(trigger),
    nextRunAt: summary.nextScheduledAt ?? null,
    lastRun: summary.lastRun ? { at: summary.lastRun.startedAt, outcome: summary.lastRun.outcome } : null,
    roles: workFoldAutomationWorkFolderRoles(projection.declaration, workFolderId),
  };
}

async function requireSettingsAutomation(state: LocalApiState, automationId: string): Promise<WorkFoldAutomationProjection> {
  const id = automationId.trim();
  if (!id) throw new WorkFoldCliError("usage", "An automation id is required.");
  const projection = await runActOperation(() => state.automations.getAutomation(id));
  if (!projection) throw new WorkFoldCliError("notFound", "No automation has this id on this machine.");
  return projection;
}

function automationHealthConflict(health: WorkFoldAutomationProjection["health"]): WorkFoldCliError {
  return new WorkFoldCliError(
    "conflict",
    health === "completed"
      ? "This one-time automation is complete."
      : health === "suspended"
        ? "This automation is suspended because a referenced work-folder was removed."
        : "This automation is off.",
  );
}

async function automationSettingsWorkFolderRefs(workFolderIds: string[]): Promise<WorkFoldAutomationSettingsWorkFolderRef[]> {
  return await Promise.all(workFolderIds.map(async (workFolderId) => {
    const workFolder = await getWorkFolder(workFolderId).catch(() => null);
    return { workFolderId, ...(workFolder ? { workFolderName: workFolder.name } : {}) };
  }));
}

async function automationSettingsSummary(
  projection: WorkFoldAutomationProjection,
  runs: WorkFoldAutomationSettingsRunView[],
): Promise<WorkFoldAutomationSettingsSummary> {
  const lastRun = runs[0];
  const active = projection.activeRunId ? runs.find((run) => run.runId === projection.activeRunId) : undefined;
  const missingWorkFolders = projection.suspension
    ? await automationSettingsWorkFolderRefs(projection.suspension.missingWorkFolderIds)
    : undefined;
  return {
    automationId: projection.declaration.id,
    title: projection.declaration.title,
    health: projection.health,
    trigger: toActAutomationTriggerRef(projection.declaration.trigger),
    ...(projection.fileWatch ? { fileWatch: projection.fileWatch } : {}),
    stepCount: projection.declaration.steps.length,
    workFolders: await automationSettingsWorkFolderRefs(workFoldAutomationReferencedWorkFolderIds(projection.declaration)),
    ...(projection.nextScheduledAt ? { nextScheduledAt: projection.nextScheduledAt } : {}),
    ...(projection.lastScheduledAt ? { lastScheduledAt: projection.lastScheduledAt } : {}),
    ...(projection.activeRunId && active ? { activeRun: { runId: projection.activeRunId, startedAt: active.startedAt } } : {}),
    ...(lastRun
      ? {
        lastRun: {
          runId: lastRun.runId,
          outcome: lastRun.outcome,
          startedAt: lastRun.startedAt,
          ...(lastRun.finishedAt ? { finishedAt: lastRun.finishedAt } : {}),
        },
      }
      : {}),
    ...(projection.suspension
      ? {
        suspension: {
          at: projection.suspension.at,
          reason: "A referenced work-folder was removed. Review the automation before turning it on again.",
          ...(missingWorkFolders?.length ? { missingWorkFolders } : {}),
        },
      }
      : {}),
  };
}

async function automationSettingsHistory(automationId: string): Promise<{
  runs: WorkFoldAutomationSettingsRunView[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const projected = await readAutomationReceiptProjection(automationId);
  return await automationSettingsHistoryFromProjection(automationId, projected);
}

async function automationSettingsHistoryFromProjection(
  automationId: string,
  projection: Awaited<ReturnType<typeof readAutomationReceiptProjection>>,
): Promise<{
  runs: WorkFoldAutomationSettingsRunView[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const projected = {
    ...projection,
    receipts: projection.receipts.filter((receipt) => receipt.automationId === automationId),
  };
  const workFolderIds = new Set<string>();
  for (const receipt of projected.receipts) {
    if (receipt.workFolderId) workFolderIds.add(receipt.workFolderId);
    if (receipt.fromWorkFolderId) workFolderIds.add(receipt.fromWorkFolderId);
    if (receipt.toWorkFolderId) workFolderIds.add(receipt.toWorkFolderId);
  }
  const workFolders = await automationSettingsWorkFolderRefs([...workFolderIds]);
  const workFolderNames = new Map(workFolders.filter((workFolder) => workFolder.workFolderName).map((workFolder) => [workFolder.workFolderId, workFolder.workFolderName!]));
  const runs = new Map<string, WorkFoldAutomationSettingsRunView & { hopsById: Map<string, WorkFoldAutomationSettingsRunView["hops"][number]> }>();
  for (const receipt of [...projected.receipts].reverse()) {
    if (!receipt.runId || (receipt.scope !== "run" && receipt.scope !== "hop")) continue;
    let run = runs.get(receipt.runId);
    if (!run) {
      run = {
        runId: receipt.runId,
        outcome: "accepted",
        startedAt: receipt.at,
        hops: [],
        hopsById: new Map(),
      };
      runs.set(receipt.runId, run);
    }
    if (receipt.scope === "run") {
      if (receipt.outcome === "accepted") {
        run.startedAt = receipt.at;
        const cause = automationSettingsCause(receipt.cause);
        if (cause) run.cause = cause;
      } else if (isAutomationSettingsOutcome(receipt.outcome)) {
        run.outcome = receipt.outcome;
        run.finishedAt = receipt.at;
        if (receipt.detail) run.detail = receipt.detail;
      }
      continue;
    }
    if (!receipt.hopId || !receipt.hopKind) continue;
    let hop = run.hopsById.get(receipt.hopId);
    if (!hop) {
      hop = { hopId: receipt.hopId, kind: receipt.hopKind, outcome: "accepted" };
      run.hopsById.set(receipt.hopId, hop);
      run.hops.push(hop);
    }
    if (isAutomationSettingsOutcome(receipt.outcome)) hop.outcome = receipt.outcome;
    const workFolderId = receipt.workFolderId ?? receipt.toWorkFolderId ?? receipt.fromWorkFolderId;
    if (workFolderId && workFolderNames.has(workFolderId)) hop.workFolderName = workFolderNames.get(workFolderId);
    if (receipt.detail) hop.detail = receipt.detail;
    const evidence = automationSettingsEvidence(receipt);
    if (evidence.length) hop.evidence = evidence;
  }
  return {
    runs: [...runs.values()]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, 50)
      .map(({ hopsById: _hopsById, ...run }) => run),
    truncated: projected.truncated || runs.size > 50,
    damagedLineCount: projected.damagedLineCount,
  };
}

function isAutomationSettingsOutcome(value: string): value is WorkFoldAutomationSettingsOutcome {
  return value === "accepted"
    || value === "succeeded"
    || value === "failed"
    || value === "stopped"
    || value === "interrupted"
    || value === "skipped"
    || value === "lapsed";
}

function automationSettingsCause(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if (cause.kind === "files-changed") return `Folder changed · ${cause.changedCount} file(s)`;
  if (cause.kind === "run-now") return "Run Now";
  if ((cause.kind === "scheduled" || cause.kind === "resume") && typeof cause.slotAt === "string") {
    return cause.kind === "resume" ? `Caught up from ${cause.slotAt}` : `Scheduled for ${cause.slotAt}`;
  }
  if (cause.kind === "on-settled" && cause.source && typeof cause.source === "object" && !Array.isArray(cause.source)) {
    const source = cause.source as Record<string, unknown>;
    return source.kind === "check-run" ? "After a Check run" : "After an app automation run";
  }
  return undefined;
}

function automationSettingsEvidence(receipt: WorkFoldActAutomationReceipt): Array<{ label: string; value: string }> {
  const evidence: Array<{ label: string; value: string }> = [];
  if (receipt.conversationId) evidence.push({ label: "Chat", value: receipt.conversationId });
  if (receipt.taskId) evidence.push({ label: "Task", value: receipt.taskId });
  if (receipt.checkpointIds?.length) evidence.push({ label: "History", value: receipt.checkpointIds.join(", ") });
  if (receipt.restorePointId) evidence.push({ label: "Restore point", value: receipt.restorePointId });
  if (receipt.fileCount !== undefined) evidence.push({ label: "Files", value: String(receipt.fileCount) });
  if (receipt.totalBytes !== undefined) evidence.push({ label: "Bytes", value: String(receipt.totalBytes) });
  if (receipt.checkRunId) evidence.push({ label: "Check run", value: receipt.checkRunId });
  if (receipt.checkIds?.length) evidence.push({ label: "Checks", value: receipt.checkIds.join(", ") });
  if (receipt.findingCount !== undefined) evidence.push({ label: "Findings", value: String(receipt.findingCount) });
  if (receipt.admittedCount !== undefined) evidence.push({ label: "Admitted", value: String(receipt.admittedCount) });
  if (receipt.placeholders?.length) {
    evidence.push({ label: "Filled in", value: receipt.placeholders.map((placeholder) => placeholder.name).join(", ") });
  }
  return evidence;
}

function toActPublicationRef(view: WorkFoldPublicationView, workFolderName?: string) {
  return {
    publicationId: view.publicationId,
    kind: view.kind,
    workFolderId: view.workFolderId,
    ...(workFolderName ? { workFolderName } : {}),
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
      : automationErrorStatus(error) ?? restrictedAppErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error ?? "work-folder act command failed.");
    if (statusCode === 400) throw new WorkFoldCliError("usage", message, { cause: error });
    if (statusCode === 403) throw new WorkFoldCliError("permissionDenied", message, { cause: error });
    if (statusCode === 404) throw new WorkFoldCliError("notFound", message, { cause: error });
    if (statusCode === 409) throw new WorkFoldCliError("conflict", message, { cause: error });
    throw new WorkFoldCliError("failure", message, { cause: error });
  }
}

/**
 * Journal-first wrapper for a mutation initiated from trusted desktop
 * Settings. Automation-domain receipts remain the effect evidence; this global
 * pair records the product verb and the main-window surface exactly as the
 * act lane would. The returned promise lets callers separate durable command
 * acceptance from their own terminal domain result when needed.
 */
async function beginDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; result: Promise<T> }> {
  const requestId = `settings:${randomUUID()}`;
  const base = { requestId, command, surface: "main-window" as const };
  if (!await state.actReceipts.append({ ...base, outcome: "accepted" })) {
    throw new WorkFoldCliError(
      "failure",
      "work-fold could not journal this Settings action, so nothing was changed.",
    );
  }
  const result = (async () => {
    try {
      const applied = await operation(requestId);
      await state.actReceipts.append({ ...base, outcome: "ok", detail: applied.detail }).catch(() => false);
      return applied.value;
    } catch (error) {
      await state.actReceipts.append({
        ...base,
        outcome: "error",
        ...(error instanceof WorkFoldCliError ? { errorCode: error.code } : {}),
        detail: errorMessage(error),
      }).catch(() => false);
      throw error;
    }
  })();
  return { requestId, result };
}

type McpSetupSession = { workFolderId: string; service: ReturnType<typeof createIncludedMcpSetup>; timer: ReturnType<typeof setTimeout> };
const mcpSetupSessions = new WeakMap<LocalApiState, Map<string, McpSetupSession>>();
function resetMcpSetupExpiry(state: LocalApiState, id: string, entry: McpSetupSession): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { mcpSetupSessions.get(state)?.delete(id); void entry.service.dispose().catch(() => undefined); }, 15 * 60_000);
  entry.timer.unref();
}
async function closeMcpSetups(state: LocalApiState): Promise<void> {
  const entries = mcpSetupSessions.get(state); mcpSetupSessions.delete(state);
  await Promise.allSettled([...(entries?.values() ?? [])].map(async (entry) => { clearTimeout(entry.timer); await entry.service.dispose(); }));
}

async function runDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; value: T }> {
  const started = await beginDesktopSettingsAct(state, command, operation);
  return { requestId: started.requestId, value: await started.result };
}

function turnStatusFor(state: LocalApiState, workFolderId: string, taskId: string): WorkFoldActTurnStatus {
  const active = state.activeTurnTasks.get(taskId);
  if (active && active.workFolderId === workFolderId) {
    return { taskId, state: "running", conversationId: active.conversationId, messageId: null, error: null, endedAt: null };
  }
  const settled = state.settledTurns.get(taskId);
  if (settled && settled.workFolderId === workFolderId) {
    return {
      taskId,
      state: settled.status,
      conversationId: settled.conversationId,
      messageId: settled.messageId ?? null,
      error: settled.error ?? null,
      endedAt: settled.endedAt,
    };
  }
  // Older than the in-memory window: the durable turn journal still knows it.
  const durable = state.turnStore.get(taskId);
  if (durable && durable.workFolderId === workFolderId && durable.status !== "accepted" && durable.status !== "running") {
    return {
      taskId,
      state: durable.status === "interrupted" ? "failed" : durable.status,
      conversationId: durable.conversationId,
      messageId: durable.messageId ?? null,
      error: durable.error ?? null,
      endedAt: durable.updatedAt,
    };
  }
  return { taskId, state: "unknown", conversationId: null, messageId: null, error: null, endedAt: null };
}

// --- the collaboration verbs and the request graph (F27/F28) --------------

const maxTurnsRememberedThisRun = 4_000;

/**
 * The `--task` rule for `chat report`, `chat ask`, and `chat handoff`: the
 * id must name the caller's own turn — the newest, still-running turn of a
 * request the named work-folder owns — checked exactly as `--parent-task` is. The
 * store's lineage refusal reaches the caller as a conflict by name.
 */
function assertOwnTask(state: LocalApiState, workFolderId: string, taskId: string): WorkFoldRequestRecord {
  try {
    return state.requests.assertOwnAcceptingTurn(taskId, workFolderId === workFoldAgentScopeId ? {} : { workFolderId });
  } catch (error) {
    throw collaborationRefusal(error);
  }
}

/** A request bound or lineage refusal is a conflict that carries the store's own sentence; anything else passes through. */
function collaborationRefusal(error: unknown): unknown {
  if (error instanceof WorkFoldRequestLimitError || error instanceof WorkFoldRequestLineageError) {
    return new WorkFoldCliError("conflict", error.message, { cause: error });
  }
  return error;
}

function requestLimitRefusalMessage(limit: "questionLifetime" | "deadline"): string {
  return "This request has expired.";
}

/**
 * F28's `waiting` field: the oldest open question this task itself asked,
 * or null. A question past its window by wall-clock is never reported live
 * even before the store's sweep marks it expired.
 */
function waitingRefForTask(state: LocalApiState, taskId: string): WorkFoldActWaitingRef | null {
  const record = state.requests.byTaskId(taskId);
  if (!record) return null;
  const now = Date.now();
  const open = state.requests.questions(record.requestId)
    .filter((question) => (question.state === "open" || (question.state === "answered" && question.continuationTaskId === null)) && (question.expiresAt === null || now < Date.parse(question.expiresAt)))
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt));
  const question = open[0];
  if (!question) return null;
  return {
    questionId: question.questionId,
    requestId: question.requestId,
    respondent: question.respondent,
    question: question.text,
    askedAt: question.askedAt,
    expiresAt: question.expiresAt,
  };
}

/**
 * The request reference a work-folder-scoped verb hands back to the caller.
 *
 * Identical to `toActRequestRef` except for one field: a delegated work-folder
 * request's `rootId` is usually the FOLD's root request id, and
 * `requests show` reads a request by id. Handing that id into a work-folder turn
 * would put the work-fold agent's own content and other work-folders' results one taught
 * command away — the same leak `work-folder-turn-context.ts` withholds the parent
 * request id to avoid — so it is projected through the same opaque handle no
 * verb accepts. A work-folder's own root still names itself.
 */
function toActRequestRefForWorkFolder(state: LocalApiState, record: WorkFoldRequestRecord): WorkFoldActRequestRef {
  const ref = toActRequestRef(state, record);
  if (record.owner.workFolderId === undefined || record.rootId === record.requestId) return ref;
  return { ...ref, rootId: workFolderTurnParentHandle(record.rootId, state.workFolderTurnHandleSalt) };
}

function toActRequestRef(state: LocalApiState, record: WorkFoldRequestRecord): WorkFoldActRequestRef {
  return {
    id: record.requestId,
    rootId: record.rootId,
    kind: record.kind,
    state: record.state,
    depth: record.depth,
    workFolderId: record.owner.workFolderId ?? null,
    workFolderName: record.owner.workFolderName ?? null,
    conversationId: record.owner.conversationId,
    deadline: record.deadline,
    openQuestions: state.requests.questions(record.requestId).filter((question) => question.state === "open").length,
    children: record.childRequestIds.length,
    results: record.results.length,
  };
}

function toActQuestionRef(question: WorkFoldQuestionRecord): WorkFoldActQuestionRef {
  return {
    questionId: question.questionId,
    requestId: question.requestId,
    taskId: question.taskId,
    respondent: question.respondent,
    text: question.text,
    state: question.state,
    askedAt: question.askedAt,
    expiresAt: question.expiresAt,
    answer: question.answer,
    answeredAt: question.answeredAt,
    continuationTaskId: question.continuationTaskId,
  };
}

function requestSummaryView(state: LocalApiState, record: WorkFoldRequestRecord): WorkFoldActRequestSummary {
  return {
    ...toActRequestRef(state, record),
    surface: record.surface,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    settledAt: record.settledAt,
    taskId: record.turns.at(-1)!.taskId,
    continuationCount: record.continuationCount,
    limitHit: record.limitHit,
  };
}

/**
 * `requests list` and `requests show` are management-scope reads: the whole
 * graph, including the work-fold agent's own assignment text and every work-folder's result
 * envelope. A caller working inside a registered work-folder is inside that work-folder's
 * scope, and what may reach a work-folder is its assignment, answers to its own
 * questions, and payloads released to it — never the graph (F9 as amended,
 * F26). The caller's directory resolves its scope exactly as `context` does,
 * and the refusal names the boundary and the verbs that do belong to a work-folder.
 */
async function assertRequestsAboveWorkFolders(cwd: string | undefined): Promise<void> {
  const candidate = cwd?.trim();
  if (!candidate) return;
  const resolved = resolve(candidate);
  const containing = (await listWorkFolders())
    .filter((workFolder) => pathContainsPath(workFolder.workFolderRoot, resolved))
    .sort((left, right) => resolve(right.workFolderRoot).length - resolve(left.workFolderRoot).length)[0];
  if (!containing) return;
  throw new WorkFoldCliError(
    "permissionDenied",
    `The request record sits above work-folders, and this ran inside "${containing.name}". Follow your own work with 'chat status' and 'chat wait', and report with 'chat report'.`,
  );
}

/** `requests show`: the complete subtree, rejecting damaged cycles. */
async function requestDetailView(state: LocalApiState, record: WorkFoldRequestRecord, ancestors = new Set<string>()): Promise<WorkFoldActRequestDetail> {
  if (ancestors.has(record.requestId)) throw new Error("Request graph contains a cycle.");
  const path = new Set(ancestors).add(record.requestId);
  const reads = await state.requests.results(record.requestId);
  const resultRecords: WorkFoldActRequestResult[] = record.results.map((ref) => {
    const read = reads.find((candidate) => (candidate.state === "ok" ? candidate.record.resultId : candidate.resultId) === ref.resultId);
    return {
      resultId: ref.resultId,
      taskId: ref.taskId,
      recordedAt: ref.recordedAt,
      receiptId: ref.receiptId,
      outcome: ref.outcome,
      fileCount: ref.fileCount,
      envelope: read?.state === "ok" ? read.record.envelope : null,
      ...(read?.state === "damaged" ? { damaged: read.error } : {}),
    };
  });
  const childRequests: WorkFoldActRequestDetail[] = [];
  if (state.requests.children(record.requestId).length) {
    for (const child of state.requests.children(record.requestId)) {
      childRequests.push(await requestDetailView(state, child, path));
    }
  }
  return {
    ...requestSummaryView(state, record),
    parentRequestId: record.parentRequestId,
    parentTaskId: record.parentTaskId,
    content: record.content,
    turns: record.turns.map((turn) => ({
      taskId: turn.taskId,
      role: turn.role,
      state: turn.state,
      acceptedAt: turn.acceptedAt,
      settledAt: turn.settledAt,
      error: turn.error,
    })),
    questions: state.requests.questions(record.requestId).map(toActQuestionRef),
    resultRecords,
    usage: record.usage,
    stopRequestedAt: record.stopRequestedAt,
    reconciledAt: record.reconciledAt,
    childRequests,
  };
}

/**
 * A report's deliverables: each named path must be a file inside the work-folder,
 * outside the reserved folders, and is recorded by content hash and size so
 * the envelope says exactly which bytes were meant.
 */
async function resolveReportFiles(
  workFolder: WorkFolderSummary,
  files: string[],
): Promise<Array<{ path: string; sha256: string; sizeBytes: number }>> {
  const resolved: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  for (const raw of files) {
    const relativePath = normalizeWorkFolderRelativePath(raw);
    let absolute: string;
    try {
      absolute = resolveWorkFolderPath(workFolder.workFolderRoot, relativePath);
    } catch (error) {
      throw new WorkFoldCliError("usage", `--file ${raw}: ${errorMessage(error)}`, { cause: error });
    }
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new WorkFoldCliError("notFound", `--file ${raw}: not found in ${workFolder.name}.`);
    if (!info.isFile()) throw new WorkFoldCliError("usage", `--file ${raw}: a result names files, not folders.`);
    const hash = createHash("sha256");
    await new Promise<void>((resolveHash, reject) => {
      createReadStream(absolute)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolveHash());
    });
    resolved.push({ path: relativePath, sha256: hash.digest("hex"), sizeBytes: info.size });
  }
  return resolved;
}

/** `--data @<path>`: read host-side against the directory the command ran in, bounded by the envelope's own data limit. */
async function readReportDataFile(dataPath: string, cwd: string): Promise<unknown> {
  const absolute = isAbsolute(dataPath) ? resolve(dataPath) : resolve(cwd, dataPath);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isFile()) throw new WorkFoldCliError("notFound", `--data @${dataPath}: file not found.`);
  if (info.size > workFoldRequestLimits.maxResultDataBytes) {
    throw new WorkFoldCliError("usage", workFoldRequestLimitMessage("resultData", workFoldRequestLimits.maxResultDataBytes));
  }
  const text = await readFile(absolute, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new WorkFoldCliError("usage", `--data @${dataPath}: the file is not valid JSON.`, { cause: error });
  }
}

/** A handoff source is a work-folder-relative path resolved inside the caller's own work-folder. */
function resolveHandoffSource(workFolder: WorkFolderSummary, raw: string): string {
  try {
    return resolveWorkFolderPath(workFolder.workFolderRoot, normalizeWorkFolderRelativePath(raw));
  } catch (error) {
    throw new WorkFoldCliError("usage", `--file ${raw}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Every settle in this app run passes through here, serialized, so two
 * children settling in the same tick can never start two continuations.
 * Failures are logged; a settle never fails because of a continuation.
 */
function queueRequestGraphSettle(state: LocalApiState, taskId: string): void {
  state.turnsSettledThisRun.add(taskId);
  while (state.turnsSettledThisRun.size > maxTurnsRememberedThisRun) {
    const oldest = state.turnsSettledThisRun.values().next().value;
    if (oldest === undefined) break;
    state.turnsSettledThisRun.delete(oldest);
  }
  state.requestSettleChain = state.requestSettleChain
    .then(() => evaluateRequestGraphSettle(state, taskId))
    .then(() => state.appAssistantTasks.refresh())
    .catch((error: unknown) => {
      console.error(`A request continuation could not be evaluated: ${errorMessage(error)}`);
    });
}

/** Releasing compaction makes pending deliveries eligible without inventing a new turn settlement. */
function queueConversationRequestEvaluation(state: LocalApiState, workFolderId: string, conversationId: string): void {
  state.requestSettleChain = state.requestSettleChain
    .then(async () => {
      for (const request of state.requests.list({ workFolderId })) {
        if (request.owner.conversationId === conversationId) {
          await evaluateRequestGraphSettle(state, request.turns.at(-1)!.taskId);
        }
      }
    })
    .then(() => state.appAssistantTasks.refresh())
    .catch((error: unknown) => {
      console.error(`A request continuation could not be evaluated after compaction: ${errorMessage(error)}`);
    });
}

async function evaluateRequestGraphSettle(state: LocalApiState, taskId: string): Promise<void> {
  const record = state.requests.byTaskId(taskId);
  if (!record) return;
  const candidates = new Map<string, WorkFoldRequestRecord>();
  let current: WorkFoldRequestRecord | null = record;
  while (current) {
    candidates.set(current.requestId, current);
    current = current.parentRequestId ? state.requests.get(current.parentRequestId) : null;
  }
  // Finishing any turn frees its Chat, including one that was occupied by a
  // newer request when this request's children finished.
  for (const other of state.requests.list()) {
    if (other.owner.workFolderId === record.owner.workFolderId && other.owner.conversationId === record.owner.conversationId) {
      candidates.set(other.requestId, other);
    }
  }
  for (const candidate of [...candidates.values()].sort((a, b) => b.depth - a.depth)) {
    await maybeStartRequestContinuation(state, candidate.requestId);
  }
}

/** Person-facing work is scoped to one request and its deliberately linked work. */
async function workFoldAgentConversationAttention(state: LocalApiState, conversationId: string) {
  const record = state.requests.latestForConversation(conversationId);
  const work = record?.state === "waiting" ? await requestPresentation(state, record) : null;
  return { requestState: record?.state ?? null, needsAnswer: (work?.questionCount ?? 0) > 0
    || extensionSnapshot(state, { workFolderRoot: workFoldAgentRoot(), conversationId }).length > 0 };
}

async function requestPresentation(state: LocalApiState, record: WorkFoldRequestRecord, remote = false): Promise<WorkRequestView> {
  const family = [record, ...state.requests.subtree(record.requestId)];
  const latest = record.turns.at(-1)!;
  const outstanding = family.some((item) => !isWorkFoldRequestTerminalState(item.state));
  const questions: WorkRequestView["questions"] = [];
  let questionCount = 0;
  let savedAnswerCount = 0;
  for (const item of family) {
    for (const question of state.requests.questions(item.requestId)) {
      if (question.respondent !== "person" || !(question.state === "open" || (question.state === "answered" && !question.continuationTaskId))) continue;
      if ((question.expiresAt !== null && Date.now() >= Date.parse(question.expiresAt))) continue;
      questionCount++;
      if (question.state === "answered") savedAnswerCount++;
      // A page of exact questions, not truncated question text. After an
      // answer the next question becomes visible. The digest retains all ids.
      if (questions.length >= workFoldRequestLimits.questionsPerPresentation) continue;
      let reason: string | undefined;
      try { state.requests.assertCanContinue(item.requestId); } catch (error) { reason = errorMessage(error); }
      const key = clientKey(item.owner.workFolderId ?? workFoldAgentScopeId, item.owner.conversationId);
      if (state.runningTurns.has(key) || state.compactingConversations.has(key)) reason = "The agent is finishing its current turn. You can write your answer now.";
      questions.push({ id: question.questionId, requestId: item.requestId, text: question.text,
        from: item.owner.workFolderName ?? (item.owner.workFolderId ? "Worker" : "work-fold"),
        state: question.state === "answered" ? "recorded" : "open",
        ...(question.state === "answered" && question.answer ? { answer: question.answer } : {}),
        canAnswer: !reason, ...(reason ? { reason } : {}) });
    }
  }
  let detail: string | null = null;
  let canContinue = false;
  if (record.continuationState === "failed") {
    detail = "The follow-up did not start. Your saved results are still available.";
  }
  const readyResults = state.requests.children(record.requestId).some((child) => {
    const turn = child.turns.at(-1)!;
    return turn.settledAt && !record.deliveredChildTaskIds.includes(turn.taskId);
  });
  if (!outstanding && !questionCount && (record.continuationState === "failed" || readyResults)) {
    try {
      state.requests.assertCanContinue(record.requestId);
      const key = clientKey(record.owner.workFolderId ?? workFoldAgentScopeId, record.owner.conversationId);
      canContinue = !state.runningTurns.has(key) && !state.compactingConversations.has(key);
      if (!detail) detail = "The delegated work is ready. Continue to bring its results together.";
    } catch { canContinue = false; }
  }
  if (record.limitHit) detail = requestLimitStopMessage(record.limitHit.limit);
  else if (record.state === "expired") detail = "This request’s time window ended. Its saved work remains; start a new message to pick it up.";
  else if (latest.state === "interrupted") detail = "Work was interrupted when the app closed. Saved work remains; nothing was restarted automatically.";
  else if (record.state === "failed" && !detail) detail = latest.error ?? "The agent could not finish. Its saved work remains in the Chat.";
  let result: WorkRequestView["result"] = null;
  if (isWorkFoldRequestTerminalState(record.state) && record.state !== "stopped" && record.state !== "expired") {
    const selected = [...record.results].reverse().find((item) => item.taskId === latest.taskId);
    if (selected) {
      const read = await state.requests.result(selected.resultId);
      if (read?.state === "ok") {
        const envelope = read.record.envelope;
        const files: NonNullable<WorkRequestView["result"]>["files"] = [];
        if (record.owner.workFolderId) for (const file of envelope.files ?? []) {
          if (remote && !await isRemoteFileVisible(record.owner.workFolderId, file.path)) continue;
          files.push({ ...file, workFolderId: record.owner.workFolderId, workFolderName: record.owner.workFolderName ?? "work-folder" });
        }
        result = { summary: envelope.summary, outcome: record.state === "partial" ? "partial" : envelope.outcome, files };
      } else detail = "The selected result could not be read. Its receipt remains; try again or open the Chat.";
    }
  }
  // Direct-child reports are deliberately released deliverables. Fold
  // requests have no work-folder file root of their own; retain each file's origin.
  if (isWorkFoldRequestTerminalState(record.state) && record.state !== "stopped" && record.state !== "expired") {
    const files = result?.files ?? [];
    const seen = new Set(files.map((file) => `${file.workFolderId}:${file.path}`));
    for (const child of state.requests.children(record.requestId)) {
      const childTurn = child.turns.at(-1)!;
      const selected = [...child.results].reverse().find((item) => item.taskId === childTurn.taskId);
      if (!selected || !child.owner.workFolderId) continue;
      const read = await state.requests.result(selected.resultId);
      if (read?.state !== "ok") continue;
      for (const file of read.record.envelope.files ?? []) {
        const key = `${child.owner.workFolderId}:${file.path}`;
        if (seen.has(key)) continue;
        if (remote && !await isRemoteFileVisible(child.owner.workFolderId, file.path)) continue;
        seen.add(key); files.push({ ...file, workFolderId: child.owner.workFolderId, workFolderName: child.owner.workFolderName ?? "work-folder" });
      }
    }
    if (files.length && !result) result = { summary: "Files from the completed work.", outcome: record.state === "done" ? "succeeded" : record.state === "partial" ? "partial" : "failed", files };
  }
  return { version: 1, requestId: record.requestId, taskId: latest.taskId, owner: record.owner,
    state: record.state, label: workRequestLabel(record.state, questionCount - savedAnswerCount, savedAnswerCount), detail,
    canStop: outstanding && !record.stopRequestedAt, canContinue, questions, questionCount,
    hadQuestions: family.some((item) => item.questionIds.length > 0), result,
    children: state.requests.children(record.requestId).map((child) => ({ requestId: child.requestId,
      title: child.owner.workFolderName ?? "work-fold", state: child.state,
      label: workRequestLabel(child.state,
        state.requests.questions(child.requestId).filter((q) => q.respondent === "person" && q.state === "open").length,
        state.requests.questions(child.requestId).filter((q) => q.respondent === "person" && q.state === "answered" && !q.continuationTaskId).length) })) };
}

function assertRemoteWorkOwner(state: LocalApiState, record: WorkFoldRequestRecord, principal: WorkFoldRemotePrincipal): void {
  const root = state.requests.get(record.rootId);
  if (!root || root.owner.workFolderId || !isRemoteWorkFoldAgentRequestOwner(root, principal)) {
    throw notFound("Remote request not found for this browser grant. This work belongs to another surface; open it in work-fold on the desktop.");
  }
}

async function performWorkAction(state: LocalApiState, record: WorkFoldRequestRecord, action: string, input: Record<string, unknown>, principal?: WorkFoldRemotePrincipal): Promise<void> {
  const receipt = { requestId: `work-ui:${randomUUID()}`, command: action === "answer" ? "chat.answer" : action === "stop" ? "agent.stop" : "chat.send",
    surface: principal ? "remote_web" as const : input.surface === "popover" ? "popover" as const : "main-window" as const,
    ...(principal ? { browserId: principal.browserId, grantId: principal.grantId } : {}) };
  if (!await state.actReceipts.append({ ...receipt, outcome: "accepted" })) throw httpError(503, "Could not record this action. Please try again.");
  try {
    if (action === "stop") await stopWorkFoldAgentRequest(state, record.turns.at(-1)!.taskId);
    else if (action === "answer") {
      if (typeof input.questionId !== "string" || typeof input.answer !== "string" || !input.answer.trim()) throw badRequest("Write an answer before sending.");
      const question = state.requests.question(input.questionId);
      const family = [record, ...state.requests.subtree(record.requestId)];
      const owner = question && family.find((item) => item.requestId === question.requestId);
      if (!question || !owner || question.respondent !== "person") throw notFound("That question does not belong to this work.");
      // A retry after a lost response acknowledges the existing delivery.
      if (question.state === "answered" && question.continuationTaskId && question.answer === input.answer.trim()) {
        await state.actReceipts.append({ ...receipt, outcome: "ok", detail: `request ${record.requestId}; answer already delivered` });
        return;
      }
      const facade = createWorkFoldActFacade(state);
      if (owner.owner.workFolderId) await facade.chatAnswer({ workFolder: owner.owner.workFolderId, questionId: question.questionId, answer: input.answer });
      else await facade.agentAnswer({ questionId: question.questionId, answer: input.answer });
    } else if (action === "continue") {
      const deliveryId = remoteStableId(input.deliveryId, "delivery id", 160);
      const view = await requestPresentation(state, record);
      const replay = record.turns.some((turn) => state.turnStore.get(turn.taskId)?.requestId === deliveryId);
      if (!view.canContinue && !replay) throw httpError(409, "This work cannot continue here. Open the Chat for its current state.");
      const workFolder = record.owner.workFolderId ? await getWorkFolder(record.owner.workFolderId) : workFoldAgentScope(state);
      await acceptConversationTurn(state, { id: record.owner.workFolderId ?? workFoldAgentScopeId, workFolderRoot: "workFolderRoot" in workFolder ? workFolder.workFolderRoot : workFolder.rootPath }, record.owner.conversationId, {
        content: await composeContinuationMessage(state, record, state.requests.children(record.requestId)), contextPaths: [], selectedPath: null,
        releasedChildTaskIds: state.requests.children(record.requestId).map((child) => child.turns.at(-1)!.taskId),
        actorKind: "system", requestId: deliveryId, request: { joinRequestId: record.requestId },
      });
    } else throw badRequest("Unknown work action.");
    await state.actReceipts.append({ ...receipt, outcome: "ok", detail: `request ${record.requestId}` });
  } catch (error) {
    await state.actReceipts.append({ ...receipt, outcome: "error", detail: errorMessage(error) }).catch(() => false);
    throw error;
  } finally { publishControlHint(state, "work-folders"); }
}

/** Bounded, addressed delivery for every owner; never replayed on startup. */
async function maybeStartRequestContinuation(state: LocalApiState, requestId: string): Promise<void> {
  if (!state.requests.continuationsEnabled() || !state.acceptingTurns) return;
  const request = state.requests.get(requestId);
  if (!request || request.stopRequestedAt || request.state === "stopped" || request.state === "expired" || request.limitHit) return;
  const scopeId = request.owner.workFolderId ?? workFoldAgentScopeId;
  if (scopeId === workFoldAgentScopeId && state.workFoldAgentInstructionsError) return;
  const own = request.turns.at(-1)!;
  if (own.state === "accepted" || own.state === "running" || own.state === "aborted") return;
  if (state.requests.questions(requestId).some((q) => q.state === "open" || (q.state === "answered" && q.continuationTaskId === null))) return;
  const key = clientKey(scopeId, request.owner.conversationId);
  if (state.runningTurns.has(key) || state.compactingConversations.has(key)) return;
  if (state.requests.subtree(requestId).some((child) => child.continuationState === "pending"
    || child.turns.some((turn) => turn.state === "accepted" || turn.state === "running"))) return;
  const batch = state.requests.children(requestId).filter((child) => {
    const turn = child.turns.at(-1)!;
    return turn.settledAt !== null && state.turnsSettledThisRun.has(turn.taskId)
      && !request.deliveredChildTaskIds.includes(turn.taskId);
  });
  if (!batch.length) return;
  // Compose before claiming: a read failure has not accepted a delivery.
  const content = await composeContinuationMessage(state, request, batch);
  const workFolder = request.owner.workFolderId ? await getWorkFolder(request.owner.workFolderId)
    : { id: workFoldAgentScopeId, workFolderRoot: workFoldAgentScope(state).rootPath };
  const note = await state.requests.noteContinuation(requestId, batch.map((child) => child.turns.at(-1)!.taskId));
  if (!note.allowed) return;
  try {
    await acceptConversationTurn(state, workFolder, request.owner.conversationId, {
      content, contextPaths: [], selectedPath: null, actorKind: "system",
      ...(request.owner.workFolderId ? {} : { workFoldAgentAttachments: [] }),
      requestId: `continuation-${requestId}-${note.count}`,
      request: { joinRequestId: requestId },
    });
  } catch (error) {
    await state.requests.failContinuation(requestId);
    console.error(`Request ${requestId} could not start its follow-up turn: ${errorMessage(error)}`);
  }
}

/**
 * The continuation's message: deterministic, bounded, no model call. It
 * names each settled child, its reported outcome or failure, the files it
 * named, and any question still open beneath it, then points at the record.
 */
async function composeContinuationMessage(
  state: LocalApiState,
  root: WorkFoldRequestRecord,
  batch: WorkFoldRequestRecord[],
): Promise<string> {
  const lines: string[] = [
    `work-fold is continuing request ${root.requestId}: selected results or questions from work it handed out are ready. Nobody typed this message.`,
    "",
  ];
  for (const child of batch) {
    const turn = child.turns.at(-1)!;
    const where = `${child.owner.workFolderName ?? child.owner.workFolderId ?? "a work-folder"} [${child.owner.workFolderId ?? ""}]`;
    const ref = [...child.results].reverse().find((result) => result.taskId === turn.taskId);
    const newest = ref ? await state.requests.result(ref.resultId) : null;
    if (ref && newest?.state !== "ok") throw new Error("The selected child result is unavailable; its receipt remains on record.");
    const unsuccessful = turn.state === "failed" || turn.state === "aborted"
      || child.state === "failed" || child.state === "stopped" || child.state === "expired";
    const outcome = unsuccessful
      ? `${child.state === "waiting" ? turn.state : child.state}${turn.error ? `: ${turn.error}` : ""}`
      : newest?.state === "ok"
      ? `${child.state === "partial" ? "partial" : newest.record.envelope.outcome}: ${newest.record.envelope.summary}`
      : turn.state === "succeeded"
        ? "finished without a report"
        : `${turn.state}${turn.error ? `: ${turn.error}` : ""}`;
    lines.push(`- ${where} — Chat ${child.owner.conversationId}, task ${turn.taskId} — ${outcome}`);
    const files = newest?.state === "ok" ? newest.record.envelope.files ?? [] : [];
    if (files.length) {
      lines.push(`  files: ${files.map((file) => file.path).join(", ")}`);
    }
    for (const question of state.requests.questions(child.requestId).filter((candidate) => candidate.state === "open")) {
      const to = question.respondent === "person"
        ? "the person"
        : child.parentRequestId === root.requestId
          ? "you"
          : "the request above it";
      lines.push(`  waiting on ${to}: question ${question.questionId} — ${question.text}`);
      if (to === "you" && child.owner.workFolderId) {
        lines.push(`    answer it with: work-fold chat answer --work-folder ${child.owner.workFolderId} --question ${question.questionId} --answer "<text>" --parent-task <this-request-task-id> --json`);
      }
    }
  }
  lines.push(
    "",
    root.owner.workFolderId
      ? "Bring these selected results together for your assignment. Answer questions addressed to you. Submit any needed chat report before your final reply, then give the complete useful answer in that reply. Child files remain in their source work-folder until explicitly copied."
      : `The whole record: work-fold requests show --request ${root.requestId} --json. Bring these results together for the person; answer what is yours to answer; if the request is finished, say so and end your turn.`,
  );
  return clampUtf8(lines.join("\n"), workFoldAutomationDeclarationBounds.maxResolvedMessageBytes);
}

/** Cuts on a byte bound and drops a trailing partial character rather than storing a replacement glyph. */
function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - Buffer.byteLength("…"))).toString("utf8").replace(/�+$/u, "")}…`;
}

function conversationRuntimeState(state: LocalApiState, workFolderId: string, conversationId: string): WorkFoldActChatState {
  const key = clientKey(workFolderId, conversationId);
  if (state.runningTurns.has(key)) return "running";
  if (state.compactingConversations.has(key)) return "compacting";
  return "idle";
}

function toActWorkFolderRef(workFolder: Pick<WorkFolderSummary, "id" | "name" | "workFolderRoot">): WorkFoldActWorkFolderRef {
  return { id: workFolder.id, name: workFolder.name, workFolderRoot: workFolder.workFolderRoot };
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
function toActCheckpointSummary(checkpoint: WorkFolderCheckpoint): WorkFoldActCheckpointSummary {
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

function toActFileVersionRef(version: WorkFolderFileVersion): WorkFoldActFileVersionRef {
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
  workFolderId: string,
  workFolderRoot: string,
  conversationId: string,
  content: string,
  contextPaths: string[],
  selectedPath: string | null,
  taskId: string,
  options: {
    workFoldAgentAttachments?: WorkFoldAgentAttachmentRef[];
    /** The task that delegated this work-folder turn; decorates its context, never its acceptance. */
    parentTaskId?: string;
    /** The assignment when it differs from this turn's message. */
    assignment?: string;
    /** The question this turn's message answers, when it is a continuation (F27). */
    answeredQuestionId?: string;
    /** work-folder Workers the person addressed with @ in this message (2026-10-01). */
    addressedWorkFolderIds?: string[];
  } = {},
): Promise<void> {
  const { workFoldAgentAttachments, answeredQuestionId } = options;
  const request = state.requests.byTaskId(taskId);
  const parentTaskId = request?.parentTaskId ?? options.parentTaskId;
  const assignment = request?.assignment ?? options.assignment;
  const key = clientKey(workFolderId, conversationId);
  let client: PiConversationClient | null = null;
  let promptStarted = false;
  let settledStatus: SettledTurnRecord["status"] = "succeeded";
  let settledMessageId: string | undefined;
  let settledError: string | undefined;
  let capturedWorkTrail: ReturnType<PiConversationClient["getTurnWorkTrail"]> = [];
  let capturedPresentation: ReturnType<PiConversationClient["getTurnPresentation"]>;
  let beforeCheckpoint: import("./history.js").WorkFolderCheckpoint | null = null;
  let afterCheckpoint: import("./history.js").WorkFolderCheckpoint | null = null;
  changeTurnCount(state, 1);
  try {
    client = await getClient(state, workFolderId, workFolderRoot, conversationId);
    const loadContextAttachments = (budgetTokens: number) => workFoldAgentAttachments
      ? loadWorkFoldAgentAttachmentsForTurn(workFoldAgentAttachments, budgetTokens)
      : loadConversationContextReferencesForTurn(workFolderRoot, contextPaths, budgetTokens);
    const attachedLinks = workFoldAgentAttachments ? workFoldAgentAttachmentLinks(workFoldAgentAttachments) : [];
    const workFoldAgentRegistry = workFolderId === workFoldAgentScopeId
      ? (await state.kernel.getWorkFolders({ kind: "renderer" })).workFolders
      : null;
    // work-folder turns read nesting from the registry file only — never listWorkFolders(),
    // which rewrites every work-folder's portable manifest — and a failed read just
    // leaves the nesting context out instead of failing the turn.
    const registeredWorkFolders: Array<{ id: string; name: string; workFolderRoot: string }> = workFoldAgentRegistry
      ?? await registeredWorkFolderOutline().catch(() => []);
    const workFoldAgentWorkFolders = workFoldAgentRegistry
      ? workFoldAgentRegistry.map((workFolder) => ({
          id: workFolder.id,
          name: workFolder.name,
          workFolderRoot: workFolder.workFolderRoot,
          ...(workFolder.parentWorkFolderId ? { parentWorkFolderId: workFolder.parentWorkFolderId } : {}),
        }))
      : undefined;
    // work-folders inside work-folders (2026-10-01): the person's @ mentions resolve to
    // the ids handoff and send take, and a parent's Worker learns which of
    // its own subfolders belong to another Worker.
    const addressedFolders = (options.addressedWorkFolderIds ?? []).flatMap((id) => {
      const workFolder = registeredWorkFolders.find((item) => item.id === id);
      return workFolder ? [{ workFolderId: workFolder.id, name: workFolder.name }] : [];
    });
    // A work-folder turn's own identity (F26): its ids, and when delegated, an
    // opaque handle for the request that asked. Never for the work-fold agent
    // scope, which carries the registry snapshot instead.
    const workFolderTurn = workFolderId === workFoldAgentScopeId
      ? undefined
      : buildWorkFolderTurnContext({
        workFolderId,
        taskId,
        requestId: resolveTurnRequestId(state, taskId),
        handleSalt: state.workFolderTurnHandleSalt,
        ...(answeredQuestionId ? { answeredQuestionId } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(assignment !== undefined && assignment !== content ? { assignment } : {}),
        ...(parentTaskId && (assignment === undefined || assignment === content) ? { assignmentIsThisMessage: true } : {}),
      });
    if (workFolderTurn && request) {
      const children = state.requests.children(request.requestId).filter((child) => {
        const latest = child.turns.at(-1)!;
        return latest.settledAt !== null && !request.deliveredChildTaskIds.includes(latest.taskId);
      });
      if (children.length) {
        workFolderTurn.releasedChildResults = await composeContinuationMessage(state, request, children);
        await state.requests.noteChildDelivery(request.requestId, children.map((child) => child.turns.at(-1)!.taskId));
      }
    }
    beforeCheckpoint = await captureTurnCheckpointSafe(state, workFolderId, workFolderRoot, conversationId, "pre_turn");
    if (workFolderTurn) workFolderTurn.history = workFolderTurnHistory(beforeCheckpoint);
    const ownWorkFolder = registeredWorkFolders.find((item) => item.id === workFolderId);
    if (workFolderTurn && ownWorkFolder) {
      const nested = [...childFolderPaths(ownWorkFolder, registeredWorkFolders)].map(([path, child]) => ({ workFolderId: child.id, name: child.name, path }));
      if (nested.length) workFolderTurn.nestedFolders = nested;
    }
    await state.beforeAgentPrompt?.({ workFolderId, conversationId, taskId, ...(workFolderTurn ? { workFolderTurn } : {}) });
    throwIfTurnCancelled(state, taskId);
    promptStarted = true;
    const finalText = await client.prompt(content, {
      loadContextAttachments,
      selectedPath,
      ...(workFolderId === workFoldAgentScopeId ? { workFoldAgentTaskId: taskId } : {}),
      ...(workFoldAgentWorkFolders ? { workFoldAgentWorkFolders } : {}),
      ...(workFolderTurn ? { workFolderTurn } : {}),
      ...(attachedLinks.length ? { attachedLinks } : {}),
      ...(addressedFolders.length ? { addressedFolders } : {}),
    });
    // Capture synchronously with prompt completion. Shutdown may dispose the
    // client while the server awaits checkpoint persistence below.
    capturedPresentation = parseAssistantPresentation(client.getTurnPresentation(), finalText);
    capturedWorkTrail = client.getTurnWorkTrail();
    promptStarted = false;
    afterCheckpoint = await captureTurnCheckpointSafe(state, workFolderId, workFolderRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    const workTrail = capturedWorkTrail;
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: finalText,
      ...(capturedPresentation ? { assistantPresentation: capturedPresentation } : {}),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      ...(workTrail.length ? { workTrail } : {}),
    };
    await appendMessage(workFolderRoot, conversationId, assistantMessage);
    settledMessageId = assistantMessage.id;
    try {
      const transcript = await readConversation(workFolderRoot, conversationId);
      if (conversationNeedsGeneratedTitle(transcript)) {
        // Record the one naming attempt before the isolated request. A crash or
        // provider failure must not turn every later Chat turn into another
        // hidden title request.
        await markConversationTitleAttempted(workFolderRoot, conversationId);
        const firstUserMessage = transcript.find((message) => message.role === "user")?.content;
        const modelTitle = firstUserMessage
          ? normalizeGeneratedConversationTitle(
            await client.generateConversationTitle(firstUserMessage, finalText),
          )
          : null;
        if (modelTitle) {
          const titledConversation = await setGeneratedConversationTitle(workFolderRoot, conversationId, modelTitle);
          client.setSessionName(titledConversation.title);
        }
      }
    } catch (error) {
      // Naming is deliberately best-effort: a title provider failure must not
      // turn a successfully persisted agent response into a failed turn.
      console.warn(`Could not persist a generated Chat title: ${errorMessage(error)}`);
    }
  } catch (error) {
    // A reused client still holds its previous turn until prompt resets it.
    // Pre-prompt cancellation/failure must never inherit that turn's evidence.
    if (promptStarted) {
      capturedPresentation ??= client?.getTurnPresentation();
      capturedWorkTrail = client?.getTurnWorkTrail() ?? [];
    }
    const cancelled = isPiTurnCancelledError(error);
    if (promptStarted) {
      promptStarted = false;
      afterCheckpoint = await captureTurnCheckpointSafe(state, workFolderId, workFolderRoot, conversationId, "post_turn");
    }
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    let failureResultPreserved = false;
    if (!cancelled) {
      console.warn(`Turn failed in ${workFolderId}/${conversationId}: ${providerCreditFailureDetail(error) ?? errorMessage(error)}`);
    }
    const publicDetail = cancelled
      ? "The agent was stopped before it completed this response."
      : assistantFailurePublicDetail(error);
    const workTrail = capturedWorkTrail;
    const interruptedContent = assistantFailureTranscriptContent(error, durable?.assistantText ?? "", cancelled);
    const interruptedPresentation = parseAssistantPresentation(capturedPresentation, interruptedContent);
    const interruptedMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: interruptedContent,
      ...(interruptedPresentation ? { assistantPresentation: interruptedPresentation } : {}),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      ...(workTrail.length ? { workTrail } : {}),
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
      await appendMessage(workFolderRoot, conversationId, interruptedMessage);
      failureResultPreserved = true;
      settledMessageId = interruptedMessage.id;
    } catch (preservationError) {
      console.error(`Could not preserve an interrupted Worker result: ${errorMessage(preservationError)}`);
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
    if (promptStarted) afterCheckpoint = await captureTurnCheckpointSafe(state, workFolderId, workFolderRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durableText = state.turnStore.get(taskId)?.assistantText ?? "";
    // Attribution, recorded with the outcome: the model that actually ran this
    // turn and what Pi reported it used. App-requested tasks read it back from
    // the turn journal as their receipt (docs/receipts-not-gates.md, F22).
    const turnUsage = client?.getTurnUsage() ?? null;
    await state.turnStore.settle(taskId, {
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      assistantText: durableText,
      fileChanges: turnFileChanges(beforeCheckpoint, afterCheckpoint),
      ...(turnUsage ? { usage: turnUsage } : {}),
    }).catch((error) => {
      console.error(`Could not persist turn settlement: ${errorMessage(error)}`);
      return null;
    });
    // The request record settles with the same outcome and usage, before the
    // task-scoped record, so a waiter or the overview reads a current request
    // state on the next tick (F25).
    await state.requests.settleTurn(taskId, {
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      ...(turnUsage ? { usage: turnUsage } : {}),
    }).catch((error: unknown) => {
      console.error(`Could not persist request settlement: ${errorMessage(error)}`);
      return null;
    });
    state.runningTurns.delete(key);
    state.cancelledTurnTasks.delete(taskId);
    state.activeTurnIdsByKey.delete(key);
    state.kernel.finishTask(taskId);
    if (state.clientsToRefresh.delete(key)) {
      // The work-folder's apps changed during this turn (propose_space_app added a
      // preview). Rebuild this Chat's client so its next turn sees the new tools.
      const stale = state.clients.get(key);
      if (stale) {
        await stale.stop().catch(() => undefined);
        state.clients.delete(key);
      }
    }
    settleTurnTask(state, taskId, {
      workFolderId,
      conversationId,
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
    });
    broadcast(state, key, settledStatus === "succeeded"
      ? { type: "done", conversationId, turnId: taskId }
      : { type: "error", conversationId, turnId: taskId, message: settledError ?? "The turn did not finish." });
    broadcast(state, key, turnStateEvent(conversationId, false, taskId));
    changeTurnCount(state, -1);
    // F28: once this turn's own settlement is fully visible, the request
    // graph above it may owe the work-fold agent one continuation turn. Fire-and-forget
    // with its own catch, the way activeTurnPromises are: a settle never
    // fails because a continuation could not start.
    queueRequestGraphSettle(state, taskId);
  }
}

const maxSettledTurnRecords = 10_000;

/**
 * The request id a work-folder turn names in its context: the durable request
 * record's id when the store holds one, otherwise the turn journal's own
 * acceptance identity — for an undelegated work-folder turn that is its own root —
 * and finally the task id for a turn accepted before either existed. Nothing
 * here invents a request id.
 */
function resolveTurnRequestId(state: LocalApiState, taskId: string): string {
  return state.requests.byTaskId(taskId)?.requestId
    ?? state.turnStore.get(taskId)?.requestId
    ?? taskId;
}

async function recoverDurableTurnState(state: LocalApiState): Promise<void> {
  const records = state.turnStore.list().sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  for (const record of records.filter((candidate) => candidate.status !== "accepted" && candidate.status !== "running").slice(-maxSettledTurnRecords)) {
    rememberDurableSettledTurn(state, record);
  }
  for (const record of records.filter((candidate) => candidate.status === "accepted" || candidate.status === "running")) {
    const rootPath = record.workFolderId === workFoldAgentScopeId
      ? workFoldAgentRoot()
      : await getWorkFolder(record.workFolderId).then((workFolder) => workFolder.workFolderRoot).catch(() => null);
    if (!rootPath) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "The app closed before this turn finished, and its work-folder is no longer registered.",
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
    const detail = "work-fold closed before this turn finished. It was not run again because completed tools may already have changed something.";
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
      console.error(`Could not append an interrupted Worker result during startup recovery: ${errorMessage(error)}`);
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
    workFolderId: record.workFolderId,
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
  publishControlHint(state, "activity");
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
  if (isPiTurnCancelledError(error)) return "Turn cancelled.";
  if (!(error instanceof PiTurnFailure)) return assistantFailurePublicDetail(error);
  const creditFailure = providerCreditFailureDetail(error);
  if (creditFailure) return partialResponsePreserved
    ? `${creditFailure} work-fold saved the partial response and completed activity below.`
    : `${creditFailure} work-fold could not save the partial response.`;
  const retrySummary = error.retryAttempts > 0
    ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
    : "";
  return partialResponsePreserved
    ? `The model stopped responding${retrySummary}. work-fold saved the partial response and completed activity below.`
    : `The model stopped responding${retrySummary}, and work-fold could not save the partial response.`;
}

function assistantFailureReason(error: unknown): "provider_error" | "setup_error" | "assistant_error" {
  if (error instanceof PiTurnFailure) return "provider_error";
  return isModelSetupError(error) ? "setup_error" : "assistant_error";
}

function assistantFailureTranscriptContent(error: unknown, checkpointText = "", cancelled = false): string {
  const checkpoint = checkpointText.trim();
  if (error instanceof PiTurnFailure) {
    return error.partialText || checkpoint || providerCreditFailureDetail(error) || "The model stopped responding before it could finish a response.";
  }
  if (checkpoint) return checkpoint;
  if (cancelled) return "The agent was stopped before it completed a response.";
  return assistantFailurePublicDetail(error);
}

function assistantFailurePublicDetail(error: unknown): string {
  if (error instanceof PiTurnDrainingError) return error.message;
  const creditFailure = providerCreditFailureDetail(error);
  if (creditFailure) return creditFailure;
  if (error instanceof PiTurnFailure) {
    const retrySummary = error.retryAttempts > 0
      ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
      : "";
    return `The model stopped responding${retrySummary}.`;
  }
  if (isModelSetupError(error)) {
    return "The agent isn’t set up yet. Open Settings → AI Models to choose a provider and model, then try again.";
  }
  if (isPiTurnTimeoutError(error)) {
    return `${errorMessage(error)} Raise or clear that limit to let long turns finish.`;
  }
  if (/timed?\s*out|timeout/i.test(errorMessage(error))) {
    return "The agent took too long to respond. Try again when you’re ready.";
  }
  return "The agent couldn’t complete this request. Try again. If it keeps happening, check Settings → AI Models.";
}

/** Preserve the actionable provider status without echoing its raw body, URLs or account data. */
function providerCreditFailureDetail(error: unknown): string | null {
  const message = errorMessage(error);
  const paymentRequired = /^\s*(?:HTTP(?:\/[\d.]+)?\s+)?402\b/i.test(message)
    || /"(?:code|status|statusCode)"\s*:\s*402\b/.test(message);
  if (!paymentRequired) return null;
  return "The model provider reported a credit or billing limit (HTTP 402). Check its available credit or reduce the maximum response length before trying again.";
}

function isModelSetupError(error: unknown): boolean {
  return /api[- ]?key|credential|auth(?:entication|orization)?|no (?:available |configured )?models?|model (?:was )?not (?:found|available|configured)|select (?:a )?model|choose (?:a )?(?:provider|model)|provider .{0,40}(?:not configured|unavailable)/i
    .test(errorMessage(error));
}

async function getClient(
  state: LocalApiState,
  workFolderId: string,
  workFolderRoot: string,
  conversationId: string,
): Promise<PiConversationClient> {
  if (workFolderId === workFoldAgentScopeId) assertWorkFoldAgentInstructionsReady(state);
  const key = clientKey(workFolderId, conversationId);
  rememberWorkFolderRoot(state, workFolderId, workFolderRoot);
  const existing = state.clients.get(key);
  if (existing) return existing;
  // The work-fold agent scope loads personal Pi capabilities and its two app-owned
  // project instructions. It belongs to no work-folder, so work-folder-bound restricted-
  // app proposal and invocation bridges stay disconnected.
  const hostCapabilities = workFolderId === workFoldAgentScopeId
    ? undefined
    : {
        workFolderId,
        restrictedAppProposals: state.restrictedAppProposals,
        restrictedApps: state.restrictedApps,
      };
  // work-folder scopes carry the compact operations guide after their own work-folder
  // instructions (F26); the work-fold agent scope has its own taught text.
  const operationsGuide = workFolderOperationsGuideForScope(workFolderId);
  const client = new PiConversationClient(conversationId, workFolderRoot, state.runtimeProvider, hostCapabilities, {
    ...(operationsGuide ? { operationsGuide } : {}),
  });
  client.on("event", (event: PiChatEvent) => {
    broadcast(state, streamKey(workFolderId, conversationId), assistantEventForRenderer(event));
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
  if (safeEvent.type === "status" && isModelSetupError(safeEvent.message)) {
    return { ...safeEvent, message: "agent setup is needed. Open Settings → AI Models." };
  }
  return safeEvent;
}

async function invalidateWorkFoldClients(state: LocalApiState, workFolderId: string): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${workFolderId}:`)) continue;
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

function optionalBoundedInteger(value: string | null, label: "offset" | "limit" | "offsetBytes" | "lengthBytes"): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  const minimum = label === "limit" ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < minimum) throw badRequest(`${label} is invalid.`);
  return parsed;
}

function capabilityScope(value: unknown): CapabilityScope {
  if (value === undefined || value === null || value === "global") return "global";
  if (value === "project") return "project";
  throw badRequest("Capability scope must be global or project.");
}

async function runHistoryRestore<T>(state: LocalApiState, workFolderId: string, operation: () => Promise<T>): Promise<T> {
  reserveCapabilityMutation(state, workFolderId, "project", workFolderId);
  try {
    return await state.restrictedApps.withHistoryRestoreReservation(workFolderId, async () => {
      const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(workFolderId);
      if (blockers.length) throw httpError(409, blockers[0]!);
      await getWorkFolder(workFolderId);
      return await operation();
    });
  } finally { state.capabilityMutations.delete(workFolderId); }
}

/** Stop is not settled until its accepted turns have actually drained. */
function requestHasUnsettledWork(state: LocalApiState, request: WorkFoldRequestRecord): boolean {
  return [request, ...state.requests.subtree(request.requestId)].some((record) =>
    !isWorkFoldRequestTerminalState(record.state)
    || record.continuationState === "pending"
    || record.turns.some((turn) => turn.state === "accepted" || turn.state === "running"));
}

/** Called with the work-folder's mutation fence held; deletion refuses instead of interrupting work. */
async function runSettledWorkFolderDeletion<T>(state: LocalApiState, workFolderId: string, operation: () => Promise<T>): Promise<T> {
  const assertSettled = () => {
    if (state.requests.list({ workFolderId }).some((request) => requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this work-folder's outstanding work before deleting.");
    }
  };
  assertSettled();
  return state.restrictedApps.withHistoryRestoreReservation(workFolderId, async () => {
    const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(workFolderId);
    if (blockers.length) throw httpError(409, blockers[0]!);
    await getWorkFolder(workFolderId);
    assertSettled();
    return operation();
  });
}

async function runCapabilityMutation<T>(
  state: LocalApiState,
  workFolder: { id: string; workFolderRoot: string },
  scope: CapabilityScope,
  operation: () => Promise<T>,
  options: { requireProjectTrust?: boolean } = {},
): Promise<T> {
  const key = scope === "global" ? globalCapabilityMutationKey : workFolder.id;
  reserveCapabilityMutation(state, workFolder.id, scope, key);
  try {
    if (
      scope === "project"
      && options.requireProjectTrust !== false
      && !await isPiProjectMutationTrusted(workFolder.workFolderRoot, state.runtimeProvider)
    ) {
      throw forbidden("Trust this work-folder before changing work-folder-scoped capabilities.");
    }
    const result = await operation();
    if (scope === "global") await invalidateAllClients(state);
    else await invalidateWorkFoldClients(state, workFolder.id);
    publishControlHint(state, "models");
    return result;
  } finally {
    state.capabilityMutations.delete(key);
  }
}

async function runRestrictedAppMutation<T>(
  state: LocalApiState,
  workFolderId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCapabilityMutation(state, workFolderId, "project", workFolderId);
  try {
    await revalidateRestrictedAppWorkFolder(state, workFolderId);
    const result = await operation();
    await invalidateWorkFoldClients(state, workFolderId);
    return result;
  } finally {
    state.capabilityMutations.delete(workFolderId);
  }
}

/**
 * Runs an app mutation from inside a work-folder turn's own tool call. Other
 * capability work in the work-folder is awaited rather than refused (a fence that
 * would refuse a short wait prefers queueing), the work-folder lane is held exactly
 * as runRestrictedAppMutation holds it, and the proposing turn's own Pi
 * client is never stopped mid-turn: it is marked for a rebuild when the turn
 * settles so the next turn sees the new app's tools.
 */
async function runRestrictedAppMutationFromTurn<T>(
  state: LocalApiState,
  workFolderId: string,
  ownTurnKey: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + 10 * 60_000;
  while (
    state.capabilityMutations.has(globalCapabilityMutationKey)
    || state.capabilityMutations.has(workFolderId)
    || hasActiveCapabilityWorkForWorkFolder(state, workFolderId, ownTurnKey)
  ) {
    if (signal?.aborted || !state.acceptingTurns) throw new Error("The turn stopped before the app could be added.");
    if (Date.now() > deadline) throw new Error("Other work in this work-folder did not finish in time. Try again from Apps.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  state.capabilityMutations.add(workFolderId);
  try {
    await revalidateRestrictedAppWorkFolder(state, workFolderId);
    const result = await operation();
    for (const [key, client] of [...state.clients]) {
      if (!key.startsWith(`${workFolderId}:`)) continue;
      if (key === ownTurnKey && state.runningTurns.has(ownTurnKey)) { state.clientsToRefresh.add(key); continue; }
      await client.stop().catch(() => undefined);
      state.clients.delete(key);
    }
    return result;
  } finally {
    state.capabilityMutations.delete(workFolderId);
  }
}

async function recoverPendingWorkFolderRemovals(
  restrictedApps: RestrictedAppService,
  restrictedAppProposals: RoutedRestrictedAppProposalHost,
  io: Partial<WorkFolderRemovalIo>,
  recentlyDeleted: WorkFoldRecentlyDeletedStore,
): Promise<{ workFolderRoots: string[]; workFolderIds: string[] }> {
  const pendingRemovals = await listPendingWorkFolderRemovals();
  for (const pending of pendingRemovals) {
    try {
      let intent = pending;
      // An interrupted managed deletion finishes into Recently deleted, not
      // into an erase: the folder this start finds claimed is still the
      // person's (docs/receipts-not-gates.md, F20).
      const removalIo = managedWorkFolderRemovalIo(recentlyDeleted, io, {
        workFolderId: intent.workFolderId,
        workFolderRoot: intent.workFolderRoot,
        receiptId: null,
        managedDeletion: intent.storage === "managed" && intent.folderDisposition !== "preserve",
      });
      if (intent.phase === "requested") {
        await restrictedApps.removeWorkFolder(intent.workFolderId);
        await restrictedAppProposals.removeWorkFolder(intent.workFolderId);
        intent = await markWorkFolderRemovalAppStateRemoved(intent.workFolderId, removalIo.io);
      }
      // The durable removal intent must remain until Check authority is gone.
      // This removal-only path never parses possibly damaged/future state.
      await purgeWorkFoldCheckState(intent.workFolderId);
      await finalizeWorkFolderRemoval(intent.workFolderId, removalIo.io);
    } catch {
      // The durable intent keeps this work-folder hidden and untrusted. Recovery of
      // other work-folders and normal startup can proceed; a later startup retries it.
    }
  }
  return {
    workFolderRoots: pendingRemovals.map((intent) => intent.workFolderRoot),
    workFolderIds: pendingRemovals.map((intent) => intent.workFolderId),
  };
}

async function runRestrictedAppMutations<T>(
  state: LocalApiState,
  workFolderIds: readonly string[],
  operation: () => Promise<T>,
  options: { requiredWorkFolderIds?: readonly string[] } = {},
): Promise<T> {
  const ids = [...new Set(workFolderIds)].sort();
  if (ids.length === 0) throw badRequest("A work-folder is required for this App change.");
  const requiredWorkFolderIds = [...new Set(options.requiredWorkFolderIds ?? ids)].sort();
  if (requiredWorkFolderIds.length === 0 || requiredWorkFolderIds.some((workFolderId) => !ids.includes(workFolderId))) {
    throw new Error("Restricted App mutation validation must name one or more reserved work-folders.");
  }
  if (state.capabilityMutations.has(globalCapabilityMutationKey)
    || ids.some((workFolderId) => state.capabilityMutations.has(workFolderId))) {
    throw httpError(409, "Wait for the current capability change to finish.");
  }
  if (ids.some((workFolderId) => hasActiveCapabilityWorkForWorkFolder(state, workFolderId))) {
    throw httpError(409, "Wait for affected work to finish before changing capabilities.");
  }
  for (const workFolderId of ids) state.capabilityMutations.add(workFolderId);
  try {
    for (const workFolderId of requiredWorkFolderIds) {
      await revalidateRestrictedAppWorkFolder(state, workFolderId);
    }
    const result = await operation();
    await Promise.all(ids.map((workFolderId) => invalidateWorkFoldClients(state, workFolderId)));
    return result;
  } finally {
    for (const workFolderId of ids) state.capabilityMutations.delete(workFolderId);
  }
}

async function revalidateRestrictedAppWorkFolder(state: LocalApiState, workFolderId: string): Promise<void> {
  await state.beforeRestrictedAppWorkFolderRevalidation?.(workFolderId);
  await getWorkFolder(workFolderId);
}

function reserveCapabilityMutation(
  state: LocalApiState,
  workFolderId: string,
  scope: CapabilityScope,
  key: string,
): void {
  const mutationConflict = scope === "global"
    ? state.capabilityMutations.size > 0
    : state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(workFolderId);
  if (mutationConflict) throw httpError(409, "Wait for the current capability change to finish.");

  const runningConflict = scope === "global"
    ? state.runningTurns.size > 0 || state.compactingConversations.size > 0 || state.checkRunReservations.size > 0 || state.checks.hasActiveRun()
    : hasActiveCapabilityWorkForWorkFolder(state, workFolderId);
  if (runningConflict) {
    throw httpError(409, "Wait for affected agent work to finish before changing capabilities.");
  }
  state.capabilityMutations.add(key);
}

function assertNoCapabilityMutationForTurn(state: LocalApiState, workFolderId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(workFolderId)) {
    throw httpError(409, "Wait for the current capability change to finish before starting a turn.");
  }
}

function assertNoCapabilityMutationForCheck(state: LocalApiState, workFolderId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(workFolderId)) {
    throw new WorkFoldCliError("conflict", "Wait for the current capability change to finish before running or changing Checks.");
  }
}

function reserveCheckOperation(state: LocalApiState, workFolderId: string): void {
  assertNoCapabilityMutationForCheck(state, workFolderId);
  if (state.checkRunReservations.has(workFolderId)) {
    throw new WorkFoldCliError("conflict", "Wait for the current Check operation to finish.");
  }
  state.checkRunReservations.add(workFolderId);
}

async function runReservedCheckOperation<T>(
  state: LocalApiState,
  workFolderId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCheckOperation(state, workFolderId);
  try {
    return await operation();
  } finally {
    state.checkRunReservations.delete(workFolderId);
  }
}

async function runCheckWorkFolderRegistryMutation<T>(state: LocalApiState, operation: () => Promise<T>): Promise<T> {
  const release = state.checks.tryReserveWorkFolderRegistryMutation();
  if (!release) throw httpError(409, "Wait for current Check work to finish before changing registered work-folders.");
  try {
    return await operation();
  } finally {
    release();
  }
}

function hasActiveCapabilityWorkForWorkFolder(state: LocalApiState, workFolderId: string, exceptTurnKey?: string): boolean {
  const prefix = `${workFolderId}:`;
  return [...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix) && key !== exceptTurnKey)
    || state.checkRunReservations.has(workFolderId)
    || state.checks.hasActiveRun(workFolderId);
}

// ---------------------------------------------------------------------------
// Fold wiring: the prepared-act fence and adapters, the automation executor's
// hop ports, the publication key fallback, and the overview's live-registry
// source readers. All of it is constructed by startLocalApi over the same shared
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
function capabilityGlobalMutationScope(): { id: string; workFolderRoot: string } {
  return { id: workFoldAgentScopeId, workFolderRoot: workFoldAgentRoot() };
}

// ---------------------------------------------------------------------------
// Prepared acts (docs/receipts-not-gates.md, F19; verb rows in
// docs/act-ledger.md). The facade composes each act's typed parameters
// and pins from live state and runs it at once through the prepared-act
// executor. The helpers below are the shared plumbing: error translation
// into the CLI's typed vocabulary, attribution from the validated management
// lineage, and the automation enablement path Settings and the act lane share.
// ---------------------------------------------------------------------------

/** Publication route refusals, with the store's typed code preserved. */
function sendPublicationError(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkFoldPublicationError) {
    const status = error.code === "INPUT_INVALID" || error.code === "WIDEN_REFUSED" || error.code === "SOURCE_INVALID"
      ? 400
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "ALREADY_REVOKED" || error.code === "ALREADY_SHARED" || error.code === "PUBLICATION_CAP" || error.code === "KEY_MISSING"
          ? 409
          : error.code === "STORE_DAMAGED" || error.code === "JOURNAL_UNAVAILABLE"
            ? 503
            : 500;
    sendJson(res, { error: error.message, code: error.code }, status);
    return;
  }
  sendError(res, error);
}

/**
 * Attribution the prepared-act verbs thread into automation grants and
 * publication receipts: the initiating surface plus, when the work-fold agent
 * request behind the act arrived through Web Access, the paired browser
 * identity (docs/receipts-not-gates.md, F19; docs/shared-pages.md).
 */
function preparedActAttribution(
  state: LocalApiState,
  surface: WorkFoldCliActSurface,
  parentTaskId?: string,
): PreparedActAttribution {
  const record = parentTaskId ? state.requests.byTaskId(parentTaskId) : null;
  return {
    surface,
    ...(record?.remote
      ? { browserId: record.remote.principalId, grantId: record.remote.grantId }
      : {}),
  };
}

/**
 * The act executor's lineage resolution: an explicitly named management
 * parent is valid while its turn is active, and when that request arrived
 * through Remote access the browser identity rides along so the accepted and
 * terminal receipts name the browser that caused the act.
 */
function resolveWorkFoldAgentLineageParent(
  state: LocalApiState,
  taskId: string,
): { taskId: string; browserId?: string; grantId?: string } | null {
  if (!state.requests.isAccepting(taskId)) return null;
  const record = state.requests.byTaskId(taskId);
  return {
    taskId,
    ...(record?.remote
      ? { browserId: record.remote.principalId, grantId: record.remote.grantId }
      : {}),
  };
}

function mapPreparedActError(error: PreparedActError): WorkFoldCliError {
  switch (error.code) {
    case "KIND_UNKNOWN":
    case "INPUT_INVALID":
      return new WorkFoldCliError("usage", error.message, { cause: error });
    case "PIN_MISMATCH":
      return new WorkFoldCliError("conflict", error.message, { cause: error });
    default:
      return new WorkFoldCliError("unavailable", error.message, { cause: error });
  }
}

async function runPreparedActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PreparedActError) throw mapPreparedActError(error);
    throw error;
  }
}

/**
 * The shared automation enablement door for the act lane and trusted desktop
 * Settings (docs/automations.md): normalize the declaration, check the
 * one-time horizon, verify the pinned digest and that every referenced
 * work-folder is registered, then run the `automation.enable` prepared act with the
 * normalized declaration as execution context. Keeping this outside the
 * act-facade closure prevents Settings from growing a second, subtly
 * different enablement path.
 */
async function enableStoredAutomationDeclaration(
  state: LocalApiState,
  declaration: WorkFoldAutomationDeclaration,
  digest: string,
  context: {
    surface: WorkFoldCliActSurface;
    parentTaskId?: string;
    requestId?: string;
  },
): Promise<{
  automationId: string;
  declarationDigest: string;
  title: string;
  referencedWorkFolderIds: string[];
  health: "enabled";
  enabledAt: string;
  /** True when this exact declaration was already on, so nothing changed. */
  alreadyEnabled: boolean;
  /** A run that was executing the previous declaration and was stopped. */
  stoppedRunId: string | null;
}> {
  const normalized = normalizeWorkFoldAutomationDeclaration(declaration);
  try {
    assertWorkFoldAutomationAtAdmissionHorizon(normalized, new Date());
  } catch (error) {
    throw new WorkFoldCliError("conflict", errorMessage(error), { cause: error });
  }
  const actualDigest = workFoldAutomationDigest(normalized);
  if (actualDigest !== digest) {
    throw new WorkFoldCliError(
      "conflict",
      "The automation declaration no longer matches its digest; nothing was enabled.",
    );
  }
  const referencedWorkFolderIds = workFoldAutomationReferencedWorkFolderIds(normalized);
  for (const workFolderId of referencedWorkFolderIds) {
    const registered = await getWorkFolder(workFolderId).catch(() => null);
    if (!registered) {
      throw new WorkFoldCliError(
        "conflict",
        `The Automation references a work-folder that is not registered on this machine (${workFolderId}).`,
      );
    }
  }
  const requestId = context.requestId?.trim() || randomUUID();
  const before = await runActOperation(() => state.automations.getAutomation(normalized.id));
  const alreadyEnabled = before?.health === "enabled" && before.digest === digest;
  const automationContext: AutomationEnableContext = {
    declaration: normalized,
    requestId,
    attribution: preparedActAttribution(state, context.surface, context.parentTaskId),
  };
  await runActOperation(() => runPreparedActOperation(async () => {
    const act = prepareAct({
      kind: "automation.enable",
      parameters: { automationId: normalized.id },
      pins: { automationId: normalized.id, declarationDigest: digest },
    });
    await state.preparedActs.run({ act, requestId, context: automationContext });
  }));
  const record = automationContext.outcome;
  return {
    automationId: normalized.id,
    declarationDigest: digest,
    title: normalized.title,
    referencedWorkFolderIds,
    health: "enabled",
    enabledAt: record?.grants[record.grants.length - 1]?.enabledAt ?? new Date().toISOString(),
    alreadyEnabled,
    // Enabling a changed declaration stops the run still executing the prior
    // one: revocation stops stale work before the change reads as complete.
    stoppedRunId: !alreadyEnabled && before?.activeRunId !== undefined ? before.activeRunId : null,
  };
}

/**
 * Reads one inert typed automation file — a proposal or a full declaration —
 * and normalizes it into the declaration enablement will verify. A proposal
 * gains a deterministic content-derived automation id, so identical content
 * always names one automation.
 */
async function readAutomationStagingFile(
  proposalPath: string,
  cwd: string,
): Promise<{ declaration: WorkFoldAutomationDeclaration; digest: string }> {
  const path = isAbsolute(proposalPath) ? resolve(proposalPath) : resolve(cwd, proposalPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readWorkFoldAutomationDocument(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || errorMessage(error).includes("ordinary file")) {
      throw new WorkFoldCliError("notFound", "The automation proposal must be a regular file on this machine.", { cause: error });
    }
    throw new WorkFoldCliError("usage", `The automation proposal is not readable JSON: ${errorMessage(error)}`, { cause: error });
  }
  const kind = (parsed as { kind?: unknown } | null)?.kind;
  try {
    if (kind === workFoldAutomationProposalKind) {
      return contentAddressedWorkFoldAutomationDeclaration(normalizeWorkFoldAutomationProposal(parsed));
    }
    if (kind === workFoldAutomationDeclarationKind) {
      const declaration = normalizeWorkFoldAutomationDeclaration(parsed);
      return { declaration, digest: workFoldAutomationDigest(declaration) };
    }
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
  throw new WorkFoldCliError(
    "usage",
    `The file is not a typed automation proposal (${workFoldAutomationProposalKind}) or declaration (${workFoldAutomationDeclarationKind}); nothing else is accepted.`,
  );
}

/**
 * Enumerates a skill bundle's SKILL.md names for the act's result and
 * receipt without installing anything, on the import path's own bounds.
 * Digest equality remains the whole identity recheck at effect time; these
 * names are derived from the exact inspected bytes.
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
 * The inspected resource summary a package install or update pins and
 * reports. Extensions and install scripts are named for what they are —
 * code that runs as you — exactly as the desktop review does.
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
 * The one share-a-page path (docs/shared-pages.md, rung 2) behind both
 * `pages share` on the act lane and Settings' share route from a file tab:
 * the same title bound, the same refusal when this desktop has no address
 * to serve at, the same source verification and already-shared refusal, and
 * the same `publish.viewer.expose` prepared act — pins rechecked at effect
 * time, activation journaled under `<request>:activate`. The caller owns the
 * outer receipt: the act protocol on the act lane, the Settings act wrapper
 * on the desktop. Returns the activated publication view.
 */
async function sharePageFromDesktop(
  state: LocalApiState,
  input: { workFolder: WorkFolderSummary; path: string; title: string; snapshot: boolean },
  context: { surface: WorkFoldCliActSurface; parentTaskId?: string; requestId?: string },
): Promise<WorkFoldPublicationView> {
  const { workFolder } = input;
  const title = input.title.trim();
  if (!title || title.length > WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH || /[\r\n]/.test(title)) {
    throw new WorkFoldCliError(
      "usage",
      `A page title of 1 through ${WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH} characters is required.`,
    );
  }
  const status = state.publications.status();
  if (status.damaged) {
    throw new WorkFoldCliError("failure", `work-fold cannot share a page: ${status.damageReason ?? "the publication store is damaged."}`);
  }
  // No address, no share: the work-fold agent cannot bootstrap web access to publish
  // to it, so the page never exists as a slot nobody can reach. A relay that
  // is merely unreachable is different — the slot stays honestly pending.
  if (!await state.publications.hasAddress()) {
    throw new WorkFoldCliError("conflict", WORKFOLD_PUBLICATION_NO_ADDRESS_MESSAGE);
  }
  const source = await designatedPageSource(workFolder.workFolderRoot, input.path);
  const alreadyShared = (await runActOperation(() => state.publications.activePublicationsForWorkFolder(workFolder.id)))
    .some((view) => view.kind === "page" && view.relativePath === source.relativePath);
  if (alreadyShared) {
    throw new WorkFoldCliError("conflict", "This file is already shared as a page; stop sharing it before sharing it again.");
  }
  const requestId = context.requestId?.trim() || randomUUID();
  const exposeContext: ViewerExposeContext = {
    requestId,
    ...(context.parentTaskId !== undefined ? { parentTaskId: context.parentTaskId } : {}),
    attribution: preparedActAttribution(state, context.surface, context.parentTaskId),
  };
  await runPublicationActOperation(() => runPreparedActOperation(async () => {
    const act = prepareAct({
      kind: "publish.viewer.expose",
      parameters: { exposure: "page", workFolderId: workFolder.id },
      pins: {
        exposure: "page",
        workFolderId: workFolder.id,
        relativePath: source.relativePath,
        title,
        snapshotEnabled: input.snapshot,
        byteBudget: WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT,
        serveBudget: WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT,
      },
    });
    await state.preparedActs.run({ act, requestId, context: exposeContext });
  }));
  if (!exposeContext.outcome) throw new WorkFoldCliError("failure", "The page was not activated.");
  return exposeContext.outcome;
}

/**
 * The act lane's reading of a publication service refusal: an invalid
 * request is a usage error, a missing slot is not found, and a slot that is
 * no longer shared or already at its cap is a conflict.
 */
async function runPublicationActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkFoldPublicationError) {
      const code = error.code === "INPUT_INVALID" || error.code === "WIDEN_REFUSED" || error.code === "SOURCE_INVALID"
        ? "usage"
        : error.code === "NOT_FOUND"
          ? "notFound"
          : error.code === "ALREADY_REVOKED" || error.code === "ALREADY_SHARED" || error.code === "PUBLICATION_CAP"
            ? "conflict"
            : error.code === "STORE_DAMAGED" || error.code === "JOURNAL_UNAVAILABLE"
              ? "unavailable"
              : "failure";
      throw new WorkFoldCliError(code, error.message, { cause: error });
    }
    return await runActOperation(() => Promise.reject(error));
  }
}

/**
 * Source verification for one page exposure, mirroring the publication
 * service's own inspection: the exact normalized relative path the pins
 * carry, an allowed media type, a regular file, and the shareable size bound.
 * The service re-verifies for real at effect time and again at every serve.
 */
async function designatedPageSource(workFolderRoot: string, relativePath: string): Promise<{ relativePath: string; byteSize: number }> {
  let path: string;
  try {
    path = resolveWorkFolderPath(workFolderRoot, relativePath);
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
  // Canonical work-folder-relative form from the resolved path, so identical
  // designations ("./weekly.md", "weekly.md") pin one identity.
  const normalized = relative(resolve(workFolderRoot), path).split(sep).join("/");
  if (!normalized) throw new WorkFoldCliError("usage", "A work-folder-relative file path is required.");
  const extension = extname(normalized).toLowerCase();
  if (!WORKFOLD_PUBLICATION_SOURCE_TYPES[extension]) {
    throw new WorkFoldCliError("usage", "Only Markdown, plain text, HTML, PNG, JPEG, and PDF files can be shared as a page.");
  }
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile()) throw new WorkFoldCliError("notFound", "The designated file does not exist as a regular file.");
  if (info.size > WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES) {
    throw new WorkFoldCliError("usage", "The designated file is larger than a shareable page (8 MiB).");
  }
  return { relativePath: normalized, byteSize: info.size };
}

/**
 * The exact work-folder file an app's single-file permission binds to. The work-folder
 * path policy already refuses an escape, a symlinked segment, and reserved
 * `.work-fold/`, `.pi/`, and `.workspace/` metadata; this adds the one thing
 * a grant root needs on top: the file has to exist as an ordinary file right
 * now. The broker re-verifies the same facts at effect time and on every
 * read, so this is an honest early refusal, not the authority.
 */
async function grantedWorkFolderFile(workFolderRoot: string, relativePath: string): Promise<string> {
  let path: string;
  try {
    path = resolveWorkFolderPath(workFolderRoot, relativePath);
  } catch (error) {
    throw new WorkFoldCliError("usage", errorMessage(error), { cause: error });
  }
  // Canonical work-folder-relative form, so "./notes.md" and "notes.md" bind one root.
  const normalized = relative(resolve(workFolderRoot), path).split(sep).join("/");
  if (!normalized) throw new WorkFoldCliError("usage", "Name the file inside the work-folder that this permission covers.");
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new WorkFoldCliError("notFound", "That file does not exist in this work-folder as an ordinary file.");
  }
  return normalized;
}

/**
 * The prepared-act fence over the exact reservation state the desktop routes
 * use: a work-folder scope reserves with runRestrictedAppMutation semantics, the
 * global scope with runCapabilityMutation's global branch. A busy scope
 * refuses with the routes' own conflict, which the act facade translates into
 * the CLI's typed vocabulary. Project trust checks stay with the calling
 * verbs and the per-kind adapters, mirroring the routes each kind reuses.
 */
function createPreparedActFence(state: LocalApiState): PreparedActFence {
  return {
    run(scope, operation) {
      return scope.scope === "work-folder"
        ? runRestrictedAppMutation(state, scope.workFolderId, operation)
        : runCapabilityMutation(state, capabilityGlobalMutationScope(), "global", operation);
    },
  };
}

/** Attribution a prepared act threads into automation grants and publication receipts. */
interface PreparedActAttribution {
  surface: WorkFoldCliActSurface;
  browserId?: string;
  grantId?: string;
}

/**
 * The execution outcome slot a calling verb reads back after a prepared act
 * ran: the installed app, the removal result, the activated publication. It
 * travels in the executor's `context`, never in a receipt.
 */
/** The Recently deleted entry a destroying verb reports back. */
interface RecentlyDeletedRef {
  entryId: string;
  restoreBy: string;
}

interface PreparedActOutcome<T> {
  outcome?: T;
  /** Stamped by `runPreparedAct`: the journaled request id the act runs under. */
  requestId?: string;
}

interface AutomationEnableContext extends PreparedActOutcome<WorkFoldAutomationRecord> {
  declaration: WorkFoldAutomationDeclaration;
  requestId: string;
  attribution: PreparedActAttribution;
}

interface ViewerExposeContext extends PreparedActOutcome<WorkFoldPublicationView> {
  requestId: string;
  parentTaskId?: string;
  attribution: PreparedActAttribution;
}

/**
 * Per-kind execution adapters for the prepared-act path: each binds one kind
 * to the same domain internals the equivalent desktop action uses. Every
 * admitted kind has an adapter. Each re-observes its pinned identities
 * immediately before executing; both `publish.viewer.expose` shapes likewise
 * re-verify their designated source or installed Release.
 */
function createPreparedActAdapters(state: LocalApiState): PreparedActAdapters {
  return {
    "app.review.install": createAppReviewInstallAdapter(state),
    "app.grant.network": createAppGrantAdapter(state, "app.grant.network"),
    "app.grant.files": createAppGrantAdapter(state, "app.grant.files"),
    "app.grant.notifications": createAppGrantAdapter(state, "app.grant.notifications"),
    "app.automation.enable": createAppAutomationEnableAdapter(state),
    "capability.skills.import": createSkillImportAdapter(state),
    "capability.package.install": createCapabilityPackageAdapter(state, "install"),
    "capability.package.update": createCapabilityPackageAdapter(state, "update"),
    "capability.resource.enabled": resourceEnableAdapter(async (act) => act.parameters.scope === "work-folder" ? (await getWorkFolder(String(act.parameters.workFolderId))).workFolderRoot : workFoldAgentRoot(), state.runtimeProvider),
    "app.connection.save": createAppConnectionSaveAdapter(state),
    "app.data.purge": createAppDataPurgeAdapter(state),
    "app.storage.clear": createAppStorageClearAdapter(state),
    "automation.enable": createAutomationEnableAdapter(state),
    "publish.viewer.expose": createViewerExposeAdapter(state),
    "work-folder.delete-folder": createManagedWorkFolderDeletionAdapter(state),
  };
}

/** The prepared-act pin as bounded text, tolerating the parameter mirror. */
function stringPinValue(act: PreparedAct, name: string): string {
  const value = act.pins[name] ?? act.parameters[name];
  return typeof value === "string" ? value : "";
}

/**
 * `app.review.install` — the digest-checked install path the desktop uses.
 * The proposal host re-verifies the reviewed digest at install time, so a
 * source changed between recheck and execution surfaces as the existing
 * REVISION_CHANGED refusal.
 */
function createAppReviewInstallAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<RestrictedAppInstalled> | undefined> {
  const recheck = async (act: PreparedAct): Promise<string | null> => {
    const proposal = await state.restrictedAppProposals.get(stringPinValue(act, "proposalId"));
    if (!proposal) return "The app review no longer exists; it was removed or superseded.";
    if (proposal.workFolderId !== act.parameters.workFolderId) return "The app review belongs to a different work-folder.";
    if (proposal.review.digest !== act.pins.reviewDigest) {
      return "The reviewed package no longer matches the pinned review; the source changed after review.";
    }
    if (proposal.status === "revision-changed") return "The package changed after review; review the new revision before installing it.";
    if (proposal.status === "dismissed") return "The app review was dismissed.";
    return null;
  };
  return {
    recheckPins: recheck,
    async execute(act, context) {
      const app = await state.restrictedAppProposals.install(stringPinValue(act, "proposalId"));
      if (!app) throw new Error("This app review is no longer available to install.");
      if (context) context.outcome = app;
      return { detail: `Installed ${app.packageName}@${app.version} (digest ${app.digest}).` };
    },
  };
}

type AppGrantKind = "app.grant.network" | "app.grant.files" | "app.grant.notifications";

/**
 * `app.grant.network|files|notifications` — the same grant path agent
 * tools uses, addressed by the pinned App Instance identity and re-verified
 * against the installed digest and the exact reviewed declaration. A file
 * grant binds to the whole work-folder (docs/receipts-not-gates.md, F21).
 */
function createAppGrantAdapter(
  state: LocalApiState,
  kind: AppGrantKind,
): PreparedActAdapter<{ root?: string } | undefined> {
  const resolve = async (act: PreparedAct): Promise<{ app: RestrictedAppInstalled } | { issue: string }> => {
    const app = await state.restrictedApps.findByFeatureInstallation(String(act.parameters.workFolderId), stringPinValue(act, "appInstanceId"));
    if (!app) return { issue: "The App Instance is no longer installed in this work-folder." };
    if ((app.releaseDigest ?? app.digest) !== act.pins.releaseDigest) {
      return { issue: "The installed app no longer matches the pinned release; it changed after the request was prepared." };
    }
    const declarationId = stringPinValue(act, "declarationId");
    const declared = kind === "app.grant.network"
      ? app.manifest.permissions.network.some((item) => item.id === declarationId)
      : kind === "app.grant.files"
        ? app.manifest.permissions.files.some((item) => item.id === declarationId)
        : app.manifest.permissions.notifications.some((item) => item.id === declarationId);
    if (!declared) return { issue: "The app no longer declares this permission." };
    return { app };
  };
  return {
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act, context) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const { app } = resolved;
      const declarationId = stringPinValue(act, "declarationId");
      const base = {
        workFolderId: app.workFolderId,
        appId: app.manifest.id,
        featureInstallationId: app.featureInstallationId,
        expectedDigest: app.digest,
      };
      if (kind === "app.grant.network") {
        await state.restrictedApps.grantNetwork({ ...base, destinationId: declarationId });
        return {
          detail: `Granted network destination "${declarationId}" to ${app.manifest.id}.`,
          undoRef: { kind: "declaration", value: declarationId },
        };
      }
      if (kind === "app.grant.notifications") {
        await state.restrictedApps.grantNotifications({ ...base, permissionId: declarationId });
        return {
          detail: `Granted notification category "${declarationId}" to ${app.manifest.id}.`,
          undoRef: { kind: "declaration", value: declarationId },
        };
      }
      const root = context?.root ?? ".";
      const workFolder = await getWorkFolder(app.workFolderId);
      await state.restrictedApps.grantFiles({ ...base, workFolderRoot: workFolder.workFolderRoot, permissionId: declarationId, root });
      return {
        detail: `Granted work-folder file access "${declarationId}" (root "${root}") to ${app.manifest.id}.`,
        undoRef: { kind: "declaration", value: declarationId },
      };
    },
  };
}

/**
 * `app.automation.enable` — the existing enablement path; runs stay inside
 * the machine-wide scheduler bounds. The reviewed digest and the
 * host-composed schedule summary are pins, so a job whose package or cadence
 * changed since the request was prepared refuses instead of enabling
 * something the receipt never described.
 */
function createAppAutomationEnableAdapter(state: LocalApiState): PreparedActAdapter {
  const resolve = async (act: PreparedAct): Promise<{ app: RestrictedAppInstalled } | { issue: string }> => {
    const app = await state.restrictedApps.findByFeatureInstallation(String(act.parameters.workFolderId), stringPinValue(act, "appInstanceId"));
    if (!app) return { issue: "The App Instance is no longer installed in this work-folder." };
    // Automations bind to the package digest they were reviewed under, the
    // same identity automation run receipts capture.
    if (app.digest !== act.pins.reviewedDigest) {
      return { issue: "The installed package no longer matches the digest this job was reviewed under." };
    }
    const appAutomationId = stringPinValue(act, "appAutomationId");
    const declaration = app.manifest.automations.find((item) => item.id === appAutomationId);
    if (!declaration) return { issue: "The app no longer declares this automation." };
    if (restrictedAppAutomationScheduleSummary(declaration) !== act.pins.scheduleSummary) {
      return { issue: "The job's reviewed schedule changed after the request was prepared." };
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
      const appAutomationId = stringPinValue(act, "appAutomationId");
      await state.restrictedApps.setAppAutomationEnabled({
        workFolderId: app.workFolderId,
        appId: app.manifest.id,
        featureInstallationId: app.featureInstallationId,
        expectedDigest: app.digest,
        appAutomationId,
        enabled: true,
      });
      return {
        detail: `Enabled automation "${appAutomationId}" (${String(act.pins.scheduleSummary)}) for ${app.manifest.id}.`,
        undoRef: { kind: "app-automation", value: appAutomationId },
      };
    },
  };
}

/**
 * `capability.skills.import` — the existing import path, digest-verified: the
 * pinned content digest names the exact inspected bytes, and the enumerated
 * skill names are derived from those bytes, so digest equality is the whole
 * identity recheck. work-folder scope resolves the work-folder's folder; Everywhere scope
 * has no work-folder, so it names the same app-owned neutral root the act facade's
 * Everywhere-scope tools verbs resolve against.
 */
function createSkillImportAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<PiSkillBundleImportResult> | undefined> {
  const loadVerified = async (act: PreparedAct): Promise<
    { bundle: { fileName: string; bytes: Uint8Array } } | { issue: string }
  > => {
    let bundle: { fileName: string; bytes: Uint8Array };
    try {
      bundle = await loadSkillBundleForAct(state, act);
    } catch (caught) {
      return { issue: `The skill bundle could not be re-read: ${errorMessage(caught)}` };
    }
    if (piSkillBundleContentDigest(bundle.bytes) !== act.pins.contentDigest) {
      return { issue: "The skill bundle's content no longer matches the pinned digest; the source changed after it was inspected." };
    }
    return { bundle };
  };
  return {
    async recheckPins(act) {
      const loaded = await loadVerified(act);
      return "issue" in loaded ? loaded.issue : null;
    },
    async execute(act, context) {
      const loaded = await loadVerified(act);
      if ("issue" in loaded) throw new Error(loaded.issue);
      const root = act.parameters.scope === "work-folder"
        ? (await getWorkFolder(String(act.parameters.workFolderId))).workFolderRoot
        : workFoldAgentRoot();
      const result = await importPiSkillBundleVerified(root, {
        fileName: loaded.bundle.fileName,
        bytes: loaded.bundle.bytes,
        scope: act.parameters.scope === "work-folder" ? "project" : "user",
        expectedContentDigest: String(act.pins.contentDigest),
      }, state.runtimeProvider);
      if (context) context.outcome = result;
      const names = result.skills.map((skill) => skill.name).join(", ");
      return {
        detail: `Imported ${result.skills.length === 1 ? "skill" : "skills"} ${names} at ${result.scope === "user" ? "Everywhere" : "This work-folder"} scope.`,
        undoRef: { kind: "skill-bundle-path", value: result.bundlePath },
      };
    },
  };
}

/**
 * Re-reads the exact bundle bytes for `capability.skills.import`. Loading is
 * identity, not trust: the adapter's content-digest recheck decides whether
 * these are the inspected bytes. An absolute path is a file-borne bundle; any
 * other source is an official catalog bundle id, rebuilt through the same
 * registry path the desktop install uses and then digest-checked like every
 * other reload.
 */
async function loadSkillBundleForAct(
  state: LocalApiState,
  act: PreparedAct,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const source = String(act.pins.source ?? act.parameters.source ?? "").trim();
  if (!source) throw new Error("the bundle source is missing");
  if (!isAbsolute(source)) {
    const bundle = await state.capabilityRegistry.buildOfficialSkillBundle(source);
    return { fileName: bundle.fileName, bytes: bundle.bytes };
  }
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("the bundle source must be a regular file");
  }
  return { fileName: basename(source), bytes: await readFile(source) };
}

/**
 * `capability.package.install|update` — the same capability-mutation
 * internals as the desktop package routes, executed inside the fence's
 * reservation (work-folder scope for a work-folder-scoped package, global for Everywhere
 * scope) instead of reserving twice. Project trust is rechecked at effect
 * time so an untrusted work-folder refuses instead of loading code.
 */
function createCapabilityPackageAdapter(
  state: LocalApiState,
  operation: "install" | "update",
): PreparedActAdapter {
  const scopeOf = (act: PreparedAct): "everywhere" | "work-folder" =>
    (act.pins.scope ?? act.parameters.scope) === "work-folder" ? "work-folder" : "everywhere";
  const workFolderOf = async (act: PreparedAct): Promise<WorkFolderSummary | null> => {
    const workFolderId = act.parameters.workFolderId;
    if (typeof workFolderId !== "string") return null;
    try {
      return await getWorkFolder(workFolderId);
    } catch {
      return null;
    }
  };
  return {
    async recheckPins(act) {
      if (scopeOf(act) !== "work-folder") return null;
      const workFolder = await workFolderOf(act);
      if (!workFolder) return "The work-folder is no longer registered.";
      return await isPiProjectMutationTrusted(workFolder.workFolderRoot, state.runtimeProvider)
        ? null
        : "Trust this work-folder before changing work-folder-scoped capabilities.";
    },
    async execute(act) {
      const scope = scopeOf(act);
      const workFolder = scope === "work-folder" ? await workFolderOf(act) : null;
      if (scope === "work-folder" && !workFolder) throw new Error("The work-folder is no longer registered.");
      const root = workFolder?.workFolderRoot ?? workFoldAgentRoot();
      const source = String(act.pins.source);
      const piScope = scope === "work-folder" ? "project" as const : "user" as const;
      if (operation === "install") {
        await installPiPackage(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      } else {
        await updatePiPackages(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      }
      return {
        detail: `${operation === "install" ? "Installed" : "Updated"} ${String(act.pins.packageId)}@${String(act.pins.version)} `
          + `from ${source} at ${piScope === "user" ? "Everywhere" : "This work-folder"} scope.`,
        undoRef: { kind: "package-source", value: source },
      };
    },
  };
}

/**
 * `app.connection.save` — opens the existing host connection flow scoped to
 * the pinned declaration. Only the browser OAuth flow can run without a
 * person typing a secret, so form-credential shapes refuse: the secret is
 * entered in Settings → Apps, never through the work-fold agent, and the act carries only
 * the connection's shape.
 */
function createAppConnectionSaveAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<RestrictedAppConnectionStatus> | undefined> {
  const targetLabel = (target: { kind: string; origin?: string; host?: string; port?: number }): string =>
    target.kind === "public-https" ? String(target.origin) : `http://${String(target.host)}:${String(target.port)}`;
  const resolve = async (act: PreparedAct): Promise<
    | { issue: string }
    | { app: RestrictedAppInstalled; destination: RestrictedAppNetworkDeclaration }
  > => {
    const app = await state.restrictedApps.findByFeatureInstallation(String(act.parameters.workFolderId), stringPinValue(act, "appInstanceId"));
    if (!app) return { issue: "The App Instance is no longer installed in this work-folder." };
    const declarationId = String(act.pins.declarationId);
    const destination = app.manifest.permissions.network.find((item) => item.id === declarationId);
    if (!destination) return { issue: "The app no longer declares this connection destination." };
    if (targetLabel(destination.target) !== act.pins.target) {
      return { issue: "The destination's reviewed target changed after the request was prepared." };
    }
    if (!destination.auth.some((item) => item.kind === act.pins.adapterKind)) {
      return { issue: "The destination no longer declares the pinned credential adapter." };
    }
    if (act.pins.adapterKind !== "oauth2-pkce") {
      return { issue: "This destination takes a secret typed on the desktop. Connect it from Settings → Apps." };
    }
    return { app, destination };
  };
  return {
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act, context) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const connection = await state.restrictedApps.connectOAuth({
        workFolderId: resolved.app.workFolderId,
        appId: resolved.app.manifest.id,
        destinationId: resolved.destination.id,
        expectedDigest: resolved.app.digest,
      });
      if (context) context.outcome = connection;
      return {
        detail: `Connected ${resolved.app.manifest.id} to ${String(act.pins.target)} through the browser sign-in flow.`,
        undoRef: { kind: "declaration", value: resolved.destination.id },
      };
    },
  };
}

function createAppStorageClearAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<{ remainingBytes: number; recentlyDeleted: RecentlyDeletedRef | null }> | undefined> {
  const resolve = async (act: PreparedAct): Promise<
    | { issue: string }
    | { app: RestrictedAppInstalled; observedBytes: number }
  > => {
    const workFolderId = String(act.parameters.workFolderId);
    const app = await state.restrictedApps.findByFeatureInstallation(workFolderId, stringPinValue(act, "appInstanceId"));
    if (!app) return { issue: "The App Instance is no longer installed in this work-folder." };
    const namespaces = act.pins.dataNamespaceIds;
    if (!Array.isArray(namespaces) || namespaces.length !== 1 || namespaces[0] !== app.dataNamespaceId) {
      return { issue: "The app's Data Namespace no longer matches the pinned storage identity." };
    }
    try {
      const usage = await state.restrictedApps.storageUsage(workFolderId, app.manifest.id, app.digest, app.featureInstallationId);
      if (usage.usageBytes !== act.pins.observedBytes) {
        return { issue: `The app's live storage changed after the request was prepared (${String(act.pins.observedBytes)} → ${usage.usageBytes} bytes).` };
      }
      return { app, observedBytes: usage.usageBytes };
    } catch (error) {
      return { issue: errorMessage(error) };
    }
  };
  return {
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act, context) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      // The copy lands in Recently deleted before the live data goes
      // (docs/receipts-not-gates.md, F20).
      const entry = await moveAppStorageExportToRecentlyDeleted(state, resolved.app, "apps.storage.clear", context?.requestId ?? null);
      const cleared = await state.restrictedApps.clearStorage(
        resolved.app.workFolderId,
        resolved.app.manifest.id,
        resolved.app.digest,
        resolved.app.featureInstallationId,
      );
      if (context) context.outcome = { remainingBytes: cleared.usageBytes, recentlyDeleted: entry ? { entryId: entry.id, restoreBy: entry.restoreBy } : null };
      return {
        detail: `Cleared ${resolved.observedBytes} bytes of live storage; ${cleared.usageBytes} bytes remain`
          + `${entry ? `; a copy is in Recently deleted as ${entry.id}` : ""}.`,
        ...(entry ? { undoRef: { kind: "recently-deleted-entry", value: entry.id } } : {}),
      };
    },
  };
}

function createAppDataPurgeAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<{ cleanupPending: boolean; recentlyDeleted: RecentlyDeletedRef[] }> | undefined> {
  type PurgeResolution =
    | { issue: string }
    | { target: "retained"; retainedDataId: string; namespaceId: string }
    | { target: "runtime-instance"; runtimeInstanceId: string; namespaceId: string };
  const resolve = async (act: PreparedAct): Promise<PurgeResolution> => {
    const target = act.parameters.purgeTarget;
    const namespaceIds = act.pins.dataNamespaceIds;
    if (!Array.isArray(namespaceIds) || namespaceIds.length !== 1) {
      return { issue: "This purge must pin exactly one Data Namespace." };
    }
    const namespaceId = namespaceIds[0]!;
    if (target === "retained") {
      const sourceWorkFolderId = String(act.pins.sourceWorkFolderId ?? act.parameters.workFolderId);
      const retainedDataId = String(act.pins.retainedDataId ?? "");
      const studio = await state.restrictedApps.localAppStudio(sourceWorkFolderId).catch(() => null);
      const retained = studio?.retainedData.find((item) => item.retainedDataId === retainedDataId);
      if (!retained) return { issue: "The retained App data record no longer exists." };
      if (retained.featureInstallationId !== act.pins.appInstanceId || retained.dataNamespaceId !== namespaceId) {
        return { issue: "The retained App data identity changed after the request was prepared." };
      }
      return { target, retainedDataId, namespaceId };
    }
    if (target === "runtime-instance") {
      const workFolderId = String(act.parameters.workFolderId);
      const runtimeInstanceId = String(act.pins.runtimeInstanceId ?? "");
      const installed = (await state.restrictedApps.list(workFolderId)).find((app) => (
        app.runtimeInstanceKind === "app" && app.runtimeInstanceId === runtimeInstanceId
      ));
      if (!installed) return { issue: "The Local App Instance is no longer installed." };
      if (installed.featureInstallationId !== act.pins.appInstanceId || installed.dataNamespaceId !== namespaceId) {
        return { issue: "The Local App Instance data identity changed after the request was prepared." };
      }
      if (act.pins.sourceWorkFolderId !== undefined && installed.sourceWorkFolderId !== act.pins.sourceWorkFolderId) {
        return { issue: "The Local App Instance source work-folder changed after the request was prepared." };
      }
      return { target, runtimeInstanceId, namespaceId };
    }
    return { issue: "This purge does not identify whether it targets retained data or an installed App Instance." };
  };
  return {
    fenceScope: () => ({ scope: "global" }),
    async recheckPins(act) {
      const resolved = await resolve(act);
      return "issue" in resolved ? resolved.issue : null;
    },
    async execute(act, context) {
      const resolved = await resolve(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const receiptId = context?.requestId ?? null;
      if (resolved.target === "retained") {
        // A copy of the retained record lands in Recently deleted before the
        // namespace goes (docs/receipts-not-gates.md, F20).
        const sourceWorkFolderId = String(act.pins.sourceWorkFolderId ?? act.parameters.workFolderId);
        const studio = await state.restrictedApps.localAppStudio(sourceWorkFolderId);
        const record = studio.retainedData.find((item) => item.retainedDataId === resolved.retainedDataId);
        if (!record) throw new Error("The retained App data record disappeared before execution.");
        const entry = await moveRetainedExportToRecentlyDeleted(state, sourceWorkFolderId, record, "apps.retained.purge", receiptId);
        const result = await state.restrictedApps.purgeLocalAppRetainedData(resolved.retainedDataId);
        if (!result.purged) throw new Error("The retained App data record disappeared before execution.");
        if (context) context.outcome = { cleanupPending: result.cleanupPending, recentlyDeleted: [{ entryId: entry.id, restoreBy: entry.restoreBy }] };
        return {
          detail: `Purged Data Namespace ${resolved.namespaceId}; a copy is in Recently deleted as ${entry.id}`
            + `${result.cleanupPending ? "; secure cleanup is pending" : ""}.`,
          undoRef: { kind: "recently-deleted-entry", value: entry.id },
        };
      }
      const entries = await moveUninstallPurgeExportsToRecentlyDeleted(
        state,
        resolved.runtimeInstanceId,
        [String(act.parameters.workFolderId), String(act.pins.sourceWorkFolderId ?? act.parameters.workFolderId)],
        receiptId,
      );
      const result = await state.restrictedApps.uninstallLocalApp({
        runtimeInstanceId: resolved.runtimeInstanceId,
        dataDisposition: "purge",
      });
      if (!result.removed) throw new Error("The Local App Instance disappeared before execution.");
      if (context) {
        context.outcome = {
          cleanupPending: result.cleanupPending,
          recentlyDeleted: entries.map((entry) => ({ entryId: entry.id, restoreBy: entry.restoreBy })),
        };
      }
      return {
        detail: `Uninstalled ${resolved.runtimeInstanceId} and purged its data`
          + `${entries.length ? `; ${entries.length} cop${entries.length === 1 ? "y is" : "ies are"} in Recently deleted` : ""}`
          + `${result.cleanupPending ? "; secure cleanup is pending" : ""}.`,
        ...(entries[0] ? { undoRef: { kind: "recently-deleted-entry", value: entries[0].id } } : {}),
      };
    },
  };
}

/**
 * `automation.enable` — the enablement receipt of docs/automations.md. The
 * normalized declaration arrives as execution context from the calling verb,
 * is re-verified against the pinned digest and automation id, and every
 * referenced work-folder must still be registered. Execution commits the
 * declaration and the exact-authority grant through the automation service with
 * the act's request id as the grant identity; the store itself re-refuses a
 * declaration that no longer hashes to the pinned digest, and enabling an
 * identical already-enabled declaration changes nothing.
 */
function createAutomationEnableAdapter(state: LocalApiState): PreparedActAdapter<AutomationEnableContext | undefined> {
  const verify = async (act: PreparedAct, context: AutomationEnableContext | undefined): Promise<string | null> => {
    const declaration = context?.declaration;
    if (!declaration) return "The automation declaration to enable was not supplied.";
    if (workFoldAutomationDigest(declaration) !== act.pins.declarationDigest) {
      return "The automation declaration no longer hashes to the digest this act pinned.";
    }
    if (declaration.id !== act.pins.automationId) return "The declaration names a different automation than this act pinned.";
    for (const workFolderId of workFoldAutomationReferencedWorkFolderIds(declaration)) {
      const registered = await getWorkFolder(workFolderId).catch(() => null);
      if (!registered) return `The automation references a work-folder that is no longer registered (${workFolderId}).`;
    }
    return null;
  };
  return {
    // Enablement is an automation-store commit under its own serialization; it
    // mutates no capability state, so it reserves no capability fence.
    fenceScope: () => null,
    recheckPins: verify,
    async execute(act, context) {
      const issue = await verify(act, context);
      if (issue || !context) throw new Error(issue ?? "The automation declaration to enable was not supplied.");
      const { attribution } = context;
      const record = await state.automations.enable({
        declaration: context.declaration,
        expectedDigest: String(act.pins.declarationDigest),
        grant: {
          requestId: context.requestId,
          surface: attribution.surface,
          ...(attribution.surface === "remote_web" && attribution.browserId !== undefined ? { browserId: attribution.browserId } : {}),
        },
      });
      context.outcome = record;
      // The service returns the untouched record when this exact declaration
      // was already on. Nothing changed, so the receipt says so and offers no
      // undo reference for a state this call did not create.
      if (record.grants[record.grants.length - 1]?.requestId !== context.requestId) {
        return {
          detail: `Automation "${record.declaration.title}" (${record.declaration.id}) was already on at digest ${record.digest}; nothing changed.`,
        };
      }
      return {
        detail: `Enabled automation "${record.declaration.title}" (${record.declaration.id}) at digest ${record.digest}.`,
        undoRef: { kind: "automation-id", value: record.declaration.id },
      };
    },
  };
}

/**
 * `publish.viewer.expose` — the activation paths of docs/shared-pages.md,
 * executed with the initiating surface and browser identity threaded into
 * the publication service's own journaled act context under a derived
 * request id (`<request>:activate`). Page exposure re-verifies the
 * designated source; hosted-app exposure (rung 3) re-resolves the pinned App
 * Instance and requires the exact pinned Release digest and viewer surface —
 * an app that updated or widened its viewer surface after the request was
 * prepared refuses instead of exposing something the receipt never named.
 */
function createViewerExposeAdapter(state: LocalApiState): PreparedActAdapter<ViewerExposeContext | undefined> {
  const recheckPage = async (act: PreparedAct): Promise<string | null> => {
    const workFolder = await getWorkFolder(String(act.pins.workFolderId)).catch(() => null);
    if (!workFolder) return "The work-folder is no longer registered.";
    try {
      const source = await designatedPageSource(workFolder.workFolderRoot, String(act.pins.relativePath));
      if (source.relativePath !== act.pins.relativePath) {
        return "The designated file's normalized path no longer matches the pinned path.";
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  };
  const resolveHostedApp = async (act: PreparedAct): Promise<
    | { exposure: Extract<Awaited<ReturnType<RestrictedAppViewerAdapter["resolveExposure"]>>, { eligible: true }> }
    | { issue: string }
  > => {
    const exposure = await state.restrictedAppViewer.resolveExposure(stringPinValue(act, "appInstanceId"));
    if (!exposure.eligible) return { issue: exposure.issue };
    if (exposure.pins.releaseDigest !== act.pins.releaseDigest) {
      return { issue: "The installed Release no longer matches the pinned digest; the app updated after the request was prepared." };
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
    async execute(act, context) {
      if (!context) throw new Error("The exposure's act context was not supplied.");
      const { attribution } = context;
      const activation = {
        // A distinct derived request id: the act lane owns `<request>`, and
        // the activation journals its own accepted/terminal pair under the
        // same single-use identity family.
        requestId: `${context.requestId}:activate`,
        surface: attribution.surface,
        ...(context.parentTaskId !== undefined ? { parentTaskId: context.parentTaskId } : {}),
        ...(attribution.browserId !== undefined ? { browserId: attribution.browserId } : {}),
        ...(attribution.grantId !== undefined ? { grantId: attribution.grantId } : {}),
      };
      if (act.pins.exposure === "page") {
        const view = await state.publications.activate({
          workFolderId: String(act.pins.workFolderId),
          relativePath: String(act.pins.relativePath),
          title: String(act.pins.title),
          serveRatePerMinute: Number(act.pins.serveBudget),
          byteBudgetPerDay: Number(act.pins.byteBudget),
          snapshotEnabled: act.pins.snapshotEnabled === true,
        }, activation);
        context.outcome = view;
        return {
          detail: `Shared "${view.title}" (${view.workFolderId}:${view.relativePath}) as /p/${view.publicationId}; `
            + `bridgeSync=${view.bridgeSlot === "confirmed" ? "confirmed" : "pending"}.`,
          undoRef: { kind: "publicationId", value: view.publicationId },
        };
      }
      const resolved = await resolveHostedApp(act);
      if ("issue" in resolved) throw new Error(resolved.issue);
      const view = await state.publications.activateApp({
        workFolderId: resolved.exposure.workFolderId,
        title: resolved.exposure.title,
        app: {
          appInstanceId: resolved.exposure.pins.appInstanceId,
          releaseDigest: resolved.exposure.pins.releaseDigest,
          viewerEntry: resolved.exposure.pins.viewerEntry,
          viewerSurface: resolved.exposure.pins.viewerSurface,
        },
      }, activation);
      context.outcome = view;
      return {
        detail: `Put "${view.title}" (App Instance ${resolved.exposure.pins.appInstanceId}, `
          + `Release ${resolved.exposure.pins.releaseDigest}) at your address as /a/${view.publicationId}; `
          + `bridgeSync=${view.bridgeSlot === "confirmed" ? "confirmed" : "pending"}.`,
        undoRef: { kind: "publicationId", value: view.publicationId },
      };
    },
  };
}

/**
 * `work-folder.delete-folder` — the managed removal path. Pin recheck re-verifies
 * the registered identity and canonical root; the `.workspace/` fail-closed
 * rule and managed-root identity claims are re-checked by the removal
 * machinery itself at execution. The complete desktop removal orchestration
 * — impact checks, Check, automation, and app-state revocation, claim-verified
 * managed deletion — is shared with DELETE /api/work-folders/:id and `work-folders
 * unregister`. It reserves its own capability fences across every affected
 * work-folder, so the adapter's null fenceScope keeps the executor from reserving
 * twice.
 */
function createManagedWorkFolderDeletionAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<WorkFolderRemovalResult & {
  recentlyDeleted: { entryId: string; restoreBy: string } | null;
  appRecentlyDeletedEntries: Array<{ entryId: string; restoreBy: string }>;
}> | undefined> {
  return {
    fenceScope: () => null,
    recheckPins(act) {
      return managedWorkFolderDeletionPinIssue({
        workFolderId: stringPinValue(act, "workFolderId"),
        workFolderRoot: stringPinValue(act, "workFolderRoot"),
      });
    },
    async execute(act, context) {
      const workFolder = await getWorkFolder(String(act.pins.workFolderId ?? act.parameters.workFolderId));
      const result = await removeWorkFolderRegistrationInternal(state, workFolder, { receiptId: context?.requestId ?? null });
      if (context) context.outcome = result;
      const trashed = (result.recentlyDeleted ? `; trash ${result.recentlyDeleted.entryId}` : "")
        + (result.appRecentlyDeletedEntries.length ? `; app data ${result.appRecentlyDeletedEntries.map((item) => item.entryId).join(", ")}` : "");
      return {
        detail: result.cleanupPending
          ? `Moved the managed work-folder's folder ${workFolder.workFolderRoot} to Recently deleted${trashed}; final cleanup completes at the next start.`
          : `Moved the managed work-folder's folder ${workFolder.workFolderRoot} to Recently deleted${trashed}.`,
        ...(result.recentlyDeleted ? { undoRef: { kind: "recently-deleted-entry", value: result.recentlyDeleted.entryId } } : {}),
      };
    },
  };
}

/**
 * The automation executor's hop ports: the same in-process internals the act
 * facade uses — turn acceptance in a fresh Chat, a new thread of the
 * work-fold agent, the files-add copy with its restore point,
 * reserved Check runs — honoring aborts through each domain's own abort path,
 * and returning identifiers and counts only. The executor fills every
 * placeholder before it calls a message port, so `message` is exactly what
 * the hop sends.
 */
function createAutomationHopPorts(state: LocalApiState): WorkFoldAutomationHopPorts {
  return {
    async chat(step, message, context) {
      const workFolder = await getWorkFolder(step.workFolder);
      const conversation = await createConversation(workFolder.workFolderRoot);
      const checkpoints: { pre?: string; post?: string } = {};
      const observer = (event: TurnCheckpointEvent): void => {
        if (event.workFolderId !== workFolder.id || event.conversationId !== conversation.id) return;
        if (event.reason === "pre_turn") checkpoints.pre ??= event.checkpointId;
        else checkpoints.post = event.checkpointId;
      };
      state.turnCheckpointListeners.add(observer);
      try {
        const { taskId } = await acceptConversationTurn(state, workFolder, conversation.id, {
          content: message,
          contextPaths: [],
          selectedPath: null,
          actorKind: "system",
        });
        const settled = await waitForSettledRequest(state, workFolder.id, conversation.id, taskId, context.signal);
        return {
          conversationId: conversation.id,
          turnTaskId: taskId,
          outcome: settled.status,
          result: await completedRequestEnvelope(state, taskId),
          ...(settled.error !== undefined ? { error: settled.error } : {}),
          ...(checkpoints.pre !== undefined ? { preCheckpointId: checkpoints.pre } : {}),
          ...(checkpoints.post !== undefined ? { postCheckpointId: checkpoints.post } : {}),
        };
      } finally {
        state.turnCheckpointListeners.delete(observer);
      }
    },
    // An agent hop always opens a *new* thread, never the person's live
    // management thread: standing behavior must not entangle a conversation
    // someone is in the middle of, and turn-conflict rejection stays exact.
    // The acceptance shape is byte-for-byte the one `agent send` uses.
    async workFoldAgent(_step, message, context) {
      if (state.workFoldAgentInstructionsError) {
        throw new Error("The work-fold agent is unavailable because work-fold could not prepare its instructions.");
      }
      const scope = workFoldAgentScopeForRoutes(state);
      const conversation = await createConversation(scope.rootPath);
      const { taskId } = await acceptConversationTurn(state, { id: scope.id, workFolderRoot: scope.rootPath }, conversation.id, {
        content: message,
        contextPaths: [],
        selectedPath: null,
        actorKind: "system",
        workFoldAgentAttachments: [],
      });
      const settled = await waitForSettledRequest(state, scope.id, conversation.id, taskId, context.signal);
      return {
        conversationId: conversation.id,
        turnTaskId: taskId,
        outcome: settled.status,
        result: await completedRequestEnvelope(state, taskId),
        ...(settled.error !== undefined ? { error: settled.error } : {}),
      };
    },
    async checkRunFindings(workFolderId, taskId) {
      const workFolder = await getWorkFolder(workFolderId).catch(() => null);
      if (!workFolder) return null;
      let run: Awaited<ReturnType<typeof state.checks.taskResult>>;
      try {
        run = await state.checks.taskResult(workFolder.id, taskId);
      } catch {
        return null;
      }
      return {
        findings: run.findings
          .filter((finding) => finding.status === "active")
          .map((finding) => ({
            checkId: finding.checkId,
            title: finding.title,
            targetPath: finding.targetPath,
            severity: finding.severity,
          })),
      };
    },
    async files(step, source, context) {
      const reserved: string[] = [];
      try {
        for (const id of [...new Set([step.fromWorkFolder, step.toWorkFolder])].sort()) {
          reserveCapabilityMutation(state, id, "project", id);
          reserved.push(id);
        }
        // A files hop is deliberately not interruptible mid-copy: it completes
        // with its restore point or fails as one unit, so the signal is only a
        // pre-flight refusal here.
        if (context.signal.aborted) throw new Error("The run was aborted before this hop copied anything.");
        const from = await getWorkFolder(step.fromWorkFolder);
        const to = await getWorkFolder(step.toWorkFolder);
        const absoluteSources = await resolveAutomationFilesSources(from.workFolderRoot, source);
        const copied: string[] = [];
        try {
          for (const sourcePath of absoluteSources) {
            copied.push(await copyPathIntoWorkFolder(sourcePath, to.workFolderRoot, step.to));
          }
        } catch (error) {
          // A mid-batch failure must not strand earlier copies without a
          // restore point: undo them best-effort, then surface the failure.
          await Promise.all(copied.map((path) =>
            rm(resolveWorkFolderPath(to.workFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
          throw error;
        }
        const safety = await checkpointAdditiveWritesOrUndo(to.workFolderRoot, copied, {
          reason: "pre_add",
          label: `Before automation hop ${step.id} added ${copied.length} item${copied.length === 1 ? "" : "s"}`,
        });
        const measured = await measureWorkFolderEntries(to.workFolderRoot, copied);
        return {
          ...(safety ? { restorePointId: safety.checkpointId } : {}),
          copiedPaths: copied,
          fileCount: measured.fileCount,
          totalBytes: measured.totalBytes,
        };
      } finally { for (const id of reserved) state.capabilityMutations.delete(id); }
    },
    async check(step, context) {
      const workFolder = await getWorkFolder(step.workFolder);
      const accepted = await runReservedCheckOperation(state, workFolder.id, () => state.checks.run({
        workFolder,
        ...(step.check !== undefined ? { checkId: step.check } : {}),
        actor: { kind: "system", workFolderId: workFolder.id },
        // Lineage stamps the settle record so automation-caused runs never fire
        // on-settled triggers — chains stay structurally impossible.
        lineage: context.lineage,
      }));
      const requestAbort = (): void => {
        void state.checks.abort(workFolder.id, accepted.taskId).catch(() => undefined);
      };
      if (context.signal.aborted) requestAbort();
      context.signal.addEventListener("abort", requestAbort, { once: true });
      try {
        for (;;) {
          const status = await state.checks.taskStatus(workFolder.id, accepted.taskId);
          if (status.state === "unknown") throw new Error("work-fold lost track of this Check run.");
          if (status.state !== "accepted" && status.state !== "running") break;
          await settleDelay(50);
        }
        const run = await state.checks.taskResult(workFolder.id, accepted.taskId);
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
    async checkpointManifest(workFolderId, checkpointId) {
      const workFolder = await getWorkFolder(workFolderId).catch(() => null);
      if (!workFolder) return null;
      const checkpoint = await getWorkFolderCheckpoint(workFolder.workFolderRoot, checkpointId);
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
 * Resolves an automation files hop's source selection inside the source work-folder:
 * exact paths under the ordinary work-folder path policy (no symbolic links, no
 * reserved segments), or the bounded tree selector through the Check target
 * resolver's discipline and the automation handoff bounds.
 */
async function resolveAutomationFilesSources(
  fromWorkFolderRoot: string,
  source: Parameters<WorkFoldAutomationHopPorts["files"]>[1],
): Promise<string[]> {
  if (source.kind === "paths") {
    if (source.paths.length === 0) throw new Error("The files hop resolved no source paths.");
    if (source.paths.length > workFoldAutomationBounds.maxHandoffFiles) {
      throw new Error(`The files hop names ${source.paths.length} paths, more than the ${workFoldAutomationBounds.maxHandoffFiles}-file bound.`);
    }
    const absolute: string[] = [];
    for (const raw of source.paths) {
      const path = resolveWorkFolderPath(fromWorkFolderRoot, raw);
      const info = await lstat(path).catch(() => null);
      if (!info) throw new Error(`Source not found in the source work-folder: ${raw}.`);
      if (info.isSymbolicLink()) throw new Error(`Symbolic-link sources cannot be copied: ${raw}.`);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Only files and folders can be copied: ${raw}.`);
      absolute.push(path);
    }
    return absolute;
  }
  const resolution = await resolveWorkFoldCheckTargets(fromWorkFolderRoot, [{
    kind: "tree",
    role: "primary",
    path: source.path,
    recursive: source.recursive,
    extensions: [...source.extensions],
  }], {
    limits: {
      maxFiles: workFoldAutomationBounds.maxHandoffFiles,
      maxTotalBytes: workFoldAutomationBounds.maxHandoffTotalBytes,
    },
  });
  return resolution.files.map((file) => file.absolutePath);
}

const maxAutomationMeasureEntries = 10_000;

/** Bounded evidence measurement of copied destinations: files and bytes. */
async function measureWorkFolderEntries(
  workFolderRoot: string,
  relativePaths: string[],
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  let visited = 0;
  const visit = async (path: string): Promise<void> => {
    if (visited >= maxAutomationMeasureEntries) return;
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
    await visit(resolveWorkFolderPath(workFolderRoot, relativePath));
  }
  return { fileCount, totalBytes };
}

/**
 * Follows one accepted turn to its settled record, honoring the automation
 * run's abort signal through the same cancellation path `agent stop` uses.
 * The accepted turn always settles (its runner records an outcome in a
 * finally block), so the wait terminates; a record evicted by the bounded
 * settled-turn history reports honestly as lost.
 */
async function waitForSettledRequest(
  state: LocalApiState,
  workFolderId: string,
  conversationId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<SettledTurnRecord> {
  const requestAbort = (): void => { void stopWorkFoldAgentRequest(state, taskId).catch(() => undefined); };
  if (signal.aborted) requestAbort();
  signal.addEventListener("abort", requestAbort, { once: true });
  try {
    for (;;) {
      // A settle may reserve a synthesis turn. Observe that decision before
      // admitting the next automation hop.
      await state.requestSettleChain;
      const request = state.requests.byTaskId(taskId);
      // A stop fences the graph before native abort cleanup finishes. A
      // automation's terminal receipt must wait for that cleanup, so its next
      // observer cannot see completed automation work with live kernel tasks.
      if (request && request.state !== "waiting" && isWorkFoldRequestTerminalState(request.state)
        && [request, ...state.requests.subtree(request.requestId)].some((item) => item.turns.some((turn) => state.activeTurnTasks.has(turn.taskId)))) {
        await settleDelay(25);
        continue;
      }
      if (request && (request.state === "waiting" || isWorkFoldRequestTerminalState(request.state))) {
        const latest = request.turns.at(-1)!;
        const settled = state.settledTurns.get(latest.taskId);
        return {
          ...(settled ?? { taskId: latest.taskId, workFolderId, conversationId, endedAt: new Date().toISOString() }),
          status: request.state === "done" ? "succeeded" : request.state === "stopped" ? "aborted" : "failed",
          ...(request.state === "done" ? {} : { error: request.state === "waiting"
            ? "The Worker request needs an answer in its Chat. This automation ended here; answering does not replay later hops."
            : `The Worker request ended ${request.state}.` }),
        };
      }
      if (!request && !state.activeTurnTasks.has(taskId)) {
        return { taskId, workFolderId, conversationId, status: "failed", endedAt: new Date().toISOString(), error: "work-fold lost track of this request." };
      }
      await settleDelay(25);
    }
  } finally { signal.removeEventListener("abort", requestAbort); }
}

function settleDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const maxOverviewConversationsPerWorkFolder = 2_048;
const maxOverviewCheckpointsPerWorkFolder = 256;
const maxOverviewActReceiptLines = 8_192;
const maxOverviewAppAutomationReceipts = 2_048;

/**
 * The overview's live-registry source readers (docs/work-fold-agent-overview.md): recorded
 * state only — the settled-turn records, the durable request graph
 * (docs/collaboration-contract.md, F25), the
 * chat store and History per registered work-folder, the Check service's status and
 * content-free settled runs, the act-receipts ledger, the automation receipts
 * journal, the publication grant records, and the
 * restricted-app registry's machine-wide automation ledgers (active accepted
 * runs and settled receipts). The kernel's own task registry supplies running
 * tasks.
 */
function createServerOverviewSources(state: LocalApiState): WorkFoldOverviewSourceReaders {
  const automationRunReader = createWorkFoldOverviewAutomationRunReader();
  return {
    settledTurns: async (): Promise<WorkFoldOverviewSettledTurnRecord[]> =>
      [...state.settledTurns.values()].map((turn) => ({
        taskId: turn.taskId,
        // The work-fold agent scope is not a work-folder; its settled turns carry no
        // work-folder id instead of rendering as a removed work-folder.
        ...(turn.workFolderId === workFoldAgentScopeId ? {} : { workFolderId: turn.workFolderId }),
        conversationId: turn.conversationId,
        outcome: turn.status,
        endedAt: turn.endedAt,
      })),
    workFoldAgentRequests: () => overviewWorkFoldAgentRequestRecords(state),
    chats: async (workFolder) => {
      const summaries = await listConversations(workFolder.workFolderRoot);
      const records = [];
      for (const summary of summaries.slice(0, maxOverviewConversationsPerWorkFolder)) {
        records.push(workFoldOverviewChatRecordFromMessages(summary, await readConversation(workFolder.workFolderRoot, summary.id)));
      }
      return records;
    },
    checkpoints: async (workFolder) =>
      (await listWorkFolderCheckpoints(workFolder.workFolderRoot, maxOverviewCheckpointsPerWorkFolder)).map((checkpoint) => ({
        checkpointId: checkpoint.checkpointId,
        createdAt: checkpoint.createdAt,
        ...(checkpoint.label !== undefined ? { label: checkpoint.label } : {}),
        reason: checkpoint.reason,
        scope: checkpoint.scope,
      })),
    checks: async (workFolder): Promise<WorkFoldOverviewCheckSource | null> => {
      const ref = { id: workFolder.id, workFolderRoot: workFolder.workFolderRoot };
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
    appAutomationRuns: async (): Promise<WorkFoldOverviewAppAutomationRunRecord[]> =>
      (await state.restrictedApps.listActiveAppAutomationRuns()).map((run) => ({
        runId: run.runId,
        appAutomationId: run.appAutomationId,
        workFolderId: run.workFolderId,
        startedAt: run.acceptedAt,
      })),
    appAutomationRunReceipts: async (): Promise<WorkFoldOverviewAppAutomationReceiptRecord[]> =>
      (await state.restrictedApps.listAppAutomationRunHistory(maxOverviewAppAutomationReceipts)).map((receipt) => ({
        receiptId: receipt.receiptId,
        runId: receipt.runId,
        appAutomationId: receipt.appAutomationId,
        workFolderId: receipt.workFolderId,
        outcome: receipt.outcome,
        finishedAt: receipt.finishedAt,
      })),
    automationRuns: automationRunReader,
    viewerGrants: async (): Promise<WorkFoldOverviewViewerGrantEventRecord[]> => {
      const events: WorkFoldOverviewViewerGrantEventRecord[] = [];
      for (const view of await state.publications.list()) {
        events.push({ publicationId: view.publicationId, event: "created", at: view.createdAt, workFolderId: view.workFolderId });
        if (view.revokedAt !== undefined) {
          events.push({ publicationId: view.publicationId, event: "revoked", at: view.revokedAt, workFolderId: view.workFolderId });
        }
        // The record's bounded health note: the publisher-facing reason
        // behind a vague not-available or resting viewer page
        // (docs/shared-pages.md, "Honest states").
        if (view.lastProblem !== undefined) {
          events.push({
            publicationId: view.publicationId,
            event: view.lastProblem.state,
            at: view.lastProblem.at,
            workFolderId: view.workFolderId,
            title: view.title,
            reason: view.lastProblem.reason,
          });
        }
      }
      return events;
    },
  };
}

/**
 * Request records for the overview, composed from the durable record alone.
 *
 * The overview recomposes on every call, from the popover, the main window, and
 * every remote client, so this path stays cheap: a record already carries its
 * state, its timestamps, its questions, and its results. Needs you is derived
 * from those records; rendering the overview never scans a transcript for a
 * question mark.
 */
async function overviewWorkFoldAgentRequestRecords(state: LocalApiState): Promise<WorkFoldOverviewAgentRequestRecord[]> {
  const records: WorkFoldOverviewAgentRequestRecord[] = [];
  for (const record of state.requests.list({ limit: maxOverviewRequestRecords })) {
    const newestTurn = record.turns.at(-1)!;
    const phase = workFoldRequestStateToAgentPhase(record.state);
    const descendants = state.requests.subtree(record.requestId);
    const questions = state.requests.questions(record.requestId);
    records.push({
      requestId: record.requestId,
      kind: record.kind,
      state: record.state,
      taskId: newestTurn.taskId,
      conversationId: record.owner.conversationId,
      ...(record.owner.workFolderId ? { workFolderId: record.owner.workFolderId } : {}),
      phase,
      startedAt: record.createdAt,
      endedAt: phase === "working" || phase === "handed_off" ? null : (record.settledAt ?? newestTurn.settledAt),
      childTaskIds: descendants.flatMap((descendant) => descendant.turns.map((turn) => turn.taskId)),
      openQuestions: questions
        .filter((question) => question.state === "open")
        .map((question) => ({ questionId: question.questionId, respondent: question.respondent, askedAt: question.askedAt })),
      questionCount: questions.length,
      resultCount: record.results.length,
    });
  }
  return records;
}

const maxOverviewRequestRecords = 16_384;

/**
 * Tolerant bounded read of the act-receipts ledger for the overview: the same
 * live and rotated files the executor appends. A damaged line is omitted —
 * the overview is a projection, never the journal's authority.
 */
async function readActReceiptJournal(state: LocalApiState): Promise<WorkFoldCliActReceipt[]> {
  const receipts: WorkFoldCliActReceipt[] = [];
  for (const path of [state.actReceipts.rotatedPath, state.actReceipts.path]) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const lines = text.split("\n").filter((line) => line.trim());
    for (const line of lines.slice(-maxOverviewActReceiptLines)) {
      try {
        const record = JSON.parse(line) as Partial<WorkFoldCliActReceipt>;
        // Every journal version stays readable: older lines are history, and
        // the current version is the one every act writes now.
        if ((record.v !== 1 && record.v !== 2 && record.v !== 3)
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
  return receipts.slice(-maxOverviewActReceiptLines);
}

function closeWorkFolderStreams(state: LocalApiState, workFolderId: string): void {
  for (const [close, owner] of [...state.fileStreams]) if (owner === workFolderId) close();
  const prefix = `${workFolderId}:`;
  for (const [key, streams] of [...state.chatStreams]) {
    if (!key.startsWith(prefix)) continue;
    for (const response of streams) response.close();
    state.chatStreams.delete(key);
  }
}

function extensionScopeId(state: LocalApiState, scope: PiExtensionUiScope): string | null {
  return workFolderRootKey(scope.workFolderRoot) === workFolderRootKey(workFoldAgentRoot())
    ? workFoldAgentScopeId : workFolderIdForRoot(state, scope.workFolderRoot);
}

function sameExtensionScope(left: PiExtensionUiScope, right: PiExtensionUiScope): boolean {
  return workFolderRootKey(left.workFolderRoot) === workFolderRootKey(right.workFolderRoot) && left.conversationId === right.conversationId;
}

function remoteExtensionRequests(state: LocalApiState, record: WorkFoldRequestRecord): Array<Record<string, unknown>> {
  const taskId = record.turns.at(-1)?.taskId;
  if (!taskId || record.owner.workFolderId || record.stopRequestedAt || record.state === "expired" || (record.deadline !== null && Date.now() >= Date.parse(record.deadline)) || state.cancelledTurnTasks.has(taskId)
      || state.activeTurnIdsByKey.get(streamKey(workFoldAgentScopeId, record.owner.conversationId)) !== taskId) return [];
  return [...state.extensionRequests.values()].filter((request) => request.taskId === taskId
    && sameExtensionScope(request, { workFolderRoot: workFoldAgentRoot(), conversationId: record.owner.conversationId })
    && !(request.method === "input" && request.secret))
    .map((request) => ({ ...rendererExtensionRequest(request), taskId }));
}

function rendererExtensionRequest(request: PiExtensionUiRequest): Record<string, unknown> {
  return {
    id: request.id, method: request.method, title: request.title,
    ...(request.method === "confirm" ? { message: request.message } : {}),
    ...(request.method === "select" ? { options: request.options } : {}),
    ...(request.method === "input" && request.placeholder ? { placeholder: request.placeholder } : {}),
    ...(request.method === "input" && request.secret ? { secret: true } : {}),
    ...(request.method === "editor" && request.prefill ? { initialValue: request.prefill } : {}),
  };
}

function extensionSnapshot(state: LocalApiState, scope: PiExtensionUiScope): Array<Record<string, unknown>> {
  return [...state.extensionRequests.values()].filter((request) => sameExtensionScope(request, scope)).map(rendererExtensionRequest);
}

/** Transient interactions never enter the replay log or portable transcript. */
function publishExtensionSnapshot(state: LocalApiState, scope: PiExtensionUiScope): void {
  publishTransientExtensionEvent(state, scope, { type: "extension_ui_snapshot", conversationId: scope.conversationId, requests: extensionSnapshot(state, scope) });
}

/** Desktop UI only: no durable log and no remote-watch listeners. */
function publishTransientExtensionEvent(state: LocalApiState, scope: PiExtensionUiScope, event: unknown): void {
  const scopeId = extensionScopeId(state, scope);
  if (!scopeId) return;
  const streams = state.chatStreams.get(streamKey(scopeId, scope.conversationId));
  for (const response of [...streams ?? []]) {
    try {
      if (response.closed || response.queuedBytes > maxChatStreamQueuedBytes) {
        response.close(); streams?.delete(response);
      } else writeSseData(response, event);
    } catch { streams?.delete(response); }
  }
}

function routeExtensionRequest(state: LocalApiState, request: PiExtensionUiRequest): void {
  const scopeId = extensionScopeId(state, request);
  if (!scopeId) {
    state.extensionUi.cancel(request.id);
    return;
  }
  if (request.taskId && state.activeTurnIdsByKey.get(streamKey(scopeId, request.conversationId)) !== request.taskId) {
    state.extensionUi.cancel(request.id);
    return;
  }
  state.extensionRequests.set(request.id, request);
  publishExtensionSnapshot(state, request);
}

function answerExtensionRequest(state: LocalApiState, scope: PiExtensionUiScope, id: string, body: { value?: unknown; cancelled?: unknown }): boolean {
  const request = state.extensionRequests.get(id);
  if (!request || !sameExtensionScope(request, scope)) throw notFound("Extension question has ended or belongs to another Chat.");
  if (body.cancelled !== undefined && typeof body.cancelled !== "boolean") throw badRequest("cancelled must be a boolean.");
  const response: PiExtensionUiResponse = body.cancelled === true ? { cancelled: true }
    : request.method === "confirm" ? { confirmed: body.value as boolean } : { value: body.value as string };
  try { validateExtensionUiResponse(request, response); }
  catch (error) { throw badRequest(errorMessage(error)); }
  return state.extensionUi.respond(request.id, response);
}

function routeRestrictedAppProposal(state: LocalApiState, proposal: RestrictedAppProposalReceipt): void {
  broadcast(state, streamKey(proposal.workFolderId, proposal.conversationId), {
    type: "restricted_app_proposal",
    conversationId: proposal.conversationId,
    proposal: rendererRestrictedAppProposal(proposal),
  });
}

function routeRestrictedAppProposalSettled(state: LocalApiState, proposal: RestrictedAppProposalReceipt): void {
  broadcast(state, streamKey(proposal.workFolderId, proposal.conversationId), {
    type: "restricted_app_proposal_settled",
    conversationId: proposal.conversationId,
    proposal: rendererRestrictedAppProposal(proposal),
  });
}

function rendererRestrictedAppProposal(proposal: RestrictedAppProposalReceipt): Record<string, unknown> {
  return {
    id: proposal.id,
    workFolderId: proposal.workFolderId,
    conversationId: proposal.conversationId,
    sourcePath: proposal.sourcePath,
    review: proposal.review,
    status: proposal.status,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...(proposal.installedApp ? { installedApp: proposal.installedApp } : {}),
    ...(proposal.error ? { error: proposal.error } : {}),
    ...(proposal.needs ? { needs: proposal.needs } : {}),
  };
}

function routeExtensionEvent(state: LocalApiState, event: PiExtensionUiEvent): void {
  const workFolderId = extensionScopeId(state, event);
  if (!workFolderId) return;
  if (event.method === "oauthDeviceCode" || event.method === "openExternal") {
    publishTransientExtensionEvent(state, event, { type: "status", conversationId: event.conversationId, message: extensionEventMessage(event) });
    return;
  }
  if (event.method === "notify") {
    broadcast(state, streamKey(workFolderId, event.conversationId), {
      type: "extension_ui_request",
      conversationId: event.conversationId,
      request: { id: event.id, method: "notify", message: event.message },
    });
    return;
  }
  if (event.method === "setEditorText" || event.method === "pasteToEditor") {
    broadcast(state, streamKey(workFolderId, event.conversationId), {
      type: "editor",
      conversationId: event.conversationId,
      editorMode: event.method === "setEditorText" ? "replace" : "append",
      text: event.text,
    });
    return;
  }
  const message = extensionEventMessage(event);
  if (message) broadcast(state, streamKey(workFolderId, event.conversationId), { type: "status", conversationId: event.conversationId, message });
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

function providerSetupResponse(status: PiSetupStatus, desktopSetup: boolean) {
  return status.providers.map((provider) => ({
    ...provider,
    oauthAvailable: provider.oauth && desktopSetup,
    guidedSetup: provider.apiKey && desktopSetup,
  }));
}

function emptyAgentStatus(): Record<string, unknown> {
  return { ready: true, configured: false, provider: null, model: null, piVersion: null, projectTrusted: false, error: null };
}

async function safeAgentStatus(workFolderRoot: string, provider: PiRuntimeProvider): Promise<Record<string, unknown>> {
  try {
    return normalizeStatus(await getPiSetupStatus(workFolderRoot, provider));
  } catch (error) {
    return { ...emptyAgentStatus(), ready: false, error: errorMessage(error) };
  }
}

interface ModelScope {
  id: string;
  workFolderRoot: string;
  label: string;
}

async function modelScope(scope: string | null | undefined, workFolderId?: string | null): Promise<ModelScope> {
  if (scope === "agent") {
    return { id: workFoldAgentScopeId, workFolderRoot: workFoldAgentRoot(), label: "the work-fold agent" };
  }
  if (scope && scope !== "work-folder") throw badRequest("agent scope must be work-folder or management.");
  if (!workFolderId) throw badRequest("work-folder id is required.");
  const workFolder = await getWorkFolder(workFolderId);
  return { id: workFolder.id, workFolderRoot: workFolder.workFolderRoot, label: "this work-folder" };
}

function openControlEventStream(state: LocalApiState, sink: LocalEventSink): void {
  if (sink.closed) return;
  state.controlStreams.add(sink);
  sink.send({ type: "reset" });
  const heartbeat = setInterval(() => sink.heartbeat(), 15_000);
  heartbeat.unref();
  sink.onClose(() => { clearInterval(heartbeat); state.controlStreams.delete(sink); });
}

function openChatStream(
  state: LocalApiState,
  res: LocalEventSink,
  workFolderId: string,
  conversationId: string,
  _lastEventId?: string | string[],
): void {
  if (res.closed) return;
  const key = streamKey(workFolderId, conversationId);
  writeSseData(res, { type: "status", conversationId, message: "Connected." });
  const log = chatEventLog(state, key);
  // The conflict reservation precedes persistence. A new subscriber must not
  // mistake that reservation for a readable accepted message/answer.
  const turnId = state.activeTurnIdsByKey.get(key);
  const running = state.runningTurns.has(key) && Boolean(turnId && state.turnStore.get(turnId)?.userMessagePersisted);
  // A reconnect reads current state. Replaying deltas would repeat local
  // timers/rows and an old process's numeric cursor could match a new log.
  // No model or tool execution is restarted by this read-only projection.
  const presentation = (running && turnId ? state.clients.get(key)?.getTurnLivePresentation(turnId) : undefined)
    ?? boundedLiveTurnPresentation({ text: log.assistantText, workTrail: [], truncated: false });
  const snapshotId = log.nextId - 1;
  writeSseData(res, {
    type: "turn_snapshot", conversationId, running,
    turnId: turnId ?? log.turnId ?? null,
    text: presentation.text, presentation,
  }, snapshotId > 0 ? snapshotId : undefined);
  // Older consumers retain their original handshake alongside the richer view.
  writeSseData(res, turnStateEvent(conversationId, running, turnId ?? log.turnId ?? null), snapshotId > 0 ? snapshotId : undefined);
  const streams = state.chatStreams.get(key) ?? new Set<LocalEventSink>();
  streams.add(res);
  state.chatStreams.set(key, streams);
  const extensionScope = { conversationId, workFolderRoot: workFolderId === workFoldAgentScopeId
    ? workFoldAgentRoot() : [...state.workFolderIdsByRoot].find(([, id]) => id === workFolderId)?.[0] ?? "" };
  writeSseData(res, { type: "extension_ui_snapshot", conversationId, requests: extensionSnapshot(state, extensionScope) });
  void state.restrictedAppProposals.list({ workFolderId, conversationId }).then(async (proposals) => {
    for (const proposal of proposals) {
      if (proposal.status !== "pending" || res.closed) continue;
      const current = await state.restrictedAppProposals.get(proposal.id);
      if (!current || current.status !== "pending" || current.updatedAt !== proposal.updatedAt || res.closed) continue;
      res.send({ type: "restricted_app_proposal", conversationId, proposal: rendererRestrictedAppProposal(current) });
    }
  }).catch(() => undefined);
  const heartbeat = setInterval(() => {
    try {
      res.heartbeat();
    } catch { /* disconnected */ }
  }, 15_000);
  res.onClose(() => {
    clearInterval(heartbeat);
    streams.delete(res);
    if (!streams.size) state.chatStreams.delete(key);
  });
}

async function openWorkFolderFileStream(
  state: LocalApiState,
  res: LocalEventSink,
  workFolderRoot: string,
  workFolderId: string,
): Promise<void> {
  let recursive = true;
  let watcher: ReturnType<typeof watch>;
  const sendEvent = (event: unknown) => {
    res.send(event);
  };
  const onChange = (eventType: string, fileName: string | Buffer | null) => {
    const rawName = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
    if (!rawName) {
      sendEvent({ type: "file_event", eventType, path: null });
      return;
    }
    const path = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || isAlwaysHiddenWorkFolderEntry(basename(path))) return;
    void readWorkFolderIgnoreState(workFolderRoot).then((ignoreState) => {
      if (res.closed) return;
      if (isWorkFolderIgnored(path, ignoreState.patterns)) return;
      try { resolveWorkFolderPath(workFolderRoot, path); } catch { return; }
      sendEvent({ type: "file_event", eventType, path });
    }).catch(() => { if (!res.closed) sendEvent({ type: "error", message: "File monitoring is unavailable. Refresh this work-folder to reconnect." }); });
  };
  const watchRoot = await canonicalWorkFolderWatchRoot(workFolderRoot);
  if (res.closed) return;
  const registered = await getWorkFolder(workFolderId);
  if (registered.workFolderRoot !== workFolderRoot) throw notFound("work-folder changed while opening file monitoring.");
  if (res.closed) return;
  try {
    watcher = watch(watchRoot, { recursive: true }, onChange);
  } catch {
    recursive = false;
    watcher = watch(watchRoot, onChange);
  }
  sendEvent({ type: "ready", recursive });
  const heartbeat = setInterval(() => {
    res.heartbeat();
  }, 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    if (!res.closed) res.close();
    state.fileStreams.delete(close);
  };
  state.fileStreams.set(close, workFolderId);
  watcher.on("error", (error) => sendEvent({ type: "error", message: errorMessage(error) }));
  res.onClose(close);
}

async function sendWorkFolderRawFile(res: ServerResponse, workFolderRoot: string, relativePath: string): Promise<void> {
  const path = resolveWorkFolderPath(workFolderRoot, relativePath);
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

function normalizeSelectedPath(workFolderRoot: string, value: string | null | undefined): string | null {
  const path = typeof value === "string" ? normalizeWorkFolderRelativePath(value) : "";
  if (!path) return null;
  let absolutePath: string;
  try {
    absolutePath = resolveWorkFolderPath(workFolderRoot, path);
  } catch (error) {
    throw badRequest(errorMessage(error));
  }
  if (!existsSync(absolutePath)) throw badRequest("The selected work-folder item no longer exists.");
  return path;
}

/**
 * The work-folder Workers a person addressed with @ (2026-10-01): at most eight
 * distinct registered work-folder ids in a stable order, never the sending scope's
 * own. An id that is no longer registered is dropped rather than refused, so a
 * retried send still replays after a work-folder was removed.
 */
async function normalizeAddressedWorkFolderIds(value: unknown, ownScopeId: string): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 512)) {
    throw badRequest("addressedWorkFolderIds must be a list of work-folder ids.");
  }
  const ids = [...new Set((value as string[]).map((item) => item.trim()))].filter((id) => id !== ownScopeId);
  if (!ids.length) return [];
  const registered = new Set((await registeredWorkFolderOutline()).map((workFolder) => workFolder.id));
  return ids.filter((id) => registered.has(id)).sort();
}

function normalizeContextPaths(workFolderRoot: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw badRequest("Chat context paths must be an array of strings.");
  const paths = [...new Set(value.map((item) => normalizeWorkFolderRelativePath(item)).filter(Boolean))];
  for (const path of paths) {
    try { resolveWorkFolderPath(workFolderRoot, path); } catch (error) { throw badRequest(errorMessage(error)); }
  }
  return paths;
}

async function captureTurnCheckpointSafe(
  state: LocalApiState,
  workFolderId: string,
  workFolderRoot: string,
  conversationId: string,
  reason: "pre_turn" | "post_turn",
): Promise<import("./history.js").WorkFolderCheckpoint | null> {
  // History is a work-folder concept. The work-fold agent scope's root holds only
  // conversation records in app state, so turn checkpoints do not apply.
  if (workFolderId === workFoldAgentScopeId) return null;
  try {
    const checkpoint = await createWorkFolderCheckpoint(workFolderRoot, {
      reason,
      label: reason === "pre_turn" ? "Before turn" : "After turn",
    });
    state.onHistoryCheckpoint?.({
      workFolderId,
      conversationId,
      reason,
      checkpointId: checkpoint.checkpointId,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    });
    for (const listener of [...state.turnCheckpointListeners]) {
      try {
        listener({ workFolderId, conversationId, reason, checkpointId: checkpoint.checkpointId });
      } catch {
        // Observers never affect the turn.
      }
    }
    if (checkpoint.skippedLargeFiles.length) {
      broadcast(state, streamKey(workFolderId, conversationId), {
        type: "status",
        conversationId,
        message: `History skipped ${checkpoint.skippedLargeFiles.length} oversized file${checkpoint.skippedLargeFiles.length === 1 ? "" : "s"}.`,
      });
    }
    return checkpoint;
  } catch (error) {
    broadcast(state, streamKey(workFolderId, conversationId), {
      type: "status",
      conversationId,
      message: `History checkpoint warning: ${errorMessage(error)}`,
    });
    return null;
  }
}

async function runWithHistorySafety<T>(workFolderRoot: string, checkpointId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await discardWorkFolderCheckpoint(workFolderRoot, checkpointId).catch(() => undefined);
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
  workFolderRoot: string,
  writtenPaths: string[],
  options: { reason: string; label: string },
): Promise<WorkFolderCheckpoint | null> {
  if (!writtenPaths.length) return null;
  try {
    return await createWorkFolderMutationCheckpoint(workFolderRoot, { deleteOnRestore: writtenPaths, ...options });
  } catch (error) {
    await Promise.all(writtenPaths.map((path) =>
      rm(resolveWorkFolderPath(workFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw httpError(500, `The added files were removed because work-folder could not record a restore point: ${errorMessage(error)}`);
  }
}

function normalizeWorkFolderRelativePath(value: string): string {
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

function resetChatEventTurn(state: LocalApiState, key: string): void {
  const log = chatEventLog(state, key);
  log.events = [];
  log.bytes = 0;
  log.assistantText = "";
  delete log.turnId;
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
    const event = data as { type?: unknown; text?: unknown; turnId?: unknown };
    if (typeof event.turnId === "string" && event.turnId) log.turnId = event.turnId;
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
  state.turnCheckpointWriter.schedule(key);
}

async function flushTurnCheckpoint(state: LocalApiState, key: string, taskId: string): Promise<void> {
  await state.turnCheckpointWriter.flush(key, taskId);
}

async function flushAllTurnCheckpoints(state: LocalApiState): Promise<void> {
  await state.turnCheckpointWriter.close();
}


function writeSseEntry(response: LocalEventSink, entry: ChatEventLogEntry): void {
  writeSseData(response, entry.data, entry.id);
}

function writeSseData(response: LocalEventSink, data: unknown, id?: number): void {
  response.send(data, id);
}

function broadcast(state: LocalApiState, key: string, event: unknown): void {
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const activeTurnId = state.activeTurnIdsByKey.get(key);
    const supplied = (event as { turnId?: unknown }).turnId;
    // Native callbacks from a draining earlier turn cannot alter a newer view.
    if (typeof supplied === "string" && activeTurnId && supplied !== activeTurnId) return;
    if (supplied === undefined || supplied === null) event = { ...event, turnId: activeTurnId ?? chatEventLog(state, key).turnId ?? null };
  }
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
      if (response.closed || response.queuedBytes > maxChatStreamQueuedBytes) {
        response.close();
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

async function readJsonBody<T>(state: LocalApiState, req: IncomingMessage, maximumBytes?: number): Promise<T> {
  const bytes = await readBody(state, req, maximumBytes);
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

async function readBody(state: LocalApiState, req: IncomingMessage, maximumBytes = state.maxBodyBytes): Promise<Buffer> {
  const limit = Math.min(maximumBytes, state.maxBodyBytes);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge("Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw tooLarge("Request body is too large.");
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

/** Content-free hints only. Reconnect always sends reset; no events are replayed. */
function publishControlHint(state: LocalApiState, type: "apps" | "work-folders" | "models" | "activity"): void {
  for (const response of state.controlStreams) {
    if (response.closed) continue;
    // A slow renderer must reconnect and requery instead of accumulating a queue.
    try { if (!response.send({ type })) response.close(); }
    catch { response.close(); }
  }
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const explicit = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
  const status = explicit
    ?? workFoldCliErrorStatus(error)
    ?? (error instanceof WorkFoldCheckOperationConflictError ? 409 : null)
    ?? (error instanceof RestrictedAppTaskError ? ({ TASK_DENIED: 403, TASK_INVALID: 400, TASK_CONFLICT: 409, TASK_UNAVAILABLE: 503 }[error.code]) : null)
    ?? automationErrorStatus(error)
    ?? restrictedAppErrorStatus(error)
    ?? 500;
  sendJson(res, {
    error: errorMessage(error),
    ...((error instanceof WorkFoldAutomationServiceError || error instanceof WorkFoldAutomationStoreError) ? { code: error.code } : {}),
    ...(error instanceof RestrictedAppError || error instanceof RestrictedAppStorageError || error instanceof RestrictedAppTaskError ? { code: error.code } : {}),
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

function automationErrorStatus(error: unknown): number | null {
  if (error instanceof WorkFoldAutomationServiceError) {
    switch (error.code) {
      case "INPUT_INVALID": return 400;
      case "NOT_FOUND": return 404;
      case "HEALTH_INVALID": return 409;
      case "SERVICE_DAMAGED": return 503;
    }
  }
  if (error instanceof WorkFoldAutomationStoreError) {
    switch (error.code) {
      case "INPUT_INVALID": return 400;
      case "NOT_FOUND": return 404;
      case "BOUND_EXCEEDED":
      case "HEALTH_INVALID":
      case "DIGEST_MISMATCH": return 409;
      case "STORE_DAMAGED":
      case "JOURNAL_UNAVAILABLE":
      case "JOURNAL_DAMAGED": return 503;
    }
  }
  return null;
}

function restrictedAppErrorStatus(error: unknown): number | null {
  if (error instanceof RestrictedAppStorageError) {
    switch (error.code) {
      case "STORAGE_INVALID": return 400;
      case "STORAGE_CONFLICT": return 409;
      case "STORAGE_QUOTA": return 413;
      case "STORAGE_CORRUPT": return 422;
      case "STORAGE_UNSAFE": return 503;
    }
  }
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
  return result ? result.map((value) => value === undefined ? "" : decodeURIComponent(value)) : null;
}

function streamKey(workFolderId: string, conversationId: string): string { return `${workFolderId}:${conversationId}`; }
function clientKey(workFolderId: string, conversationId: string): string { return streamKey(workFolderId, conversationId); }

function rememberWorkFolderRoot(state: LocalApiState, workFolderId: string, rootPath: string): void {
  state.workFolderIdsByRoot.set(workFolderRootKey(rootPath), workFolderId);
}

function workFolderIdForRoot(state: LocalApiState, rootPath: string): string | null {
  return state.workFolderIdsByRoot.get(workFolderRootKey(rootPath)) ?? null;
}

function workFolderRootKey(rootPath: string): string {
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

function turnStateEvent(conversationId: string, running: boolean, turnId?: string | null): { type: "turn_state"; conversationId: string; running: boolean; turnId?: string | null } {
  return { type: "turn_state", conversationId, running, ...(turnId === undefined ? {} : { turnId }) };
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
