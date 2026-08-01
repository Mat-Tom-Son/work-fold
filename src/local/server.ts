import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream, existsSync, watch } from "node:fs";
import { lstat, rm, stat } from "node:fs/promises";
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
  createConversation,
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
  removePiPackage,
  savePiApiKey,
  setPiDefaultModel,
  updatePiPackages,
  type PiOAuthHooks,
  type PiSetupStatus,
} from "./agent/pi-runtime-config.js";
import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment } from "./conversation-context.js";
import {
  createWorkspaceCheckpoint,
  createWorkspaceMutationCheckpoint,
  discardWorkspaceCheckpoint,
  listFileVersions,
  listWorkspaceCheckpoints,
  restoreFileVersion,
  restoreWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
} from "./history.js";
import {
  copyResourcesToWorkspace,
  createResourceFolder,
  listResourceTree,
  uploadResourceFiles,
} from "./resources.js";
import { searchWorkspace } from "./search.js";
import { SpaceAppearanceStore } from "./space-appearance-store.js";
import { conversationTitleFromFirstUserMessage } from "../shared/chat-title.js";
import { spaceAppearanceBannerNames } from "../shared/space-appearance.js";
import { WorkspaceCheckOperationConflictError, WorkspaceCheckService } from "./checks/check-service.js";
import type { WorkspaceCheckDecisionKind } from "./checks/check-types.js";
import { purgeWorkspaceCheckState } from "./checks/check-store.js";
import { ensureManagementInstructions } from "./management-instructions.js";
import {
  configureWorkspaceStateRoot,
  restrictedAppRoot,
  workspaceManagementRoot,
  workspaceManagementScopeId,
} from "./state-paths.js";
import { WorkspaceKernel } from "./workspace-kernel.js";
import { WorkspaceCliError } from "./cli/protocol.js";
import type {
  WorkspaceActChatMessage,
  WorkspaceActChatState,
  WorkspaceActConversationRef,
  WorkspaceActFacade,
  WorkspaceActSpaceRef,
  WorkspaceActTurnStatus,
} from "./cli/act-facade.js";
import { resolveWorkspaceCliSpaceSelector } from "./workspace-cli-adapter.js";
import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
} from "./server-dev-options.js";
import { isAlwaysHiddenWorkspaceEntry, isWorkspaceIgnored, readWorkspaceIgnoreState, setWorkspaceIgnoreState } from "./workspace-ignore.js";
import { canonicalWorkspaceWatchRoot } from "./workspace-watch.js";
import {
  beginWorkspaceRemoval,
  copyPathIntoWorkspace,
  createManagedWorkspace,
  createWorkspaceFolder,
  createWorkspaceTextFile,
  deleteWorkspaceEntry,
  finalizeWorkspaceRemoval,
  findExistingWorkspaceFilePaths,
  getWorkspace,
  getWorkspaceEntryInfo,
  listWorkspaces,
  listPendingWorkspaceRemovals,
  markWorkspaceRemovalAppStateRemoved,
  moveWorkspaceEntry,
  readWorkspaceTextFile,
  renameWorkspaceEntry,
  registerLinkedWorkspace,
  renameWorkspace,
  resolveWorkspacePath,
  scanWorkspaceTree,
  workspaceRemovalPendingResult,
  writeWorkspaceTextFile,
  writeUploadedFiles,
  type WorkspaceRemovalIo,
  type WorkspaceSummary,
} from "./workspace.js";

export interface LocalFolderGrantProvider {
  consumeLocalFolderGrant(input: { rootPath: string; grantId: string }): boolean | Promise<boolean>;
}

export interface LocalApiOptions {
  host?: "127.0.0.1";
  port?: number;
  appMode?: "dev" | "desktop";
  /** Root used only for managed workspace content. */
  workspaceBase?: string;
  /** Workspace app data: registry, chats, Pi sessions, resources, history. */
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
  kernel?: WorkspaceKernel;
  /** Shared with the desktop read CLI and interactive act facade. */
  checkService?: WorkspaceCheckService;
  /** Shared with the desktop kernel so registry trust changes apply everywhere. */
  spaceTrustAuthority?: RegisteredSpaceTrustAuthority;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  /** Failure-injection seam for the durable Space-removal coordinator. */
  workspaceRemovalIo?: Partial<WorkspaceRemovalIo>;
  /** Failure-injection seam that runs immediately before mandatory post-reservation Space validation. */
  beforeRestrictedAppWorkspaceRevalidation?: (workspaceId: string) => Promise<void>;
  maxBodyBytes?: number;
  loadEnv?: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  onHistoryCheckpoint?: (event: {
    workspaceId: string;
    conversationId: string;
    reason: "pre_turn" | "post_turn";
    checkpointId: string;
    skippedLargeFiles: string[];
  }) => void;
}

export interface LocalApiHandle {
  origin: string;
  port: number;
  kernel: WorkspaceKernel;
  /** In-process authority for CLI act-lane commands; see cli/act-facade.ts. */
  actFacade: WorkspaceActFacade;
  close: () => Promise<void>;
}

interface LocalApiState {
  appMode: "dev" | "desktop";
  workspaceBase?: string;
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
  kernel: WorkspaceKernel;
  checks: WorkspaceCheckService;
  spaceTrustAuthority: RegisteredSpaceTrustAuthority;
  managementInstructionsError: string | null;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  workspaceRemovalIo: Partial<WorkspaceRemovalIo>;
  beforeRestrictedAppWorkspaceRevalidation?: (workspaceId: string) => Promise<void>;
  chatStreams: Map<string, Set<ServerResponse>>;
  clients: Map<string, PiConversationClient>;
  runningTurns: Set<string>;
  activeTurnTasks: Map<string, { workspaceId: string; conversationId: string }>;
  settledTurns: Map<string, SettledTurnRecord>;
  compactingConversations: Set<string>;
  capabilityMutations: Set<string>;
  checkRunReservations: Set<string>;
  workspaceIdsByRoot: Map<string, string>;
  extensionRequests: Map<string, PiExtensionUiRequest>;
  fileStreams: Set<() => void>;
  activeTurns: number;
  onAgentTurnActivity?: (activeTurns: number) => void;
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
  workspaceId: string;
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
  configureWorkspaceStateRoot(options.stateBase ?? developmentDefaults?.stateBase);
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? developmentDefaults?.port ?? numberFromEnv("WORKSPACE_LOCAL_API_PORT", 4327);
  const extensionUi = options.extensionUiBridge ?? new RoutedPiExtensionUiBridge();
  const extensionRuntimeProvider: PiRuntimeProvider = {
    async resolveRuntime(workspaceRoot) {
      const runtime = await options.piRuntimeProvider?.resolveRuntime(workspaceRoot) ?? {};
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
  const recoveredWorkspaceRoots = await recoverPendingWorkspaceRemovals(
    restrictedApps,
    restrictedAppProposals,
    options.workspaceRemovalIo ?? {},
  );
  const pendingWorkspaceIds = (await listPendingWorkspaceRemovals()).map((intent) => intent.workspaceId);
  const appearance = options.appearanceStore ?? await SpaceAppearanceStore.create({
    normalize: { allowedBannerNames: new Set(spaceAppearanceBannerNames) },
  });
  const spaceTrustAuthority = options.spaceTrustAuthority
    ?? new RegisteredSpaceTrustAuthority((await listWorkspaces()).map((workspace) => workspace.rootPath));
  for (const rootPath of recoveredWorkspaceRoots) spaceTrustAuthority.revoke(rootPath);
  // The management scope's root is app-owned state, so authorizing its
  // runtime is an application decision rather than a registration ceremony.
  // The only project configuration under it is what Workspace itself
  // materializes here: the management AGENTS.md context file and the
  // manage-workspaces Skill.
  spaceTrustAuthority.grant(workspaceManagementRoot());
  let managementInstructionsError: string | null = null;
  try {
    await ensureManagementInstructions();
  } catch (error) {
    managementInstructionsError = errorMessage(error);
    console.warn(`Workspace could not materialize the management instructions; the management conversation is unavailable: ${managementInstructionsError}`);
  }
  const runtimeProvider = new RegisteredSpaceRuntimeProvider(extensionRuntimeProvider, spaceTrustAuthority);
  const kernel = options.kernel ?? new WorkspaceKernel({ runtimeProvider });
  const checks = options.checkService ?? new WorkspaceCheckService({ kernel });
  const state: LocalApiState = {
    appMode,
    workspaceBase: options.workspaceBase ? resolve(options.workspaceBase) : undefined,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"],
    sessionToken: options.sessionToken,
    maxBodyBytes: options.maxBodyBytes ?? numberFromEnv("WORKSPACE_LOCAL_MAX_BODY_BYTES", 100 * 1024 * 1024),
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
    workspaceRemovalIo: options.workspaceRemovalIo ?? {},
    beforeRestrictedAppWorkspaceRevalidation: options.beforeRestrictedAppWorkspaceRevalidation,
    chatStreams: new Map(),
    clients: new Map(),
    runningTurns: new Set(),
    activeTurnTasks: new Map(),
    settledTurns: new Map(),
    compactingConversations: new Set(),
    capabilityMutations: new Set(),
    checkRunReservations: new Set(),
    workspaceIdsByRoot: new Map(),
    extensionRequests: new Map(),
    fileStreams: new Set(),
    activeTurns: 0,
    onAgentTurnActivity: options.onAgentTurnActivity,
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
  try {
    restrictedApps.startAutomations(pendingWorkspaceIds);
  } catch (error) {
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
    actFacade: createWorkspaceActFacade(state),
    close: async () => {
      extensionUi.off("request", requestListener);
      extensionUi.off("event", eventListener);
      extensionUi.off("settled", settledListener);
      restrictedAppProposals.off("request", proposalListener);
      restrictedAppProposals.off("settled", proposalSettledListener);
      extensionUi.cancelAll();
      for (const streams of state.chatStreams.values()) for (const response of streams) response.end();
      for (const close of [...state.fileStreams]) close();
      for (const client of state.clients.values()) await client.stop().catch(() => undefined);
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
    sendJson(res, { ok: true, app: "Workspace", mode: state.appMode });
    return;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const workspaces = (await state.kernel.getSpaces({ kind: "renderer" })).spaces;
    const agent = workspaces[0] ? await safeAgentStatus(workspaces[0].rootPath, state.runtimeProvider) : emptyAgentStatus();
    sendJson(res, { workspaces, agent, appearance: state.appearance.snapshot() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/appearance") {
    sendJson(res, { appearance: state.appearance.snapshot() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/appearance/migrate") {
    const body = await readJsonBody<{ customizations?: unknown }>(state, req);
    const workspaceIds = new Set((await state.kernel.getSpaces({ kind: "renderer" })).spaces.map((workspace) => workspace.id));
    const appearance = await state.appearance.importLegacy(body.customizations, workspaceIds);
    sendJson(res, { appearance });
    return;
  }

  const checksStatusMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/status$/);
  if (checksStatusMatch && method === "GET") {
    const workspace = await getWorkspace(checksStatusMatch[1]);
    sendJson(res, { status: await state.checks.status(workspace) });
    return;
  }

  const checksDecorationsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/decorations$/);
  if (checksDecorationsMatch && method === "GET") {
    const workspace = await getWorkspace(checksDecorationsMatch[1]);
    sendJson(res, { decorations: await state.checks.decorations(workspace) });
    return;
  }

  const checksOverviewMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/overview$/);
  if (checksOverviewMatch && method === "POST") {
    const workspace = await getWorkspace(checksOverviewMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const overview = await runReservedCheckOperation(
      state,
      workspace.id,
      () => state.checks.overview(workspace),
    );
    sendJson(res, { overview });
    return;
  }

  const checksRunMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/run$/);
  if (checksRunMatch && method === "POST") {
    const workspace = await getWorkspace(checksRunMatch[1]);
    const body = await readJsonBody<{ checkId?: string }>(state, req);
    if (body.checkId !== undefined && typeof body.checkId !== "string") throw badRequest("Check id must be a string.");
    const checkId = body.checkId?.trim();
    const accepted = await runReservedCheckOperation(state, workspace.id, () => state.checks.run({
      space: workspace,
      ...(checkId ? { checkId } : {}),
      actor: { kind: "renderer", cwd: workspace.rootPath, workspaceId: workspace.id },
    }));
    sendJson(res, { task: accepted }, 202);
    return;
  }

  const checksTaskMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/tasks\/([^/]+)$/);
  if (checksTaskMatch && method === "GET") {
    const workspace = await getWorkspace(checksTaskMatch[1]);
    sendJson(res, { task: await state.checks.taskStatus(workspace.id, checksTaskMatch[2]) });
    return;
  }

  const checksAbortMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/tasks\/([^/]+)\/abort$/);
  if (checksAbortMatch && method === "POST") {
    const workspace = await getWorkspace(checksAbortMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const aborted = await runReservedCheckOperation(
      state,
      workspace.id,
      () => state.checks.abort(workspace.id, checksAbortMatch[2]),
    );
    sendJson(res, { taskId: checksAbortMatch[2], aborted });
    return;
  }

  const checksDecisionMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/checks\/findings\/([^/]+)\/decision$/);
  if (checksDecisionMatch && method === "POST") {
    const workspace = await getWorkspace(checksDecisionMatch[1]);
    const body = await readJsonBody<{ decision?: WorkspaceCheckDecisionKind; deferUntil?: string }>(state, req);
    const decisionKind = body.decision;
    if (!isWorkspaceCheckDecisionKind(decisionKind)) throw badRequest("Choose a valid Check decision.");
    if (body.deferUntil !== undefined && typeof body.deferUntil !== "string") throw badRequest("Check deferUntil must be a timestamp.");
    const decision = await runReservedCheckOperation(state, workspace.id, () => state.checks.decide({
      spaceId: workspace.id,
      findingId: checksDecisionMatch[2],
      decision: decisionKind,
      actor: "renderer",
      ...(body.deferUntil ? { deferUntil: body.deferUntil } : {}),
    }));
    sendJson(res, { findingId: checksDecisionMatch[2], decision });
    return;
  }

  if (method === "POST" && url.pathname === "/api/workspaces") {
    const body = await readJsonBody<{ name?: string }>(state, req);
    const workspace = await runCheckSpaceRegistryMutation(
      state,
      () => createSpaceInternal(state, body.name ?? "Personal Space"),
    );
    sendJson(res, { workspace }, 201);
    return;
  }

  if (method === "POST" && url.pathname === "/api/workspaces/local-folder") {
    const body = await readJsonBody<{ rootPath?: string; folderGrantId?: string; providerHint?: "google-drive" }>(state, req);
    if (!body.rootPath?.trim()) throw badRequest("Choose a local folder to turn into a Space.");
    if (state.localFolderGrantProvider) {
      if (!body.folderGrantId || !await state.localFolderGrantProvider.consumeLocalFolderGrant({ rootPath: body.rootPath, grantId: body.folderGrantId })) {
        throw forbidden("The folder selection expired. Choose the folder again to create the Space.");
      }
    } else if (state.appMode === "desktop") {
      throw forbidden("A folder must be selected in the desktop app before it can become a Space.");
    }
    const workspace = await runCheckSpaceRegistryMutation(
      state,
      () => registerSpaceInternal(state, body.rootPath!, body.providerHint),
    );
    sendJson(res, { workspace }, 201);
    return;
  }

  const workspaceMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)$/);
  if (workspaceMatch && (method === "PUT" || method === "PATCH")) {
    const body = await readJsonBody<{ name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A Space name is required.");
    sendJson(res, { workspace: await renameWorkspace(workspaceMatch[1], body.name) });
    return;
  }
  if (workspaceMatch && method === "DELETE") {
    const workspace = await getWorkspace(workspaceMatch[1]);
    const affectedWorkspaceIds = await state.restrictedApps.workspaceRemovalMutationWorkspaceIds(workspace.id);
    const removal = await runRestrictedAppMutations(state, affectedWorkspaceIds, async () => {
      const releaseCheckRemoval = state.checks.tryReserveSpaceRemoval(workspace.id);
      if (!releaseCheckRemoval) throw httpError(409, "Wait for the current Check operation before removing this Space.");
      try {
        const impact = await state.restrictedApps.workspaceRemovalImpact(workspace.id);
        if (impact.activeSourceInstanceCount > 0 || impact.activeTargetInstanceCount > 0) {
          throw badRequest("Uninstall release-backed Apps from this Space before removing it.");
        }
        if (impact.retainedDataCount > 0) {
          throw badRequest("Purge this App Project's retained local data in App Studio before removing its source Space.");
        }
        const intent = await beginWorkspaceRemoval(workspace.id, state.workspaceBase, state.workspaceRemovalIo);
        state.restrictedApps.fenceWorkspaceRemoval(workspace.id);
        state.spaceTrustAuthority.revoke(workspace.rootPath);
        state.workspaceIdsByRoot.delete(workspaceRootKey(workspace.rootPath));
        await invalidateWorkspaceClients(state, workspace.id);
        closeWorkspaceStreams(state, workspace.id);
        for (const request of [...state.extensionRequests.values()]) {
          if (request.workspaceRoot !== workspace.rootPath) continue;
          state.extensionUi.cancel(request.id);
          state.extensionRequests.delete(request.id);
        }
        try {
          await state.checks.removeSpace(workspace.id);
        } catch {
          return workspaceRemovalPendingResult(intent);
        }
        try {
          await state.restrictedApps.removeWorkspace(workspace.id);
          await state.restrictedAppProposals.removeWorkspace(workspace.id);
        } catch {
          return workspaceRemovalPendingResult(intent);
        }
        try {
          await markWorkspaceRemovalAppStateRemoved(intent.workspaceId, state.workspaceRemovalIo);
        } catch {
          return workspaceRemovalPendingResult(intent);
        }
        const result = await finalizeWorkspaceRemoval(intent.workspaceId, state.workspaceRemovalIo);
        if (!result.cleanupPending) await state.appearance.removeWorkspace(workspace.id);
        if (!result.cleanupPending) state.restrictedApps.releaseWorkspaceRemovalFence(workspace.id);
        return result;
      } finally {
        releaseCheckRemoval();
      }
    }, { requiredWorkspaceIds: [workspace.id] });
    sendJson(res, removal);
    return;
  }

  const workspaceAppearanceMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/appearance$/);
  if (workspaceAppearanceMatch && method === "PUT") {
    const workspace = await getWorkspace(workspaceAppearanceMatch[1]);
    const body = await readJsonBody<{ customization?: unknown }>(state, req);
    if (!body.customization || typeof body.customization !== "object" || Array.isArray(body.customization)) {
      throw badRequest("A Space appearance object is required.");
    }
    const appearance = await state.appearance.replaceWorkspace(
      workspace.id,
      body.customization,
    );
    sendJson(res, { appearance });
    return;
  }
  if (workspaceAppearanceMatch && method === "DELETE") {
    const workspace = await getWorkspace(workspaceAppearanceMatch[1]);
    sendJson(res, { appearance: await state.appearance.removeWorkspace(workspace.id) });
    return;
  }

  const proposalCollectionMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals$/);
  if (proposalCollectionMatch && method === "GET") {
    const workspace = await getWorkspace(proposalCollectionMatch[1]);
    if (!(await readConversation(workspace.rootPath, proposalCollectionMatch[2])).length) throw notFound("Conversation not found.");
    const proposals = await state.restrictedAppProposals.list({ workspaceId: workspace.id, conversationId: proposalCollectionMatch[2] });
    sendJson(res, { proposals: proposals.map(rendererRestrictedAppProposal) });
    return;
  }
  const proposalInstallMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals\/([^/]+)\/install$/);
  if (proposalInstallMatch && method === "POST") {
    const workspace = await getWorkspace(proposalInstallMatch[1]);
    const proposal = await state.restrictedAppProposals.get(proposalInstallMatch[3]);
    if (!proposal || proposal.workspaceId !== workspace.id || proposal.conversationId !== proposalInstallMatch[2]) throw notFound("App proposal not found.");
    const app = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedAppProposals.install(proposal.id));
    if (!app) throw httpError(409, "This app proposal is no longer available to install.");
    sendJson(res, { app, proposal: rendererRestrictedAppProposal((await state.restrictedAppProposals.get(proposal.id))!) }, 201);
    return;
  }
  const proposalMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/restricted-app-proposals\/([^/]+)$/);
  if (proposalMatch && method === "DELETE") {
    const workspace = await getWorkspace(proposalMatch[1]);
    const proposal = await state.restrictedAppProposals.get(proposalMatch[3]);
    if (!proposal || proposal.workspaceId !== workspace.id || proposal.conversationId !== proposalMatch[2]) throw notFound("App proposal not found.");
    sendJson(res, { dismissed: await state.restrictedAppProposals.dismiss(proposal.id) });
    return;
  }

  const localAppStudioMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio$/);
  if (localAppStudioMatch && method === "GET") {
    const workspace = await getWorkspace(localAppStudioMatch[1]);
    sendJson(res, { studio: await state.restrictedApps.localAppStudio(workspace.id) });
    return;
  }

  const localAppRemovalImpactMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-removal-impact$/);
  if (localAppRemovalImpactMatch && method === "GET") {
    const workspace = await getWorkspace(localAppRemovalImpactMatch[1]);
    sendJson(res, { impact: await state.restrictedApps.workspaceRemovalImpact(workspace.id) });
    return;
  }
  if (localAppStudioMatch && method === "PUT") {
    const workspace = await getWorkspace(localAppStudioMatch[1]);
    const body = await readJsonBody<{ title?: unknown; description?: unknown; icon?: unknown }>(state, req);
    if (typeof body.title !== "string"
      || (body.description !== undefined && body.description !== null && typeof body.description !== "string")
      || (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string")) {
      throw badRequest("An App title plus optional text description and icon id are required.");
    }
    const title = body.title;
    const description = body.description === undefined ? null : body.description;
    const icon = body.icon === undefined ? null : body.icon;
    const project = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.declareLocalAppProject({
      workspaceId: workspace.id,
      presentation: { title, description, icon },
    }));
    sendJson(res, { project });
    return;
  }

  const localAppReleasePrepareMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/releases\/prepare$/);
  if (localAppReleasePrepareMatch && method === "POST") {
    const workspace = await getWorkspace(localAppReleasePrepareMatch[1]);
    const body = await readJsonBody<{ displayVersion?: unknown }>(state, req);
    if (typeof body.displayVersion !== "string" || !body.displayVersion.trim()) throw badRequest("A Release version is required.");
    const displayVersion = body.displayVersion;
    const prepared = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.prepareLocalAppRelease({
      workspaceId: workspace.id,
      displayVersion,
    }));
    sendJson(res, { release: prepared }, 201);
    return;
  }

  const localAppReleasePublishMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/releases\/publish$/);
  if (localAppReleasePublishMatch && method === "POST") {
    const workspace = await getWorkspace(localAppReleasePublishMatch[1]);
    const body = await readJsonBody<{ releaseDigest?: unknown }>(state, req);
    if (typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) throw badRequest("A prepared Release digest is required.");
    const releaseDigest = body.releaseDigest;
    const release = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.publishLocalAppRelease({
      workspaceId: workspace.id,
      releaseDigest,
    }));
    sendJson(res, { release });
    return;
  }

  const localAppReleaseMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/releases\/([^/]+)$/);
  if (localAppReleaseMatch && method === "DELETE") {
    const workspace = await getWorkspace(localAppReleaseMatch[1]);
    const releaseDigest = localAppReleaseMatch[2];
    const deletion = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.deleteLocalAppRelease({
      workspaceId: workspace.id,
      releaseDigest,
    }));
    sendJson(res, { deletion });
    return;
  }

  const localAppInstallPrepareMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/installs\/prepare$/);
  if (localAppInstallPrepareMatch && method === "POST") {
    const source = await getWorkspace(localAppInstallPrepareMatch[1]);
    const body = await readJsonBody<{ targetWorkspaceId?: unknown; releaseDigest?: unknown }>(state, req);
    if (typeof body.targetWorkspaceId !== "string" || !body.targetWorkspaceId.trim()
      || typeof body.releaseDigest !== "string" || !body.releaseDigest.trim()) {
      throw badRequest("A target Space and published Release are required.");
    }
    const targetWorkspaceId = body.targetWorkspaceId;
    const releaseDigest = body.releaseDigest;
    const target = await getWorkspace(targetWorkspaceId);
    const operation = await runRestrictedAppMutations(state, [source.id, target.id], () => state.restrictedApps.prepareLocalAppInstall({
      sourceWorkspaceId: source.id,
      targetWorkspaceId: target.id,
      releaseDigest,
    }));
    sendJson(res, { operation }, 201);
    return;
  }

  const localAppOperationActivateMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/operations\/([^/]+)\/activate$/);
  if (localAppOperationActivateMatch && method === "POST") {
    const source = await getWorkspace(localAppOperationActivateMatch[1]);
    const studio = await state.restrictedApps.localAppStudio(source.id);
    const operation = studio.operations.find((item) => item.operationId === localAppOperationActivateMatch[2]);
    if (!operation) throw notFound("Prepared App operation not found.");
    const target = await getWorkspace(operation.targetWorkspaceId);
    const result = await runRestrictedAppMutations(state, [source.id, target.id], () => operation.kind === "install"
      ? state.restrictedApps.activateLocalAppInstall(operation.operationId)
      : state.restrictedApps.activateLocalAppUpdate(operation.operationId));
    sendJson(res, result);
    return;
  }
  const localAppOperationMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/operations\/([^/]+)$/);
  if (localAppOperationMatch && method === "DELETE") {
    const source = await getWorkspace(localAppOperationMatch[1]);
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

  const localAppUpdatePrepareMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/instances\/([^/]+)\/updates\/prepare$/);
  if (localAppUpdatePrepareMatch && method === "POST") {
    const source = await getWorkspace(localAppUpdatePrepareMatch[1]);
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
    const target = await getWorkspace(instance.workspaceId);
    const operation = await runRestrictedAppMutations(state, [source.id, target.id], () => state.restrictedApps.prepareLocalAppUpdate({
      sourceWorkspaceId: source.id,
      runtimeInstanceId: instance.runtimeInstanceId,
      releaseDigest,
      ...(continuityPolicy ? { continuityPolicy } : {}),
    }));
    sendJson(res, { operation }, 201);
    return;
  }

  const localAppInstanceMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/local-app-instances\/([^/]+)$/);
  if (localAppInstanceMatch && method === "DELETE") {
    const workspace = await getWorkspace(localAppInstanceMatch[1]);
    const body = await readJsonBody<{ dataDisposition?: "retain" | "purge" }>(state, req);
    if (body.dataDisposition !== "retain" && body.dataDisposition !== "purge") {
      throw badRequest("Choose whether to retain or purge this App's local data.");
    }
    const installed = (await state.restrictedApps.list(workspace.id)).find((app) => (
      app.runtimeInstanceKind === "app" && app.runtimeInstanceId === localAppInstanceMatch[2]
    ));
    if (!installed) throw notFound("Local App Instance not found.");
    const result = await runRestrictedAppMutations(state, [installed.sourceWorkspaceId, workspace.id], () => state.restrictedApps.uninstallLocalApp({
      runtimeInstanceId: localAppInstanceMatch[2],
      dataDisposition: body.dataDisposition!,
    }), { requiredWorkspaceIds: [workspace.id] });
    sendJson(res, result);
    return;
  }

  const localAppRetainedDataMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/app-studio\/retained-data\/([^/]+)$/);
  if (localAppRetainedDataMatch && method === "DELETE") {
    const source = await getWorkspace(localAppRetainedDataMatch[1]);
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

  const restrictedCollectionMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps$/);
  if (restrictedCollectionMatch && method === "GET") {
    const workspace = await getWorkspace(restrictedCollectionMatch[1]);
    sendJson(res, { apps: await state.restrictedApps.list(workspace.id) });
    return;
  }
  if (restrictedCollectionMatch && method === "POST") {
    const workspace = await getWorkspace(restrictedCollectionMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; expectedDigest?: string }>(state, req);
    if (!body.sourcePath?.trim() || !body.expectedDigest?.trim()) throw badRequest("A reviewed package folder and digest are required.");
    const app = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.install({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      sourcePath: body.sourcePath!,
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app }, 201);
    return;
  }

  const restrictedInspectMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/inspect$/);
  if (restrictedInspectMatch && method === "POST") {
    const workspace = await getWorkspace(restrictedInspectMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("A Space-relative package folder is required.");
    sendJson(res, { review: await state.restrictedApps.inspect({
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      sourcePath: body.sourcePath,
    }) });
    return;
  }

  const restrictedItemMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)$/);
  if (restrictedItemMatch && method === "DELETE") {
    const workspace = await getWorkspace(restrictedItemMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    const removed = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.remove({
      workspaceId: workspace.id,
      appId: restrictedItemMatch[2],
      ...(body.expectedDigest ? { expectedDigest: body.expectedDigest } : {}),
    }));
    sendJson(res, { removed });
    return;
  }

  const restrictedInvokeMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/invoke$/);
  if (restrictedInvokeMatch && method === "POST") {
    const workspace = await getWorkspace(restrictedInvokeMatch[1]);
    assertNoCapabilityMutationForTurn(state, workspace.id);
    const body = await readJsonBody<{ expectedDigest?: string; action?: string; input?: unknown }>(state, req);
    if (!body.expectedDigest?.trim() || !body.action?.trim()) throw badRequest("An installed revision and action are required.");
    assertNoCapabilityMutationForTurn(state, workspace.id);
    const result = await state.restrictedApps.invoke({
      workspaceId: workspace.id,
      appId: restrictedInvokeMatch[2],
      expectedDigest: body.expectedDigest,
      action: body.action,
      input: body.input,
    });
    sendJson(res, { result });
    return;
  }

  const restrictedConnectionsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/connections$/);
  if (restrictedConnectionsMatch && method === "GET") {
    const workspace = await getWorkspace(restrictedConnectionsMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    sendJson(res, { connections: await state.restrictedApps.connectionStatus(
      workspace.id,
      restrictedConnectionsMatch[2],
      expectedDigest,
    ) });
    return;
  }

  const restrictedNetworkGrantMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/network\/([^/]+)$/);
  if (restrictedNetworkGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workspace = await getWorkspace(restrictedNetworkGrantMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const operation = method === "PUT" ? state.restrictedApps.grantNetwork.bind(state.restrictedApps) : state.restrictedApps.revokeNetwork.bind(state.restrictedApps);
    const app = await runRestrictedAppMutation(state, workspace.id, () => operation({
      workspaceId: workspace.id,
      appId: restrictedNetworkGrantMatch[2],
      destinationId: restrictedNetworkGrantMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedFileGrantMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/files\/([^/]+)$/);
  if (restrictedFileGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workspace = await getWorkspace(restrictedFileGrantMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string; root?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const app = await runRestrictedAppMutation(state, workspace.id, () => method === "PUT"
      ? state.restrictedApps.grantFiles({
          workspaceId: workspace.id,
          workspaceRoot: workspace.rootPath,
          appId: restrictedFileGrantMatch[2],
          permissionId: restrictedFileGrantMatch[3],
          expectedDigest: body.expectedDigest!,
          root: body.root ?? "",
        })
      : state.restrictedApps.revokeFiles({
          workspaceId: workspace.id,
          appId: restrictedFileGrantMatch[2],
          permissionId: restrictedFileGrantMatch[3],
          expectedDigest: body.expectedDigest!,
        }));
    sendJson(res, { app });
    return;
  }

  const restrictedNotificationGrantMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/permissions\/notifications\/([^/]+)$/);
  if (restrictedNotificationGrantMatch && (method === "PUT" || method === "DELETE")) {
    const workspace = await getWorkspace(restrictedNotificationGrantMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const operation = method === "PUT"
      ? state.restrictedApps.grantNotifications.bind(state.restrictedApps)
      : state.restrictedApps.revokeNotifications.bind(state.restrictedApps);
    const app = await runRestrictedAppMutation(state, workspace.id, () => operation({
      workspaceId: workspace.id,
      appId: restrictedNotificationGrantMatch[2],
      permissionId: restrictedNotificationGrantMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedAutomationRunMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)\/run$/);
  if (restrictedAutomationRunMatch && method === "POST") {
    const workspace = await getWorkspace(restrictedAutomationRunMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const result = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.runAutomationNow({
      workspaceId: workspace.id,
      appId: restrictedAutomationRunMatch[2],
      automationId: restrictedAutomationRunMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, result);
    return;
  }

  const restrictedAutomationRunsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)\/runs$/);
  if (restrictedAutomationRunsMatch && method === "GET") {
    const workspace = await getWorkspace(restrictedAutomationRunsMatch[1]);
    const expectedDigest = url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    const runs = await state.restrictedApps.listAutomationRuns(
      workspace.id,
      restrictedAutomationRunsMatch[2],
      expectedDigest,
      restrictedAutomationRunsMatch[3],
    );
    sendJson(res, { runs });
    return;
  }

  const restrictedAutomationMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/automations\/([^/]+)$/);
  if (restrictedAutomationMatch && (method === "PUT" || method === "DELETE")) {
    const workspace = await getWorkspace(restrictedAutomationMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const app = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.setAutomationEnabled({
      workspaceId: workspace.id,
      appId: restrictedAutomationMatch[2],
      automationId: restrictedAutomationMatch[3],
      expectedDigest: body.expectedDigest!,
      enabled: method === "PUT",
    }));
    sendJson(res, { app });
    return;
  }

  const restrictedStorageMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/storage$/);
  if (restrictedStorageMatch && (method === "GET" || method === "DELETE")) {
    const workspace = await getWorkspace(restrictedStorageMatch[1]);
    const body = method === "DELETE" ? await readJsonBody<{ expectedDigest?: string }>(state, req) : null;
    const expectedDigest = body?.expectedDigest ?? url.searchParams.get("expectedDigest")?.trim();
    if (!expectedDigest) throw badRequest("An installed revision is required.");
    const usage = method === "DELETE"
      ? await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.clearStorage(
          workspace.id,
          restrictedStorageMatch[2],
          expectedDigest,
        ))
      : await state.restrictedApps.storageUsage(workspace.id, restrictedStorageMatch[2], expectedDigest);
    sendJson(res, { usage });
    return;
  }

  const restrictedOAuthMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/connections\/([^/]+)\/oauth$/);
  if (restrictedOAuthMatch && method === "POST") {
    const workspace = await getWorkspace(restrictedOAuthMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const connection = await runRestrictedAppMutation(state, workspace.id, () => state.restrictedApps.connectOAuth({
      workspaceId: workspace.id,
      appId: restrictedOAuthMatch[2],
      destinationId: restrictedOAuthMatch[3],
      expectedDigest: body.expectedDigest!,
    }));
    sendJson(res, { connection });
    return;
  }

  const restrictedConnectionMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/restricted-apps\/([^/]+)\/connections\/([^/]+)$/);
  if (restrictedConnectionMatch && (method === "PUT" || method === "DELETE")) {
    const workspace = await getWorkspace(restrictedConnectionMatch[1]);
    const body = await readJsonBody<{ expectedDigest?: string; credential?: unknown }>(state, req);
    if (!body.expectedDigest?.trim()) throw badRequest("An installed revision is required.");
    const result = await runRestrictedAppMutation(state, workspace.id, async () => {
      if (method === "DELETE") {
        return { removed: await state.restrictedApps.deleteConnection({
          workspaceId: workspace.id,
          appId: restrictedConnectionMatch[2],
          destinationId: restrictedConnectionMatch[3],
          expectedDigest: body.expectedDigest!,
        }) };
      }
      return { connection: await state.restrictedApps.setConnection({
        workspaceId: workspace.id,
        appId: restrictedConnectionMatch[2],
        destinationId: restrictedConnectionMatch[3],
        expectedDigest: body.expectedDigest!,
        credential: body.credential,
      }) };
    });
    sendJson(res, result);
    return;
  }

  const searchMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/search$/);
  if (method === "GET" && searchMatch) {
    const workspace = await getWorkspace(searchMatch[1]);
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "files" && scope !== "chats") throw badRequest("Search scope is unsupported.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const result = await searchWorkspace(workspace.rootPath, url.searchParams.get("q") ?? "", {
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

  const treeMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/tree$/);
  if (method === "GET" && treeMatch) {
    const workspace = await getWorkspace(treeMatch[1]);
    const maxDepthValue = Number(url.searchParams.get("maxDepth") ?? 20);
    const maxDepth = Number.isFinite(maxDepthValue) ? Math.min(Math.max(Math.floor(maxDepthValue), 0), 50) : 20;
    const scan = await scanWorkspaceTree(
      workspace.rootPath,
      maxDepth,
      url.searchParams.get("path") ?? "",
      { includeIgnored: url.searchParams.get("includeIgnored") !== "0" },
    );
    sendJson(res, { tree: scan.entries, truncated: scan.truncated });
    return;
  }

  const fileMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/file$/);
  if (method === "GET" && fileMatch) {
    const workspace = await getWorkspace(fileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    sendJson(res, await readWorkspaceTextFile(workspace.rootPath, path));
    return;
  }
  if (method === "PUT" && fileMatch) {
    const workspace = await getWorkspace(fileMatch[1]);
    const body = await readJsonBody<{ path?: string; text?: string }>(state, req);
    if (!body.path?.trim() || typeof body.text !== "string") throw badRequest("A file path and text are required.");
    const safety = await createWorkspaceMutationCheckpoint(workspace.rootPath, {
      paths: [body.path],
      reason: "pre_edit",
      label: `Before editing ${body.path}`,
    });
    const file = await runWithHistorySafety(workspace.rootPath, safety.checkpointId, () => writeWorkspaceTextFile(workspace.rootPath, body.path!, body.text!));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const fileInfoMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/file-info$/);
  if (method === "GET" && fileInfoMatch) {
    const workspace = await getWorkspace(fileInfoMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Space item path is required.");
    sendJson(res, await getWorkspaceEntryInfo(workspace.rootPath, path));
    return;
  }

  const pathsExistMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/paths-exist$/);
  if (method === "POST" && pathsExistMatch) {
    const workspace = await getWorkspace(pathsExistMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) {
      throw badRequest("Space paths must be an array of strings.");
    }
    sendJson(res, { existing: await findExistingWorkspaceFilePaths(workspace.rootPath, body.paths) });
    return;
  }

  const rawFileMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/raw-file$/);
  if (method === "GET" && rawFileMatch) {
    const workspace = await getWorkspace(rawFileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    await sendWorkspaceRawFile(res, workspace.rootPath, path);
    return;
  }

  const moveMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/move-local-entry$/);
  if (method === "POST" && moveMatch) {
    const workspace = await getWorkspace(moveMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; targetFolderPath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("Select a file or folder to move.");
    const moveSource = normalizeWorkspaceRelativePath(body.sourcePath);
    const moveTargetFolder = normalizeWorkspaceRelativePath(body.targetFolderPath ?? "");
    const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
    const safety = await createWorkspaceMutationCheckpoint(workspace.rootPath, {
      movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
      reason: "pre_move",
      label: `Before moving ${body.sourcePath}`,
    });
    const moved = await runWithHistorySafety(workspace.rootPath, safety.checkpointId, () => moveWorkspaceEntry(workspace.rootPath, {
      sourcePath: moveSource,
      targetFolderPath: body.targetFolderPath ?? "",
    }));
    sendJson(res, { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const renameMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/rename-local-entry$/);
  if (method === "POST" && renameMatch) {
    const workspace = await getWorkspace(renameMatch[1]);
    const body = await readJsonBody<{ path?: string; newName?: string }>(state, req);
    if (!body.path?.trim() || !body.newName?.trim()) throw badRequest("A Space item and new name are required.");
    const renameSource = normalizeWorkspaceRelativePath(body.path);
    const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
    const renameDestination = [renameParent, body.newName].filter(Boolean).join("/");
    const safety = await createWorkspaceMutationCheckpoint(workspace.rootPath, {
      movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
      reason: "pre_rename",
      label: `Before renaming ${body.path}`,
    });
    const renamed = await runWithHistorySafety(workspace.rootPath, safety.checkpointId, () => renameWorkspaceEntry(workspace.rootPath, { path: body.path!, newName: body.newName! }));
    sendJson(res, { renamed, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const foldersMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/folders$/);
  if (method === "POST" && foldersMatch) {
    const workspace = await getWorkspace(foldersMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A folder name is required.");
    const folderTarget = [normalizeWorkspaceRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createWorkspaceMutationCheckpoint(workspace.rootPath, {
      deleteOnRestore: [folderTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const folder = await runWithHistorySafety(workspace.rootPath, safety.checkpointId, () => createWorkspaceFolder(workspace.rootPath, body.parentPath ?? "", body.name!));
    sendJson(res, { folder, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const filesMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/files$/);
  if (method === "POST" && filesMatch) {
    const workspace = await getWorkspace(filesMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string; text?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A file name is required.");
    const fileTarget = [normalizeWorkspaceRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createWorkspaceMutationCheckpoint(workspace.rootPath, {
      deleteOnRestore: [fileTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const file = await runWithHistorySafety(workspace.rootPath, safety.checkpointId, () => createWorkspaceTextFile(workspace.rootPath, body.parentPath ?? "", body.name!, body.text ?? ""));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const deleteMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/local-file$/);
  if (method === "DELETE" && deleteMatch) {
    const workspace = await getWorkspace(deleteMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("Select a file or folder to delete.");
    const safety = await createWorkspaceMutationCheckpoint(workspace.rootPath, {
      paths: [body.path],
      reason: "pre_delete",
      label: `Before deleting ${body.path}`,
    });
    const deleted = await runWithHistorySafety(workspace.rootPath, safety.checkpointId, () => deleteWorkspaceEntry(workspace.rootPath, body.path!));
    sendJson(res, { ...deleted, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const ignoreMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/ignore-paths$/);
  if (method === "GET" && ignoreMatch) {
    const workspace = await getWorkspace(ignoreMatch[1]);
    sendJson(res, await readWorkspaceIgnoreState(workspace.rootPath));
    return;
  }
  if (method === "POST" && ignoreMatch) {
    const workspace = await getWorkspace(ignoreMatch[1]);
    const body = await readJsonBody<{ paths?: unknown; ignored?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || typeof body.ignored !== "boolean") {
      throw badRequest("Space paths and an ignore decision are required.");
    }
    sendJson(res, await setWorkspaceIgnoreState(workspace.rootPath, body.paths, body.ignored));
    return;
  }

  const fileEventsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/file-events$/);
  if (method === "GET" && fileEventsMatch) {
    const workspace = await getWorkspace(fileEventsMatch[1]);
    await openWorkspaceFileStream(state, req, res, workspace.rootPath);
    return;
  }

  const uploadMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/upload-local-files$/);
  if (method === "POST" && uploadMatch) {
    const workspace = await getWorkspace(uploadMatch[1]);
    const multipart = await readMultipartBody(state, req);
    const relativePaths = parseRelativePaths(multipart.fields.get("relativePaths"), multipart.files.length);
    const uploaded = await writeUploadedFiles(
      workspace.rootPath,
      multipart.fields.get("targetFolderPath") ?? "",
      multipart.files.map((file, index) => ({ fileName: file.fileName, relativePath: relativePaths[index], data: file.data })),
    );
    const safety = await checkpointAdditiveWritesOrUndo(workspace.rootPath, uploaded.map((file) => file.path), {
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
  if (method === "POST" && url.pathname === "/api/resources/copy-to-workspace") {
    const body = await readJsonBody<{ workspaceId?: string; paths?: string[]; targetFolder?: string }>(state, req);
    if (!body.workspaceId || !Array.isArray(body.paths)) throw badRequest("A Space and Library items are required.");
    const workspace = await getWorkspace(body.workspaceId);
    const copied = await copyResourcesToWorkspace(workspace.rootPath, body.paths, body.targetFolder ?? "From Library");
    const safety = await checkpointAdditiveWritesOrUndo(workspace.rootPath, copied, {
      reason: "pre_add",
      label: `Before adding ${copied.length} Library item${copied.length === 1 ? "" : "s"}`,
    });
    sendJson(res, { copied, safetyCheckpointId: safety?.checkpointId ?? null, historySkippedPaths: safety?.skippedLargeFiles ?? [] });
    return;
  }

  const checkpointCollectionMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/history\/checkpoints$/);
  if (checkpointCollectionMatch && method === "GET") {
    const workspace = await getWorkspace(checkpointCollectionMatch[1]);
    sendJson(res, { checkpoints: await listWorkspaceCheckpoints(workspace.rootPath) });
    return;
  }
  if (checkpointCollectionMatch && method === "POST") {
    const workspace = await getWorkspace(checkpointCollectionMatch[1]);
    const body = await readJsonBody<{ label?: string }>(state, req);
    sendJson(res, { checkpoint: await createWorkspaceCheckpoint(workspace.rootPath, { label: body.label, reason: "manual" }) }, 201);
    return;
  }
  const checkpointRestoreMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/history\/checkpoints\/([^/]+)\/restore$/);
  if (method === "POST" && checkpointRestoreMatch) {
    const workspace = await getWorkspace(checkpointRestoreMatch[1]);
    sendJson(res, await restoreWorkspaceCheckpoint(workspace.rootPath, checkpointRestoreMatch[2]));
    return;
  }

  const fileVersionsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/history\/file-versions$/);
  if (method === "GET" && fileVersionsMatch) {
    const workspace = await getWorkspace(fileVersionsMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A Space-relative file path is required.");
    sendJson(res, { path, versions: await listFileVersions(workspace.rootPath, path) });
    return;
  }
  if (method === "POST" && fileVersionsMatch) {
    const workspace = await getWorkspace(fileVersionsMatch[1]);
    const body = await readJsonBody<{ path?: string; hashSha256?: string }>(state, req);
    if (!body.path?.trim() || !body.hashSha256?.trim()) throw badRequest("A file path and version hash are required.");
    sendJson(res, { result: await restoreFileVersion(workspace.rootPath, body.path, body.hashSha256) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/agent/models") {
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) throw badRequest("Space id is required.");
    const workspace = await getWorkspace(workspaceId);
    const models = await listPiModels(workspace.rootPath, state.runtimeProvider);
    sendJson(res, {
      models: models.map((model) => ({
        ...model,
        oauthSupported: model.oauthSupported && Boolean(state.piOAuthHooks),
      })),
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/status") {
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) throw badRequest("Space id is required.");
    const workspace = await getWorkspace(workspaceId);
    sendJson(res, { status: await safeAgentStatus(workspace.rootPath, state.runtimeProvider) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/configure") {
    const body = await readJsonBody<{ workspaceId?: string; provider?: string; model?: string; apiKey?: string }>(state, req);
    const workspace = await configuredWorkspace(body.workspaceId, body.provider, body.model);
    const selected = (await listPiModels(workspace.rootPath, state.runtimeProvider))
      .find((model) => model.provider === body.provider && model.id === body.model);
    if (!selected) throw badRequest("The selected Pi model is not available in this Space.");
    if (!body.apiKey?.trim() && !selected.authConfigured) {
      throw badRequest(`Enter an API key for ${selected.providerName}.`);
    }
    if (body.apiKey?.trim()) {
      await savePiApiKey(workspace.rootPath, body.provider!, body.apiKey, { runtimeProvider: state.runtimeProvider });
    }
    await setPiDefaultModel(workspace.rootPath, { provider: body.provider!, id: body.model! }, state.runtimeProvider);
    await invalidateAllClients(state);
    sendJson(res, { status: normalizeStatus(await getPiSetupStatus(workspace.rootPath, state.runtimeProvider)) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/oauth") {
    if (!state.piOAuthHooks) throw unavailable("Provider account sign-in requires the Workspace desktop app. You can use an API key for this provider instead.");
    const body = await readJsonBody<{ workspaceId?: string; provider?: string; model?: string }>(state, req);
    const workspace = await configuredWorkspace(body.workspaceId, body.provider, body.model);
    await loginPiOAuth(workspace.rootPath, body.provider!, state.piOAuthHooks, state.runtimeProvider);
    await setPiDefaultModel(workspace.rootPath, { provider: body.provider!, id: body.model! }, state.runtimeProvider);
    await invalidateAllClients(state);
    sendJson(res, { status: normalizeStatus(await getPiSetupStatus(workspace.rootPath, state.runtimeProvider)) });
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
    const body = await readJsonBody<{ workspaceId?: string; id?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workspaceId || !body.id?.trim()) throw badRequest("A Space and capability are required.");
    const workspace = await getWorkspace(body.workspaceId);
    const scope = capabilityScope(body.scope);
    // Remote inspection is read-only and can take several seconds. Complete it
    // before reserving the mutation so discovery never blocks an unrelated turn.
    const item = await state.capabilityRegistry.details(body.id);
    const bundle = item.sourceKind === "bundle"
      ? await state.capabilityRegistry.buildOfficialSkillBundle(item.id)
      : null;
    const installSource = item.installSource;
    if (!bundle && !installSource) throw badRequest("This capability is a reference and cannot be installed directly.");
    const installed = await runCapabilityMutation(state, workspace, scope, async () => {
      if (bundle) {
        const imported = await importPiSkillBundle(workspace.rootPath, {
          fileName: bundle.fileName,
          bytes: bundle.bytes,
          scope: scope === "project" ? "project" : "user",
        }, state.runtimeProvider);
        return { kind: "skill" as const, item, imported };
      }
      await installPiPackage(workspace.rootPath, installSource!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
      return { kind: "package" as const, item, source: installSource! };
    });
    sendJson(res, { installed }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/install") {
    const body = await readJsonBody<{ workspaceId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workspaceId || !body.source?.trim()) throw badRequest("A Space and package source are required.");
    const workspace = await getWorkspace(body.workspaceId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, workspace, scope, async () => {
      await installPiPackage(workspace.rootPath, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { installed: true }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/update") {
    const body = await readJsonBody<{ workspaceId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workspaceId || !body.source?.trim() || !body.scope) {
      throw badRequest("A Space, package source, and scope are required.");
    }
    const workspace = await getWorkspace(body.workspaceId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, workspace, scope, async () => {
      await updatePiPackages(workspace.rootPath, body.source, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { updated: true });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/remove") {
    const body = await readJsonBody<{ workspaceId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.workspaceId || !body.source?.trim() || !body.scope) {
      throw badRequest("A Space, package source, and scope are required.");
    }
    const workspace = await getWorkspace(body.workspaceId);
    const scope = capabilityScope(body.scope);
    const removed = await runCapabilityMutation(state, workspace, scope, async () =>
      await removePiPackage(workspace.rootPath, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      }));
    sendJson(res, { removed });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/import") {
    const multipart = await readMultipartBody(state, req);
    const workspaceId = multipart.fields.get("workspaceId");
    if (!workspaceId || !multipart.files.length) throw badRequest("A Space and Skill files are required.");
    const workspace = await getWorkspace(workspaceId);
    const scope = multipart.fields.get("scope") === "project" ? "project" : "user";
    const imported = await runCapabilityMutation(
      state,
      workspace,
      scope === "project" ? "project" : "global",
      async () => {
        const results = [];
        for (const file of multipart.files) {
          results.push(await importPiSkillBundle(workspace.rootPath, { fileName: file.fileName, bytes: file.data, scope }, state.runtimeProvider));
        }
        return results;
      },
    );
    sendJson(res, { imported }, 201);
    return;
  }

  const catalogMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/agent\/catalog$/);
  if (method === "GET" && catalogMatch) {
    const snapshot = await state.kernel.getCapabilities({ kind: "renderer", workspaceId: catalogMatch[1] });
    sendJson(res, snapshot.catalog);
    return;
  }
  const conversationsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations$/);
  if (conversationsMatch && method === "GET") {
    const workspace = await getWorkspace(conversationsMatch[1]);
    sendJson(res, { conversations: await listConversations(workspace.rootPath) });
    return;
  }
  if (conversationsMatch && method === "POST") {
    const workspace = await getWorkspace(conversationsMatch[1]);
    sendJson(res, { conversation: await createConversation(workspace.rootPath) }, 201);
    return;
  }

  const conversationMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)$/);
  if (conversationMatch && (method === "PUT" || method === "PATCH")) {
    const workspace = await getWorkspace(conversationMatch[1]);
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
    const key = clientKey(workspace.id, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current Assistant turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    const conversation = body.title !== undefined
      ? await renameConversation(workspace.rootPath, conversationId, body.title)
      : await updateConversationLifecycle(workspace.rootPath, conversationId, {
          ...(body.archived !== undefined ? { archived: body.archived } : {}),
          ...(body.snoozedUntil !== undefined ? { snoozedUntil: body.snoozedUntil } : {}),
        });
    if (body.title !== undefined) state.clients.get(key)?.setSessionName(conversation.title);
    sendJson(res, { conversation });
    return;
  }

  const conversationRuntimeMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/runtime$/);
  if (conversationRuntimeMatch && method === "GET") {
    const workspace = await getWorkspace(conversationRuntimeMatch[1]);
    const conversationId = conversationRuntimeMatch[2];
    if (!(await readConversation(workspace.rootPath, conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, workspace.id, workspace.rootPath, conversationId);
    sendJson(res, { runtime: await client.getState() });
    return;
  }

  const contextAttachmentMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/context-attachments$/);
  if (contextAttachmentMatch && method === "POST") {
    const workspace = await getWorkspace(contextAttachmentMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("A file path is required.");
    sendJson(res, { attachment: await previewConversationContextAttachment(workspace.rootPath, { path: body.path }) }, 201);
    return;
  }

  const eventsMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const workspace = await getWorkspace(eventsMatch[1]);
    rememberWorkspaceRoot(state, workspace.id, workspace.rootPath);
    openChatStream(state, req, res, eventsMatch[1], eventsMatch[2]);
    return;
  }
  const messagesPostMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && messagesPostMatch) {
    const workspace = await getWorkspace(messagesPostMatch[1]);
    const conversationId = messagesPostMatch[2];
    const body = await readJsonBody<{ content?: string; contextPaths?: string[]; selectedPath?: string | null }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const selectedPath = normalizeSelectedPath(workspace.rootPath, body.selectedPath);
    const contextPaths = normalizeContextPaths(workspace.rootPath, body.contextPaths);
    const { message } = await acceptConversationTurn(state, workspace, conversationId, {
      content,
      contextPaths,
      selectedPath,
      actorKind: "assistant",
    });
    sendJson(res, { accepted: true, message }, 202);
    return;
  }
  const abortMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/abort$/);
  if (method === "POST" && abortMatch) {
    const workspace = await getWorkspace(abortMatch[1]);
    const key = clientKey(workspace.id, abortMatch[2]);
    const client = state.clients.get(key);
    sendJson(res, { aborted: client ? await client.abort() : false });
    return;
  }

  const compactMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/compact$/);
  if (method === "POST" && compactMatch) {
    const workspace = await getWorkspace(compactMatch[1]);
    if (!(await readConversation(workspace.rootPath, compactMatch[2])).length) throw notFound("Conversation not found.");
    const key = clientKey(workspace.id, compactMatch[2]);
    const body = await readJsonBody<{ customInstructions?: string }>(state, req);
    assertNoCapabilityMutationForTurn(state, workspace.id);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    state.compactingConversations.add(key);
    const task = state.kernel.startTask({
      kind: "compaction",
      workspaceId: workspace.id,
      conversationId: compactMatch[2],
      actor: { kind: "assistant", cwd: workspace.rootPath, workspaceId: workspace.id, conversationId: compactMatch[2] },
    });
    try {
      const client = await getClient(state, workspace.id, workspace.rootPath, compactMatch[2]);
      await client.compact(body.customInstructions?.trim() || undefined);
      broadcast(state, streamKey(workspace.id, compactMatch[2]), { type: "done", conversationId: compactMatch[2] });
    } finally {
      state.compactingConversations.delete(key);
      state.kernel.finishTask(task.id);
    }
    sendJson(res, { compacted: true });
    return;
  }
  const messagesGetMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)$/);
  if (method === "GET" && messagesGetMatch) {
    const workspace = await getWorkspace(messagesGetMatch[1]);
    sendJson(res, { messages: await readConversation(workspace.rootPath, messagesGetMatch[2]) });
    return;
  }
  const extensionResponseMatch = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/conversations\/([^/]+)\/extension-ui\/([^/]+)$/);
  if (method === "POST" && extensionResponseMatch) {
    const workspace = await getWorkspace(extensionResponseMatch[1]);
    const request = state.extensionRequests.get(extensionResponseMatch[3]);
    if (!request || request.workspaceRoot !== workspace.rootPath || request.conversationId !== extensionResponseMatch[2]) {
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
  workspace: { id: string; rootPath: string },
  conversationId: string,
  input: {
    content: string;
    contextPaths: string[];
    selectedPath: string | null;
    actorKind: "assistant" | "cli";
  },
): Promise<{ message: { id: string; role: "user"; content: string; createdAt: string }; taskId: string }> {
  const turnKey = clientKey(workspace.id, conversationId);
  const existing = await readConversationSummary(workspace.rootPath, conversationId);
  if (!existing) throw notFound("Conversation not found.");
  if (existing.archivedAt) throw httpError(409, "Restore this Chat before sending another message.");
  if (existing.snoozedUntil && Date.parse(existing.snoozedUntil) > Date.now()) {
    throw httpError(409, "Resume this Chat before sending another message.");
  }
  assertNoCapabilityMutationForTurn(state, workspace.id);
  if (state.compactingConversations.has(turnKey)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  if (state.runningTurns.has(turnKey)) throw httpError(409, "Wait for the current agent turn to finish.");
  state.runningTurns.add(turnKey);
  const task = state.kernel.startTask({
    kind: "assistant_turn",
    workspaceId: workspace.id,
    conversationId,
    actor: { kind: input.actorKind, cwd: workspace.rootPath, workspaceId: workspace.id, conversationId },
  });
  state.activeTurnTasks.set(task.id, { workspaceId: workspace.id, conversationId });
  broadcast(state, turnKey, turnStateEvent(conversationId, true));
  const message = { id: randomUUID(), role: "user" as const, content: input.content, createdAt: new Date().toISOString() };
  try {
    await appendMessage(workspace.rootPath, conversationId, message);
  } catch (error) {
    state.runningTurns.delete(turnKey);
    state.activeTurnTasks.delete(task.id);
    state.kernel.finishTask(task.id);
    broadcast(state, turnKey, turnStateEvent(conversationId, false));
    throw error;
  }
  void runAgentTurn(state, workspace.id, workspace.rootPath, conversationId, input.content, input.contextPaths, input.selectedPath, task.id);
  return { message, taskId: task.id };
}

async function createSpaceInternal(state: LocalApiState, name: string): Promise<WorkspaceSummary> {
  const workspace = await createManagedWorkspace(name, state.workspaceBase);
  state.spaceTrustAuthority.grant(workspace.rootPath);
  return workspace;
}

async function registerSpaceInternal(state: LocalApiState, rootPath: string, providerHint?: "google-drive"): Promise<WorkspaceSummary> {
  const workspace = await registerLinkedWorkspace(rootPath, providerHint);
  state.spaceTrustAuthority.grant(workspace.rootPath);
  return workspace;
}

const maxActAddSources = 25;

/**
 * The act facade is the CLI act lane's in-process authority. Every method
 * reuses the same route internals as the renderer (turn acceptance, trust
 * grants, History-checkpointed additions), so a CLI-initiated action obeys
 * identical conflict, trust, and persistence rules. Registering a folder
 * through the act lane deliberately has no renderer folder-picker grant:
 * possession of the per-launch act token is that caller's authorization.
 */
function createWorkspaceActFacade(state: LocalApiState): WorkspaceActFacade {
  const resolveSpace = async (selector: string): Promise<WorkspaceSummary> => {
    const resolved = resolveWorkspaceCliSpaceSelector(await listWorkspaces(), selector.trim() || undefined);
    if (!resolved) throw new WorkspaceCliError("usage", "Act commands require an explicit --space <id-or-name>.");
    return resolved;
  };
  return {
    async createConversation(input) {
      const workspace = await resolveSpace(input.space);
      const conversation = await runActOperation(() => createConversation(workspace.rootPath));
      return { space: toActSpaceRef(workspace), conversation: toActConversationRef(conversation) };
    },
    async listConversations(input) {
      const workspace = await resolveSpace(input.space);
      const conversations = await runActOperation(() => listConversations(workspace.rootPath));
      return { space: toActSpaceRef(workspace), conversations: conversations.map(toActConversationRef) };
    },
    async sendMessage(input) {
      const workspace = await resolveSpace(input.space);
      const content = input.content.trim();
      if (!content) throw new WorkspaceCliError("usage", "Message content is required.");
      if (!input.conversationId && !input.newConversation) {
        throw new WorkspaceCliError("usage", "Provide --conversation <id> or --new.");
      }
      return runActOperation(async () => {
        const conversationId = input.newConversation
          ? (await createConversation(workspace.rootPath)).id
          : input.conversationId!;
        const { message, taskId } = await acceptConversationTurn(state, workspace, conversationId, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
        });
        return { space: toActSpaceRef(workspace), conversationId, messageId: message.id, taskId };
      });
    },
    async conversationStatus(input) {
      const workspace = await resolveSpace(input.space);
      const summary = await runActOperation(() => readConversationSummary(workspace.rootPath, input.conversationId));
      if (!summary) throw new WorkspaceCliError("notFound", "Conversation not found.");
      return {
        space: toActSpaceRef(workspace),
        conversation: toActConversationRef(summary),
        state: conversationRuntimeState(state, workspace.id, input.conversationId),
      };
    },
    async conversationResult(input) {
      const workspace = await resolveSpace(input.space);
      const result = await conversationResultForScope(state, workspace.id, workspace.rootPath, input.conversationId, input.messages);
      return { space: toActSpaceRef(workspace), ...result };
    },
    async abortTurn(input) {
      const workspace = await resolveSpace(input.space);
      const client = state.clients.get(clientKey(workspace.id, input.conversationId));
      return {
        space: toActSpaceRef(workspace),
        conversationId: input.conversationId,
        aborted: client ? await client.abort() : false,
      };
    },
    async turnStatus(input) {
      const workspace = await resolveSpace(input.space);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkspaceCliError("usage", "Provide --task <id>.");
      const task = turnStatusFor(state, workspace.id, taskId);
      return { space: toActSpaceRef(workspace), task };
    },
    async turnResult(input) {
      const workspace = await resolveSpace(input.space);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkspaceCliError("usage", "Provide --task <id>.");
      const result = await turnResultForScope(state, workspace.id, workspace.rootPath, taskId);
      return { space: toActSpaceRef(workspace), ...result };
    },
    async createSpace(input) {
      const name = input.name.trim();
      if (!name) throw new WorkspaceCliError("usage", "A Space name is required.");
      const workspace = await runActOperation(() => runCheckSpaceRegistryMutation(state, () => createSpaceInternal(state, name)));
      return { space: toActSpaceRef(workspace) };
    },
    async registerSpace(input) {
      const rootPath = input.rootPath.trim();
      if (!rootPath || !isAbsolute(rootPath)) {
        throw new WorkspaceCliError("usage", "Provide an absolute folder path to register.");
      }
      const workspace = await runActOperation(() => runCheckSpaceRegistryMutation(state, () => registerSpaceInternal(state, rootPath)));
      return { space: toActSpaceRef(workspace) };
    },
    async addFiles(input) {
      const workspace = await resolveSpace(input.space);
      const result = await runActOperation(() => addExternalFilesInternal(workspace, input));
      return { space: toActSpaceRef(workspace), ...result };
    },
    async checksEnable(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => {
        const proposalPath = isAbsolute(input.proposalPath)
          ? resolve(input.proposalPath)
          : resolve(input.cwd, input.proposalPath);
        const enabled = await runActOperation(() => state.checks.enable({
          space: workspace,
          proposalPath,
          actor: "cli",
        }));
        return {
          space: toActSpaceRef(workspace),
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
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => ({
        space: toActSpaceRef(workspace),
        checkId: input.checkId,
        disabled: await runActOperation(() => state.checks.disable(workspace, input.checkId)),
      }));
    },
    async checksRun(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => {
        const accepted = await runActOperation(() => state.checks.run({
          space: workspace,
          ...(input.checkId ? { checkId: input.checkId } : {}),
          actor: { kind: "cli", cwd: workspace.rootPath, workspaceId: workspace.id },
        }));
        return { space: toActSpaceRef(workspace), ...accepted };
      });
    },
    async checksTask(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => ({
        space: toActSpaceRef(workspace),
        task: await state.checks.taskStatus(workspace.id, input.taskId),
      }));
    },
    async checksResult(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => {
        const run = await runActOperation(() => state.checks.taskResult(workspace.id, input.taskId));
        if (run.state === "aborted" || run.state === "interrupted") {
          throw new WorkspaceCliError("conflict", run.error ?? "The Check run did not finish.");
        }
        if (run.state === "failed") throw new WorkspaceCliError("failure", run.error ?? "The Check run failed.");
        return { space: toActSpaceRef(workspace), run };
      });
    },
    async checksAbort(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => ({
        space: toActSpaceRef(workspace),
        taskId: input.taskId,
        aborted: await state.checks.abort(workspace.id, input.taskId),
      }));
    },
    async checksProblems(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => {
        const result = await runActOperation(() => state.checks.problems(workspace, input.checkId));
        return {
          space: toActSpaceRef(workspace),
          ...(input.checkId ? { checkId: input.checkId } : {}),
          ...result,
        };
      });
    },
    async checksDecide(input) {
      const workspace = await resolveSpace(input.space);
      return runReservedCheckOperation(state, workspace.id, async () => {
        const decision = await runActOperation(() => state.checks.decide({
          spaceId: workspace.id,
          findingId: input.findingId,
          decision: input.decision,
          actor: "cli",
          ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
        }));
        return { space: toActSpaceRef(workspace), findingId: input.findingId, decision };
      });
    },
    async manageList() {
      const scope = managementScope(state);
      const conversations = await runActOperation(() => listConversations(scope.rootPath));
      return { conversations: conversations.map(toActConversationRef) };
    },
    async manageSend(input) {
      const content = input.content.trim();
      if (!content) throw new WorkspaceCliError("usage", "Message content is required.");
      const scope = managementScope(state);
      return runActOperation(async () => {
        const conversationId = input.newConversation
          ? (await createConversation(scope.rootPath)).id
          : input.conversationId ?? (await resolveManagementConversation(true)).id;
        const { message, taskId } = await acceptConversationTurn(state, scope, conversationId, {
          content,
          contextPaths: [],
          selectedPath: null,
          actorKind: "cli",
        });
        return { conversationId, messageId: message.id, taskId };
      });
    },
    async manageConversationStatus(input) {
      const scope = managementScope(state);
      const conversation = input.conversationId
        ? await runActOperation(() => readConversationSummary(scope.rootPath, input.conversationId!))
        : await runActOperation(() => resolveManagementConversation(false).catch(() => null));
      if (!conversation) {
        throw new WorkspaceCliError(
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
      if (!taskId) throw new WorkspaceCliError("usage", "Provide --task <id>.");
      return { task: turnStatusFor(state, workspaceManagementScopeId, taskId) };
    },
    async manageConversationResult(input) {
      const scope = managementScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveManagementConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new WorkspaceCliError("notFound", "No management conversation exists yet. Send a message to start one.");
      }
      return conversationResultForScope(state, scope.id, scope.rootPath, conversationId, input.messages);
    },
    async manageTurnResult(input) {
      assertManagementInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new WorkspaceCliError("usage", "Provide --task <id>.");
      const scope = managementScope(state);
      return turnResultForScope(state, scope.id, scope.rootPath, taskId);
    },
    async manageAbort(input) {
      const scope = managementScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveManagementConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new WorkspaceCliError("notFound", "No management conversation exists yet. Send a message to start one.");
      }
      const client = state.clients.get(clientKey(scope.id, conversationId));
      return { conversationId, aborted: client ? await client.abort() : false };
    },
  };
}

/** The management scope shaped like the workspace refs the turn internals take. */
function managementScope(state?: LocalApiState): { id: string; rootPath: string } {
  if (state) assertManagementInstructionsReady(state);
  return { id: workspaceManagementScopeId, rootPath: workspaceManagementRoot() };
}

function assertManagementInstructionsReady(state: LocalApiState): void {
  if (!state.managementInstructionsError) return;
  throw new WorkspaceCliError(
    "unavailable",
    "The management conversation is unavailable because Workspace could not prepare its required instructions. Restart Workspace; if this continues, check the app-data management folder.",
  );
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
  if (!create) throw new WorkspaceCliError("notFound", "No management conversation exists yet. Send a message to start one.");
  return createConversation(scope.rootPath);
}

async function turnResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  taskId: string,
): Promise<{ conversationId: string; task: { taskId: string; state: "succeeded"; endedAt: string }; message: WorkspaceActChatMessage }> {
  const task = turnStatusFor(state, scopeId, taskId);
  if (task.state === "running") {
    throw new WorkspaceCliError("conflict", "The turn is still running. Use chat wait or chat status --task.");
  }
  if (task.state === "unknown") {
    throw new WorkspaceCliError("notFound", "Task not found. Turn outcomes are kept while the Workspace app stays running.");
  }
  if (task.state === "aborted") throw new WorkspaceCliError("conflict", "The turn was aborted before it finished.");
  if (task.state === "failed") throw new WorkspaceCliError("failure", task.error ?? "The turn failed.");
  const conversationId = task.conversationId!;
  const messages = await runActOperation(() => readConversation(rootPath, conversationId));
  const message = messages.find((item) => item.id === task.messageId);
  if (!message) throw new WorkspaceCliError("failure", "The turn's response message could not be found in the transcript.");
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
  state: WorkspaceActChatState;
  total: number;
  lastAssistant: string | null;
  messages: WorkspaceActChatMessage[];
}> {
  const all = await runActOperation(() => readConversation(rootPath, conversationId));
  if (!all.length) throw new WorkspaceCliError("notFound", "Conversation not found.");
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
  workspace: WorkspaceSummary,
  input: { fromPaths: string[]; toDir?: string; cwd: string },
): Promise<{ copied: string[]; checkpointId: string | null }> {
  if (!input.fromPaths.length) throw new WorkspaceCliError("usage", "Provide at least one --from <path> to add.");
  if (input.fromPaths.length > maxActAddSources) {
    throw new WorkspaceCliError("usage", `At most ${maxActAddSources} sources can be added at once.`);
  }
  const toDir = normalizeWorkspaceRelativePath(input.toDir ?? "");
  const sources: string[] = [];
  for (const raw of input.fromPaths) {
    const trimmed = raw.trim();
    if (!trimmed) throw new WorkspaceCliError("usage", "Source paths cannot be empty.");
    const source = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
    const info = await lstat(source).catch(() => null);
    if (!info) throw new WorkspaceCliError("notFound", `Source not found: ${trimmed}.`);
    if (info.isSymbolicLink()) throw new WorkspaceCliError("usage", `Symbolic-link sources cannot be added: ${trimmed}.`);
    if (!info.isFile() && !info.isDirectory()) {
      throw new WorkspaceCliError("usage", `Only files and folders can be added: ${trimmed}.`);
    }
    if (pathContainsPath(workspace.rootPath, source)) {
      throw new WorkspaceCliError("usage", `Source is already inside this Space: ${trimmed}. Move it in Files instead.`);
    }
    if (pathContainsPath(source, workspace.rootPath)) {
      throw new WorkspaceCliError("usage", `Source contains this Space and cannot be copied into it: ${trimmed}.`);
    }
    sources.push(source);
  }
  const copied: string[] = [];
  try {
    for (const source of sources) copied.push(await copyPathIntoWorkspace(source, workspace.rootPath, toDir));
  } catch (error) {
    // A mid-batch failure must not strand earlier copies without a restore
    // point: undo them best-effort, then surface the failure.
    await Promise.all(copied.map((path) =>
      rm(resolveWorkspacePath(workspace.rootPath, path), { recursive: true, force: true }).catch(() => undefined)));
    throw error;
  }
  const safety = await checkpointAdditiveWritesOrUndo(workspace.rootPath, copied, {
    reason: "pre_add",
    label: `Before adding ${copied.length} item${copied.length === 1 ? "" : "s"}`,
  });
  return { copied, checkpointId: safety?.checkpointId ?? null };
}

async function runActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceCliError) throw error;
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : null;
    const message = error instanceof Error ? error.message : String(error ?? "Workspace act command failed.");
    if (statusCode === 400) throw new WorkspaceCliError("usage", message, { cause: error });
    if (statusCode === 403) throw new WorkspaceCliError("permissionDenied", message, { cause: error });
    if (statusCode === 404) throw new WorkspaceCliError("notFound", message, { cause: error });
    if (statusCode === 409) throw new WorkspaceCliError("conflict", message, { cause: error });
    throw new WorkspaceCliError("failure", message, { cause: error });
  }
}

function turnStatusFor(state: LocalApiState, workspaceId: string, taskId: string): WorkspaceActTurnStatus {
  const active = state.activeTurnTasks.get(taskId);
  if (active && active.workspaceId === workspaceId) {
    return { taskId, state: "running", conversationId: active.conversationId, messageId: null, error: null, endedAt: null };
  }
  const settled = state.settledTurns.get(taskId);
  if (settled && settled.workspaceId === workspaceId) {
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

function conversationRuntimeState(state: LocalApiState, workspaceId: string, conversationId: string): WorkspaceActChatState {
  const key = clientKey(workspaceId, conversationId);
  if (state.runningTurns.has(key)) return "running";
  if (state.compactingConversations.has(key)) return "compacting";
  return "idle";
}

function toActSpaceRef(workspace: WorkspaceSummary): WorkspaceActSpaceRef {
  return { id: workspace.id, name: workspace.name, rootPath: workspace.rootPath };
}

function toActConversationRef(conversation: ConversationSummary): WorkspaceActConversationRef {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

function toActChatMessage(message: ChatMessage): WorkspaceActChatMessage {
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
  workspaceId: string,
  workspaceRoot: string,
  conversationId: string,
  content: string,
  contextPaths: string[],
  selectedPath: string | null,
  taskId: string,
): Promise<void> {
  const key = clientKey(workspaceId, conversationId);
  let client: PiConversationClient | null = null;
  let promptStarted = false;
  let settledStatus: SettledTurnRecord["status"] = "succeeded";
  let settledMessageId: string | undefined;
  let settledError: string | undefined;
  changeTurnCount(state, 1);
  try {
    client = await getClient(state, workspaceId, workspaceRoot, conversationId);
    const contextAttachments = await loadConversationContextAttachmentsForTurn(workspaceRoot, contextPaths);
    await captureTurnCheckpointSafe(state, workspaceId, workspaceRoot, conversationId, "pre_turn");
    promptStarted = true;
    const finalText = await client.prompt(content, { contextAttachments, selectedPath });
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: finalText,
      createdAt: new Date().toISOString(),
    };
    await appendMessage(workspaceRoot, conversationId, assistantMessage);
    settledMessageId = assistantMessage.id;
    try {
      const firstUserMessage = (await readConversation(workspaceRoot, conversationId))
        .find((message) => message.role === "user")
        ?.content;
      const generatedTitle = conversationTitleFromFirstUserMessage(firstUserMessage);
      if (generatedTitle) {
        const conversation = await setGeneratedConversationTitle(workspaceRoot, conversationId, generatedTitle);
        client.setSessionName(conversation.title);
      }
    } catch (error) {
      // A derived title must never turn an otherwise persisted successful
      // Assistant response into a failed turn.
      console.warn(`Could not persist a generated Chat title: ${errorMessage(error)}`);
    }
    broadcast(state, streamKey(workspaceId, conversationId), { type: "done", conversationId });
  } catch (error) {
    let partialResponsePreserved = false;
    if (error instanceof PiTurnFailure) {
      const interruptedMessage = {
        id: randomUUID(),
        role: "assistant" as const,
        content: error.partialText || "The Assistant was interrupted before it could finish its response.",
        createdAt: new Date().toISOString(),
        interruption: {
          reason: "provider_error" as const,
          message: error.message,
          retryAttempts: error.retryAttempts,
          provider: error.provider,
          model: error.model,
          activities: error.activities,
        },
      };
      try {
        await appendMessage(workspaceRoot, conversationId, interruptedMessage);
        partialResponsePreserved = true;
        settledMessageId = interruptedMessage.id;
      } catch (preservationError) {
        console.error(`Could not preserve an interrupted Assistant response: ${errorMessage(preservationError)}`);
      }
    }
    const message = assistantTurnFailureMessage(error, partialResponsePreserved);
    settledStatus = isPiTurnCancelledError(error) ? "aborted" : "failed";
    settledError = message;
    broadcast(state, streamKey(workspaceId, conversationId), { type: "error", conversationId, message });
    // A provider failure settles the Pi session cleanly after its bounded retry
    // path. Keep that live session so the next user message can continue from
    // completed tool results. Unexpected runtime failures still rebuild the
    // client from the durable Pi session on the next turn.
    if (!(error instanceof PiTurnFailure)) {
      await client?.stop().catch(() => undefined);
      state.clients.delete(key);
    }
  } finally {
    if (promptStarted) await captureTurnCheckpointSafe(state, workspaceId, workspaceRoot, conversationId, "post_turn");
    state.runningTurns.delete(key);
    state.kernel.finishTask(taskId);
    settleTurnTask(state, taskId, {
      workspaceId,
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
  state.settledTurns.set(taskId, { taskId, endedAt: new Date().toISOString(), ...record });
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function assistantTurnFailureMessage(error: unknown, partialResponsePreserved: boolean): string {
  if (isPiTurnCancelledError(error)) return "Assistant turn cancelled.";
  if (!(error instanceof PiTurnFailure)) return errorMessage(error);
  const retrySummary = error.retryAttempts > 0
    ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
    : "";
  return partialResponsePreserved
    ? `The model stopped responding${retrySummary}. Workspace preserved the partial response and completed activity below.`
    : `The model stopped responding${retrySummary}, and Workspace could not preserve the partial response.`;
}

async function getClient(
  state: LocalApiState,
  workspaceId: string,
  workspaceRoot: string,
  conversationId: string,
): Promise<PiConversationClient> {
  if (workspaceId === workspaceManagementScopeId) assertManagementInstructionsReady(state);
  const key = clientKey(workspaceId, conversationId);
  rememberWorkspaceRoot(state, workspaceId, workspaceRoot);
  const existing = state.clients.get(key);
  if (existing) return existing;
  // The management scope loads personal Pi capabilities and its two app-owned
  // project instructions. It belongs to no Space, so Space-bound restricted-
  // app proposal and invocation bridges stay disconnected.
  const hostCapabilities = workspaceId === workspaceManagementScopeId
    ? undefined
    : {
        workspaceId,
        restrictedAppProposals: state.restrictedAppProposals,
        restrictedApps: state.restrictedApps,
      };
  const client = new PiConversationClient(conversationId, workspaceRoot, state.runtimeProvider, hostCapabilities);
  client.on("event", (event: PiChatEvent) => {
    const { raw: _raw, ...safeEvent } = event;
    broadcast(state, streamKey(workspaceId, conversationId), safeEvent);
  });
  state.clients.set(key, client);
  return client;
}

async function invalidateWorkspaceClients(state: LocalApiState, workspaceId: string): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${workspaceId}:`)) continue;
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
  workspace: { id: string; rootPath: string },
  scope: CapabilityScope,
  operation: () => Promise<T>,
  options: { requireProjectTrust?: boolean } = {},
): Promise<T> {
  const key = scope === "global" ? globalCapabilityMutationKey : workspace.id;
  reserveCapabilityMutation(state, workspace.id, scope, key);
  try {
    if (
      scope === "project"
      && options.requireProjectTrust !== false
      && !await isPiProjectMutationTrusted(workspace.rootPath, state.runtimeProvider)
    ) {
      throw forbidden("Trust this Space before changing Space-scoped capabilities.");
    }
    const result = await operation();
    if (scope === "global") await invalidateAllClients(state);
    else await invalidateWorkspaceClients(state, workspace.id);
    return result;
  } finally {
    state.capabilityMutations.delete(key);
  }
}

async function runRestrictedAppMutation<T>(
  state: LocalApiState,
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCapabilityMutation(state, workspaceId, "project", workspaceId);
  try {
    await revalidateRestrictedAppWorkspace(state, workspaceId);
    const result = await operation();
    await invalidateWorkspaceClients(state, workspaceId);
    return result;
  } finally {
    state.capabilityMutations.delete(workspaceId);
  }
}

async function recoverPendingWorkspaceRemovals(
  restrictedApps: RestrictedAppService,
  restrictedAppProposals: RoutedRestrictedAppProposalHost,
  io: Partial<WorkspaceRemovalIo>,
): Promise<string[]> {
  const pendingRemovals = await listPendingWorkspaceRemovals();
  for (const pending of pendingRemovals) {
    try {
      let intent = pending;
      if (intent.phase === "requested") {
        await restrictedApps.removeWorkspace(intent.workspaceId);
        await restrictedAppProposals.removeWorkspace(intent.workspaceId);
        intent = await markWorkspaceRemovalAppStateRemoved(intent.workspaceId, io);
      }
      // The durable removal intent must remain until Check authority is gone.
      // This removal-only path never parses possibly damaged/future state.
      await purgeWorkspaceCheckState(intent.workspaceId);
      await finalizeWorkspaceRemoval(intent.workspaceId, io);
    } catch {
      // The durable intent keeps this Space hidden and untrusted. Recovery of
      // other Spaces and normal startup can proceed; a later startup retries it.
    }
  }
  return pendingRemovals.map((intent) => intent.rootPath);
}

async function runRestrictedAppMutations<T>(
  state: LocalApiState,
  workspaceIds: readonly string[],
  operation: () => Promise<T>,
  options: { requiredWorkspaceIds?: readonly string[] } = {},
): Promise<T> {
  const ids = [...new Set(workspaceIds)].sort();
  if (ids.length === 0) throw badRequest("A Space is required for this App change.");
  const requiredWorkspaceIds = [...new Set(options.requiredWorkspaceIds ?? ids)].sort();
  if (requiredWorkspaceIds.length === 0 || requiredWorkspaceIds.some((workspaceId) => !ids.includes(workspaceId))) {
    throw new Error("Restricted App mutation validation must name one or more reserved Spaces.");
  }
  if (state.capabilityMutations.has(globalCapabilityMutationKey)
    || ids.some((workspaceId) => state.capabilityMutations.has(workspaceId))) {
    throw httpError(409, "Wait for the current capability change to finish.");
  }
  if (ids.some((workspaceId) => hasActiveCapabilityWorkForWorkspace(state, workspaceId))) {
    throw httpError(409, "Wait for affected work to finish before changing capabilities.");
  }
  for (const workspaceId of ids) state.capabilityMutations.add(workspaceId);
  try {
    for (const workspaceId of requiredWorkspaceIds) {
      await revalidateRestrictedAppWorkspace(state, workspaceId);
    }
    const result = await operation();
    await Promise.all(ids.map((workspaceId) => invalidateWorkspaceClients(state, workspaceId)));
    return result;
  } finally {
    for (const workspaceId of ids) state.capabilityMutations.delete(workspaceId);
  }
}

async function revalidateRestrictedAppWorkspace(state: LocalApiState, workspaceId: string): Promise<void> {
  await state.beforeRestrictedAppWorkspaceRevalidation?.(workspaceId);
  await getWorkspace(workspaceId);
}

function reserveCapabilityMutation(
  state: LocalApiState,
  workspaceId: string,
  scope: CapabilityScope,
  key: string,
): void {
  const mutationConflict = scope === "global"
    ? state.capabilityMutations.size > 0
    : state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(workspaceId);
  if (mutationConflict) throw httpError(409, "Wait for the current capability change to finish.");

  const runningConflict = scope === "global"
    ? state.runningTurns.size > 0 || state.compactingConversations.size > 0 || state.checkRunReservations.size > 0 || state.checks.hasActiveRun()
    : hasActiveCapabilityWorkForWorkspace(state, workspaceId);
  if (runningConflict) {
    throw httpError(409, "Wait for affected Assistant work to finish before changing capabilities.");
  }
  state.capabilityMutations.add(key);
}

function assertNoCapabilityMutationForTurn(state: LocalApiState, workspaceId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(workspaceId)) {
    throw httpError(409, "Wait for the current capability change to finish before starting an Assistant turn.");
  }
}

function assertNoCapabilityMutationForCheck(state: LocalApiState, workspaceId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(workspaceId)) {
    throw new WorkspaceCliError("conflict", "Wait for the current capability change to finish before running or changing Checks.");
  }
}

function reserveCheckOperation(state: LocalApiState, workspaceId: string): void {
  assertNoCapabilityMutationForCheck(state, workspaceId);
  if (state.checkRunReservations.has(workspaceId)) {
    throw new WorkspaceCliError("conflict", "Wait for the current Check operation to finish.");
  }
  state.checkRunReservations.add(workspaceId);
}

async function runReservedCheckOperation<T>(
  state: LocalApiState,
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCheckOperation(state, workspaceId);
  try {
    return await operation();
  } finally {
    state.checkRunReservations.delete(workspaceId);
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

function hasActiveCapabilityWorkForWorkspace(state: LocalApiState, workspaceId: string): boolean {
  const prefix = `${workspaceId}:`;
  return [...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix))
    || state.checkRunReservations.has(workspaceId)
    || state.checks.hasActiveRun(workspaceId);
}

function closeWorkspaceStreams(state: LocalApiState, workspaceId: string): void {
  const prefix = `${workspaceId}:`;
  for (const [key, streams] of [...state.chatStreams]) {
    if (!key.startsWith(prefix)) continue;
    for (const response of streams) response.end();
    state.chatStreams.delete(key);
  }
}

function routeExtensionRequest(state: LocalApiState, request: PiExtensionUiRequest): void {
  state.extensionRequests.set(request.id, request);
  const workspaceId = workspaceIdForRoot(state, request.workspaceRoot);
  if (!workspaceId) {
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
  broadcast(state, streamKey(workspaceId, request.conversationId), {
    type: "extension_ui_request",
    conversationId: request.conversationId,
    request: rendererRequest,
  });
}

function routeRestrictedAppProposal(state: LocalApiState, proposal: RestrictedAppProposalReceipt): void {
  broadcast(state, streamKey(proposal.workspaceId, proposal.conversationId), {
    type: "restricted_app_proposal",
    conversationId: proposal.conversationId,
    proposal: rendererRestrictedAppProposal(proposal),
  });
}

function routeRestrictedAppProposalSettled(state: LocalApiState, proposal: RestrictedAppProposalReceipt): void {
  broadcast(state, streamKey(proposal.workspaceId, proposal.conversationId), {
    type: "restricted_app_proposal_settled",
    conversationId: proposal.conversationId,
    proposal: rendererRestrictedAppProposal(proposal),
  });
}

function rendererRestrictedAppProposal(proposal: RestrictedAppProposalReceipt): Record<string, unknown> {
  return {
    id: proposal.id,
    workspaceId: proposal.workspaceId,
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
  const workspaceId = workspaceIdForRoot(state, event.workspaceRoot);
  if (!workspaceId) return;
  if (event.method === "notify") {
    broadcast(state, streamKey(workspaceId, event.conversationId), {
      type: "extension_ui_request",
      conversationId: event.conversationId,
      request: { id: event.id, method: "notify", message: event.message },
    });
    return;
  }
  if (event.method === "setEditorText" || event.method === "pasteToEditor") {
    broadcast(state, streamKey(workspaceId, event.conversationId), {
      type: "editor",
      conversationId: event.conversationId,
      editorMode: event.method === "setEditorText" ? "replace" : "append",
      text: event.text,
    });
    return;
  }
  const message = extensionEventMessage(event);
  if (message) broadcast(state, streamKey(workspaceId, event.conversationId), { type: "status", conversationId: event.conversationId, message });
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

async function safeAgentStatus(workspaceRoot: string, provider: PiRuntimeProvider): Promise<Record<string, unknown>> {
  try {
    return normalizeStatus(await getPiSetupStatus(workspaceRoot, provider));
  } catch (error) {
    return { ...emptyAgentStatus(), ready: false, error: errorMessage(error) };
  }
}

async function configuredWorkspace(workspaceId?: string, provider?: string, model?: string) {
  if (!workspaceId || !provider?.trim() || !model?.trim()) throw badRequest("A Space, provider, and model are required.");
  return getWorkspace(workspaceId);
}

function openChatStream(
  state: LocalApiState,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  conversationId: string,
): void {
  const key = streamKey(workspaceId, conversationId);
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
  void state.restrictedAppProposals.list({ workspaceId, conversationId }).then(async (proposals) => {
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

async function openWorkspaceFileStream(
  state: LocalApiState,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
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
    if (!path || isAlwaysHiddenWorkspaceEntry(basename(path))) return;
    void readWorkspaceIgnoreState(workspaceRoot).then((ignoreState) => {
      if (isWorkspaceIgnored(path, ignoreState.patterns)) return;
      try { resolveWorkspacePath(workspaceRoot, path); } catch { return; }
      sendEvent({ type: "file_event", eventType, path });
    });
  };
  const watchRoot = await canonicalWorkspaceWatchRoot(workspaceRoot);
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

async function sendWorkspaceRawFile(res: ServerResponse, workspaceRoot: string, relativePath: string): Promise<void> {
  const path = resolveWorkspacePath(workspaceRoot, relativePath);
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

function normalizeSelectedPath(workspaceRoot: string, value: string | null | undefined): string | null {
  const path = typeof value === "string" ? normalizeWorkspaceRelativePath(value) : "";
  if (!path) return null;
  let absolutePath: string;
  try {
    absolutePath = resolveWorkspacePath(workspaceRoot, path);
  } catch (error) {
    throw badRequest(errorMessage(error));
  }
  if (!existsSync(absolutePath)) throw badRequest("The selected Space item no longer exists.");
  return path;
}

function normalizeContextPaths(workspaceRoot: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw badRequest("Chat context paths must be an array of strings.");
  const paths = [...new Set(value.map((item) => normalizeWorkspaceRelativePath(item)).filter(Boolean))].slice(0, 32);
  for (const path of paths) {
    try { resolveWorkspacePath(workspaceRoot, path); } catch (error) { throw badRequest(errorMessage(error)); }
  }
  return paths;
}

async function captureTurnCheckpointSafe(
  state: LocalApiState,
  workspaceId: string,
  workspaceRoot: string,
  conversationId: string,
  reason: "pre_turn" | "post_turn",
): Promise<void> {
  // History is a Space concept. The management scope's root holds only
  // conversation records in app state, so turn checkpoints do not apply.
  if (workspaceId === workspaceManagementScopeId) return;
  try {
    const checkpoint = await createWorkspaceCheckpoint(workspaceRoot, {
      reason,
      label: reason === "pre_turn" ? "Before Assistant turn" : "After Assistant turn",
    });
    state.onHistoryCheckpoint?.({
      workspaceId,
      conversationId,
      reason,
      checkpointId: checkpoint.checkpointId,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    });
    if (checkpoint.skippedLargeFiles.length) {
      broadcast(state, streamKey(workspaceId, conversationId), {
        type: "status",
        conversationId,
        message: `History skipped ${checkpoint.skippedLargeFiles.length} oversized file${checkpoint.skippedLargeFiles.length === 1 ? "" : "s"}.`,
      });
    }
  } catch (error) {
    broadcast(state, streamKey(workspaceId, conversationId), {
      type: "status",
      conversationId,
      message: `History checkpoint warning: ${errorMessage(error)}`,
    });
  }
}

async function runWithHistorySafety<T>(workspaceRoot: string, checkpointId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await discardWorkspaceCheckpoint(workspaceRoot, checkpointId).catch(() => undefined);
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
  workspaceRoot: string,
  writtenPaths: string[],
  options: { reason: string; label: string },
): Promise<WorkspaceCheckpoint | null> {
  if (!writtenPaths.length) return null;
  try {
    return await createWorkspaceMutationCheckpoint(workspaceRoot, { deleteOnRestore: writtenPaths, ...options });
  } catch (error) {
    await Promise.all(writtenPaths.map((path) =>
      rm(resolveWorkspacePath(workspaceRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw httpError(500, `The added files were removed because Workspace could not record a restore point: ${errorMessage(error)}`);
  }
}

function normalizeWorkspaceRelativePath(value: string): string {
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
  if (state.sessionToken && req.headers["x-workspace-session"] !== state.sessionToken) throw unauthorized("Unauthorized.");
}

function setCorsHeaders(state: LocalApiState, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && state.allowedOrigins.includes(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,x-workspace-session");
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
    ?? workspaceCliErrorStatus(error)
    ?? (error instanceof WorkspaceCheckOperationConflictError ? 409 : null)
    ?? restrictedAppErrorStatus(error)
    ?? 500;
  sendJson(res, {
    error: errorMessage(error),
    ...(error instanceof RestrictedAppError ? { code: error.code } : {}),
  }, status);
}

function workspaceCliErrorStatus(error: unknown): number | null {
  if (!(error instanceof WorkspaceCliError)) return null;
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
function badRequest(message: string): Error { return httpError(400, message); }
function unauthorized(message: string): Error { return httpError(401, message); }
function forbidden(message: string): Error { return httpError(403, message); }
function notFound(message: string): Error { return httpError(404, message); }
function tooLarge(message: string): Error { return httpError(413, message); }
function unavailable(message: string): Error { return httpError(503, message); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isWorkspaceCheckDecisionKind(value: unknown): value is WorkspaceCheckDecisionKind {
  return value === "accept" || value === "reject" || value === "resolve" || value === "defer";
}

function match(path: string, pattern: RegExp): string[] | null {
  const result = pattern.exec(path);
  return result ? result.map((value) => decodeURIComponent(value)) : null;
}

function streamKey(workspaceId: string, conversationId: string): string { return `${workspaceId}:${conversationId}`; }
function clientKey(workspaceId: string, conversationId: string): string { return streamKey(workspaceId, conversationId); }

function rememberWorkspaceRoot(state: LocalApiState, workspaceId: string, rootPath: string): void {
  state.workspaceIdsByRoot.set(workspaceRootKey(rootPath), workspaceId);
}

function workspaceIdForRoot(state: LocalApiState, rootPath: string): string | null {
  return state.workspaceIdsByRoot.get(workspaceRootKey(rootPath)) ?? null;
}

function workspaceRootKey(rootPath: string): string {
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
