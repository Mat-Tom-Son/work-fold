import { restrictedAppAssistantLimits, type RestrictedAppAssistantTask, type RestrictedAppResultOutcome } from "../../../src/shared/restricted-app-tasks.js";

/** Person-facing status of one app-requested Assistant task. */
export function restrictedAppAssistantTaskStatusLabel(
  task: Pick<RestrictedAppAssistantTask, "status" | "cancellationRequested">,
): string {
  if (task.cancellationRequested && (task.status === "running" || task.status === "dispatching")) return "Stopping";
  switch (task.status) {
    case "dispatching": return "Starting";
    case "running": return "Running";
    case "succeeded": return "Done";
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
  return (task.status === "running" || task.status === "dispatching") && !task.cancellationRequested;
}

/**
 * The badge beside the status when the Assistant said the work did not fully
 * land. A result that succeeded needs no extra word; the status already says
 * Done.
 */
export function restrictedAppAssistantResultOutcomeLabel(
  outcome: RestrictedAppResultOutcome,
): string | null {
  switch (outcome) {
    case "succeeded": return null;
    case "partial": return "Partial";
    case "failed": return "Did not finish";
  }
}

/**
 * Bounds are defaults, not caps: a trimmed result says which number it hit and
 * where a person can raise it (docs/receipts-not-gates.md, principle 6).
 */
export const restrictedAppAssistantResultTrimNote =
  `\n… Trimmed to the ${restrictedAppAssistantLimits.resultBytes / 1024} KiB result limit in Settings → The fold → Limits. Open Chat for the full reply.`;

/** Compact size for one deliverable a result named. */
export function restrictedAppResultFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
