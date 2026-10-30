import { useEffect, useRef, useState } from "react";
import { Check, Circle, Loader2 } from "lucide-react";

import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";
import { includedToolReadiness } from "../../lib/included-tool-readiness";
import { includedToolsPath, includedToolSetupBody } from "../../lib/included-tool-scope";
import { IncludedLinuxComputerSetup } from "./IncludedLinuxComputerSetup";

type ComputerAction = "check" | "request-permissions" | "accessibility" | "screen-recording" | "recheck";

/** How long Allow keeps watching System Settings for the person's answer. */
const watchMs = 5 * 60_000;

/**
 * Computer Control setup (2026-10-11): one Allow button that asks macOS, then
 * watches until both permissions are on, restarting the helper by itself when
 * Screen Recording needs it. Names the helper macOS lists, work-fold
 * Computer, so people know what to turn on. Works with or without a
 * work-folder, so first run can offer it.
 */
export function IncludedComputerSetup({ workFolderId, enabled, onStatusChange }: {
  workFolderId?: string;
  enabled: boolean;
  onStatusChange?: (status: IncludedToolStatus | null) => void;
}) {
  if (window.workFoldDesktop?.app.platform === "linux") return <IncludedLinuxComputerSetup workFolderId={workFolderId} enabled={enabled} onStatusChange={onStatusChange} />;
  return <IncludedMacComputerSetup workFolderId={workFolderId} enabled={enabled} onStatusChange={onStatusChange} />;
}

function IncludedMacComputerSetup({ workFolderId, enabled, onStatusChange }: {
  workFolderId?: string; enabled: boolean; onStatusChange?: (status: IncludedToolStatus | null) => void;
}) {
  const [status, setStatus] = useState<IncludedToolStatus | null>(null);
  const [busy, setBusy] = useState<ComputerAction | null>(null);
  const [error, setError] = useState<{ source: "read" | "action"; message: string } | null>(null);
  const [watching, setWatching] = useState(false);
  const watchUntil = useRef(0);
  const restarted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const listener = useRef(onStatusChange);
  listener.current = onStatusChange;

  function publish(next: IncludedToolStatus | null) {
    setStatus(next);
    listener.current?.(next);
    if (next?.state === "ready") setWatching(false);
  }

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const read = () => {
      if (request.current || document.visibilityState === "hidden") return;
      void api<{ tools: IncludedToolStatus[] }>(includedToolsPath(workFolderId), { signal: controller.signal })
        .then(({ tools }) => {
          if (!alive.current || request.current) return;
          publish(tools.find((tool) => tool.id === "computer") ?? null);
          setError((current) => current?.source === "read" ? null : current);
        })
        .catch((caught) => { if (alive.current && !controller.signal.aborted) setError({ source: "read", message: errorText(caught) }); });
    };
    read();
    const timer = window.setInterval(read, 5_000);
    window.addEventListener("focus", read);
    return () => { alive.current = false; controller.abort(); request.current?.abort(); window.clearInterval(timer); window.removeEventListener("focus", read); };
  }, [workFolderId]);

  async function act(action: ComputerAction, quiet = false): Promise<IncludedToolStatus | null> {
    if (request.current || !enabled) return null;
    const controller = new AbortController();
    request.current = controller;
    if (!quiet) { setBusy(action); setError(null); }
    try {
      const result = await api<{ status: IncludedToolStatus }>("/api/agent/included-tools/setup", {
        method: "POST", signal: controller.signal, body: includedToolSetupBody(workFolderId, "computer", action),
      });
      if (alive.current && !controller.signal.aborted) publish(result.status);
      return result.status;
    } catch (caught) {
      if (alive.current && !controller.signal.aborted && !quiet) setError({ source: "action", message: errorText(caught) });
      return null;
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current && !quiet) setBusy(null);
    }
  }

  async function allow() {
    restarted.current = false;
    const next = await act("request-permissions");
    if (next && next.state !== "ready") { watchUntil.current = Date.now() + watchMs; setWatching(true); }
  }

  // While the person is in System Settings, look every two seconds. macOS
  // applies Screen Recording to a helper only after it restarts, so once it
  // is allowed but not yet capturable, restart the helper once.
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState !== "hidden") {
        const next = await act("check", true);
        const facts = next?.facts;
        if (!stopped && facts?.screenRecordingAllowed === true && facts.screenRecording !== true && !restarted.current) {
          restarted.current = true;
          await act("recheck", true);
        }
      }
      if (stopped) return;
      if (Date.now() >= watchUntil.current) setWatching(false);
      else timer = setTimeout(() => void tick(), 2_000);
    };
    timer = setTimeout(() => void tick(), 2_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [watching]);

  const ready = status?.state === "ready";
  const unavailable = status?.state === "unavailable" && status.facts?.supportedOS === false;
  const facts = status?.facts ?? {};
  const label = !enabled ? "Turned Off" : busy === "request-permissions" ? "Asking macOS…" : watching ? "Waiting for your OK" : includedToolReadiness(status ?? undefined).label;
  const permissions: Array<{ key: "accessibility" | "screenRecording"; action: ComputerAction; title: string; detail: string }> = [
    { key: "accessibility", action: "accessibility", title: "Accessibility", detail: "lets it click and type" },
    { key: "screenRecording", action: "screen-recording", title: "Screen Recording", detail: "lets it see the screen" },
  ];
  const known = "accessibility" in facts || watching;

  return (
    <section className="included-tool-setup computer-setup" aria-label="Computer Control setup" aria-busy={Boolean(busy)}>
      <div className="included-tool-status"><strong role="status">{label}</strong></div>
      {!ready && !unavailable ? <p>Computer Control lets your Worker see your screen and use the mouse and keyboard when you ask it to. macOS needs your OK first.</p> : null}
      {unavailable ? <p>{status?.detail}</p> : null}
      {ready ? <p>Your Worker can see the screen and use apps when you ask it to.</p> : null}
      {enabled && !ready && !unavailable ? (
        <>
          {known ? (
            <ul className="setup-checklist" aria-label="Permissions">
              {permissions.map((item) => {
                const allowed = facts[item.key] === true;
                return (
                  <li key={item.key} className={allowed ? "done" : ""}>
                    {allowed ? <Check size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                    <span><strong>{item.title}</strong> {item.detail}</span>
                    {allowed ? <span className="setup-checklist-state">Allowed</span> : <button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => void act(item.action)}>Open Settings</button>}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="setup-hint">In System Settings → Privacy &amp; Security, turn on <strong>work-fold Computer</strong>. That is the small helper, part of work-fold, that does the clicking and typing.</p>
          {watching ? <p className="setup-waiting" role="status"><Loader2 className="spin" size={14} aria-hidden="true" />Watching for your OK. This updates by itself.</p>
            : <button className="ui-control ui-control--primary" type="button" disabled={Boolean(busy)} onClick={() => void allow()}>{busy === "request-permissions" ? "Asking macOS…" : "Allow Computer Control"}</button>}
        </>
      ) : null}
      {ready ? <div className="included-tool-actions"><button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => void act("check")}>{busy === "check" ? "Checking…" : "Check again"}</button></div> : null}
      {error ? <p className="included-tool-error" role="alert">{error.message}</p> : null}
      {enabled && !unavailable ? (
        <details className="included-tool-optional">
          <summary>Technical details</summary>
          {facts.helper || facts.path ? (
            <dl className="included-tool-facts">
              {facts.helper ? <div><dt>Helper</dt><dd>{String(facts.helper)}</dd></div> : null}
              {facts.path ? <div><dt>Location</dt><dd>{String(facts.path)}</dd></div> : null}
            </dl>
          ) : <p>The helper starts when your Worker first uses Computer Control.</p>}
          <div className="included-tool-actions"><button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => void act("recheck")}>{busy === "recheck" ? "Restarting…" : "Restart helper"}</button></div>
        </details>
      ) : null}
    </section>
  );
}
