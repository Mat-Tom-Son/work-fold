import { IncludedMcpSetup } from "./IncludedMcpSetup";
import { useEffect, useRef, useState } from "react";
import type { IncludedToolDefinition, IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";
import "./included-tool-setup.css";

type Result = { status: IncludedToolStatus; revealPath?: string; openUrl?: string };

export function IncludedToolSetup({ spaceId, tool, enabled }: { spaceId: string; tool: IncludedToolDefinition; enabled: boolean }) {
  const [status, setStatus] = useState<IncludedToolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let cancelled = false;
    void api<{ tools: IncludedToolStatus[] }>(`/api/agent/included-tools?spaceId=${encodeURIComponent(spaceId)}`, { signal: controller.signal })
      .then(({ tools }) => { if (!cancelled) setStatus(tools.find((item) => item.id === tool.id) ?? null); })
      .catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    return () => { cancelled = true; alive.current = false; controller.abort(); request.current?.abort(); };
  }, [spaceId, tool.id]);

  async function act(action: string) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    try {
      const result = await api<Result>("/api/agent/included-tools/setup", { method: "POST", signal: controller.signal, body: { spaceId, id: tool.id, action, ...(action === "connect-brave" ? { secret } : {}) } });
      if (alive.current) { setStatus(result.status); setPath(result.revealPath ?? null); setSecret(""); }
    } catch (caught) { if (alive.current) setError(errorText(caught)); }
    finally { request.current = null; if (alive.current) setBusy(false); }
  }
  const label = !enabled ? "Turned off" : status?.state === "ready" ? "Ready" : status?.state === "setup_required" ? "Setup needed" : status?.state === "unavailable" ? "Unavailable" : "Setup";
  return <section className="included-tool-setup" aria-label={`${tool.title} setup`} aria-busy={busy}>
    <div className="included-tool-status"><strong>{label}</strong>{tool.id !== "mcp" ? <button type="button" className="professional-button professional-button-secondary" disabled={busy || !enabled} onClick={() => void act("check")}>{busy ? "Checking…" : "Check setup"}</button> : null}</div>
    <p role="status">{!enabled ? "Turn this Extension on to use it in new Assistant work." : status?.detail ?? "Readiness has not been checked."}</p>
    {enabled && status && status.state !== "unknown" && tool.id !== "web" ? <small>Last checked {new Date(status.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small> : null}
    {error ? <p className="included-tool-error" role="alert">{error}</p> : null}
    {tool.id === "computer" ? <>
      <p>macOS needs permission for <strong>work-fold Computer</strong> to see and operate apps. Requires macOS 14 or later.</p>
      <div className="included-tool-actions">
        <button className="professional-button professional-button-primary" type="button" disabled={busy || !enabled} onClick={() => void act("request-permissions")}>Set up permissions</button>
        <button className="professional-button professional-button-secondary" type="button" disabled={busy || !enabled} onClick={() => void act("accessibility")}>Accessibility</button>
        <button className="professional-button professional-button-secondary" type="button" disabled={busy || !enabled} onClick={() => void act("screen-recording")}>Screen Recording</button>
        <button className="professional-button professional-button-secondary" type="button" disabled={busy || !enabled} onClick={() => void act("recheck")}>Recheck after changes</button>
      </div>
      {status?.facts ? <dl className="included-tool-facts">{Object.entries(status.facts).map(([key, value]) => <div key={key}><dt>{key === "accessibility" ? "Accessibility" : key === "screenRecording" ? "Screen Recording" : key}</dt><dd>{typeof value === "boolean" ? value ? "Allowed" : "Not verified" : value}</dd></div>)}</dl> : null}
    </> : null}
    {tool.id === "chrome" ? <>
      <p>Add the included companion to your Chrome profile once. It lets the Assistant work with your signed-in sites.</p>
      <button className="professional-button professional-button-primary" type="button" disabled={busy || !enabled} onClick={() => void act("prepare-companion")}>Set up Chrome</button>
      {path ? <div className="included-companion-path"><p>In Chrome → Extensions, enable Developer mode, choose <strong>Load unpacked</strong>, then select this folder. If already installed, choose <strong>Reload</strong>.</p><code>{path}</code><button className="professional-button professional-button-secondary" type="button" onClick={() => void navigator.clipboard.writeText(path).catch((caught) => setError(errorText(caught)))}>Copy folder path</button></div> : null}
    </> : null}
    {tool.id === "web" ? <details className="included-tool-optional"><summary>Optional Brave Search connection</summary><p>Search already works with DuckDuckGo. Connect Brave Search to use its API instead.</p><form onSubmit={(event) => { event.preventDefault(); void act("connect-brave"); }}><label>Brave Search API key<input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={busy} /></label><div className="included-tool-actions"><button type="submit" className="professional-button professional-button-primary" disabled={busy || !enabled || !secret.trim()}>Connect</button><button type="button" className="professional-button professional-button-secondary" disabled={busy} onClick={() => void act("disconnect-brave")}>Use DuckDuckGo</button></div></form></details> : null}
    {tool.id === "mcp" ? <IncludedMcpSetup spaceId={spaceId} enabled={enabled} /> : null}
  </section>;
}
