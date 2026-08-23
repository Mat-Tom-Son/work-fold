import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import * as undici from "undici-pi-reviewed";

import {
  DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS,
  applyPiHttpProxySettings,
  configurePiHttpDispatcher,
  currentPiHttpDispatcher,
  isPiHttpDispatcherInstalled,
  normalizePiHttpIdleTimeoutMs,
} from "../src/local/agent/pi-http.js";

test("Pi's proxy setting only fills proxy variables the environment left unset", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyPiHttpProxySettings(undefined, env), null);
  assert.equal(applyPiHttpProxySettings("   ", env), null);
  assert.equal(applyPiHttpProxySettings("http://proxy.local:3128", env), "http://proxy.local:3128");
  assert.equal(env.HTTP_PROXY, "http://proxy.local:3128");
  assert.equal(env.HTTPS_PROXY, "http://proxy.local:3128");
  const explicit: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://corp:8080" };
  assert.equal(applyPiHttpProxySettings("http://proxy.local:3128", explicit), "http://corp:8080");
  assert.equal(explicit.HTTPS_PROXY, "http://corp:8080", "an explicit environment proxy is never overridden");
  assert.equal(explicit.HTTP_PROXY, "http://proxy.local:3128");
});

test("idle timeout normalization matches Pi's defaults", () => {
  assert.equal(normalizePiHttpIdleTimeoutMs(undefined), DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS);
  assert.equal(normalizePiHttpIdleTimeoutMs(Number.NaN), DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS);
  assert.equal(normalizePiHttpIdleTimeoutMs(-5), DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS);
  assert.equal(normalizePiHttpIdleTimeoutMs(0), 0);
  assert.equal(normalizePiHttpIdleTimeoutMs(1234.9), 1234);
});

test("the guarded proxy-aware dispatcher is installed once per timeout and serves global fetch", async () => {
  assert.equal(isPiHttpDispatcherInstalled(), false);
  const first = configurePiHttpDispatcher(60_000);
  assert.deepEqual(first, { idleTimeoutMs: 60_000, reconfigured: true });
  assert.equal(isPiHttpDispatcherInstalled(), true);
  const dispatcher = currentPiHttpDispatcher();
  assert.ok(dispatcher instanceof undici.EnvHttpProxyAgent);
  assert.equal((dispatcher as unknown as { listenerCount(event: string): number }).listenerCount("error"), 1, "Pi's error guard is attached");
  assert.deepEqual(configurePiHttpDispatcher(60_000), { idleTimeoutMs: 60_000, reconfigured: false });
  assert.deepEqual(configurePiHttpDispatcher(0), { idleTimeoutMs: 0, reconfigured: true });
  assert.notEqual(currentPiHttpDispatcher(), dispatcher, "a changed timeout installs a fresh dispatcher");
  assert.equal(globalThis.fetch, undici.fetch, "global fetch and the dispatcher share one undici implementation");

  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, agent: request.headers["user-agent"] ?? null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/provider`);
    assert.equal(response.status, 200);
    const body = await response.json() as { path: string };
    assert.equal(body.path, "/provider");
  } finally {
    server.close();
    await once(server, "close");
  }
});
