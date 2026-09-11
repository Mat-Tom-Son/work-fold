import { restrictedAppInferenceLimits } from "../../../../src/shared/restricted-app-inference";
import { restrictedAppAssistantLimits } from "../../../../src/shared/restricted-app-tasks";
import {
  workFoldAutomationDefaultConcurrency,
  workFoldRoutingDeclarationBounds,
  workFoldRoutingMaxConcurrentRuns,
  workFoldTrashDefaultRetentionDays,
} from "../../../../src/shared/fold-limits";
import { foldLimitsSettings } from "../../ui-contract";

/**
 * Settings → The fold → Limits (docs/receipts-not-gates.md, F19 principle 6:
 * bounds are defaults, not caps, and they are "visible in Settings where a
 * person might want to raise them"). Every app and routing refusal names this
 * section, so this pane is where those phrases resolve.
 *
 * Read-only this wave: the bounds are frozen constants, and the one adjustable
 * number — how long Recently deleted keeps an item — is set in its own pane,
 * which this one links to. Every value is read from the frozen contract the
 * host enforces (`restrictedAppAssistantLimits`, `restrictedAppInferenceLimits`,
 * `workFoldRoutingDeclarationBounds`, `workFoldRoutingMaxConcurrentRuns`,
 * `workFoldAutomationDefaultConcurrency`), so the shown number cannot drift
 * from the enforced one.
 */

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
