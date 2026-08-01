import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Clock3, FileCheck2, Loader2, RefreshCw, X } from "lucide-react";

import { api, ApiError, errorText } from "../../lib/api";
import { checksToolbarPresentation } from "../../lib/checks-ui";
import { formatItemCount, formatTimeAgo } from "../../lib/format";
import type {
  ChecksDecisionKind,
  ChecksFinding,
  ChecksOverview,
  ChecksStatus,
  ChecksTaskStatus,
  WorkspaceSummary,
} from "../../types";
import { requestConfirm, showToast } from "../../ui/feedback";

export function ChecksToolbarButton({
  status,
  loading,
  unavailable,
  onClick,
}: {
  status: ChecksStatus | null;
  loading: boolean;
  unavailable: boolean;
  onClick: () => void;
}) {
  const presentation = checksToolbarPresentation(status, unavailable);
  if (loading || !presentation) return null;
  return (
    <button
      className={["checks-toolbar-button", presentation.tone === "quiet" ? "" : presentation.tone].filter(Boolean).join(" ")}
      type="button"
      onClick={onClick}
      title={presentation.title}
      aria-label={`${presentation.label}${presentation.count ? `, ${presentation.count}` : ""}`}
    >
      {presentation.icon === "running" ? <Loader2 className="spin" size={13} />
        : presentation.icon === "attention" ? <span className="checks-toolbar-dot" aria-hidden="true" />
          : presentation.icon === "unhealthy" ? <AlertCircle size={13} />
            : presentation.icon === "stale" ? <RefreshCw size={13} />
              : <FileCheck2 size={13} />}
      <span>{presentation.label}</span>
      {presentation.count ? <strong>{presentation.count}</strong> : null}
    </button>
  );
}

export function ChecksPane({
  workspace,
  active,
  onOpenFile,
  onChecksChanged,
}: {
  workspace: WorkspaceSummary;
  active: boolean;
  onOpenFile: (path: string) => void;
  onChecksChanged: () => void | Promise<void>;
}) {
  const [overview, setOverview] = useState<ChecksOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overviewUnavailable, setOverviewUnavailable] = useState(false);
  const [task, setTask] = useState<ChecksTaskStatus | null>(null);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [abortSubmitting, setAbortSubmitting] = useState(false);
  const [findingBusy, setFindingBusy] = useState<string | null>(null);
  const requestRef = useRef(0);
  const overviewFlightRef = useRef<Promise<void> | null>(null);
  const onChecksChangedRef = useRef(onChecksChanged);
  const mutationRef = useRef<"run" | "abort" | `finding:${string}` | null>(null);
  const workspaceId = workspace.id;
  const workspaceIdRef = useRef(workspaceId);

  useEffect(() => {
    onChecksChangedRef.current = onChecksChanged;
  }, [onChecksChanged]);

  const loadOverview = useCallback((quiet = false): Promise<void> => {
    if (overviewFlightRef.current) return overviewFlightRef.current;
    const request = ++requestRef.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    const operation = (async () => {
      try {
        const response = await api<{ overview: ChecksOverview }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/checks/overview`,
          { method: "POST", body: {} },
        );
        if (request !== requestRef.current) return;
        setOverview(response.overview);
        setOverviewUnavailable(false);
        setError(null);
        await onChecksChangedRef.current();
      } catch (caught) {
        if (request === requestRef.current) {
          setOverviewUnavailable(true);
          setError(errorText(caught));
        }
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })().finally(() => {
      if (overviewFlightRef.current === operation) overviewFlightRef.current = null;
    });
    overviewFlightRef.current = operation;
    return operation;
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceIdRef.current === workspaceId) return;
    workspaceIdRef.current = workspaceId;
    requestRef.current += 1;
    overviewFlightRef.current = null;
    setOverview(null);
    setTask(null);
    setRunSubmitting(false);
    setAbortSubmitting(false);
    setFindingBusy(null);
    mutationRef.current = null;
    setError(null);
    setOverviewUnavailable(false);
    setLoading(true);
  }, [workspaceId]);

  useEffect(() => {
    if (active) void loadOverview();
  }, [active, workspaceId]);

  useEffect(() => {
    if (!active) return;
    const refreshOnReturn = () => {
      if (document.visibilityState !== "hidden") void loadOverview(true);
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [active, loadOverview]);

  useEffect(() => {
    if (!task || !isPendingTask(task)) return;
    let cancelled = false;
    let timer: number | null = null;
    let failures = 0;
    const poll = async () => {
      try {
        const response = await api<{ task: ChecksTaskStatus }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/checks/tasks/${encodeURIComponent(task.taskId)}`,
        );
        if (cancelled) return;
        setTask(response.task);
        if (!isPendingTask(response.task)) {
          await loadOverview(true);
          if (response.task.state === "succeeded") showToast({ text: "Checks finished.", tone: "success" });
          else if (response.task.state !== "aborted") showToast({ text: response.task.error || "Checks did not finish.", tone: "error" });
        }
      } catch (caught) {
        if (!cancelled) {
          setError(errorText(caught));
          failures += 1;
          timer = window.setTimeout(() => void poll(), Math.min(500 * (2 ** Math.min(failures, 4)), 5_000));
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadOverview, task, workspaceId]);

  useEffect(() => {
    if (!active || (task && isPendingTask(task)) || !overview?.status.running) return;
    const timer = window.setTimeout(() => void loadOverview(true), 750);
    return () => window.clearTimeout(timer);
  }, [active, loadOverview, overview?.status.running, task]);

  const checksById = useMemo(
    () => new Map((overview?.checks ?? []).map((check) => [check.id, check])),
    [overview?.checks],
  );

  async function runChecks(): Promise<void> {
    if (mutationRef.current) return;
    mutationRef.current = "run";
    setRunSubmitting(true);
    setError(null);
    try {
      const response = await api<{ task: { taskId: string; runId: string; checkIds: string[] } }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/checks/run`,
        { method: "POST", body: {} },
      );
      setTask({
        taskId: response.task.taskId,
        runId: response.task.runId,
        state: "accepted",
        startedAt: new Date().toISOString(),
        endedAt: null,
        error: null,
      });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      if (mutationRef.current === "run") mutationRef.current = null;
      setRunSubmitting(false);
    }
  }

  async function abortChecks(): Promise<void> {
    if (!task || mutationRef.current) return;
    mutationRef.current = "abort";
    setAbortSubmitting(true);
    try {
      const response = await api<{ aborted: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/checks/tasks/${encodeURIComponent(task.taskId)}/abort`, {
        method: "POST",
        body: {},
      });
      if (response.aborted) {
        setTask((current) => current ? { ...current, state: "aborted", endedAt: new Date().toISOString() } : current);
      }
      await loadOverview(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      if (mutationRef.current === "abort") mutationRef.current = null;
      setAbortSubmitting(false);
    }
  }

  async function decide(finding: ChecksFinding, decision: ChecksDecisionKind): Promise<void> {
    if (mutationRef.current) return;
    const mutation = `finding:${finding.id}` as const;
    mutationRef.current = mutation;
    setFindingBusy(finding.id);
    try {
      if (decision === "reject") {
        const confirmed = await requestConfirm({
          title: "Mark this finding as not an issue?",
          body: "It will stay hidden until the designated file or Check changes.",
          confirmLabel: "Not an issue",
        });
        if (!confirmed) return;
      }
      const deferUntil = decision === "defer"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : undefined;
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/checks/findings/${encodeURIComponent(finding.id)}/decision`, {
        method: "POST",
        body: { decision, ...(deferUntil ? { deferUntil } : {}) },
      });
      await loadOverview(true);
      showToast({
        text: decision === "resolve" ? "Finding marked resolved."
          : decision === "reject" ? "Finding marked as not an issue."
            : "Finding deferred until tomorrow.",
        tone: "success",
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) await loadOverview(true);
      setError(errorText(caught));
    } finally {
      if (mutationRef.current === mutation) mutationRef.current = null;
      setFindingBusy(null);
    }
  }

  if (loading && !overview) {
    return <div className="checks-pane checks-pane-loading" aria-live="polite"><Loader2 className="spin" size={17} />Loading Checks</div>;
  }

  const status = overviewUnavailable ? null : overview?.status ?? null;
  const taskPending = Boolean(task && isPendingTask(task));
  const running = runSubmitting || taskPending || Boolean(status?.running);
  return (
    <div className="workspace-pane-content checks-pane professional-surface">
      <header className="checks-header">
        <div>
          <span className="checks-eyebrow"><FileCheck2 size={14} />Optional · manual</span>
          <h1>Checks</h1>
          <p>Expectations for files you explicitly chose. Workspace does not inspect anything else.</p>
        </div>
        <div className="checks-header-actions">
          {status?.lastRunAt ? <span className="checks-last-run">Last run {formatTimeAgo(status.lastRunAt)}</span> : null}
          {runSubmitting ? (
            <button className="professional-button professional-button-secondary" type="button" disabled>
              <Loader2 className="spin" size={14} />Starting
            </button>
          ) : taskPending ? (
            <button className="professional-button professional-button-secondary" type="button" disabled={abortSubmitting} onClick={() => void abortChecks()}>
              {abortSubmitting ? <Loader2 className="spin" size={14} /> : <X size={14} />}{abortSubmitting ? "Stopping" : "Stop"}
            </button>
          ) : status?.running ? (
            <button className="professional-button professional-button-secondary" type="button" disabled>
              <Loader2 className="spin" size={14} />Checking
            </button>
          ) : (
            <button className="professional-button professional-button-primary" type="button" disabled={!status?.enabled || refreshing || Boolean(mutationRef.current)} onClick={() => void runChecks()}>
              <RefreshCw className={refreshing ? "spin" : undefined} size={14} />Run Checks
            </button>
          )}
        </div>
      </header>

      {error ? <div className="checks-health-message error" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => void loadOverview(true)}>Try again</button></div> : null}
      {running ? <div className="checks-running" aria-live="polite"><Loader2 className="spin" size={15} /><span>Checking only the designated files…</span></div> : null}
      {overviewUnavailable
        ? <div className="checks-status-line check-error"><span aria-hidden="true" /><p>Current Check results are unavailable. Workspace is not labeling your files as clear or failed.</p></div>
        : status ? <ChecksStatusLine status={status} /> : null}

      <section className="checks-section" aria-labelledby={`checks-findings-${workspaceId}`}>
        <div className="checks-section-heading">
          <div><h2 id={`checks-findings-${workspaceId}`}>Needs attention</h2><p>{overviewUnavailable ? "Unavailable until Workspace can re-verify the designated evidence." : "Current findings with evidence Workspace re-verified."}</p></div>
          {!overviewUnavailable && overview?.findings.length ? <span>{overview.findings.length}</span> : null}
        </div>
        {overviewUnavailable ? (
          <div className="checks-empty-findings"><p>Current findings could not be re-verified. Try again before acting on a previous result.</p></div>
        ) : overview?.findings.length ? (
          <div className="checks-finding-list">
            {overview.findings.map((finding) => {
              const check = checksById.get(finding.checkId);
              const targetExists = finding.evidence.some(
                (evidence) => evidence.path === finding.targetPath && evidence.observed === "file",
              );
              return (
                <article className="checks-finding" key={finding.id}>
                  <span className="checks-finding-marker" aria-hidden="true" />
                  <div className="checks-finding-copy">
                    <div className="checks-finding-title"><h3>{finding.title}</h3><span>{severityLabel(finding.severity)}</span></div>
                    <div className="checks-finding-source">
                      {targetExists ? <button type="button" onClick={() => onOpenFile(finding.targetPath)}>{finding.targetPath}</button> : <code>{finding.targetPath}</code>}
                      {check ? <span>{check.title}</span> : null}
                    </div>
                    {finding.detail ? <p>{finding.detail}</p> : null}
                    {finding.remediation ? <p className="checks-remediation">{finding.remediation}</p> : null}
                    <div className="checks-finding-actions" role="group" aria-label={`Decisions for ${finding.title}`}>
                      <button type="button" aria-label={`Mark ${finding.title} resolved`} disabled={findingBusy !== null || Boolean(mutationRef.current)} onClick={() => void decide(finding, "resolve")}><Check size={13} />Mark resolved</button>
                      <button type="button" aria-label={`Defer ${finding.title} until tomorrow`} disabled={findingBusy !== null || Boolean(mutationRef.current)} onClick={() => void decide(finding, "defer")}><Clock3 size={13} />Tomorrow</button>
                      <button type="button" aria-label={`Mark ${finding.title} as not an issue`} disabled={findingBusy !== null || Boolean(mutationRef.current)} onClick={() => void decide(finding, "reject")}>Not an issue</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <ChecksEmptyFindings overview={overview} />}
        {!overviewUnavailable && overview?.truncated ? <p className="checks-truncated">More current findings exist. Narrow the Check or review them with the management CLI.</p> : null}
      </section>

      {!overviewUnavailable && overview?.healthErrors.length ? (
        <section className="checks-section checks-health" aria-labelledby={`checks-health-${workspaceId}`}>
          <div className="checks-section-heading"><div><h2 id={`checks-health-${workspaceId}`}>Check health</h2><p>These are Check problems, not problems in your files.</p></div></div>
          <ul>{overview.healthErrors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul>
        </section>
      ) : null}

      <section className="checks-section" aria-labelledby={`checks-expectations-${workspaceId}`}>
        <div className="checks-section-heading"><div><h2 id={`checks-expectations-${workspaceId}`}>Designated expectations</h2><p>Only these bounded targets may be inspected when you run Checks.</p></div></div>
        {overviewUnavailable ? (
          <div className="checks-empty-config"><strong>Check configuration could not be refreshed.</strong><p>No Check is running automatically. Try again to verify the currently designated targets.</p></div>
        ) : overview?.checks.length ? (
          <div className="checks-definition-list">
            {overview.checks.map((check) => (
              <div className="checks-definition" key={check.id}>
                <div className="checks-definition-main"><strong>{check.title}</strong><span className={`checks-authority ${check.authority}`}>{authorityLabel(check.authority)}</span></div>
                <div className="checks-target-list">
                  {check.targets.map((target, index) => (
                    <span key={`${target.role}:${target.path}:${index}`}>
                      <code>{target.path}</code>
                      <small>{target.role === "reference" ? "Reference" : target.kind === "tree" ? `Selected ${target.recursive ? "tree" : "folder"}` : "Selected file"}</small>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : overview ? (
          <div className="checks-empty-config"><strong>No Checks are configured.</strong><p>Nothing in this Space is being inspected. A Check starts as a reviewable proposal created in conversation, then must be enabled explicitly.</p></div>
        ) : null}
      </section>
    </div>
  );
}

function ChecksStatusLine({ status }: { status: ChecksOverview["status"] }) {
  let copy: string;
  if (status.state === "needs-attention") {
    copy = status.needsAttention === 1
      ? "1 finding needs attention."
      : `${formatItemCount(status.needsAttention, "finding")} need attention.`;
  } else if (status.state === "current-clear") {
    copy = `No current findings from ${formatItemCount(status.enabled, "enabled Check")}.`;
  } else if (status.state === "blocked") {
    copy = status.blocked === 1
      ? "1 Check needs review before running."
      : `${formatItemCount(status.blocked, "Check")} need review before running.`;
  } else if (status.state === "check-error") {
    copy = "The latest Check work did not complete. Your files are not being labeled as failed.";
  } else if (status.proposed > 0 && status.enabled === 0) {
    copy = status.proposed === 1
      ? "1 proposed Check is not enabled. There is no result yet."
      : `${formatItemCount(status.proposed, "proposed Check")} are not enabled. There is no result yet.`;
  } else if (status.neverRun) {
    const neverRun = status.neverRun === 1
      ? "1 Check has not run yet."
      : `${formatItemCount(status.neverRun, "Check")} have not run yet.`;
    copy = status.stale
      ? `${neverRun} ${formatItemCount(status.stale, "other result")} changed after its last run.`
      : neverRun;
  } else if (status.stale) {
    copy = "Designated files changed after the last run. Run Checks when you want a current result.";
  } else {
    copy = status.configured
      ? "Checks are configured and run only when requested."
      : "No Checks are configured for this Space.";
  }
  return <div className={`checks-status-line ${status.state}`}><span aria-hidden="true" /><p>{copy}</p></div>;
}

function ChecksEmptyFindings({ overview }: { overview: ChecksOverview | null }) {
  if (!overview) return null;
  if (!overview.checks.length) return <div className="checks-empty-findings"><p>No configured Checks means no result—not a clean bill of health.</p></div>;
  if (overview.status.state === "blocked" || overview.status.state === "check-error") return <div className="checks-empty-findings"><p>No file finding is shown because the Check itself needs attention.</p></div>;
  if (overview.status.proposed > 0 && overview.status.enabled === 0) return <div className="checks-empty-findings"><p>No Check has been enabled or run. Review the proposed expectations below.</p></div>;
  if (overview.status.state === "stale") return <div className="checks-empty-findings"><p>Run Checks to get a current result for the designated files.</p></div>;
  return <div className="checks-empty-findings"><Check size={15} /><p>Nothing currently needs attention from the latest requested run.</p></div>;
}

function isPendingTask(task: ChecksTaskStatus): boolean {
  return task.state === "accepted" || task.state === "running";
}

function severityLabel(severity: ChecksFinding["severity"]): string {
  return severity === "error" ? "Important" : severity === "warning" ? "Review" : "Note";
}

function authorityLabel(authority: ChecksOverview["checks"][number]["authority"]): string {
  return authority === "enabled" ? "Enabled" : authority === "blocked" ? "Needs review" : "Not enabled";
}
