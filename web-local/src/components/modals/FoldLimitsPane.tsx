import { useEffect, useState } from "react";

import { restrictedAppInferenceLimits } from "../../../../src/shared/restricted-app-inference";
import { restrictedAppAssistantLimits } from "../../../../src/shared/restricted-app-tasks";
import {
  workFoldAutomationDefaultConcurrency,
  workFoldRequestContinuationsDefaultEnabled,
  workFoldRequestLimits,
  workFoldRoutingDeclarationBounds,
  workFoldRoutingMaxConcurrentRuns,
  workFoldTrashDefaultRetentionDays,
} from "../../../../src/shared/fold-limits";
import { api, errorText } from "../../lib/api";
import { foldLimitsSettings } from "../../ui-contract";

/**
 * Settings → The fold → Limits (docs/receipts-not-gates.md, F19 principle 6:
 * bounds are visible and named). Every app and routing refusal names this
 * section, so this pane is where those phrases resolve.
 *
 * The bounds are frozen constants. The one adjustable number — how long
 * Recently deleted keeps an item — is set in its own pane, which this one
 * links to, and the one switch — whether finished handed-out work is brought
 * back to its owner as a turn (docs/collaboration-contract.md, F28) — lives
 * here. Every shown value is read from the frozen contract the host enforces
 * (`restrictedAppAssistantLimits`, `restrictedAppInferenceLimits`,
 * `workFoldRequestLimits`, `workFoldRoutingDeclarationBounds`,
 * `workFoldRoutingMaxConcurrentRuns`, `workFoldAutomationDefaultConcurrency`),
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
        if (!cancelled) setError(foldLimitsSettings.continuationsUnavailable);
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
      setNotice(foldLimitsSettings.continuationsSaved);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const checked = enabled ?? workFoldRequestContinuationsDefaultEnabled;
  return (
    <>
      <h4 id="fold-limits-continuations-title">{foldLimitsSettings.continuationsHeading}</h4>
      <p>{foldLimitsSettings.continuationsIntro}</p>
      <div className="settings-actions">
        <label htmlFor="fold-limits-continuations">
          <input
            id="fold-limits-continuations"
            type="checkbox"
            checked={checked}
            disabled={enabled === null || busy}
            onChange={(event) => { void save(event.target.checked); }}
          />
          {" "}
          {foldLimitsSettings.continuationsLabel}
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

function seconds(milliseconds: number): string {
  return `${formatNumber(milliseconds / 1000)} seconds`;
}

function hours(milliseconds: number): string {
  const value = milliseconds / 3_600_000;
  return `${formatNumber(value)} hour${value === 1 ? "" : "s"}`;
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

export function FoldLimitsPane({ onOpenRecentlyDeleted }: { onOpenRecentlyDeleted?: () => void }) {
  const assistant = restrictedAppAssistantLimits;
  const inference = restrictedAppInferenceLimits;
  const routing = workFoldRoutingDeclarationBounds;
  const requests = workFoldRequestLimits;

  return (
    <section className="settings-section" aria-labelledby="fold-limits-title">
      <div className="settings-section-heading">
        <h3 id="fold-limits-title">{foldLimitsSettings.heading}</h3>
        <span>{foldLimitsSettings.frozenNote}</span>
      </div>
      <p>{foldLimitsSettings.intro}</p>

      <h4 id="fold-limits-assistant-title">{foldLimitsSettings.assistantHeading}</h4>
      <p>{foldLimitsSettings.assistantIntro}</p>
      <LimitRows
        rows={[
          ["Chat request instructions", kib(assistant.instructions)],
          ["Chat request input", kib(assistant.inputBytes)],
          ["Chat result returned to the app", kib(assistant.resultBytes)],
          ["Chat requests running per app", String(assistant.runningPerInstallation)],
          ["Short answer instructions", kib(inference.instructionsBytes)],
          ["Short answer input", kib(inference.inputBytes)],
          ["Short answer result shape", kib(inference.schemaBytes)],
          ["Short answer result", `${kib(inference.defaultOutputBytes)} by default, up to ${kib(inference.maxOutputBytes)}`],
          ["Short answers running per app", `${inference.runningPerInstallation}, with ${inference.waitingPerInstallation} more waiting`],
          ["Short answers running on this computer", String(inference.runningMachineWide)],
          ["Time one short answer may take", seconds(inference.timeoutMs)],
        ]}
      />

      <h4 id="fold-limits-requests-title">{foldLimitsSettings.requestsHeading}</h4>
      <p>{foldLimitsSettings.requestsIntro}</p>
      <LimitRows
        rows={[
          ["How long one request stays open", hours(requests.deadlineMs)],
          ["Space turns one request may start", String(requests.maxChildRequestsPerRoot)],
          ["How far a request may hand work on", `${requests.maxDelegationDepth} levels`],
          ["Space turns running together", String(requests.maxConcurrentChildrenPerRoot)],
          ["Follow-up turns after work settles", String(requests.maxContinuationsPerRoot)],
          ["Model spending for one request", requests.providerBudgetUsd === null ? "No limit" : `$${formatNumber(requests.providerBudgetUsd)}`],
          ["A question the Assistant asks", kib(requests.maxQuestionTextBytes)],
          ["An answer you give", kib(requests.maxAnswerTextBytes)],
          ["A result summary", kib(requests.maxResultSummaryBytes)],
          ["Result details", kib(requests.maxResultDataBytes)],
          ["Files one result may name", String(requests.maxResultFiles)],
          ["Questions one request may hold", String(requests.maxQuestionsPerRequest)],
          ["Results one request may hold", String(requests.maxResultsPerRequest)],
          ["Turns one request may hold", String(requests.maxTurnsPerRequest)],
          ["Actions one request may record", String(requests.maxActionsPerRequest)],
          ["Kept for", `${requests.retentionDays} days`],
        ]}
      />
      <ContinuationsSwitch />

      <h4 id="fold-limits-routings-title">{foldLimitsSettings.routingsHeading}</h4>
      <p>{foldLimitsSettings.routingsIntro}</p>
      <LimitRows
        rows={[
          ["Steps in one routing", String(routing.maxSteps)],
          ["Routings on this computer", String(routing.maxRoutingsPerMachine)],
          ["Routing runs at once", String(workFoldRoutingMaxConcurrentRuns)],
          ["Message a step sends", kib(routing.maxChatMessageBytes)],
          ["Message after filled-in details", kib(routing.maxResolvedMessageBytes)],
          ["One filled-in detail", `${kib(routing.maxPlaceholderTextBytes)}, up to ${routing.maxPlaceholderListItems} items`],
          ["Files one step may copy", String(routing.maxExactPathsPerFilesStep)],
        ]}
      />

      <h4 id="fold-limits-automations-title">{foldLimitsSettings.automationsHeading}</h4>
      <p>{foldLimitsSettings.automationsIntro}</p>
      <LimitRows rows={[["Automations running on this computer", String(workFoldAutomationDefaultConcurrency)]]} />

      <h4 id="fold-limits-deleted-title">{foldLimitsSettings.deletedHeading}</h4>
      <p>{foldLimitsSettings.deletedIntro}</p>
      <LimitRows rows={[["Kept for", `${workFoldTrashDefaultRetentionDays} days unless you change it`]]} />
      {onOpenRecentlyDeleted ? (
        <div className="settings-actions">
          <button className="secondary-button" type="button" onClick={onOpenRecentlyDeleted}>
            {foldLimitsSettings.deletedLink}
          </button>
        </div>
      ) : null}
    </section>
  );
}
