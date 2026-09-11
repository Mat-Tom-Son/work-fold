import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";

import {
  workFoldRequestLimitMessage,
  type WorkFoldRequestLimitName,
} from "../src/local/requests/request-records.js";
import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";
import { restrictedAppAssistantLimits } from "../src/shared/restricted-app-tasks.js";
import {
  workFoldAutomationDefaultConcurrency,
  workFoldRequestLimits,
  workFoldRoutingDeclarationBounds,
  workFoldRoutingMaxConcurrentRuns,
} from "../src/shared/fold-limits.js";
import { FoldLimitsPane } from "../web-local/src/components/modals/FoldLimitsPane.js";
import { createDomHarness } from "./support/dom.js";

/**
 * Settings → The fold → Limits (docs/receipts-not-gates.md, F19 principle 6).
 * Bounds are defaults, not gates, and they are visible in Settings. Every
 * app-facing refusal names "Settings → The fold → Limits", so this suite pins
 * that the section exists, that it is read-only, and that the numbers it shows
 * are the frozen constants the host enforces rather than retyped copies.
 */

const [settingsSource, paneSource, tasksSource, inferenceSource] = await Promise.all([
  readFile(new URL("../web-local/src/components/modals/DesktopSettingsModal.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web-local/src/components/modals/FoldLimitsPane.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/local/agent/restricted-app-tasks.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/local/agent/restricted-app-inference.ts", import.meta.url), "utf8"),
]);

test("the surface every limit message names is a real fold Settings section", () => {
  // The phrase the refusals interpolate.
  for (const [label, source] of [["tasks", tasksSource], ["inference", inferenceSource]] as const) {
    assert.match(
      source,
      /const limitsSection = "Settings → The fold → Limits";/,
      `${label} refusals still name the Limits section`,
    );
  }
  assert.match(settingsSource, /type FoldSettingsSection = [^;]*\| "limits";/);
  assert.match(settingsSource, /"limits",\s*"Limits"/);
  assert.match(settingsSource, /foldSection === "limits" \? <FoldLimitsPane/);
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

  assert.match(text, /Limits/);
  assert.ok(text.includes(`${restrictedAppAssistantLimits.inputBytes / 1024} KB`), "the 64 KB Chat request input bound is shown");
  assert.ok(text.includes(`${restrictedAppAssistantLimits.resultBytes / 1024} KB`), "the 256 KB Chat result bound is shown");
  assert.ok(
    text.includes(`Chat requests running per app${restrictedAppAssistantLimits.runningPerInstallation}`),
    "the four-running-per-app bound is shown",
  );
  assert.ok(text.includes(`${restrictedAppInferenceLimits.instructionsBytes / 1024} KB`), "the short-answer instruction bound is shown");
  assert.ok(text.includes(`${restrictedAppInferenceLimits.timeoutMs / 1000} seconds`), "the short-answer time budget is shown");
  assert.ok(
    text.includes(`Short answers running on this computer${restrictedAppInferenceLimits.runningMachineWide}`),
    "the machine-wide inference bound is shown",
  );
  assert.ok(text.includes(`Steps in one routing${workFoldRoutingDeclarationBounds.maxSteps}`), "the raised step default is shown");
  assert.ok(text.includes(`Routing runs at once${workFoldRoutingMaxConcurrentRuns}`), "the raised run-slot default is shown");
  assert.ok(
    text.includes(`Automations running on this computer${workFoldAutomationDefaultConcurrency}`),
    "the automation concurrency default is shown",
  );

  // The request bounds every collaboration refusal names (docs/collaboration-contract.md).
  assert.ok(text.includes(`How long one request stays open${workFoldRequestLimits.deadlineMs / 3_600_000} hours`), "the request window is shown");
  assert.ok(text.includes(`Space turns one request may start${workFoldRequestLimits.maxChildRequestsPerRoot}`), "the child count is shown");
  assert.ok(text.includes(`How far a request may hand work on${workFoldRequestLimits.maxDelegationDepth} levels`), "the depth is shown");
  assert.ok(text.includes(`Space turns running together${workFoldRequestLimits.maxConcurrentChildrenPerRoot}`), "the concurrency is shown");
  assert.ok(text.includes(`Follow-up turns after work settles${workFoldRequestLimits.maxContinuationsPerRoot}`), "the continuation count is shown");
  assert.ok(text.includes("Model spending for one requestNo limit"), "no spending cap is shipped");
  assert.ok(text.includes(`A result summary${workFoldRequestLimits.maxResultSummaryBytes / 1024} KB`), "the summary bound is shown");
  assert.ok(text.includes(`Result details${workFoldRequestLimits.maxResultDataBytes / 1024} KB`), "the data bound is shown");
  assert.ok(text.includes(`Files one result may name${workFoldRequestLimits.maxResultFiles}`), "the file count is shown");
});

/**
 * Every request refusal ends with "Settings → The fold → Limits shows this
 * number." A bound whose refusal says that and whose number is not in the
 * pane sends a person somewhere that does not answer them, which is exactly
 * the gate-in-disguise principle 6 forbids. This pins one row per bound, so a
 * new `WorkFoldRequestLimitName` cannot be added without one.
 */
test("every request bound whose refusal names the Limits section has a row in it", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(FoldLimitsPane));
  const text = dom.container.textContent ?? "";

  const limits = workFoldRequestLimits;
  const kb = (bytes: number): string => `${bytes / 1024} KB`;
  const window = `${limits.deadlineMs / 3_600_000} hours`;
  const rows: Record<WorkFoldRequestLimitName, string> = {
    deadline: `How long one request stays open${window}`,
    questionLifetime: `How long one request stays open${window}`,
    childTasks: `Space turns one request may start${limits.maxChildRequestsPerRoot}`,
    depth: `How far a request may hand work on${limits.maxDelegationDepth} levels`,
    concurrentChildren: `Space turns running together${limits.maxConcurrentChildrenPerRoot}`,
    continuations: `Follow-up turns after work settles${limits.maxContinuationsPerRoot}`,
    providerBudget: "Model spending for one requestNo limit",
    questionText: `A question the Assistant asks${kb(limits.maxQuestionTextBytes)}`,
    answerText: `An answer you give${kb(limits.maxAnswerTextBytes)}`,
    resultSummary: `A result summary${kb(limits.maxResultSummaryBytes)}`,
    resultData: `Result details${kb(limits.maxResultDataBytes)}`,
    resultFiles: `Files one result may name${limits.maxResultFiles}`,
    questionsPerRequest: `Questions one request may hold${limits.maxQuestionsPerRequest}`,
    resultsPerRequest: `Results one request may hold${limits.maxResultsPerRequest}`,
    turnsPerRequest: `Turns one request may hold${limits.maxTurnsPerRequest}`,
    actionsPerRequest: `Actions one request may record${limits.maxActionsPerRequest}`,
  };

  for (const [name, row] of Object.entries(rows) as Array<[WorkFoldRequestLimitName, string]>) {
    assert.match(
      workFoldRequestLimitMessage(name, 1),
      /Settings → The fold → Limits shows this number\.$/,
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
    .find((button) => button.textContent?.trim() === "Open Recently deleted");
  assert.ok(link, "the pane offers a way into Recently deleted");
  await dom.act(() => { link?.click(); });
  assert.equal(opened, 1);
});
