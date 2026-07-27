const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const networkChannel = "workspace:restricted-app:network";
const tabCommandChannel = "workspace:restricted-app:tabs";
const contextChannel = "workspace:restricted-app:context";
const storageChannel = "workspace:restricted-app:storage";
const storageChangedChannel = "workspace:restricted-app:storage-changed";
const filesChannel = "workspace:restricted-app:files";
const notificationsChannel = "workspace:restricted-app:notifications";
const maximumFileEnvelopeBytes = 800 * 1024;
const encoder = new TextEncoder();

function argumentValue(name: string): string {
  const prefix = `--workspace-restricted-${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return "";
  try { return decodeURIComponent(argument.slice(prefix.length)); } catch { return ""; }
}

function initialState(): unknown {
  const value = argumentValue("state");
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Host-declared runtime bounds. These are constant for the lifetime of the
 * mount, so they arrive as a launch argument and `limits.get()` stays
 * synchronous — an app should be able to consult its budget on any code path
 * without awaiting the host.
 */
function initialLimits(): unknown {
  const value = argumentValue("limits");
  if (!value) return null;
  try { return deepFreeze(JSON.parse(value)); } catch { return null; }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

const limits = initialLimits();
const networkRequestBytes = nestedPositiveInteger(limits, "network", "maxRequestBytes", 128 * 1024);
const maximumNetworkEnvelopeBytes = networkRequestBytes * 6 + 64 * 1024;
const maximumStorageEnvelopeBytes = nestedPositiveInteger(limits, "storage", "maxTransactionBytes", 160 * 1024) + 64 * 1024;

function nestedPositiveInteger(
  value: unknown,
  section: string,
  field: string,
  fallback: number,
): number {
  if (!value || typeof value !== "object") return fallback;
  const group = (value as Record<string, unknown>)[section];
  if (!group || typeof group !== "object") return fallback;
  const candidate = (group as Record<string, unknown>)[field];
  return Number.isSafeInteger(candidate) && (candidate as number) > 0 ? candidate as number : fallback;
}

function codedError(code: string, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

let context = Object.freeze({
  workspaceId: argumentValue("workspace-id"),
  appId: argumentValue("app-id"),
  digest: argumentValue("digest"),
  mountId: argumentValue("mount-id"),
  placement: argumentValue("placement") === "tab" ? "tab" as const : "navigator" as const,
  appTabId: argumentValue("app-tab-id") || null,
  route: argumentValue("route") || "/",
  state: initialState(),
  theme: argumentValue("theme") === "dark" ? "dark" as const : "light" as const,
  active: true,
});

const contextListeners = new Set<(value: typeof context) => void>();
ipcRenderer.on(contextChannel, (_event, value: Partial<typeof context>) => {
  context = Object.freeze({ ...context, ...value });
  for (const listener of contextListeners) {
    try { listener(context); } catch { /* app callback errors stay inside the app */ }
  }
});

async function invokeHost(channel: string, request: unknown, maximum: number, fallbackCode: string) {
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new Error("Restricted app request must be JSON-compatible.");
  }
  if (serialized === undefined || encoder.encode(serialized).byteLength > maximum) {
    throw new Error("Restricted app request exceeds the size limit.");
  }
  const response = await ipcRenderer.invoke(channel, serialized) as {
    ok?: unknown;
    value?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (response?.ok === true) return response.value;
  const error = new Error(typeof response?.error?.message === "string" ? response.error.message : "Restricted app request failed.");
  Object.defineProperty(error, "code", {
    value: typeof response?.error?.code === "string" ? response.error.code : fallbackCode,
    enumerable: true,
  });
  throw error;
}

const networkRequest = (request: unknown) => {
  const body = request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>).body
    : undefined;
  if (typeof body === "string" && encoder.encode(body).byteLength > networkRequestBytes) {
    return Promise.reject(codedError(
      "NETWORK_REQUEST_TOO_LARGE",
      `The network request body exceeded the ${networkRequestBytes}-byte request limit.`,
    ));
  }
  return invokeHost(networkChannel, request, maximumNetworkEnvelopeBytes, "NETWORK_FAILED");
};
const storageRequest = (operation: string, fields: Record<string, unknown> = {}) => invokeHost(storageChannel, { operation, ...fields }, maximumStorageEnvelopeBytes, "STORAGE_FAILED");
const fileRequest = (operation: string, request: unknown) => invokeHost(filesChannel, { operation, request }, maximumFileEnvelopeBytes, "FILE_FAILED");
const notificationRequest = (request: unknown) => invokeHost(notificationsChannel, request, 4 * 1024, "NOTIFICATION_FAILED");

const storageListeners = new Set<(event: { revision: number; keys: string[]; reset: boolean }) => void>();
ipcRenderer.on(storageChangedChannel, (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const candidate = value as { revision?: unknown; keys?: unknown; reset?: unknown };
  if (!Number.isSafeInteger(candidate.revision) || !Array.isArray(candidate.keys) || candidate.keys.length > 128
    || candidate.keys.some((key) => typeof key !== "string") || typeof candidate.reset !== "boolean") return;
  const event = Object.freeze({
    revision: candidate.revision as number,
    keys: Object.freeze([...(candidate.keys as string[])]) as unknown as string[],
    reset: candidate.reset,
  });
  for (const listener of storageListeners) {
    try { listener(event); } catch { /* app callback errors stay inside the app */ }
  }
});

contextBridge.exposeInMainWorld("workspaceRestrictedApp", Object.freeze({
  request: networkRequest,
  network: Object.freeze({ request: networkRequest }),
  storage: Object.freeze({
    usage: () => storageRequest("usage"),
    keys: (prefix = "") => storageRequest("keys", { prefix }),
    get: (key: string) => storageRequest("get", { key }),
    set: (key: string, value: unknown) => storageRequest("set", { key, value }),
    delete: (key: string) => storageRequest("delete", { key }),
    clear: () => storageRequest("clear"),
    transaction: (transaction: unknown) => storageRequest("transaction", { transaction }),
    onChanged: (listener: (event: { revision: number; keys: string[]; reset: boolean }) => void) => {
      if (typeof listener !== "function") throw new TypeError("Storage listener must be a function.");
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    },
  }),
  files: Object.freeze({
    list: (request: unknown) => fileRequest("list", request),
    read: (request: unknown) => fileRequest("read", request),
    write: (request: unknown) => fileRequest("write", request),
  }),
  notifications: Object.freeze({
    show: (request: { permissionId: string }) => notificationRequest(request),
  }),
  limits: Object.freeze({
    get: () => limits,
  }),
  context: Object.freeze({
    get: () => context,
    onChanged: (listener: (value: typeof context) => void) => {
      contextListeners.add(listener);
      return () => contextListeners.delete(listener);
    },
  }),
  tabs: Object.freeze({
    open: (tab: { tabId: string; title: string; route: string; state?: unknown }) => ipcRenderer.invoke(tabCommandChannel, { type: "open", ...tab }),
    update: (tab: { title: string; route: string; state?: unknown }) => ipcRenderer.invoke(tabCommandChannel, { type: "update", ...tab }),
    close: () => ipcRenderer.invoke(tabCommandChannel, { type: "close" }),
  }),
}));

if (argumentValue("mode") === "ui") {
  const blockFileAccess = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type.toLowerCase() === "file") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener("dragover", (event) => event.preventDefault(), true);
  window.addEventListener("drop", (event) => event.preventDefault(), true);
  window.addEventListener("click", blockFileAccess, true);
  window.addEventListener("keydown", blockFileAccess, true);
  window.addEventListener("DOMContentLoaded", () => {
    const disableFileInputs = () => document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => { input.disabled = true; });
    disableFileInputs();
    new MutationObserver(disableFileInputs).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["type"] });
  },
  { once: true });
}
