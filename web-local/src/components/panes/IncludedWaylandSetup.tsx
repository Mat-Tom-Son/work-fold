import { useEffect, useRef, useState } from "react";
import type { IncludedToolStatus } from "../../../../src/shared/included-tools";
import { api, errorText } from "../../lib/api";

type Choice = { scope: "space" | "management"; id: string; title: string };
type Conversation = { id: string; title: string; archivedAt?: string | null };
export function IncludedWaylandSetup({ spaceId, enabled, onStatusChange }: {
  spaceId: string; enabled: boolean; onStatusChange?(status: IncludedToolStatus): void;
}) {
  const [status, setStatus] = useState<IncludedToolStatus>();
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState("");
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
    void Promise.all([
      api<{ conversations: Conversation[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/conversations`, { signal: signal.signal }),
      api<{ conversations: Conversation[] }>("/api/management/conversations", { signal: signal.signal }),
    ]).then(([space, management]) => {
      if (!closed) setChoices([
        ...space.conversations.filter(chat => !chat.archivedAt).slice(0, 100).map(chat => ({ ...chat, scope: "space" as const })),
        ...management.conversations.filter(chat => !chat.archivedAt).slice(0, 100).map(chat => ({ ...chat, scope: "management" as const })),
      ]);
    }).catch(error => { if (!closed) setError(errorText(error)); });
    void refresh();
    return () => { closed = true; signal.abort(); clearTimeout(timer); activeRequest.current?.abort(); };
  }, [spaceId]);

  async function act(action: "share-screen" | "stop-sharing") {
    if (action === "share-screen" && activeRequest.current) return;
    // Stop remains reachable while the compositor's chooser is open.
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    ++generation.current; setBusy(true); setError(undefined);
    const choice = choices.find(item => `${item.scope}:${item.id}` === selected);
    try {
      const result = await api<{ status: IncludedToolStatus }>("/api/agent/included-tools/setup", {
        method: "POST", signal: controller.signal,
        body: { spaceId, id: "computer", action, ...(choice ? { scope: choice.scope, conversationId: choice.id } : {}) },
      });
      if (!controller.signal.aborted) { setStatus(result.status); listener.current?.(result.status); }
    } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
    finally { if (activeRequest.current === controller) { activeRequest.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  const sharing = status?.computerSession;
  const current = sharing?.owner;
  const named = current && choices.find(choice => choice.id === current.conversationId && choice.scope === current.scope);
  const live = sharing && ["requesting", "active", "stopping"].includes(sharing.state);
  return <section className="included-tool-optional" aria-label="Wayland screen sharing">
    <h4>Share a screen</h4>
    <p>Choose the Chat that may use this screen. Keyboard input goes to the focused application on the desktop. Sharing ends on Stop, lock, sleep, or app exit.</p>
    {current ? <p>Chat with {current.scope === "management" ? "work-fold agent" : "Worker"}: {named?.title ?? current.conversationId}</p> : null}
    {!live ? <label>Chat<select value={selected} disabled={busy || !enabled} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a Chat</option>
      {choices.map(choice => <option key={`${choice.scope}:${choice.id}`} value={`${choice.scope}:${choice.id}`}>
        {choice.scope === "management" ? "work-fold agent — " : "Worker — "}{choice.title}
      </option>)}
    </select></label> : null}
    {!choices.length && !live ? <p>Create a Chat, then reopen this setup.</p> : null}
    <div className="included-tool-actions">
      {!live ? <button className="professional-button professional-button-primary" type="button" disabled={busy || !enabled || !selected} onClick={() => void act("share-screen")}>Choose screen</button> : null}
      {live || busy ? <button className="professional-button professional-button-secondary" type="button" disabled={sharing?.state === "stopping"} onClick={() => void act("stop-sharing")}>Stop sharing</button> : null}
    </div>
    {sharing ? <p role="status">{sharing.detail}</p> : null}
    {error ? <p className="included-tool-error" role="alert">{error}</p> : null}
  </section>;
}
