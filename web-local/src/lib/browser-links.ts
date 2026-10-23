/**
 * Links that open in the built-in browser (docs/built-in-browser.md). A link
 * to a server on this computer, such as the dev server a Worker started,
 * opens as a browser tab instead of in the default browser.
 */

/** Asks the open work-folder view to open a browser tab at an address. */
export const openBrowserTabEvent = "work-fold:open-browser-tab";

export interface OpenBrowserTabRequest {
  url: string;
}

/** The address of a server on this computer, or null for anything else. */
export function localServerHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0";
    if (!local) return null;
    if (host === "0.0.0.0") url.hostname = "localhost";
    return url.toString();
  } catch {
    return null;
  }
}

export function browserTabsAvailable(): boolean {
  return Boolean(window.workFoldDesktop?.browser);
}

export function requestBrowserTab(url: string): void {
  window.dispatchEvent(new CustomEvent<OpenBrowserTabRequest>(openBrowserTabEvent, { detail: { url } }));
}
