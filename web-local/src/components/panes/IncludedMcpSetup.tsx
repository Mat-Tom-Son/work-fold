import { useEffect, useRef, useState } from "react";
import type { IncludedMcpServer, IncludedMcpOAuthJob } from "../../../../src/local/agent/included-mcp-setup";
import { api, errorText } from "../../lib/api";

export function IncludedMcpSetup({ spaceId, enabled }: { spaceId: string; enabled: boolean }) {
  const [opened, setOpened] = useState(false);
  const [servers, setServers] = useState<IncludedMcpServer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [transport, setTransport] = useState<"url" | "command">("url");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("[]");
  const [extra, setExtra] = useState("{}");
  const [tokenFor, setTokenFor] = useState<IncludedMcpServer | null>(null);
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<{ state: string; detail: string } | null>(null);
  const [job, setJob] = useState<IncludedMcpOAuthJob | null>(null);
  const session = useRef<string | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    alive.current = true; setOpened(false);
    let ownedId: string | null = null;
    let cancelled = false;
    void api<{ sessionId: string; servers: IncludedMcpServer[] }>("/api/agent/mcp-setup", { method: "POST", body: { spaceId, operation: "open" } }).then((result) => {
      ownedId = result.sessionId;
      if (cancelled) { void close(ownedId); return; }
      session.current = ownedId; setServers(result.servers); setOpened(true);
    }).catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    const close = (sessionId: string) => api("/api/agent/mcp-setup", { method: "POST", body: { spaceId, sessionId, operation: "close" } }).catch(() => undefined);
    return () => { cancelled = true; alive.current = false; session.current = null; if (ownedId) void close(ownedId); };
  }, [spaceId]);

  async function operation(action: string, fields: Record<string, unknown> = {}) {
    if (!session.current) throw new Error("Wait for connection setup to open, then try again.");
    return api<{ servers?: IncludedMcpServer[]; job?: IncludedMcpOAuthJob; probe?: { state: string; detail: string } }>("/api/agent/mcp-setup", { method: "POST", body: { ...fields, spaceId, sessionId: session.current, operation: action } });
  }
  async function act(action: string, fields: Record<string, unknown> = {}) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const result = await operation(action, fields);
      if (!alive.current) return;
      if (result.servers) setServers(result.servers);
      if (result.job) setJob(result.job);
      if (result.probe) setProbe(result.probe);
      if (action === "save") { setAdding(false); setName(""); setEndpoint(""); setExtra("{}"); }
      if (action === "bearer") { setTokenFor(null); setToken(""); }
      if (action === "oauth-cancel") setJob(null);
    } catch (caught) { if (alive.current) setError(errorText(caught)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = window.setTimeout(() => {
      void operation("oauth-status", { jobId: job.id }).then(async ({ job: next }) => {
        if (!alive.current || !next) return;
        setJob(next);
        if (next.state === "connected") await act("list");
      }).catch((caught) => { if (alive.current) { setError(errorText(caught)); setJob(null); } });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [job]);
  const selection = (server: IncludedMcpServer) => ({ scope: server.scope, name: server.name, expectedRevision: server.revision });
  function save() {
    try {
      const additional = JSON.parse(extra);
      if (!additional || typeof additional !== "object" || Array.isArray(additional)) throw new Error("Advanced settings must be a JSON object.");
      void act("save", { name, scope, definition: { ...additional, [transport]: endpoint, ...(transport === "command" ? { args: JSON.parse(args) } : {}) } });
    } catch (caught) { setError(errorText(caught)); }
  }
  return <div className="included-mcp-setup">
    <div className="included-tool-actions"><button type="button" className="professional-button professional-button-primary" disabled={!enabled || busy || !opened} onClick={() => setAdding(true)}>Add connection</button><button type="button" className="professional-button professional-button-secondary" disabled={busy || !opened} onClick={() => void act("list")}>Refresh</button></div>
    {error ? <p className="included-tool-error" role="alert">{error}</p> : null}
    {probe ? <p role="status">{probe.state === "ready" ? "Connected" : probe.detail}</p> : null}
    {job ? <div className="included-mcp-auth" role="status"><p>{job.state === "running" ? "Complete sign-in in your browser." : job.state === "connected" ? "Signed in." : job.message ?? `Sign-in ${job.state}.`}</p>{job.state === "running" ? <button type="button" className="professional-button professional-button-secondary" onClick={() => void act("oauth-cancel", { jobId: job.id })}>Cancel sign-in</button> : null}</div> : null}
    {!opened && !error ? <p role="status">Loading connections…</p> : opened && !servers.length && !adding ? <p>No connections</p> : null}
    <ul className="included-mcp-list">{servers.map((server) => <li key={`${server.scope}:${server.name}`}><div><strong>{server.name}</strong><small>{server.scope === "global" ? "Everywhere" : "This Space only"} · {server.disabled ? "Turned off" : server.auth === "none" ? "No sign-in required" : server.credential === "present" ? "Signed in" : server.credential === "not_checked" ? "Sign-in not checked" : server.credential === "unavailable" ? "Secure storage unavailable" : "Not signed in"}</small></div><div className="included-tool-actions">
      <button type="button" className="professional-button professional-button-secondary" disabled={busy || !enabled || server.disabled} onClick={() => void act("check", selection(server))}>Check</button>
      <button type="button" className="professional-button professional-button-secondary" disabled={busy || !enabled} onClick={() => void act("enabled", { ...selection(server), enabled: server.disabled })}>{server.disabled ? "Turn on" : "Turn off"}</button>
      {server.transport === "http" && server.auth !== "none" ? <><button type="button" className="professional-button professional-button-secondary" disabled={busy || !enabled || server.disabled || job?.state === "running"} onClick={() => void act("oauth", selection(server))}>Sign in</button></> : null}
      </div><details className="included-tool-optional"><summary>Connection settings</summary><code>{server.endpoint}</code><div className="included-tool-actions">{server.transport === "http" ? <><button type="button" className="professional-button professional-button-secondary" disabled={busy || !enabled} onClick={() => { setTokenFor(server); setToken(""); }}>Use token</button><button type="button" className="professional-button professional-button-secondary" disabled={busy} onClick={() => void act("disconnect", selection(server))}>Disconnect</button></> : null}
      <button type="button" className="professional-button professional-button-secondary" disabled={busy} onClick={() => void act("remove", selection(server))}>Remove</button>
    </div></details></li>)}</ul>
    {tokenFor ? <form className="included-mcp-form" onSubmit={(event) => { event.preventDefault(); void act("bearer", { ...selection(tokenFor), token }); }}><label>Token for {tokenFor.name}<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label><div className="included-tool-actions"><button type="submit" className="professional-button professional-button-primary" disabled={busy || !token.trim()}>Connect</button><button type="button" className="professional-button professional-button-secondary" onClick={() => { setTokenFor(null); setToken(""); }}>Cancel</button></div></form> : null}
    {adding ? <form className="included-mcp-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h3>Add connection</h3><label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="my-service" /></label>
      <label>Available in<select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}><option value="global">Everywhere</option><option value="project">This Space only</option></select></label>
      <label>Connection<select value={transport} onChange={(event) => setTransport(event.target.value as "url" | "command")}><option value="url">Service URL</option><option value="command">Local server command</option></select></label>
      <label>{transport === "url" ? "MCP service URL" : "Executable"}<input required type={transport === "url" ? "url" : "text"} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "url" ? "https://example.com/mcp" : "/path/to/server"} /></label>
      {transport === "command" ? <><p>Install the command and its runtime first.</p><label>Arguments (JSON array)<input value={args} onChange={(event) => setArgs(event.target.value)} /></label></> : null}
      <details><summary>Advanced settings</summary><textarea aria-label="Advanced MCP settings" value={extra} onChange={(event) => setExtra(event.target.value)} rows={5} spellCheck={false} /></details>
      <div className="included-tool-actions"><button type="submit" className="professional-button professional-button-primary" disabled={busy}>Add connection</button><button type="button" className="professional-button professional-button-secondary" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
    </form> : null}
  </div>;
}
