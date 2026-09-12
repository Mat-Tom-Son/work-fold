import { useEffect, useState } from "react";

import type { RestrictedAppInferenceReceipt } from "../../../../src/shared/restricted-app-inference";
import { errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { listRestrictedAppInferenceReceipts } from "../../lib/restricted-apps";
import type { RestrictedAppInstalled } from "../../types";

/**
 * Short answers this app asked the Assistant for (docs/receipts-not-gates.md,
 * F22). `assistant.infer` needs no grant beyond installation, so disclosure is
 * after the fact: this is the reader for it. Each row says when, from where,
 * how it ended, how much text went in and came back, which model actually ran,
 * and what it used. The list spans code changes, so a receipt stays readable
 * after the app is updated.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function inferenceReceiptOutcomeLabel(receipt: RestrictedAppInferenceReceipt): string {
  if (receipt.outcome === "ok") return "Answered";
  if (receipt.outcome === "accepted") return "Running";
  return receipt.errorCode ? `Stopped · ${receipt.errorCode}` : "Stopped";
}

export function RestrictedAppInferenceReceipts({ app, disabled }: {
  app: RestrictedAppInstalled;
  disabled: boolean;
}) {
  const [receipts, setReceipts] = useState<RestrictedAppInferenceReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) return;
    let alive = true;
    let loading = false;
    async function refresh(): Promise<void> {
      if (!alive || loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const next = await listRestrictedAppInferenceReceipts(app);
        if (alive) { setReceipts(next); setError(null); }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const unsubscribe = subscribeControlEvents(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { alive = false; unsubscribe(); window.clearInterval(timer); };
  }, [app, disabled]);

  if (!receipts.length && !error) return null;
  return <section className="restricted-app-connections restricted-app-inference-receipts" aria-label="Short answers">
    <div className="restricted-app-connections-heading"><h3>Short answers</h3></div>
    {error ? <p role="alert">{error}</p> : null}
    {receipts.map((receipt) => <article className="restricted-app-destination-card" key={receipt.id}>
      <div className="restricted-app-destination-heading">
        <div>
          <strong>{new Date(receipt.at).toLocaleString()}</strong>
          <span>
            {receipt.surface === "worker" ? "From a background task" : "From the app's view"}
            {receipt.schema ? " · structured result" : ""}
            {typeof receipt.durationMs === "number" ? ` · ${(receipt.durationMs / 1000).toFixed(1)}s` : ""}
          </span>
        </div>
        <span className={receipt.outcome === "error" ? "professional-status-badge" : "professional-status-badge enabled"}>
          {inferenceReceiptOutcomeLabel(receipt)}
        </span>
      </div>
      <dl className="capability-review-facts">
        <div><dt>Sent</dt><dd>{formatBytes(receipt.inputBytes)}</dd></div>
        <div><dt>Returned</dt><dd>{typeof receipt.outputBytes === "number" ? formatBytes(receipt.outputBytes) : "—"}</dd></div>
        <div><dt>Model</dt><dd>{receipt.model ? `${receipt.model.provider} · ${receipt.model.id}` : "—"}</dd></div>
        <div><dt>Used</dt><dd>{receipt.usage ? `${receipt.usage.inputTokens} in · ${receipt.usage.outputTokens} out` : "—"}</dd></div>
      </dl>
    </article>)}
  </section>;
}
