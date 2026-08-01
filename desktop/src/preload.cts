const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

function argumentValue(name: string): string {
  const prefix = `--work-fold-${name}=`;
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
const productName = argumentValue("product-name");
const internalProtocol = argumentValue("internal-protocol");
const rawWindowMaterial = argumentValue("window-material");
const windowMaterial = rawWindowMaterial === "mica" || rawWindowMaterial === "vibrancy" ? rawWindowMaterial : "none";

contextBridge.exposeInMainWorld("workFoldDesktop", {
  desktop: true,
  api: {
    baseUrl: apiBaseUrl,
    getSessionHeaders: () => ipcRenderer.invoke("work-fold:api:session-headers"),
  },
  app: {
    name: productName,
    version: appVersion,
    platform: process.platform,
    iconUrl: internalProtocol ? `${internalProtocol}://app/_desktop-assets/icon-32.png` : "",
  },
  runtime: {
    getHealth: () => ipcRenderer.invoke("work-fold:runtime:health"),
    onRendererRecovered: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("work-fold:runtime:renderer-recovered", listener);
      return () => ipcRenderer.removeListener("work-fold:runtime:renderer-recovered", listener);
    },
  },
  space: {
    chooseFolder: () => ipcRenderer.invoke("work-fold:space:choose-folder"),
    revealFolder: (spaceId: string) => ipcRenderer.invoke("work-fold:space:reveal-folder", spaceId),
    openPath: (spaceId: string, path: string, action: "open" | "open-native" | "reveal" = "open") => (
      ipcRenderer.invoke("work-fold:space:open-path", { spaceId, path, action })
    ),
    startDrag: (spaceId: string, path: string) => ipcRenderer.invoke("work-fold:space:start-drag", { spaceId, path }),
    previewFile: (spaceId: string, path: string) => ipcRenderer.invoke("work-fold:space:preview-file", { spaceId, path }),
    ...(process.platform === "darwin" ? {
      popupFileMenu: (request: {
        spaceId: string;
        path: string;
        kind: "file" | "folder";
        capabilities: { open: boolean; attach: boolean; history: boolean; upload: boolean; rename: boolean; delete: boolean };
        point: { x: number; y: number };
      }) => ipcRenderer.invoke("work-fold:space:popup-file-menu", request),
    } : {}),
    setActiveSpace: (spaceId: string | null) => ipcRenderer.invoke("work-fold:space:set-active-space", spaceId),
    onOpenSpace: (callback: (spaceId: string) => void) => {
      let disposed = false;
      const deliveredTokens = new Set<string>();
      const deliver = (value: unknown) => {
        if (disposed || !value || typeof value !== "object" || Array.isArray(value)) return;
        const request = value as { token?: unknown; spaceId?: unknown };
        if (typeof request.token !== "string" || !request.token || request.token.length > 128
          || typeof request.spaceId !== "string" || !request.spaceId || request.spaceId.length > 512) return;
        if (deliveredTokens.has(request.token)) return;
        deliveredTokens.add(request.token);
        if (deliveredTokens.size > 32) deliveredTokens.delete(deliveredTokens.values().next().value as string);
        callback(request.spaceId);
        ipcRenderer.send("work-fold:space:ack-open-space", request.token);
      };
      const listener = (_event: unknown, value: unknown) => deliver(value);
      ipcRenderer.on("work-fold:space:open-space", listener);
      void ipcRenderer.invoke("work-fold:space:take-open-space").then(deliver).catch(() => undefined);
      return () => {
        disposed = true;
        ipcRenderer.removeListener("work-fold:space:open-space", listener);
      };
    },
    onOpenFolder: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("work-fold:menu:open-folder", listener);
      return () => ipcRenderer.removeListener("work-fold:menu:open-folder", listener);
    },
  },
  agent: {
    onOpenSettings: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("work-fold:agent:open-settings", listener);
      return () => ipcRenderer.removeListener("work-fold:agent:open-settings", listener);
    },
  },
  restrictedApps: {
    mountView: (request: unknown) => ipcRenderer.invoke("work-fold:restricted-app-view:mount", request),
    layoutView: (request: unknown) => ipcRenderer.send("work-fold:restricted-app-view:layout", request),
    unmountView: (mountId: string) => ipcRenderer.invoke("work-fold:restricted-app-view:unmount", mountId),
    onTabCommand: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("work-fold:restricted-app-view:tab-command", listener);
      return () => ipcRenderer.removeListener("work-fold:restricted-app-view:tab-command", listener);
    },
    onViewState: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("work-fold:restricted-app-view:state", listener);
      return () => ipcRenderer.removeListener("work-fold:restricted-app-view:state", listener);
    },
    onOpenRequest: (callback: (owner: unknown) => void) => {
      const listener = (_event: unknown, owner: unknown) => callback(owner);
      ipcRenderer.on("work-fold:restricted-app-view:open-request", listener);
      return () => ipcRenderer.removeListener("work-fold:restricted-app-view:open-request", listener);
    },
  },
  window: {
    material: windowMaterial,
    setTheme: (theme: "light" | "dark", source?: "light" | "dark" | "system") => ipcRenderer.send("work-fold:window:set-theme", theme, source),
    railTooltip: {
      show: (request: unknown) => ipcRenderer.send("work-fold:window:rail-tooltip-show", request),
      hide: () => ipcRenderer.send("work-fold:window:rail-tooltip-hide"),
    },
    getAccentColor: () => ipcRenderer.invoke("work-fold:window:accent-color"),
    getCloseToTray: () => ipcRenderer.invoke("work-fold:window:get-close-to-tray"),
    setCloseToTray: (enabled: boolean) => ipcRenderer.invoke("work-fold:window:set-close-to-tray", enabled),
    onAccentColorChanged: (callback: (accent: string | null) => void) => {
      const listener = (_event: unknown, accent: string | null) => callback(accent);
      ipcRenderer.on("work-fold:window:accent-color-changed", listener);
      return () => ipcRenderer.removeListener("work-fold:window:accent-color-changed", listener);
    },
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("work-fold:shell:open-external", url),
  },
  updates: {
    getStatus: () => ipcRenderer.invoke("work-fold:updates:status"),
    check: () => ipcRenderer.invoke("work-fold:updates:check"),
    install: () => ipcRenderer.invoke("work-fold:updates:install"),
    updateNow: () => ipcRenderer.invoke("work-fold:updates:update-now"),
    onStatusChanged: (callback: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on("work-fold:updates:status-changed", listener);
      return () => ipcRenderer.removeListener("work-fold:updates:status-changed", listener);
    },
  },
  settings: {
    getStatus: () => ipcRenderer.invoke("work-fold:settings:status"),
  },
  menu: {
    setState: (state: unknown) => ipcRenderer.send("work-fold:menu:set-state", state),
    popup: (menuId: unknown, bounds: unknown) => ipcRenderer.invoke("work-fold:menu:popup", menuId, bounds),
    onCommand: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("work-fold:menu-command", listener);
      return () => ipcRenderer.removeListener("work-fold:menu-command", listener);
    },
  },
});
