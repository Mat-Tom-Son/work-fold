import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import { SpaceAutomationsPane, folderAutomationRoleSentence } from "../web-local/src/components/panes/SpaceAutomationsPane.js";
import { buildFixtureFolderAutomations } from "../web-local/src/fixtures/space-fixture.js";
import type { FolderAutomationView } from "../src/shared/routing-presentation.js";
import { createDomHarness } from "./support/dom.js";

const home = {
  id: "fixture-home",
  name: "Home projects",
  spaceRoot: "/tmp/Home projects",
  location: { kind: "local" as const, storage: "linked" as const },
  createdAt: "2026-07-10T18:30:00.000Z",
  updatedAt: "2026-07-10T18:30:00.000Z",
};

function rowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".folder-automation-row")].map((row) => row.textContent ?? "");
}

function buttonsIn(row: Element): string[] {
  return [...row.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
}

test("role sentences use the Folder's own terms", () => {
  assert.equal(folderAutomationRoleSentence(["watches", "copies-from"]), "Watches this folder · Copies files from here");
  assert.equal(folderAutomationRoleSentence(["copies-to", "chats-here", "checks-here"]), "Copies files here · Starts a Chat here · Runs a Check here");
});

test("the preview renders Home projects' two automations from fixture data with no network", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; throw new Error("no network in the preview"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let opened = 0;
  const fixture = buildFixtureFolderAutomations();
  assert.equal(fixture["fixture-trip"]?.length, 1, "Japan trip has one");
  assert.deepEqual(fixture["fixture-trip"]?.[0]?.roles, ["copies-to"]);

  await dom.render(createElement(SpaceAutomationsPane, {
    space: home,
    automations: fixture["fixture-home"],
    active: true,
    fixtureMode: true,
    onRefresh: async () => {},
    onOpenAllAutomations: () => { opened += 1; },
  }));

  assert.equal(dom.container.querySelector("h1")?.textContent, "Automations in Home projects");
  const rows = [...dom.container.querySelectorAll(".folder-automation-row")];
  assert.equal(rows.length, 2);
  const [on, off] = rowTexts(dom.container);
  assert.match(on!, /On/);
  assert.match(on!, /When Kitchen refresh changes/);
  assert.match(on!, /Watches this folder · Copies files from here/);
  assert.match(on!, /Last run /);
  assert.deepEqual(buttonsIn(rows[0]!), ["Run now", "Turn off"]);
  assert.match(off!, /Off/);
  assert.match(off!, /Every 30 minutes/);
  assert.match(off!, /Starts a Chat here/);
  assert.match(off!, /Not run yet/);
  assert.deepEqual(buttonsIn(rows[1]!), ["Turn on"]);

  await dom.act(async () => { (rows[0]!.querySelector("button") as HTMLButtonElement).click(); });
  assert.equal(fetches, 0, "preview actions never reach the network");

  const all = [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "All automations");
  assert.ok(all);
  await dom.act(async () => { all.click(); });
  assert.equal(opened, 1);
  assert.doesNotMatch(dom.container.textContent ?? "", /Delete|Edit|…/);
});

test("Turn off posts the Folder-scoped act and refreshes; an emptied list says so once", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ disabled: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let refreshes = 0;
  const running: FolderAutomationView = {
    routingId: "routing-kitchen-to-trip",
    title: "Kitchen to trip",
    state: "running",
    triggerSummary: "Manual only",
    nextRunAt: null,
    lastRun: { at: "2026-09-24T12:00:00.000Z", outcome: "failed" },
    roles: ["copies-from"],
  };
  const props = {
    space: home,
    active: false,
    onRefresh: async () => { refreshes += 1; },
    onOpenAllAutomations: () => {},
  };
  await dom.render(createElement(SpaceAutomationsPane, { ...props, automations: [running] }));
  const row = dom.container.querySelector(".folder-automation-row")!;
  assert.deepEqual(buttonsIn(row), ["Turn off"], "Run now shows only while On");
  assert.match(row.textContent ?? "", /Running/);
  assert.match(row.textContent ?? "", /· Failed/);
  await dom.act(async () => { (row.querySelector("button") as HTMLButtonElement).click(); });
  await dom.waitFor(() => refreshes > 0);
  assert.deepEqual(calls, [{ url: "/api/spaces/fixture-home/automations/routing-kitchen-to-trip/disable", method: "POST" }]);

  await dom.render(createElement(SpaceAutomationsPane, { ...props, automations: [] }));
  assert.equal(dom.container.querySelector(".folder-automations-empty")?.textContent, "No automations touch this folder.");
  assert.equal(dom.container.querySelectorAll(".folder-automations-empty").length, 1);
});
