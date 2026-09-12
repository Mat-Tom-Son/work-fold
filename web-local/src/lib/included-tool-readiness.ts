import type { IncludedToolStatus } from "../../../src/shared/included-tools";
import type { ChromeConnectionState } from "../../../src/shared/chrome-connection";

export function chromeConnectionReadiness(state: ChromeConnectionState | undefined) {
  const labels: Record<ChromeConnectionState, string> = {
    not_connected: "Not connected", connecting: "Connecting…", connected: "Connected",
    app_not_running: "work-fold is closed", native_host_missing: "Setup needed", update_app: "Update work-fold",
    update_extension: "Update Chrome extension", profile_conflict: "Another profile is connected", busy: "Chrome is in use",
    store_unavailable: "Chrome extension unavailable", connection_error: "Not connected",
  };
  return { label: state ? labels[state] : "Not checked", tone: state === "connected" ? "enabled" : state === "connection_error" ? "error" : "", setup: !["connected", "store_unavailable"].includes(state ?? "") };
}

/** A loaded Pi Extension is not evidence that its external tools are ready. */
export function includedToolReadiness(status: IncludedToolStatus | undefined) {
  if (status?.id === "chrome") return chromeConnectionReadiness(status.chrome?.state);
  switch (status?.state) {
    case "ready": return { label: "Ready", tone: "enabled", setup: false };
    case "setup_required": return { label: "Setup needed", tone: "", setup: true };
    case "unavailable": return { label: "Unavailable", tone: "error", setup: true };
    default: return { label: "Not checked", tone: "", setup: true };
  }
}
