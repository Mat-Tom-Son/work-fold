import { IncludedMcpSetup } from "./IncludedMcpSetup";
import { IncludedChromeSetup } from "./IncludedChromeSetup";
import { useEffect, useRef, useState } from "react";
import type { IncludedToolDefinition, IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";
import { includedToolReadiness } from "../../lib/included-tool-readiness";
import "./included-tool-setup.css";

type Result = { status: IncludedToolStatus };

type SetupProps = { spaceId: string; tool: IncludedToolDefinition; enabled: boolean; onStatusChange?: (status: IncludedToolStatus | null) => void };

export function IncludedToolSetup(props: SetupProps) {
  if (props.tool.id === "chrome") return <IncludedChromeSetup spaceId={props.spaceId} enabled={props.enabled} onStatusChange={props.onStatusChange} />;
  return <IncludedToolSetupSession key={`${props.spaceId}:${props.tool.id}`} {...props} />;
}

function IncludedToolSetupSession({ spaceId, tool, enabled, onStatusChange }: SetupProps) {
  const [status, setStatus] = useState<IncludedToolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const statusRevision = useRef(0);
  const statusListener = useRef(onStatusChange);
  statusListener.current = onStatusChange;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const revision = statusRevision.current;
    let cancelled = false;
    void api<{ tools: IncludedToolStatus[] }>(`/api/agent/included-tools?spaceId=${encodeURIComponent(spaceId)}`, { signal: controller.signal })
      .then(({ tools }) => {
        if (cancelled || statusRevision.current !== revision) return;
        const next = tools.find((item) => item.id === tool.id) ?? null;
        setStatus(next);
        if (next) statusListener.current?.(next);
      })
      .catch((caught) => { if (!cancelled && statusRevision.current === revision) setError(errorText(caught)); });
    return () => { cancelled = true; alive.current = false; controller.abort(); request.current?.abort(); };
  }, [spaceId, tool.id]);

  async function act(action: string) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    statusRevision.current += 1;
    setStatus(null); statusListener.current?.(null);
    setBusy(true); setError(null);
    try {
      const result = await api<Result>("/api/agent/included-tools/setup", { method: "POST", signal: controller.signal, body: { spaceId, id: tool.id, action, ...(action === "connect-brave" ? { secret } : {}) } });
      if (alive.current && !controller.signal.aborted) { setStatus(result.status); statusListener.current?.(result.status); setSecret(""); }
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) {
        setError(errorText(caught));
        // A failed check must not keep a previously successful badge. Read the
        // host's remaining evidence; transport errors alone prove no readiness.
        try {
          const { tools } = await api<{ tools: IncludedToolStatus[] }>(`/api/agent/included-tools?spaceId=${encodeURIComponent(spaceId)}`, { signal: controller.signal });
          if (alive.current && !controller.signal.aborted) {
            const next = tools.find((item) => item.id === tool.id) ?? null;
            setStatus(next); statusListener.current?.(next);
          }
        } catch { /* The original actionable error stays visible. */ }
      }
    }
    finally { if (request.current === controller) request.current = null; if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  const label = !enabled ? "Turned off" : includedToolReadiness(status ?? undefined).label;
  const needsSetup = enabled && status?.state !== "ready";
  const requirement = enabled && status && ["setup_required", "unavailable"].includes(status.state) ? status.detail : null;
  return <section className="included-tool-setup" aria-label={`${tool.title} setup`} aria-busy={busy}>
    {tool.id !== "mcp" || !enabled ? <div className="included-tool-status"><strong role="status">{label}</strong>{tool.id !== "mcp" ? <button type="button" className="professional-button professional-button-secondary" disabled={busy || !enabled} onClick={() => void act(tool.id === "computer" ? "recheck" : "check")}>{busy ? "Checking…" : "Check"}</button> : null}</div> : null}
    {requirement ? <p>{requirement}</p> : null}
    {error ? <p className="included-tool-error" role="alert">{error}</p> : null}
    {tool.id === "computer" ? <>
      {needsSetup ? <button className="professional-button professional-button-primary" type="button" disabled={busy} onClick={() => void act("request-permissions")}>Set up permissions</button> : null}
      <details className="included-tool-optional"><summary>Permissions</summary>
        <div className="included-tool-actions">
          <button className="professional-button professional-button-secondary" type="button" disabled={busy || !enabled} onClick={() => void act("accessibility")}>Accessibility</button>
          <button className="professional-button professional-button-secondary" type="button" disabled={busy || !enabled} onClick={() => void act("screen-recording")}>Screen Recording</button>
        </div>
        {status?.facts ? <dl className="included-tool-facts">{Object.entries(status.facts).map(([key, value]) => <div key={key}><dt>{key === "accessibility" ? "Accessibility" : key === "screenRecording" ? "Screen Recording" : key}</dt><dd>{typeof value === "boolean" ? value ? "Allowed" : "Not verified" : value}</dd></div>)}</dl> : null}
      </details>
    </> : null}
    {tool.id === "web" ? <details className="included-tool-optional"><summary>Brave Search</summary><form onSubmit={(event) => { event.preventDefault(); void act("connect-brave"); }}><label>API key<input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={busy} /></label><div className="included-tool-actions"><button type="submit" className="professional-button professional-button-primary" disabled={busy || !enabled || !secret.trim()}>Connect</button><button type="button" className="professional-button professional-button-secondary" disabled={busy} onClick={() => void act("disconnect-brave")}>Use DuckDuckGo</button></div></form></details> : null}
    {tool.id === "mcp" ? <IncludedMcpSetup spaceId={spaceId} enabled={enabled} /> : null}
  </section>;
}
