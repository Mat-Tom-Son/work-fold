import type { RestrictedAppAutomationRunReceipt } from "../types.js";

export function restrictedAppAutomationOutcomeLabel(
  run: Pick<RestrictedAppAutomationRunReceipt, "outcome" | "state">,
): string {
  switch (run.outcome) {
    case "success": return "Succeeded";
    case "failure": return "Failed";
    case "skipped": return "Skipped";
    case "cancelled": return "Cancelled";
    case "interrupted": return "Interrupted — completion unknown";
  }
}
