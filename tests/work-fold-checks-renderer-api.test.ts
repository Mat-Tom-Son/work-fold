import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi } from "../src/local/server.js";
import { WorkFoldCheckService, type WorkFoldCheckTaskStatus } from "../src/local/checks/check-service.js";
import type {
  WorkFoldCheckRendererDecorations,
  WorkFoldCheckRendererOverview,
  WorkFoldCheckStatusSnapshot,
} from "../src/local/checks/check-types.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";

const proposal = {
  kind: "work-fold.check-proposal",
  version: 1,
  name: "Required signed delivery",
  createdBy: "human",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed delivery exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
  },
} as const;

test("renderer Checks API stays explicit, Space-scoped, and task-backed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-checks-renderer-api-"));
  const kernel = new WorkFoldKernel();
  const checkService = new WorkFoldCheckService({ kernel });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    kernel,
    checkService,
  });
  try {
    const created = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", {
      method: "POST",
      body: { name: "Checks UI Space" },
    }, 201);
    const spaceId = created.space.id;
    const proposalPath = join(sandbox, "signed-delivery.work-fold-check.json");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    await api.actFacade.checksEnable({ space: spaceId, proposalPath, cwd: sandbox });

    const releaseRegistryMutation = checkService.tryReserveSpaceRegistryMutation();
    assert.ok(releaseRegistryMutation);
    const conflictedStatus = await fetch(`${api.origin}/api/spaces/${spaceId}/checks/status`);
    assert.equal(conflictedStatus.status, 409, await conflictedStatus.text());
    releaseRegistryMutation();

    const awaitingRun = await request<{ status: WorkFoldCheckStatusSnapshot }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/status`,
    );
    assert.equal(awaitingRun.status.state, "stale");
    assert.equal(awaitingRun.status.neverRun, 1);
    assert.equal(awaitingRun.status.stale, 0);

    const beforeRun = await request<{ decorations: WorkFoldCheckRendererDecorations }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/decorations`,
    );
    assert.deepEqual(beforeRun.decorations.items, []);

    const invalidRun = await fetch(`${api.origin}/api/spaces/${spaceId}/checks/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkId: 42 }),
    });
    assert.equal(invalidRun.status, 400);

    const accepted = await request<{ task: { taskId: string } }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/run`,
      { method: "POST", body: {} },
      202,
    );
    const terminal = await waitForTerminal(api.origin, spaceId, accepted.task.taskId);
    assert.equal(terminal.state, "succeeded");
    const settledAbort = await request<{ aborted: boolean }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/tasks/${accepted.task.taskId}/abort`,
      { method: "POST", body: {} },
    );
    assert.equal(settledAbort.aborted, false);

    const decorations = await request<{ decorations: WorkFoldCheckRendererDecorations }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/decorations`,
    );
    assert.deepEqual(decorations.decorations.items, [{ path: "Delivery/signed.pdf", count: 1 }]);

    const overview = await request<{ overview: WorkFoldCheckRendererOverview }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/overview`,
      { method: "POST", body: {} },
    );
    assert.equal(overview.overview.status.state, "needs-attention");
    assert.equal(overview.overview.checks[0]?.authority, "enabled");
    assert.equal(overview.overview.findings[0]?.targetPath, "Delivery/signed.pdf");

    const findingId = overview.overview.findings[0]!.id;
    await request(api.origin, `/api/spaces/${spaceId}/checks/findings/${findingId}/decision`, {
      method: "POST",
      body: { decision: "resolve" },
    });
    const resolved = await request<{ overview: WorkFoldCheckRendererOverview }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/overview`,
      { method: "POST", body: {} },
    );
    assert.equal(resolved.overview.findings.length, 0);
    assert.equal(resolved.overview.status.needsAttention, 0);

    await mkdir(join(created.space.spaceRoot, "Delivery"), { recursive: true });
    await writeFile(join(created.space.spaceRoot, "Delivery", "signed.pdf"), "%PDF current");
    const clearRun = await request<{ task: { taskId: string } }>(
      api.origin,
      `/api/spaces/${spaceId}/checks/run`,
      { method: "POST", body: {} },
      202,
    );
    assert.equal((await waitForTerminal(api.origin, spaceId, clearRun.task.taskId)).state, "succeeded");
    const staleDecision = await fetch(`${api.origin}/api/spaces/${spaceId}/checks/findings/${findingId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    assert.equal(staleDecision.status, 409, await staleDecision.text());

    const invalidDecision = await fetch(`${api.origin}/api/spaces/${spaceId}/checks/findings/${findingId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "silence-forever" }),
    });
    assert.equal(invalidDecision.status, 400);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForTerminal(origin: string, spaceId: string, taskId: string): Promise<WorkFoldCheckTaskStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await request<{ task: WorkFoldCheckTaskStatus }>(
      origin,
      `/api/spaces/${spaceId}/checks/tasks/${taskId}`,
    );
    if (response.task.state !== "accepted" && response.task.state !== "running") return response.task;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the renderer Check task.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function request<T = unknown>(
  origin: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

test("desktop text Check setup is inert, re-enable pins review, and provider removal cannot interrupt a run", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-text-check-api-"));
  const kernel = new WorkFoldKernel();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const service = new WorkFoldCheckService({ kernel, reviewModel: async () => { requests++; await hold; return { submission: { findings: [] } }; } });
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), spaceBase: join(sandbox, "content"), loadEnv: false, kernel, checkService: service });
  try {
    const { space } = await request<{ space: { id: string; spaceRoot: string } }>(api.origin, "/api/spaces", { method: "POST", body: { name: "Text review" } }, 201);
    await writeFile(join(space.spaceRoot, "draft.md"), "An ordinary paragraph.");
    const configured = await request<{ declaration: { id: string }; digest: string }>(api.origin, `/api/spaces/${space.id}/checks/configure`, { method: "POST", body: { proposal: { ...proposal, check: { ...proposal.check, sensor: { id: "work-fold.text-review", revision: 1, parameters: { criteria: "Flag unclear prose." } }, targets: [{ kind: "file", role: "primary", path: "draft.md" }] } } } });
    assert.equal(requests, 0);
    await request(api.origin, `/api/spaces/${space.id}/checks/${configured.declaration.id}/disable`, { method: "POST", body: {} });
    const stale = await fetch(`${api.origin}/api/spaces/${space.id}/checks/${configured.declaration.id}/enable`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedDigest: "0".repeat(64) }) });
    assert.equal(stale.status, 409);
    const enabled = await request<{ declaration: { id: string } }>(api.origin, `/api/spaces/${space.id}/checks/${configured.declaration.id}/enable`, { method: "POST", body: { expectedDigest: configured.digest } });
    assert.equal(enabled.declaration.id, configured.declaration.id);
    const accepted = await request<{ task: { taskId: string } }>(api.origin, `/api/spaces/${space.id}/checks/run`, { method: "POST", body: {} }, 202);
    const removal = await fetch(`${api.origin}/api/agent/auth`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ spaceId: space.id, provider: "test" }) });
    assert.equal(removal.status, 409, await removal.text());
    release();
    assert.equal((await waitForTerminal(api.origin, space.id, accepted.task.taskId)).state, "succeeded");
    assert.equal(requests, 1);
  } finally { release(); await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});
