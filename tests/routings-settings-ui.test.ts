import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";

import {
  FoldRoutingsPane,
  type FoldRoutingDetailResponse,
  type FoldRoutingHealth,
  type FoldRoutingHistoryResponse,
  type FoldRoutingsResponse,
} from "../web-local/src/components/modals/FoldRoutingsPane.js";
import { createDomHarness } from "./support/dom.js";

const [settingsSource, paneSource, mainPreload, popoverPreload, desktopMain] = await Promise.all([
  readFile(new URL("../web-local/src/components/modals/DesktopSettingsModal.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web-local/src/components/modals/FoldRoutingsPane.tsx", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/management-popover-preload.cts", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8"),
]);

test("The fold Settings includes Routings without introducing a builder", () => {
  assert.match(settingsSource, /type FoldSettingsSection = "access" \| "pages" \| "routings" \| "authority"/);
  assert.match(settingsSource, /"routings",\s*"Routings"/);
  assert.match(settingsSource, /foldSection === "routings" \? <FoldRoutingsPane \/>/);
  assert.doesNotMatch(paneSource, /builder|cron|RRULE/i);
  assert.match(paneSource, /No routings yet\. Ask the fold to set one up\./);
});

test("Routing Settings has no HTTP fallback and stays on the trusted main-window bridge", () => {
  assert.doesNotMatch(paneSource, /\/api\/settings\/routings|\bfetch\s*\(|\bapi\s*[<(]/);
  assert.match(paneSource, /window\.workFoldDesktop\?\.routings/);

  for (const [method, channel] of [
    ["list", "list"],
    ["show", "show"],
    ["history", "history"],
    ["stageEnable", "stage-enable"],
    ["run", "run"],
    ["stop", "stop"],
    ["disable", "disable"],
    ["delete", "delete"],
  ] as const) {
    assert.match(mainPreload, new RegExp(`${method}:.*ipcRenderer\\.invoke\\("work-fold:routings:${channel}"`));
    assert.match(desktopMain, new RegExp(`ipcMain\\.handle\\("work-fold:routings:${channel}"[\\s\\S]{0,220}routingSettings\\(event`));
  }
  assert.match(desktopMain, /const routingSettings = async \(event:[\s\S]{0,180}assertTrustedMainRenderer\(event\)/);
  assert.doesNotMatch(popoverPreload, /work-fold:routings:|\broutings\s*:/);
});

test("Routing actions are gated by enabled, disabled, suspended, and completed health", async (t) => {
  const expectations: Array<{ health: FoldRoutingHealth; shown: string[]; hidden: string[] }> = [
    { health: "enabled", shown: ["Run a copy now", "Turn off"], hidden: ["Ask to turn on", "Delete", "Stop"] },
    { health: "disabled", shown: ["Ask to turn on", "Delete"], hidden: ["Run a copy now", "Turn off", "Stop"] },
    { health: "suspended", shown: ["Ask to turn on", "Delete"], hidden: ["Run a copy now", "Turn off", "Stop"] },
    { health: "completed", shown: ["Delete"], hidden: ["Run a copy now", "Ask to turn on", "Turn off", "Stop"] },
  ];

  for (const expectation of expectations) {
    const dom = await createDomHarness();
    t.after(() => dom.cleanup());
    installRoutingBridge(expectation.health);
    await dom.render(createElement(FoldRoutingsPane));
    await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));

    const labels = [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")]
      .map((button) => button.textContent?.trim() ?? "");
    for (const label of expectation.shown) assert.ok(labels.includes(label), `${expectation.health} shows ${label}`);
    for (const label of expectation.hidden) assert.ok(!labels.includes(label), `${expectation.health} hides ${label}`);

    await dom.cleanup();
  }
});

test("an active run exposes Stop and prevents conflicting actions", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  installRoutingBridge("enabled", true);
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));

  assert.ok(buttonLabels(dom.container).includes("Stop"));
  const run = [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")]
    .find((button) => button.textContent?.trim() === "Run a copy now");
  assert.equal(run?.disabled, true, "same-routing non-overlap disables another copy while active");
  assert.ok(!buttonLabels(dom.container).includes("Delete"), "an active completed occurrence cannot be deleted");
});

test("a completed one-time routing hides Delete until its active run settles", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  installRoutingBridge("completed", true);
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));

  assert.ok(buttonLabels(dom.container).includes("Stop"));
  assert.ok(!buttonLabels(dom.container).includes("Delete"));
});

test("Run a copy now invokes the preload bridge, never a network request", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls = installRoutingBridge("enabled");
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));

  const run = [...dom.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Run a copy now");
  assert.ok(run);
  await dom.act(async () => {
    run.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await dom.waitFor(() => calls.run === 1);
  assert.equal(calls.run, 1);
  await dom.waitFor(() => /Run requested/.test(dom.container.textContent ?? ""));
  assert.match(dom.container.textContent ?? "", /Run requested/);
});

test("an admitted queued run stays visible until its exact history entry settles", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls = installRoutingBridge("enabled");
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));

  const run = [...dom.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Run a copy now");
  assert.ok(run);
  await dom.act(async () => {
    run.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await dom.waitFor(() => buttonLabels(dom.container).includes("Starting…"));
  const queued = [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")]
    .find((button) => button.textContent?.trim() === "Starting…");
  assert.equal(queued?.disabled, true);
  assert.match(dom.container.textContent ?? "", /Starting/);

  calls.completeRun();
  await dom.waitFor(() => buttonLabels(dom.container).includes("Run a copy now"));
  assert.equal(calls.run, 1, "polling the exact run never re-admits it");
});

test("damaged run history blocks widening actions but leaves narrowing actions available", async (t) => {
  const enabledDom = await createDomHarness();
  installRoutingBridge("enabled", false, true);
  await enabledDom.render(createElement(FoldRoutingsPane));
  await enabledDom.waitFor(() => Boolean(enabledDom.container.querySelector(".fold-routing-inspector-header")));
  const enabledButtons = [...enabledDom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")];
  assert.equal(enabledButtons.find((button) => button.textContent?.trim() === "Run a copy now")?.disabled, true);
  assert.equal(enabledButtons.find((button) => button.textContent?.trim() === "Turn off")?.disabled, false);
  await enabledDom.cleanup();

  const runningDom = await createDomHarness();
  installRoutingBridge("enabled", true, true);
  await runningDom.render(createElement(FoldRoutingsPane));
  await runningDom.waitFor(() => Boolean(runningDom.container.querySelector(".fold-routing-inspector-header")));
  assert.equal([...runningDom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")]
    .find((button) => button.textContent?.trim() === "Stop")?.disabled, false);
  await runningDom.cleanup();

  const disabledDom = await createDomHarness();
  installRoutingBridge("disabled", false, true);
  await disabledDom.render(createElement(FoldRoutingsPane));
  await disabledDom.waitFor(() => Boolean(disabledDom.container.querySelector(".fold-routing-inspector-header")));
  const disabledButtons = [...disabledDom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")];
  assert.equal(disabledButtons.find((button) => button.textContent?.trim() === "Ask to turn on")?.disabled, true);
  assert.equal(disabledButtons.find((button) => button.textContent?.trim() === "Delete")?.disabled, false);
  await disabledDom.cleanup();
});

test("a late polling response cannot replace a newly selected routing or retarget its actions", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const bridge = installSwitchingRoutingBridge();
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => /Routing A/.test(dom.container.textContent ?? ""));
  await dom.waitFor(() => bridge.showACalls() === 2, 2_500);

  const routingB = [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-list-row")]
    .find((button) => /Routing B/.test(button.textContent ?? ""));
  assert.ok(routingB);
  await dom.act(async () => { routingB.click(); });
  await dom.waitFor(() => dom.container.querySelector(".fold-routing-inspector-header h4")?.textContent === "Routing B");

  bridge.resolveLateA();
  await dom.settle();
  assert.equal(dom.container.querySelector(".fold-routing-inspector-header h4")?.textContent, "Routing B");

  const turnOff = [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")]
    .find((button) => button.textContent?.trim() === "Turn off");
  assert.ok(turnOff);
  await dom.act(async () => {
    turnOff.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await dom.waitFor(() => bridge.disabledIds.length === 1);
  assert.deepEqual(bridge.disabledIds, ["routing-b"]);
});

test("desktop wake catches asynchronous routing resume failures", () => {
  assert.match(desktopMain, /routingPowerLifecycle\?\.resume\(\)\.catch\(\(error\) =>/);
  assert.match(desktopMain, /could not resume Routings after wake/);
});

function installRoutingBridge(health: FoldRoutingHealth, running = false, journalDamaged = false): {
  run: number;
  completeRun: () => void;
} {
  let runSettled = false;
  const calls = {
    run: 0,
    completeRun: () => { runSettled = true; },
  };
  const activeRun = running ? { runId: "run-1", startedAt: "2026-09-01T12:00:00.000Z" } : undefined;
  const summary = {
    routingId: "routing-ui-test",
    title: "Prepare the handoff",
    health,
    trigger: { kind: "manual" as const },
    stepCount: 1,
    ...(activeRun ? { activeRun } : {}),
  };
  const list: FoldRoutingsResponse = {
    routings: [summary],
    status: {
      storeDamaged: false,
      journalDamaged,
      ...(journalDamaged ? { journalDamageReason: "The run journal is damaged." } : {}),
      activeRunCount: running ? 1 : 0,
    },
  };
  const show: FoldRoutingDetailResponse = {
    routing: {
      ...summary,
      createdAt: "2026-09-01T11:00:00.000Z",
      spaces: [{ spaceId: "space-a", spaceName: "Client launch" }],
      steps: [{ id: "handoff", kind: "chat", space: { spaceId: "space-a", spaceName: "Client launch" }, message: "Prepare the handoff." }],
      ...(health === "suspended" ? { suspension: { at: "2026-09-01T11:30:00.000Z", reason: "A referenced Space was removed." } } : {}),
      ...(health === "completed" ? { completedAt: "2026-09-01T12:00:00.000Z" } : {}),
    },
  };
  const history = (): FoldRoutingHistoryResponse => ({
    runs: runSettled ? [{
      runId: "run-1",
      outcome: "succeeded",
      startedAt: "2026-09-01T12:00:00.000Z",
      finishedAt: "2026-09-01T12:00:01.000Z",
      hops: [],
    }] : [],
    truncated: false,
    damagedLineCount: 0,
  });
  Object.defineProperty(window, "workFoldDesktop", {
    configurable: true,
    value: {
      routings: {
        list: async () => list,
        show: async () => show,
        history: async () => history(),
        stageEnable: async () => ({ routingId: summary.routingId, decisionId: "decision-1", state: "staged" as const }),
        run: async () => {
          calls.run += 1;
          return { routingId: summary.routingId, requestId: "settings:request-1", runId: "run-1", accepted: true as const };
        },
        stop: async () => ({ stopped: true }),
        disable: async () => ({ disabled: true }),
        delete: async () => ({ deleted: true }),
      },
    },
  });
  return calls;
}

function buttonLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".fold-routing-actions button")]
    .map((button) => button.textContent?.trim() ?? "");
}

function installSwitchingRoutingBridge(): {
  disabledIds: string[];
  showACalls: () => number;
  resolveLateA: () => void;
} {
  const disabledIds: string[] = [];
  let aCalls = 0;
  let resolveLateA!: (value: FoldRoutingDetailResponse) => void;
  const lateA = new Promise<FoldRoutingDetailResponse>((resolve) => { resolveLateA = resolve; });
  const summary = (routingId: "routing-a" | "routing-b") => ({
    routingId,
    title: routingId === "routing-a" ? "Routing A" : "Routing B",
    health: "enabled" as const,
    trigger: { kind: "manual" as const },
    stepCount: 1,
    ...(routingId === "routing-a"
      ? { activeRun: { runId: "active-a", startedAt: "2026-09-01T12:00:00.000Z" } }
      : {}),
  });
  const detail = (routingId: "routing-a" | "routing-b"): FoldRoutingDetailResponse => ({
    routing: {
      ...summary(routingId),
      createdAt: "2026-09-01T11:00:00.000Z",
      spaces: [{ spaceId: "space-a", spaceName: "Client launch" }],
      steps: [{
        id: "handoff",
        kind: "chat",
        space: { spaceId: "space-a", spaceName: "Client launch" },
        message: routingId === "routing-a" ? "Run A." : "Run B.",
      }],
    },
  });
  const list: FoldRoutingsResponse = {
    routings: [summary("routing-a"), summary("routing-b")],
    status: { storeDamaged: false, journalDamaged: false, activeRunCount: 1 },
  };
  const history: FoldRoutingHistoryResponse = { runs: [], truncated: false, damagedLineCount: 0 };
  Object.defineProperty(window, "workFoldDesktop", {
    configurable: true,
    value: {
      routings: {
        list: async () => list,
        show: async (routingId: string) => {
          if (routingId === "routing-a") {
            aCalls += 1;
            if (aCalls === 2) return await lateA;
          }
          return detail(routingId as "routing-a" | "routing-b");
        },
        history: async () => history,
        stageEnable: async (routingId: string) => ({ routingId, decisionId: "decision-1", state: "staged" as const }),
        run: async (routingId: string) => ({ routingId, requestId: "settings:request-1", runId: "run-1", accepted: true as const }),
        stop: async () => ({ stopped: true }),
        disable: async (routingId: string) => {
          disabledIds.push(routingId);
          return { disabled: true };
        },
        delete: async () => ({ deleted: true }),
      },
    },
  });
  return {
    disabledIds,
    showACalls: () => aCalls,
    resolveLateA: () => resolveLateA(detail("routing-a")),
  };
}
