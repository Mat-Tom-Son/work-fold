import type {
  AutomationDetailResponse,
  AutomationHistoryResponse,
  AutomationsResponse,
  AutomationRunResponse,
  AutomationEnableResponse,
  AutomationEnableProposalResponse,
  AutomationProposalsResponse,
} from "./components/modals/AutomationsPane";

export {};

interface WorkFoldDesktopUpdateStatus {
  supported: boolean;
  phase: "unsupported" | "idle" | "checking" | "available" | "not_available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
}

interface WorkFoldRemoteAccessStatus {
  configured: boolean;
  enabled: boolean;
  connection: "stopped" | "connecting" | "connected" | "error";
  slug: string | null;
  url: string | null;
  /** The pages-<slug> origin share links compose against; null until an address exists. */
  viewerOrigin: string | null;
  lastError: string | null;
  approvedBrowsers: Array<{ id: string; browserId: string; label: string; approvedAt: string }>;
}

type WorkFoldDesktopMenuCommand =
  | "new-work-folder"
  | "open-local-folder"
  | "new-chat"
  | "reload-work-folder-state"
  | "check-for-updates"
  | "open-settings"
  | "open-about"
  | "open-capabilities"
  | "open-skills"
  | "open-extensions"
  | "open-command-palette"
  | "open-keyboard-shortcuts"
  | "close-tab"
  | "toggle-sidebar"
  | "toggle-agent-panel";

type WorkFoldDesktopMenuId = "file" | "edit" | "view" | "help";
type WorkFoldDesktopPathAction = "open" | "open-native" | "reveal";
type WorkFoldDesktopFileMenuCommand = "open" | "open-with" | "reveal" | "copy-path" | "attach-chat" | "version-history" | "share" | "new-folder" | "upload-here" | "refresh" | "give-worker" | "rename" | "delete";

interface WorkFoldDesktopFileMenuRequest {
  workFolderId: string;
  path: string;
  kind: "file" | "folder";
  capabilities: {
    open: boolean;
    attach: boolean;
    history: boolean;
    upload: boolean;
    rename: boolean;
    delete: boolean;
    share: boolean;
    shared: boolean;
    worker?: boolean;
  };
  point: { x: number; y: number };
}

interface WorkFoldRestrictedAppViewRequest {
  workFolderId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  mountId: string;
  placement: "navigator" | "tab";
  appTabId?: string;
  route: string;
  state?: unknown;
  sequence: number;
  bounds: { x: number; y: number; width: number; height: number };
  active: boolean;
  occluded: boolean;
  theme: "light" | "dark";
  appearance?: Record<string, string>;
  openedFrom?: { kind: "notification"; permissionId: string };
}

interface WorkFoldBrowserHistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisitedAt: string;
}

type WorkFoldBrowserCommand =
  | { type: "back" | "forward" | "reload" | "stop" | "focus" | "stop-find" | "inspect" | "zoom-in" | "zoom-out" | "zoom-reset" | "dismiss-notice" | "print" | "save-pdf" | "open-blocked-popup" | "allow-popups" | "dismiss-blocked-popup" }
  | { type: "mute"; muted: boolean }
  | { type: "find"; text: string; forward: boolean; newSearch: boolean }
  | { type: "forget-permission" | "open-privacy-settings"; kind: import("../../src/shared/browser").BrowserSitePermission };

interface WorkFoldRestrictedAppAttention {
  workFolderId: string;
  appId: string;
  featureInstallationId: string;
  count: number;
}

interface WorkFoldRestrictedAppTabCommand {
  type: "open" | "update" | "close";
  workFolderId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  sourceMountId: string;
  sourcePlacement: "navigator" | "tab";
  sourceAppTabId?: string;
  tab?: { appTabId: string; title: string; route: string; state?: unknown };
}

interface WorkFoldRestrictedAppViewState {
  mountId: string;
  state: "loading" | "ready" | "crashed" | "stopped";
  message?: string;
}

interface WorkFoldRestrictedAppOwner {
  workFolderId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  permissionId: string;
  /** Where the clicked notification opens the app's left-pane view; "/" when the app named none. */
  route?: string;
  state?: unknown;
}

declare global {
  interface Window {
    workFoldDesktop?: {
      desktop: true;
      clipboard?: import("../../src/shared/clipboard").ClipboardWriter;
      api: {
        baseUrl: string;
        getSessionHeaders: () => Promise<Record<string, string>>;
      };
      app: {
        name: string;
        version: string;
        platform: NodeJS.Platform;
        iconUrl: string;
      };
      runtime: {
        getHealth: () => Promise<{
          pi: { ok: boolean; configured?: boolean; version?: string; message?: string };
          settings: { encryptionAvailable: boolean; configuredProviders: string[] };
        }>;
        onRendererRecovered: (listener: () => void) => () => void;
      };
      workFolder: {
        chooseFolder: () => Promise<{ path: string; folderGrantId: string } | null>;
        revealFolder: (workFolderId: string) => Promise<void>;
        openPath: (workFolderId: string, path: string, action?: WorkFoldDesktopPathAction) => Promise<void>;
        openPathWith?: (workFolderId: string, path: string) => Promise<{ opened: boolean; canceled: boolean; appName: string | null }>;
        startDrag: (workFolderId: string, path: string) => Promise<void>;
        previewFile: (workFolderId: string, path: string) => Promise<boolean>;
        popupFileMenu?: (request: WorkFoldDesktopFileMenuRequest) => Promise<WorkFoldDesktopFileMenuCommand | null>;
        setActiveWorkFolder: (workFolderId: string | null) => Promise<void>;
        onOpenWorkFolder: (listener: (workFolderId: string, view?: "checks") => void) => () => void;
        onOpenFolder: (listener: () => void) => () => void;
      };
      agent: {
        /** The local path of a file dropped on the work-fold agent panel. */
        getPathForFile?: (file: File) => string;
        openWorkFoldAgentDraft?: (text: string) => Promise<boolean>;
        openChecks?: (workFolderId: string) => Promise<boolean>;
        onOpenSettings: (listener: (scope?: "agent") => void) => () => void;
      };
      /** Main-window-only automation management; absent from the popover preload. */
      automations?: {
        list: () => Promise<AutomationsResponse>;
        /** Pending `*.work-fold-automation.json` files in the work-fold agent's working folder. */
        proposals: () => Promise<AutomationProposalsResponse>;
        /** Turns on one pending file by absolute path, through the same enable path as the CLI. */
        enableProposal: (path: string) => Promise<AutomationEnableProposalResponse>;
        show: (automationId: string) => Promise<AutomationDetailResponse>;
        history: (automationId: string) => Promise<AutomationHistoryResponse>;
        enable: (automationId: string) => Promise<AutomationEnableResponse>;
        run: (automationId: string) => Promise<AutomationRunResponse>;
        stop: (automationId: string) => Promise<unknown>;
        disable: (automationId: string) => Promise<unknown>;
        delete: (automationId: string) => Promise<unknown>;
      };
      workFoldAgent?: {
        openChecks?: (workFolderId: string) => Promise<boolean>;
        openResultFile?: (workFolderId: string, path: string) => Promise<void>;
        getPathForFile: (file: File) => string;
        hide: () => void;
        openMainWindow: () => Promise<boolean>;
        openAiModelsSettings: () => Promise<boolean>;
        onStaged: (listener: (items: Array<{ kind: "path" | "text"; value: string }>) => void) => () => void;
      };
      restrictedApps: {
        mountView: (request: WorkFoldRestrictedAppViewRequest) => Promise<{ mounted: true; digest: string }>;
        layoutView: (request: WorkFoldRestrictedAppViewRequest) => void;
        unmountView: (mountId: string) => Promise<void>;
        onTabCommand: (listener: (command: WorkFoldRestrictedAppTabCommand) => void) => () => void;
        onViewState: (listener: (state: WorkFoldRestrictedAppViewState) => void) => () => void;
        onOpenRequest: (listener: (owner: WorkFoldRestrictedAppOwner) => void) => () => void;
        attentionStates?: () => Promise<WorkFoldRestrictedAppAttention[]>;
        onAttention?: (listener: (state: WorkFoldRestrictedAppAttention) => void) => () => void;
      };
      /** The built-in browser's tabs; main-window only (docs/built-in-browser.md). */
      browser?: {
        mount: (request: import("../../src/shared/browser").BrowserViewRequest) => Promise<import("../../src/shared/browser").BrowserPageState | null>;
        layout: (request: import("../../src/shared/browser").BrowserViewRequest) => void;
        unmount: (pageId: string) => Promise<void>;
        navigate: (pageId: string, address: string) => Promise<import("../../src/shared/browser").BrowserPageState>;
        command: (pageId: string, command: WorkFoldBrowserCommand) => Promise<void>;
        close: (pageId: string) => Promise<void>;
        respondPermission: (pageId: string, requestId: string, decision: "allow" | "block") => Promise<void>;
        sync: (tabs: import("../../src/shared/browser").BrowserTabsSync) => void;
        states: () => Promise<import("../../src/shared/browser").BrowserPageState[]>;
        /** Shows a file the browser downloaded in Finder or Explorer. */
        showDownload: (path: string) => Promise<void>;
        /** A browser tab's right-click menu; resolves with what the tab strip should do, if anything. */
        popupTabMenu: (pageId: string, url: string, point: { x: number; y: number }, options: { canReopen: boolean; hasOthers: boolean }) => Promise<import("../../src/shared/browser").BrowserTabMenuCommand | null>;
        /** Pages from history matching what someone typed in the address bar. */
        suggest: (text: string) => Promise<WorkFoldBrowserHistoryEntry[]>;
        /** The most recently visited pages, for a new tab. */
        recent: () => Promise<WorkFoldBrowserHistoryEntry[]>;
        clearHistory: () => Promise<void>;
        onState: (listener: (state: import("../../src/shared/browser").BrowserPageState) => void) => () => void;
        onOpenTab: (listener: (command: import("../../src/shared/browser").BrowserOpenTabCommand) => void) => () => void;
        onCloseTab: (listener: (command: { pageId: string }) => void) => () => void;
        onShortcut: (listener: (shortcut: import("../../src/shared/browser").BrowserShortcut) => void) => () => void;
        onFindResult: (listener: (result: import("../../src/shared/browser").BrowserFindResult) => void) => () => void;
        onDownload: (listener: (download: import("../../src/shared/browser").BrowserDownload) => void) => () => void;
      };
      window: {
        control?: (action: "state" | "minimize" | "toggle-maximize" | "quit") => Promise<{ maximized: boolean }>;
        onMaximized?: (listener: (maximized: boolean) => void) => () => void;
        material: "mica" | "vibrancy" | "none";
        setTheme: (theme: "light" | "dark", source?: "light" | "dark" | "system") => void;
        railTooltip: {
          show: (request: {
            text: string;
            bounds: { x: number; y: number; width: number; height: number };
            theme: "light" | "dark";
          }) => void;
          hide: () => void;
        };
        getAccentColor: () => Promise<string | null>;
        onAccentColorChanged: (listener: (accent: string | null) => void) => () => void;
        getCloseToTray: () => Promise<{ supported: boolean; enabled: boolean }>;
        setCloseToTray: (enabled: boolean) => Promise<{ supported: boolean; enabled: boolean }>;
      };
      shell: {
        openExternal: (url: string) => Promise<void>;
      };
      updates: {
        getStatus: () => Promise<WorkFoldDesktopUpdateStatus>;
        check: () => Promise<WorkFoldDesktopUpdateStatus>;
        install: () => Promise<WorkFoldDesktopUpdateStatus>;
        updateNow: () => Promise<WorkFoldDesktopUpdateStatus>;
        onStatusChanged: (listener: (status: WorkFoldDesktopUpdateStatus) => void) => () => void;
      };
      settings: {
        getStatus: () => Promise<{ encryptionAvailable: boolean; configuredProviders: string[] }>;
      };
      remoteAccess: {
        getStatus: () => Promise<WorkFoldRemoteAccessStatus>;
        configure: (request: { slug: string; password: string }) => Promise<WorkFoldRemoteAccessStatus>;
        setEnabled: (enabled: boolean) => Promise<WorkFoldRemoteAccessStatus>;
        revokeBrowser: (grantId: string) => Promise<WorkFoldRemoteAccessStatus>;
        revokeAll: () => Promise<WorkFoldRemoteAccessStatus>;
        remove: () => Promise<WorkFoldRemoteAccessStatus>;
        open: () => Promise<void>;
        onStatusChanged: (listener: (status: WorkFoldRemoteAccessStatus) => void) => () => void;
      };
      menu: {
        setState: (state: { workFolderOpen: boolean }) => void;
        popup: (menuId: WorkFoldDesktopMenuId, bounds: { x: number; y: number }) => Promise<void>;
        onCommand: (listener: (command: WorkFoldDesktopMenuCommand) => void) => () => void;
      };
    };
  }
}
