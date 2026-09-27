import { useEffect, useRef, useState } from "react";
import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";

export function IncludedWaylandSetup({ spaceId, enabled, onStatusChange }: {
  spaceId: string; enabled: boolean; onStatusChange?(status: IncludedToolStatus): void;
}) {
  const [status, setStatus] = useState<IncludedToolStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const listener = useRef(onStatusChange); listener.current = onStatusChange;
  const generation = useRef(0);
  useEffect(() => {
    let closed = false;
    const signal = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const revision = generation.current;
      try {
        const result = await api<{ tools: IncludedToolStatus[] }>(`/api/agent/included-tools?spaceId=${encodeURIComponent(spaceId)}`, { signal: signal.signal });
        const computer = result.tools.find(tool => tool.id === "computer");
        if (!closed && revision === generation.current && computer) { setStatus(computer); listener.current?.(computer); }
      } catch (error) { if (!closed) setError(errorText(error)); }
      finally { if (!closed) timer = setTimeout(() => void refresh(), 2_000); }
    };
    void refresh();
    return () => { closed = true; signal.abort(); clearTimeout(timer); activeRequest.current?.abort(); };
  }, [spaceId]);

  async function act(action: "share-screen" | "stop-sharing") {
    if (action === "share-screen" && activeRequest.current) return;
    // Stop remains reachable while the compositor's chooser is open.
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    ++generation.current; setBusy(true); setError(undefined);
    try {
      const result = await api<{ status: IncludedToolStatus }>("/api/agent/included-tools/setup", {
        method: "POST", signal: controller.signal,
        body: { spaceId, id: "computer", action },
      });
      if (!controller.signal.aborted) { setStatus(result.status); listener.current?.(result.status); }
    } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
    finally { if (activeRequest.current === controller) { activeRequest.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  const sharing = status?.computerSession;
  const current = sharing?.owner;
  const live = sharing && ["requesting", "active", "stopping"].includes(sharing.state);
  const failure = error || (sharing?.state === "error" ? sharing.detail : undefined);
  const active = sharing?.state === "active";
  return <section className="included-tool-optional" aria-label="Wayland screen sharing">
    <p>{active ? "Shared with all chats and the work-fold agent." : "Share your screen with any chat."}</p>
    {!live ? <p>Choose <strong>Allow interaction</strong> to enable clicks and typing.</p> : null}
    {active && (!sharing.pointer || !sharing.keyboard) ? <p>Full control is off. Share again with <strong>Allow interaction</strong>.</p> : null}
    {current ? <p role="status">{current.scope === "management" ? "work-fold agent" : "Folder Worker"} is using your screen.</p> : null}
    {sharing?.state === "requesting" ? <p role="status">Choose a screen in the Linux dialog.</p> : sharing?.state === "stopping" ? <p role="status">Stopping sharing…</p> : null}
    <div className="included-tool-actions">
      {!live ? <button className="professional-button professional-button-primary" type="button" disabled={busy || !enabled} onClick={() => void act("share-screen")}>Share desktop</button> : null}
      {live || busy ? <button className="professional-button professional-button-secondary" type="button" disabled={sharing?.state === "stopping"} onClick={() => void act("stop-sharing")}>Stop sharing</button> : null}
    </div>
    {failure ? <p className="included-tool-error" role="alert">{failure}</p> : null}
  </section>;
}
