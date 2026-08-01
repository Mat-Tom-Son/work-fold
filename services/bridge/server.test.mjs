import assert from "node:assert/strict";
import test from "node:test";

import { startBridgeServer } from "./server.mjs";

test("serves a healthy placeholder without caching", async (context) => {
  const service = await startBridgeServer({ host: "127.0.0.1", port: 0 });
  context.after(() => service.close());

  const response = await fetch(`http://127.0.0.1:${service.port}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "work-fold-bridge",
    status: "ready",
  });
});

test("rejects unsupported methods", async (context) => {
  const service = await startBridgeServer({ host: "127.0.0.1", port: 0 });
  context.after(() => service.close());

  const response = await fetch(`http://127.0.0.1:${service.port}/`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
