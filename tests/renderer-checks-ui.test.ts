import assert from "node:assert/strict";
import test from "node:test";
import { createElement, StrictMode } from "react";

import type { WorkspaceCheckRendererOverview } from "../src/local/checks/check-types.js";
import type { WorkspaceSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const overview: WorkspaceCheckRendererOverview = {
  kind: "workspace.checks.renderer",
  version: 0,
  workspaceId: "space-checks-ui",
  status: {
    kind: "workspace.checks.experimental",
    version: 0,
    workspaceId: "space-checks-ui",
    state: "current-clear",
    configured: 1,
    proposed: 0,
    enabled: 1,
    current: 1,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: "2026-08-01T12:00:00.000Z",
  },
  checks: [{
    id: "check-one",
    title: "Weekend plan stays available",
    severity: "warning",
    trigger: "manual",
    sensor: { id: "workspace.file-presence", revision: 1 },
    targets: [{ kind: "file", role: "primary", path: "Notes/Weekend plan.md" }],
    authority: "enabled",
  }],
  findings: [],
  invalidated: 0,
  healthErrors: [],
  truncated: false,
};

test("opening the Checks tab re-verifies status once and never starts a run", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ overview }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { ChecksPane } = await import("../web-local/src/components/panes/ChecksPane.js");
  const workspace = { id: "space-checks-ui", name: "Weekend Launch", rootPath: "/tmp/weekend-launch" } as WorkspaceSummary;
  await dom.render(createElement(StrictMode, null, createElement(ChecksPane, {
    workspace,
    active: true,
    onOpenFile: () => undefined,
    onChecksChanged: () => undefined,
  })));
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("Weekend plan stays available"));

  assert.equal(calls.filter((call) => call.url.endsWith("/checks/overview")).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/checks/run")), false);
  assert.match(dom.container.textContent ?? "", /Only these bounded targets may be inspected when you run Checks/);
});

test("proposals-only Checks stay unknown instead of rendering a clear result", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const proposalsOnly: WorkspaceCheckRendererOverview = {
    ...overview,
    status: {
      ...overview.status,
      state: "not-configured",
      proposed: 1,
      enabled: 0,
      current: 0,
      lastRunAt: null,
    },
    checks: overview.checks.map((check) => ({ ...check, authority: "proposed" as const })),
  };
  let responseOverview: WorkspaceCheckRendererOverview = proposalsOnly;
  globalThis.fetch = async () => new Response(JSON.stringify({ overview: responseOverview }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const { ChecksPane } = await import("../web-local/src/components/panes/ChecksPane.js");
  const workspace = { id: "space-checks-ui", name: "Weekend Launch", rootPath: "/tmp/weekend-launch" } as WorkspaceSummary;
  await dom.render(createElement(ChecksPane, {
    workspace,
    active: true,
    onOpenFile: () => undefined,
    onChecksChanged: () => undefined,
  }));
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("No Check has been enabled or run"));

  assert.match(dom.container.textContent ?? "", /1 proposed Check is not enabled\. There is no result yet\./);
  assert.doesNotMatch(dom.container.textContent ?? "", /Nothing currently needs attention from the latest requested run/);

  responseOverview = {
    ...proposalsOnly,
    workspaceId: "space-checks-blocked",
    status: {
      ...proposalsOnly.status,
      workspaceId: "space-checks-blocked",
      state: "blocked",
      proposed: 0,
      blocked: 1,
    },
    checks: proposalsOnly.checks.map((check) => ({ ...check, authority: "blocked" as const })),
  };
  await dom.render(createElement(ChecksPane, {
    workspace: { ...workspace, id: "space-checks-blocked" },
    active: true,
    onOpenFile: () => undefined,
    onChecksChanged: () => undefined,
  }));
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("1 Check needs review before running"));
  assert.match(dom.container.textContent ?? "", /No file finding is shown because the Check itself needs attention/);
  assert.doesNotMatch(dom.container.textContent ?? "", /proposed Check is not enabled/);
});

test("finding decisions expose a distinct accessible name per finding", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const findingTitle = "Signed delivery is missing";
  const needsAttention: WorkspaceCheckRendererOverview = {
    ...overview,
    status: { ...overview.status, state: "needs-attention", current: 0, needsAttention: 1 },
    findings: [{
      id: "finding-one",
      fingerprint: "fingerprint-one",
      checkId: "check-one",
      declarationDigest: "declaration-digest",
      sensorId: "workspace.file-presence",
      sensorRevision: 1,
      sensorDigest: "sensor-digest",
      severity: "warning",
      title: findingTitle,
      targetPath: "Notes/Weekend plan.md",
      observedAt: "2026-08-01T12:00:00.000Z",
      status: "active",
      evidence: [{
        kind: "path-state",
        path: "Notes/Weekend plan.md",
        expected: "file",
        observed: "missing",
        identity: {
          checkId: "check-one",
          path: "Notes/Weekend plan.md",
          state: "missing",
        },
      }],
    }],
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ overview: needsAttention }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const { ChecksPane } = await import("../web-local/src/components/panes/ChecksPane.js");
  const workspace = { id: "space-checks-ui", name: "Weekend Launch", rootPath: "/tmp/weekend-launch" } as WorkspaceSummary;
  await dom.render(createElement(ChecksPane, {
    workspace,
    active: true,
    onOpenFile: () => undefined,
    onChecksChanged: () => undefined,
  }));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[role="group"]')));

  const group = dom.container.querySelector(`[role="group"][aria-label="Decisions for ${findingTitle}"]`);
  assert.ok(group);
  assert.ok(group.querySelector(`[aria-label="Mark ${findingTitle} resolved"]`));
  assert.ok(group.querySelector(`[aria-label="Defer ${findingTitle} until tomorrow"]`));
  assert.ok(group.querySelector(`[aria-label="Mark ${findingTitle} as not an issue"]`));
});

test("a transient status failure preserves known configuration but marks it unavailable", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests > 1) throw new Error("temporary status failure");
    return new Response(JSON.stringify({ status: { ...overview.status, running: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { useWorkspaceChecks } = await import("../web-local/src/hooks/useWorkspaceChecks.js");
  const workspace = { id: "space-checks-ui", name: "Weekend Launch", rootPath: "/tmp/weekend-launch" } as WorkspaceSummary;
  function Harness() {
    const checks = useWorkspaceChecks(workspace, false, true);
    return createElement("button", {
      type: "button",
      "data-configured": String(checks.status?.configured ?? 0),
      "data-unavailable": String(checks.unavailable),
      onClick: () => void checks.refresh(),
    }, "Refresh");
  }
  await dom.render(createElement(Harness));
  await dom.waitFor(() => dom.container.querySelector("button")?.getAttribute("data-configured") === "1");
  await dom.act(() => {
    dom.container.querySelector("button")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await dom.waitFor(() => dom.container.querySelector("button")?.getAttribute("data-unavailable") === "true");

  assert.equal(dom.container.querySelector("button")?.getAttribute("data-configured"), "1");
  await dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  assert.equal(requests, 2, "polling pauses while the last known running status is unavailable");
});
