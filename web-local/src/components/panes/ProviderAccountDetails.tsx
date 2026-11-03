import { useEffect, useState } from "react";
import type { ProviderAccountDetails as AccountDetails } from "../../../../src/shared/provider-account";
import { api } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";

/** Account metadata stays in Settings and is never part of the model catalog or a Chat. */
export function ProviderAccountDetails({ provider, scope, workFolderId, revision, active, fixtureMode }: {
  provider: string; scope: "work-folder" | "agent"; workFolderId?: string; revision: unknown; active: boolean; fixtureMode: boolean;
}) {
  const [account, setAccount] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
        <div><dt>Email</dt><dd>{account?.email ?? "Not provided by OpenAI"}</dd></div>
        <div><dt>Workspace</dt><dd>{account?.workspaceName ?? account?.workspaceId ?? "Not provided by OpenAI"}</dd></div>
        {account?.plan ? <div><dt>Plan</dt><dd>{account.plan.replace(/_/g, " ")}</dd></div> : null}
      </dl>
      {account?.source === "saved_sign_in" ? <p className="professional-field-hint">Details from the saved sign-in.</p> : null}
      {account?.connected === false ? <p className="professional-field-hint" role="status">This connection has no signed-in OpenAI account.</p> : null}
      {error ? <p className="professional-field-hint" role="status">{error}</p> : null}
    </>}
    <p className="professional-field-hint">This connection does not provide plan usage limits or reset times. Review your plan and app limits in ChatGPT.</p>
    <div className="ai-models-connection-controls">
      <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage in ChatGPT</a>
      <button className="ui-control" type="button" disabled={loading || !active || fixtureMode} onClick={() => setAttempt(value => value + 1)}>Refresh account details</button>
    </div>
  </div>;
}
