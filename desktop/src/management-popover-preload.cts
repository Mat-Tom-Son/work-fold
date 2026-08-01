const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");
const productIdentity = require("../../src/shared/product-identity.json") as typeof import("../../src/shared/product-identity.json");

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

const rawWindowMaterial = argumentValue("window-material");
const windowMaterial = rawWindowMaterial === "vibrancy" ? "vibrancy" : "none";
const maxStagedItems = 16;
const maxStagedValueLength = 4_096;

// This window only needs the local API session and four popover actions. Keep
// it separate from the main renderer preload so a UI bug here cannot reach
// folder pickers, restricted-app brokers, updates, settings, or shell actions.
contextBridge.exposeInMainWorld("workFoldDesktop", {
  desktop: true,
  api: {
    baseUrl: argumentValue("api-base-url"),
    getSessionHeaders: () => ipcRenderer.invoke("work-fold:api:session-headers"),
  },
  app: {
    name: productIdentity.productName,
    version: argumentValue("app-version"),
    platform: process.platform,
    iconUrl: `${productIdentity.internalProtocol}://app/_desktop-assets/icon-32.png`,
  },
  management: {
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) ?? "";
      } catch {
        return "";
      }
    },
    hide: () => ipcRenderer.send("work-fold:management:hide"),
    openMainWindow: () => ipcRenderer.invoke("work-fold:management:open-main"),
    onStaged: (callback: (items: Array<{ kind: "path" | "text"; value: string }>) => void) => {
      const listener = (_event: unknown, items: unknown) => {
        if (!Array.isArray(items)) return;
        const safe = items.slice(0, maxStagedItems).filter((item): item is { kind: "path" | "text"; value: string } =>
          Boolean(item) && typeof item === "object"
          && ((item as { kind?: unknown }).kind === "path" || (item as { kind?: unknown }).kind === "text")
          && typeof (item as { value?: unknown }).value === "string"
          && (item as { value: string }).value.length <= maxStagedValueLength);
        if (safe.length) callback(safe);
      };
      ipcRenderer.on("work-fold:management:staged", listener);
      return () => ipcRenderer.removeListener("work-fold:management:staged", listener);
    },
  },
  window: { material: windowMaterial },
});
