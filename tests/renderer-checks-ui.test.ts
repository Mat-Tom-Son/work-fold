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
