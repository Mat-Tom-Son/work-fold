import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent, WebContents } from "electron";

export interface ModelContextDiagnosticRequest {
  path: string;
  method: "GET" | "POST";
  body?: { enabled: boolean } | { clear: true };
}

/** Only the existing diagnostic routes are reachable through this preload. */
export function parseModelContextDiagnosticRequest(value: unknown): ModelContextDiagnosticRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid diagnostic request.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "path" && key !== "body")
    || typeof input.path !== "string" || input.path.length > 2048
    || !/^\/api\/model-context(?:\/[a-zA-Z0-9_-]+)?(?:\?[^#]*)?$/.test(input.path)) {
    throw new Error("Invalid diagnostic path.");
  }
  const url = new URL(input.path, "http://diagnostics.local");
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "spaceId" && key !== "conversationId")
    || new Set(keys).size !== keys.length
    || keys.some((key) => !url.searchParams.get(key) || url.searchParams.get(key)!.length > 256)
    || (url.searchParams.has("conversationId") && !url.searchParams.has("spaceId"))) {
    throw new Error("Invalid diagnostic scope.");
  }
  if (input.body === undefined) return { path: input.path, method: "GET" };
  const body = input.body;
  if (url.pathname !== "/api/model-context" || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid diagnostic change.");
  }
  const fields = body as Record<string, unknown>;
  const fieldsKeys = Object.keys(fields);
  if (fieldsKeys.length === 1 && fieldsKeys[0] === "enabled" && typeof fields.enabled === "boolean") {
    return { path: input.path, method: "POST", body: { enabled: fields.enabled } };
  }
  if (fieldsKeys.length === 1 && fieldsKeys[0] === "clear" && fields.clear === true) {
    return { path: input.path, method: "POST", body: { clear: true } };
  }
  throw new Error("Invalid diagnostic change.");
}

interface Options {
  url: string;
  preload: string;
  title?: string;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  request: (request: ModelContextDiagnosticRequest) => Promise<unknown>;
}

/** A separate developer surface with no settings, shell, or session-token IPC. */
export class ModelContextWindow {
  #window: BrowserWindow | null = null;
  #opening: Promise<void> | null = null;
  readonly #options: Options;

  constructor(options: Options) { this.#options = options; }

  owns(sender: WebContents): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.webContents === sender);
  }

  assertSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): void {
    const frame = event.senderFrame;
    const mainFrame = event.sender.mainFrame;
    if (!this.owns(event.sender) || !frame || frame.processId !== mainFrame.processId
      || frame.routingId !== mainFrame.routingId || frame.url !== this.#options.url) {
      throw new Error("The developer inspector requires its own trusted main frame.");
    }
  }

  async request(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, input: unknown): Promise<unknown> {
    this.assertSender(event);
    return this.#options.request(parseModelContextDiagnosticRequest(input));
  }

  closeFrom(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): void {
    this.assertSender(event);
    this.#window?.close();
  }

  handleMenuCommand(command: string): boolean {
    const window = this.#window;
    if (!window || window.isDestroyed() || !window.isFocused()) return false;
    if (command === "close-tab") { window.close(); return true; }
    if (command === "reload-space-state") { window.webContents.reload(); return true; }
    return false;
  }

  dispose(): void { this.#window?.destroy(); this.#window = null; }

  async open(): Promise<void> {
    if (this.#opening) return this.#opening;
    if (this.#window && !this.#window.isDestroyed()) {
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show();
      this.#window.focus();
      return;
    }
    const window = this.#options.createWindow({
      title: this.#options.title ?? "Inspect context",
      width: 1120, height: 820, minWidth: 680, minHeight: 480, show: false,
      webPreferences: {
        preload: this.#options.preload,
        contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false,
      },
    });
    this.#window = window;
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const preventNavigation = (event: { preventDefault(): void }, url: string) => {
      if (url !== this.#options.url) event.preventDefault();
    };
    window.webContents.on("will-navigate", preventNavigation);
    window.webContents.on("will-redirect", preventNavigation);
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.alt || !(input.meta || (process.platform !== "darwin" && input.control))) return;
      const key = input.key.toLowerCase();
      // The app menu normally directs these shortcuts to the main Space.
      // They must also work here when no Space is open and its menu is disabled.
      if ((key === "w" || key === "r") && this.handleMenuCommand(key === "w" ? "close-tab" : "reload-space-state")) {
        event.preventDefault();
      }
    });
    window.on("closed", () => { if (this.#window === window) this.#window = null; });
    this.#opening = window.loadURL(this.#options.url).then(() => {
      if (!window.isDestroyed()) { window.show(); window.focus(); }
    }).catch((error: unknown) => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }).finally(() => { this.#opening = null; });
    return this.#opening;
  }
}
