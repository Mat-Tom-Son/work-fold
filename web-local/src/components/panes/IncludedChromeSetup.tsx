import { useEffect, useRef, useState } from "react";
import type { ChromeSetupAction } from "../../../../src/shared/chrome-connection";
import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";
import { chromeConnectionReadiness } from "../../lib/included-tool-readiness";

type Props = { spaceId: string; enabled: boolean; onStatusChange?: (status: IncludedToolStatus | null) => void };

export function IncludedChromeSetup(props: Props) {
  return <ChromeSetupSession key={props.spaceId} {...props} />;
}

function ChromeSetupSession({ spaceId, enabled, onStatusChange }: Props) {
  const [status, setStatus] = useState<IncludedToolStatus | null>(null);
  const [action, setAction] = useState<ChromeSetupAction | null>(null);
  const [error, setError] = useState<{ source: "read" | "action"; message: string } | null>(null);
  const [watching, setWatching] = useState(false);
  const watchUntil = useRef(0);
  const alive = useRef(false);
  const revision = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const listener = useRef(onStatusChange);
  listener.current = onStatusChange;

  function publish(next: IncludedToolStatus | null) {
    setStatus(next); listener.current?.(next);
    if (next?.chrome?.state === "connected") setWatching(false);
  }

  async function refresh() {
    if (mutation.current) return;
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    const owner = ++revision.current;
    try {
      const { tools } = await api<{ tools: IncludedToolStatus[] }>(`/api/agent/included-tools?spaceId=${encodeURIComponent(spaceId)}`, { signal: controller.signal });
      if (alive.current && !controller.signal.aborted && owner === revision.current) {
        publish(tools.find((tool) => tool.id === "chrome") ?? null);
        setError((current) => current?.source === "read" ? null : current);
      }
    } catch (caught) {
      if (alive.current && !controller.signal.aborted && owner === revision.current) { publish(null); setError({ source: "read", message: errorText(caught) }); }
    } finally { if (readRequest.current === controller) readRequest.current = null; }
  }

  useEffect(() => {
    alive.current = true;
    void refresh();
    const returned = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      alive.current = false; revision.current += 1;
      readRequest.current?.abort(); mutation.current?.abort();
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [spaceId]);

  // Only an explicitly opened setup observes the handshake for a short time.
  // These reads do not launch Chrome, enroll a profile, or own its connection.
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState !== "hidden") await refresh();
      if (stopped) return;
      if (Date.now() >= watchUntil.current) setWatching(false);
      else timer = setTimeout(() => void tick(), 2_000);
    };
    timer = setTimeout(() => void tick(), 2_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [watching]);

  async function act(nextAction: ChromeSetupAction) {
    if (mutation.current || !enabled) return;
    const controller = new AbortController();
    mutation.current = controller;
    readRequest.current?.abort(); revision.current += 1;
    setAction(nextAction); setError(null); publish(null);
    let accepted = false;
    try {
      const result = await api<{ status: IncludedToolStatus }>("/api/agent/included-tools/setup", {
        method: "POST", signal: controller.signal, body: { spaceId, id: "chrome", action: nextAction },
      });
      if (!alive.current || controller.signal.aborted) return;
      accepted = true;
      publish(result.status);
      if ((nextAction === "connect-chrome" || nextAction === "change-chrome-profile") && ["not_connected", "connecting"].includes(result.status.chrome?.state ?? "")) {
        watchUntil.current = Date.now() + 120_000; setWatching(true);
      } else if (nextAction === "disconnect-chrome") setWatching(false);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) setError({ source: "action", message: errorText(caught) });
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (alive.current && !controller.signal.aborted) {
        setAction(null);
        // A refused mutation may have preserved the existing selected profile.
        if (!accepted) void refresh();
      }
    }
  }

  const connection = status?.chrome;
  const state = connection?.state;
  const hasSelection = connection?.hasSelection === true || state === "connected" || state === "profile_conflict";
  const presentation = chromeConnectionReadiness(state);
  const canConnect = !["connected", "connecting", "store_unavailable", "app_not_running", "update_app", "profile_conflict", "busy"].includes(state ?? "");
  const pendingLabel = action === "check" ? "Checking…" : action === "disconnect-chrome" ? "Disconnecting…" : action === "change-chrome-profile" ? "Changing profile…" : action ? "Connecting…" : null;
  const cancelObservation = () => { setWatching(false); readRequest.current?.abort(); };
  return <section className="included-tool-setup" aria-label="Chrome setup" aria-busy={Boolean(action)}>
    <div className="included-tool-status"><strong role="status">{!enabled ? "Turned off" : pendingLabel ?? presentation.label}</strong>
      <button type="button" className="professional-button professional-button-secondary" disabled={!enabled || Boolean(action)} onClick={() => void act("check")}>Check</button>
    </div>
    {error ? <p className="included-tool-error" role="alert">{error.message}</p> : null}
    {state === "busy" ? <p>Stop Chrome work before changing the connection.</p> : null}
    {enabled && (state === "connecting" || watching) ? <p>In Chrome, choose Connect.</p> : null}
    <div className="included-tool-actions included-chrome-actions">
      {canConnect ? <button type="button" className="professional-button professional-button-primary" disabled={!enabled || Boolean(action)} onClick={() => void act("connect-chrome")}>{action === "connect-chrome" ? "Opening Chrome…" : state === "update_extension" ? "Update extension" : "Connect Chrome"}</button> : null}
      {hasSelection ? <>
        <button type="button" className="professional-button professional-button-secondary" disabled={!enabled || Boolean(action)} onClick={() => void act("change-chrome-profile")}>Change profile</button>
        <button type="button" className="professional-button professional-button-secondary" disabled={!enabled || Boolean(action)} onClick={() => void act("disconnect-chrome")}>Disconnect</button>
      </> : null}
      {watching ? <button type="button" className="professional-button professional-button-secondary" disabled={Boolean(action)} onClick={cancelObservation}>Cancel</button> : null}
    </div>
  </section>;
}
