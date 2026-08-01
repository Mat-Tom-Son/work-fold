import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

export interface PiExtensionUiScope {
  conversationId: string;
  spaceRoot: string;
}

export type PiExtensionUiRequest = PiExtensionUiScope & {
  id: string;
  method: "select";
  title: string;
  options: string[];
  timeout?: number;
} | PiExtensionUiScope & {
  id: string;
  method: "confirm";
  title: string;
  message: string;
  timeout?: number;
} | PiExtensionUiScope & {
  id: string;
  method: "input";
  title: string;
  placeholder?: string;
  secret?: boolean;
  timeout?: number;
} | PiExtensionUiScope & {
  id: string;
  method: "editor";
  title: string;
  prefill?: string;
};

export type PiExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface PiExtensionUiSettled {
  id: string;
  response: PiExtensionUiResponse;
}

type StripUiEnvelope<T> = T extends unknown
  ? Omit<T, keyof PiExtensionUiScope | "id">
  : never;

export type PiExtensionUiEvent = PiExtensionUiScope & {
  id: string;
  method: "notify";
  message: string;
  notifyType?: "info" | "warning" | "error";
} | PiExtensionUiScope & {
  id: string;
  method: "setStatus";
  key: string;
  text?: string;
} | PiExtensionUiScope & {
  id: string;
  method: "setWorkingMessage";
  message?: string;
} | PiExtensionUiScope & {
  id: string;
  method: "setWorkingVisible";
  visible: boolean;
} | PiExtensionUiScope & {
  id: string;
  method: "setWorkingIndicator";
  options?: WorkingIndicatorOptions;
} | PiExtensionUiScope & {
  id: string;
  method: "setHiddenThinkingLabel";
  label?: string;
} | PiExtensionUiScope & {
  id: string;
  method: "setWidget";
  key: string;
  lines?: string[];
  placement?: "aboveEditor" | "belowEditor";
} | PiExtensionUiScope & {
  id: string;
  method: "setTitle";
  title: string;
} | PiExtensionUiScope & {
  id: string;
  method: "setEditorText" | "pasteToEditor";
  text: string;
} | PiExtensionUiScope & {
  id: string;
  method: "openExternal";
  url: string;
  instructions?: string;
} | PiExtensionUiScope & {
  id: string;
  method: "oauthDeviceCode";
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
} | PiExtensionUiScope & {
  id: string;
  method: "copyText";
  text: string;
} | PiExtensionUiScope & {
  id: string;
  method: "openSettings" | "quit";
} | PiExtensionUiScope & {
  id: string;
  method: "unsupported";
  feature: string;
};

export type PiExtensionUiRequestPayload = StripUiEnvelope<PiExtensionUiRequest>;
export type PiExtensionUiEventPayload = StripUiEnvelope<PiExtensionUiEvent>;

/** Renderer/Electron adapter for Pi extension UI primitives. */
export interface PiExtensionUiBridge {
  request(request: PiExtensionUiRequest): Promise<PiExtensionUiResponse>;
  publish(event: PiExtensionUiEvent): void;
  getEditorText?(): string;
  cancel?(id: string): boolean;
}

/**
 * Shared request router for HTTP/SSE or Electron IPC hosts. Listen for
 * `request` and `event`; feed dialog answers back through respond().
 */
export class RoutedPiExtensionUiBridge extends EventEmitter implements PiExtensionUiBridge {
  private readonly pending = new Map<string, {
    resolve: (response: PiExtensionUiResponse) => void;
    timeout?: NodeJS.Timeout;
  }>();
  private editorText = "";

  request(request: PiExtensionUiRequest): Promise<PiExtensionUiResponse> {
    return new Promise((resolve) => {
      const timeout = "timeout" in request && request.timeout && request.timeout > 0
        ? setTimeout(() => this.respond(request.id, { cancelled: true }), request.timeout)
        : undefined;
      this.pending.set(request.id, { resolve, ...(timeout ? { timeout } : {}) });
      this.emit("request", request);
    });
  }

  publish(event: PiExtensionUiEvent): void {
    if (event.method === "setEditorText") {
      this.editorText = event.text;
    } else if (event.method === "pasteToEditor") {
      this.editorText += event.text;
    }
    this.emit("event", event);
  }

  getEditorText(): string {
    return this.editorText;
  }

  setEditorText(value: string): void {
    this.editorText = value;
  }

  respond(id: string, response: PiExtensionUiResponse): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.resolve(response);
    this.emit("settled", { id, response } satisfies PiExtensionUiSettled);
    return true;
  }

  cancel(id: string): boolean {
    return this.respond(id, { cancelled: true });
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}

export function publishExtensionUiEvent(
  bridge: PiExtensionUiBridge,
  scope: PiExtensionUiScope,
  event: PiExtensionUiEventPayload,
): void {
  bridge.publish({ ...scope, id: randomUUID(), ...event } as PiExtensionUiEvent);
}

export function createHeadlessExtensionUiBridge(): PiExtensionUiBridge {
  return {
    async request() {
      return { cancelled: true };
    },
    publish() {
      // Headless hosts intentionally ignore fire-and-forget UI events.
    },
  };
}

/**
 * Adapts Pi's TUI-shaped extension API to serializable renderer requests.
 * Terminal component factories cannot cross the process boundary; those are
 * reported as unsupported while dialog, notification, status, widget, title,
 * and editor-text primitives remain available.
 */
export function createExtensionUiContext(
  bridge: PiExtensionUiBridge,
  scope: PiExtensionUiScope,
): ExtensionUIContext {
  const publish = (event: PiExtensionUiEventPayload) => {
    publishExtensionUiEvent(bridge, scope, event);
  };
  const request = async (
    value: PiExtensionUiRequestPayload,
    options?: ExtensionUIDialogOptions,
  ): Promise<PiExtensionUiResponse> => {
    if (options?.signal?.aborted) return { cancelled: true };
    const id = randomUUID();
    return new Promise<PiExtensionUiResponse>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const onAbort = () => {
        bridge.cancel?.(id);
        finish({ cancelled: true });
      };
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (response: PiExtensionUiResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      if (options?.signal) options.signal.addEventListener("abort", onAbort, { once: true });
      if (options?.timeout && options.timeout > 0) {
        timeout = setTimeout(onAbort, options.timeout);
      }
      bridge.request({ ...scope, id, ...value } as PiExtensionUiRequest).then(finish, (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  };

  return {
    async select(title, options, dialogOptions) {
      const response = await request({ method: "select", title, options, timeout: dialogOptions?.timeout }, dialogOptions);
      return "value" in response && options.includes(response.value) ? response.value : undefined;
    },
    async confirm(title, message, dialogOptions) {
      const response = await request({ method: "confirm", title, message, timeout: dialogOptions?.timeout }, dialogOptions);
      return "confirmed" in response ? response.confirmed : false;
    },
    async input(title, placeholder, dialogOptions) {
      const response = await request({ method: "input", title, placeholder, timeout: dialogOptions?.timeout }, dialogOptions);
      return "value" in response ? response.value : undefined;
    },
    notify(message, type) {
      publish({ method: "notify", message, notifyType: type });
    },
    onTerminalInput() {
      return () => undefined;
    },
    setStatus(key, text) {
      publish({ method: "setStatus", key, text });
    },
    setWorkingMessage(message) {
      publish({ method: "setWorkingMessage", message });
    },
    setWorkingVisible(visible) {
      publish({ method: "setWorkingVisible", visible });
    },
    setWorkingIndicator(options) {
      publish({ method: "setWorkingIndicator", options });
    },
    setHiddenThinkingLabel(label) {
      publish({ method: "setHiddenThinkingLabel", label });
    },
    setWidget(key, content, options) {
      if (content === undefined || Array.isArray(content)) {
        publish({ method: "setWidget", key, lines: content, placement: options?.placement });
      } else {
        publish({ method: "unsupported", feature: `component widget: ${key}` });
      }
    },
    setFooter() {
      publish({ method: "unsupported", feature: "custom footer" });
    },
    setHeader() {
      publish({ method: "unsupported", feature: "custom header" });
    },
    setTitle(title) {
      publish({ method: "setTitle", title });
    },
    async custom() {
      publish({ method: "unsupported", feature: "custom terminal component" });
      return undefined as never;
    },
    pasteToEditor(text) {
      publish({ method: "pasteToEditor", text });
    },
    setEditorText(text) {
      publish({ method: "setEditorText", text });
    },
    getEditorText() {
      return bridge.getEditorText?.() ?? "";
    },
    async editor(title, prefill) {
      const response = await request({ method: "editor", title, prefill });
      return "value" in response ? response.value : undefined;
    },
    addAutocompleteProvider() {
      publish({ method: "unsupported", feature: "autocomplete provider" });
    },
    setEditorComponent() {
      publish({ method: "unsupported", feature: "custom editor component" });
    },
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return neutralTheme as unknown as ExtensionUIContext["theme"];
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Theme switching is controlled by the work-fold renderer." };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {
      // The renderer owns tool-card expansion.
    },
  };
}

const plain = (_kind: unknown, text: string) => text;
const decorate = (text: string) => text;
const neutralTheme = {
  fg: plain,
  bg: plain,
  bold: decorate,
  italic: decorate,
  underline: decorate,
  inverse: decorate,
  strikethrough: decorate,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => decorate,
  getBashModeBorderColor: () => decorate,
};
