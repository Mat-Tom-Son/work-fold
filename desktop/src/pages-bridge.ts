/**
 * The desktop's bridge client for publishing pages (docs/pages.md,
 * "Publishing (stage 2)"): the shared device-route client over the encrypted
 * Web Access settings. Settings are read on every call, so setting Web Access
 * up, turning it off, or removing it applies to the very next publish or
 * check-in; while it isn't set up or is off, every call refuses with
 * WEB_ACCESS_REQUIRED and checking in quietly does nothing.
 */
import { createPagesBridgeClient, type WorkFoldPagesBridge } from "../../src/local/pages/page-bridge-client.js";
import type { SecureSettingsStore } from "./settings.js";

export function createDesktopPagesBridge(
  settings: Pick<SecureSettingsStore, "getRemoteAccess">,
  fetchFn: typeof fetch = fetch,
): WorkFoldPagesBridge {
  return createPagesBridgeClient({
    fetchFn,
    async getConnection() {
      const remoteAccess = await settings.getRemoteAccess();
      if (!remoteAccess) return { unavailable: "not-set-up" };
      if (!remoteAccess.enabled) return { unavailable: "turned-off" };
      return { bridgeUrl: remoteAccess.bridgeUrl, deviceToken: remoteAccess.deviceToken };
    },
  });
}
