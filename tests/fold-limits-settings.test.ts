import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";

import {
  workFoldRequestLimitMessage,
  type WorkFoldRequestLimitName,
} from "../src/local/requests/request-records.js";
import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";
import { restrictedAppAssistantLimits, restrictedAppLimitSize } from "../src/shared/restricted-app-tasks.js";
import {
  workFoldAutomationDefaultConcurrency,
  workFoldExtensionUiLimits,
  workFoldRequestLimits,
  workFoldRoutingDeclarationBounds,
  workFoldRoutingMaxConcurrentRuns,
} from "../src/shared/fold-limits.js";
import { FoldLimitsPane } from "../web-local/src/components/modals/FoldLimitsPane.js";
import { createDomHarness } from "./support/dom.js";

/**
 * Settings → Automations → Limits (docs/receipts-not-gates.md, F19 principle 6).
 * Bounds are defaults, not gates, and they are visible in Settings. Every
 * app-facing refusal names "Settings → Automations → Limits", so this suite pins
 * that the section exists, that it is read-only, and that the numbers it shows
 * are the frozen constants the host enforces rather than retyped copies.
 */

const [settingsSource, paneSource, tasksSource, inferenceSource] = await Promise.all([
  readFile(new URL("../web-local/src/components/modals/DesktopSettingsModal.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web-local/src/components/modals/FoldLimitsPane.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/local/agent/restricted-app-tasks.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/local/agent/restricted-app-inference.ts", import.meta.url), "utf8"),
]);

/** The pane's own rendering: KB below one MB, MB from there. */
function sizeText(bytes: number): string {
  const kibibytes = bytes / 1024;
  const value = kibibytes >= 1024 ? kibibytes / 1024 : kibibytes;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${kibibytes >= 1024 ? "MB" : "KB"}`;
}

test("the surface every limit message names is a real fold Settings section", () => {
  // The phrase the refusals interpolate.
  for (const [label, source] of [["tasks", tasksSource], ["inference", inferenceSource]] as const) {
    assert.match(
      source,
      /const limitsSection = "Settings → Automations → Limits";/,
      `${label} refusals still name the Limits section`,
    );
  }
  assert.match(settingsSource, /type FoldSettingsSection = [^;]*\| "limits";/);
  assert.match(settingsSource, /id: "automations", label: "Automations"/);
  assert.match(settingsSource, /page === "automations" \? \(\s*<div[^>]*>\s*<FoldRoutingsPane \/>\s*<FoldLimitsPane onOpenRecentlyDeleted=\{\(\) => setPage\("recently-deleted"\)\} \/>/);
});

test("the Limits pane reads the frozen contracts instead of retyping them", () => {
  for (const contract of [
    "restrictedAppAssistantLimits",
    "restrictedAppInferenceLimits",
    "workFoldRequestLimits",
    "workFoldRoutingDeclarationBounds",
    "workFoldRoutingMaxConcurrentRuns",
    "workFoldAutomationDefaultConcurrency",
  ]) {
    assert.ok(paneSource.includes(contract), `the pane sources ${contract}`);
  }
  // Nothing here changes a bound, and nothing here is a gate. The one control
  // is the F28 switch for bringing finished handed-out work back to the fold
  // (docs/collaboration-contract.md); it is the only input and the only API
  // call the pane makes, and turning it off records everything just the same.
  const inputs = paneSource.match(/<input\b/g) ?? [];
  assert.equal(inputs.length, 1, "the pane has exactly one control: the continuation switch");
  assert.match(paneSource, /type="checkbox"/);
  const apiCalls = paneSource.match(/\bapi</g) ?? [];
  assert.equal(apiCalls.length, 2, "one read and one save of the continuation setting, nothing else");
  assert.match(paneSource, /\/api\/settings\/requests\/continuations/);
  assert.doesNotMatch(paneSource, /staged|approve|policy|Reviewed|Unrestricted|\bcard\b|\bmode\b/i);
});

test("the Limits pane shows the assistant, routing, and automation numbers a refusal can name", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(FoldLimitsPane));
  const text = dom.container.textContent ?? "";

  assert.doesNotMatch(text, /How long one request stays open|Steps in one automation|Follow-up turns after work settles|Worker turns running together/);
  assert.ok(text.includes(`Chat request input${restrictedAppLimitSize(restrictedAppAssistantLimits.inputBytes)}`), "the Chat request input bound is shown");
  assert.ok(text.includes(`Chat result returned to the app${restrictedAppLimitSize(restrictedAppAssistantLimits.resultBytes)}`), "the Chat result bound is shown");
  assert.ok(
    text.includes(`Chat requests running per app${restrictedAppAssistantLimits.runningPerInstallation}`),
    "the running-per-app bound is shown",
  );
  assert.ok(text.includes(`Short answer instructions${restrictedAppLimitSize(restrictedAppInferenceLimits.instructionsBytes)}`), "the short-answer instruction bound is shown");
  assert.ok(text.includes(`Short answer input${restrictedAppLimitSize(restrictedAppInferenceLimits.inputBytes)}`), "the short-answer input bound is shown");
  assert.ok(
    text.includes(`Short answers running per app${restrictedAppInferenceLimits.runningPerInstallation}, with ${restrictedAppInferenceLimits.waitingPerInstallation} more waiting`),
    "the per-app inference bound is shown",
  );
  assert.ok(
    text.includes(`Short answers running on this computer${restrictedAppInferenceLimits.runningMachineWide}`),
    "the machine-wide inference bound is shown",
  );
  assert.ok(text.includes(`Automation runs at once${workFoldRoutingMaxConcurrentRuns}`), "the raised run-slot default is shown");
  assert.ok(
    text.includes(`Automations running on this computer${workFoldAutomationDefaultConcurrency}`),
    "the automation concurrency default is shown",
  );

  // The request bounds every collaboration refusal names (docs/collaboration-contract.md).
  assert.ok(text.includes("Model spending for one requestNo limit"), "no spending cap is shipped");
  assert.ok(text.includes(`A result summary${sizeText(workFoldRequestLimits.maxResultSummaryBytes)}`), "the summary bound is shown");
  assert.ok(text.includes(`Result Details${sizeText(workFoldRequestLimits.maxResultDataBytes)}`), "the data bound is shown");
  assert.ok(text.includes(`Pending Extension questions per Chat${workFoldExtensionUiLimits.pendingPerChat}`));
  assert.ok(text.includes(`An Extension answer or editor text${sizeText(workFoldExtensionUiLimits.answerBytes)}`));
});

/**
 * Current request transport bounds and the optional spending cap point at
 * Settings → Automations → Limits. Historical quota names remain readable in
 * durable records but must not reappear as current limits in this pane.
 */
test("current request transport bounds and the optional budget have rows in Limits", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(FoldLimitsPane));
  const text = dom.container.textContent ?? "";

  const limits = workFoldRequestLimits;
  const rows: Partial<Record<WorkFoldRequestLimitName, string>> = {
    providerBudget: "Model spending for one requestNo limit",
    questionText: `A question an agent asks${sizeText(limits.maxQuestionTextBytes)}`,
    answerText: `An answer you give${sizeText(limits.maxAnswerTextBytes)}`,
    resultSummary: `A result summary${sizeText(limits.maxResultSummaryBytes)}`,
    resultData: `Result Details${sizeText(limits.maxResultDataBytes)}`,
  };

  for (const [name, row] of Object.entries(rows) as Array<[WorkFoldRequestLimitName, string]>) {
    assert.match(
      workFoldRequestLimitMessage(name, 1),
      /Settings → Automations → Limits shows this number\.$/,
      `the ${name} refusal points at the Limits pane`,
    );
    assert.ok(text.includes(row), `the ${name} bound has a row reading "${row}"`);
  }
});

test("the Limits pane links to Recently deleted rather than setting retention itself", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let opened = 0;
  await dom.render(createElement(FoldLimitsPane, { onOpenRecentlyDeleted: () => { opened += 1; } }));
  const link = [...dom.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Open Recently Deleted");
  assert.ok(link, "the pane offers a way into Recently deleted");
  await dom.act(() => { link?.click(); });
  assert.equal(opened, 1);
});
