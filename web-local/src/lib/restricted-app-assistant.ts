import { restrictedAppAssistantLimits, restrictedAppLimitSize, type RestrictedAppAssistantTask } from "../../../src/shared/restricted-app-tasks.js";

/** Person-facing status of one app-requested Assistant task. */
export function restrictedAppAssistantTaskStatusLabel(
  task: Pick<RestrictedAppAssistantTask, "status" | "cancellationRequested" | "result">,
): string {
  if (task.cancellationRequested && (task.status === "running" || task.status === "dispatching")) return "Stopping";
  switch (task.status) {
    case "dispatching": return "Starting";
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "succeeded": return task.result?.outcome === "partial" ? "Partly finished" : task.result?.outcome === "failed" ? "Couldn’t finish" : "Done";
    case "failed": return "Failed";
    case "cancelled": return "Stopped";
    case "interrupted": return "Interrupted";
  }
}

/**
 * The compact receipt line for one settled request: the model that actually ran
 * its Chat turn and what that turn used, in the same order and wording the
 * short-answer receipts use. A turn whose model carries no pricing simply has
 * no cost segment — the cost is unknown, never zero. Returns null while nothing
 * has been reported yet.
 */
export function restrictedAppAssistantTaskUsageLine(
  task: Pick<RestrictedAppAssistantTask, "model" | "usage">,
): string | null {
  const segments = [
    task.model ? `${task.model.provider} · ${task.model.id}` : null,
    task.usage ? `${task.usage.inputTokens} in · ${task.usage.outputTokens} out` : null,
    task.usage && typeof task.usage.amountUsd === "number"
      ? `$${task.usage.amountUsd.toFixed(task.usage.amountUsd >= 1 ? 2 : 4)}`
      : null,
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length ? segments.join(" · ") : null;
}

/** Stop is offered while the task is starting or running and no stop was requested yet. */
export function restrictedAppAssistantTaskCanStop(
  task: Pick<RestrictedAppAssistantTask, "status" | "cancellationRequested">,
): boolean {
  return (task.status === "running" || task.status === "dispatching" || task.status === "waiting") && !task.cancellationRequested;
}
/**
 * A trimmed result names its fixed bound and the Settings row showing it.
 *
 * `truncated` covers two bounds, and the ordinary one is the summary: every
 * reply is cut at `summaryBytes` before the envelope ceiling is ever
 * consulted, so naming only the envelope ceiling sent the reader to the wrong
 * row. Both numbers are named, in the same spelling as the rows in Settings →
 * Automations → Limits ("A result summary", "Chat result returned to the app").
 */
export const restrictedAppAssistantResultTrimNote =
  `\n… Trimmed to the ${restrictedAppLimitSize(restrictedAppAssistantLimits.summaryBytes)} summary limit in Settings → Automations → Limits.`
  + ` Details over the ${restrictedAppLimitSize(restrictedAppAssistantLimits.resultBytes)} result limit are left out there too.`
  + " Open Chat for the full reply.";

/** Compact size for one deliverable a result named. */
export function restrictedAppResultFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
