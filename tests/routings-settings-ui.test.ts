import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, Fragment } from "react";
import { useFolderAutomations } from "../web-local/src/hooks/useFolderAutomations.js";

import {
  FoldRoutingsPane,
  type FoldRoutingDetailResponse,
  type FoldRoutingHealth,
  type FoldRoutingHistoryResponse,
  type FoldRoutingProposalsResponse,
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

test("General Settings includes Automations without introducing a builder", () => {
  assert.match(settingsSource, /type FoldSettingsSection = "routings" \| "deleted" \| "limits";/);
  assert.match(settingsSource, /id: "web-access", label: "Web Access"/);
  assert.match(settingsSource, /id: "shared-pages", label: "Shared Pages"/);
  assert.match(settingsSource, /id: "automations", label: "Automations"/);
  assert.match(settingsSource, /id: "recently-deleted", label: "Recently Deleted"/);
  assert.match(settingsSource, /page === "automations" \? \(\s*<div[^>]*>\s*<FoldRoutingsPane \/>/);
  assert.doesNotMatch(paneSource, /builder|cron|RRULE/i);
  // The two residuals `routings show` prints are mirrored here, so both
  // surfaces tell a person the same thing (docs/fold-routings.md).
  assert.match(paneSource, /While this automation is on/);
  assert.match(paneSource, /Standing channel: whatever step \{handoff\.from\}/);
  assert.match(paneSource, /worker turn uses the permissions its folder has at that moment/);
  assert.match(paneSource, /No automations yet\./);
  // receipts-not-gates: nothing in this pane asks for permission or names an
  // authority mode; turning a routing on is one receipted click.
  assert.doesNotMatch(paneSource, /staged|approve|policy|Reviewed|Unrestricted|\bcard\b|\bmode\b/i);
});

test("Routing Settings has no HTTP fallback and stays on the trusted main-window bridge", () => {
  assert.doesNotMatch(paneSource, /\/api\/settings\/routings|\bfetch\s*\(|\bapi\s*[<(]/);
  assert.match(paneSource, /window\.workFoldDesktop\?\.routings/);

  for (const [method, channel] of [
    ["list", "list"],
    ["proposals", "proposals"],
    ["enableProposal", "enable-proposal"],
    ["show", "show"],
    ["history", "history"],
    ["enable", "enable"],
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
    { health: "enabled", shown: ["Run a copy now", "Turn Off"], hidden: ["Turn On", "Delete", "Stop"] },
    { health: "disabled", shown: ["Turn On", "Delete"], hidden: ["Run a copy now", "Turn Off", "Stop"] },
    { health: "suspended", shown: ["Turn On", "Delete"], hidden: ["Run a copy now", "Turn Off", "Stop"] },
    { health: "completed", shown: ["Delete"], hidden: ["Run a copy now", "Turn On", "Turn Off", "Stop"] },
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
    assert.ok(
      [...dom.container.querySelectorAll(".fold-routing-step-heading strong")]
        .some((heading) => heading.textContent?.trim() === "Message work-fold agent"),
      "a management step reads as a message to the work-fold agent",
    );

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
  await dom.waitFor(() => /Run Requested/.test(dom.container.textContent ?? ""));
  assert.match(dom.container.textContent ?? "", /Run Requested/);
});

test("Automations has no New automation button; the empty state says where to ask (2026-09-25)", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls = installRoutingBridge("disabled");
  const drafts: string[] = [];
  Object.assign(window.workFoldDesktop!, {
    agent: { openFoldDraft: async (draft: string) => { drafts.push(draft); return true; } },
  });
  await dom.render(createElement(FoldRoutingsPane));
  await dom.settle();
  assert.equal([...dom.container.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "New automation"), false);
  const empty = dom.container.querySelector(".fold-routings-empty");
  if (empty) assert.match(empty.textContent ?? "", /ask the work-fold agent/);
  assert.equal(drafts.length, 0);
  assert.equal(calls.run, 0);
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
  assert.equal(enabledButtons.find((button) => button.textContent?.trim() === "Turn Off")?.disabled, false);
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
  assert.equal(disabledButtons.find((button) => button.textContent?.trim() === "Turn On")?.disabled, true);
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
    .find((button) => button.textContent?.trim() === "Turn Off");
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
      steps: [
        { id: "handoff", kind: "chat", space: { spaceId: "space-a", spaceName: "Client launch" }, message: "Prepare the handoff." },
        { id: "report", kind: "fold", message: "The handoff finished." },
      ],
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
        enable: async () => ({
          routingId: summary.routingId,
          requestId: "settings:request-1",
          enabled: true as const,
          alreadyEnabled: false,
        }),
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
        enable: async (routingId: string) => ({
          routingId,
          requestId: "settings:request-1",
          enabled: true as const,
          alreadyEnabled: false,
        }),
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


test("missing desktop bridge leaves Automations readable instead of crashing Settings", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[role="alert"]')));
  assert.match(dom.container.textContent ?? "", /available in the desktop app/);
  assert.ok(dom.container.querySelector(".fold-routings"), "Settings remains readable");
  assert.equal(dom.container.querySelector(".fold-routing-proposals"), null, "no bridge, no pending section");
});

test("pending proposal files list above the automations and Turn on moves one into the list", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  installRoutingBridge("enabled");
  const bridge = window.workFoldDesktop!.routings! as unknown as Record<string, unknown>;
  const readyPath = "/state/management/hourly.work-fold-routing.json";
  const enabledPaths: string[] = [];
  let turnedOn = false;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  Object.assign(window.workFoldDesktop!, { api: {} });
  globalThis.fetch = (async () => new Response(JSON.stringify({ automations: turnedOn ? [{ routingId: "routing-hourly" }] : [] }), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  function FolderRailState() {
    const { bySpace } = useFolderAutomations("space-a", false);
    return createElement("output", { "data-folder-count": true }, String(bySpace["space-a"]?.length ?? "loading"));
  }
  const original = bridge.list as () => Promise<FoldRoutingsResponse>;
  const added = {
    routingId: "routing-hourly",
    title: "Hourly hello",
    health: "enabled" as const,
    trigger: { kind: "interval" as const, intervalMinutes: 60 },
    stepCount: 1,
    spaces: [{ spaceId: "space-a", spaceName: "Client launch" }],
  };
  Object.assign(bridge, {
    list: async () => {
      const list = await original();
      return turnedOn ? { ...list, routings: [...list.routings, added] } : list;
    },
    proposals: async (): Promise<FoldRoutingProposalsResponse> => ({
      proposals: [
        { valid: false, path: "/state/management/broken.work-fold-routing.json", fileName: "broken.work-fold-routing.json", problem: "Not valid JSON." },
        ...(turnedOn ? [] : [{
          valid: true as const,
          path: readyPath,
          fileName: "hourly.work-fold-routing.json",
          routingId: "routing-hourly",
          digest: "a".repeat(64),
          title: "Hourly hello",
          trigger: { kind: "interval" as const, intervalMinutes: 60 },
        }]),
      ],
      truncated: false,
    }),
    enableProposal: async (path: string) => {
      enabledPaths.push(path);
      turnedOn = true;
      return { routingId: "routing-hourly", requestId: "settings:request-2", enabled: true as const, alreadyEnabled: false, routing: added };
    },
  });
  await dom.render(createElement(Fragment, null, createElement(FoldRoutingsPane), createElement(FolderRailState)));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-proposals")));
  await dom.waitFor(() => dom.container.querySelector("output")?.textContent === "0");

  const section = dom.container.querySelector<HTMLElement>(".fold-routing-proposals")!;
  assert.equal(section.querySelector("h5")?.textContent, "Ready to turn on");
  assert.ok(
    section.compareDocumentPosition(dom.container.querySelector(".fold-routings-workbench")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the pending section sits above the automations",
  );
  const rows = [...section.querySelectorAll<HTMLElement>(".fold-routing-proposal")];
  assert.equal(rows.length, 2);
  const invalid = rows.find((row) => row.classList.contains("invalid"))!;
  assert.match(invalid.textContent ?? "", /broken\.work-fold-routing\.json/);
  assert.equal(invalid.getAttribute("title"), "Not valid JSON.");
  assert.equal(invalid.querySelector("button"), null, "an invalid file has no button");
  const ready = rows.find((row) => !row.classList.contains("invalid"))!;
  assert.match(ready.textContent ?? "", /Hourly hello/);
  assert.match(ready.textContent ?? "", /Every 1 hour/);
  const turnOn = ready.querySelector<HTMLButtonElement>("button")!;
  assert.equal(turnOn.textContent, "Turn On");

  await dom.act(async () => {
    turnOn.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await dom.waitFor(() => enabledPaths.length === 1 && !dom.container.querySelector(".fold-routing-proposal:not(.invalid)"));
  await dom.waitFor(() => dom.container.querySelector("output")?.textContent === "1");
  assert.deepEqual(enabledPaths, [readyPath]);
  await dom.waitFor(() => [...dom.container.querySelectorAll(".fold-routing-list-row")]
    .some((row) => /Hourly hello/.test(row.textContent ?? "")));
  await dom.waitFor(() => dom.container.querySelector(".fold-routing-list-row.selected strong")?.textContent === "Hourly hello");
  assert.match(dom.container.textContent ?? "", /Automation turned on/);
});

test("invalid-only proposal files remain visible with their repair reason", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  installRoutingBridge("enabled");
  Object.assign(window.workFoldDesktop!.routings!, {
    proposals: async (): Promise<FoldRoutingProposalsResponse> => ({
      proposals: [{ valid: false, path: "/m/broken.work-fold-routing.json", fileName: "broken.work-fold-routing.json", problem: "Not valid JSON." }],
      truncated: false,
    }),
  });
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));
  await dom.settle();
  const section = dom.container.querySelector(".fold-routing-proposals")!;
  assert.equal(section.querySelector("h5")?.textContent, "Automation files");
  const invalid = section.querySelector(".fold-routing-proposal.invalid")!;
  assert.match(invalid.textContent ?? "", /broken\.work-fold-routing\.json/);
  assert.equal(invalid.getAttribute("title"), "Not valid JSON.");
  assert.equal(invalid.querySelector("button"), null);
});

test("the Folder filter narrows the one automation list client-side", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  installRoutingBridge("enabled");
  const summary = (routingId: string, title: string, spaces: Array<{ spaceId: string; spaceName: string }>) => ({
    routingId,
    title,
    health: "enabled" as const,
    trigger: { kind: "manual" as const },
    stepCount: 1,
    spaces,
  });
  const alpha = { spaceId: "space-alpha", spaceName: "Alpha" };
  const beta = { spaceId: "space-beta", spaceName: "Beta" };
  const listCalls = { count: 0 };
  Object.assign(window.workFoldDesktop!.routings!, {
    list: async (): Promise<FoldRoutingsResponse> => {
      listCalls.count += 1;
      return {
        routings: [
          summary("routing-one", "Alpha only", [alpha]),
          summary("routing-two", "Alpha to Beta", [alpha, beta]),
          summary("routing-three", "Beta only", [beta]),
        ],
        status: { storeDamaged: false, journalDamaged: false, activeRunCount: 0 },
      };
    },
  });
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-folder-filter")));
  const chips = () => [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-routing-folder-filter button")];
  const rows = () => [...dom.container.querySelectorAll(".fold-routing-list-row strong")].map((row) => row.textContent);
  assert.deepEqual(chips().map((chip) => chip.textContent), ["All", "Alpha", "Beta"]);
  assert.equal(chips()[0]?.getAttribute("aria-pressed"), "true");
  assert.deepEqual(rows(), ["Alpha only", "Alpha to Beta", "Beta only"]);

  const callsBefore = listCalls.count;
  await dom.act(async () => { chips()[2]!.click(); });
  assert.deepEqual(rows(), ["Alpha to Beta", "Beta only"]);
  assert.equal(chips()[2]?.getAttribute("aria-pressed"), "true");
  await dom.waitFor(() => dom.container.querySelector(".fold-routing-list-row.selected strong")?.textContent === "Alpha to Beta");
  assert.equal(listCalls.count, callsBefore, "filtering is client-side");

  await dom.act(async () => { chips()[0]!.click(); });
  assert.deepEqual(rows(), ["Alpha only", "Alpha to Beta", "Beta only"]);
});

test("a single automation or a single Folder shows no Folder filter", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  installRoutingBridge("enabled");
  await dom.render(createElement(FoldRoutingsPane));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".fold-routing-inspector-header")));
  assert.equal(dom.container.querySelector(".fold-routing-folder-filter"), null);
});
