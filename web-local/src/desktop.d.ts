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
  | "new-space"
  | "open-local-folder"
  | "new-chat"
  | "reload-space-state"
  | "check-for-updates"
  | "open-settings"
  | "open-about"
  | "open-capabilities"
  | "open-skills"
  | "open-extensions"
  | "open-command-palette"
  | "open-keyboard-shortcuts";

type WorkFoldDesktopMenuId = "file" | "edit" | "view" | "help";
type WorkFoldDesktopPathAction = "open" | "open-native" | "reveal";
type WorkFoldDesktopFileMenuCommand = "open" | "reveal" | "copy-path" | "attach-chat" | "version-history" | "upload-here" | "rename" | "delete";

interface WorkFoldDesktopFileMenuRequest {
  spaceId: string;
  path: string;
  kind: "file" | "folder";
  capabilities: {
    open: boolean;
    attach: boolean;
    history: boolean;
    upload: boolean;
    rename: boolean;
    delete: boolean;
  };
  point: { x: number; y: number };
}

interface WorkFoldRestrictedAppViewRequest {
  spaceId: string;
  appId: string;
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
}

interface WorkFoldRestrictedAppTabCommand {
  type: "open" | "update" | "close";
  spaceId: string;
  appId: string;
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
  spaceId: string;
  appId: string;
  digest: string;
  permissionId: string;
}

declare global {
  interface Window {
    workFoldDesktop?: {
      desktop: true;
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
      space: {
        chooseFolder: () => Promise<{ path: string; folderGrantId: string } | null>;
        revealFolder: (spaceId: string) => Promise<void>;
        openPath: (spaceId: string, path: string, action?: WorkFoldDesktopPathAction) => Promise<void>;
        startDrag: (spaceId: string, path: string) => Promise<void>;
        previewFile: (spaceId: string, path: string) => Promise<boolean>;
        popupFileMenu?: (request: WorkFoldDesktopFileMenuRequest) => Promise<WorkFoldDesktopFileMenuCommand | null>;
        setActiveSpace: (spaceId: string | null) => Promise<void>;
        onOpenSpace: (listener: (spaceId: string) => void) => () => void;
        onOpenFolder: (listener: () => void) => () => void;
      };
      agent: {
        onOpenSettings: (listener: (scope?: "management") => void) => () => void;
      };
      /**
       * Main-window-only needs-you helpers; absent in the popover's narrow
       * preload, so surfaces feature-detect the file-grant folder picker.
       */
      decisions?: {
        chooseFileGrantRoot: (spaceId: string) => Promise<{ root?: string; error?: string } | null>;
      };
      management?: {
        getPathForFile: (file: File) => string;
        hide: () => void;
        openMainWindow: () => Promise<boolean>;
        openAssistantSettings: () => Promise<boolean>;
        onStaged: (listener: (items: Array<{ kind: "path" | "text"; value: string }>) => void) => () => void;
      };
      restrictedApps: {
        mountView: (request: WorkFoldRestrictedAppViewRequest) => Promise<{ mounted: true; digest: string }>;
        layoutView: (request: WorkFoldRestrictedAppViewRequest) => void;
        unmountView: (mountId: string) => Promise<void>;
        onTabCommand: (listener: (command: WorkFoldRestrictedAppTabCommand) => void) => () => void;
        onViewState: (listener: (state: WorkFoldRestrictedAppViewState) => void) => () => void;
        onOpenRequest: (listener: (owner: WorkFoldRestrictedAppOwner) => void) => () => void;
      };
      window: {
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
        setState: (state: { spaceOpen: boolean }) => void;
        popup: (menuId: WorkFoldDesktopMenuId, bounds: { x: number; y: number }) => Promise<void>;
        onCommand: (listener: (command: WorkFoldDesktopMenuCommand) => void) => () => void;
      };
    };
  }
}
