import type { RestrictedAppAssistantTask } from "../../../src/shared/restricted-app-tasks.js";

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
