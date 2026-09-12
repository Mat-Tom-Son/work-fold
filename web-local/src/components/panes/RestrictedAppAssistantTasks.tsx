import { useEffect, useState } from "react";
import type { RestrictedAppAssistantTask, RestrictedAppTaskDetail } from "../../../../src/shared/restricted-app-tasks";
import type { RestrictedAppInstalled } from "../../types";
import { errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { restrictedAppAssistantResultTrimNote, restrictedAppAssistantTaskCanStop, restrictedAppAssistantTaskStatusLabel, restrictedAppAssistantTaskUsageLine, restrictedAppResultFileSize } from "../../lib/restricted-app-assistant";
import { cancelRestrictedAppAssistantTask, listRestrictedAppAssistantTasks, readRestrictedAppAssistantTask } from "../../lib/restricted-apps";
import { ConnectedWorkRequest, openWorkFile } from "../chat/WorkRequest";

/**
 * Requests this app handed to the Space's Assistant. Each one already started
 * its own Chat when the app asked; this list shows status, the exact
 * instructions and input, the reply once done, and offers Open Chat and Stop.
 */
export function RestrictedAppAssistantTasks({ app, disabled, onOpenChat, onOpenFile = openWorkFile }: {
  app: RestrictedAppInstalled;
  disabled: boolean;
  onOpenChat?: (spaceId: string, conversationId: string) => Promise<void>;
  onOpenFile?: (spaceId: string, path: string) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<RestrictedAppAssistantTask[]>([]);
  const [detail, setDetail] = useState<RestrictedAppTaskDetail | null>(null);
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
    if (!detail || disabled) return;
    const current = tasks.find((task) => task.id === detail.task.id);
    if (!current || (current.status === detail.task.status && current.updatedAt === detail.task.updatedAt)) return;
    let alive = true;
    void readRestrictedAppAssistantTask(app, detail.task.requestId).then((next) => { if (alive) setDetail(next); })
      .catch((caught) => { if (alive) setError(errorText(caught)); });
    return () => { alive = false; };
  }, [app, disabled, tasks, detail]);

  async function inspect(task: RestrictedAppAssistantTask, openChat = false) {
    setBusy(true); setError(null);
    try {
      const next = await readRestrictedAppAssistantTask(app, task.requestId);
      if (openChat && onOpenChat) await onOpenChat(app.spaceId, next.conversationId);
      else setDetail(next);
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  async function stop(task: RestrictedAppAssistantTask) {
    setBusy(true); setError(null);
    try {
      const updated = await cancelRestrictedAppAssistantTask(app, task.requestId);
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  const unavailable = disabled || busy;
  if (!tasks.length && !error) return null;
  return <section className="restricted-app-connections restricted-app-assistant-tasks" aria-label="Assistant requests">
    <div className="restricted-app-connections-heading"><h3>Assistant requests</h3></div>
    {error ? <p role="alert">{error}</p> : null}
    {tasks.map((task) => <article className="restricted-app-destination-card" key={task.id} tabIndex={-1}>
      <div className="restricted-app-task-heading"><strong>{task.title}</strong><span className="professional-status-badge">{restrictedAppAssistantTaskStatusLabel(task)}</span></div>
      {task.result ? <div className="restricted-app-task-result">
        <p className="work-result-summary" aria-label="Assistant result">{task.result.summary}{task.result.truncated ? restrictedAppAssistantResultTrimNote : ""}</p>
        {task.result.files?.length ? <ul className="work-result-files" aria-label="Assistant result files">
          {task.result.files.map((file) => <li key={file.path}><button className="work-file-button" type="button" onClick={() => void onOpenFile(app.spaceId, file.path).catch((caught) => setError(errorText(caught)))}><span>{file.path}</span><small>{restrictedAppResultFileSize(file.sizeBytes)} · Open file</small></button></li>)}
        </ul> : null}
      </div> : null}
      <div className="restricted-app-task-actions">
        <button className="professional-button professional-button-secondary" disabled={unavailable} onClick={() => void inspect(task)}>Details</button>
        {onOpenChat ? <button className="professional-button professional-button-secondary" disabled={unavailable} onClick={() => void inspect(task, true)}>Open Chat</button> : null}
        {restrictedAppAssistantTaskCanStop(task) ? <button className="professional-button professional-button-secondary" disabled={unavailable} onClick={() => void stop(task)}>Stop</button> : null}
      </div>
      {task.status === "waiting" ? <AppTaskQuestion app={app} task={task} onOpenFile={onOpenFile} /> : null}
      {detail?.task.id === task.id ? <div className="restricted-app-task-review">
        <details><summary>Request details</summary>
          <pre tabIndex={0} aria-label="Assistant request">{detail.instructions}{"\n\n"}{JSON.stringify(JSON.parse(detail.inputJson), null, 2)}</pre>
          {restrictedAppAssistantTaskUsageLine(task) ? <p className="restricted-app-task-usage">{restrictedAppAssistantTaskUsageLine(task)}</p> : null}
        </details>
        {task.status !== "waiting" && detail.taskId ? <ConnectedWorkRequest path={`/api/tasks/${encodeURIComponent(detail.taskId)}/work`} showResultSummary={false} showResultFiles={false} showStop={false} onOpenFile={onOpenFile} /> : null}
        {detail.task.result?.data === undefined ? null : <details><summary>Result details</summary><pre tabIndex={0} aria-label="Assistant result details">{JSON.stringify(detail.task.result.data, null, 2)}</pre></details>}
        <button className="professional-button professional-button-secondary" disabled={busy} onClick={() => setDetail(null)}>Close</button>
      </div> : null}
    </article>)}
  </section>;
}

function AppTaskQuestion({ app, task, onOpenFile }: { app: RestrictedAppInstalled; task: RestrictedAppAssistantTask; onOpenFile: (spaceId: string, path: string) => Promise<void> }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readRestrictedAppAssistantTask(app, task.requestId).then((detail) => { if (alive) setTaskId(detail.taskId ?? null); })
      .catch((caught) => { if (alive) setError(errorText(caught)); });
    return () => { alive = false; };
  }, [app, task.requestId]);
  return taskId ? <ConnectedWorkRequest path={`/api/tasks/${encodeURIComponent(taskId)}/work`} showStop={false} onOpenFile={onOpenFile} /> : error ? <p role="alert">{error}</p> : null;
}
