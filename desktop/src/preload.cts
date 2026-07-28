const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

function argumentValue(name: string): string {
  const prefix = `--workspace-${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return "";
  try {
    return decodeURIComponent(argument.slice(prefix.length));
  } catch {
    return "";
  }
}

const apiBaseUrl = argumentValue("api-base-url");
const appVersion = argumentValue("app-version");
const rawWindowMaterial = argumentValue("window-material");
const windowMaterial = rawWindowMaterial === "mica" || rawWindowMaterial === "vibrancy" ? rawWindowMaterial : "none";

contextBridge.exposeInMainWorld("workspaceDesktop", {
  desktop: true,
  api: {
    baseUrl: apiBaseUrl,
    getSessionHeaders: () => ipcRenderer.invoke("workspace:api:session-headers"),
  },
  app: {
    name: "Workspace",
    version: appVersion,
    platform: process.platform,
    iconUrl: "workspace-desktop://app/_desktop-assets/icon-32.png",
  },
  runtime: {
    getHealth: () => ipcRenderer.invoke("workspace:runtime:health"),
    onRendererRecovered: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("workspace:runtime:renderer-recovered", listener);
      return () => ipcRenderer.removeListener("workspace:runtime:renderer-recovered", listener);
    },
  },
  workspace: {
    chooseFolder: () => ipcRenderer.invoke("workspace:workspace:choose-folder"),
    revealFolder: (workspaceId: string) => ipcRenderer.invoke("workspace:workspace:reveal-folder", workspaceId),
    openPath: (workspaceId: string, path: string, action: "open" | "open-native" | "reveal" = "open") => (
      ipcRenderer.invoke("workspace:workspace:open-path", { workspaceId, path, action })
    ),
    startDrag: (workspaceId: string, path: string) => ipcRenderer.invoke("workspace:workspace:start-drag", { workspaceId, path }),
    previewFile: (workspaceId: string, path: string) => ipcRenderer.invoke("workspace:workspace:preview-file", { workspaceId, path }),
    ...(process.platform === "darwin" ? {
      popupFileMenu: (request: {
        workspaceId: string;
        path: string;
        kind: "file" | "folder";
        capabilities: { open: boolean; attach: boolean; history: boolean; upload: boolean; rename: boolean; delete: boolean };
        point: { x: number; y: number };
      }) => ipcRenderer.invoke("workspace:workspace:popup-file-menu", request),
    } : {}),
    setActiveSpace: (workspaceId: string | null) => ipcRenderer.invoke("workspace:workspace:set-active-space", workspaceId),
    onOpenSpace: (callback: (workspaceId: string) => void) => {
      let disposed = false;
      const deliveredTokens = new Set<string>();
      const deliver = (value: unknown) => {
        if (disposed || !value || typeof value !== "object" || Array.isArray(value)) return;
        const request = value as { token?: unknown; workspaceId?: unknown };
        if (typeof request.token !== "string" || !request.token || request.token.length > 128
          || typeof request.workspaceId !== "string" || !request.workspaceId || request.workspaceId.length > 512) return;
        if (deliveredTokens.has(request.token)) return;
        deliveredTokens.add(request.token);
        if (deliveredTokens.size > 32) deliveredTokens.delete(deliveredTokens.values().next().value as string);
        callback(request.workspaceId);
        ipcRenderer.send("workspace:workspace:ack-open-space", request.token);
      };
      const listener = (_event: unknown, value: unknown) => deliver(value);
      ipcRenderer.on("workspace:workspace:open-space", listener);
      void ipcRenderer.invoke("workspace:workspace:take-open-space").then(deliver).catch(() => undefined);
      return () => {
        disposed = true;
        ipcRenderer.removeListener("workspace:workspace:open-space", listener);
      };
    },
    onOpenFolder: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("workspace:menu:open-folder", listener);
      return () => ipcRenderer.removeListener("workspace:menu:open-folder", listener);
    },
  },
  agent: {
    onOpenSettings: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("workspace:agent:open-settings", listener);
      return () => ipcRenderer.removeListener("workspace:agent:open-settings", listener);
    },
  },
  restrictedApps: {
    mountView: (request: unknown) => ipcRenderer.invoke("workspace:restricted-app-view:mount", request),
    layoutView: (request: unknown) => ipcRenderer.send("workspace:restricted-app-view:layout", request),
    unmountView: (mountId: string) => ipcRenderer.invoke("workspace:restricted-app-view:unmount", mountId),
    onTabCommand: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("workspace:restricted-app-view:tab-command", listener);
      return () => ipcRenderer.removeListener("workspace:restricted-app-view:tab-command", listener);
    },
    onViewState: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("workspace:restricted-app-view:state", listener);
      return () => ipcRenderer.removeListener("workspace:restricted-app-view:state", listener);
    },
    onOpenRequest: (callback: (owner: unknown) => void) => {
      const listener = (_event: unknown, owner: unknown) => callback(owner);
      ipcRenderer.on("workspace:restricted-app-view:open-request", listener);
      return () => ipcRenderer.removeListener("workspace:restricted-app-view:open-request", listener);
    },
  },
  window: {
    material: windowMaterial,
    setTheme: (theme: "light" | "dark", source?: "light" | "dark" | "system") => ipcRenderer.send("workspace:window:set-theme", theme, source),
    railTooltip: {
      show: (request: unknown) => ipcRenderer.send("workspace:window:rail-tooltip-show", request),
      hide: () => ipcRenderer.send("workspace:window:rail-tooltip-hide"),
    },
    getAccentColor: () => ipcRenderer.invoke("workspace:window:accent-color"),
    getCloseToTray: () => ipcRenderer.invoke("workspace:window:get-close-to-tray"),
    setCloseToTray: (enabled: boolean) => ipcRenderer.invoke("workspace:window:set-close-to-tray", enabled),
    onAccentColorChanged: (callback: (accent: string | null) => void) => {
      const listener = (_event: unknown, accent: string | null) => callback(accent);
      ipcRenderer.on("workspace:window:accent-color-changed", listener);
      return () => ipcRenderer.removeListener("workspace:window:accent-color-changed", listener);
    },
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("workspace:shell:open-external", url),
  },
  updates: {
    getStatus: () => ipcRenderer.invoke("workspace:updates:status"),
    check: () => ipcRenderer.invoke("workspace:updates:check"),
    install: () => ipcRenderer.invoke("workspace:updates:install"),
    updateNow: () => ipcRenderer.invoke("workspace:updates:update-now"),
    onStatusChanged: (callback: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on("workspace:updates:status-changed", listener);
      return () => ipcRenderer.removeListener("workspace:updates:status-changed", listener);
    },
  },
  settings: {
    getStatus: () => ipcRenderer.invoke("workspace:settings:status"),
  },
  menu: {
    setState: (state: unknown) => ipcRenderer.send("workspace:menu:set-state", state),
    popup: (menuId: unknown, bounds: unknown) => ipcRenderer.invoke("workspace:menu:popup", menuId, bounds),
    onCommand: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("workspace:menu-command", listener);
      return () => ipcRenderer.removeListener("workspace:menu-command", listener);
    },
  },
});
