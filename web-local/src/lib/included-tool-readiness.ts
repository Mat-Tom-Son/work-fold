import type { IncludedToolStatus } from "../../../src/shared/included-tools";
import type { ChromeConnectionState, ChromeConnectionSummary } from "../../../src/shared/chrome-connection";

export function chromeConnectionReadiness(state: ChromeConnectionState | undefined, hasSelection = false, problem?: ChromeConnectionSummary["problem"]) {
  const labels: Record<ChromeConnectionState, string> = {
    not_connected: "Not Connected", connecting: "Connecting…", connected: "Connected",
    app_not_running: "work-fold is closed", native_host_missing: "Setup Needed", update_app: "Update work-fold",
    update_extension: "Update Chrome Extension", profile_conflict: "Another profile is connected", busy: "Chrome is in use",
    store_unavailable: "Chrome Extension Unavailable", connection_error: "Not Connected",
  };
  // Setup is offered only for a known state a person can fix; an unchecked,
  // transient, or unfixable state never asks for setup.
  const setup = problem === "native_host_unavailable" || !(hasSelection && ["not_connected", "connection_error"].includes(state ?? "")) && Boolean(state) && !["connected", "connecting", "busy", "store_unavailable"].includes(state ?? "");
  return { label: problem === "native_host_unavailable" ? "Setup Needed" : state ? labels[state] : "Not Checked", tone: state === "connected" ? "enabled" : state === "connection_error" ? "error" : "", setup };
}

/** A loaded Pi Extension is not evidence that its external tools are ready. */
export function includedToolReadiness(status: IncludedToolStatus | undefined) {
  if (status?.id === "chrome") {
    if (status.stale && status.chrome?.state === "connected") return { label: "Last Connected", tone: "", setup: false };
    return chromeConnectionReadiness(status.chrome?.state, status.chrome?.hasSelection, status.chrome?.problem);
  }
  if (status?.id === "mcp" && status.facts?.connections !== undefined) return { label: status.facts.connections === "0" ? "No Connections" : "Configured", tone: "", setup: status.facts.connections === "0" };
  if (status?.stale && status.state === "ready") return { label: "Last Check Passed", tone: "", setup: false };
  switch (status?.state) {
    case "ready": return { label: "Ready", tone: "enabled", setup: false };
    case "setup_required": return { label: "Setup Needed", tone: "", setup: true };
    case "unavailable": return { label: "Unavailable", tone: "error", setup: true };
    default: return { label: "Not Checked", tone: "", setup: false };
  }
}
