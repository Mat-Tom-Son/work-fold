import type { ChatActivityStatus } from "../../types";

/** The one activity mark: a pulse while a Worker runs, green when its reply waits to be seen. */
export function ActivityDot({ status, labeled = false }: { status: ChatActivityStatus; labeled?: boolean }) {
  const label = status === "running" ? "Working" : "New reply";
  return (
    // Not a live region: these dots sit inside buttons and list rows, and a
    // status role there makes every row an announcement.
    <span className={`chat-activity-indicator ${status}${labeled ? " labeled" : ""}`} title={labeled ? undefined : label}>
      <span className="chat-activity-dot" aria-hidden="true" />
      <span className={labeled ? "chat-activity-label" : "sr-only"}>{label}</span>
    </span>
  );
}
