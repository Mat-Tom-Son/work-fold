import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray,
  type ContextMenuParams,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
} from "electron";

import { RoutedPiExtensionUiBridge, type PiExtensionUiEvent } from "../../src/local/agent/extension-ui.js";
import { defaultAgentSdkDir } from "../../src/local/agent/agent-data-dir.js";
import {
  RegisteredSpaceRuntimeProvider,
  RegisteredSpaceTrustAuthority,
} from "../../src/local/agent/registered-space-runtime.js";
import type { PiRuntimeProvider } from "../../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../../src/local/server.js";
import { loadLocalEnvironmentFile } from "../../src/local/server-dev-options.js";
import type { WorkFoldActFacade } from "../../src/local/cli/act-facade.js";
import {
  removeWorkFoldCliActTokenFile,
  writeWorkFoldCliActTokenFile,
} from "../../src/local/cli/act-token.js";
import { configureWorkFoldStateRoot, managedSpaceRoot, workFoldManagementRoot } from "../../src/local/state-paths.js";
import { getSpace, listSpaces } from "../../src/local/space.js";
import { containsReservedSpacePathSegment } from "../../src/local/space-path-policy.js";
import { WorkFoldCliKernelAdapter } from "../../src/local/work-fold-cli-adapter.js";
import { WorkFoldKernel } from "../../src/local/work-fold-kernel.js";
import { WorkFoldCheckService } from "../../src/local/checks/check-service.js";
import { WorkFoldSettleSignal } from "../../src/local/routings/settle-signal.js";
import { RestrictedAppService } from "../../src/local/agent/restricted-app-service.js";
import { FileRestrictedAppStorage } from "../../src/local/agent/restricted-app-storage.js";
import { RestrictedAppNotificationBroker } from "../../src/local/agent/restricted-app-notifications.js";
import { restrictedAppRoot } from "../../src/local/state-paths.js";
import {
  WorkFoldDesktopCliHost,
  workFoldCliInstanceData,
  workFoldCliRequestIdFromArgv,
  workFoldSecondInstanceIntent,
} from "./work-fold-cli-host.js";
import { ManagementPopover, type ManagementPopoverStagedItem } from "./management-popover.js";
import { PackagedPiRuntimeProvider } from "./pi-runtime.js";
import { applyLoginShellEnvironment, formatLoginShellEnvironmentResult, type LoginShellEnvironmentResult } from "./shell-environment.js";
import { createRestrictedAppConnectionStore } from "./restricted-app-connections.js";
import { createRestrictedAppOAuthClient } from "./restricted-app-oauth.js";
import { RestrictedAppHost, restrictedAppProtocol } from "./restricted-app-host.js";
import { SecureSettingsStore } from "./settings.js";
import { DesktopUpdater, type DesktopUpdateStatus } from "./updater.js";
import {
  workFoldDesktopUserDataPath,
  workFoldDesktopStateOverride,
  workFoldDesktopUsesInstalledProductData,
} from "./user-data-path.js";
import {
  latestWorkFoldReleaseUrl,
  runWorkFoldStartupRecovery,
  workFoldStartupRecoveryPlan,
  type WorkFoldStartupRecoveryPlan,
} from "./startup-recovery.js";
import { createDesktopPiOAuthHooks } from "./pi-oauth.js";
import { AppLifetimeResource } from "./app-lifetime-resource.js";
import {
  nativeFileMenuItems,
  parseNativeFileMenuRequest,
  type NativeFileMenuCommand,
  type NativeFileMenuRequest,
} from "./file-context-menu.js";
import { desktopWindowMaterial, shouldUseMacVibrancy, shouldUseWindowsMica } from "./window-material.js";
import { GracefulQuitCoordinator, type QuitPreparationOutcome } from "./quit-coordinator.js";
import { RailTooltipOverlay } from "./rail-tooltip-overlay.js";
import { productIdentity } from "../../src/shared/product-identity.js";
import { resolveDesktopApplicationVersion } from "./application-version.js";
import {
  RemoteAccessClient,
  RemoteBridgeRequestError,
  createRemoteBridgePublicationSync,
  generateRemoteDeviceKeys,
  runRemoteAccountRemoval,
  type RemoteAccessStatus,
  type RemotePairingPrompt,
} from "./remote-access.js";
import type { RemoteAccessSettings } from "./settings.js";

const productionProductName = productIdentity.productName;
const localMacSmokeProductName = productIdentity.macSmokeProductName;
const localMacSmokeBuild = process.platform === "darwin" && app.isPackaged && packagedBuildChannel() === "mac-local-smoke";
const productName = localMacSmokeBuild ? localMacSmokeProductName : productionProductName;
const appProtocol = productIdentity.internalProtocol;
const appUserModelId = productIdentity.productionAppId;
const desktopAssetRoutePrefix = "/_desktop-assets/";
const desktopTitleBarHeight = 40;
const desktopTitleBarOverlayPalettes = {
  light: { color: "#f2f4ef", symbolColor: "#1c2530" },
  dark: { color: "#0f1622", symbolColor: "#e9eef7" },
} as const;
// Electron supports Mica on Windows 11 22H2+ (build 22621). Older builds and
// reduced-transparency sessions use a solid theme-matched window background.
const micaSupported = shouldUseWindowsMica(
  process.platform,
  process.getSystemVersion(),
  nativeTheme.prefersReducedTransparency,
);
const macVibrancyEnabled = process.env.WORKFOLD_MAC_NATIVE_MATERIAL?.trim() !== "0";
const macVibrancySupported = shouldUseMacVibrancy(
  process.platform,
  nativeTheme.prefersReducedTransparency,
  macVibrancyEnabled,
);
const nativeWindowMaterial = desktopWindowMaterial(process.platform, {
  windowsMica: micaSupported,
  macVibrancy: macVibrancySupported,
});
const windowBackgroundColors = { light: "#f2f4ef", dark: "#0f1622" } as const;

function titleBarOverlayFor(theme: "light" | "dark"): Electron.TitleBarOverlay {
  return {
    ...desktopTitleBarOverlayPalettes[theme],
    // With Mica the window-controls corner stays transparent so the material
    // shows through the whole title bar instead of a solid strip.
    ...(micaSupported ? { color: "#00000000" } : {}),
    height: desktopTitleBarHeight,
  };
}
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
// Development builds may override public service origins through the
// repository's ignored local configuration. Packaged builds use the public
// work-fold bridge and never depend on release-workstation credentials.
if (!app.isPackaged) loadLocalEnvironmentFile(join(repoRoot, ".env"));
const applicationVersion = resolveDesktopApplicationVersion({
  isPackaged: app.isPackaged,
  electronVersion: app.getVersion(),
  developmentPackageVersion: developmentPackageVersion(),
});
const folderGrantTtlMs = 5 * 60 * 1000;
const shutdownTimeoutMs = 10_000;
const windowStateSaveDelayMs = 500;
const rendererRecoveryMaxAttempts = 6;
const rendererRecoveryBaseDelayMs = 1_000;
const rendererRecoveryMaxDelayMs = 30_000;
const resumeRendererHealthDelayMs = 5_000;
const resumeUpdateCheckDelayMs = 20_000;
const headlessCliIdleGraceMs = 500;
const defaultWindowState = { width: 1440, height: 960 };
const minimumWindowState = { width: 1100, height: 760 };
const folderGrants = new Map<string, { spaceRoot: string; expiresAt: number }>();

let mainWindow: BrowserWindow | null = null;
let railTooltipOverlay: RailTooltipOverlay | null = null;
let tray: Tray | null = null;
let managementPopover: ManagementPopover | null = null;
const localApiLifetime = new AppLifetimeResource<Awaited<ReturnType<typeof startLocalApi>>>();
let piRuntime: PackagedPiRuntimeProvider | null = null;
let secureSettings: SecureSettingsStore | null = null;
let remoteAccessClient: RemoteAccessClient | null = null;
let apiSessionToken = "";
let actFacade: WorkFoldActFacade | null = null;
let actToken = "";
let resolveManagementLineageParent: ((taskId: string) => { taskId: string } | null) | null = null;
/**
 * The routing executor's sleep/wake lifecycle handle (docs/fold-routings.md:
 * suspension aborts the active run, which settles `interrupted`; resume
 * re-arms cadences from the durable anchor). Set once the interactive local
 * API exists; both calls are safe no-ops after close.
 */
let routingPowerLifecycle: { suspend: () => void; resume: () => Promise<void> } | null = null;
let quitting = false;
let quittingForUpdate = false;
let activeAgentTurns = 0;
let powerBlockerId: number | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let startupRecoveryPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let rendererProtocolRegistered = false;
let ipcRegistered = false;
let powerMonitorRegistered = false;
let accentColorMonitorRegistered = false;
let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let rendererRecoveryInFlight = false;
let rendererRecoveryAttempts = 0;
let rendererLoadFailed = false;
let rendererRecoveryFailurePromptShown = false;
let createWindowPromise: Promise<void> | null = null;
let rendererMenuState: RendererMenuState = { spaceOpen: false };
let desktopHostPromise: Promise<DesktopHost> | null = null;
let interactiveStartupPromise: Promise<void> | null = null;
let activateRegistered = false;
let interactiveRequested = false;
let cliRequestGeneration = 0;
let activeNativeSpace: { id: string; name: string; spaceRoot: string } | null = null;
let activeNativeSpaceGeneration = 0;
let pendingOpenSpaceRequest: { token: string; spaceId: string } | null = null;
const pendingMacOpenPaths: string[] = [];
let macOpenPathDrainPromise: Promise<void> | null = null;
const quitCoordinator = new GracefulQuitCoordinator({
  prepare: prepareForApplicationQuit,
  quit: () => app.quit(),
  onError: (error) => {
    console.warn(`${productName} quit preparation failed; continuing shutdown: ${errorMessage(error)}`);
  },
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: appProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: restrictedAppProtocol,
    privileges: {
      standard: true,
      secure: true,
    },
  },
]);

function packagedBuildChannel(): string {
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { workFoldBuildChannel?: unknown };
    return typeof metadata.workFoldBuildChannel === "string" ? metadata.workFoldBuildChannel : "production";
  } catch {
    // Historical production packages predate the explicit channel marker.
    return "production";
  }
}

function developmentPackageVersion(): string | undefined {
  if (app.isPackaged) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof metadata.version === "string" ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

app.setName(productName);
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);

configureStableUserDataPath();
let initialCliRequestId: string | null = null;
let initialCliArgumentError: unknown = null;
try {
  initialCliRequestId = workFoldCliRequestIdFromArgv(process.argv);
} catch (error) {
  initialCliArgumentError = error;
}
interactiveRequested = initialCliRequestId === null && initialCliArgumentError === null;
const ownsInstance = app.requestSingleInstanceLock(workFoldCliInstanceData(initialCliRequestId));
if (!ownsInstance) app.quit();

if (ownsInstance && process.platform === "darwin") {
  // macOS can deliver this before `ready`. Queue the path so Finder and Dock
  // launches can be resolved against the registered Space catalog once the
  // app host is available. Unknown folders are never registered implicitly.
  app.on("open-file", (event, path) => {
    event.preventDefault();
    pendingMacOpenPaths.push(path);
    interactiveRequested = true;
    if (app.isReady()) {
      void startInteractiveApp()
        .then(drainPendingMacOpenPaths)
        .catch(reportStartupError);
    }
  });
}

if (ownsInstance) {
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    // Route by cause: the shim relaunches this executable for every CLI
    // request, so anything CLI-shaped stays headless — even when the request
    // id was lost in transit — and only a genuine interactive relaunch (the
    // person opened work-fold again) may front the window.
    const intent = workFoldSecondInstanceIntent(argv, additionalData);
    if (intent.kind === "cli-invalid") {
      console.warn(`${productName} rejected an invalid CLI launch: ${intent.reason}`);
      return;
    }
    if (intent.kind === "cli") {
      void processWorkFoldCliRequest(intent.requestId).catch((error) => {
        console.warn(`${productName} could not process CLI request ${intent.requestId}: ${errorMessage(error)}`);
      });
      return;
    }
    interactiveRequested = true;
    void startInteractiveApp().then(showWindow).catch(reportStartupError);
  });
  app.whenReady().then(async () => {
    configureStableUserDataPath();
    configureWorkFoldStateRoot(app.getPath("userData"));
    await ensureLoginShellEnvironment();
    configureCliEnvironment();
    if (initialCliArgumentError) throw initialCliArgumentError;
    if (initialCliRequestId) {
      await processWorkFoldCliRequest(initialCliRequestId);
      if (!interactiveRequested) {
        await quitAfterCliRequest();
        return;
      }
    }
    await startInteractiveApp();
  }).catch(reportStartupError);
}

app.on("window-all-closed", () => {
  if (quittingForUpdate) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  if (!quitCoordinator.shouldPreventNativeQuit()) return;
  event.preventDefault();
  quitCoordinator.requestQuit();
});

async function prepareForApplicationQuit(): Promise<QuitPreparationOutcome> {
  destroyTray();
  if (desktopUpdater?.shouldInstallOnQuit()) {
    await shutdownForUpdateInstall();
    const status = await desktopUpdater.installDownloadedUpdateOnQuit();
    if (status.phase === "installing") return "handoff";
    desktopUpdater.dispose();
    desktopUpdater = null;
    return "quit";
  }
  await shutdown();
  desktopUpdater?.dispose();
  desktopUpdater = null;
  return "quit";
}

function requestApplicationQuit(): void {
  quitting = true;
  quitCoordinator.requestQuit();
}

interface DesktopHost {
  settings: SecureSettingsStore;
  extensionUi: RoutedPiExtensionUiBridge;
  runtime: PackagedPiRuntimeProvider;
  runtimeProvider: PiRuntimeProvider;
  spaceTrustAuthority: RegisteredSpaceTrustAuthority;
  kernel: WorkFoldKernel;
  checks: WorkFoldCheckService;
  cli: WorkFoldDesktopCliHost;
  restrictedApps: RestrictedAppService;
  restrictedAppHost: RestrictedAppHost;
  /**
   * The one in-process settle seam (docs/fold-routings.md): the host's Check
   * and restricted-app services publish into this exact instance, and the
   * interactive local API consumes it for routing triggers — one signal for
   * the whole desktop, or settles silently never reach enabled routings.
   */
  settleSignal: WorkFoldSettleSignal;
}

let loginShellEnvironmentPromise: Promise<LoginShellEnvironmentResult> | null = null;

/**
 * Dock, Finder, Spotlight, and `open` launches inherit launchd's minimal
 * environment, so Pi's shell tools would miss everything the person's shell
 * profile adds to PATH. Resolve the login shell once, before any Pi session or
 * CLI PATH pin can observe process.env; a terminal launch is left untouched.
 */
function ensureLoginShellEnvironment(): Promise<LoginShellEnvironmentResult> {
  loginShellEnvironmentPromise ??= applyLoginShellEnvironment().then((result) => {
    const line = formatLoginShellEnvironmentResult(result);
    if (result.status === "failed") console.warn(`${productName}: ${line}`);
    else console.log(`${productName}: ${line}`);
    return result;
  });
  return loginShellEnvironmentPromise;
}

async function ensureDesktopHost(): Promise<DesktopHost> {
  if (desktopHostPromise) return desktopHostPromise;
  desktopHostPromise = (async () => {
    await ensureLoginShellEnvironment();
    const userData = app.getPath("userData");
    configureWorkFoldStateRoot(userData);
    const settings = new SecureSettingsStore(join(userData, "secure-settings.bin"));
    const restrictedConnections = createRestrictedAppConnectionStore(join(userData, "restricted-app-connections.bin"));
    const restrictedOAuth = createRestrictedAppOAuthClient(restrictedConnections, (url) => shell.openExternal(url));
    const restrictedStorage = new FileRestrictedAppStorage(join(restrictedAppRoot(), "data"));
    const restrictedNotifications = new RestrictedAppNotificationBroker({
      sink: {
        isSupported: () => Notification.isSupported(),
        show: (display, callbacks) => {
          const notification = new Notification({ title: display.title, body: display.body });
          notification.on("click", callbacks.onClick);
          notification.on("close", callbacks.onClose);
          notification.show();
          return { close: () => notification.close() };
        },
      },
    });
    // One settle signal for the whole desktop host: the Check service and the
    // restricted-app service publish durable settles into it, and the local
    // API's routing executor subscribes to the same instance.
    const settleSignal = new WorkFoldSettleSignal();
    let restrictedApps!: RestrictedAppService;
    const restrictedRuntime = new RestrictedAppHost({
      connections: restrictedConnections,
      oauth: restrictedOAuth,
      storage: restrictedStorage,
      notifications: restrictedNotifications,
      resolveSpaceRoot: async (spaceId) => (await listSpaces()).find((space) => space.id === spaceId)?.spaceRoot ?? null,
      preloadPath: resolveRestrictedAppPreloadPath(),
      onTabCommand: (command) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("work-fold:restricted-app-view:tab-command", command);
      },
      onUiState: (state) => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== state.ownerWebContentsId) return;
        mainWindow.webContents.send("work-fold:restricted-app-view:state", state);
      },
      onNotificationOpen: (request) => {
        void restrictedApps.runtimeDescriptor(request.spaceId, request.appId, request.digest).then((current) => {
          const enabledForNotification = current.automations.some((state) => state.enabled
            && current.manifest.automations.some((automation) => automation.id === state.id
              && automation.permissions.notifications.includes(request.permissionId)));
          if (!enabledForNotification || !current.notificationGrants.includes(request.permissionId)
            || !current.manifest.permissions.notifications.some((item) => item.id === request.permissionId)) return;
          showWindow();
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send("work-fold:restricted-app-view:open-request", request);
        }).catch(() => undefined);
      },
    });
    try {
      restrictedApps = await RestrictedAppService.create({
        rootPath: restrictedAppRoot(),
        runtimeHost: restrictedRuntime,
        connections: restrictedConnections,
        oauth: restrictedOAuth,
        storage: restrictedStorage,
        deferAutomationStart: true,
        settleSignal,
      });
    } catch (error) {
      await restrictedRuntime.close();
      throw error;
    }
    try {
      const extensionUi = new RoutedPiExtensionUiBridge();
      extensionUi.on("event", (event: PiExtensionUiEvent) => {
      if (event.method === "openExternal") void openExternal(event.url);
      else if (event.method === "oauthDeviceCode") void openExternal(event.verificationUri);
      else if (event.method === "copyText") clipboard.writeText(event.text);
      else if (event.method === "openSettings") mainWindow?.webContents.send("work-fold:agent:open-settings");
      else if (event.method === "quit") app.quit();
      });
      const runtime = new PackagedPiRuntimeProvider({
        agentDir: defaultAgentSdkDir(),
        authStorageHost: settings,
        assistantPreferencesPath: join(userData, "assistant-model-preferences.json"),
        openRouterCatalogPath: join(userData, "model-catalogs", "openrouter.json"),
        managementRoot: workFoldManagementRoot(),
        extensionUi,
      });
      const spaceTrustAuthority = new RegisteredSpaceTrustAuthority((await listSpaces()).map((space) => space.spaceRoot));
      const runtimeProvider = new RegisteredSpaceRuntimeProvider(runtime, spaceTrustAuthority);
      const kernel = new WorkFoldKernel({ runtimeProvider });
      const checks = new WorkFoldCheckService({ kernel, settleSignal });
      const cli = new WorkFoldDesktopCliHost({
      stateRoot: userData,
      kernel: new WorkFoldCliKernelAdapter(kernel, {
        checksStatusProvider: ({ spaceId, spaceRoot }) => checks.status({ id: spaceId, spaceRoot: spaceRoot }),
      }),
      version: applicationVersion,
      productName,
      getActFacade: () => (actFacade && actToken ? { facade: actFacade, token: actToken } : null),
      resolveLineageParent: (taskId) => resolveManagementLineageParent?.(taskId) ?? null,
      });
      await cli.initialize();
      secureSettings = settings;
      piRuntime = runtime;
      return { settings, extensionUi, runtime, runtimeProvider, spaceTrustAuthority, kernel, checks, cli, restrictedApps, restrictedAppHost: restrictedRuntime, settleSignal };
    } catch (error) {
      await restrictedApps.close();
      throw error;
    }
  })();
  return desktopHostPromise;
}

async function processWorkFoldCliRequest(requestId: string): Promise<void> {
  cliRequestGeneration += 1;
  const host = await ensureDesktopHost();
  await host.cli.processRequest(requestId);
}

async function startInteractiveApp(): Promise<void> {
  interactiveRequested = true;
  if (interactiveStartupPromise) return interactiveStartupPromise;
  interactiveStartupPromise = (async () => {
    await ensureDesktopHost();
    const api = await ensureInteractiveLocalApi();
    loadDesktopPreferences();
    registerRendererProtocol();
    registerIpc();
    await ensureMainWindow();
    await ensureRemoteAccessClient(api);
    configureUpdater();
    createTrayIfSupported();
    if (!activateRegistered) {
      activateRegistered = true;
      app.on("activate", () => {
        if (!mainWindow || mainWindow.isDestroyed()) void ensureMainWindow();
        else showWindow();
      });
    }
    await drainPendingMacOpenPaths();
  })();
  return interactiveStartupPromise;
}

async function quitAfterCliRequest(): Promise<void> {
  const host = await ensureDesktopHost();
  while (!interactiveRequested) {
    const observedGeneration = cliRequestGeneration;
    await host.cli.whenIdle();
    await host.runtime.flush();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, headlessCliIdleGraceMs));
    if (observedGeneration === cliRequestGeneration) break;
  }
  if (interactiveRequested) {
    await startInteractiveApp();
    return;
  }
  await host.restrictedApps.close();
  await host.checks.close();
  // A headless boot proves no interactive app holds the single-instance lock,
  // so any act-token file on disk is stale crash residue; removing it lets
  // shims fail fast instead of booting another headless host per attempt.
  await removeWorkFoldCliActTokenFile(app.getPath("userData")).catch(() => undefined);
  quitting = true;
  // Exit synchronously after the queue and host-backed auth storage are both
  // drained so a new process cannot hand work to a half-shutdown primary.
  quitCoordinator.allowNativeQuit();
  app.quit();
}

function reportStartupError(error: unknown): void {
  console.error(`${productName} could not start: ${errorMessage(error)}`);
  const recovery = workFoldStartupRecoveryPlan(error);
  if (interactiveRequested && recovery) {
    startupRecoveryPromise ??= recoverFromNewerLocalState(recovery).catch((recoveryError) => {
      console.error(`${productName} update recovery failed: ${errorMessage(recoveryError)}`);
      dialog.showErrorBox(
        `${productName} update recovery failed`,
        "work-fold could not complete update recovery. Your Spaces and app data are still safe.",
      );
      quitting = true;
      app.quit();
    });
    return;
  }
  if (interactiveRequested) dialog.showErrorBox(`${productName} could not start`, errorMessage(error));
  quitting = true;
  app.quit();
}

async function recoverFromNewerLocalState(plan: WorkFoldStartupRecoveryPlan): Promise<void> {
  await runWorkFoldStartupRecovery(plan, {
    showDialog: async (prompt) => (await dialog.showMessageBox({
      type: prompt.type,
      title: prompt.title,
      message: prompt.message,
      detail: prompt.detail,
      buttons: prompt.buttons,
      defaultId: prompt.defaultId,
      cancelId: prompt.cancelId,
      noLink: true,
    })).response,
    checkForUpdate: async () => {
      configureUpdater();
      const checked = await checkForUpdates(true);
      if (checked.phase === "error") throw new Error(checked.error ?? checked.message);
      return checked.phase === "available" ? checked.availableVersion : null;
    },
    downloadAndInstall: async () => {
      if (!desktopUpdater) return false;
      let status = await desktopUpdater.updateNow();
      if (status.phase === "ready") status = await desktopUpdater.install();
      return status.phase === "installing";
    },
    openReleases: () => openExternal(latestWorkFoldReleaseUrl),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
}

function ensureInteractiveLocalApi(): Promise<Awaited<ReturnType<typeof startLocalApi>>> {
  return localApiLifetime.ensure(async () => {
    const userData = app.getPath("userData");
    const host = await ensureDesktopHost();
    apiSessionToken = randomUUID();
    const api = await startLocalApi({
      appMode: "desktop",
      port: 0,
      spaceBase: managedSpaceRoot(),
      stateBase: userData,
      sessionToken: apiSessionToken,
      allowedOrigins: [`${appProtocol}://app`],
      piRuntimeProvider: host.runtime,
      piOAuthHooks: createDesktopPiOAuthHooks({
        openExternal,
        readClipboard: () => clipboard.readText(),
        writeClipboard: (value) => clipboard.writeText(value),
        showMessageBox: (options) => dialog.showMessageBox(options),
        onError: (error) => console.warn(`${productName} provider sign-in UI failed: ${errorMessage(error)}`),
      }),
      spaceTrustAuthority: host.spaceTrustAuthority,
      extensionUiBridge: host.extensionUi,
      kernel: host.kernel,
      checkService: host.checks,
      // The exact instance the injected Check and restricted-app services
      // publish into, so desktop settles reach routing triggers; and the CLI
      // host's own act-receipts journal, so decisions, publications, and CLI
      // acts share one ledger file and one at-most-once gate.
      settleSignal: host.settleSignal,
      actReceipts: host.cli.receipts,
      localFolderGrantProvider: { consumeLocalFolderGrant },
      restrictedAppService: host.restrictedApps,
      onAgentTurnActivity: updateAgentPowerState,
      // Pages your fold serves (docs/fold-publishing.md): publication keys
      // live in operating-system-encrypted secure settings beside the other
      // Remote access material, and the slot/snapshot sync lane reads the
      // current Remote access credential at call time — unconfigured means
      // slot syncs stay honestly pending while deletions are already
      // satisfied by the account cascade.
      publicationKeys: host.settings.publicationKeyStore(),
      publicationBridge: createRemoteBridgePublicationSync(() => host.settings.getRemoteAccess()),
    });
    // The per-launch act token authorizes the CLI act lane for exactly this
    // interactive run; without a readable token file, act commands stay
    // unavailable rather than half-working.
    actToken = randomBytes(32).toString("hex");
    actFacade = api.actFacade;
    resolveManagementLineageParent = api.resolveManagementLineageParent;
    routingPowerLifecycle = api.routings;
    try {
      await writeWorkFoldCliActTokenFile(userData, actToken, productName);
    } catch (error) {
      actFacade = null;
      actToken = "";
      console.warn(`${productName} could not write the CLI act token; act commands will report unavailable: ${errorMessage(error)}`);
    }
    return api;
  });
}

async function ensureRemoteAccessClient(api: Awaited<ReturnType<typeof startLocalApi>>): Promise<RemoteAccessClient> {
  if (remoteAccessClient) return remoteAccessClient;
  const host = await ensureDesktopHost();
  remoteAccessClient = new RemoteAccessClient({
    settingsStore: host.settings,
    facade: api.remoteFacade,
    promptPairing: promptRemoteBrowserPairing,
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("work-fold:remote-access:status", status);
    },
    // The desktop side of the serving path: `viewer.fetch` renders through
    // the publication authority's effect-time recheck, reconnects re-drive
    // pending slot syncs and snapshot seeds, and the bridge's resting notice
    // becomes the publisher-facing health note the glance surfaces.
    viewerPages: {
      servePage: (publicationId) => api.publications.serveViewerPage(publicationId),
      serveAppCall: (publicationId, call) => api.publications.serveViewerAppCall(publicationId, call),
      onDeviceConnected: () => api.publications.redriveBridgeSync(),
      noteResting: (publicationId, reason) => api.publications.noteViewerResting(publicationId, reason),
    },
  });
  const settings = await host.settings.getRemoteAccess();
  if (settings?.enabled) await remoteAccessClient.start();
  return remoteAccessClient;
}

async function promptRemoteBrowserPairing(pairing: RemotePairingPrompt): Promise<boolean> {
  const unverifiedBrowserLabel = JSON.stringify(pairing.label);
  const options = {
    type: "question" as const,
    title: "Approve remote browser",
    message: "Approve this remote browser?",
    detail: `Unverified browser-supplied label: ${unverifiedBrowserLabel}\n\nConfirm that this code also appears in the browser:\n\n${pairing.code}\n\nThis is a full-trust grant. The browser can ask work-fold to read or change files your account can access and run commands on this computer. Revoke it immediately if you do not recognize it.`,
    buttons: ["Approve browser", "Decline"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function configureRemoteAccess(value: unknown): Promise<RemoteAccessStatus> {
  const request = remoteAccessSetupRequest(value);
  const host = await ensureDesktopHost();
  const api = await ensureInteractiveLocalApi();
  const existing = await host.settings.getRemoteAccess();
  const bridgeUrl = existing?.bridgeUrl ?? remoteBridgeUrl();
  if (!existing) {
    const keys = generateRemoteDeviceKeys();
    const enrolled = await remoteBridgeRequest<{
      account: { id: string; slug: string };
      deviceToken: string;
    }>(bridgeUrl, "/api/device/enroll", {
      method: "POST",
      body: {
        slug: request.slug,
        password: request.password,
        deviceSigningPublicJwk: keys.deviceSigningPublicJwk,
        deviceEncryptionPublicJwk: keys.deviceEncryptionPublicJwk,
      },
    });
    await host.settings.setRemoteAccess({
      enabled: true,
      bridgeUrl,
      accountId: enrolled.account.id,
      slug: enrolled.account.slug,
      deviceToken: enrolled.deviceToken,
      ...keys,
      grants: [],
    });
  } else {
    const updated = await remoteBridgeRequest<{ account: { id: string; slug: string } }>(bridgeUrl, "/api/device/account", {
      method: "PUT",
      token: existing.deviceToken,
      body: { slug: request.slug, password: request.password },
    });
    await host.settings.setRemoteAccess({ ...existing, enabled: true, slug: updated.account.slug });
  }
  const client = await ensureRemoteAccessClient(api);
  client.stop();
  await client.start();
  return client.status();
}

async function setRemoteAccessEnabled(value: unknown): Promise<RemoteAccessStatus> {
  if (typeof value !== "boolean") throw new Error("Web access enabled state must be a boolean.");
  const host = await ensureDesktopHost();
  const settings = await host.settings.setRemoteAccessEnabled(value);
  if (!settings) throw new Error("Set up web access before enabling it.");
  const client = await ensureRemoteAccessClient(await ensureInteractiveLocalApi());
  if (value) await client.start(); else {
    try { await client.stopActiveRemoteTasks(); }
    finally { client.stop(); }
  }
  return client.status();
}

async function revokeRemoteBrowser(value: unknown): Promise<RemoteAccessStatus> {
  if (typeof value !== "string" || !value || value.length > 160) throw new Error("A browser grant id is required.");
  const host = await ensureDesktopHost();
  const settings = await requiredRemoteAccessSettings(host.settings);
  const client = await ensureRemoteAccessClient(await ensureInteractiveLocalApi());
  await runRemoteRevocationSteps([
    () => client.revokeLocalGrant(value),
    () => remoteBridgeRequest(settings.bridgeUrl, `/api/device/grants/${encodeURIComponent(value)}`, { method: "DELETE", token: settings.deviceToken }),
  ]);
  return client.status();
}

async function revokeAllRemoteBrowsers(): Promise<RemoteAccessStatus> {
  const host = await ensureDesktopHost();
  const settings = await requiredRemoteAccessSettings(host.settings);
  const client = await ensureRemoteAccessClient(await ensureInteractiveLocalApi());
  await runRemoteRevocationSteps([
    () => client.revokeAllLocalGrants(),
    () => remoteBridgeRequest(settings.bridgeUrl, "/api/device/grants/revoke-all", { method: "POST", token: settings.deviceToken, body: {} }),
  ]);
  return client.status();
}

async function removeRemoteAccess(): Promise<RemoteAccessStatus> {
  const host = await ensureDesktopHost();
  const settings = await requiredRemoteAccessSettings(host.settings);
  const client = await ensureRemoteAccessClient(await ensureInteractiveLocalApi());
  try {
    await runRemoteAccountRemoval({
      revokeLocalAuthority: () => client.revokeAllLocalGrants(),
      disableLocalAccess: () => host.settings.setRemoteAccessEnabled(false),
      deleteBridgeAccount: () => remoteBridgeRequest(settings.bridgeUrl, "/api/device/account", { method: "DELETE", token: settings.deviceToken }),
      clearLocalCredentials: () => host.settings.clearRemoteAccess(),
    });
  } finally {
    client.stop();
  }
  return client.status();
}

async function runRemoteRevocationSteps(steps: Array<() => Promise<unknown>>): Promise<void> {
  const failures: string[] = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { failures.push(errorMessage(error)); }
  }
  if (failures.length) throw new Error(failures.join(" "));
}

async function requiredRemoteAccessSettings(settings: SecureSettingsStore): Promise<RemoteAccessSettings> {
  const configured = await settings.getRemoteAccess();
  if (!configured) throw new Error("Web access is not configured.");
  return configured;
}

function remoteBridgeUrl(): string {
  const value = process.env.WORKFOLD_REMOTE_BRIDGE_URL?.trim() || "https://www.work-fold.com";
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && new Set(["localhost", "127.0.0.1"]).has(url.hostname)))
    || url.pathname !== "/" || url.username || url.password) throw new Error("WORKFOLD_REMOTE_BRIDGE_URL is invalid.");
  return url.toString();
}

function remoteAccessSetupRequest(value: unknown): { slug: string; password: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Web access setup is invalid.");
  const record = value as { slug?: unknown; password?: unknown };
  const slug = typeof record.slug === "string" ? record.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(slug) || slug.length < 3) {
    throw new Error("Choose 3–32 lowercase letters, numbers, or hyphens.");
  }
  if (typeof record.password !== "string" || record.password.length < 8 || record.password.length > 256) {
    throw new Error("Use a password of at least 8 characters.");
  }
  return { slug, password: record.password };
}

async function remoteBridgeRequest<T = unknown>(
  bridgeUrl: string,
  path: string,
  options: { method: "GET" | "POST" | "PUT" | "DELETE"; token?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(new URL(path, bridgeUrl), {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({})) as { error?: unknown } & T;
  if (!response.ok) {
    throw new RemoteBridgeRequestError(
      response.status,
      typeof body.error === "string" ? body.error : `Remote bridge request failed (${response.status}).`,
    );
  }
  return body;
}

async function createMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
    return;
  }

  const api = await ensureInteractiveLocalApi();

  const state = visibleWindowState(readWindowState());
  const initialState = state ?? defaultWindowState;
  mainWindow = new BrowserWindow({
    ...initialState,
    minWidth: minimumWindowState.width,
    minHeight: minimumWindowState.height,
    title: productName,
    icon: resolveWindowIcon(),
    autoHideMenuBar: process.platform === "win32",
    ...(process.platform === "win32" ? {
      ...(micaSupported ? { backgroundMaterial: "mica" as const } : {}),
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlayFor(nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    } : {}),
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      ...(macVibrancySupported ? {
        vibrancy: "sidebar" as const,
        visualEffectState: "followWindow" as const,
      } : {}),
    } : {}),
    // Solid backgrounds paint over native materials. Reduced-transparency
    // sessions deliberately receive the opaque theme-matched fallback.
    ...(nativeWindowMaterial === "none"
      ? { backgroundColor: windowBackgroundColors[nativeTheme.shouldUseDarkColors ? "dark" : "light"] }
      : { backgroundColor: "#00000000" }),
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: !app.isPackaged,
      // Assistant turns and automations are owned by the app host, not renderer
      // paint. Let Chromium throttle hidden/occluded UI to preserve battery life.
      backgroundThrottling: true,
      additionalArguments: [
        ...productRendererArguments(),
        rendererArgument("api-base-url", api.origin),
        rendererArgument("app-version", applicationVersion),
        rendererArgument("window-material", nativeWindowMaterial),
      ],
    },
  });
  railTooltipOverlay = new RailTooltipOverlay(mainWindow);

  applyNativeActiveSpaceToWindow(mainWindow);

  if (process.platform === "win32") {
    try {
      mainWindow.webContents.session.setSpellCheckerLanguages(["en-US"]);
    } catch (error) {
      console.warn(`${productName} could not configure spellchecker languages: ${errorMessage(error)}`);
    }
  }
  const rendererWebContentsId = mainWindow.webContents.id;
  mainWindow.webContents.on("did-start-navigation", () => railTooltipOverlay?.hide());
  mainWindow.webContents.on("render-process-gone", () => railTooltipOverlay?.hide());
  mainWindow.webContents.on("page-title-updated", (event) => {
    if (process.platform !== "darwin" || !activeNativeSpace) return;
    event.preventDefault();
    applyNativeActiveSpaceToWindow(mainWindow);
  });
  mainWindow.webContents.once("destroyed", () => {
    void desktopHostPromise?.then((host) => host.restrictedAppHost.unmountUiOwner(rendererWebContentsId));
  });
  configureWindowStatePersistence(mainWindow);
  if (state?.isMaximized) mainWindow.maximize();
  // First reveal only: renderer recoveries can re-emit ready-to-show, and a
  // window the person hid (Windows close-to-tray, minimize) must not
  // resurface because an autonomous reload finished painting.
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("blur", () => railTooltipOverlay?.hide());
  mainWindow.on("hide", () => railTooltipOverlay?.hide());
  mainWindow.on("minimize", () => railTooltipOverlay?.hide());
  mainWindow.on("close", (event) => {
    if (quitting || quittingForUpdate || !quitCoordinator.shouldPreventNativeQuit()) return;
    // Close-to-tray is Windows behavior; the macOS menu-bar item must not
    // change what closing the last macOS window means (Dock keeps the host).
    if (process.platform !== "win32" || !tray || !desktopPreferences.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
    maybeShowTrayNotice();
  });
  mainWindow.on("query-session-end", () => { void shutdown(); });
  mainWindow.on("session-end", () => {
    quitting = true;
    void shutdown();
  });
  mainWindow.on("closed", () => {
    railTooltipOverlay?.close();
    railTooltipOverlay = null;
    mainWindow = null;
    if (process.platform !== "darwin" && !quitting && !quittingForUpdate) app.quit();
  });
  configureWindowNavigation(mainWindow);
  configureContextMenu(mainWindow);
  configureWindowResilience(mainWindow);
  configurePowerMonitor();
  configureAccentColorMonitor();
  configureMenu();

  try {
    await loadMainRenderer(mainWindow);
  } catch (error) {
    console.warn(`${productName} renderer load failed: ${errorMessage(error)}`);
    scheduleRendererRecovery(`initial renderer load failed: ${errorMessage(error)}`);
  }
}

function registerRendererProtocol(): void {
  if (rendererProtocolRegistered) return;
  rendererProtocolRegistered = true;
  const rendererRoot = resolveRendererDir();
  const desktopAssets = resolveDesktopAssetsDir();
  protocol.handle(appProtocol, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (requestedPath.startsWith(desktopAssetRoutePrefix)) {
      if (requestedPath !== `${desktopAssetRoutePrefix}icon-32.png`) return new Response("Not found", { status: 404 });
      return fetchProtocolFile(desktopAssets, "icon-32.png", request.method);
    }
    return fetchProtocolFile(rendererRoot, requestedPath.replace(/^\/+/, ""), request.method);
  });
}

function fetchProtocolFile(rootDir: string, requestedPath: string, method: string): Promise<Response> | Response {
  const candidate = resolve(rootDir, requestedPath);
  const relativeCandidate = relative(rootDir, candidate);
  if (/^\.\.(?:[\\/]|$)/.test(relativeCandidate) || isAbsolute(relativeCandidate)) return new Response("Not found", { status: 404 });
  if (!existsSync(candidate)) return new Response("Not found", { status: 404 });
  if (method === "HEAD") return new Response(null, { status: 200 });
  return net.fetch(pathToFileURL(candidate).href);
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("work-fold:api:session-headers", (event) => {
    assertTrustedRenderer(event);
    return { "x-work-fold-session": apiSessionToken };
  });
  ipcMain.handle("work-fold:runtime:health", async (event) => {
    assertTrustedRenderer(event);
    return {
      pi: piRuntime ? await piRuntime.health() : { ok: false, configured: false, version: "", message: "Pi is still starting." },
      settings: secureSettings ? await secureSettings.status() : { encryptionAvailable: false, configuredProviders: [] },
    };
  });
  ipcMain.handle("work-fold:space:choose-folder", async (event) => {
    assertTrustedRenderer(event);
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { title: "Choose a folder to turn into a Space", properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ title: "Choose a folder to turn into a Space", properties: ["openDirectory", "createDirectory"] });
    const spaceRoot = result.filePaths[0];
    if (result.canceled || !spaceRoot) return null;
    return { path: spaceRoot, folderGrantId: createFolderGrant(spaceRoot) };
  });
  // The app.grant.files person-chosen root (docs/fold-consecrations.md): a
  // staged file-grant card pins the reviewed declaration only, and approval
  // binds it to a folder the person picks here — desktop-only by
  // construction, because only the main renderer's preload reaches this
  // handler. The dialog result is validated against the Space's folder and
  // returned as the Space-relative root the grant path stores.
  ipcMain.handle("work-fold:decisions:choose-file-grant-root", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (typeof value !== "string" || !value.trim()) throw new Error("A Space id is required.");
    const space = await getSpace(value.trim());
    const options = {
      title: "Choose the folder this app may access",
      defaultPath: space.spaceRoot,
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return null;
    const relativePath = relative(space.spaceRoot, resolve(chosen));
    if (relativePath !== "" && (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))) {
      return { error: "Choose a folder inside this Space's folder." };
    }
    const root = relativePath === "" ? "." : relativePath.split(sep).join("/");
    if (root !== "." && containsReservedSpacePathSegment(root)) {
      return { error: "work-fold metadata folders cannot be granted to an app." };
    }
    return { root };
  });
  const routingSettings = async (event: IpcMainInvokeEvent, value?: unknown) => {
    assertTrustedMainRenderer(event);
    return {
      facade: (await ensureInteractiveLocalApi()).routingSettings,
      ...(value !== undefined ? { routingId: routingSettingsId(value) } : {}),
    };
  };
  ipcMain.handle("work-fold:routings:list", async (event) => {
    const { facade } = await routingSettings(event);
    return facade.list();
  });
  ipcMain.handle("work-fold:routings:show", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.show(routingId!);
  });
  ipcMain.handle("work-fold:routings:history", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.history(routingId!);
  });
  ipcMain.handle("work-fold:routings:stage-enable", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.stageEnable(routingId!);
  });
  ipcMain.handle("work-fold:routings:run", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.run(routingId!);
  });
  ipcMain.handle("work-fold:routings:stop", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.stop(routingId!);
  });
  ipcMain.handle("work-fold:routings:disable", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.disable(routingId!);
  });
  ipcMain.handle("work-fold:routings:delete", async (event, value: unknown) => {
    const { facade, routingId } = await routingSettings(event, value);
    return facade.delete(routingId!);
  });
  ipcMain.handle("work-fold:space:reveal-folder", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (typeof value !== "string") throw new Error("A Space id is required.");
    const space = await getSpace(value);
    const error = await shell.openPath(space.spaceRoot);
    if (error) throw new Error(`work-fold could not show this Space's folder. ${error}`);
  });
  ipcMain.handle("work-fold:space:open-path", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = spacePathRequest(value);
    const filePath = await resolveSpaceItem(request.spaceId, request.path);
    if (request.action === "reveal") {
      shell.showItemInFolder(filePath);
      return;
    }
    const result = await shell.openPath(filePath);
    if (result) throw new Error(`${productName} could not open this item. ${result}`);
  });
  ipcMain.handle("work-fold:space:start-drag", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = spacePathRequest(value, false);
    const filePath = await resolveSpaceItem(request.spaceId, request.path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Only files can be dragged out of a Space.");
    const icon = nativeImage.createFromPath(join(resolveDesktopAssetsDir(), "icon-32.png"));
    if (icon.isEmpty()) return false;
    event.sender.startDrag({ file: filePath, icon });
    return true;
  });
  ipcMain.handle("work-fold:space:preview-file", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return false;
    const request = spacePathRequest(value, false);
    const filePath = await resolveSpaceItem(request.spaceId, request.path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Only files can be previewed with Quick Look.");
    const window = mainWindow;
    if (!window || window.isDestroyed()) throw new Error("The work-fold window is not available.");
    window.previewFile(filePath, basename(filePath));
    return true;
  });
  ipcMain.handle("work-fold:space:popup-file-menu", async (event, value: unknown): Promise<NativeFileMenuCommand | null> => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return null;
    const request = parseNativeFileMenuRequest(value);
    await validateNativeFileMenuEntry(request);
    return popupNativeFileMenu(request);
  });
  ipcMain.handle("work-fold:space:set-active-space", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 512)) {
      throw new Error("A valid Space id is required.");
    }
    await setActiveNativeSpace(value === null ? null : value.trim());
  });
  ipcMain.handle("work-fold:space:take-open-space", (event) => {
    assertTrustedMainRenderer(event);
    const request = pendingOpenSpaceRequest;
    pendingOpenSpaceRequest = null;
    return request;
  });
  ipcMain.on("work-fold:space:ack-open-space", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value === "string" && pendingOpenSpaceRequest?.token === value) pendingOpenSpaceRequest = null;
  });
  ipcMain.handle("work-fold:shell:open-external", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (typeof value !== "string") throw new Error("A URL is required.");
    await openExternal(value);
  });
  ipcMain.handle("work-fold:window:accent-color", (event) => {
    assertTrustedRenderer(event);
    return getSystemAccentColor();
  });
  ipcMain.on("work-fold:management:hide", (event) => {
    assertTrustedRenderer(event);
    managementPopover?.hide();
  });
  ipcMain.handle("work-fold:management:open-main", (event) => {
    assertTrustedRenderer(event);
    managementPopover?.hide();
    showWindow();
    return true;
  });
  ipcMain.handle("work-fold:management:open-assistant-settings", async (event) => {
    assertTrustedRenderer(event);
    managementPopover?.hide();
    await ensureMainWindow();
    showWindow();
    mainWindow?.webContents.send("work-fold:agent:open-settings", "management");
    return true;
  });
  ipcMain.handle("work-fold:window:get-close-to-tray", (event) => {
    assertTrustedRenderer(event);
    return closeToTrayStatus();
  });
  ipcMain.handle("work-fold:window:set-close-to-tray", (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (typeof value !== "boolean") throw new Error("Close-to-background preference must be a boolean.");
    updateDesktopPreferences({ closeToTray: value });
    return closeToTrayStatus();
  });
  ipcMain.on("work-fold:window:set-theme", (event, value: unknown, source: unknown) => {
    assertTrustedRenderer(event);
    if (value !== "light" && value !== "dark") return;
    // Keep the OS-drawn chrome (Mica backdrop, frame, menus) on the app theme.
    // "system" preserves prefers-color-scheme change events in the renderer.
    nativeTheme.themeSource = source === "light" || source === "dark" || source === "system" ? source : value;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (process.platform === "win32") {
      mainWindow.setTitleBarOverlay(titleBarOverlayFor(value));
      if (!micaSupported) mainWindow.setBackgroundColor(windowBackgroundColors[value]);
    } else if (process.platform === "darwin" && nativeWindowMaterial === "none") {
      mainWindow.setBackgroundColor(windowBackgroundColors[value]);
    }
  });
  ipcMain.on("work-fold:menu:set-state", (event, value: unknown) => {
    assertTrustedRenderer(event);
    updateApplicationMenuState(value);
  });
  ipcMain.handle("work-fold:menu:popup", (event, menuId: unknown, bounds: unknown) => {
    assertTrustedRenderer(event);
    popupApplicationSubmenu(menuId, bounds);
  });
  ipcMain.handle("work-fold:settings:status", (event) => {
    assertTrustedRenderer(event);
    return secureSettings?.status() ?? { encryptionAvailable: false, configuredProviders: [] };
  });
  ipcMain.handle("work-fold:remote-access:status", async (event) => {
    assertTrustedMainRenderer(event);
    return (await ensureRemoteAccessClient(await ensureInteractiveLocalApi())).status();
  });
  ipcMain.handle("work-fold:remote-access:configure", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    return configureRemoteAccess(value);
  });
  ipcMain.handle("work-fold:remote-access:set-enabled", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    return setRemoteAccessEnabled(value);
  });
  ipcMain.handle("work-fold:remote-access:revoke-browser", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    return revokeRemoteBrowser(value);
  });
  ipcMain.handle("work-fold:remote-access:revoke-all", (event) => {
    assertTrustedMainRenderer(event);
    return revokeAllRemoteBrowsers();
  });
  ipcMain.handle("work-fold:remote-access:remove", (event) => {
    assertTrustedMainRenderer(event);
    return removeRemoteAccess();
  });
  ipcMain.handle("work-fold:remote-access:open", async (event) => {
    assertTrustedMainRenderer(event);
    const status = await (await ensureRemoteAccessClient(await ensureInteractiveLocalApi())).status();
    if (!status.url) throw new Error("Set up web access before opening it.");
    await shell.openExternal(status.url);
  });
  ipcMain.on("work-fold:window:rail-tooltip-show", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    try {
      railTooltipOverlay?.show(value);
    } catch (error) {
      console.warn(`${productName} could not show a rail tooltip: ${errorMessage(error)}`);
    }
  });
  ipcMain.on("work-fold:window:rail-tooltip-hide", (event) => {
    assertTrustedMainRenderer(event);
    railTooltipOverlay?.hide();
  });
  ipcMain.handle("work-fold:restricted-app-view:mount", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const window = mainWindow;
    if (!window || window.isDestroyed()) throw new Error("The work-fold window is not available.");
    const identity = restrictedAppViewIdentity(value);
    const host = await ensureDesktopHost();
    const descriptor = await host.restrictedApps.runtimeDescriptor(identity.spaceId, identity.appId, identity.digest);
    const mounted = await host.restrictedAppHost.mountUi(descriptor, event.sender, window, restrictedAppViewPayload(value));
    railTooltipOverlay?.raise();
    return mounted;
  });
  ipcMain.on("work-fold:restricted-app-view:layout", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    void ensureDesktopHost()
      .then((host) => {
        host.restrictedAppHost.layoutUi(event.sender.id, restrictedAppViewPayload(value));
        railTooltipOverlay?.raise();
      })
      .catch((error) => console.warn(`${productName} could not lay out a restricted app view: ${errorMessage(error)}`));
  });
  ipcMain.handle("work-fold:restricted-app-view:unmount", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value !== "string") throw new Error("A restricted app mount id is required.");
    const host = await ensureDesktopHost();
    await host.restrictedAppHost.unmountUi(event.sender.id, value);
  });
  ipcMain.handle("work-fold:updates:status", (event): DesktopUpdateStatus => {
    assertTrustedRenderer(event);
    return getUpdateStatus();
  });
  ipcMain.handle("work-fold:updates:check", async (event): Promise<DesktopUpdateStatus> => {
    assertTrustedRenderer(event);
    return checkForUpdates();
  });
  ipcMain.handle("work-fold:updates:install", async (event): Promise<DesktopUpdateStatus> => {
    assertTrustedRenderer(event);
    return desktopUpdater?.install() ?? getUpdateStatus();
  });
  ipcMain.handle("work-fold:updates:update-now", async (event): Promise<DesktopUpdateStatus> => {
    assertTrustedRenderer(event);
    return desktopUpdater?.updateNow() ?? getUpdateStatus();
  });
}

type RendererMenuCommand =
  | "new-space"
  | "open-local-folder"
  | "new-chat"
  | "close-tab"
  | "reload-space-state"
  | "check-for-updates"
  | "open-settings"
  | "open-about"
  | "open-capabilities"
  | "open-skills"
  | "open-extensions"
  | "open-command-palette"
  | "open-keyboard-shortcuts";

type ApplicationMenuId = "file" | "edit" | "view" | "help";

interface RendererMenuState {
  spaceOpen: boolean;
}

function configureMenu(): void {
  if (process.platform === "darwin") {
    app.setAboutPanelOptions({
      applicationName: productName,
      applicationVersion,
      copyright: "Copyright © Mat-Tom-Son",
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate()));
  if (process.platform === "win32" && mainWindow) {
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(false);
  }
  updateApplicationMenuState(rendererMenuState);
}

function buildApplicationMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    ...macApplicationMenu(),
    { id: "file", label: "File", submenu: buildApplicationSubmenuTemplate("file") },
    { id: "edit", label: "Edit", submenu: buildApplicationSubmenuTemplate("edit") },
    { id: "view", label: "View", submenu: buildApplicationSubmenuTemplate("view") },
    ...macWindowMenu(),
    { id: "help", label: "Help", submenu: buildApplicationSubmenuTemplate("help") },
  ];
}

function buildApplicationSubmenuTemplate(menuId: ApplicationMenuId): MenuItemConstructorOptions[] {
  if (menuId === "file") {
    const items: MenuItemConstructorOptions[] = [
      { label: "New Space", accelerator: "CommandOrControl+N", click: () => sendRendererMenuCommand("new-space") },
      { label: "Turn Folder into a Space...", accelerator: "CommandOrControl+O", click: () => sendRendererMenuCommand("open-local-folder") },
      ...(process.platform === "darwin" ? [{
        label: "Open Recent",
        role: "recentDocuments" as const,
        submenu: [{ role: "clearRecentDocuments" as const }],
      }] : []),
      { type: "separator" },
      { id: "new-chat", label: "New Chat", accelerator: "CommandOrControl+Shift+N", enabled: rendererMenuState.spaceOpen, click: () => sendRendererMenuCommand("new-chat") },
      { id: "refresh-space", label: "Refresh Space", accelerator: "CommandOrControl+R", enabled: rendererMenuState.spaceOpen, click: () => sendRendererMenuCommand("reload-space-state") },
    ];
    if (process.platform !== "darwin") {
      items.push(
        { type: "separator" },
        { label: "Settings...", accelerator: "CommandOrControl+,", click: () => sendRendererMenuCommand("open-settings") },
      );
    }
    if (process.platform === "darwin") {
      // Cmd+W follows tab-strip muscle memory and closes the active surface
      // tab; the window keeps the conventional Shift+Cmd+W.
      items.push(
        { type: "separator" },
        { id: "close-tab", label: "Close Tab", accelerator: "CommandOrControl+W", enabled: rendererMenuState.spaceOpen, click: () => sendRendererMenuCommand("close-tab") },
        { role: "close", accelerator: "Shift+CommandOrControl+W" },
      );
    } else {
      items.push({ type: "separator" }, { role: "quit" });
    }
    return items;
  }
  if (menuId === "edit") {
    return [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(process.platform === "darwin" ? [{ role: "pasteAndMatchStyle" as const }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
      ...macEditMenuAdditions(),
    ];
  }
  if (menuId === "view") {
    return [
      { label: "Command Palette...", accelerator: "CommandOrControl+K", click: () => sendRendererMenuCommand("open-command-palette") },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      ...(!app.isPackaged ? [{ type: "separator" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[] : []),
      { type: "separator" },
      { role: "togglefullscreen" },
    ];
  }
  const items: MenuItemConstructorOptions[] = [
    { id: "open-capabilities", label: "Capabilities", accelerator: "CommandOrControl+Shift+S", enabled: rendererMenuState.spaceOpen, click: () => sendRendererMenuCommand("open-capabilities") },
    { label: "Keyboard Shortcuts", accelerator: "CommandOrControl+/", click: () => sendRendererMenuCommand("open-keyboard-shortcuts") },
  ];
  if (process.platform !== "darwin") {
    items.push(
      { type: "separator" },
      { label: "Check for Updates...", click: () => sendRendererMenuCommand("check-for-updates") },
      { type: "separator" },
      { label: `About ${productName} ${applicationVersion}`, click: () => sendRendererMenuCommand("open-about") },
    );
  }
  return items;
}

function macApplicationMenu(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [{
    label: productName,
    submenu: [
      { role: "about" },
      {
        label: "Check for Updates...",
        click: () => {
          void checkForUpdatesFromMenu().catch((error) => {
            console.warn(`${productName} could not present the update check: ${errorMessage(error)}`);
          });
        },
      },
      { type: "separator" },
      { label: "Settings...", accelerator: "Command+,", click: () => sendRendererMenuCommand("open-settings") },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { id: "quit-space", label: `Quit ${productName}`, accelerator: "Command+Q", click: requestApplicationQuit },
    ],
  }];
}

function macWindowMenu(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [{ role: "windowMenu" }];
}

function macEditMenuAdditions(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [
    { type: "separator" },
    {
      label: "Substitutions",
      submenu: [
        { role: "showSubstitutions" },
        { type: "separator" },
        { role: "toggleSmartQuotes" },
        { role: "toggleSmartDashes" },
        { role: "toggleTextReplacement" },
      ],
    },
    {
      label: "Speech",
      submenu: [
        { role: "startSpeaking" },
        { role: "stopSpeaking" },
      ],
    },
    { type: "separator" },
    { label: "Emoji & Symbols", accelerator: "Control+Command+Space", click: () => app.showEmojiPanel() },
  ];
}

function popupApplicationSubmenu(menuId: unknown, bounds: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || !isApplicationMenuId(menuId)) return;
  const point = menuPopupPoint(bounds);
  Menu.buildFromTemplate(buildApplicationSubmenuTemplate(menuId)).popup({ window: mainWindow, x: point.x, y: point.y });
}

function isApplicationMenuId(value: unknown): value is ApplicationMenuId {
  return value === "file" || value === "edit" || value === "view" || value === "help";
}

function menuPopupPoint(value: unknown): { x: number; y: number } {
  const rawX = isRecord(value) ? Number(value.x) : Number.NaN;
  const rawY = isRecord(value) ? Number(value.y) : Number.NaN;
  return {
    x: Number.isFinite(rawX) ? Math.max(0, Math.round(rawX)) : 0,
    y: Number.isFinite(rawY) ? Math.max(0, Math.round(rawY)) : desktopTitleBarHeight,
  };
}

function sendRendererMenuCommand(command: RendererMenuCommand): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    if (app.isReady() && !quitting && !quittingForUpdate) {
      void ensureMainWindow().then(() => sendRendererMenuCommand(command)).catch(reportStartupError);
    }
    return;
  }
  showWindow();
  window.webContents.send("work-fold:menu-command", command);
}

function updateApplicationMenuState(value: unknown): void {
  rendererMenuState = {
    spaceOpen: isRecord(value)
      ? value.spaceOpen === true || value.spaceOpen === true
      : rendererMenuState.spaceOpen,
  };
  const menu = Menu.getApplicationMenu();
  setMenuItemEnabled(menu, "new-chat", rendererMenuState.spaceOpen);
  setMenuItemEnabled(menu, "refresh-space", rendererMenuState.spaceOpen);
  setMenuItemEnabled(menu, "open-capabilities", rendererMenuState.spaceOpen);
}

function setMenuItemEnabled(menu: Menu | null, id: string, enabled: boolean): void {
  const item = menu?.getMenuItemById(id);
  if (item) item.enabled = enabled;
}

function configureUpdater(): void {
  // Ad hoc verification builds use a separate identity and must never touch
  // the production update feed or production work-fold Safe Storage key.
  if (desktopUpdater || localMacSmokeBuild) return;
  desktopUpdater = new DesktopUpdater({
    getWindow: () => mainWindow,
    prepareToInstall: shutdownForUpdateInstall,
  });
  desktopUpdater.start();
}

function getUpdateStatus(): DesktopUpdateStatus {
  return desktopUpdater?.getStatus() ?? {
    supported: false,
    phase: "unsupported",
    currentVersion: applicationVersion,
    availableVersion: null,
    progressPercent: null,
    checkedAt: null,
    message: "Updates are not available in this build.",
    error: null,
  };
}

function checkForUpdates(interactive = true): Promise<DesktopUpdateStatus> {
  return desktopUpdater?.check(interactive) ?? Promise.resolve(getUpdateStatus());
}

async function checkForUpdatesFromMenu(): Promise<void> {
  const status = await checkForUpdates(true);
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (status.phase === "available") {
    const result = window
      ? await dialog.showMessageBox(window, {
        type: "info",
        message: status.message,
        detail: "work-fold can download the update now and restart when it is ready.",
        buttons: ["Download and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      : await dialog.showMessageBox({
        type: "info",
        message: status.message,
        detail: "work-fold can download the update now and restart when it is ready.",
        buttons: ["Download and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    if (result.response === 0) await desktopUpdater?.updateNow();
    return;
  }
  if (status.phase === "ready") {
    const result = window
      ? await dialog.showMessageBox(window, {
        type: "info",
        message: status.message,
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      : await dialog.showMessageBox({
        type: "info",
        message: status.message,
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    if (result.response === 0) await desktopUpdater?.install();
    return;
  }
  const options = {
    type: status.phase === "error" ? "error" as const : "info" as const,
    message: status.message,
    ...(status.error ? { detail: status.error } : {}),
    buttons: ["OK"],
    noLink: true,
  };
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

function configureStableUserDataPath(): void {
  const useInstalledProductData = workFoldDesktopUsesInstalledProductData({
    executablePath: process.execPath,
    productName,
    isPackaged: app.isPackaged,
    fileExists: existsSync,
  });
  const target = workFoldDesktopUserDataPath({
    appDataPath: app.getPath("appData"),
    productName,
    useInstalledProductData,
    override: workFoldDesktopStateOverride(process.env),
  });
  if (app.getPath("userData") !== target) app.setPath("userData", target);
}

function configureCliEnvironment(): void {
  // Every Assistant shell must address the same profile as the desktop process
  // that launched it. Development and installed builds intentionally use
  // different userData roots, so leaving this unset can expose a different
  // Space registry through an installed work-fold CLI on PATH.
  process.env.WORKFOLD_CLI_STATE_DIR = app.getPath("userData");
  if (!app.isPackaged || (process.platform !== "win32" && process.platform !== "darwin")) return;
  const executableDirectory = dirnameFromFile(process.execPath);
  const binDirectory = process.platform === "darwin"
    ? resolve(executableDirectory, "..", "bin")
    : join(executableDirectory, "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLocaleLowerCase() === "path") ?? "Path";
  const currentPath = process.env[pathKey] ?? "";
  const alreadyPresent = currentPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .some((entry) => samePath(entry, binDirectory));
  if (!alreadyPresent) process.env[pathKey] = currentPath ? `${binDirectory}${delimiter}${currentPath}` : binDirectory;
  // Agent shell tools inherit this process environment. Pinning the executable
  // makes their CLI calls address this exact installed work-fold build.
  process.env.WORKFOLD_CLI_APP = process.execPath;
}

function createFolderGrant(spaceRoot: string): string {
  cleanupFolderGrants();
  const id = randomUUID();
  folderGrants.set(id, { spaceRoot: resolve(spaceRoot), expiresAt: Date.now() + folderGrantTtlMs });
  return id;
}

function consumeLocalFolderGrant(input: { spaceRoot: string; grantId: string }): boolean {
  cleanupFolderGrants();
  const grant = folderGrants.get(input.grantId);
  folderGrants.delete(input.grantId);
  return Boolean(grant && grant.expiresAt >= Date.now() && samePath(grant.spaceRoot, input.spaceRoot));
}

function cleanupFolderGrants(): void {
  const now = Date.now();
  for (const [id, grant] of folderGrants) {
    if (grant.expiresAt <= now) folderGrants.delete(id);
  }
}

type SpacePathAction = "open" | "open-native" | "reveal";

function spacePathRequest(value: unknown, requireAction = true): { spaceId: string; path: string; action: SpacePathAction } {
  if (!isRecord(value)) throw new Error("A Space file request is required.");
  const spaceId = typeof value.spaceId === "string" ? value.spaceId.trim() : "";
  const path = typeof value.path === "string" ? value.path : "";
  const action = value.action === "reveal" || value.action === "open-native" || value.action === "open"
    ? value.action
    : "open";
  if (!spaceId) throw new Error("A Space id is required.");
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("A relative Space file path is required.");
  if (requireAction && value.action !== undefined && value.action !== "reveal" && value.action !== "open-native" && value.action !== "open") {
    throw new Error("Unsupported Space file action.");
  }
  return { spaceId, path, action };
}

async function resolveSpaceItem(spaceId: string, itemPath: string): Promise<string> {
  const space = await getSpace(spaceId);
  const spaceRoot = await realpath(space.spaceRoot);
  const candidate = resolve(spaceRoot, itemPath);
  assertPathInsideRoot(spaceRoot, candidate);
  const resolvedCandidate = await realpath(candidate);
  assertPathInsideRoot(spaceRoot, resolvedCandidate);
  return resolvedCandidate;
}

async function setActiveNativeSpace(spaceId: string | null): Promise<void> {
  const generation = ++activeNativeSpaceGeneration;
  if (spaceId === null) {
    activeNativeSpace = null;
    applyNativeActiveSpaceToWindow(mainWindow);
    return;
  }

  // The renderer supplies identity only. Name and root are always loaded from
  // the host-owned registry before they reach native window or OS APIs.
  const space = await getSpace(spaceId);
  if (generation !== activeNativeSpaceGeneration) return;
  activeNativeSpace = { id: space.id, name: space.name, spaceRoot: space.spaceRoot };
  applyNativeActiveSpaceToWindow(mainWindow);
  if (process.platform === "darwin") app.addRecentDocument(space.spaceRoot);
}

async function validateNativeFileMenuEntry(request: NativeFileMenuRequest): Promise<void> {
  let info;
  if (request.path) {
    info = await stat(await resolveSpaceItem(request.spaceId, request.path));
  } else {
    const space = await getSpace(request.spaceId);
    info = await stat(await realpath(space.spaceRoot));
  }
  if ((request.kind === "file" && !info.isFile()) || (request.kind === "folder" && !info.isDirectory())) {
    throw new Error("The native file menu entry no longer matches this Space.");
  }
}

function popupNativeFileMenu(request: NativeFileMenuRequest): Promise<NativeFileMenuCommand | null> {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.reject(new Error("The work-fold window is not available."));
  }
  return new Promise((resolveCommand) => {
    let settled = false;
    const finish = (command: NativeFileMenuCommand | null) => {
      if (settled) return;
      settled = true;
      resolveCommand(command);
    };
    const template = nativeFileMenuItems(request).map<MenuItemConstructorOptions>((item) => item.type === "separator"
      ? { type: "separator" }
      : { label: item.label, click: () => finish(item.command) });
    Menu.buildFromTemplate(template).popup({
      window,
      x: request.point.x,
      y: request.point.y,
      callback: () => finish(null),
    });
  });
}

function applyNativeActiveSpaceToWindow(window: BrowserWindow | null): void {
  if (process.platform !== "darwin" || !window || window.isDestroyed()) return;
  window.setRepresentedFilename(activeNativeSpace?.spaceRoot ?? "");
  window.setTitle(activeNativeSpace?.name ?? productName);
}

async function drainPendingMacOpenPaths(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (macOpenPathDrainPromise) {
    await macOpenPathDrainPromise;
    if (pendingMacOpenPaths.length) await drainPendingMacOpenPaths();
    return;
  }

  macOpenPathDrainPromise = (async () => {
    while (pendingMacOpenPaths.length) {
      const path = pendingMacOpenPaths.shift();
      if (!path) continue;
      await ensureMainWindow();
      showWindow();
      const spaceId = await registeredSpaceIdForOpenPath(path);
      if (!spaceId) {
        console.warn(`${productName} ignored an unregistered Finder folder: ${path}`);
        continue;
      }
      await setActiveNativeSpace(spaceId);
      const request = { token: randomUUID(), spaceId };
      pendingOpenSpaceRequest = request;
      const window = mainWindow;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("work-fold:space:open-space", request);
      }
    }
  })().finally(() => {
    macOpenPathDrainPromise = null;
  });

  await macOpenPathDrainPromise;
  if (pendingMacOpenPaths.length) await drainPendingMacOpenPaths();
}

async function registeredSpaceIdForOpenPath(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return null;
    const openedRoot = await realpath(path);
    for (const space of await listSpaces()) {
      try {
        const registeredRoot = await realpath(space.spaceRoot);
        if (samePath(openedRoot, registeredRoot)) return space.id;
      } catch {
        // Missing registered folders are already excluded from normal bootstrap;
        // one stale registration must not block another exact match.
      }
    }
  } catch {
    // Finder may pass a path that moved before work-fold was ready.
  }
  return null;
}

function assertPathInsideRoot(spaceRoot: string, candidate: string): void {
  const child = relative(spaceRoot, candidate);
  if (!child || /^\.\.(?:[\\/]|$)/.test(child) || isAbsolute(child)) throw new Error("The requested item is outside this Space.");
}

function updateAgentPowerState(activeTurns: number): void {
  activeAgentTurns = Math.max(0, activeTurns);
  updateTrayTooltip();
  if (activeTurns > 0 && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (activeTurns <= 0 && powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

async function openExternal(value: string): Promise<void> {
  const url = new URL(value);
  if (!new Set(["https:", "http:", "mailto:"]).has(url.protocol)) throw new Error(`work-fold cannot open ${url.protocol} links.`);
  await shell.openExternal(url.toString());
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = null;
  // Queued act requests must answer unavailable instead of racing a closing
  // Pi runtime, so the act authority is revoked before anything else stops.
  actFacade = null;
  actToken = "";
  resolveManagementLineageParent = null;
  remoteAccessClient?.stop();
  updateAgentPowerState(0);
  const runtime = piRuntime;
  piRuntime = null;
  const restrictedApps = desktopHostPromise?.then((host) => host.restrictedApps.close()) ?? Promise.resolve();
  const checks = desktopHostPromise?.then((host) => host.checks.close()) ?? Promise.resolve();
  shutdownPromise = (async () => {
    const outcomes = await Promise.allSettled([
      withShutdownTimeout(localApiLifetime.close(), "local API"),
      withShutdownTimeout(runtime?.flush() ?? Promise.resolve(), "Pi state"),
      withShutdownTimeout(restrictedApps, "restricted apps"),
      withShutdownTimeout(checks, "Checks"),
      withShutdownTimeout(removeWorkFoldCliActTokenFile(app.getPath("userData")), "CLI act token"),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") console.warn(`${productName} shutdown cleanup failed: ${errorMessage(outcome.reason)}`);
    }
  })();
  return shutdownPromise;
}

async function shutdownForUpdateInstall(): Promise<void> {
  quittingForUpdate = true;
  quitting = true;
  destroyTray();
  await shutdown();
  quitCoordinator.allowNativeQuit();
}

async function withShutdownTimeout<T>(promise: Promise<T>, label: string): Promise<T | void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(() => {
          console.warn(`${productName} shutdown timed out waiting for ${label}; continuing.`);
          resolveTimeout();
        }, shutdownTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function showWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    if (app.isReady()) void ensureMainWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve();
  createWindowPromise ??= createMainWindow().finally(() => { createWindowPromise = null; });
  return createWindowPromise;
}

interface DesktopPreferences {
  closeToTray: boolean;
  trayNoticeShown: boolean;
}

let desktopPreferences: DesktopPreferences = { closeToTray: true, trayNoticeShown: false };

function desktopPreferencesPath(): string {
  return join(app.getPath("userData"), "desktop-preferences.json");
}

function loadDesktopPreferences(): void {
  if (!existsSync(desktopPreferencesPath())) return;
  try {
    const parsed = JSON.parse(readFileSync(desktopPreferencesPath(), "utf8"));
    if (!isRecord(parsed)) return;
    desktopPreferences = {
      closeToTray: typeof parsed.closeToTray === "boolean" ? parsed.closeToTray : true,
      trayNoticeShown: parsed.trayNoticeShown === true,
    };
  } catch (error) {
    console.warn(`${productName} could not read desktop preferences: ${errorMessage(error)}`);
  }
}

function updateDesktopPreferences(update: Partial<DesktopPreferences>): void {
  desktopPreferences = { ...desktopPreferences, ...update };
  try {
    writeFileSync(desktopPreferencesPath(), `${JSON.stringify(desktopPreferences, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`${productName} could not save desktop preferences: ${errorMessage(error)}`);
  }
}

function createTrayIfSupported(): void {
  if (tray || (process.platform !== "win32" && process.platform !== "darwin")) return;
  const icon = resolveTrayIcon();
  if (!icon) {
    console.warn(`${productName} tray icon was not found; the ${process.platform === "darwin" ? "menu-bar" : "tray"} surface is unavailable.`);
    return;
  }
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "Your fold", click: () => { void toggleManagementPopover(); } },
    { label: `Open ${productName}`, click: showWindow },
    { type: "separator" },
    { label: "Check for Updates...", click: () => sendRendererMenuCommand("check-for-updates") },
    { type: "separator" },
    { label: `Quit ${productName}`, click: () => app.quit() },
  ]);
  if (process.platform === "darwin") {
    // No persistent context menu on macOS: setContextMenu would swallow the
    // left click. Click opens the management popover, right-click the menu,
    // and material dropped on the icon lands in the popover as staged context.
    tray.on("click", () => { void toggleManagementPopover(); });
    tray.on("right-click", () => tray?.popUpContextMenu(menu));
    tray.on("drop-files", (_event, files) => {
      void openManagementPopoverWithItems(files.map((file) => ({ kind: "path" as const, value: file })));
    });
    tray.on("drop-text", (_event, text) => {
      void openManagementPopoverWithItems([{ kind: "text" as const, value: text }]);
    });
  } else {
    tray.setContextMenu(menu);
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  }
  updateTrayTooltip();
  // Warm the hidden popover renderer off the startup critical path so the
  // first "Your fold" summon paints the ready surface immediately.
  setTimeout(() => {
    void ensureManagementPopover().then((popover) => popover.warm()).catch(() => {});
  }, 2_500);
}

function resolveTrayIcon(): Electron.NativeImage | string | null {
  if (process.platform === "darwin") {
    // Monochrome template image so macOS recolors the menu-bar item for
    // light/dark menu bars; createFromPath also loads the @2x variant.
    const path = join(resolveDesktopAssetsDir(), "iconTemplate.png");
    if (!existsSync(path)) return null;
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) return null;
    image.setTemplateImage(true);
    return image;
  }
  const iconPath = resolveWindowIcon();
  return existsSync(iconPath) ? iconPath : null;
}

function destroyTray(): void {
  tray?.destroy();
  tray = null;
  managementPopover?.destroy();
  managementPopover = null;
}

async function ensureManagementPopover(): Promise<ManagementPopover> {
  if (managementPopover) return managementPopover;
  const api = await ensureInteractiveLocalApi();
  managementPopover = new ManagementPopover({
    appProtocol,
    preloadPath: resolveManagementPopoverPreloadPath(),
    additionalArguments: [
      ...productRendererArguments(),
      rendererArgument("api-base-url", api.origin),
      rendererArgument("app-version", applicationVersion),
      rendererArgument("window-material", process.platform === "darwin" && macVibrancySupported ? "vibrancy" : "none"),
    ],
    backgroundColor: windowBackgroundColors[nativeTheme.shouldUseDarkColors ? "dark" : "light"],
    vibrancy: process.platform === "darwin" && macVibrancySupported,
    devTools: !app.isPackaged,
    configureNavigation: configureWindowNavigation,
    onError: (message) => console.warn(`${productName} management popover failed to load: ${message}`),
  });
  return managementPopover;
}

async function toggleManagementPopover(): Promise<void> {
  try {
    const popover = await ensureManagementPopover();
    await popover.toggle(tray?.getBounds() ?? null);
  } catch (error) {
    console.warn(`${productName} could not open the management popover: ${errorMessage(error)}`);
  }
}

async function openManagementPopoverWithItems(items: ManagementPopoverStagedItem[]): Promise<void> {
  try {
    const popover = await ensureManagementPopover();
    await popover.stage(items, tray?.getBounds() ?? null);
  } catch (error) {
    console.warn(`${productName} could not stage dropped material: ${errorMessage(error)}`);
  }
}

function updateTrayTooltip(): void {
  if (!tray) return;
  tray.setToolTip(activeAgentTurns > 0
    ? `${productName} — Assistant is working on ${activeAgentTurns === 1 ? "a task" : `${activeAgentTurns} tasks`}`
    : productName);
}

function maybeShowTrayNotice(): void {
  if (desktopPreferences.trayNoticeShown) return;
  updateDesktopPreferences({ trayNoticeShown: true });
  if (!Notification.isSupported()) return;
  new Notification({
    title: `${productName} is still running`,
    body: "Your Assistant can keep working in the background. Use the tray icon to reopen or quit work-fold, or change this in Settings.",
  }).show();
}

function closeToTrayStatus(): { supported: boolean; enabled: boolean } {
  // A macOS menu-bar item is a management surface, not close-to-tray support:
  // closing the last macOS window already keeps the app alive via the Dock.
  return { supported: process.platform === "win32" && tray !== null, enabled: desktopPreferences.closeToTray };
}

function configurePowerMonitor(): void {
  if (powerMonitorRegistered) return;
  powerMonitorRegistered = true;
  powerMonitor.on("suspend", () => {
    void desktopHostPromise?.then((host) => host.restrictedApps.suspendAutomations());
    // Routing runs share the scheduler discipline: suspension aborts the
    // active run (it settles `interrupted`, honestly receipted) and holds
    // admissions until resume (docs/fold-routings.md).
    routingPowerLifecycle?.suspend();
  });
  powerMonitor.on("resume", () => {
    void desktopHostPromise?.then((host) => host.restrictedApps.resumeAutomations());
    void routingPowerLifecycle?.resume().catch((error) => {
      console.warn(`${productName} could not resume Routings after wake: ${errorMessage(error)}`);
    });
    void remoteAccessClient?.recoverConnection().catch((error) => {
      console.warn(`${productName} could not recover Remote access after resume: ${errorMessage(error)}`);
    });
    setTimeout(ensureRendererAfterResume, resumeRendererHealthDelayMs);
    setTimeout(() => { void checkForUpdates(false); }, resumeUpdateCheckDelayMs);
  });
  powerMonitor.on("shutdown", () => { void shutdown(); });
}

function configureAccentColorMonitor(): void {
  if (accentColorMonitorRegistered || (process.platform !== "win32" && process.platform !== "darwin")) return;
  accentColorMonitorRegistered = true;
  const sendAccentColor = () => {
    const window = mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send("work-fold:window:accent-color-changed", getSystemAccentColor());
  };
  if (process.platform === "darwin") {
    systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", sendAccentColor);
  } else {
    systemPreferences.on("accent-color-changed", sendAccentColor);
  }
}

function getSystemAccentColor(): string | null {
  if (process.platform !== "win32" && process.platform !== "darwin") return null;
  try {
    const raw = systemPreferences.getAccentColor().replace(/^#/, "");
    return /^[0-9a-fA-F]{8}$/.test(raw) ? `#${raw.slice(0, 6)}` : null;
  } catch {
    return null;
  }
}

function configureWindowResilience(window: BrowserWindow): void {
  const unmountRestrictedViews = () => {
    void desktopHostPromise?.then((host) => host.restrictedAppHost.unmountUiOwner(window.webContents.id));
  };
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) unmountRestrictedViews();
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || !isTrustedRendererUrl(url)) return;
    rendererLoadFailed = true;
    scheduleRendererRecovery(description || `load failed with error ${code}`);
  });
  window.webContents.on("did-finish-load", () => {
    rendererLoadFailed = false;
    rendererRecoveryAttempts = 0;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    unmountRestrictedViews();
    if (!window.isDestroyed()) scheduleRendererRecovery(`renderer process ended: ${details.reason}`);
  });
}

function ensureRendererAfterResume(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
  const currentUrl = window.webContents.getURL();
  if (!isTrustedRendererUrl(currentUrl)) scheduleRendererRecovery(`renderer was not on the app URL after resume: ${currentUrl || "blank"}`, 0);
}

function loadMainRenderer(window: BrowserWindow): Promise<void> {
  return window.loadURL(`${appProtocol}://app/index.html`);
}

function scheduleRendererRecovery(reason: string, delayMs?: number): void {
  if (quitting || quittingForUpdate || !quitCoordinator.shouldPreventNativeQuit()) return;
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || rendererRecoveryTimer || rendererRecoveryInFlight) return;
  if (rendererRecoveryAttempts >= rendererRecoveryMaxAttempts) {
    void showRendererRecoveryFailedDialog(reason);
    return;
  }
  const delay = delayMs ?? Math.min(rendererRecoveryMaxDelayMs, rendererRecoveryBaseDelayMs * (2 ** rendererRecoveryAttempts));
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = null;
    void recoverRenderer(reason);
  }, delay);
}

async function recoverRenderer(reason: string): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  rendererRecoveryInFlight = true;
  rendererRecoveryAttempts += 1;
  let retryReason: string | null = null;
  try {
    console.warn(`${productName} reloading its window after a recoverable issue: ${reason}`);
    await loadMainRenderer(window);
  } catch (error) {
    retryReason = errorMessage(error);
  } finally {
    rendererRecoveryInFlight = false;
  }
  if (retryReason) scheduleRendererRecovery(retryReason);
  else {
    rendererLoadFailed = false;
    rendererRecoveryAttempts = 0;
    rendererRecoveryFailurePromptShown = false;
    window.webContents.send("work-fold:runtime:renderer-recovered");
  }
}

async function showRendererRecoveryFailedDialog(reason: string): Promise<void> {
  if (rendererRecoveryFailurePromptShown) return;
  rendererRecoveryFailurePromptShown = true;
  const options = {
    type: "error" as const,
    message: `${productName} could not recover this window.`,
    detail: `The window failed to reload after ${rendererRecoveryAttempts} attempts. Restart to try again. (${reason})`,
    buttons: [`Restart ${productName}`, "Close"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) {
    app.relaunch();
    app.exit(0);
  } else {
    app.quit();
  }
}

function configureWindowNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch((error) => console.warn(`${productName} blocked external navigation: ${errorMessage(error)}`));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    void openExternal(url).catch((error) => console.warn(`${productName} blocked external navigation: ${errorMessage(error)}`));
  });
}

function configureContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template = buildContextMenuTemplate(window, params);
    if (template) Menu.buildFromTemplate(template).popup({ window, frame: params.frame ?? undefined });
  });
}

function buildContextMenuTemplate(window: BrowserWindow, params: ContextMenuParams): MenuItemConstructorOptions[] | null {
  if (params.isEditable) return buildEditableContextMenuTemplate(window, params);
  if (params.selectionText.length > 0 || params.linkURL.length > 0) return buildSelectionContextMenuTemplate(params);
  return null;
}

function buildEditableContextMenuTemplate(window: BrowserWindow, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord.length > 0) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    template.push(...(suggestions.length ? suggestions.map((suggestion) => ({
      label: suggestion,
      click: () => window.webContents.replaceMisspelling(suggestion),
    })) : [{ label: "No suggestions", enabled: false }]));
    template.push({ label: "Add to Dictionary", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
  }
  template.push(
    { role: "undo", enabled: params.editFlags.canUndo },
    { role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll" },
  );
  return template;
}

function buildSelectionContextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (params.selectionText.length > 0) template.push({ role: "copy", enabled: params.editFlags.canCopy });
  if (params.linkURL.length > 0) template.push({ label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) });
  return template;
}

function assertTrustedRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url)) throw new Error("Untrusted renderer IPC request.");
}

function assertTrustedMainRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertTrustedRenderer(event);
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  const mainFrameMatches = Boolean(frame && frame.processId === mainFrame.processId && frame.routingId === mainFrame.routingId);
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !mainFrameMatches) {
    throw new Error("Restricted app view requests require the main work-fold renderer.");
  }
}

function routingSettingsId(value: unknown): string {
  if (typeof value !== "string") throw new Error("A Routing id is required.");
  const routingId = value.trim();
  if (!routingId || routingId.length > 256
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(routingId)) {
    throw new Error("The Routing id is invalid.");
  }
  return routingId;
}

function restrictedAppViewIdentity(value: unknown): { spaceId: string; appId: string; digest: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Restricted app view identity is invalid.");
  const record = value as Record<string, unknown>;
  const spaceId = typeof record.spaceId === "string" ? record.spaceId : "";
  const appId = typeof record.appId === "string" ? record.appId : "";
  const digest = typeof record.digest === "string" ? record.digest.toLowerCase() : "";
  if (!spaceId || spaceId.length > 256 || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(appId) || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Restricted app view identity is invalid.");
  }
  return { spaceId, appId, digest };
}

function restrictedAppViewPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Restricted app view request is invalid.");
  const { spaceId: _spaceId, appId: _appId, digest: _digest, ...payload } = value as Record<string, unknown>;
  return payload;
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${appProtocol}:` && url.hostname === "app";
  } catch {
    return false;
  }
}

function rendererArgument(name: string, value: string): string {
  return `--work-fold-${name}=${encodeURIComponent(value)}`;
}

function productRendererArguments(): string[] {
  return [
    rendererArgument("product-name", productName),
    rendererArgument("internal-protocol", appProtocol),
  ];
}

function resolveRendererDir(): string {
  const directory = app.isPackaged ? join(process.resourcesPath, "web-local") : join(repoRoot, "dist", "web-local");
  if (!existsSync(join(directory, "index.html"))) throw new Error(`${productName} renderer build was not found at ${directory}. Run npm run local:build.`);
  return directory;
}

function resolvePreloadPath(): string {
  return join(dirnameFromFile(currentFile), "preload.cjs");
}

function resolveManagementPopoverPreloadPath(): string {
  return join(dirnameFromFile(currentFile), "management-popover-preload.cjs");
}

function resolveRestrictedAppPreloadPath(): string {
  return join(dirnameFromFile(currentFile), "restricted-app-preload.cjs");
}

function resolveWindowIcon(): string {
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  return app.isPackaged ? join(process.resourcesPath, "assets", iconFile) : join(repoRoot, "desktop", "assets", iconFile);
}

function resolveDesktopAssetsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "assets") : join(repoRoot, "desktop", "assets");
}

function dirnameFromFile(value: string): string {
  return resolve(value, "..");
}

interface WindowState { x: number; y: number; width: number; height: number; isMaximized: boolean }

function configureWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState(window);
    }, windowStateSaveDelayMs);
  };
  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState(window);
  });
}

function readWindowState(): WindowState | null {
  const path = join(app.getPath("userData"), "window-state.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowState>;
    if (![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part))) return null;
    return {
      x: Math.round(value.x as number),
      y: Math.round(value.y as number),
      width: Math.max(minimumWindowState.width, Math.round(value.width as number)),
      height: Math.max(minimumWindowState.height, Math.round(value.height as number)),
      isMaximized: value.isMaximized === true,
    };
  } catch {
    return null;
  }
}

function visibleWindowState(state: WindowState | null): WindowState | null {
  if (!state || !screen.getAllDisplays().some((display) => intersects(state, display.bounds))) return null;
  const largestWorkArea = screen.getAllDisplays().reduce(
    (best, display) => display.workArea.width * display.workArea.height > best.width * best.height ? display.workArea : best,
    { x: 0, y: 0, width: minimumWindowState.width, height: minimumWindowState.height },
  );
  return {
    ...state,
    width: Math.min(state.width, largestWorkArea.width),
    height: Math.min(state.height, largestWorkArea.height),
  };
}

function saveWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const state: WindowState = { ...bounds, isMaximized: window.isMaximized() };
    writeFileSync(join(app.getPath("userData"), "window-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Window placement is a convenience; startup should not fail if it cannot be saved.
  }
}

function intersects(a: WindowState, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function samePath(first: string, second: string): boolean {
  const a = resolve(first);
  const b = resolve(second);
  return process.platform === "win32" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
