import assert from "node:assert/strict";
import test from "node:test";

import { checksToolbarPresentation } from "../web-local/src/lib/checks-ui.js";
import type { ChecksStatus } from "../web-local/src/types.js";

const base: ChecksStatus = {
  kind: "workspace.checks.experimental",
  version: 0,
  spaceId: "space-1",
  state: "not-configured",
  configured: 0,
  proposed: 0,
  enabled: 0,
  current: 0,
  neverRun: 0,
  stale: 0,
  blocked: 0,
  errors: 0,
  needsAttention: 0,
  running: 0,
  lastRunAt: null,
};

test("Checks stay invisible in unconfigured Spaces", () => {
  assert.equal(checksToolbarPresentation(base), null);
});

test("Checks toolbar distinguishes never-run, stale, attention, and Check health", () => {
  assert.equal(checksToolbarPresentation({
    ...base,
    state: "stale",
    configured: 1,
    enabled: 1,
    neverRun: 1,
  })?.label, "Checks not run");

  assert.equal(checksToolbarPresentation({
    ...base,
    state: "stale",
    configured: 1,
    enabled: 1,
    stale: 1,
  })?.label, "Results not current");

  assert.deepEqual(checksToolbarPresentation({
    ...base,
    state: "needs-attention",
    configured: 1,
    enabled: 1,
    current: 1,
    needsAttention: 2,
  }), {
    icon: "attention",
    label: "Needs attention",
    title: "2 current findings in explicitly designated files",
    tone: "attention",
    count: 2,
  });

  const blocked = checksToolbarPresentation({
    ...base,
    state: "blocked",
    configured: 1,
    blocked: 1,
  });
  assert.equal(blocked?.label, "Check issue");
  assert.match(blocked?.title ?? "", /not a problem label on your files/);
});

test("proposals-only and temporarily unavailable Checks never look current or runnable", () => {
  const proposals = checksToolbarPresentation({
    ...base,
    configured: 1,
    proposed: 1,
  });
  assert.equal(proposals?.label, "Check proposals");
  assert.match(proposals?.title ?? "", /No Checks are enabled/);

  const unavailable = checksToolbarPresentation({
    ...base,
    state: "current-clear",
    configured: 1,
    enabled: 1,
    current: 1,
  }, true);
  assert.equal(unavailable?.label, "Check status unavailable");
  assert.match(unavailable?.title ?? "", /does not label your files as clear or failed/);
});

test("running work takes precedence over a previous finding count", () => {
  const presentation = checksToolbarPresentation({
    ...base,
    state: "needs-attention",
    configured: 1,
    enabled: 1,
    current: 1,
    needsAttention: 1,
    running: 1,
  });
  assert.equal(presentation?.icon, "running");
  assert.equal(presentation?.count, null);
});

test("mixed never-run and stale Checks report both kinds of uncertainty", () => {
  const presentation = checksToolbarPresentation({
    ...base,
    state: "stale",
    configured: 2,
    enabled: 2,
    neverRun: 1,
    stale: 1,
  });
  assert.equal(presentation?.label, "Results not current");
  assert.match(presentation?.title ?? "", /1 Check not run; 1 result changed/);
});
