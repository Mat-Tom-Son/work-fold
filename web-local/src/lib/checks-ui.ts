import type { ChecksStatus } from "../types";
import { formatItemCount } from "./format";

export interface ChecksToolbarPresentation {
  icon: "running" | "attention" | "unhealthy" | "stale" | "current";
  label: string;
  title: string;
  tone: "quiet" | "attention" | "unhealthy";
  count: number | null;
}

export function checksToolbarPresentation(status: ChecksStatus | null): ChecksToolbarPresentation | null {
  if (!status?.configured) return null;
  if (status.running > 0) {
    return {
      icon: "running",
      label: "Checking",
      title: "Checks are running over explicitly designated files",
      tone: "quiet",
      count: null,
    };
  }
  if (status.needsAttention > 0) {
    return {
      icon: "attention",
      label: "Needs attention",
      title: `${formatItemCount(status.needsAttention, "current finding")} in explicitly designated files`,
      tone: "attention",
      count: status.needsAttention,
    };
  }
  if (status.state === "blocked" || status.state === "check-error") {
    return {
      icon: "unhealthy",
      label: "Check issue",
      title: "A Check needs review; this is not a problem label on your files",
      tone: "unhealthy",
      count: null,
    };
  }
  if (status.state === "stale") {
    return {
      icon: "stale",
      label: status.neverRun ? "Run Checks" : "Refresh Checks",
      title: "Results are not current; Checks run only when requested",
      tone: "quiet",
      count: null,
    };
  }
  return {
    icon: "current",
    label: "Checks",
    title: "View the latest result for explicitly designated files",
    tone: "quiet",
    count: null,
  };
}
