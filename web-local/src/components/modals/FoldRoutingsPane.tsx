import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorText } from "../../lib/api";

export type FoldRoutingHealth = "enabled" | "disabled" | "suspended" | "completed";
export type FoldRoutingOutcome = "accepted" | "succeeded" | "failed" | "stopped" | "interrupted" | "skipped" | "lapsed";

export interface FoldRoutingSpaceRef {
  spaceId: string;
  spaceName?: string;
}

export type FoldRoutingTriggerView =
  | { kind: "manual"; summary?: string }
  | { kind: "interval"; intervalMinutes: number; summary?: string }
  | { kind: "at"; at: string; ifMissed: "run" | "skip"; summary?: string }
  | {
    kind: "on-settled";
    summary?: string;
    source: {
      kind: "check-run" | "app-automation-run";
      spaceId: string;
      spaceName?: string;
      checkId?: string;
      appId?: string;
      automationId?: string;
      outcomes?: string[];
    };
  };

export type FoldRoutingStepView =
  | {
    id: string;
    kind: "chat";
    space: FoldRoutingSpaceRef;
    message: string;
  }
  | {
    id: string;
    kind: "files";
    fromSpace: FoldRoutingSpaceRef;
    toSpace: FoldRoutingSpaceRef;
    to: string;
    source:
      | { kind: "paths"; paths: string[] }
      | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
      | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number };
  }
  | {
    id: string;
    kind: "check";
    space: FoldRoutingSpaceRef;
    checkId?: string;
  };

export interface FoldRoutingSummaryView {
  routingId: string;
  title: string;
  health: FoldRoutingHealth;
  trigger: FoldRoutingTriggerView;
  stepCount: number;
  nextScheduledAt?: string;
  lastScheduledAt?: string;
  activeRun?: { runId: string; startedAt: string };
  lastRun?: {
    runId: string;
    outcome: FoldRoutingOutcome;
    startedAt: string;
    finishedAt?: string;
  };
  suspension?: {
    at: string;
    reason?: string;
    missingSpaces?: FoldRoutingSpaceRef[];
  };
}

export interface FoldRoutingDetailView extends FoldRoutingSummaryView {
  createdAt: string;
  createdBy?: string;
  spaces: FoldRoutingSpaceRef[];
  steps: FoldRoutingStepView[];
  completedAt?: string;
}

export interface FoldRoutingHistoryHopView {
  hopId: string;
  kind: "chat" | "files" | "check";
  outcome: FoldRoutingOutcome;
  spaceName?: string;
  detail?: string;
  evidence?: Array<{ label: string; value: string }>;
}

export interface FoldRoutingHistoryRunView {
  runId: string;
  outcome: FoldRoutingOutcome;
  startedAt: string;
  finishedAt?: string;
  cause?: string;
  detail?: string;
  hops: FoldRoutingHistoryHopView[];
}

export interface FoldRoutingsResponse {
  routings: FoldRoutingSummaryView[];
  status: {
    storeDamaged: boolean;
    storeDamageReason?: string;
    journalDamaged: boolean;
    journalDamageReason?: string;
    activeRunCount: number;
  };
}

export interface FoldRoutingDetailResponse {
  routing: FoldRoutingDetailView;
}

export interface FoldRoutingHistoryResponse {
  runs: FoldRoutingHistoryRunView[];
  truncated: boolean;
  damagedLineCount: number;
}

export interface FoldRoutingStageResponse {
  routingId: string;
  decisionId: string;
  state: "staged" | "executed";
}

export interface FoldRoutingRunResponse {
  routingId: string;
  requestId: string;
  runId: string;
  accepted: true;
}

const emptyHistory: FoldRoutingHistoryResponse = { runs: [], truncated: false, damagedLineCount: 0 };

/**
 * Settings-only projection over the host routing service. The renderer never
 * parses declarations or receipt JSONL itself: the host resolves Space names,
 * safe details, run groups, and evidence identifiers before they arrive here.
 */
export function FoldRoutingsPane() {
  const [data, setData] = useState<FoldRoutingsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FoldRoutingDetailView | null>(null);
  const [history, setHistory] = useState<FoldRoutingHistoryResponse>(emptyHistory);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [runWatches, setRunWatches] = useState<Record<string, { startedAt: number; runId?: string }>>({});
  const selectedIdRef = useRef<string | null>(null);

  const selectRouting = useCallback((routingId: string | null) => {
    selectedIdRef.current = routingId;
    setSelectedId(routingId);
  }, []);

  const loadList = useCallback(async () => {
    const next = await routingBridge().list();
    setData(next);
    setLoadError(null);
    const current = selectedIdRef.current;
    selectRouting(current && next.routings.some((routing) => routing.routingId === current)
      ? current
      : next.routings[0]?.routingId ?? null);
    return next;
  }, [selectRouting]);

  const loadSelected = useCallback(async (routingId: string) => {
    const [nextDetail, nextHistory] = await Promise.all([
      routingBridge().show(routingId),
      routingBridge().history(routingId),
    ]);
    if (selectedIdRef.current !== routingId) return;
    setDetail(nextDetail.routing);
    setHistory(nextHistory);
    setDetailError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void routingBridge().list()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setLoadError(null);
        const current = selectedIdRef.current;
        selectRouting(current && next.routings.some((routing) => routing.routingId === current)
          ? current
          : next.routings[0]?.routingId ?? null);
      })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [selectRouting]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (!selectedId) {
      setDetail(null);
      setHistory(emptyHistory);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setHistory(emptyHistory);
    setDetailError(null);
    void Promise.all([
      routingBridge().show(selectedId),
      routingBridge().history(selectedId),
    ])
      .then(([nextDetail, nextHistory]) => {
        if (cancelled) return;
        setDetail(nextDetail.routing);
        setHistory(nextHistory);
        setDetailError(null);
      })
      .catch((caught) => { if (!cancelled) setDetailError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const hasActiveRun = Boolean(data?.routings.some((routing) => routing.activeRun))
    || pending.some((key) => key.startsWith("run:"))
    || Object.keys(runWatches).length > 0;
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => {
      void loadList()
        .then(async (next) => {
          const selectedStillExists = selectedId && next.routings.some((routing) => routing.routingId === selectedId);
          if (selectedStillExists) await loadSelected(selectedId);
          const settled: string[] = [];
          for (const [routingId, watch] of Object.entries(runWatches)) {
            const routing = next.routings.find((candidate) => candidate.routingId === routingId);
            if (!routing || routing.health !== "enabled" || next.status.journalDamaged || Date.now() - watch.startedAt > 10 * 60_000) {
              settled.push(routingId);
              continue;
            }
            if (routing.activeRun) continue;
            const recent = await routingBridge().history(routingId).catch(() => null);
            if (recent?.runs.some((run) => run.outcome !== "accepted" && (
              watch.runId ? run.runId === watch.runId : Date.parse(run.startedAt) >= watch.startedAt - 1_000
            ))) {
              settled.push(routingId);
            }
          }
          if (settled.length) {
            setRunWatches((current) => Object.fromEntries(
              Object.entries(current).filter(([routingId]) => !settled.includes(routingId)),
            ));
          }
        })
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, loadList, loadSelected, runWatches, selectedId]);

  const selectedSummary = useMemo(
    () => data?.routings.find((routing) => routing.routingId === selectedId) ?? null,
    [data?.routings, selectedId],
  );

  async function runAction(key: string, operation: () => Promise<string | null>) {
    if (pending.includes(key)) return;
    const watchedRoutingId = key.startsWith("run:") ? key.slice("run:".length) : null;
    if (watchedRoutingId) {
      setRunWatches((current) => ({ ...current, [watchedRoutingId]: { startedAt: Date.now() } }));
    }
    setPending((current) => [...current, key]);
    setActionError(null);
    setNotice(null);
    try {
      const nextNotice = await operation();
      const next = await loadList();
      const nextSelectedId = selectedId && next.routings.some((routing) => routing.routingId === selectedId)
        ? selectedId
        : next.routings[0]?.routingId ?? null;
      if (nextSelectedId) await loadSelected(nextSelectedId);
      else {
        setDetail(null);
        setHistory(emptyHistory);
      }
      if (nextNotice) setNotice(nextNotice);
    } catch (caught) {
      if (watchedRoutingId) {
        setRunWatches((current) => Object.fromEntries(
          Object.entries(current).filter(([routingId]) => routingId !== watchedRoutingId),
        ));
      }
      setActionError(errorText(caught));
    } finally {
      setPending((current) => current.filter((item) => item !== key));
    }
  }

  const status = data?.status;
  const routings = data?.routings ?? [];
  const storeUnavailable = Boolean(status?.storeDamaged);
  const wideningUnavailable = storeUnavailable || Boolean(status?.journalDamaged);

  return (
    <section className="settings-section fold-routings" aria-labelledby="fold-routings-title">
      <div className="settings-section-heading">
        <h3 id="fold-routings-title">Routings</h3>
        {data ? <span>{routings.length}</span> : null}
      </div>
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {status?.storeDamaged ? (
        <span className="settings-inline-error" role="alert">
          {status.storeDamageReason ?? "The routing records could not be read."} Nothing will run until they are recovered.
        </span>
      ) : null}
      {status?.journalDamaged ? (
        <span className="settings-inline-error" role="alert">
          {status.journalDamageReason ?? "Run history could not be verified."} New runs are unavailable.
        </span>
      ) : null}
      {notice ? <span className="settings-save-status" role="status">{notice}</span> : null}
      {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
      {data && !routings.length ? (
        <div className="fold-routings-empty">No routings yet. Ask the fold to set one up.</div>
      ) : null}
      {routings.length ? (
        <div className="fold-routings-workbench">
          <div className="fold-routing-list" role="listbox" aria-label="Routings">
            {routings.map((routing) => (
              <button
                className={routing.routingId === selectedId ? "fold-routing-list-row selected" : "fold-routing-list-row"}
                type="button"
                role="option"
                aria-selected={routing.routingId === selectedId}
                key={routing.routingId}
                onClick={() => {
                  selectRouting(routing.routingId);
                  setActionError(null);
                  setNotice(null);
                }}
              >
                <span className="fold-routing-list-heading">
                  <strong>{routing.title}</strong>
                  <RoutingHealth
                    health={routing.health}
                    running={Boolean(routing.activeRun)}
                    starting={Boolean(runWatches[routing.routingId]) && !routing.activeRun}
                  />
                </span>
                <small>{triggerSummary(routing.trigger)}</small>
                <small>{routing.activeRun
                  ? "Running now"
                  : runWatches[routing.routingId]
                    ? "Starting…"
                    : routing.nextScheduledAt
                      ? `Next ${formatDateTime(routing.nextScheduledAt)}`
                      : lastRunSummary(routing)}</small>
              </button>
            ))}
          </div>
          <div className="fold-routing-inspector" aria-live="polite">
            {detailError ? <span className="settings-inline-error" role="alert">{detailError}</span> : null}
            {!detail && !detailError ? <div className="fold-routing-loading">Loading</div> : null}
            {detail && selectedSummary ? (
              <>
                <header className="fold-routing-inspector-header">
                  <div>
                    <h4>{detail.title}</h4>
                    <span>{triggerSummary(detail.trigger)}</span>
                  </div>
                  <RoutingHealth
                    health={selectedSummary.health}
                    running={Boolean(selectedSummary.activeRun)}
                    starting={Boolean(runWatches[selectedSummary.routingId]) && !selectedSummary.activeRun}
                  />
                </header>

                {detail.health === "suspended" ? (
                  <p className="fold-routing-suspension">
                    {detail.suspension?.reason ?? missingSpacesMessage(detail.suspension?.missingSpaces)}
                  </p>
                ) : null}

                <dl className="fold-routing-facts">
                  <div><dt>Next</dt><dd>{detail.nextScheduledAt ? formatDateTime(detail.nextScheduledAt) : "—"}</dd></div>
                  <div><dt>Last run</dt><dd>{detail.lastRun ? `${outcomeLabel(detail.lastRun.outcome)} · ${formatDateTime(detail.lastRun.startedAt)}` : "Not run yet"}</dd></div>
                </dl>

                <section className="fold-routing-detail-section" aria-labelledby="fold-routing-steps-title">
                  <h5 id="fold-routing-steps-title">Steps</h5>
                  <ol className="fold-routing-step-list">
                    {detail.steps.map((step) => <RoutingStep key={step.id} step={step} />)}
                  </ol>
                </section>

                <RoutingActions
                  routing={detail}
                  pending={pending}
                  storeUnavailable={storeUnavailable}
                  wideningUnavailable={wideningUnavailable}
                  runQueued={Boolean(runWatches[detail.routingId]) && !detail.activeRun}
                  onRun={(key, operation) => void runAction(key, operation)}
                  onRunAdmitted={(routingId, runId) => {
                    setRunWatches((current) => ({
                      ...current,
                      [routingId]: { startedAt: current[routingId]?.startedAt ?? Date.now(), runId },
                    }));
                  }}
                  onDeleted={() => selectRouting(null)}
                />

                <section className="fold-routing-detail-section fold-routing-history" aria-labelledby="fold-routing-history-title">
                  <div className="fold-routing-section-heading">
                    <h5 id="fold-routing-history-title">Recent runs</h5>
                    {history.truncated ? <span>Newest shown</span> : null}
                  </div>
                  {history.damagedLineCount ? <small className="settings-inline-error">Some older run records could not be read.</small> : null}
                  {!history.runs.length ? <p>Nothing has run yet.</p> : (
                    <div className="fold-routing-run-list">
                      {history.runs.map((run) => <RoutingRun key={run.runId} run={run} />)}
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RoutingActions({ routing, pending, storeUnavailable, wideningUnavailable, runQueued, onRun, onRunAdmitted, onDeleted }: {
  routing: FoldRoutingDetailView;
  pending: string[];
  storeUnavailable: boolean;
  wideningUnavailable: boolean;
  runQueued: boolean;
  onRun: (key: string, operation: () => Promise<string | null>) => void;
  onRunAdmitted: (routingId: string, runId: string) => void;
  onDeleted: () => void;
}) {
  const anyPending = pending.some((key) => key.endsWith(`:${routing.routingId}`));
  const isRunning = Boolean(routing.activeRun);
  const canDelete = !isRunning
    && (routing.health === "disabled" || routing.health === "suspended" || routing.health === "completed");

  return (
    <section className="fold-routing-actions" aria-label="Routing actions">
      <div className="settings-actions">
        {routing.health === "enabled" ? (
          <button
            className="primary-button"
            type="button"
            disabled={wideningUnavailable || anyPending || isRunning || runQueued}
            onClick={() => onRun(`run:${routing.routingId}`, async () => {
              const requested = await routingBridge().run(routing.routingId);
              onRunAdmitted(routing.routingId, requested.runId);
              return "Run requested";
            })}
          >
            {pending.includes(`run:${routing.routingId}`) || runQueued ? "Starting…" : "Run a copy now"}
          </button>
        ) : null}
        {isRunning ? (
          <button
            className="secondary-button danger"
            type="button"
            disabled={pending.includes(`stop:${routing.routingId}`)}
            onClick={() => onRun(`stop:${routing.routingId}`, async () => {
              await routingBridge().stop(routing.routingId);
              return "Stopping run";
            })}
          >
            {pending.includes(`stop:${routing.routingId}`) ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        {routing.health === "enabled" ? (
          <button
            className="secondary-button"
            type="button"
            disabled={storeUnavailable || anyPending}
            onClick={() => onRun(`disable:${routing.routingId}`, async () => {
              await routingBridge().disable(routing.routingId);
              return "Routing turned off";
            })}
          >
            {pending.includes(`disable:${routing.routingId}`) ? "Turning off…" : "Turn off"}
          </button>
        ) : null}
        {routing.health === "disabled" || routing.health === "suspended" ? (
          <button
            className="primary-button"
            type="button"
            disabled={wideningUnavailable || anyPending}
            onClick={() => onRun(`enable:${routing.routingId}`, async () => {
              const result = await routingBridge().stageEnable(routing.routingId);
              return result.state === "executed" ? "Routing turned on" : "Ready for review";
            })}
          >
            {pending.includes(`enable:${routing.routingId}`) ? "Preparing…" : "Ask to turn on"}
          </button>
        ) : null}
        {canDelete ? (
          <button
            className="secondary-button danger"
            type="button"
            disabled={storeUnavailable || anyPending}
            onClick={() => {
              if (!window.confirm(`Delete “${routing.title}”? Its run history will remain.`)) return;
              onRun(`delete:${routing.routingId}`, async () => {
                await routingBridge().delete(routing.routingId);
                onDeleted();
                return "Routing deleted";
              });
            }}
          >
            {pending.includes(`delete:${routing.routingId}`) ? "Deleting…" : "Delete"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RoutingHealth({ health, running, starting = false }: { health: FoldRoutingHealth; running: boolean; starting?: boolean }) {
  const label = running
    ? "Running"
    : starting
      ? "Starting"
    : health === "enabled"
      ? "On"
      : health === "disabled"
        ? "Off"
        : health === "completed"
          ? "Done"
          : "Suspended";
  return <span className={`fold-routing-health ${running ? "running" : health}`}>{label}</span>;
}

function RoutingStep({ step }: { step: FoldRoutingStepView }) {
  if (step.kind === "chat") {
    return (
      <li>
        <div className="fold-routing-step-heading"><strong>Chat</strong><span>{spaceLabel(step.space)}</span></div>
        <blockquote>{step.message}</blockquote>
      </li>
    );
  }
  if (step.kind === "files") {
    return (
      <li>
        <div className="fold-routing-step-heading"><strong>Copy files</strong><span>{spaceLabel(step.fromSpace)} → {spaceLabel(step.toSpace)}</span></div>
        <p>{filesSourceSummary(step.source)} into <code>{step.to || "/"}</code></p>
      </li>
    );
  }
  return (
    <li>
      <div className="fold-routing-step-heading"><strong>Run Checks</strong><span>{spaceLabel(step.space)}</span></div>
      <p>{step.checkId ? `Check ${step.checkId}` : "All enabled Checks"}</p>
    </li>
  );
}

function RoutingRun({ run }: { run: FoldRoutingHistoryRunView }) {
  return (
    <details className="fold-routing-run">
      <summary>
        <span className={`fold-routing-run-dot ${run.outcome}`} aria-hidden="true" />
        <strong>{outcomeLabel(run.outcome)}</strong>
        <span>{formatDateTime(run.startedAt)}</span>
      </summary>
      <div className="fold-routing-run-detail">
        {run.cause ? <p>{run.cause}</p> : null}
        {run.detail ? <p>{run.detail}</p> : null}
        {run.hops.length ? (
          <ol>
            {run.hops.map((hop) => (
              <li key={hop.hopId}>
                <div><strong>{hopLabel(hop.kind)}</strong><span>{outcomeLabel(hop.outcome)}{hop.spaceName ? ` · ${hop.spaceName}` : ""}</span></div>
                {hop.detail ? <small>{hop.detail}</small> : null}
                {hop.evidence?.map((item) => <small key={`${hop.hopId}:${item.label}:${item.value}`}>{item.label}: <code>{item.value}</code></small>)}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </details>
  );
}

function triggerSummary(trigger: FoldRoutingTriggerView): string {
  if (trigger.summary) return trigger.summary;
  if (trigger.kind === "manual") return "Manual only";
  if (trigger.kind === "interval") return `Every ${formatMinutes(trigger.intervalMinutes)}`;
  if (trigger.kind === "at") return `Once · ${formatDateTime(trigger.at)}`;
  const source = trigger.source;
  const space = source.spaceName ?? source.spaceId;
  if (source.kind === "check-run") return `After a Check settles in ${space}`;
  return `After ${source.appId} · ${source.automationId} settles in ${space}`;
}

function filesSourceSummary(source: Extract<FoldRoutingStepView, { kind: "files" }>["source"]): string {
  if (source.kind === "paths") return source.paths.join(", ");
  if (source.kind === "tree") {
    const suffix = source.extensions.length ? ` (${source.extensions.join(", ")})` : "";
    return `${source.path || "/"}${source.recursive ? " and its folders" : ""}${suffix}`;
  }
  const suffix = source.extensions?.length ? ` matching ${source.extensions.join(", ")}` : "";
  return `Files created by ${source.step}${suffix} · up to ${source.maxFiles} files / ${formatBytes(source.maxTotalBytes)}`;
}

function lastRunSummary(routing: FoldRoutingSummaryView): string {
  if (!routing.lastRun) return routing.health === "completed" ? "Completed" : "Not run yet";
  return `${outcomeLabel(routing.lastRun.outcome)} · ${formatDateTime(routing.lastRun.startedAt)}`;
}

function missingSpacesMessage(spaces: FoldRoutingSpaceRef[] | undefined): string {
  if (!spaces?.length) return "A referenced Space is no longer available. Review the routing before turning it on again.";
  return `${spaces.map(spaceLabel).join(", ")} ${spaces.length === 1 ? "is" : "are"} no longer available. Review the routing before turning it on again.`;
}

function spaceLabel(space: FoldRoutingSpaceRef): string {
  return space.spaceName ?? space.spaceId;
}

function outcomeLabel(outcome: FoldRoutingOutcome): string {
  return ({
    accepted: "Started",
    succeeded: "Succeeded",
    failed: "Failed",
    stopped: "Stopped",
    interrupted: "Interrupted",
    skipped: "Skipped",
    lapsed: "Missed",
  })[outcome];
}

function hopLabel(kind: FoldRoutingHistoryHopView["kind"]): string {
  return kind === "chat" ? "Chat" : kind === "files" ? "Copy files" : "Run Checks";
}

function formatMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function routingBridge() {
  const bridge = window.workFoldDesktop?.routings;
  if (!bridge) throw new Error("Routing settings are available in the desktop app.");
  return bridge;
}
