import { useEffect, useRef, useState } from "react";
import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";
import { includedToolReadiness } from "../../lib/included-tool-readiness";
import { includedToolsPath, includedToolSetupBody } from "../../lib/included-tool-scope";
import { IncludedWaylandSetup } from "./IncludedWaylandSetup";

/** Portal sharing belongs to the app, including before the first work-folder. */
export function IncludedLinuxComputerSetup({ workFolderId, enabled, onStatusChange }: {
  workFolderId?: string; enabled: boolean; onStatusChange?(status: IncludedToolStatus | null): void;
}) {
  const [status, setStatus] = useState<IncludedToolStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const listener = useRef(onStatusChange); listener.current = onStatusChange;
  useEffect(() => {
    const controller = new AbortController();
    void api<{ tools: IncludedToolStatus[] }>(includedToolsPath(workFolderId), { signal: controller.signal })
      .then(({ tools }) => {
        if (controller.signal.aborted) return;
        const next = tools.find(tool => tool.id === "computer"); setStatus(next); listener.current?.(next ?? null);
      }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [workFolderId]);

  async function check() {
    if (request.current || !enabled) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined);
    try {
      const { status: next } = await api<{ status: IncludedToolStatus }>("/api/agent/included-tools/setup", {
        method: "POST", signal: controller.signal, body: includedToolSetupBody(workFolderId, "computer", "start-check"),
      });
      if (!controller.signal.aborted) { setStatus(next); listener.current?.(next); }
    } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  const wayland = Boolean(status?.computerSession);
  return <section className="included-tool-setup computer-setup" aria-label="Computer Control setup">
    <div className="included-tool-status"><strong role="status">{!enabled ? "Turned Off" : includedToolReadiness(status).label}</strong></div>
    {wayland ? <IncludedWaylandSetup workFolderId={workFolderId} enabled={enabled} onStatusChange={next => { setStatus(next); listener.current?.(next); }} /> : <>
      <p>{status?.detail ?? "Check your desktop's accessibility and screen control."}</p>
      <button className="ui-control ui-control--primary" type="button" disabled={busy || !enabled} onClick={() => void check()}>{busy ? "Checking…" : "Start and Check"}</button>
    </>}
    {error ? <p className="included-tool-error" role="alert">{error}</p> : null}
    <details className="included-tool-optional"><summary>Technical details</summary>
      {wayland ? <p>One Chat controls the desktop at a time. Typing goes to the focused app. Locking, sleep, or quitting work-fold ends sharing.</p> : null}
      {wayland ? <button className="ui-control" type="button" disabled={busy || !enabled} onClick={() => void check()}>{busy ? "Checking…" : "Check accessibility"}</button> : null}
      {status?.facts ? <dl className="included-tool-facts">{Object.entries(status.facts).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "boolean" ? value ? "Allowed" : "Not verified" : value}</dd></div>)}</dl> : null}
    </details>
  </section>;
}
