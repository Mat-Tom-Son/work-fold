import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream, existsSync, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PiConversationClient,
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
import { appendMessage, createConversation, listConversations, readConversation, readConversationSummary, renameConversation, updateConversationLifecycle } from "./agent/chat-store.js";
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
} from "./history.js";
import {
  copyResourcesToWorkspace,
  createResourceFolder,
  listResourceTree,
  uploadResourceFiles,
} from "./resources.js";
import { searchWorkspace } from "./search.js";
import { SpaceAppearanceStore } from "./space-appearance-store.js";
import { spaceAppearanceBannerNames } from "../shared/space-appearance.js";
import { configureWorkspaceStateRoot, restrictedAppRoot } from "./state-paths.js";
import { WorkspaceKernel } from "./workspace-kernel.js";
import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
} from "./server-dev-options.js";
import { isAlwaysHiddenWorkspaceEntry, isWorkspaceIgnored, readWorkspaceIgnoreState, setWorkspaceIgnoreState } from "./workspace-ignore.js";
import { canonicalWorkspaceWatchRoot } from "./workspace-watch.js";
import {
  beginWorkspaceRemoval,
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
  spaceTrustAuthority: RegisteredSpaceTrustAuthority;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  workspaceRemovalIo: Partial<WorkspaceRemovalIo>;
  beforeRestrictedAppWorkspaceRevalidation?: (workspaceId: string) => Promise<void>;
  chatStreams: Map<string, Set<ServerResponse>>;
  clients: Map<string, PiConversationClient>;
  runningTurns: Set<string>;
  compactingConversations: Set<string>;
  capabilityMutations: Set<string>;
  workspaceIdsByRoot: Map<string, string>;
  extensionRequests: Map<string, PiExtensionUiRequest>;
  fileStreams: Set<() => void>;
  activeTurns: number;
  onAgentTurnActivity?: (activeTurns: number) => void;
  onHistoryCheckpoint?: LocalApiOptions["onHistoryCheckpoint"];
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
  const runtimeProvider = new RegisteredSpaceRuntimeProvider(extensionRuntimeProvider, spaceTrustAuthority);
  const kernel = options.kernel ?? new WorkspaceKernel({ runtimeProvider });
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
    spaceTrustAuthority,
    localFolderGrantProvider: options.localFolderGrantProvider,
    workspaceRemovalIo: options.workspaceRemovalIo ?? {},
    beforeRestrictedAppWorkspaceRevalidation: options.beforeRestrictedAppWorkspaceRevalidation,
    chatStreams: new Map(),
    clients: new Map(),
    runningTurns: new Set(),
    compactingConversations: new Set(),
    capabilityMutations: new Set(),
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

  if (method === "POST" && url.pathname === "/api/workspaces") {
    const body = await readJsonBody<{ name?: string }>(state, req);
    const workspace = await createManagedWorkspace(body.name ?? "Personal Space", state.workspaceBase);
    state.spaceTrustAuthority.grant(workspace.rootPath);
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
    const workspace = await registerLinkedWorkspace(body.rootPath, body.providerHint);
    state.spaceTrustAuthority.grant(workspace.rootPath);
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
    sendJson(res, { uploaded }, 201);
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
    sendJson(res, { copied });
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
    const turnKey = clientKey(workspace.id, conversationId);
    const body = await readJsonBody<{ content?: string; contextPaths?: string[]; selectedPath?: string | null }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const selectedPath = normalizeSelectedPath(workspace.rootPath, body.selectedPath);
    const contextPaths = normalizeContextPaths(workspace.rootPath, body.contextPaths);
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
      actor: { kind: "assistant", cwd: workspace.rootPath, workspaceId: workspace.id, conversationId },
    });
    broadcast(state, turnKey, turnStateEvent(conversationId, true));
    const message = { id: randomUUID(), role: "user" as const, content, createdAt: new Date().toISOString() };
    try {
      await appendMessage(workspace.rootPath, conversationId, message);
    } catch (error) {
      state.runningTurns.delete(turnKey);
      state.kernel.finishTask(task.id);
      broadcast(state, turnKey, turnStateEvent(conversationId, false));
      throw error;
    }
    void runAgentTurn(state, workspace.id, workspace.rootPath, conversationId, content, contextPaths, selectedPath, task.id);
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
  changeTurnCount(state, 1);
  try {
    client = await getClient(state, workspaceId, workspaceRoot, conversationId);
    const contextAttachments = await loadConversationContextAttachmentsForTurn(workspaceRoot, contextPaths);
    await captureTurnCheckpointSafe(state, workspaceId, workspaceRoot, conversationId, "pre_turn");
    promptStarted = true;
    const finalText = await client.prompt(content, { contextAttachments, selectedPath });
    await appendMessage(workspaceRoot, conversationId, {
      id: randomUUID(),
      role: "assistant",
      content: finalText,
      createdAt: new Date().toISOString(),
    });
    broadcast(state, streamKey(workspaceId, conversationId), { type: "done", conversationId });
  } catch (error) {
    const message = isPiTurnCancelledError(error) ? "Agent turn cancelled." : errorMessage(error);
    broadcast(state, streamKey(workspaceId, conversationId), { type: "error", conversationId, message });
    await client?.stop().catch(() => undefined);
    state.clients.delete(key);
  } finally {
    if (promptStarted) await captureTurnCheckpointSafe(state, workspaceId, workspaceRoot, conversationId, "post_turn");
    state.runningTurns.delete(key);
    state.kernel.finishTask(taskId);
    broadcast(state, key, turnStateEvent(conversationId, false));
    changeTurnCount(state, -1);
  }
}

async function getClient(
  state: LocalApiState,
  workspaceId: string,
  workspaceRoot: string,
  conversationId: string,
): Promise<PiConversationClient> {
  const key = clientKey(workspaceId, conversationId);
  rememberWorkspaceRoot(state, workspaceId, workspaceRoot);
  const existing = state.clients.get(key);
  if (existing) return existing;
  const client = new PiConversationClient(conversationId, workspaceRoot, state.runtimeProvider, {
    workspaceId,
    restrictedAppProposals: state.restrictedAppProposals,
    restrictedApps: state.restrictedApps,
  });
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
  if (ids.some((workspaceId) => hasActiveAssistantOperationForWorkspace(state, workspaceId))) {
    throw httpError(409, "Wait for affected Assistant work to finish before changing capabilities.");
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
    ? state.runningTurns.size > 0 || state.compactingConversations.size > 0
    : hasActiveAssistantOperationForWorkspace(state, workspaceId);
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

function hasActiveAssistantOperationForWorkspace(state: LocalApiState, workspaceId: string): boolean {
  const prefix = `${workspaceId}:`;
  return [...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix));
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
  const status = explicit ?? restrictedAppErrorStatus(error) ?? 500;
  sendJson(res, {
    error: errorMessage(error),
    ...(error instanceof RestrictedAppError ? { code: error.code } : {}),
  }, status);
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
