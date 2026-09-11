const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const networkChannel = "work-fold:restricted-app:network";
const tabCommandChannel = "work-fold:restricted-app:tabs";
const contextChannel = "work-fold:restricted-app:context";
const storageChannel = "work-fold:restricted-app:storage";
const storageChangedChannel = "work-fold:restricted-app:storage-changed";
const tasksChangedChannel = "work-fold:restricted-app:tasks-changed";
const checksChangedChannel = "work-fold:restricted-app:checks-changed";
const filesChangedChannel = "work-fold:restricted-app:files-changed";
const filesSubscriptionChannel = "work-fold:restricted-app:files-subscribe";
const checksChannel = "work-fold:restricted-app:checks";
const assistantTasksChannel = "work-fold:restricted-app:assistant-tasks";
const assistantInferChannel = "work-fold:restricted-app:assistant-infer";
const filesChannel = "work-fold:restricted-app:files";
const notificationsChannel = "work-fold:restricted-app:notifications";
const maximumFileEnvelopeBytes = 800 * 1024;
const encoder = new TextEncoder();

function argumentValue(name: string): string {
  const prefix = `--work-fold-restricted-${name}=`;
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
// JSON escaping can expand one byte into six, so both Assistant envelopes
// leave that headroom over the published input bound.
const maximumAssistantEnvelopeBytes = nestedPositiveInteger(limits, "assistant", "inputBytes", 64 * 1024) * 6 + 64 * 1024;
const maximumInferEnvelopeBytes = nestedPositiveInteger(limits, "inference", "inputBytes", 256 * 1024) * 6 + 128 * 1024;

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
  spaceId: argumentValue("space-id"),
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

/**
 * The three owned-id change hints (docs/collaboration-contract.md, F30). A
 * hint carries ids and an ordering revision, never content: the app re-reads
 * through the lane it already has. Every payload is validated here so a
 * malformed push reaches no app callback, and every callback failure stays
 * inside the app.
 */
type TasksChangedEvent = { revision: number; taskIds: string[]; receiptIds: string[] };
type ChecksChangedEvent = { revision: number; permissionIds: string[] };
type FilesChangedEvent = { revision: number; permissionIds: string[]; truncated: boolean };

function boundedIdList(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  if (value.some((item) => typeof item !== "string" || !item.length)) return null;
  return [...(value as string[])];
}

const tasksListeners = new Set<(event: TasksChangedEvent) => void>();
ipcRenderer.on(tasksChangedChannel, (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const candidate = value as { revision?: unknown; taskIds?: unknown; receiptIds?: unknown };
  if (!Number.isSafeInteger(candidate.revision)) return;
  const taskIds = boundedIdList(candidate.taskIds, 64);
  const receiptIds = boundedIdList(candidate.receiptIds, 64);
  if (!taskIds || !receiptIds) return;
  const event = Object.freeze({
    revision: candidate.revision as number,
    taskIds: Object.freeze(taskIds) as unknown as string[],
    receiptIds: Object.freeze(receiptIds) as unknown as string[],
  });
  for (const listener of tasksListeners) {
    try { listener(event); } catch { /* app callback errors stay inside the app */ }
  }
});

const checksChangedListeners = new Set<(event: ChecksChangedEvent) => void>();
ipcRenderer.on(checksChangedChannel, (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const candidate = value as { revision?: unknown; permissionIds?: unknown };
  if (!Number.isSafeInteger(candidate.revision)) return;
  const permissionIds = boundedIdList(candidate.permissionIds, 8);
  if (!permissionIds) return;
  const event = Object.freeze({
    revision: candidate.revision as number,
    permissionIds: Object.freeze(permissionIds) as unknown as string[],
  });
  for (const listener of checksChangedListeners) {
    try { listener(event); } catch { /* app callback errors stay inside the app */ }
  }
});

const filesChangedListeners = new Set<(event: FilesChangedEvent) => void>();

/**
 * Tells the host whether this app is listening for granted-root changes.
 * Registration is preload-local, so without this notice the host cannot tell
 * a subscribing app from one that never called `files.onChanged` — and a
 * directory permission binds to the whole Space, so it would walk that Space
 * on every poll for the life of the view. Sent only when the answer changes.
 */
let filesSubscribed = false;
function noteFilesSubscription(): void {
  const subscribed = filesChangedListeners.size > 0;
  if (subscribed === filesSubscribed) return;
  filesSubscribed = subscribed;
  try {
    ipcRenderer.send(filesSubscriptionChannel, { subscribed });
  } catch {
    // The host is gone; the watch it would have kept is gone with it.
  }
}
ipcRenderer.on(filesChangedChannel, (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const candidate = value as { revision?: unknown; permissionIds?: unknown; truncated?: unknown };
  if (!Number.isSafeInteger(candidate.revision) || typeof candidate.truncated !== "boolean") return;
  const permissionIds = boundedIdList(candidate.permissionIds, 16);
  if (!permissionIds) return;
  const event = Object.freeze({
    revision: candidate.revision as number,
    permissionIds: Object.freeze(permissionIds) as unknown as string[],
    truncated: candidate.truncated,
  });
  for (const listener of filesChangedListeners) {
    try { listener(event); } catch { /* app callback errors stay inside the app */ }
  }
});

const appBridge = Object.freeze({
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
  checks: Object.freeze({
    read: (request: { permissionId: string }) => invokeHost(checksChannel, request, 1024, "CHECK_UNAVAILABLE"),
    onChanged: (listener: (event: ChecksChangedEvent) => void) => {
      if (typeof listener !== "function") throw new TypeError("Check listener must be a function.");
      checksChangedListeners.add(listener);
      return () => checksChangedListeners.delete(listener);
    },
  }),
  tasks: Object.freeze({
    onChanged: (listener: (event: TasksChangedEvent) => void) => {
      if (typeof listener !== "function") throw new TypeError("Assistant task listener must be a function.");
      tasksListeners.add(listener);
      return () => tasksListeners.delete(listener);
    },
  }),
  assistant: Object.freeze({
    request: (request: unknown) => invokeHost(assistantTasksChannel, { operation: "request", request }, maximumAssistantEnvelopeBytes, "TASK_UNAVAILABLE"),
    list: () => invokeHost(assistantTasksChannel, { operation: "list" }, 1024, "TASK_UNAVAILABLE"),
    get: (requestId: string) => invokeHost(assistantTasksChannel, { operation: "get", requestId }, 1024, "TASK_UNAVAILABLE"),
    cancel: (requestId: string) => invokeHost(assistantTasksChannel, { operation: "cancel", requestId }, 1024, "TASK_UNAVAILABLE"),
    infer: (request: unknown) => invokeHost(assistantInferChannel, { request }, maximumInferEnvelopeBytes, "INFER_UNAVAILABLE"),
  }),
  files: Object.freeze({
    list: (request: unknown) => fileRequest("list", request),
    read: (request: unknown) => fileRequest("read", request),
    write: (request: unknown) => fileRequest("write", request),
    onChanged: (listener: (event: FilesChangedEvent) => void) => {
      if (typeof listener !== "function") throw new TypeError("File listener must be a function.");
      filesChangedListeners.add(listener);
      noteFilesSubscription();
      return () => {
        filesChangedListeners.delete(listener);
        noteFilesSubscription();
      };
    },
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
});

// Error custom properties do not survive Electron's context bridge. Carry a
// plain outcome across it, then construct the public Error in the app world.
// No raw IPC function or transport object is installed on window.
const synchronousBridgePaths = [
  "context.get", "context.onChanged", "limits.get", "storage.onChanged",
  // Registrations return an unsubscribe function, not a promise, so they must
  // cross the bridge unwrapped exactly as `storage.onChanged` does.
  "tasks.onChanged", "checks.onChanged", "files.onChanged",
];
// A TypeError thrown on this side of the bridge reaches the app as a plain
// Error, so the listener registrations re-check their argument in the app
// world and throw the app world's own TypeError. The checks above remain the
// last line for anything that reaches them another way.
const listenerRegistrationMessages: Record<string, string> = {
  "storage.onChanged": "Storage listener must be a function.",
  "tasks.onChanged": "Assistant task listener must be a function.",
  "checks.onChanged": "Check listener must be a function.",
  "files.onChanged": "File listener must be a function.",
};
function bridgeTransport(value: unknown, path = ""): unknown {
  if (typeof value === "function") {
    if (synchronousBridgePaths.includes(path)) return value;
    return async (...args: unknown[]) => {
      try { return { ok: true, value: await value(...args) }; }
      catch (caught) {
        const error = caught as { code?: unknown; message?: unknown } | null;
        return { ok: false, error: { code: typeof error?.code === "string" ? error.code : "APP_ERROR", message: typeof error?.message === "string" ? error.message : "App request failed." } };
      }
    };
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, bridgeTransport(item, path ? `${path}.${key}` : key)]));
}
contextBridge.executeInMainWorld({
  args: [bridgeTransport(appBridge), synchronousBridgePaths, listenerRegistrationMessages],
  func: (transport: Record<string, unknown>, synchronous: string[], registrations: Record<string, string>) => {
    const ErrorConstructor = Error;
    const TypeErrorConstructor = TypeError;
    const defineProperty = Object.defineProperty;
    const freeze = Object.freeze;
    const sync = new Set(synchronous);
    const rebuild = (value: unknown, path = ""): unknown => {
      if (typeof value === "function") {
        if (sync.has(path)) {
          const registrationMessage = registrations[path];
          if (registrationMessage === undefined) return value;
          return (listener: unknown) => {
            if (typeof listener !== "function") throw new TypeErrorConstructor(registrationMessage);
            return value(listener);
          };
        }
        return async (...args: unknown[]) => {
          const outcome = await value(...args);
          if (outcome.ok) return outcome.value;
          const error = new ErrorConstructor(outcome.error.message);
          defineProperty(error, "code", { value: outcome.error.code, enumerable: true });
          throw error;
        };
      }
      return freeze(Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rebuild(item, path ? `${path}.${key}` : key)])));
    };
    defineProperty(globalThis, "workFoldRestrictedApp", { value: rebuild(transport), writable: false, configurable: false });
  },
});

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
