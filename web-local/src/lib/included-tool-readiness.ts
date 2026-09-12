import type { IncludedToolStatus } from "../../../src/shared/included-tools";

/** A loaded Pi Extension is not evidence that its external tools are ready. */
export function includedToolReadiness(status: IncludedToolStatus | undefined) {
  switch (status?.state) {
    case "ready": return { label: "Ready", tone: "enabled", setup: false };
    case "setup_required": return { label: "Setup needed", tone: "", setup: true };
    case "unavailable": return { label: "Unavailable", tone: "error", setup: true };
    default: return { label: "Not checked", tone: "", setup: true };
  }
}
