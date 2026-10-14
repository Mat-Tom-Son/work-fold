import { useEffect, useState } from "react";

import { restrictedAppInferenceLimits } from "../../../../src/shared/restricted-app-inference";
import { restrictedAppAssistantLimits } from "../../../../src/shared/restricted-app-tasks";
import {
  workFoldAppAutomationDefaultConcurrency,
  workFoldExtensionUiLimits,
  workFoldRequestContinuationsDefaultEnabled,
  workFoldRequestLimits,
  workFoldAutomationDeclarationBounds,
  workFoldAutomationMaxConcurrentRuns,
  workFoldRecentlyDeletedDefaultRetentionDays,
} from "../../../../src/shared/work-fold-limits";
import { api, errorText } from "../../lib/api";
import { workFoldLimitsSettings } from "../../ui-contract";

/**
 * Settings → Automations → Limits (docs/receipts-not-gates.md, F19 principle 6:
 * bounds are visible and named). Every app and automation refusal names this
 * section, so this pane is where those phrases resolve.
 *
 * The bounds are frozen constants. The one adjustable number — how long
 * Recently Deleted keeps an item — is set in its own pane, which this one
 * links to, and the one switch — whether finished handed-out work is brought
 * back to its owner as a turn (docs/collaboration-contract.md, F28) — lives
 * here. Every shown value is read from the frozen contract the host enforces
 * (`restrictedAppAssistantLimits`, `restrictedAppInferenceLimits`,
 * `workFoldRequestLimits`, `workFoldAutomationDeclarationBounds`,
 * `workFoldAutomationMaxConcurrentRuns`, `workFoldAppAutomationDefaultConcurrency`),
 * so the shown number cannot drift from the enforced one.
 */

interface RequestSettingsResponse {
  continuationsEnabled: boolean;
}

/**
 * The F28 switch. It loads from the running app and saves through a journaled
 * Settings act; without the app it shows the shipped default, disabled, and
 * says why. Turning it off changes nothing about what is recorded.
 */
function ContinuationsSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api<RequestSettingsResponse>("/api/settings/requests");
        if (!cancelled) setEnabled(response.continuationsEnabled);
      } catch {
        if (!cancelled) setError(workFoldLimitsSettings.continuationsUnavailable);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function save(next: boolean): Promise<void> {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await api<RequestSettingsResponse>("/api/settings/requests/continuations", { method: "PUT", body: { enabled: next } });
      setEnabled(response.continuationsEnabled);
      setNotice(workFoldLimitsSettings.continuationsSaved);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const checked = enabled ?? workFoldRequestContinuationsDefaultEnabled;
  return (
    <>
      <h4 id="work-fold-limits-continuations-title">{workFoldLimitsSettings.continuationsHeading}</h4>
      <div className="settings-actions">
        <label htmlFor="work-fold-limits-continuations">
          <input
            id="work-fold-limits-continuations"
            type="checkbox"
            checked={checked}
            disabled={enabled === null || busy}
            onChange={(event) => { void save(event.target.checked); }}
          />
          {" "}
          {workFoldLimitsSettings.continuationsLabel}
        </label>
        {notice ? <span className="settings-save-status" role="status">{notice}</span> : null}
        {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
      </div>
    </>
  );
}

function kib(bytes: number): string {
  const kibibytes = bytes / 1024;
  if (kibibytes >= 1024) return `${formatNumber(kibibytes / 1024)} MB`;
  return `${formatNumber(kibibytes)} KB`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function LimitRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="context-meta-grid">
      {rows.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export function WorkFoldLimitsPane({ onOpenRecentlyDeleted }: { onOpenRecentlyDeleted?: () => void }) {
  const assistant = restrictedAppAssistantLimits;
  const inference = restrictedAppInferenceLimits;
  const automation = workFoldAutomationDeclarationBounds;
  const requests = workFoldRequestLimits;

  return (
    <details className="settings-section settings-limits">
      <summary className="settings-section-heading settings-limits-summary"><h3 id="work-fold-limits-title">{workFoldLimitsSettings.heading}</h3></summary>
      {workFoldLimitsSettings.frozenNote ? <span className="settings-section-note">{workFoldLimitsSettings.frozenNote}</span> : null}

      <h4 id="work-fold-limits-app-requests-title">{workFoldLimitsSettings.appRequestsHeading}</h4>
      <LimitRows
        rows={[
          ["Worker request input", kib(assistant.inputBytes)],
          ["Worker result returned to the app", kib(assistant.resultBytes)],
          ["Worker requests running per app", String(assistant.runningPerInstallation)],
          ["Short answer instructions", kib(inference.instructionsBytes)],
          ["Short answer input", kib(inference.inputBytes)],
          ["Short answer result shape", kib(inference.schemaBytes)],
          ["Short answer result", inference.defaultOutputBytes === inference.maxOutputBytes
            ? kib(inference.maxOutputBytes)
            : `${kib(inference.defaultOutputBytes)} by default, up to ${kib(inference.maxOutputBytes)}`],
          ["Short answers running per app", `${inference.runningPerInstallation}, with ${inference.waitingPerInstallation} more waiting`],
          ["Short answers running on this computer", String(inference.runningMachineWide)],
        ]}
      />

      <h4>Live Extension Questions</h4>
      <LimitRows rows={[
        ["Pending Extension questions per Chat", String(workFoldExtensionUiLimits.pendingPerChat)],
        ["Pending Extension questions on this computer", String(workFoldExtensionUiLimits.pendingTotal)],
        ["Choices in an Extension question", String(workFoldExtensionUiLimits.options)],
        ["An Extension question", kib(workFoldExtensionUiLimits.requestBytes)],
        ["An Extension answer or editor text", kib(workFoldExtensionUiLimits.answerBytes)],
      ]} />

      <h4 id="work-fold-limits-requests-title">{workFoldLimitsSettings.requestsHeading}</h4>
      <LimitRows
        rows={[
          ["Model spending for one request", requests.providerBudgetUsd === null ? "No limit" : `$${formatNumber(requests.providerBudgetUsd)}`],
          ["A question a Worker or the work-fold agent asks", kib(requests.maxQuestionTextBytes)],
          ["An answer you give", kib(requests.maxAnswerTextBytes)],
          ["A result summary", kib(requests.maxResultSummaryBytes)],
          ["Result Details", kib(requests.maxResultDataBytes)],
          ["Kept for", `${requests.retentionDays} days`],
        ]}
      />
      <ContinuationsSwitch />

      <h4 id="work-fold-limits-automations-title">{workFoldLimitsSettings.automationsHeading}</h4>
      <LimitRows
        rows={[
          ["Automation runs at once", String(workFoldAutomationMaxConcurrentRuns)],
          ["Message a step sends", kib(automation.maxChatMessageBytes)],
          ["Message after filled-in details", kib(automation.maxResolvedMessageBytes)],
          ["One filled-in detail", `${kib(automation.maxPlaceholderTextBytes)}, up to ${automation.maxPlaceholderListItems} items`],
        ]}
      />

      <h4 id="work-fold-limits-app-automations-title">{workFoldLimitsSettings.appAutomationsHeading}</h4>
      <LimitRows rows={[["Automations running on this computer", String(workFoldAppAutomationDefaultConcurrency)]]} />

      <h4 id="work-fold-limits-deleted-title">{workFoldLimitsSettings.deletedHeading}</h4>
      <LimitRows rows={[["Kept for", `${workFoldRecentlyDeletedDefaultRetentionDays} days unless you change it`]]} />
      {onOpenRecentlyDeleted ? (
        <div className="settings-actions">
          <button className="ui-control" type="button" onClick={onOpenRecentlyDeleted}>
            {workFoldLimitsSettings.deletedLink}
          </button>
        </div>
      ) : null}
    </details>
  );
}
