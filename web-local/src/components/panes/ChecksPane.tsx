import type { CheckCorrectionRecord } from "../../../../src/local/checks/check-corrections";
import type { WorkFoldCheckRunRecord } from "../../../../src/local/checks/check-types";
import { CheckSetup } from "./CheckSetup";
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
  SpaceSummary,
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
  space,
  active,
  onOpenFile,
  onChecksChanged,
  onAskAssistant,
}: {
  space: SpaceSummary;
  active: boolean;
  onOpenFile: (path: string) => void;
  onChecksChanged: () => void | Promise<void>;
  onAskAssistant?: (text: string) => void;
}) {
  const [correctionReview, setCorrectionReview] = useState<{ correction: CheckCorrectionRecord; before: string } | null>(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [trialResult, setTrialResult] = useState<WorkFoldCheckRunRecord | null>(null);
  const trialTaskRef = useRef<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
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
  const spaceId = space.id;
  const spaceIdRef = useRef(spaceId);

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
        const response = await readCheckOverview(spaceId, () => request === requestRef.current);
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
  }, [spaceId]);

  useEffect(() => {
    if (spaceIdRef.current === spaceId) return;
    spaceIdRef.current = spaceId;
    requestRef.current += 1;
    overviewFlightRef.current = null;
    setOverview(null);
    setTrialResult(null);
    setCorrectionReview(null);
    trialTaskRef.current = null;
    setTask(null);
    setRunSubmitting(false);
    setAbortSubmitting(false);
    setFindingBusy(null);
    mutationRef.current = null;
    setError(null);
    setOverviewUnavailable(false);
    setLoading(true);
  }, [spaceId]);

  useEffect(() => {
    if (active) void loadOverview();
  }, [active, spaceId]);

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
          `/api/spaces/${encodeURIComponent(spaceId)}/checks/tasks/${encodeURIComponent(task.taskId)}`,
        );
        if (cancelled) return;
        if (!isPendingTask(response.task) && trialTaskRef.current === response.task.taskId) {
          const result = await api<{ run: WorkFoldCheckRunRecord }>(`/api/spaces/${encodeURIComponent(spaceId)}/checks/tasks/${encodeURIComponent(response.task.taskId)}/result`);
          if (cancelled) return;
          setTrialResult(result.run);
        }
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
  }, [loadOverview, task, spaceId]);

  useEffect(() => {
    if (!active || (task && isPendingTask(task)) || !overview?.status.running) return;
    const timer = window.setTimeout(() => void loadOverview(true), 750);
    return () => window.clearTimeout(timer);
  }, [active, loadOverview, overview?.status.running, task]);

  const checksById = useMemo(
    () => new Map((overview?.checks ?? []).map((check) => [check.id, check])),
    [overview?.checks],
  );

  async function askFold(check?: ChecksOverview["checks"][number]) {
    const draft = check
      ? `Help me change ${JSON.stringify(check.title)} in folder ${JSON.stringify(space.name)} (${spaceId}). Keep the current Check unchanged while we review a new proposal. Check reference: ${check.id}.`
      : `Help me set up a Check in folder ${JSON.stringify(space.name)} (${spaceId}).`;
    try {
      if (!window.workFoldDesktop?.agent?.openFoldDraft) throw new Error("Open the work-fold agent in the desktop app and ask it to set up a Check for this folder.");
      await window.workFoldDesktop.agent.openFoldDraft(draft);
    } catch (caught) { setError(errorText(caught)); }
  }

  async function tryCheck(check: ChecksOverview["checks"][number]) {
    if (mutationRef.current) return;
    if (!await requestConfirm({ title: `Try ${check.title}?`, body: `Run once over the displayed files${check.execution === "model" ? " using the fold’s model. Designated text is sent to your provider and charges may apply" : ""}. This trial does not turn on the Check or replace its live results.`, confirmLabel: "Try it" })) return;
    mutationRef.current = "run";
    setRunSubmitting(true); setTrialResult(null); setError(null);
    try {
      const { task: accepted } = await api<{ task: { taskId: string; runId: string } }>(`/api/spaces/${encodeURIComponent(spaceId)}/checks/${encodeURIComponent(check.id)}/try`, { method: "POST", body: { expectedDigest: check.digest } });
      trialTaskRef.current = accepted.taskId;
      setTask({ ...accepted, state: "accepted", startedAt: new Date().toISOString(), endedAt: null, error: null });
    } catch (caught) { setError(errorText(caught)); }
    finally { mutationRef.current = null; setRunSubmitting(false); }
  }

  async function askAssistant(finding: ChecksFinding) {
    if (!onAskAssistant || mutationRef.current) return;
    mutationRef.current = `finding:${finding.id}`; setFindingBusy(finding.id);
    try {
      const { draft } = await api<{ draft: string }>(`/api/spaces/${encodeURIComponent(spaceId)}/checks/findings/${encodeURIComponent(finding.id)}/help`, { method: "POST", body: { fingerprint: finding.fingerprint } });
      onAskAssistant(draft);
    } catch (caught) { setError(errorText(caught)); await loadOverview(true); }
    finally { mutationRef.current = null; setFindingBusy(null); }
  }

  async function correctionAction(id: string, action: "review" | "apply" | "dismiss") {
    if (mutationRef.current) return;
    mutationRef.current = "run"; setCorrectionBusy(true); setError(null);
    try {
      const result = await api<{ correction: CheckCorrectionRecord; before: string; task?: { taskId: string; runId: string }; rerunError?: string }>(`/api/spaces/${encodeURIComponent(spaceId)}/checks/corrections/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} });
      if (action === "review") setCorrectionReview(result);
      else {
        setCorrectionReview(null);
        if (result.task) { trialTaskRef.current = null; setTask({ ...result.task, state: "accepted", startedAt: new Date().toISOString(), endedAt: null, error: null }); }
        await loadOverview(true);
        if (result.rerunError) setError(`Correction applied. The Check could not restart: ${result.rerunError}`);
      }
    } catch (caught) { setCorrectionReview(null); await loadOverview(true); setError(errorText(caught)); }
    finally { mutationRef.current = null; setCorrectionBusy(false); }
  }

  async function toggleCheck(check: ChecksOverview["checks"][number]): Promise<void> {
    if (mutationRef.current) return;
    const enabled = check.authority === "enabled";
    if (!enabled && !await requestConfirm({ title: `Enable ${check.title}?`, body: `Allow this Check to inspect the displayed targets when requested${check.execution === "model" ? ", using the fold’s model and displayed criteria. Provider charges may apply" : ""}. Enabling does not start a run.`, confirmLabel: "Enable Check" })) return;
    mutationRef.current = "run";
    try {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/checks/${encodeURIComponent(check.id)}/${enabled ? "disable" : "enable"}`, { method: "POST", body: enabled ? {} : { expectedDigest: check.digest } });
      await loadOverview(true);
    } catch (caught) { setError(errorText(caught)); }
    finally { mutationRef.current = null; }
  }

  async function runChecks(): Promise<void> {
    if (mutationRef.current) return;
    setTrialResult(null);
    trialTaskRef.current = null;
    mutationRef.current = "run";
    setRunSubmitting(true);
    setError(null);
    try {
      const response = await api<{ task: { taskId: string; runId: string; checkIds: string[] } }>(
        `/api/spaces/${encodeURIComponent(spaceId)}/checks/run`,
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
      const response = await api<{ aborted: boolean }>(`/api/spaces/${encodeURIComponent(spaceId)}/checks/tasks/${encodeURIComponent(task.taskId)}/abort`, {
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
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/checks/findings/${encodeURIComponent(finding.id)}/decision`, {
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
    <div className="space-pane-content checks-pane professional-surface">
      <header className="checks-header">
        <div>
          <h1>Checks</h1>
        </div>
        <div className="checks-header-actions">
          <button type="button" className="professional-button professional-button-secondary" disabled={running} onClick={() => void askFold()}>Tell the work-fold agent what to check</button>
          <button type="button" className="checks-manual-button" disabled={running} onClick={() => setConfiguring(!configuring)}>Set up manually</button>
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

      {configuring ? <CheckSetup spaceId={spaceId} onCancel={() => setConfiguring(false)} onSaved={async () => { setConfiguring(false); await loadOverview(true); }} /> : null}
      {error ? <div className="checks-health-message error" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => void loadOverview(true)}>Try again</button></div> : null}
      {running ? <div className="checks-running" aria-live="polite"><Loader2 className="spin" size={15} /><span>Checking only the designated files…</span></div> : null}
      {overviewUnavailable
        ? <div className="checks-status-line check-error"><span aria-hidden="true" /><p>Check results are unavailable. Try refreshing.</p></div>
        : status && status.configured > 0 && !running ? <ChecksStatusLine status={status} /> : null}

      {!overviewUnavailable && overview?.corrections?.some((item) => item.state !== "dismissed") ? <section className="checks-section" aria-label="Corrections">
        <h2>Corrections</h2>
        {[...overview.corrections.filter((item) => item.state === "pending"), ...overview.corrections.filter((item) => item.state !== "pending" && item.state !== "dismissed").slice(0, 1)].map((item) => <article className="checks-definition" key={item.id}>
          <strong>{item.proposal.path}</strong><p>{item.state === "pending" ? "Ready for review" : item.state === "applied" ? "Applied · original saved in History" : item.error || "Application not yet confirmed · check History"}</p>
          {item.state === "pending" ? <div className="checks-header-actions"><button type="button" disabled={running || correctionBusy} onClick={() => void correctionAction(item.id, "review")}>Review correction</button><button type="button" disabled={correctionBusy} onClick={() => void correctionAction(item.id, "dismiss")}>Dismiss</button></div> : null}
        </article>)}
        {correctionReview ? <div className="checks-correction-review" aria-label="Review correction">
          <h3>{correctionReview.correction.proposal.path}</h3><p>Apply saves the original in History and rechecks with the fold’s model. Provider charges may apply.</p>
          <CorrectionDiff before={correctionReview.before} after={correctionReview.correction.proposal.replacement} />
          <button type="button" className="professional-button professional-button-primary" disabled={correctionBusy || running} onClick={() => void correctionAction(correctionReview.correction.id, "apply")}>Apply and recheck</button>
          <button type="button" disabled={correctionBusy} onClick={() => setCorrectionReview(null)}>Close review</button>
        </div> : null}
      </section> : null}

      {trialResult ? <section className="checks-section checks-trial" aria-label="Trial result">
        <h2>Trial result</h2><p>Trial · {new Date(trialResult.startedAt).toLocaleString()} · live results unchanged.</p>
        <p>{trialResult.state === "succeeded" ? `${formatItemCount(trialResult.admittedCount, "finding")} in this trial.` : trialResult.error || "The trial did not finish."}</p>
        {trialResult.findings.map((finding) => <article key={finding.id}><strong>{finding.title}</strong><p>{finding.targetPath}</p>{finding.evidence.map((evidence, index) => evidence.kind === "text-span" ? <blockquote key={index}>{evidence.quote}</blockquote> : null)}<p>{finding.detail}</p></article>)}
      </section> : null}

      {Boolean(overview?.findings.length || running || overviewUnavailable) ? <section className="checks-section" aria-labelledby={`checks-findings-${spaceId}`}>
        <div className="checks-section-heading">
          <div><h2 id={`checks-findings-${spaceId}`}>Needs attention</h2></div>
          {!overviewUnavailable && overview?.findings.length ? <span>{overview.findings.length}</span> : null}
        </div>
        {overviewUnavailable ? (
          <div className="checks-empty-findings"><p>Refresh to review current findings.</p></div>
        ) : overview?.findings.length ? (
          <div className="checks-finding-list">
            {overview.findings.map((finding) => {
              const check = checksById.get(finding.checkId);
              const targetExists = finding.evidence.some(
                (evidence) => evidence.path === finding.targetPath && (evidence.kind === "text-span" || evidence.observed === "file"),
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
                    {finding.evidence.some((evidence) => evidence.kind === "text-span") ? <p><strong>Model suggestion</strong></p> : null}
                    {finding.evidence.map((evidence, index) => evidence.kind === "text-span" ? <blockquote key={index}><p>{evidence.quote}</p></blockquote> : null)}
                    {finding.detail ? <p>{finding.detail}</p> : null}
                    {finding.remediation ? <p className="checks-remediation">{finding.remediation}</p> : null}
                    {onAskAssistant ? <button type="button" className="professional-button professional-button-secondary" disabled={findingBusy !== null || running} onClick={() => void askAssistant(finding)}>Ask Space Assistant to help</button> : null}
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
        ) : running ? <p>Results will appear when this review finishes.</p> : <ChecksEmptyFindings overview={overview} />}
        {!overviewUnavailable && overview?.truncated ? <p className="checks-truncated">More current findings exist. Narrow the Check or review them with the management CLI.</p> : null}
      </section> : null}

      {!overviewUnavailable && overview?.healthErrors.length ? (
        <section className="checks-section checks-health" aria-labelledby={`checks-health-${spaceId}`}>
          <div className="checks-section-heading"><div><h2 id={`checks-health-${spaceId}`}>Check health</h2></div></div>
          <ul>{overview.healthErrors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul>
        </section>
      ) : null}

      <section className="checks-section" aria-labelledby={`checks-expectations-${spaceId}`}>
        <div className="checks-section-heading"><div><h2 id={`checks-expectations-${spaceId}`}>Your Checks</h2></div></div>
        {overviewUnavailable ? (
          <div className="checks-empty-config"><strong>Could not refresh Check configuration.</strong></div>
        ) : overview?.checks.length ? (
          <div className="checks-definition-list">
            {overview.checks.map((check) => (
              <div className="checks-definition" key={check.id}>
                <details open={check.authority !== "enabled"}><summary className="checks-definition-main"><strong>{check.title}</strong><span className={`checks-authority ${check.authority}`}>{authorityLabel(check.authority)}</span></summary>
                {check.criteria ? <p>{check.criteria}</p> : null}
                {check.execution === "model" ? <p>Text review · fold model · suggestions only</p> : null}
                <button type="button" className="professional-button professional-button-secondary" disabled={Boolean(mutationRef.current) || (check.authority !== "enabled" && !check.digest)} onClick={() => void toggleCheck(check)}>{check.authority === "enabled" ? "Turn off" : "Turn on"}</button>
                <button type="button" className="professional-button professional-button-secondary" disabled={running || !check.digest} onClick={() => void tryCheck(check)}>Try it</button>
                <button type="button" className="professional-button professional-button-secondary" disabled={running} onClick={() => void askFold(check)}>Change with fold</button>
                <div className="checks-target-list">
                  {check.targets.map((target, index) => (
                    <span key={`${target.role}:${target.path}:${index}`}>
                      <code>{target.path}</code>
                      <small>{target.role === "reference" ? "Reference" : target.kind === "tree" ? `Selected ${target.recursive ? "tree" : "folder"}` : "Selected file"}</small>
                    </span>
                  ))}
                </div>
                </details>
              </div>
            ))}
          </div>
        ) : overview ? (
          <div className="checks-empty-config"><strong>No Checks configured.</strong></div>
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
    copy = "A Check could not finish.";
  } else if (status.proposed > 0 && status.enabled === 0) {
    copy = status.proposed === 1
      ? "1 proposal ready for review."
      : `${formatItemCount(status.proposed, "proposal")} ready for review.`;
  } else if (status.neverRun) {
    const neverRun = status.neverRun === 1
      ? "1 Check has not run yet."
      : `${formatItemCount(status.neverRun, "Check")} have not run yet.`;
    copy = status.stale
      ? `${neverRun} ${formatItemCount(status.stale, "other result")} changed after its last run.`
      : neverRun;
  } else if (status.stale) {
    copy = "Files changed · run Checks to refresh.";
  } else {
    copy = status.configured
      ? "Checks are configured and run only when requested."
      : "No Checks are configured for this folder.";
  }
  return <div className={`checks-status-line ${status.state}`}><span aria-hidden="true" /><p>{copy}</p></div>;
}

function ChecksEmptyFindings({ overview }: { overview: ChecksOverview | null }) {
  if (!overview) return null;
  if (!overview.checks.length) return <div className="checks-empty-findings"><p>No results yet.</p></div>;
  if (overview.status.state === "blocked" || overview.status.state === "check-error") return <div className="checks-empty-findings"><p>The Check needs attention.</p></div>;
  if (overview.status.proposed > 0 && overview.status.enabled === 0) return <div className="checks-empty-findings"><p>Review a proposal below to get started.</p></div>;
  if (overview.status.state === "stale") return <div className="checks-empty-findings"><p>Run Checks to refresh results.</p></div>;
  return <div className="checks-empty-findings"><Check size={15} /><p>No findings in the latest run.</p></div>;
}

function isPendingTask(task: ChecksTaskStatus): boolean {
  return task.state === "accepted" || task.state === "running";
}

function severityLabel(severity: ChecksFinding["severity"]): string {
  return severity === "error" ? "Important" : severity === "warning" ? "Review" : "Note";
}

function authorityLabel(authority: ChecksOverview["checks"][number]["authority"]): string {
  return authority === "enabled" ? "On" : authority === "blocked" ? "Needs review" : "Off · review";
}

/** A single contiguous diff preserves every changed line, with surrounding
 * context. Long unchanged prefixes/suffixes stay out of the review. */
function CorrectionDiff({ before, after }: { before: string; after: string }) {
  const left = before.split("\n"), right = after.split("\n");
  let start = 0, end = 0;
  while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
  while (end < Math.min(left.length, right.length) - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  const contextStart = Math.max(0, start - 3);
  return <div className="checks-correction-diff"><div><h4>Before</h4><pre>{left.slice(contextStart, left.length - Math.max(0, end - 3)).join("\n")}</pre></div><div><h4>After</h4><pre>{right.slice(contextStart, right.length - Math.max(0, end - 3)).join("\n")}</pre></div></div>;
}

/** Files status and this work tab may refresh on the same focus event. Retry
 * only their brief read reservation conflict; never retry a Check or mutation. */
async function readCheckOverview(spaceId: string, current: () => boolean): Promise<{ overview: ChecksOverview }> {
  for (let attempt = 0; ; attempt++) {
    if (!current()) throw new Error("Check refresh superseded.");
    try { return await api<{ overview: ChecksOverview }>(`/api/spaces/${encodeURIComponent(spaceId)}/checks/overview`, { method: "POST", body: {} }); }
    catch (caught) {
      if (!(caught instanceof ApiError) || caught.status !== 409 || attempt >= 3) throw caught;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80 * (2 ** attempt)));
    }
  }
}
