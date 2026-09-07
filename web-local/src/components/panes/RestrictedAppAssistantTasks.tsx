import { useEffect, useState } from "react";
import type { RestrictedAppAssistantTask, RestrictedAppTaskReview } from "../../../../src/shared/restricted-app-tasks";
import type { RestrictedAppInstalled } from "../../types";
import { errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { actRestrictedAppAssistantTask, listRestrictedAppAssistantTasks, reviewRestrictedAppAssistantTask } from "../../lib/restricted-apps";

export function RestrictedAppAssistantTasks({ app, disabled, onOpenChat }: {
  app: RestrictedAppInstalled;
  disabled: boolean;
  onOpenChat?: (spaceId: string, conversationId: string) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<RestrictedAppAssistantTask[]>([]);
  const [review, setReview] = useState<RestrictedAppTaskReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (disabled) return;
    let alive = true;
    let loading = false;
    async function refresh() {
      if (!alive || loading || document.visibilityState === "hidden") return;
      loading = true;
      try { const next = await listRestrictedAppAssistantTasks(app); if (alive) setTasks(next); }
      catch (caught) { if (alive) setError(errorText(caught)); }
      finally { loading = false; }
    }
    void refresh();
    const unsubscribe = subscribeControlEvents(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { alive = false; unsubscribe(); window.clearInterval(timer); };
  }, [app, disabled]);

  useEffect(() => {
    if (!review || disabled || tasks.find((task) => task.id === review.task.id)?.status === review.task.status) return;
    let alive = true;
    void reviewRestrictedAppAssistantTask(app, review.task.requestId).then((next) => { if (alive) setReview(next); })
      .catch((caught) => { if (alive) setError(errorText(caught)); });
    return () => { alive = false; };
  }, [app, disabled, tasks, review]);

  async function inspect(task: RestrictedAppAssistantTask, openChat = false) {
    setBusy(true); setError(null);
    try {
      const next = await reviewRestrictedAppAssistantTask(app, task.requestId);
      if (openChat && next.conversationId && onOpenChat) await onOpenChat(app.spaceId, next.conversationId);
      else setReview(next);
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  async function act(task: RestrictedAppAssistantTask, operation: "approve" | "cancel") {
    setBusy(true); setError(null);
    try {
      const updated = await actRestrictedAppAssistantTask(app, task.requestId, operation, operation === "approve" ? review?.reviewDigest : undefined);
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setReview(null);
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  const unavailable = disabled || busy;
  return <section className="restricted-app-connections restricted-app-assistant-tasks" aria-label="Assistant requests">
    <div className="restricted-app-connections-heading"><h3>Assistant requests</h3></div>
    {error ? <p role="alert">{error}</p> : null}
    {!tasks.length ? <p>No requests yet.</p> : tasks.map((task) => <article className="restricted-app-destination-card" key={task.id}>
      <div><strong>{task.title}</strong><span className="professional-status-badge">{task.cancellationRequested && task.status === "running" ? "Stopping" : task.status === "cancelled" && !task.approvedAt ? "Dismissed" : taskStatus[task.status]}</span></div>
      <div className="restricted-app-task-actions">
        <button className="professional-button professional-button-secondary" disabled={unavailable} onClick={() => void inspect(task)}>{task.status === "pending" ? "Review" : "Details"}</button>
        {task.status === "pending" || task.status === "running" ? <button className="professional-button professional-button-secondary" disabled={unavailable || task.cancellationRequested} onClick={() => void act(task, "cancel")}>{task.status === "pending" ? "Dismiss" : "Stop"}</button> : null}
        {onOpenChat && task.approvedAt ? <button className="professional-button professional-button-secondary" disabled={unavailable} onClick={() => void inspect(task, true)}>Open Chat</button> : null}
      </div>
      {review?.task.id === task.id ? <div className="restricted-app-task-review">
        <pre tabIndex={0} aria-label="Assistant request">{review.instructions}{"\n\n"}{JSON.stringify(JSON.parse(review.inputJson), null, 2)}</pre>
        {task.status === "pending" ? <>
          <p>Uses this Space’s Assistant and its usual tools. Its reply is shared with {app.manifest.title}.</p>
          <button className="professional-button professional-button-primary" disabled={unavailable} onClick={() => void act(task, "approve")}>Run in this Space</button>
        </> : review.task.result ? <pre tabIndex={0} aria-label="Assistant result">{review.task.result.text}{review.task.result.truncated ? "\n… Open Chat for the full reply." : ""}</pre> : null}
        <button className="professional-button professional-button-secondary" disabled={busy} onClick={() => setReview(null)}>Close</button>
      </div> : null}
    </article>)}
  </section>;
}

const taskStatus: Record<RestrictedAppAssistantTask["status"], string> = {
  pending: "Needs review", dispatching: "Starting", running: "Running", succeeded: "Done", failed: "Failed",
  cancelled: "Stopped", interrupted: "Interrupted", expired: "Expired",
};
