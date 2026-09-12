import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Braces, Check, Copy, RefreshCw, Search, X } from "lucide-react";
import type { ModelContextInspection as ModelContextInspectionRecord, ModelContextInspectionState, ModelContextInspectionSummary, ModelContextSnapshot } from "../../../../src/shared/model-context-inspection";
import { workFoldModelContextLimits } from "../../../../src/shared/fold-limits";
import { useModalDialog } from "../../hooks/useModalDialog";
import { api, errorText } from "../../lib/api";

interface InspectorProps {
  spaceId?: string;
  conversationId?: string;
  scopeLabel?: string;
  fixtureMode?: boolean;
  onClose: () => void;
}

/** Scope changes remount the inspector: a late response can never enter another Chat. */
export function ModelContextInspector(props: InspectorProps) {
  return <ContextInspector key={JSON.stringify([props.spaceId ?? null, props.conversationId ?? null, props.fixtureMode ?? false])} {...props} />;
}

export function InspectContextButton({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return <button className={`inspect-context-trigger${compact ? " compact" : ""}`} type="button" onClick={onClick} aria-label="Inspect context" title="Inspect model context">
    <Braces size={14} aria-hidden="true" />{compact ? null : <span>Inspect context</span>}
  </button>;
}

function ContextInspector({ spaceId, conversationId, scopeLabel = "All model requests on this desktop", fixtureMode = false, onClose }: InspectorProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });
  const [state, setState] = useState<ModelContextInspectionState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const [record, setRecord] = useState<ModelContextInspectionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"assembled" | "provider_payload" | "provenance">("assembled");
  const [sample, setSample] = useState(0);
  const [copied, setCopied] = useState(false);
  const jsonRef = useRef<HTMLPreElement>(null);
  const copyGeneration = useRef(0);
  const mounted = useRef(true);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const fixture = useRef(createModelContextFixture(spaceId, conversationId));
  const params = new URLSearchParams();
  if (spaceId) params.set("spaceId", spaceId);
  if (conversationId) params.set("conversationId", conversationId);
  const filter = params.size ? `?${params}` : "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      detailGeneration.current++;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, []);

  const request = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try { return await api<T>(path, { ...(body === undefined ? {} : { method: "POST", body }), signal: controller.signal }); }
    finally { controllers.current.delete(controller); }
  }, []);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = fixtureMode ? fixture.current.state : await request<ModelContextInspectionState>(`/api/model-context${filter}`);
      if (!mounted.current || current !== generation.current) return;
      setState(next);
      setSelectedId((id) => next.records.some((item) => item.id === id) ? id : next.records[0]?.id ?? null);
      if (!next.enabled || !next.records.length) setRecord(null);
    } catch (caught) {
      if (mounted.current && current === generation.current) setError(errorText(caught));
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [filter, fixtureMode, request]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (fixtureMode) return;
    const refreshOnFocus = () => { if (!busyRef.current) void refresh(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [fixtureMode, refresh]);
  useEffect(() => {
    if (fixtureMode || !state?.records.length) return;
    // A copy displayed in this window expires with its source capture too.
    const expiresAt = Math.min(...state.records.map((item) => item.createdAt + state.limits.retentionMs));
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - state.limits.retentionMs;
      const records = state.records.filter((item) => item.createdAt > cutoff);
      setState({ ...state, records });
      if (!records.some((item) => item.id === selectedRef.current)) {
        setSelectedId(records[0]?.id ?? null);
        setRecord(null);
      }
    }, Math.max(1, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [fixtureMode, state]);

  useEffect(() => {
    const current = ++detailGeneration.current;
    setCopied(false);
    if (!selectedId) { setRecord(null); setDetailLoading(false); return; }
    setDetailLoading(true);
    const load = async () => {
      try {
        const result = fixtureMode
          ? { record: fixture.current.records.find((item) => item.id === selectedId)! }
          : await request<{ record: ModelContextInspectionRecord }>(`/api/model-context/${encodeURIComponent(selectedId)}${filter}`);
        if (!mounted.current || current !== detailGeneration.current || selectedRef.current !== selectedId) return;
        setRecord(result.record);
        setSample((index) => Math.min(index, Math.max(0, result.record.payloads.length - 1)));
      } catch (caught) {
        if (mounted.current && current === detailGeneration.current) { setRecord(null); setError(errorText(caught)); }
      } finally { if (mounted.current && current === detailGeneration.current) setDetailLoading(false); }
    };
    void load();
    // Refresh the selected capture in place when the server reports a new snapshot.
  }, [selectedId, state, filter, fixtureMode, request]);

  async function changeRecording(body: { enabled: boolean } | { clear: true }) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    ++generation.current;
    ++detailGeneration.current;
    if ("clear" in body || !body.enabled) { setRecord(null); setSelectedId(null); setQuery(""); }
    try {
      let next: ModelContextInspectionState;
      if (fixtureMode) {
        fixture.current.state = { ...fixture.current.state, ...("enabled" in body ? { enabled: body.enabled } : {}), records: [] };
        fixture.current.records = [];
        next = fixture.current.state;
      } else next = await request<ModelContextInspectionState>(`/api/model-context${filter}`, body);
      if (mounted.current) {
        setState(next);
        setSelectedId((id) => next.records.some((item) => item.id === id) ? id : next.records[0]?.id ?? null);
        if (!next.records.length) setRecord(null);
        setLoading(false);
      }
    } catch (caught) { if (mounted.current) setError(errorText(caught)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  const activeRecord = record?.id === selectedId ? record : null;
  const snapshot = activeRecord ? stage === "assembled" ? activeRecord.assembled : stage === "provenance" ? activeRecord.provenance : activeRecord.payloads[sample] : undefined;
  const json = useMemo(() => snapshot ? JSON.stringify(snapshot.value, null, 2) : "", [snapshot]);
  useEffect(() => { copyGeneration.current++; setCopied(false); }, [json]);
  const matches = useMemo(() => findMatches(json, query), [json, query]);
  useEffect(() => { if (query) jsonRef.current?.querySelector("mark")?.scrollIntoView?.({ block: "nearest" }); }, [query, json]);
  const selectedSummary = state?.records.find((item) => item.id === selectedId);

  async function copyJson() {
    const current = copyGeneration.current;
    try {
      await navigator.clipboard.writeText(json);
      if (mounted.current && current === copyGeneration.current) setCopied(true);
    } catch { if (mounted.current && current === copyGeneration.current) setError("Couldn’t copy. You can select and copy the displayed text."); }
  }

  return <div className="model-context-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="model-context-inspector" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="model-context-heading">
        <div><h2 id={titleId}>Model context</h2><p>{scopeLabel}</p></div>
        <button ref={closeRef} type="button" className="model-context-icon" onClick={onClose} aria-label="Close context inspector"><X size={18} /></button>
      </header>
      <div className="model-context-recording">
        <label><input type="checkbox" checked={state?.enabled ?? false} disabled={!state || busy} onChange={(event) => void changeRecording({ enabled: event.target.checked })} /><strong>Record model context</strong></label>
        <div className="model-context-actions">
          <button type="button" onClick={() => void refresh()} disabled={loading || busy}><RefreshCw size={13} aria-hidden="true" />Refresh</button>
          <button type="button" onClick={() => void changeRecording({ clear: true })} disabled={!state || busy}>Clear all</button>
        </div>
        <p>Records future requests across this desktop, including private message text. Text can contain secrets; redaction is partial. Images appear as metadata; authentication headers are excluded. Turning this off clears all captures.</p>
        {state ? <small>Kept in memory for up to {Math.round(state.limits.retentionMs / 60_000)} minutes · {state.limits.records} requests · {formatBytes(state.limits.totalBytes)} total</small> : null}
      </div>
      {error ? <p className="model-context-error" role="alert">{error}</p> : null}
      {!state || !state.records.length ? <div className="model-context-empty" role="status">
        <Braces size={26} aria-hidden="true" />
        <h3>{loading ? "Loading captures…" : state?.enabled ? "No requests captured here yet" : "Recording is off"}</h3>
        <p>{loading ? "Reading saved diagnostics." : state?.enabled ? "Use the Assistant, then refresh. Opening this inspector does not call a model." : "Turn on recording to inspect future model requests. Earlier context is not reconstructed."}</p>
      </div> : <div className="model-context-workspace">
        <label className="model-context-request-picker">Request
          <select value={selectedId ?? ""} onChange={(event) => { setSelectedId(event.target.value); setSample(0); setError(null); }}>
            {state.records.map((item) => <option key={item.id} value={item.id}>{requestLabel(item)}</option>)}
          </select>
        </label>
        {selectedSummary ? <div className="model-context-meta">
          <strong>{purposeLabel(selectedSummary.owner.purpose)}</strong>
          <span>{selectedSummary.provider} / {selectedSummary.model}</span>
          <time dateTime={new Date(selectedSummary.createdAt).toISOString()}>{new Date(selectedSummary.createdAt).toLocaleString()}</time>
          <span title={selectedSummary.owner.conversationId}>Chat {selectedSummary.owner.conversationId}</span>
          <span>{statusLabel(selectedSummary.status)} · {formatBytes(selectedSummary.bytes)}</span>
        </div> : null}
        <div className="model-context-stages" role="tablist" aria-label="Capture stage">
          {([ ["assembled", "Assembled context"], ["provider_payload", "Provider payload observed"], ["provenance", "Provenance"] ] as const).map(([value, label], index, stages) => <button key={value} id={`${titleId}-${value}`} role="tab" aria-selected={stage === value} aria-controls={`${titleId}-content`} tabIndex={stage === value ? 0 : -1} onClick={() => setStage(value)} onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const next = (index + (event.key === "ArrowRight" ? 1 : -1) + stages.length) % stages.length;
            setStage(stages[next][0]);
            (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
          }}>{label}</button>)}
        </div>
        <div className="model-context-content" id={`${titleId}-content`} role="tabpanel" aria-labelledby={`${titleId}-${stage}`} aria-busy={detailLoading}>
          <p className="model-context-stage-note">{stage === "provenance" ? "Origins from the loaded Pi runtime at dispatch. File contents are not reconstructed afterward; available Skills are not evidence they were read." : stage === "assembled" ? "Context assembled by Pi before provider conversion. This can differ from the provider payload." : "Payload exposed by the provider adapter. Capture does not prove network delivery or model completion."}</p>
          {stage === "provider_payload" && (activeRecord?.payloads.length ?? 0) > 1 ? <label className="model-context-sample">Payload sample <select value={sample} onChange={(event) => setSample(Number(event.target.value))}>{activeRecord?.payloads.map((item, index) => <option value={index} key={index}>{index + 1} · {new Date(item.capturedAt).toLocaleTimeString()}</option>)}</select></label> : null}
          {snapshot ? <>
            {snapshot.truncated || snapshot.omissions.length ? <p className="model-context-omissions">{snapshot.truncated ? "This snapshot is truncated. " : ""}{snapshot.omissions.join(" · ")}</p> : null}
            <div className="model-context-search-row">
              <label><Search size={14} aria-hidden="true" /><input type="search" placeholder="Find in this snapshot" aria-label="Find in snapshot" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              {query ? <span role="status">{matches.length === 200 ? "200+" : matches.length} matches</span> : null}
              <button type="button" onClick={() => void copyJson()} title="Copy displayed JSON">{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? "Copied" : "Copy"}</span></button>
            </div>
            <pre ref={jsonRef} className="model-context-json" tabIndex={0} aria-label="Captured JSON"><HighlightedJson text={json} matches={matches} queryLength={query.length} /></pre>
          </> : <div className="model-context-no-payload" role="status">{detailLoading ? "Loading snapshot…" : stage === "provenance" ? "No runtime provenance was captured for this request." : stage === "provider_payload" ? "No provider payload was observed for this request. The adapter may not expose it, or the request has not reached that stage. Assembled context is still available." : "This capture is no longer available. Refresh to see the remaining requests."}</div>}
        </div>
      </div>}
      <footer className="model-context-coverage">Captures work-fold’s Pi requests. Extensions using their own model transport may be absent.</footer>
    </section>
  </div>;
}

function findMatches(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const positions: number[] = [];
  let index = haystack.indexOf(needle);
  while (index >= 0 && positions.length < 200) { positions.push(index); index = haystack.indexOf(needle, index + Math.max(1, needle.length)); }
  return positions;
}
function HighlightedJson({ text, matches, queryLength }: { text: string; matches: number[]; queryLength: number }) {
  if (!matches.length) return <>{text}</>;
  let end = 0;
  return <>{matches.map((start) => { const before = text.slice(end, start); end = start + queryLength; return <span key={start}>{before}<mark>{text.slice(start, end)}</mark></span>; })}{text.slice(end)}</>;
}
function formatBytes(bytes: number): string { return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function purposeLabel(purpose: string): string { return ({ assistant: "Assistant", chat: "Chat", title: "Chat title", check: "Check", app_inference: "App inference", compaction: "Context compaction" } as Record<string, string>)[purpose] ?? purpose.replace(/[_-]/g, " "); }
function statusLabel(status: ModelContextInspectionSummary["status"]): string { return status === "response_received" ? "Response started" : status === "dispatch_error" ? "Dispatch error" : "Captured"; }
function requestLabel(record: ModelContextInspectionSummary): string { return `${new Date(record.createdAt).toLocaleTimeString()} · ${purposeLabel(record.owner.purpose)} · ${record.model}`; }

/** Inert fixture: no capture APIs, model requests, or recording changes on the host. */
export function createModelContextFixture(_spaceId?: string, conversationId = "fixture-chat") {
  const now = new Date("2026-09-11T20:30:00Z").getTime();
  const snapshot = (value: ModelContextSnapshot["value"]): ModelContextSnapshot => ({ capturedAt: now, value, truncated: false, omissions: ["Image bytes omitted; image metadata retained."], bytes: 2400 });
  const record: ModelContextInspectionRecord = {
    id: "fixture-context-one", owner: { spaceRoot: "/example/Space", conversationId, sessionId: "fixture-session", purpose: "chat" },
    provider: "example", model: "Vision model", api: "example", createdAt: now, status: "response_received", stage: "provider_payload", payloadSamples: 1, truncated: false, bytes: 4800,
    assembled: snapshot({ systemPrompt: "Verify the requested result using the available tools.", messages: [{ role: "user", content: "Check the report’s layout." }, { role: "toolResult", toolName: "read", content: [{ type: "text", text: "Page 1 of 3, revision 7. Remaining pages have not been inspected." }, { type: "image", mimeType: "image/png", bytes: 18742, data: "[image bytes omitted]" }] }], tools: [{ name: "read", description: "Read text or images" }] }),
    payloads: [snapshot({ model: "Vision model", input: [{ role: "user", content: "Check the report’s layout." }, { role: "tool", content: [{ type: "text", text: "Page 1 of 3, revision 7." }, { type: "image", mimeType: "image/png", bytes: 18742, data: "[image bytes omitted]" }] }] })],
  };
  const second = { ...record, id: "fixture-context-two", owner: { ...record.owner, purpose: "title" }, model: "Text model", payloads: [], payloadSamples: 0, stage: "assembled" as const, createdAt: now - 5000,
    assembled: { ...snapshot({ systemPrompt: "Write a short title for this Chat.", messages: [{ role: "user", content: "Check the report’s layout." }] }), omissions: [] },
  };
  const records = [record, second];
  return { records, state: { enabled: true, records: records.map(({ assembled: _a, payloads: _p, ...summary }) => summary), limits: { ...workFoldModelContextLimits } } as ModelContextInspectionState };
}
