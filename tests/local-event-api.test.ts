import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalApi } from "../src/local/server.js";

test("multiplex transport retains renderer session/origin authorization and rejects arbitrary routes before streaming", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-multiplex-auth-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false,
    appMode: "desktop", sessionToken: "synthetic-renderer-session", piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  const body = JSON.stringify({ subscriptions: [{ id: "control", path: "/api/management/control-events" }] });
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${api.origin}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
    const headers = { "content-type": "application/json", "x-work-fold-session": "synthetic-renderer-session" };
    assert.equal((await fetch(`${api.origin}/api/events`, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body })).status, 403);
    for (const path of ["/api/requests/private/answer", "https://example.invalid/", "/api/management/control-events?token=anything"]) {
      const response = await fetch(`${api.origin}/api/events`, { method: "POST", headers, body: JSON.stringify({ subscriptions: [{ id: "arbitrary", path }] }) });
      assert.equal(response.status, 400);
      assert.doesNotMatch(response.headers.get("content-type") ?? "", /event-stream/);
    }
    const oversized = await fetch(`${api.origin}/api/events`, { method: "POST", headers, body: JSON.stringify({ subscriptions: [], padding: "x".repeat(70_000) }) });
    assert.equal(oversized.status, 413);
    const response = await fetch(`${api.origin}/api/events`, { method: "POST", headers, body, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"subscriptionId":"control"/);
    assert.match(first, /"type":"reset"/);
    controller.abort(); await reader.cancel().catch(() => undefined); reader.releaseLock();
  } finally { controller.abort(); await api.close(); await rm(root, { recursive: true, force: true }); }
});
