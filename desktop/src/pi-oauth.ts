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
 * "Paste from clipboard" action so Workspace never reads clipboard contents
 * without a contemporaneous user gesture.
 */
export function createDesktopPiOAuthHooks(host: DesktopPiOAuthHost): PiOAuthHooks {
  return {
    openUrl(info) {
      void Promise.resolve(host.openExternal(info.url)).catch((error) => host.onError?.(error));
    },
    showDeviceCode(info) {
      host.writeClipboard(info.userCode);
      void host.showMessageBox({
        type: "info",
        title: "Complete provider sign-in",
        message: `Enter this code in your browser:\n\n${info.userCode}`,
        detail: "Workspace copied the code to your clipboard and opened the provider's verification page.",
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).catch((error) => host.onError?.(error));
    },
    prompt(input) {
      return promptFromClipboard(host, input);
    },
    manualCodeInput() {
      return promptFromClipboard(host, {
        message: "Paste the OAuth redirect URL or authorization code",
        placeholder: "Redirect URL or authorization code",
      });
    },
    async select(input) {
      if (input.options.length === 0) return undefined;
      const cancelId = input.options.length;
      const result = await host.showMessageBox({
        type: "question",
        title: "Choose sign-in method",
        message: input.message,
        buttons: [...input.options.map((option) => option.label), "Cancel"],
        defaultId: 0,
        cancelId,
        noLink: true,
      });
      return result.response === cancelId ? undefined : input.options[result.response]?.id;
    },
    progress(message) {
      host.onProgress?.(message);
    },
  };
}

async function promptFromClipboard(
  host: DesktopPiOAuthHost,
  input: { message: string; placeholder?: string; allowEmpty?: boolean },
): Promise<string> {
  while (true) {
    const useDefaultId = input.allowEmpty ? 1 : -1;
    const cancelId = input.allowEmpty ? 2 : 1;
    const result = await host.showMessageBox({
      type: "question",
      title: "Complete provider sign-in",
      message: input.message,
      detail: input.placeholder
        ? `Copy the requested value from your browser, then choose Paste from clipboard.\n\nExpected: ${input.placeholder}`
        : "Copy the requested value from your browser, then choose Paste from clipboard.",
      buttons: [
        "Paste from clipboard",
        ...(input.allowEmpty ? ["Use default"] : []),
        "Cancel",
      ],
      defaultId: 0,
      cancelId,
      noLink: true,
    });

    if (result.response === cancelId) throw new Error("Provider sign-in cancelled.");
    if (result.response === useDefaultId) return "";

    const value = host.readClipboard().trim();
    if (value || input.allowEmpty) return value;

    await host.showMessageBox({
      type: "warning",
      title: "Nothing to paste",
      message: "Copy the authorization code or requested value from your browser, then try again.",
      buttons: ["Try again"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }
}
