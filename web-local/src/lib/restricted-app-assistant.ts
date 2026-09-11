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

/** Stop is offered while the task is starting or running and no stop was requested yet. */
export function restrictedAppAssistantTaskCanStop(
  task: Pick<RestrictedAppAssistantTask, "status" | "cancellationRequested">,
): boolean {
  return (task.status === "running" || task.status === "dispatching") && !task.cancellationRequested;
}
