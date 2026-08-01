import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserWindow, MessageBoxOptions } from "electron";

const require = createRequire(import.meta.url);

const defaultStartupDelayMs = 5_000;
const defaultUpdateIntervalMs = 4 * 60 * 60 * 1_000;
const defaultTransientRetryDelayMs = 60_000;

export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface DesktopUpdateStatus {
  supported: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
}

/** Kept as an alias for callers from the initial public release. */
export type DesktopUpdateCheckResult = DesktopUpdateStatus;

export interface DesktopUpdateInfoLike {
  version: string;
}

export interface DesktopUpdateCheckResultLike {
  isUpdateAvailable: boolean;
  updateInfo: DesktopUpdateInfoLike;
  downloadPromise?: Promise<unknown> | null;
}

export interface DesktopUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  installerPath?: string | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<DesktopUpdateCheckResultLike | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface DesktopUpdateMessage {
  type: "info" | "error";
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  noLink?: boolean;
}

export interface DesktopUpdaterHost {
  isSupported(): boolean;
  platform(): NodeJS.Platform;
  currentVersion(): string;
  now(): string;
  installerExists(path: string): boolean;
  showMessage(options: DesktopUpdateMessage): Promise<{ response: number }>;
  setProgress(value: number): void;
  emitStatus(status: DesktopUpdateStatus): void;
}

export interface DesktopUpdaterOptions {
  getWindow?: () => BrowserWindow | null;
  prepareToInstall: () => Promise<void>;
  updater?: DesktopUpdaterAdapter;
  host?: DesktopUpdaterHost;
  automaticChecks?: boolean;
  timings?: Partial<{
    startupDelayMs: number;
    updateIntervalMs: number;
    transientRetryDelayMs: number;
  }>;
}

export function hasPackagedDesktopUpdateFeed(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  fileExists?: (path: string) => boolean;
}): boolean {
  if (!options.isPackaged || (options.platform !== "win32" && options.platform !== "darwin")) return false;
  return (options.fileExists ?? existsSync)(join(options.resourcesPath, "app-update.yml"));
}

export function hasDownloadedUpdatePayload(options: {
  platform: NodeJS.Platform;
  updateDownloadedEventReceived: boolean;
  installerPath: string | null;
  installerExists: boolean;
}): boolean {
  if (!options.updateDownloadedEventReceived) return false;
  // Squirrel.Mac owns the downloaded ZIP and does not expose installerPath.
  if (options.platform === "darwin") return true;
  return Boolean(options.installerPath && options.installerExists);
}

/**
 * Mature installed-update lifecycle. The feed always comes from the packaged
 * app-update.yml; this class never overrides GitHub, signing, or publisher data.
 */
export class DesktopUpdater {
  private readonly updater: DesktopUpdaterAdapter;
  private readonly host: DesktopUpdaterHost;
  private readonly prepareToInstall: () => Promise<void>;
  private readonly automaticChecks: boolean;
  private readonly startupDelayMs: number;
  private readonly updateIntervalMs: number;
  private readonly transientRetryDelayMs: number;
  private status: DesktopUpdateStatus;
  private configured = false;
  private disposed = false;
  private backgroundCheckInFlight = false;
  private installAfterDownload = false;
  private installOnQuit = false;
  private downloadedUpdateReady = false;
  private checkPromise: Promise<DesktopUpdateStatus> | null = null;
  private installPromise: Promise<DesktopUpdateStatus> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private promptingForRestart = false;

  constructor(options: DesktopUpdaterOptions) {
    this.updater = options.updater ?? defaultUpdaterAdapter();
    this.host = options.host ?? defaultElectronHost(options.getWindow ?? (() => null));
    this.prepareToInstall = options.prepareToInstall;
    this.automaticChecks = options.automaticChecks !== false;
    this.startupDelayMs = options.timings?.startupDelayMs ?? defaultStartupDelayMs;
    this.updateIntervalMs = options.timings?.updateIntervalMs ?? defaultUpdateIntervalMs;
    this.transientRetryDelayMs = options.timings?.transientRetryDelayMs ?? defaultTransientRetryDelayMs;
    this.status = {
      supported: this.supported,
      phase: this.supported ? "idle" : "unsupported",
      currentVersion: this.host.currentVersion(),
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      message: this.supported
        ? "Ready to check for updates."
        : "Updates are not available in this build.",
      error: null,
    };
  }

  get supported(): boolean {
    return this.host.isSupported();
  }

  start(): void {
    if (this.disposed || this.configured) return;
    this.configured = true;
    if (!this.supported) {
      this.setStatus({ phase: "unsupported", message: "Updates are not available in this build." });
      return;
    }

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;
    this.updater.on("checking-for-update", this.onCheckingForUpdate);
    this.updater.on("update-available", this.onUpdateAvailable);
    this.updater.on("update-not-available", this.onUpdateNotAvailable);
    this.updater.on("download-progress", this.onDownloadProgress);
    this.updater.on("update-downloaded", this.onUpdateDownloaded);
    this.updater.on("update-cancelled", this.onUpdateCancelled);
    this.updater.on("error", this.onError);
    this.setStatus({ phase: "idle", message: "Ready to check for updates.", error: null });

    if (!this.automaticChecks) return;
    this.scheduleBackgroundCheck(this.startupDelayMs);
    this.intervalTimer = setInterval(() => { void this.check(false); }, this.updateIntervalMs);
    this.intervalTimer.unref();
  }

  getStatus(): DesktopUpdateStatus {
    return {
      ...this.status,
      supported: this.supported,
      currentVersion: this.host.currentVersion(),
    };
  }

  /** `interactive=false` is a silent background check with transient retry. */
  check(interactive = true): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.disposed) return Promise.resolve(this.getStatus());
    const current = this.getStatus();
    if (current.phase === "ready" || current.phase === "installing") return Promise.resolve(current);
    if (!interactive && current.phase === "available") return Promise.resolve(current);
    if (this.checkPromise) return this.checkPromise;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.checkPromise = this.runCheck(!interactive).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async updateNow(): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.disposed) return this.getStatus();
    const current = this.getStatus();
    if (current.phase === "installing" || current.phase === "checking" || current.phase === "downloading") return current;
    if (current.phase === "ready") return this.install();

    const checked = current.phase === "available" ? current : await this.check(true);
    if (checked.phase !== "available") return checked;

    this.installAfterDownload = true;
    try {
      this.setStatus({ phase: "downloading", progressPercent: 0, message: "Downloading update...", error: null });
      await this.updater.downloadUpdate();
      return this.getStatus();
    } catch (error) {
      this.installAfterDownload = false;
      this.downloadedUpdateReady = false;
      return this.setStatus({
        phase: "error",
        progressPercent: null,
        message: "Update download failed.",
        error: errorMessage(error),
      });
    }
  }

  install(): Promise<DesktopUpdateStatus> {
    return this.beginInstall({ forceRunAfter: true, runShutdown: true });
  }

  shouldInstallOnQuit(): boolean {
    return this.supported && this.installOnQuit && this.status.phase === "ready";
  }

  installDownloadedUpdateOnQuit(): Promise<DesktopUpdateStatus> {
    if (!this.shouldInstallOnQuit()) return Promise.resolve(this.getStatus());
    return this.beginInstall({ forceRunAfter: false, runShutdown: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.retryTimer = null;
    this.intervalTimer = null;
    this.updater.off("checking-for-update", this.onCheckingForUpdate);
    this.updater.off("update-available", this.onUpdateAvailable);
    this.updater.off("update-not-available", this.onUpdateNotAvailable);
    this.updater.off("download-progress", this.onDownloadProgress);
    this.updater.off("update-downloaded", this.onUpdateDownloaded);
    this.updater.off("update-cancelled", this.onUpdateCancelled);
    this.updater.off("error", this.onError);
    this.host.setProgress(-1);
  }

  private async runCheck(background: boolean): Promise<DesktopUpdateStatus> {
    this.backgroundCheckInFlight = background;
    try {
      this.setStatus({ phase: "checking", progressPercent: null, message: "Checking for updates...", error: null });
      const result = await this.updater.checkForUpdates();
      if (!result) {
        return this.setStatus({
          phase: "not_available",
          progressPercent: null,
          checkedAt: this.host.now(),
          message: "No update feed is configured.",
          error: null,
        });
      }
      if (result.isUpdateAvailable) {
        return this.setStatus({
          phase: "available",
          availableVersion: result.updateInfo.version,
          progressPercent: null,
          checkedAt: this.host.now(),
          message: `work-fold ${result.updateInfo.version} is available.`,
          error: null,
        });
      }
      return this.setStatus({
        phase: "not_available",
        availableVersion: null,
        progressPercent: null,
        checkedAt: this.host.now(),
        message: `work-fold ${this.host.currentVersion()} is up to date.`,
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (background && isTransientNetworkUpdateError(message)) return this.deferTransientCheck(message);
      return this.setStatus({ phase: "error", progressPercent: null, message: "Update check failed.", error: message });
    } finally {
      this.backgroundCheckInFlight = false;
    }
  }

  private beginInstall(options: { forceRunAfter: boolean; runShutdown: boolean }): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.disposed || this.status.phase !== "ready") return Promise.resolve(this.getStatus());
    if (this.installPromise) return this.installPromise;

    const installerPath = this.downloadedInstallerPath();
    if (!hasDownloadedUpdatePayload({
      platform: this.host.platform(),
      updateDownloadedEventReceived: this.downloadedUpdateReady,
      installerPath,
      installerExists: Boolean(installerPath && this.host.installerExists(installerPath)),
    })) {
      this.installOnQuit = false;
      this.downloadedUpdateReady = false;
      return Promise.resolve(this.setStatus({
        phase: "error",
        progressPercent: null,
        message: "Downloaded update payload is missing.",
        error: this.host.platform() === "darwin"
          ? "Squirrel.Mac has no downloaded update ready to install."
          : installerPath ? `Installer not found at ${installerPath}.` : "No downloaded update installer path was available.",
      }));
    }

    this.installOnQuit = false;
    this.setStatus({
      phase: "installing",
      progressPercent: 100,
      message: options.forceRunAfter ? "Restarting to install update..." : "Installing update...",
      error: null,
    });
    this.installPromise = (async () => {
      try {
        if (options.runShutdown) await this.prepareToInstall();
        this.updater.quitAndInstall(true, options.forceRunAfter);
      } catch (error) {
        this.restoreReadyAfterInstallFailure(errorMessage(error));
      }
      return this.getStatus();
    })();
    return this.installPromise;
  }

  private restoreReadyAfterInstallFailure(message: string): DesktopUpdateStatus {
    this.installPromise = null;
    const installerPath = this.downloadedInstallerPath();
    if (hasDownloadedUpdatePayload({
      platform: this.host.platform(),
      updateDownloadedEventReceived: this.downloadedUpdateReady,
      installerPath,
      installerExists: Boolean(installerPath && this.host.installerExists(installerPath)),
    })) {
      this.installOnQuit = true;
      return this.setStatus({
        phase: "ready",
        progressPercent: 100,
        message: "The downloaded update is still ready to install.",
        error: message,
      });
    }
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    return this.setStatus({
      phase: "error",
      progressPercent: null,
      message: "Update install failed before restart.",
      error: message,
    });
  }

  private downloadedInstallerPath(): string | null {
    return typeof this.updater.installerPath === "string" && this.updater.installerPath.trim()
      ? this.updater.installerPath
      : null;
  }

  private scheduleBackgroundCheck(delayMs: number): void {
    if (!this.supported || this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.check(false);
    }, delayMs);
    this.retryTimer.unref();
  }

  private deferTransientCheck(message: string): DesktopUpdateStatus {
    console.warn(`work-fold update check deferred until the network recovers: ${message}`);
    this.scheduleBackgroundCheck(this.transientRetryDelayMs);
    return this.setStatus({
      phase: "idle",
      progressPercent: null,
      message: "Update check is waiting for the network to come back.",
      error: null,
    });
  }

  private readonly onCheckingForUpdate = (): void => {
    this.setStatus({ phase: "checking", progressPercent: null, message: "Checking for updates...", error: null });
  };

  private readonly onUpdateAvailable = (info: DesktopUpdateInfoLike): void => {
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.setStatus({
      phase: "available",
      availableVersion: info.version,
      progressPercent: null,
      checkedAt: this.host.now(),
      message: `work-fold ${info.version} is available.`,
      error: null,
    });
  };

  private readonly onUpdateNotAvailable = (info: DesktopUpdateInfoLike): void => {
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.setStatus({
      phase: "not_available",
      availableVersion: null,
      progressPercent: null,
      checkedAt: this.host.now(),
      message: `work-fold ${info.version || this.host.currentVersion()} is up to date.`,
      error: null,
    });
  };

  private readonly onDownloadProgress = (info: { percent: number }): void => {
    this.setStatus({
      phase: "downloading",
      progressPercent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : null,
      message: "Downloading update...",
      error: null,
    });
  };

  private readonly onUpdateDownloaded = (info: DesktopUpdateInfoLike): void => {
    this.installOnQuit = true;
    this.downloadedUpdateReady = true;
    this.setStatus({
      phase: "ready",
      availableVersion: info.version,
      progressPercent: 100,
      message: `work-fold ${info.version} is ready to install.`,
      error: null,
    });
    if (this.installAfterDownload) {
      this.installAfterDownload = false;
      void this.install();
      return;
    }
    if (!this.disposed) void this.promptToRestart(info.version);
  };

  private readonly onUpdateCancelled = (): void => {
    this.installAfterDownload = false;
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.setStatus({ phase: "idle", progressPercent: null, message: "The update download was cancelled.", error: null });
  };

  private readonly onError = (error: Error): void => {
    const message = errorMessage(error);
    console.warn(`work-fold updater error: ${message}`);
    if (this.status.phase === "installing" || this.installPromise) {
      this.restoreReadyAfterInstallFailure(message);
      return;
    }
    if ((this.backgroundCheckInFlight || this.isDeferredNetworkStatus()) && isTransientNetworkUpdateError(message)) {
      this.deferTransientCheck(message);
      return;
    }
    if (this.status.phase === "downloading") this.downloadedUpdateReady = false;
    this.setStatus({ phase: "error", progressPercent: null, message: "Update check failed.", error: message });
  };

  private isDeferredNetworkStatus(): boolean {
    return this.status.phase === "idle" && this.status.message === "Update check is waiting for the network to come back.";
  }

  private async promptToRestart(version: string): Promise<void> {
    if (this.promptingForRestart || this.disposed) return;
    this.promptingForRestart = true;
    try {
      const result = await this.host.showMessage({
        type: "info",
        title: "work-fold update ready",
        message: `work-fold ${version} is ready to install.`,
        detail: "Restart work-fold to finish updating. If you choose Later, the update will install when you quit the app.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        await this.install();
        return;
      }
      this.installOnQuit = true;
      this.setStatus({
        phase: "ready",
        availableVersion: version,
        progressPercent: 100,
        message: `work-fold ${version} will install when you quit.`,
        error: null,
      });
    } finally {
      this.promptingForRestart = false;
    }
  }

  private setStatus(patch: Partial<DesktopUpdateStatus>): DesktopUpdateStatus {
    this.status = {
      ...this.status,
      ...patch,
      supported: this.supported,
      currentVersion: this.host.currentVersion(),
    };
    const status = this.getStatus();
    this.host.emitStatus(status);
    this.host.setProgress(status.phase === "downloading" && status.progressPercent !== null ? status.progressPercent / 100 : -1);
    return status;
  }
}

export function isTransientNetworkUpdateError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "err_name_not_resolved",
    "err_internet_disconnected",
    "err_network_changed",
    "err_connection_reset",
    "err_connection_timed_out",
    "err_timed_out",
    "enotfound",
    "eai_again",
    "etimedout",
    "econnreset",
    "socket hang up",
    "network socket disconnected",
    "fetch failed",
    "name not resolved",
    "temporary failure in name resolution",
  ].some((needle) => normalized.includes(needle));
}

function defaultUpdaterAdapter(): DesktopUpdaterAdapter {
  const updaterModule = require("electron-updater") as { autoUpdater: DesktopUpdaterAdapter };
  return updaterModule.autoUpdater;
}

function defaultElectronHost(getWindow: () => BrowserWindow | null): DesktopUpdaterHost {
  const electron = require("electron") as typeof import("electron");
  return {
    isSupported: () => hasPackagedDesktopUpdateFeed({
      isPackaged: electron.app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
    }),
    platform: () => process.platform,
    currentVersion: () => electron.app.getVersion(),
    now: () => new Date().toISOString(),
    installerExists: existsSync,
    showMessage: async (options) => {
      const window = getWindow();
      const result = window && !window.isDestroyed()
        ? await electron.dialog.showMessageBox(window, options as MessageBoxOptions)
        : await electron.dialog.showMessageBox(options as MessageBoxOptions);
      return { response: result.response };
    },
    setProgress: (value) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.setProgressBar(value);
    },
    emitStatus: (status) => {
      const window = getWindow();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("work-fold:updates:status-changed", status);
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
