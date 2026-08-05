import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream, existsSync, watch } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PiConversationClient,
  PiTurnFailure,
  isPiTurnCancelledError,
  type PiChatEvent,
  type PiRuntimeProvider,
} from "./agent/pi-client.js";
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
import { importPiSkillBundle } from "./agent/skill-import.js";
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
import { RestrictedAppService } from "./agent/restricted-app-service.js";
import {
  getPiSetupStatus,
  installPiPackage,
  isPiProjectMutationTrusted,
  listPiModels,
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
  type ManagementRequestRecord,
} from "./management-requests.js";
import type {
  WorkFoldRemoteFacade,
  WorkFoldRemoteOperation,
  WorkFoldRemotePrincipal,
  WorkFoldRemoteTreeResult,
} from "./remote-management.js";
import {
  createSpaceCheckpoint,
  createSpaceMutationCheckpoint,
  discardSpaceCheckpoint,
  listFileVersions,
  listSpaceCheckpoints,
  restoreFileVersion,
  restoreSpaceCheckpoint,
  type SpaceCheckpoint,
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
import { spaceAppearanceBannerNames } from "../shared/space-appearance.js";
import { WorkFoldCheckOperationConflictError, WorkFoldCheckService } from "./checks/check-service.js";
import type { WorkFoldCheckDecisionKind } from "./checks/check-types.js";
import { purgeWorkFoldCheckState } from "./checks/check-store.js";
import { ensureManagementInstructions } from "./management-instructions.js";
import {
  configureWorkFoldStateRoot,
  restrictedAppRoot,
  workFoldManagementRoot,
  workFoldManagementScopeId,
} from "./state-paths.js";
import { WorkFoldKernel } from "./work-fold-kernel.js";
import { WorkFoldCliError } from "./cli/protocol.js";
import type {
  WorkFoldActChatMessage,
  WorkFoldActChatState,
  WorkFoldActConversationRef,
  WorkFoldActFacade,
  WorkFoldActManagementRequest,
  WorkFoldActManagementRequestPhase,
  WorkFoldActSpaceRef,
  WorkFoldActTurnStatus,
} from "./cli/act-facade.js";
import { resolveWorkFoldCliSpaceSelector } from "./work-fold-cli-adapter.js";
import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
} from "./server-dev-options.js";
import { isAlwaysHiddenSpaceEntry, isSpaceIgnored, readSpaceIgnoreState, setSpaceIgnoreState } from "./space-ignore.js";
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
  type SpaceSummary,
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
  spaceTrustAuthority: RegisteredSpaceTrustAuthority;
  managementInstructionsError: string | null;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  spaceRemovalIo: Partial<SpaceRemovalIo>;
  beforeRestrictedAppSpaceRevalidation?: (spaceId: string) => Promise<void>;
  managementRequests: ManagementRequestRegistry;
  chatStreams: Map<string, Set<ServerResponse>>;
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
  activeTurns: number;
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
  const recoveredSpaceRoots = await recoverPendingSpaceRemovals(
    restrictedApps,
    restrictedAppProposals,
    options.spaceRemovalIo ?? {},
  );
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
  const checks = options.checkService ?? new WorkFoldCheckService({ kernel });
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
    spaceTrustAuthority,
    managementInstructionsError,
    localFolderGrantProvider: options.localFolderGrantProvider,
    spaceRemovalIo: options.spaceRemovalIo ?? {},
    beforeRestrictedAppSpaceRevalidation: options.beforeRestrictedAppSpaceRevalidation,
    managementRequests: new ManagementRequestRegistry(),
    chatStreams: new Map(),
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
    activeTurns: 0,
    onAgentTurnActivity: options.onAgentTurnActivity,
    beforeAgentPrompt: options.beforeAgentPrompt,
    beforeManagementActionRecord: options.beforeManagementActionRecord,
    onHistoryCheckpoint: options.onHistoryCheckpoint,
  };

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
    close: async () => {
      clearInterval(remoteUploadPruneTimer);
      extensionUi.off("request", requestListener);
      extensionUi.off("event", eventListener);
      extensionUi.off("settled", settledListener);
      restrictedAppProposals.off("request", proposalListener);
      restrictedAppProposals.off("settled", proposalSettledListener);
      extensionUi.cancelAll();
      for (const streams of state.chatStreams.values()) for (const response of streams) response.end();
      for (const close of [...state.fileStreams]) close();
      for (const client of state.clients.values()) await client.stop().catch(() => undefined);
      await Promise.allSettled([...state.activeTurnPromises]);
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
    const affectedSpaceIds = await state.restrictedApps.spaceRemovalMutationSpaceIds(space.id);
    const removal = await runRestrictedAppMutations(state, affectedSpaceIds, async () => {
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
        const intent = await beginSpaceRemoval(space.id, state.spaceBase, state.spaceRemovalIo);
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
    sendJson(res, removal);
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
    sendJson(res, { conversation: await createConversation(space.spaceRoot) }, 201);
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
    const body = await readJsonBody<{ content?: string; contextPaths?: string[]; selectedPath?: string | null }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const selectedPath = normalizeSelectedPath(space.spaceRoot, body.selectedPath);
    const contextPaths = normalizeContextPaths(space.spaceRoot, body.contextPaths);
    const { message } = await acceptConversationTurn(state, space, conversationId, {
      content,
      contextPaths,
      selectedPath,
      actorKind: "assistant",
    });
    sendJson(res, { accepted: true, message }, 202);
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
    const conversationId = body.newConversation === true
      ? (await createConversation(scope.rootPath)).id
      : conversationIdInput ?? (await resolveManagementConversation(true)).id;
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
    actorKind: "assistant" | "cli" | "renderer";
    /** Management-scope reference attachments; never used for Space Chats. */
    managementAttachments?: ManagementAttachmentRef[];
    /** Previous needs-you request whose audit trail this reply continues. */
    continuedFromManagementTaskId?: string;
    /** Remote provenance is persisted with the message and management request. */
    remotePrincipal?: WorkFoldRemotePrincipal;
  },
): Promise<{ message: { id: string; role: "user"; content: string; createdAt: string }; taskId: string }> {
  const turnKey = clientKey(space.id, conversationId);
  const existing = await readConversationSummary(space.spaceRoot, conversationId);
  if (!existing) throw notFound("Conversation not found.");
  if (existing.archivedAt) throw httpError(409, "Restore this Chat before sending another message.");
  if (existing.snoozedUntil && Date.parse(existing.snoozedUntil) > Date.now()) {
    throw httpError(409, "Resume this Chat before sending another message.");
  }
  assertNoCapabilityMutationForTurn(state, space.id);
  if (state.compactingConversations.has(turnKey)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  if (state.runningTurns.has(turnKey)) throw httpError(409, "Wait for the current agent turn to finish.");
  state.runningTurns.add(turnKey);
  const task = state.kernel.startTask({
    kind: "assistant_turn",
    spaceId: space.id,
    conversationId,
    actor: { kind: input.actorKind, cwd: space.spaceRoot, spaceId: space.id, conversationId },
  });
  state.activeTurnTasks.set(task.id, { spaceId: space.id, conversationId });
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
    id: randomUUID(),
    role: "user" as const,
    content: input.content,
    createdAt: new Date().toISOString(),
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
  } catch (error) {
    state.runningTurns.delete(turnKey);
    state.activeTurnTasks.delete(task.id);
    state.cancelledTurnTasks.delete(task.id);
    state.kernel.finishTask(task.id);
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
  return { message, taskId: task.id };
}

async function createSpaceInternal(state: LocalApiState, name: string): Promise<SpaceSummary> {
  const space = await createManagedSpace(name, state.spaceBase);
  state.spaceTrustAuthority.grant(space.spaceRoot);
  return space;
}

async function registerSpaceInternal(state: LocalApiState, rootPath: string, providerHint?: "google-drive"): Promise<SpaceSummary> {
  const space = await registerLinkedSpace(rootPath, providerHint);
  state.spaceTrustAuthority.grant(space.spaceRoot);
  return space;
}

const maxActAddSources = 25;

/**
 * Dedicated remote semantic adapter. The desktop relay can invoke only these
 * bounded operations; it never receives the renderer session token or a
 * generic local-HTTP tunnel. Every Assistant send still enters the canonical
 * management conversation through the shared acceptance path.
 */
function createWorkFoldRemoteFacade(state: LocalApiState): WorkFoldRemoteFacade {
  return {
    async purgeUploads(grantId) {
      const root = remoteManagementUploadRoot(workFoldManagementRoot());
      if (!grantId) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      await rm(join(root, safeRemoteUploadSegment(grantId)), { recursive: true, force: true });
    },
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
function createWorkFoldActFacade(state: LocalApiState): WorkFoldActFacade {
  const resolveSpace = async (selector: string): Promise<SpaceSummary> => {
    const resolved = resolveWorkFoldCliSpaceSelector(await listSpaces(), selector.trim() || undefined);
    if (!resolved) throw new WorkFoldCliError("usage", "Act commands require an explicit --space <id-or-name>.");
    return resolved;
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
    dispositions: managementAttachmentDispositions(record),
    actions: record.actions,
    children,
    reply,
    source: record.source,
    remotePrincipalId: record.remotePrincipalId,
    remoteRequestId: record.remoteRequestId,
  };
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
    throw new WorkFoldCliError("notFound", "Task not found. Turn outcomes are kept while the Space app stays running.");
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

async function runActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkFoldCliError) throw error;
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : null;
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
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: finalText,
      createdAt: new Date().toISOString(),
    };
    await appendMessage(spaceRoot, conversationId, assistantMessage);
    settledMessageId = assistantMessage.id;
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
    broadcast(state, streamKey(spaceId, conversationId), { type: "done", conversationId });
  } catch (error) {
    const cancelled = isPiTurnCancelledError(error);
    let failureResultPreserved = false;
    if (!cancelled) {
      console.warn(`Assistant turn failed in ${spaceId}/${conversationId}: ${errorMessage(error)}`);
      const interruptedMessage = {
        id: randomUUID(),
        role: "assistant" as const,
        content: assistantFailureTranscriptContent(error),
        createdAt: new Date().toISOString(),
        interruption: {
          reason: assistantFailureReason(error),
          message: assistantFailurePublicDetail(error),
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
        console.error(`Could not preserve a failed Assistant result: ${errorMessage(preservationError)}`);
      }
    }
    const message = assistantTurnFailureMessage(error, failureResultPreserved);
    settledStatus = cancelled ? "aborted" : "failed";
    settledError = message;
    broadcast(state, streamKey(spaceId, conversationId), { type: "error", conversationId, message });
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
    state.runningTurns.delete(key);
    state.cancelledTurnTasks.delete(taskId);
    state.kernel.finishTask(taskId);
    if (spaceId === workFoldManagementScopeId) state.managementRequests.finish(taskId, settledStatus);
    settleTurnTask(state, taskId, {
      spaceId,
      conversationId,
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
    });
    broadcast(state, key, turnStateEvent(conversationId, false));
    changeTurnCount(state, -1);
  }
}

const maxSettledTurnRecords = 500;

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

function assistantFailureTranscriptContent(error: unknown): string {
  if (error instanceof PiTurnFailure) {
    return error.partialText || "The model stopped responding before it could finish a response.";
  }
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
): Promise<string[]> {
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
  return pendingRemovals.map((intent) => intent.spaceRoot);
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
  res.write(`data: ${JSON.stringify({ type: "status", conversationId, message: "Connected." })}\n\n`);
  res.write(`data: ${JSON.stringify(turnStateEvent(conversationId, state.runningTurns.has(key)))}\n\n`);
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
    try { res.write(": keepalive\n\n"); } catch { /* disconnected */ }
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

function broadcast(state: LocalApiState, key: string, event: unknown): void {
  for (const response of state.chatStreams.get(key) ?? []) {
    try { response.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* disconnected */ }
  }
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
  res.setHeader("access-control-allow-headers", "content-type,x-work-fold-session");
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
