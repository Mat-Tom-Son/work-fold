import { useEffect, useState } from "react";
import type { ProviderAccountDetails as AccountDetails, ProviderUsageWindow } from "../../../../src/shared/provider-account";
import { api } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";

/** Account metadata stays in Settings and is never part of the model catalog or a Chat. */
export function ProviderAccountDetails({ provider, scope, workFolderId, revision, active, fixtureMode, onSelectCodex, onReconnect, busy = false }: {
  provider: string; scope: "work-folder" | "agent"; workFolderId?: string; revision: unknown; active: boolean; fixtureMode: boolean;
  onSelectCodex?: () => void; onReconnect?: () => void; busy?: boolean;
}) {
  const [account, setAccount] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || fixtureMode || provider !== "openai-codex") return;
    const refresh = () => { if (!document.hidden) setAttempt(value => value + 1); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [active, fixtureMode, provider]);
  useEffect(() => {
    if (!active || fixtureMode) return;
    // Credential changes must refresh identity even while the parent keeps
    // unsaved model/instruction drafts instead of applying new settings.
    return subscribeControlEvents(hint => {
      if (hint === "models" || hint === "reset") setAttempt(value => value + 1);
    });
  }, [active, fixtureMode]);
  useEffect(() => {
    const controller = new AbortController();
    setAccount(null);
    setError(null);
    if (!active || fixtureMode) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    const params = new URLSearchParams({ provider, scope });
    if (scope === "work-folder" && workFolderId) params.set("workFolderId", workFolderId);
    void api<{ account: AccountDetails }>(`/api/agent/provider-account?${params}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setAccount(result.account);
        setError(result.account.error);
      }, () => {
        if (!controller.signal.aborted) setError("OpenAI account details are unavailable. Your connection has been kept.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [provider, scope, workFolderId, revision, active, fixtureMode, attempt]);

  return <div className="ai-models-account-details" aria-label="OpenAI account details">
    {loading ? <p className="professional-field-hint" role="status">Loading account details…</p> : <>
      <dl>
        <div><dt>Email</dt><dd>{account?.email ?? (account?.identityNeedsReconnect ? "Reconnect to load email" : error ? "Unavailable" : "Not returned by this sign-in")}</dd></div>
        <div><dt>Workspace</dt><dd>{account?.workspaceName ?? account?.workspaceId ?? (error ? "Unavailable" : "Not returned by this sign-in")}</dd></div>
        {account?.plan ? <div><dt>Plan</dt><dd>{account.plan.replace(/_/g, " ")}</dd></div> : null}
      </dl>
      {account?.source === "saved_sign_in" ? <p className="professional-field-hint">Details from the saved sign-in.</p> : null}
      {account?.identityNeedsReconnect ? <p className="professional-field-hint">This connection was saved without your account identity. Reconnect once to load your email.</p> : null}
      {account?.identityNeedsReconnect && onReconnect ? <button className="ui-control" type="button" disabled={busy} onClick={onReconnect}>Reconnect to load email</button> : null}
      {account?.limits?.length ? <section className="ai-models-account-usage" aria-label="Codex subscription usage">
        <h4>Codex usage</h4>
        {account.limits.map(limit => <div className="ai-models-account-limit" key={limit.id}>
          <strong>{limit.name}</strong>
          {[limit.primary, limit.secondary].map((window, index) => window ? <UsageWindow key={index} window={window} /> : null)}
        </div>)}
        {account.applicableResets != null ? <p className="professional-field-hint">Rate-limit resets for this workspace: {account.applicableResets}{account.availableResets != null ? ` (${account.availableResets} on account)` : ""}</p>
          : account.availableResets != null ? <p className="professional-field-hint">Rate-limit resets on account: {account.availableResets}</p> : null}
        {account.checkedAt ? <p className="professional-field-hint">Updated {new Date(account.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Refreshes every minute while open.</p> : null}
      </section> : null}
      {account?.connected === false ? <p className="professional-field-hint" role="status">This connection has no signed-in OpenAI account.</p> : null}
      {error ? <p className="professional-field-hint" role="status">{error}</p> : null}
    </>}
    {provider === "openai" ? <p className="professional-field-hint">This sign-in provides identity and direct ChatGPT plan access. Workspace, plan usage limits and reset times are available through a separate Codex subscription connection.</p>
      : account?.limitsAvailability !== "available" && !loading ? <p className="professional-field-hint">Usage limits are currently unavailable. Refresh account details to try again.</p> : null}
    <div className="ai-models-connection-controls">
      <a href={provider === "openai-codex" ? "https://chatgpt.com/codex/settings/usage" : "https://chatgpt.com/settings/usage"} target="_blank" rel="noreferrer">Manage usage in ChatGPT</a>
      {provider === "openai" && onSelectCodex ? <button className="ui-control" type="button" disabled={busy} onClick={onSelectCodex}>View Codex connection</button> : null}
      <button className="ui-control" type="button" disabled={loading || busy || !active || fixtureMode} onClick={() => setAttempt(value => value + 1)}>Refresh account details</button>
    </div>
  </div>;
}

function UsageWindow({ window }: { window: ProviderUsageWindow }) {
  const minutes = window.windowDurationMins;
  const duration = !minutes ? "Usage window" : minutes % 1440 === 0 ? `${minutes / 1440}-day window`
    : minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;
  return <div className="ai-models-account-window">
    <div><span>{duration}</span><span>{window.usedPercent}% used</span></div>
    <progress max={100} value={Math.min(100, window.usedPercent)} aria-label={`${duration} usage`} />
    {window.resetsAt ? <p className="professional-field-hint">Resets <time dateTime={new Date(window.resetsAt * 1000).toISOString()}>{new Date(window.resetsAt * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time></p> : null}
  </div>;
}
