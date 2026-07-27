import { randomUUID } from "node:crypto";
import { extname, posix } from "node:path";
import {
  BrowserWindow,
  ipcMain,
  session,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Rectangle,
  type Session,
  type WebContents,
} from "electron";

import {
  assertRestrictedAppEffectAuthority,
  RestrictedAppError,
  RestrictedAppNetworkBroker,
  type RestrictedAppConnectionStore,
} from "../../src/local/agent/restricted-app-connections.js";
import { validateRestrictedAppValue } from "../../src/local/agent/restricted-app-manifest.js";
import {
  buildRestrictedAppLimits,
  restrictedAppNetworkEnvelopeBytes,
  restrictedAppStorageEnvelopeBytes,
} from "../../src/local/agent/restricted-app-limits.js";
import {
  RestrictedAppFileBroker,
  RestrictedAppFileError,
} from "../../src/local/agent/restricted-app-files.js";
import {
  FileRestrictedAppStorage,
  RestrictedAppStorageError,
  type RestrictedAppStorageMutationResult,
} from "../../src/local/agent/restricted-app-storage.js";
import {
  RestrictedAppNotificationBroker,
  RestrictedAppNotificationError,
  type RestrictedAppNotificationOpenRequest,
} from "../../src/local/agent/restricted-app-notifications.js";
import { createWorkspaceMutationCheckpoint, discardWorkspaceCheckpoint } from "../../src/local/history.js";
import type { RestrictedAppOAuthPkceClient } from "../../src/local/agent/restricted-app-oauth.js";
import {
  snapshotRestrictedAppPackage,
  type RestrictedAppPackageSnapshot,
  type RestrictedAppStageReceipt,
} from "../../src/local/agent/restricted-app-package.js";
import type {
  RestrictedAppRuntimeAuthority,
  RestrictedAppRuntimeDescriptor,
  RestrictedAppRuntimeHost,
} from "../../src/local/agent/restricted-app-service.js";
import {
  authorityStampsEqual,
  parsePrincipalId,
  type EffectivePrincipal,
} from "../../src/local/agent/app-platform-contract.js";
import { resolveRestrictedAppCornerRadius } from "../../src/shared/restricted-app-presentation.js";

export const restrictedAppProtocol = "agent-app";
const networkChannel = "workspace:restricted-app:network";
const tabCommandChannel = "workspace:restricted-app:tabs";
const contextChannel = "workspace:restricted-app:context";
const storageChannel = "workspace:restricted-app:storage";
const storageChangedChannel = "workspace:restricted-app:storage-changed";
const filesChannel = "workspace:restricted-app:files";
const notificationsChannel = "workspace:restricted-app:notifications";
const indexPath = "/__workspace/index.html";
const bootstrapPath = "/__workspace/bootstrap.js";
const maxInvocationBytes = 256 * 1024;
const maxFileEnvelopeBytes = 800 * 1024;
const maxNotificationEnvelopeBytes = 4 * 1024;
const defaultInvocationTimeoutMs = 5_000;
const workerIdleTimeoutMs = 30_000;

export interface RestrictedAppHostOptions {
  connections: RestrictedAppConnectionStore;
  preloadPath: string;
  invocationTimeoutMs?: number;
  networkBroker?: RestrictedAppNetworkBroker;
  oauth?: RestrictedAppOAuthPkceClient;
  storage: FileRestrictedAppStorage;
  fileBroker?: RestrictedAppFileBroker;
  notifications: RestrictedAppNotificationBroker;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  onTabCommand?: (command: RestrictedAppTabCommand) => void;
  onUiState?: (state: RestrictedAppUiState) => void;
  onNotificationOpen?: (request: RestrictedAppNotificationOpenRequest) => void;
}

export interface RestrictedAppTabCommand {
  type: "open" | "update" | "close";
  workspaceId: string;
  appId: string;
  digest: string;
  sourceMountId: string;
  sourcePlacement: "navigator" | "tab";
  sourceAppTabId?: string;
  tab?: { appTabId: string; title: string; route: string; state?: unknown };
}

export interface RestrictedAppUiState {
  ownerWebContentsId: number;
  mountId: string;
  state: "ready" | "crashed" | "stopped";
  message?: string;
}

export interface RestrictedAppUiMountRequest {
  mountId: string;
  placement: "navigator" | "tab";
  appTabId?: string;
  route: string;
  state?: unknown;
  sequence: number;
  bounds: Rectangle;
  active: boolean;
  occluded: boolean;
  theme: "light" | "dark";
}

interface RestrictedAppInstance {
  key: string;
  webContentsId: number;
  token: string;
  origin: string;
  app: RestrictedAppRuntimeDescriptor;
  generation: number;
  snapshot: RestrictedAppPackageSnapshot;
  window: BrowserWindow;
  session: Session;
  pendingOperation: RestrictedAppPendingOperation | null;
  idleTimer?: NodeJS.Timeout;
  crashed: boolean;
  abortController: AbortController;
  destroyPromise?: Promise<void>;
}

interface RestrictedAppPendingOperation {
  kind: "action" | "automation";
  id: string;
  effectivePrincipal: EffectivePrincipal;
}

interface RestrictedAppEffectLease {
  instance: RestrictedAppNetworkInstance;
  operation?: RestrictedAppPendingOperation;
  requireActiveUi: boolean;
}

interface RestrictedAppLaunch {
  workspaceId: string;
  appId: string;
  digest: string;
  promise: Promise<RestrictedAppInstance>;
}

interface RestrictedAppUiInstance {
  mountId: string;
  ownerWebContentsId: number;
  webContentsId: number;
  token: string;
  origin: string;
  entryPath: string;
  app: RestrictedAppRuntimeDescriptor;
  generation: number;
  snapshot: RestrictedAppPackageSnapshot;
  parent: BrowserWindow;
  view: WebContentsView;
  session: Session;
  sequence: number;
  placement: "navigator" | "tab";
  appTabId?: string;
  route: string;
  state?: unknown;
  theme: "light" | "dark";
  active: boolean;
  occluded: boolean;
  crashed: boolean;
  abortController: AbortController;
  destroyPromise?: Promise<void>;
}

type RestrictedAppNetworkInstance = RestrictedAppInstance | RestrictedAppUiInstance;

interface PendingStorageEvent {
  revision: number;
  keys: Set<string>;
  reset: boolean;
  timer: NodeJS.Timeout;
}

export class RestrictedAppHost implements RestrictedAppRuntimeHost {
  readonly #connections: RestrictedAppConnectionStore;
  readonly #preloadPath: string;
  readonly #invocationTimeoutMs: number;
  readonly #network: RestrictedAppNetworkBroker;
  readonly #storage: FileRestrictedAppStorage;
  readonly #files: RestrictedAppFileBroker;
  readonly #limitsArgument: string;
  readonly #maxNetworkEnvelopeBytes: number;
  readonly #notifications: RestrictedAppNotificationBroker;
  readonly #resolveWorkspaceRoot: RestrictedAppHostOptions["resolveWorkspaceRoot"];
  readonly #onTabCommand?: RestrictedAppHostOptions["onTabCommand"];
  readonly #onUiState?: RestrictedAppHostOptions["onUiState"];
  readonly #onNotificationOpen?: RestrictedAppHostOptions["onNotificationOpen"];
  readonly #instances = new Map<string, RestrictedAppInstance>();
  readonly #uiInstances = new Map<string, RestrictedAppUiInstance>();
  readonly #instancesByWebContents = new Map<number, RestrictedAppNetworkInstance>();
  readonly #launches = new Map<string, RestrictedAppLaunch>();
  readonly #generations = new Map<string, number>();
  readonly #authorities = new Map<string, RestrictedAppRuntimeAuthority>();
  readonly #pendingStorageEvents = new Map<string, PendingStorageEvent>();
  readonly #storageLastEmittedAt = new Map<string, number>();
  #notificationsSuspended = false;
  #closed = false;

  constructor(options: RestrictedAppHostOptions) {
    this.#connections = options.connections;
    this.#preloadPath = options.preloadPath;
    this.#invocationTimeoutMs = options.invocationTimeoutMs ?? defaultInvocationTimeoutMs;
    this.#network = options.networkBroker ?? new RestrictedAppNetworkBroker({ credentials: options.connections, oauth: options.oauth });
    this.#storage = options.storage;
    this.#files = options.fileBroker ?? new RestrictedAppFileBroker();
    this.#notifications = options.notifications;
    this.#resolveWorkspaceRoot = options.resolveWorkspaceRoot;
    this.#onTabCommand = options.onTabCommand;
    this.#onUiState = options.onUiState;
    this.#onNotificationOpen = options.onNotificationOpen;
    // Composed from the live brokers so a host that overrides a bound cannot
    // publish a stale one. Serialized once: the values never change per mount.
    this.#limitsArgument = rendererArgument("limits", JSON.stringify(buildRestrictedAppLimits({
      network: {
        maxRequestBytes: this.#network.limits.maxRequestBytes,
        maxResponseBytes: this.#network.limits.maxResponseBytes,
        timeoutMs: this.#network.limits.timeoutMs,
        maxRedirects: this.#network.limits.maxRedirects,
      },
      files: {
        maxReadBytes: this.#files.limits.maxReadBytes,
        maxWriteBytes: this.#files.limits.maxWriteBytes,
      },
    })));
    this.#maxNetworkEnvelopeBytes = restrictedAppNetworkEnvelopeBytes(this.#network.limits.maxRequestBytes);
    ipcMain.handle(networkChannel, (event, value) => this.#handleNetwork(event, value));
    ipcMain.handle(storageChannel, (event, value) => this.#handleStorage(event, value));
    ipcMain.handle(filesChannel, (event, value) => this.#handleFiles(event, value));
    ipcMain.handle(notificationsChannel, (event, value) => this.#handleNotification(event, value));
    ipcMain.handle(tabCommandChannel, (event, value) => this.#handleTabCommand(event, value));
  }

  syncAuthority(authorities: readonly RestrictedAppRuntimeAuthority[]): void {
    const next = new Map<string, RestrictedAppRuntimeAuthority>();
    for (const authority of authorities) {
      const key = appScopeKey(authority.workspaceId, authority.appId);
      if (next.has(key)) throw new Error("Restricted app authority contains a duplicate runtime scope.");
      next.set(key, structuredClone(authority));
    }
    this.#authorities.clear();
    for (const [key, authority] of next) this.#authorities.set(key, authority);
    const invalidatedScopes = new Map<string, { workspaceId: string; appId: string }>();
    for (const instance of [...this.#instances.values(), ...this.#uiInstances.values()]) {
      if (!this.#persistentAuthorityMatches(instance.app)) {
        invalidatedScopes.set(appScopeKey(instance.app.workspaceId, instance.app.manifest.id), {
          workspaceId: instance.app.workspaceId,
          appId: instance.app.manifest.id,
        });
      }
    }
    for (const scope of invalidatedScopes.values()) this.#advanceGeneration(scope.workspaceId, scope.appId);
    for (const instance of [...this.#instances.values()]) {
      if (!this.#persistentAuthorityMatches(instance.app)) void this.#destroy(instance);
    }
    for (const instance of [...this.#uiInstances.values()]) {
      if (!this.#persistentAuthorityMatches(instance.app)) void this.#destroyUi(instance, "stopped");
    }
  }

  async invoke(app: RestrictedAppRuntimeDescriptor, action: string, input: unknown): Promise<unknown> {
    this.#assertOpen();
    if (!app.manifest.runtime.worker) throw new RestrictedAppError("APP_UNAVAILABLE", "This app does not expose a worker.");
    const tool = app.manifest.tools.find((item) => item.action === action);
    if (!tool) throw new RestrictedAppError("ACTION_UNKNOWN", "The restricted app action is not declared.");
    assertBoundedJson(input, "Restricted app input", maxInvocationBytes);
    try {
      validateRestrictedAppValue(tool.inputSchema, input, "Restricted app input");
    } catch (error) {
      throw new RestrictedAppError("INPUT_INVALID", errorMessage(error));
    }
    const generation = this.#generation(app.workspaceId, app.manifest.id);
    const instance = await this.#instance(app, generation);
    try {
      this.#assertLaunchCurrent(app, generation);
    } catch (error) {
      await this.#destroy(instance);
      throw error;
    }
    if (instance.pendingOperation) throw new RestrictedAppError("APP_UNAVAILABLE", "This restricted app is already handling an action.");
    instance.pendingOperation = {
      kind: "action",
      id: randomUUID(),
      effectivePrincipal: { principalId: app.principalId, kind: "human", realm: "local" },
    };
    const serializedInput = JSON.stringify(input);
    const expression = `globalThis.__workspaceInvoke(${JSON.stringify(action)},JSON.parse(${JSON.stringify(serializedInput)}))`;
    try {
      const envelope = await withDeadline(
        instance.window.webContents.executeJavaScript(expression, false),
        this.#invocationTimeoutMs,
        () => this.#crash(instance, "Restricted app action timed out."),
      );
      const result = parseInvocationEnvelope(envelope);
      try {
        validateRestrictedAppValue(tool.resultSchema, result, "Restricted app output");
      } catch (error) {
        throw new RestrictedAppError("OUTPUT_INVALID", errorMessage(error));
      }
      return structuredClone(result);
    } catch (error) {
      if (error instanceof RestrictedAppError) throw error;
      if (instance.crashed || instance.window.isDestroyed() || instance.window.webContents.isDestroyed()) {
        throw new RestrictedAppError("APP_CRASHED", "The restricted app renderer stopped while handling the action.");
      }
      throw new RestrictedAppError("APP_ERROR", safeRendererError(error));
    } finally {
      instance.pendingOperation = null;
      this.#scheduleWorkerIdle(instance);
    }
  }

  async runAutomation(
    app: RestrictedAppRuntimeDescriptor,
    event: {
      runId: string;
      automationId: string;
      handler: string;
      reason: "scheduled" | "manual" | "resume";
      scheduledAt: string;
      effectivePrincipal: EffectivePrincipal;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assertOpen();
    if (signal?.aborted) throw new RestrictedAppError("APP_UNAVAILABLE", "The automation was cancelled before it started.");
    const automation = app.manifest.automations.find((item) => item.id === event.automationId && item.handler === event.handler);
    if (!app.manifest.runtime.worker || !automation) {
      throw new RestrictedAppError("APP_UNAVAILABLE", "This app does not expose the requested automation.");
    }
    const effectivePrincipal = automationEffectivePrincipal(event.effectivePrincipal, event.reason, app.principalId);
    const { effectivePrincipal: _hostPrincipal, ...rendererEvent } = event;
    assertBoundedJson(rendererEvent, "Restricted app automation event", maxInvocationBytes);
    const generation = this.#generation(app.workspaceId, app.manifest.id);
    const instance = await this.#instance(app, generation);
    if (signal?.aborted) {
      await this.#destroy(instance);
      throw new RestrictedAppError("APP_UNAVAILABLE", "The automation was cancelled before it started.");
    }
    try {
      this.#assertLaunchCurrent(app, generation);
    } catch (error) {
      await this.#destroy(instance);
      throw error;
    }
    if (instance.pendingOperation) throw new RestrictedAppError("APP_UNAVAILABLE", "This restricted app is already handling work.");
    instance.pendingOperation = { kind: "automation", id: event.runId, effectivePrincipal };
    const serializedEvent = JSON.stringify(rendererEvent);
    const expression = `globalThis.__workspaceRunAutomation(JSON.parse(${JSON.stringify(serializedEvent)}))`;
    const abort = () => { void this.#destroy(instance); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const envelope = await withDeadline(
        instance.window.webContents.executeJavaScript(expression, false),
        this.#invocationTimeoutMs,
        () => this.#crash(instance, "Restricted app automation timed out."),
      );
      parseInvocationEnvelope(envelope);
    } catch (error) {
      if (error instanceof RestrictedAppError) throw error;
      if (instance.crashed || instance.window.isDestroyed() || instance.window.webContents.isDestroyed()) {
        throw new RestrictedAppError("APP_CRASHED", "The restricted app renderer stopped during automation work.");
      }
      throw new RestrictedAppError("APP_ERROR", safeRendererError(error));
    } finally {
      signal?.removeEventListener("abort", abort);
      instance.pendingOperation = null;
      this.#scheduleWorkerIdle(instance);
    }
  }

  async mountUi(
    app: RestrictedAppRuntimeDescriptor,
    owner: WebContents,
    parent: BrowserWindow,
    value: unknown,
  ): Promise<{ mounted: true; digest: string }> {
    this.#assertOpen();
    const request = parseUiMountRequest(value);
    const generation = this.#generation(app.workspaceId, app.manifest.id);
    const key = uiMountKey(owner.id, request.mountId);
    const current = this.#uiInstances.get(key);
    if (current) {
      if (current.app.workspaceId !== app.workspaceId || current.app.manifest.id !== app.manifest.id || current.app.digest !== app.digest) {
        await this.#destroyUi(current, "stopped");
      } else {
        this.#applyUiRequest(current, request);
        return { mounted: true, digest: app.digest };
      }
    }

    const receipt: RestrictedAppStageReceipt = {
      id: app.manifest.id,
      packageName: app.packageName,
      version: app.version,
      digest: app.digest,
      artifactDigest: app.artifactDigest,
      stagedRoot: app.stagedRoot,
      fileCount: app.fileCount,
      totalBytes: app.totalBytes,
      manifest: structuredClone(app.manifest),
    };
    const snapshot = await snapshotRestrictedAppPackage(receipt);
    try {
      this.#assertLaunchCurrent(app, generation);
    } catch (error) {
      this.#onUiState?.({ ownerWebContentsId: owner.id, mountId: request.mountId, state: "stopped" });
      throw error;
    }
    if (owner.isDestroyed() || parent.isDestroyed()) throw new RestrictedAppError("APP_UNAVAILABLE", "The Workspace window is not available.");

    const token = randomUUID().replace(/-/g, "");
    const origin = `${restrictedAppProtocol}://${token}`;
    const isolatedSession = session.fromPartition(`restricted-app-ui-${randomUUID()}`, { cache: false });
    isolatedSession.protocol.handle(restrictedAppProtocol, (protocolRequest) => this.#uiProtocolResponse(snapshot, token, protocolRequest));
    configureRestrictedSession(isolatedSession, token);
    const view = new WebContentsView({
      webPreferences: {
        session: isolatedSession,
        preload: this.#preloadPath,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        webviewTag: false,
        enableWebSQL: false,
        disableBlinkFeatures: "WebRTC",
        javascript: true,
        images: true,
        webgl: true,
        spellcheck: false,
        backgroundThrottling: true,
        disableDialogs: true,
        navigateOnDragDrop: false,
        additionalArguments: [
          "--workspace-restricted-mode=ui",
          rendererArgument("workspace-id", app.workspaceId),
          rendererArgument("app-id", app.manifest.id),
          rendererArgument("digest", app.digest),
          rendererArgument("mount-id", request.mountId),
          rendererArgument("placement", request.placement),
          rendererArgument("app-tab-id", request.appTabId ?? ""),
          rendererArgument("route", request.route),
          rendererArgument("theme", request.theme),
          rendererArgument("state", request.state === undefined ? "" : JSON.stringify(request.state)),
          this.#limitsArgument,
        ],
      },
    });
    // This clips the native pixels, not hit testing. The owning placeholder's
    // inset keeps the rounded cutout over inert pane background.
    view.setBorderRadius(resolveRestrictedAppCornerRadius(app.manifest.ui.cornerRadius));
    const entryPath = `/${app.manifest.runtime.entry}`;
    const instance: RestrictedAppUiInstance = {
      mountId: request.mountId,
      ownerWebContentsId: owner.id,
      webContentsId: view.webContents.id,
      token,
      origin,
      entryPath,
      app: structuredClone(app),
      generation,
      snapshot,
      parent,
      view,
      session: isolatedSession,
      sequence: request.sequence,
      placement: request.placement,
      ...(request.appTabId ? { appTabId: request.appTabId } : {}),
      route: request.route,
      ...(request.state !== undefined ? { state: structuredClone(request.state) } : {}),
      theme: request.theme,
      active: request.active,
      occluded: request.occluded,
      crashed: false,
      abortController: new AbortController(),
    };
    try {
      this.#assertLaunchCurrent(app, generation);
      this.#uiInstances.set(key, instance);
      this.#instancesByWebContents.set(view.webContents.id, instance);
      this.#configureUiContents(instance);
      this.#applyUiLayout(instance, request.bounds);
      await withDeadline(
        view.webContents.loadURL(`${origin}${entryPath}`),
        this.#invocationTimeoutMs,
        () => { throw new RestrictedAppError("APP_TIMEOUT", "Restricted app UI load timed out."); },
      );
      this.#assertLaunchCurrent(app, generation);
      if (this.#uiInstances.get(key) !== instance || instance.crashed) throw new RestrictedAppError("APP_UNAVAILABLE", "The app view was closed before it finished loading.");
      this.#emitUiState(instance, "ready");
      return { mounted: true, digest: app.digest };
    } catch (error) {
      const invalidated = this.#closed || this.#generation(app.workspaceId, app.manifest.id) !== generation;
      await this.#destroyUi(instance, invalidated ? "stopped" : "crashed", invalidated ? undefined : safeRendererError(error));
      if (error instanceof RestrictedAppError) throw error;
      throw new RestrictedAppError("APP_ERROR", `Restricted app UI could not start: ${safeRendererError(error)}`);
    }
  }

  layoutUi(ownerWebContentsId: number, value: unknown): void {
    const request = parseUiLayoutRequest(value);
    const instance = this.#uiInstances.get(uiMountKey(ownerWebContentsId, request.mountId));
    if (!instance || request.sequence <= instance.sequence || instance.crashed) return;
    this.#applyUiRequest(instance, request);
  }

  async unmountUi(ownerWebContentsId: number, mountId: string): Promise<void> {
    const id = mountIdValue(mountId);
    const instance = this.#uiInstances.get(uiMountKey(ownerWebContentsId, id));
    if (instance) await this.#destroyUi(instance, "stopped");
  }

  async unmountUiOwner(ownerWebContentsId: number): Promise<void> {
    await Promise.allSettled([...this.#uiInstances.values()]
      .filter((instance) => instance.ownerWebContentsId === ownerWebContentsId)
      .map((instance) => this.#destroyUi(instance, "stopped")));
  }

  async stop(workspaceId: string, appId: string, digest?: string): Promise<void> {
    this.#advanceGeneration(workspaceId, appId);
    this.#notifications.closeApp({ workspaceId, appId }, digest);
    this.#clearPendingStorageEvent(workspaceId, appId);
    this.#storageLastEmittedAt.delete(storageEventKey(workspaceId, appId));
    const workerDisposals: Promise<void>[] = [];
    for (const instance of [...this.#instances.values()]) {
      if (instance.app.workspaceId !== workspaceId || instance.app.manifest.id !== appId || (digest && instance.app.digest !== digest)) continue;
      workerDisposals.push(this.#destroy(instance));
    }
    const uiDisposals: Promise<void>[] = [];
    for (const instance of [...this.#uiInstances.values()]) {
      if (instance.app.workspaceId !== workspaceId || instance.app.manifest.id !== appId || (digest && instance.app.digest !== digest)) continue;
      uiDisposals.push(this.#destroyUi(instance, "stopped"));
    }
    this.#clearPendingStorageEvent(workspaceId, appId);
    await Promise.all([...workerDisposals, ...uiDisposals]);
    const launching = [...this.#launches.values()]
      .filter((item) => item.workspaceId === workspaceId && item.appId === appId)
      .map((item) => item.promise);
    await Promise.allSettled(launching);
  }

  suspend(): void {
    this.#notificationsSuspended = true;
    this.#notifications.closeAll();
  }

  resume(): void {
    this.#notificationsSuspended = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    ipcMain.removeHandler(networkChannel);
    ipcMain.removeHandler(storageChannel);
    ipcMain.removeHandler(filesChannel);
    ipcMain.removeHandler(notificationsChannel);
    ipcMain.removeHandler(tabCommandChannel);
    for (const event of this.#pendingStorageEvents.values()) clearTimeout(event.timer);
    this.#pendingStorageEvents.clear();
    this.#storageLastEmittedAt.clear();
    this.#notifications.dispose();
    for (const instance of this.#instances.values()) this.#advanceGeneration(instance.app.workspaceId, instance.app.manifest.id);
    await Promise.allSettled([...this.#launches.values()].map((item) => item.promise));
    await Promise.allSettled([...this.#instances.values()].map((instance) => this.#destroy(instance)));
    await Promise.allSettled([...this.#uiInstances.values()].map((instance) => this.#destroyUi(instance, "stopped")));
  }

  async #instance(app: RestrictedAppRuntimeDescriptor, expectedGeneration: number): Promise<RestrictedAppInstance> {
    const key = instanceKey(app.workspaceId, app.manifest.id, app.digest);
    const scopeKey = appScopeKey(app.workspaceId, app.manifest.id);
    const existing = this.#instances.get(key);
    if (existing && !existing.crashed && !existing.window.isDestroyed() && !existing.window.webContents.isDestroyed()) {
      this.#assertLaunchCurrent(app, expectedGeneration);
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
      return existing;
    }
    const launching = this.#launches.get(scopeKey);
    if (launching) {
      if (launching.digest === app.digest) {
        this.#assertLaunchCurrent(app, expectedGeneration);
        return await launching.promise;
      }
      this.#advanceGeneration(app.workspaceId, app.manifest.id);
      await launching.promise.catch(() => undefined);
    }
    for (const instance of [...this.#instances.values()]) {
      if (instance.app.workspaceId === app.workspaceId && instance.app.manifest.id === app.manifest.id) await this.#destroy(instance);
    }
    this.#assertLaunchCurrent(app, expectedGeneration);
    const promise = this.#launch(app, key, expectedGeneration).finally(() => {
      if (this.#launches.get(scopeKey)?.promise === promise) this.#launches.delete(scopeKey);
    });
    this.#launches.set(scopeKey, { workspaceId: app.workspaceId, appId: app.manifest.id, digest: app.digest, promise });
    return await promise;
  }

  async #launch(app: RestrictedAppRuntimeDescriptor, key: string, generation: number): Promise<RestrictedAppInstance> {
    const receipt: RestrictedAppStageReceipt = {
      id: app.manifest.id,
      packageName: app.packageName,
      version: app.version,
      digest: app.digest,
      artifactDigest: app.artifactDigest,
      stagedRoot: app.stagedRoot,
      fileCount: app.fileCount,
      totalBytes: app.totalBytes,
      manifest: structuredClone(app.manifest),
    };
    const snapshot = await snapshotRestrictedAppPackage(receipt);
    this.#assertLaunchCurrent(app, generation);
    let isolatedSession: Session | undefined;
    let instance: RestrictedAppInstance | undefined;
    try {
      const token = randomUUID().replace(/-/g, "");
      const origin = `${restrictedAppProtocol}://${token}`;
      isolatedSession = session.fromPartition(`restricted-app-${randomUUID()}`, { cache: false });
      isolatedSession.protocol.handle(restrictedAppProtocol, (request) => this.#protocolResponse(snapshot, token, request));
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>", `${restrictedAppProtocol}://*/*`] }, (details, callback) => {
        let allowed = false;
        try {
          const url = new URL(details.url);
          allowed = url.protocol === `${restrictedAppProtocol}:` && url.hostname === token
            && !url.port && !url.username && !url.password;
        } catch {
          allowed = false;
        }
        callback({ cancel: !allowed });
      });
      const window = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        frame: false,
        focusable: false,
        paintWhenInitiallyHidden: false,
        webPreferences: {
          session: isolatedSession,
          preload: this.#preloadPath,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: false,
          webviewTag: false,
          enableWebSQL: false,
          disableBlinkFeatures: "WebRTC",
          javascript: true,
          images: false,
          webgl: false,
          spellcheck: false,
          backgroundThrottling: true,
          disableDialogs: true,
          navigateOnDragDrop: false,
          additionalArguments: ["--workspace-restricted-mode=worker", this.#limitsArgument],
        },
      });
      const launchedInstance: RestrictedAppInstance = {
        key,
        webContentsId: window.webContents.id,
        token,
        origin,
        app: structuredClone(app),
        generation,
        snapshot,
        window,
        session: isolatedSession,
        pendingOperation: null,
        crashed: false,
        abortController: new AbortController(),
      };
      instance = launchedInstance;
      this.#instances.set(key, launchedInstance);
      this.#instancesByWebContents.set(window.webContents.id, launchedInstance);
      this.#configureContents(launchedInstance);
      this.#assertLaunchCurrent(app, generation);
      await withDeadline(
        window.loadURL(`${origin}${indexPath}`),
        this.#invocationTimeoutMs,
        () => this.#crash(launchedInstance, "Restricted app document load timed out."),
      );
      const ready = await withDeadline(
        window.webContents.executeJavaScript("globalThis.__workspaceReady", false),
        this.#invocationTimeoutMs,
        () => this.#crash(launchedInstance, "Restricted app startup timed out."),
      );
      if (ready !== true) throw new RestrictedAppError("APP_ERROR", "Restricted app startup did not complete.");
      this.#assertLaunchCurrent(app, generation);
      return launchedInstance;
    } catch (error) {
      if (instance) await this.#destroy(instance);
      else if (isolatedSession) await this.#disposeSession(isolatedSession);
      if (error instanceof RestrictedAppError) throw error;
      throw new RestrictedAppError("APP_ERROR", `Restricted app could not start: ${safeRendererError(error)}`);
    }
  }

  #configureContents(instance: RestrictedAppInstance): void {
    const contents = instance.window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("frame-created", (_event, details) => {
      if (details.frame === contents.mainFrame) return;
      this.#terminate(instance);
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.session.on("will-download", (event) => event.preventDefault());
    contents.on("render-process-gone", () => {
      instance.crashed = true;
      void this.#destroy(instance);
    });
    contents.on("destroyed", () => {
      instance.crashed = true;
      void this.#destroy(instance);
    });
  }

  #configureUiContents(instance: RestrictedAppUiInstance): void {
    const contents = instance.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.on("will-navigate", (event, url) => {
      if (!sameUiDocument(instance, url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.session.on("will-download", (event) => event.preventDefault());
    contents.on("render-process-gone", () => {
      instance.crashed = true;
      void this.#destroyUi(instance, "crashed", "The app view stopped unexpectedly.");
    });
    contents.on("destroyed", () => {
      if (instance.crashed) return;
      instance.crashed = true;
      void this.#destroyUi(instance, "stopped");
    });
  }

  #applyUiRequest(instance: RestrictedAppUiInstance, request: RestrictedAppUiMountRequest): void {
    if (request.sequence < instance.sequence) return;
    instance.sequence = request.sequence;
    instance.active = request.active;
    instance.occluded = request.occluded;
    instance.theme = request.theme;
    instance.route = request.route;
    instance.state = request.state === undefined ? undefined : structuredClone(request.state);
    this.#applyUiLayout(instance, request.bounds);
    if (!instance.view.webContents.isDestroyed()) {
      instance.view.webContents.send(contextChannel, {
        placement: instance.placement,
        appTabId: instance.appTabId ?? null,
        route: instance.route,
        state: instance.state ?? null,
        theme: instance.theme,
        active: instance.active && !instance.occluded,
      });
    }
  }

  #applyUiLayout(instance: RestrictedAppUiInstance, requestedBounds: Rectangle): void {
    if (instance.parent.isDestroyed() || instance.view.webContents.isDestroyed()) return;
    const bounds = clippedViewBounds(requestedBounds, instance.parent.getContentBounds(), instance.parent.webContents.getZoomFactor());
    const visible = instance.active && !instance.occluded && bounds.width > 0 && bounds.height > 0 && instance.parent.isVisible() && !instance.parent.isMinimized();
    if (!visible) {
      instance.view.setVisible(false);
      instance.parent.contentView.removeChildView(instance.view);
      return;
    }
    instance.parent.contentView.addChildView(instance.view);
    instance.view.setBounds(bounds);
    instance.view.setVisible(true);
  }

  async #destroyUi(instance: RestrictedAppUiInstance, state: RestrictedAppUiState["state"], message?: string): Promise<void> {
    if (instance.destroyPromise) return await instance.destroyPromise;
    instance.destroyPromise = (async () => {
      const key = uiMountKey(instance.ownerWebContentsId, instance.mountId);
      if (this.#uiInstances.get(key) === instance) this.#uiInstances.delete(key);
      if (this.#instancesByWebContents.get(instance.webContentsId) === instance) this.#instancesByWebContents.delete(instance.webContentsId);
      instance.crashed = state === "crashed";
      instance.abortController.abort();
      if (!instance.parent.isDestroyed()) instance.parent.contentView.removeChildView(instance.view);
      if (!instance.view.webContents.isDestroyed()) instance.view.webContents.close({ waitForBeforeUnload: false });
      await this.#disposeSession(instance.session);
      this.#emitUiState(instance, state, message);
    })();
    return await instance.destroyPromise;
  }

  #emitUiState(instance: RestrictedAppUiInstance, state: RestrictedAppUiState["state"], message?: string): void {
    this.#onUiState?.({
      ownerWebContentsId: instance.ownerWebContentsId,
      mountId: instance.mountId,
      state,
      ...(message ? { message: message.slice(0, 300) } : {}),
    });
  }

  async #handleTabCommand(event: IpcMainInvokeEvent, value: unknown): Promise<void> {
    const fromMainFrame = ipcFromMainFrame(event);
    const instance = this.#ownedActiveUiInstance(event.sender, fromMainFrame);
    if (!instance) throw new RestrictedAppError("APP_UNAVAILABLE", "The tab request did not come from an installed app's main frame.");
    this.#assertEffectAuthorized(instance);
    const command = parseTabCommand(value, instance);
    this.#onTabCommand?.(command);
  }

  async #handleNetwork(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const instance = this.#ownedPowerInstance(event.sender, ipcFromMainFrame(event));
    if (!instance) return { ok: false, error: { code: "NETWORK_DENIED", message: "The network caller is not an active restricted app." } };
    try {
      const lease = this.#captureEffectLease(instance);
      if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > this.#maxNetworkEnvelopeBytes) {
        throw new RestrictedAppError("NETWORK_DENIED", "The network request envelope exceeds the size limit.");
      }
      let request: unknown;
      try {
        request = JSON.parse(value);
      } catch {
        throw new RestrictedAppError("NETWORK_DENIED", "The network request envelope is invalid.");
      }
      const response = await this.#network.request({
        tenantId: instance.app.tenantId,
        runtimeInstanceId: instance.app.runtimeInstanceId,
        featureId: instance.app.manifest.id,
        featureInstallationId: instance.app.featureInstallationId,
        featureRevisionDigest: instance.app.artifactDigest,
        effectivePrincipalId: lease.operation
          ? lease.operation.effectivePrincipal.principalId
          : instance.app.principalId,
        connectionOwner: { kind: "instance", runtimeInstanceId: instance.app.runtimeInstanceId },
        networkGrants: [...instance.app.networkGrants],
      }, instance.app.manifest, request, instance.abortController.signal, () => this.#assertEffectLease(lease));
      this.#assertEffectLease(lease);
      return { ok: true, value: response };
    } catch (error) {
      const code = error instanceof RestrictedAppError ? error.code : "NETWORK_FAILED";
      return { ok: false, error: { code, message: errorMessage(error).slice(0, 500) } };
    }
  }

  async #handleStorage(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const instance = this.#ownedInstance(event.sender, ipcFromMainFrame(event));
    if (!instance || ("window" in instance && !instance.pendingOperation)) {
      return hostError("STORAGE_FAILED", "The storage caller is not an active restricted app.");
    }
    try {
      const lease = this.#captureEffectLease(instance, false);
      const request = jsonEnvelope(value, restrictedAppStorageEnvelopeBytes, "storage");
      const owner = {
        ownerClass: "instance" as const,
        tenantId: instance.app.tenantId,
        runtimeInstanceId: instance.app.runtimeInstanceId,
        featureInstallationId: instance.app.featureInstallationId,
        dataNamespaceId: instance.app.dataNamespaceId,
      };
      const authorizeCommit = () => this.#assertEffectLease(lease);
      let result: unknown;
      let mutation: RestrictedAppStorageMutationResult | undefined;
      if (request.operation === "usage") {
        assertRequestKeys(request, ["operation"]);
        result = await this.#storage.usage(owner);
      } else if (request.operation === "keys") {
        assertRequestKeys(request, ["operation", "prefix"]);
        result = await this.#storage.keys(owner, request.prefix === undefined ? "" : stringField(request.prefix, "Storage key prefix", 256));
      } else if (request.operation === "get") {
        assertRequestKeys(request, ["operation", "key"]);
        result = await this.#storage.get(owner, stringField(request.key, "Storage key", 256));
      } else if (request.operation === "set") {
        assertRequestKeys(request, ["operation", "key", "value"]);
        mutation = await this.#storage.set(owner, stringField(request.key, "Storage key", 256), request.value as never, authorizeCommit);
        result = mutation;
      } else if (request.operation === "delete") {
        assertRequestKeys(request, ["operation", "key"]);
        mutation = await this.#storage.delete(owner, stringField(request.key, "Storage key", 256), authorizeCommit);
        result = mutation;
      } else if (request.operation === "clear") {
        assertRequestKeys(request, ["operation"]);
        mutation = await this.#storage.clear(owner, authorizeCommit);
        result = mutation;
      } else if (request.operation === "transaction") {
        assertRequestKeys(request, ["operation", "transaction"]);
        mutation = await this.#storage.transaction(owner, request.transaction as never, authorizeCommit);
        result = mutation;
      } else {
        throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage operation is unsupported.");
      }
      this.#assertEffectLease(lease);
      if (mutation?.changed) this.#queueStorageChanged(instance, mutation);
      return { ok: true, value: result };
    } catch (error) {
      const code = error instanceof RestrictedAppStorageError || error instanceof RestrictedAppError
        ? error.code
        : "STORAGE_FAILED";
      return hostError(code, errorMessage(error));
    }
  }

  async #handleFiles(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const instance = this.#ownedPowerInstance(event.sender, ipcFromMainFrame(event));
    if (!instance) return hostError("FILE_DENIED", "The file caller is not an active restricted app.");
    try {
      const lease = this.#captureEffectLease(instance);
      const envelope = jsonEnvelope(value, maxFileEnvelopeBytes, "file");
      assertRequestKeys(envelope, ["operation", "request"]);
      const workspaceRoot = await this.#resolveWorkspaceRoot(instance.app.workspaceId);
      if (!workspaceRoot) throw new RestrictedAppFileError("FILE_DENIED", "The app's Space is no longer registered.");
      const context = {
        workspaceRoot,
        declarations: instance.app.manifest.permissions.files,
        grants: instance.app.fileGrants,
        authorizeCommit: () => this.#assertEffectLease(lease),
      };
      let result: unknown;
      if (envelope.operation === "list") result = await this.#files.list(context, envelope.request);
      else if (envelope.operation === "read") result = await this.#files.read(context, envelope.request);
      else if (envelope.operation === "write") {
        const target = fileCheckpointTarget(instance.app.fileGrants, envelope.request);
        const checkpoint = await createWorkspaceMutationCheckpoint(workspaceRoot, {
          ...(target.mode === "replace" ? { paths: [target.path] } : { deleteOnRestore: [target.path] }),
          reason: "restricted_app_write",
          label: `${instance.app.manifest.title} changed ${target.path}`,
        });
        try {
          result = await this.#files.write(context, envelope.request);
        } catch (error) {
          await discardWorkspaceCheckpoint(workspaceRoot, checkpoint.checkpointId).catch(() => undefined);
          throw error;
        }
      } else throw new RestrictedAppFileError("FILE_DENIED", "Restricted app file operation is unsupported.");
      this.#assertEffectLease(lease);
      return { ok: true, value: result };
    } catch (error) {
      const code = error instanceof RestrictedAppFileError || error instanceof RestrictedAppError
        ? error.code
        : "FILE_FAILED";
      return hostError(code, errorMessage(error));
    }
  }

  async #handleNotification(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const instance = this.#ownedInstance(event.sender, ipcFromMainFrame(event));
    if (!instance || !("window" in instance) || instance.pendingOperation?.kind !== "automation" || this.#notificationsSuspended) {
      return hostError("NOTIFICATION_DENIED", "Notifications are available only during an enabled automation run.");
    }
    try {
      const lease = this.#captureEffectLease(instance);
      const request = jsonEnvelope(value, maxNotificationEnvelopeBytes, "notification");
      const result = this.#notifications.show({
        workspaceId: instance.app.workspaceId,
        appId: instance.app.manifest.id,
        digest: instance.app.digest,
        appTitle: instance.app.manifest.title,
        declarations: instance.app.manifest.permissions.notifications,
        grants: instance.app.notificationGrants,
        automationEnabled: instance.app.automations.some((automation) => automation.enabled),
        invocationId: lease.operation!.id,
      }, request, (owner) => this.#onNotificationOpen?.(owner));
      this.#assertEffectLease(lease);
      return { ok: true, value: result };
    } catch (error) {
      const code = error instanceof RestrictedAppNotificationError || error instanceof RestrictedAppError
        ? error.code
        : "NOTIFICATION_FAILED";
      return hostError(code, errorMessage(error));
    }
  }

  #queueStorageChanged(source: RestrictedAppNetworkInstance, mutation: RestrictedAppStorageMutationResult): void {
    if (this.#closed || this.#instancesByWebContents.get(source.webContentsId) !== source) return;
    const hasActiveOwnerView = [...this.#instancesByWebContents.values()].some((instance) => (
      "view" in instance
      && instance.app.workspaceId === source.app.workspaceId
      && instance.app.manifest.id === source.app.manifest.id
      && this.#uiIsActive(instance)
    ));
    if (!hasActiveOwnerView) return;
    const key = storageEventKey(source.app.workspaceId, source.app.manifest.id);
    const pending = this.#pendingStorageEvents.get(key);
    const now = Date.now();
    if (pending) {
      pending.revision = Math.max(pending.revision, mutation.revision);
      if (!pending.reset) {
        for (const changedKey of mutation.changedKeys) pending.keys.add(changedKey);
        if (pending.keys.size > 128) {
          pending.keys.clear();
          pending.reset = true;
        }
      }
      return;
    }
    const keys = new Set(mutation.changedKeys);
    const reset = keys.size > 128;
    if (reset) keys.clear();
    const lastEmittedAt = this.#storageLastEmittedAt.get(key) ?? 0;
    const delay = Math.max(100, lastEmittedAt + 100 - now);
    const timer = setTimeout(() => this.#flushStorageChanged(source.app.workspaceId, source.app.manifest.id), delay);
    timer.unref?.();
    this.#pendingStorageEvents.set(key, { revision: mutation.revision, keys, reset, timer });
  }

  #flushStorageChanged(workspaceId: string, appId: string): void {
    const key = storageEventKey(workspaceId, appId);
    const pending = this.#pendingStorageEvents.get(key);
    if (!pending) return;
    this.#pendingStorageEvents.delete(key);
    this.#storageLastEmittedAt.set(key, Date.now());
    const event = {
      revision: pending.revision,
      keys: pending.reset ? [] : [...pending.keys].sort(),
      reset: pending.reset,
    };
    for (const instance of this.#instancesByWebContents.values()) {
      if (!("view" in instance) || instance.app.workspaceId !== workspaceId || instance.app.manifest.id !== appId
        || !this.#uiIsActive(instance)) continue;
      const bounds = instance.view.getBounds();
      if (bounds.width <= 0 || bounds.height <= 0 || instance.view.webContents.isDestroyed()) continue;
      instance.view.webContents.send(storageChangedChannel, event);
    }
  }

  #clearPendingStorageEvent(workspaceId: string, appId: string): void {
    const key = storageEventKey(workspaceId, appId);
    const pending = this.#pendingStorageEvents.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingStorageEvents.delete(key);
  }

  #ownedInstance(sender: WebContents, isMainFrame: boolean): RestrictedAppNetworkInstance | null {
    const instance = this.#instancesByWebContents.get(sender.id);
    if (!instance || instance.crashed || !isMainFrame || sender.isDestroyed()) return null;
    const expectedContents = "window" in instance ? instance.window.webContents : instance.view.webContents;
    if (sender !== expectedContents) return null;
    if ("window" in instance) {
      if (sender.mainFrame.url !== `${instance.origin}${indexPath}`) return null;
    } else if (!sameUiDocument(instance, sender.mainFrame.url)) return null;
    return instance;
  }

  #ownedPowerInstance(sender: WebContents, isMainFrame: boolean): RestrictedAppNetworkInstance | null {
    const instance = this.#ownedInstance(sender, isMainFrame);
    if (!instance) return null;
    if ("window" in instance) return instance.pendingOperation ? instance : null;
    return this.#uiIsActive(instance) ? instance : null;
  }

  #ownedActiveUiInstance(sender: WebContents, isMainFrame: boolean): RestrictedAppUiInstance | null {
    const instance = this.#ownedInstance(sender, isMainFrame);
    return instance && "view" in instance && this.#uiIsActive(instance) ? instance : null;
  }

  #captureEffectLease(instance: RestrictedAppNetworkInstance, requireActiveUi = true): RestrictedAppEffectLease {
    if ("window" in instance) {
      if (!instance.pendingOperation) throw new RestrictedAppError("AUTHORITY_STALE", "The restricted app operation has ended.");
      const lease = { instance, operation: instance.pendingOperation, requireActiveUi };
      this.#assertEffectLease(lease);
      return lease;
    }
    const lease = { instance, requireActiveUi };
    this.#assertEffectLease(lease);
    return lease;
  }

  #assertEffectLease(lease: RestrictedAppEffectLease): void {
    this.#assertEffectAuthorized(lease.instance);
    if ("window" in lease.instance) {
      if (!lease.operation || lease.instance.pendingOperation !== lease.operation) {
        throw new RestrictedAppError("AUTHORITY_STALE", "The restricted app operation ended before the effect could commit.");
      }
    } else if (lease.requireActiveUi && !this.#uiIsActive(lease.instance)) {
      throw new RestrictedAppError("AUTHORITY_STALE", "The restricted app view became inactive before the effect could commit.");
    }
  }

  #uiIsActive(instance: RestrictedAppUiInstance): boolean {
    if (this.#closed || this.#instancesByWebContents.get(instance.webContentsId) !== instance
      || instance.view.webContents.isDestroyed() || !instance.view.getVisible()) return false;
    const bounds = instance.view.getBounds();
    return bounds.width > 0 && bounds.height > 0 && instance.active && !instance.occluded && !instance.parent.isDestroyed()
      && instance.parent.isVisible() && !instance.parent.isMinimized();
  }

  #uiProtocolResponse(snapshot: RestrictedAppPackageSnapshot, token: string, request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return response("Method not allowed", 405, "text/plain");
    let url: URL;
    try { url = new URL(request.url); } catch { return response("Not found", 404, "text/plain"); }
    if (url.protocol !== `${restrictedAppProtocol}:` || url.hostname !== token || url.port || url.username || url.password) return response("Not found", 404, "text/plain");
    let path: string;
    try { path = decodeURIComponent(url.pathname.replace(/^\/+/, "")); } catch { return response("Not found", 404, "text/plain"); }
    if (!path || path.includes("\\") || path.includes("\0") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return response("Not found", 404, "text/plain");
    }
    const bytes = snapshot.files.get(path);
    const contentType = uiContentType(path, path === snapshot.receipt.manifest.runtime.entry);
    if (!bytes || !contentType) return response("Not found", 404, "text/plain");
    return uiResponse(request.method === "HEAD" ? null : Buffer.from(bytes), contentType, contentType.startsWith("text/html"));
  }

  #protocolResponse(snapshot: RestrictedAppPackageSnapshot, token: string, request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return response("Method not allowed", 405, "text/plain");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return response("Not found", 404, "text/plain");
    }
    if (url.protocol !== `${restrictedAppProtocol}:` || url.hostname !== token || url.port || url.username || url.password || url.search || url.hash) {
      return response("Not found", 404, "text/plain");
    }
    if (url.pathname === indexPath) {
      const html = '<!doctype html><meta charset="utf-8"><script type="module" src="/__workspace/bootstrap.js"></script>';
      return response(request.method === "HEAD" ? null : html, 200, "text/html; charset=utf-8", true);
    }
    if (url.pathname === bootstrapPath) {
      const worker = snapshot.receipt.manifest.runtime.worker;
      if (!worker) return response("Worker unavailable", 404, "text/plain");
      const entry = `/${worker}`;
      const source = [
        'for(const name of ["RTCPeerConnection","webkitRTCPeerConnection"]){Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});}',
        "const stringify=JSON.stringify.bind(JSON);",
        "const encode=TextEncoder.prototype.encode.bind(new TextEncoder());",
        `const ready=import(${JSON.stringify(entry)}).then((module)=>{`,
        `if(${snapshot.receipt.manifest.tools.length}>0&&typeof module.handleAction!=="function")throw new Error("Restricted app worker must export handleAction.");`,
        `if(${snapshot.receipt.manifest.automations.length > 0 ? "true" : "false"}&&typeof module.handleAutomation!=="function")throw new Error("Restricted app worker must export handleAutomation.");`,
        "return module;",
        "});",
        `const maximum=${maxInvocationBytes};`,
        'Object.defineProperty(globalThis,"__workspaceReady",{value:ready.then(()=>true),writable:false,configurable:false});',
        'Object.defineProperty(globalThis,"__workspaceInvoke",{value:async(action,input)=>{try{const module=await ready;const value=await module.handleAction(action,input);let json;try{json=stringify(value);}catch{return "E"+stringify({code:"OUTPUT_INVALID",message:"Restricted app output must be JSON-compatible."});}if(json===undefined||encode(json).byteLength>maximum)return "E"+stringify({code:"OUTPUT_INVALID",message:"Restricted app output exceeds the size limit."});return "S"+json;}catch(error){let message="Restricted app action failed.";try{message=String(error&&error.message||message).slice(0,500);}catch{}return "E"+stringify({code:"APP_ERROR",message});}},writable:false,configurable:false});',
        'Object.defineProperty(globalThis,"__workspaceRunAutomation",{value:async(event)=>{try{const module=await ready;await module.handleAutomation(event);return "Snull";}catch(error){let message="Restricted app automation failed.";try{message=String(error&&error.message||message).slice(0,500);}catch{}return "E"+stringify({code:"APP_ERROR",message});}},writable:false,configurable:false});',
      ].join("\n");
      return response(request.method === "HEAD" ? null : source, 200, "text/javascript; charset=utf-8", true);
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return response("Not found", 404, "text/plain");
    }
    if (!path || path.includes("\\") || path.includes("\0") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return response("Not found", 404, "text/plain");
    }
    const bytes = snapshot.files.get(path);
    const extension = extname(path).toLowerCase();
    if (!bytes || (extension !== ".js" && extension !== ".mjs" && extension !== ".json")) return response("Not found", 404, "text/plain");
    const body = request.method === "HEAD" ? null : Buffer.from(bytes);
    return response(body, 200, extension === ".json" ? "application/json" : "text/javascript; charset=utf-8", true);
  }

  #crash(instance: RestrictedAppInstance, message: string): never {
    if (instance.crashed) {
      void this.#destroy(instance);
      throw new RestrictedAppError("APP_CRASHED", "The restricted app renderer stopped while handling the action.");
    }
    this.#terminate(instance);
    throw new RestrictedAppError("APP_TIMEOUT", message);
  }

  #terminate(instance: RestrictedAppInstance): void {
    instance.crashed = true;
    if (!instance.window.isDestroyed() && !instance.window.webContents.isDestroyed()) instance.window.webContents.forcefullyCrashRenderer();
    void this.#destroy(instance);
  }

  async #destroy(instance: RestrictedAppInstance): Promise<void> {
    if (instance.destroyPromise) return await instance.destroyPromise;
    instance.destroyPromise = (async () => {
      this.#detach(instance);
      if (instance.idleTimer) clearTimeout(instance.idleTimer);
      instance.crashed = true;
      instance.abortController.abort();
      if (!instance.window.isDestroyed()) instance.window.destroy();
      await this.#disposeSession(instance.session);
    })();
    return await instance.destroyPromise;
  }

  #scheduleWorkerIdle(instance: RestrictedAppInstance): void {
    if (instance.idleTimer) clearTimeout(instance.idleTimer);
    instance.idleTimer = undefined;
    if (this.#closed || instance.crashed || this.#instances.get(instance.key) !== instance
      || instance.window.isDestroyed() || instance.window.webContents.isDestroyed()) return;
    const timer = setTimeout(() => {
      instance.idleTimer = undefined;
      if (!instance.pendingOperation) void this.#destroy(instance);
    }, workerIdleTimeoutMs);
    timer.unref?.();
    instance.idleTimer = timer;
  }

  async #disposeSession(isolatedSession: Session): Promise<void> {
    isolatedSession.setPermissionCheckHandler(null);
    isolatedSession.setPermissionRequestHandler(null);
    isolatedSession.setDevicePermissionHandler(null);
    isolatedSession.webRequest.onBeforeRequest(null);
    isolatedSession.removeAllListeners("will-download");
    await Promise.allSettled([
      Promise.resolve().then(() => isolatedSession.protocol.unhandle(restrictedAppProtocol)),
      isolatedSession.closeAllConnections(),
      isolatedSession.clearData(),
    ]);
  }

  #detach(instance: RestrictedAppInstance): void {
    if (this.#instances.get(instance.key) === instance) this.#instances.delete(instance.key);
    if (this.#instancesByWebContents.get(instance.webContentsId) === instance) this.#instancesByWebContents.delete(instance.webContentsId);
  }

  #assertOpen(): void {
    if (this.#closed) throw new RestrictedAppError("APP_UNAVAILABLE", "The restricted app host is closed.");
  }

  #generation(workspaceId: string, appId: string): number {
    return this.#generations.get(appScopeKey(workspaceId, appId)) ?? 0;
  }

  #advanceGeneration(workspaceId: string, appId: string): void {
    const key = appScopeKey(workspaceId, appId);
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
  }

  #assertLaunchCurrent(app: RestrictedAppRuntimeDescriptor, generation: number): void {
    if (this.#closed || this.#generation(app.workspaceId, app.manifest.id) !== generation) {
      throw new RestrictedAppError("APP_UNAVAILABLE", "The restricted app was stopped before startup completed.");
    }
    this.#assertPersistentAuthority(app);
  }

  #persistentAuthorityMatches(app: RestrictedAppRuntimeDescriptor): boolean {
    const current = this.#authorities.get(appScopeKey(app.workspaceId, app.manifest.id));
    return Boolean(current
      && current.digest === app.digest
      && current.runtimeInstanceId === app.runtimeInstanceId
      && current.featureInstallationId === app.featureInstallationId
      && authorityStampsEqual(current.authority, app.authority));
  }

  #assertEffectAuthorized(instance: RestrictedAppNetworkInstance): void {
    const app = instance.app;
    assertRestrictedAppEffectAuthority({
      hostOpen: !this.#closed,
      launchGeneration: instance.generation,
      currentGeneration: this.#generation(app.workspaceId, app.manifest.id),
      live: !instance.crashed
        && !instance.abortController.signal.aborted
        && this.#instancesByWebContents.get(instance.webContentsId) === instance,
      persistentAuthorityCurrent: this.#persistentAuthorityMatches(app),
    });
  }

  #assertPersistentAuthority(app: RestrictedAppRuntimeDescriptor): void {
    if (!this.#persistentAuthorityMatches(app)) {
      throw new RestrictedAppError("AUTHORITY_STALE", "The restricted app authority changed before the effect could commit.");
    }
  }
}

function configureRestrictedSession(isolatedSession: Session, token: string): void {
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setDevicePermissionHandler(() => false);
  isolatedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>", `${restrictedAppProtocol}://*/*`] }, (details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === `${restrictedAppProtocol}:` && url.hostname === token && !url.port && !url.username && !url.password;
    } catch {
      allowed = false;
    }
    callback({ cancel: !allowed });
  });
}

function parseUiMountRequest(value: unknown): RestrictedAppUiMountRequest {
  const record = strictRecord(value, "Restricted app view", [
    "mountId", "placement", "appTabId", "route", "state", "sequence", "bounds", "active", "occluded", "theme",
  ]);
  const placement = record.placement;
  if (placement !== "navigator" && placement !== "tab") throw new Error("Restricted app view placement is invalid.");
  const appTabId = record.appTabId === undefined || record.appTabId === null || record.appTabId === ""
    ? undefined
    : appTabIdValue(record.appTabId);
  if (placement === "tab" && !appTabId) throw new Error("Restricted app tabs require an app tab id.");
  if (placement === "navigator" && appTabId) throw new Error("Restricted app navigators cannot claim an app tab id.");
  const state = jsonStateValue(record.state);
  return {
    mountId: mountIdValue(record.mountId),
    placement,
    ...(appTabId ? { appTabId } : {}),
    route: appRouteValue(record.route),
    ...(state !== undefined ? { state } : {}),
    sequence: sequenceValue(record.sequence),
    bounds: rectangleValue(record.bounds),
    active: booleanValue(record.active, "Restricted app view active state"),
    occluded: booleanValue(record.occluded, "Restricted app view occlusion state"),
    theme: themeValue(record.theme),
  };
}

function parseUiLayoutRequest(value: unknown): RestrictedAppUiMountRequest {
  return parseUiMountRequest(value);
}

function parseTabCommand(value: unknown, instance: RestrictedAppUiInstance): RestrictedAppTabCommand {
  const record = strictRecord(value, "Restricted app tab command", ["type", "tabId", "title", "route", "state"]);
  if (record.type !== "open" && record.type !== "update" && record.type !== "close") throw new Error("Restricted app tab command is invalid.");
  if ((record.type === "update" || record.type === "close") && (instance.placement !== "tab" || !instance.appTabId)) {
    throw new Error("Only an app tab can update or close itself.");
  }
  let tab: RestrictedAppTabCommand["tab"];
  if (record.type !== "close") {
    const state = jsonStateValue(record.state);
    tab = {
      appTabId: record.type === "open" ? appTabIdValue(record.tabId) : instance.appTabId!,
      title: boundedText(record.title, "Restricted app tab title", 120),
      route: appRouteValue(record.route),
      ...(state !== undefined ? { state } : {}),
    };
  }
  return {
    type: record.type,
    workspaceId: instance.app.workspaceId,
    appId: instance.app.manifest.id,
    digest: instance.app.digest,
    sourceMountId: instance.mountId,
    sourcePlacement: instance.placement,
    ...(instance.appTabId ? { sourceAppTabId: instance.appTabId } : {}),
    ...(tab ? { tab } : {}),
  };
}

function strictRecord(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`${label} contains an unsupported field: ${unknown}`);
  return record;
}

function jsonEnvelope(value: unknown, maximum: number, label: string): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`Restricted app ${label} request exceeds the size limit.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Restricted app ${label} request is invalid.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Restricted app ${label} request must be an object.`);
  return parsed as Record<string, unknown>;
}

function assertRequestKeys(value: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`Restricted app request contains an unsupported field: ${unknown}`);
}

function stringField(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${label} is invalid.`);
  return value;
}

function hostError(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message: message.slice(0, 500) } };
}

function fileCheckpointTarget(
  grants: readonly { id: string; root: string }[],
  value: unknown,
): { path: string; mode: "create" | "replace" } {
  const request = strictRecord(value, "Restricted app file write", ["grantId", "path", "encoding", "data", "mode"]);
  if (request.mode !== "create" && request.mode !== "replace") throw new RestrictedAppFileError("FILE_DENIED", "App file write mode is invalid.");
  const grantId = stringField(request.grantId, "App file grant id", 64);
  const grant = grants.find((item) => item.id === grantId);
  if (!grant) throw new RestrictedAppFileError("FILE_DENIED", "The app does not have this Space file grant.");
  const requested = safeCheckpointPath(request.path);
  const path = requested === "." ? grant.root : grant.root === "." ? requested : posix.join(grant.root, requested);
  if (path === ".") throw new RestrictedAppFileError("FILE_DENIED", "An app cannot replace the Space root.");
  return { path, mode: request.mode };
}

function safeCheckpointPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\\") || value.includes(":") || value.includes("\0") || value.startsWith("/")) {
    throw new RestrictedAppFileError("FILE_DENIED", "App file path is invalid.");
  }
  if (value === ".") return value;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".workspace" || segment === ".pi")) {
    throw new RestrictedAppFileError("FILE_DENIED", "App file path is invalid.");
  }
  return segments.join("/");
}

function mountIdValue(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/i.test(value)) throw new Error("Restricted app mount id is invalid.");
  return value.toLowerCase();
}

function appTabIdValue(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new Error("Restricted app tab id is invalid.");
  return value;
}

function appRouteValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || /[\\\0\r\n]/.test(value) || !value.startsWith("/") || value.startsWith("//")) {
    throw new Error("Restricted app route must be an origin-relative path.");
  }
  const parsed = new URL(value, "https://restricted-app.invalid");
  if (parsed.origin !== "https://restricted-app.invalid") throw new Error("Restricted app route escapes its app.");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function jsonStateValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  assertBoundedJson(value, "Restricted app tab state", 64 * 1024);
  return structuredClone(value);
}

function sequenceValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Restricted app view sequence is invalid.");
  return value as number;
}

function rectangleValue(value: unknown): Rectangle {
  const record = strictRecord(value, "Restricted app view bounds", ["x", "y", "width", "height"]);
  const numbers = [record.x, record.y, record.width, record.height];
  if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item)) || (record.width as number) < 0 || (record.height as number) < 0) {
    throw new Error("Restricted app view bounds are invalid.");
  }
  return {
    x: Math.round(record.x as number),
    y: Math.round(record.y as number),
    width: Math.round(record.width as number),
    height: Math.round(record.height as number),
  };
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function themeValue(value: unknown): "light" | "dark" {
  if (value !== "light" && value !== "dark") throw new Error("Restricted app theme is invalid.");
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function uiMountKey(ownerWebContentsId: number, mountId: string): string {
  return `${ownerWebContentsId}:${mountId}`;
}

function ipcFromMainFrame(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  const mainFrame = event.sender.mainFrame;
  return frame.processId === mainFrame.processId && frame.routingId === mainFrame.routingId;
}

function rendererArgument(name: string, value: string): string {
  return `--workspace-restricted-${name}=${encodeURIComponent(value)}`;
}

function sameUiDocument(instance: RestrictedAppUiInstance, value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${restrictedAppProtocol}:`
      && url.hostname === instance.token
      && !url.port
      && !url.username
      && !url.password
      && url.pathname === instance.entryPath;
  } catch {
    return false;
  }
}

function clippedViewBounds(bounds: Rectangle, contentBounds: Rectangle, zoomFactor: number): Rectangle {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = Math.max(0, Math.round(bounds.x * scale));
  const y = Math.max(0, Math.round(bounds.y * scale));
  const right = Math.min(contentBounds.width, Math.round((bounds.x + bounds.width) * scale));
  const bottom = Math.min(contentBounds.height, Math.round((bounds.y + bounds.height) * scale));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function uiContentType(path: string, declaredEntry: boolean): string | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return declaredEntry ? "text/html; charset=utf-8" : null;
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return null;
}

function uiResponse(body: BodyInit | null, contentType: string, html: boolean): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()",
      "referrer-policy": "no-referrer",
      "x-dns-prefetch-control": "off",
      "x-content-type-options": "nosniff",
      ...(html ? {
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'",
      } : {}),
    },
  });
}

function response(body: BodyInit | null, status: number, contentType: string, csp = false): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()",
      "referrer-policy": "no-referrer",
      "x-dns-prefetch-control": "off",
      "x-content-type-options": "nosniff",
      ...(csp ? {
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'",
      } : {}),
    },
  });
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => never): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout();
          } catch (error) {
            reject(error);
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertBoundedJson(value: unknown, label: string, maximum: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RestrictedAppError(label.includes("output") ? "OUTPUT_INVALID" : "INPUT_INVALID", `${label} must be JSON-compatible.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maximum) {
    throw new RestrictedAppError(label.includes("output") ? "OUTPUT_INVALID" : "INPUT_INVALID", `${label} exceeds the size limit.`);
  }
}

function parseInvocationEnvelope(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxInvocationBytes + 1_024) {
    throw new RestrictedAppError("OUTPUT_INVALID", "Restricted app output envelope exceeds the size limit.");
  }
  if (value.startsWith("E")) {
    let record: { code?: unknown; message?: unknown };
    try {
      record = JSON.parse(value.slice(1)) as { code?: unknown; message?: unknown };
    } catch {
      throw new RestrictedAppError("OUTPUT_INVALID", "Restricted app output envelope is invalid.");
    }
    const code = record.code === "OUTPUT_INVALID" ? "OUTPUT_INVALID" : "APP_ERROR";
    const message = typeof record.message === "string" ? record.message.slice(0, 500) : "Restricted app action failed.";
    throw new RestrictedAppError(code, message);
  }
  if (!value.startsWith("S") || Buffer.byteLength(value.slice(1), "utf8") > maxInvocationBytes) {
    throw new RestrictedAppError("OUTPUT_INVALID", "Restricted app output envelope is invalid.");
  }
  try {
    return JSON.parse(value.slice(1));
  } catch {
    throw new RestrictedAppError("OUTPUT_INVALID", "Restricted app output must be valid JSON.");
  }
}

function automationEffectivePrincipal(
  value: EffectivePrincipal,
  reason: "scheduled" | "manual" | "resume",
  localHumanPrincipalId: RestrictedAppRuntimeDescriptor["principalId"],
): EffectivePrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 3
    || !Object.prototype.hasOwnProperty.call(value, "principalId")
    || !Object.prototype.hasOwnProperty.call(value, "kind")
    || !Object.prototype.hasOwnProperty.call(value, "realm")) {
    throw new RestrictedAppError("APP_UNAVAILABLE", "The automation effective Principal is invalid.");
  }
  const principalId = parsePrincipalId(value.principalId);
  const expectedKind = reason === "manual" ? "human" : "service";
  if (value.realm !== "local" || value.kind !== expectedKind
    || (reason === "manual" && principalId !== localHumanPrincipalId)) {
    throw new RestrictedAppError("APP_UNAVAILABLE", "The automation effective Principal does not match its run reason.");
  }
  return Object.freeze({ principalId, kind: expectedKind, realm: "local" });
}

function instanceKey(workspaceId: string, appId: string, digest: string): string {
  return JSON.stringify([workspaceId, appId, digest]);
}

function appScopeKey(workspaceId: string, appId: string): string {
  return JSON.stringify([workspaceId, appId]);
}

function storageEventKey(workspaceId: string, appId: string): string {
  return JSON.stringify([workspaceId, appId]);
}

function safeRendererError(error: unknown): string {
  const message = errorMessage(error).replace(/(?:[A-Za-z]:)?[\\/][^\s:]+/g, "app code");
  return message.slice(0, 500) || "Restricted app action failed.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
