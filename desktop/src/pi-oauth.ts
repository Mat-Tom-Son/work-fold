import type { PiOAuthHooks } from "../../src/local/agent/pi-runtime-config.js";

export interface DesktopOAuthMessageBoxOptions {
  type?: "none" | "info" | "error" | "question" | "warning";
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  title: string;
  message: string;
  detail?: string;
  noLink?: boolean;
  signal?: AbortSignal;
}

export interface DesktopPiOAuthHost {
  openExternal(url: string): Promise<void> | void;
  readClipboard(): string;
  writeClipboard(value: string): void;
  showMessageBox(options: DesktopOAuthMessageBoxOptions): Promise<{ response: number }>;
  onProgress?(message: string): void;
  onError?(error: unknown): void;
}

/**
 * Adapts Pi's provider-neutral OAuth callbacks to desktop-safe primitives.
 *
 * Browser callbacks complete automatically when a provider supports them.
 * Providers that return a code in the browser use an explicit
 * "Paste from clipboard" action so work-fold never reads clipboard contents
 * without a contemporaneous user gesture.
 */
export function createDesktopPiOAuthHooks(host: DesktopPiOAuthHost): PiOAuthHooks {
  return {
    async openUrl(info) {
      await host.openExternal(info.url);
    },
    showDeviceCode(info) {
      host.writeClipboard(info.userCode);
      void host.showMessageBox({
        type: "info",
        title: "Complete Provider Sign-In",
        message: `Enter this code in your browser:\n\n${info.userCode}`,
        detail: "work-fold copied the code to your clipboard and opened the provider's verification page.",
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).catch((error) => host.onError?.(error));
    },
    prompt(input) {
      return promptFromClipboard(host, input);
    },
    manualCodeInput(signal, input) {
      return promptFromClipboard(host, {
        message: input?.message ?? "Paste the OAuth redirect URL or authorization code",
        placeholder: input?.placeholder ?? "Redirect URL or authorization code", signal,
      });
    },
    async select(input) {
      input.signal?.throwIfAborted();
      if (input.options.length === 0) return undefined;
      const cancelId = input.options.length;
      const result = await host.showMessageBox({
        type: "question",
        title: "Choose Sign-In Method",
        message: input.message,
        detail: input.options.filter((option) => option.description).map((option) => `${option.label}: ${option.description}`).join("\n") || undefined,
        buttons: [...input.options.map((option) => option.label), "Cancel"],
        defaultId: 0,
        cancelId,
        noLink: true,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      return result.response === cancelId ? undefined : input.options[result.response]?.id;
    },
    progress(message) {
      host.onProgress?.(message);
    },
    async info(input) {
      await host.showMessageBox({
        type: "info", title: "Provider Setup", message: input.message,
        detail: input.links?.map((link) => `${link.label ?? "Learn more"}: ${link.url}`).join("\n"),
        buttons: ["Continue"], defaultId: 0, cancelId: 0, noLink: true,
      });
    },
  };
}

async function promptFromClipboard(
  host: DesktopPiOAuthHost,
  input: { message: string; placeholder?: string; allowEmpty?: boolean; signal?: AbortSignal },
): Promise<string> {
  while (true) {
    input.signal?.throwIfAborted();
    const useDefaultId = input.allowEmpty ? 1 : -1;
    const cancelId = input.allowEmpty ? 2 : 1;
    const result = await host.showMessageBox({
      type: "question",
      title: "Complete Provider Sign-In",
      message: input.message,
      detail: input.placeholder
        ? `Copy the requested value from your browser, then choose Paste from Clipboard.\n\nExpected: ${input.placeholder}`
        : "Copy the requested value, then choose Paste from Clipboard.",
      buttons: [
        "Paste from Clipboard",
        ...(input.allowEmpty ? ["Use Default"] : []),
        "Cancel",
      ],
      defaultId: 0,
      cancelId,
      noLink: true,
      signal: input.signal,
    });

    input.signal?.throwIfAborted();
    if (result.response === cancelId) throw new Error("Provider sign-in cancelled.");
    if (result.response === useDefaultId) return "";

    const value = host.readClipboard().trim();
    if (value || input.allowEmpty) return value;

    await host.showMessageBox({
      type: "warning",
      title: "Nothing to Paste",
      message: "Copy the authorization code or requested value from your browser, then try again.",
      buttons: ["Try Again"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }
}
