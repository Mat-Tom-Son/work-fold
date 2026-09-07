import { useState } from "react";
import { api, errorText } from "../../lib/api";
import { setRestrictedAppCheckGrant } from "../../lib/restricted-apps";
import type { ChecksOverview, RestrictedAppInstalled } from "../../types";
import { requestConfirm } from "../../ui/feedback";

export function RestrictedAppCheckAccess({ app, busy, onAppChanged, onError }: {
  app: RestrictedAppInstalled;
  busy: boolean;
  onAppChanged: (app: RestrictedAppInstalled) => void;
  onError: (message: string) => void;
}) {
  const [choices, setChoices] = useState<ChecksOverview["checks"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  async function choose(permissionId: string) {
    setLoading(true);
    setChoices(null);
    setSelection("");
    try {
      const result = await api<{ overview: ChecksOverview }>(`/api/spaces/${encodeURIComponent(app.spaceId)}/checks/overview`, { method: "POST", body: {} });
      setChoices(result.overview.checks.filter((check) => check.digest));
      setEditing(permissionId);
    } catch (error) { onError(errorText(error)); }
    finally { setLoading(false); }
  }
  async function change(permissionId: string, remove = false) {
    const check = choices?.find((item) => item.id === selection);
    if (!remove) {
      if (!check?.digest) return;
      if (!await requestConfirm({ title: `Share “${check.title}” results?`, body: `${app.manifest.title} can read this Check’s status, finding details, paths and quoted evidence.`, confirmLabel: "Allow results" })) return;
    }
    setLoading(true);
    try {
      onAppChanged(await setRestrictedAppCheckGrant(app, permissionId, remove ? null : { checkId: check!.id, declarationDigest: check!.digest! }));
      setEditing(null);
    } catch (error) { onError(errorText(error)); }
    finally { setLoading(false); }
  }
  return <section className="restricted-app-connections" aria-label="Check results">
    <div className="restricted-app-connections-heading"><h3>Check results</h3></div>
    {app.manifest.permissions.checks?.map((permission) => {
      const grant = app.checkGrants?.find((item) => item.permissionId === permission.id);
      return <article className="restricted-app-destination-card" key={permission.id}>
        <div className="restricted-app-destination-heading"><strong>{permission.title}</strong><span>{grant ? `${grant.title ?? "Selected Check"} · read only` : "Off"}</span></div>
        {editing === permission.id ? <>
          <label>Check <select aria-label={`Check for ${permission.title}`} disabled={busy || loading} value={selection} onChange={(event) => setSelection(event.target.value)}>
            <option value="">Choose a Check</option>
            {choices?.map((check) => <option key={check.id} value={check.id}>{check.title}</option>)}
          </select></label>
          {!choices?.length ? <p>No Checks in this Space yet.</p> : null}
          <div className="restricted-app-destination-actions">
            <button className="professional-button professional-button-primary" disabled={busy || loading || !selection} onClick={() => void change(permission.id)}>Allow results</button>
            <button className="professional-button professional-button-secondary" disabled={loading} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </> : <div className="restricted-app-destination-actions">
          <button className="professional-button professional-button-secondary" disabled={busy || loading} onClick={() => void choose(permission.id)}>{grant ? "Change Check" : "Choose Check"}</button>
          {grant ? <button className="professional-button professional-button-secondary" disabled={busy || loading} onClick={() => void change(permission.id, true)}>Revoke</button> : null}
        </div>}
      </article>;
    })}
  </section>;
}
