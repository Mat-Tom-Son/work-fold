import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";

import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";
import { restrictedAppAssistantLimits } from "../src/shared/restricted-app-tasks.js";
import {
  workFoldAutomationDefaultConcurrency,
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
    "workFoldRoutingDeclarationBounds",
    "workFoldRoutingMaxConcurrentRuns",
    "workFoldAutomationDefaultConcurrency",
  ]) {
    assert.ok(paneSource.includes(contract), `the pane sources ${contract}`);
  }
  // Read-only this wave: nothing here changes a bound, and nothing here is a gate.
  assert.doesNotMatch(paneSource, /<input|api</);
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
