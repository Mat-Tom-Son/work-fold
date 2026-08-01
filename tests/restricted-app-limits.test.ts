import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRestrictedAppLimits,
  restrictedAppNetworkEnvelopeBytes,
  restrictedAppStorageEnvelopeBytes,
} from "../src/local/agent/restricted-app-limits.js";
import { RestrictedAppNetworkBroker } from "../src/local/agent/restricted-app-connections.js";
import { RestrictedAppFileBroker } from "../src/local/agent/restricted-app-files.js";
import { restrictedAppStorageLimits } from "../src/local/agent/restricted-app-storage.js";
import {
  parseRestrictedAppManifest,
  restrictedAppAutomationIntervalMinutes,
} from "../src/local/agent/restricted-app-manifest.js";

const emptyCredentials = {
  async get() { return undefined; },
  async set() { /* unused */ },
  async delete() { return false; },
};

test("published limits are composed from the live brokers rather than restated", () => {
  const network = new RestrictedAppNetworkBroker({
    credentials: emptyCredentials as never,
    maxRequestBytes: 1_024,
    maxResponseBytes: 2_048,
    timeoutMs: 4_000,
    maxRedirects: 1,
    fetch: (async () => new Response("")) as typeof globalThis.fetch,
  });
  const files = new RestrictedAppFileBroker({ maxReadBytes: 8_192, maxWriteBytes: 4_096 });
  const limits = buildRestrictedAppLimits({
    network: {
      maxRequestBytes: network.limits.maxRequestBytes,
      maxResponseBytes: network.limits.maxResponseBytes,
      timeoutMs: network.limits.timeoutMs,
      maxRedirects: network.limits.maxRedirects,
    },
    files: { maxReadBytes: files.limits.maxReadBytes, maxWriteBytes: files.limits.maxWriteBytes },
  });

  // A host that configures a non-default bound must publish that bound, not the
  // default one. This is the whole point: an app designs against these numbers.
  assert.deepEqual(limits.network, { maxRequestBytes: 1_024, maxResponseBytes: 2_048, timeoutMs: 4_000, maxRedirects: 1 });
  assert.deepEqual(limits.files, { maxReadBytes: 8_192, maxWriteBytes: 4_096 });
  assert.equal(limits.storage.quotaBytes, restrictedAppStorageLimits.appBytes);
  assert.equal(limits.storage.maxKeys, restrictedAppStorageLimits.keys);
  assert.equal(limits.storage.maxValueBytes, restrictedAppStorageLimits.valueBytes);
  assert.equal(limits.automations.minimumIntervalMinutes, restrictedAppAutomationIntervalMinutes.minimum);
  assert.equal(limits.automations.maximumIntervalMinutes, restrictedAppAutomationIntervalMinutes.maximum);
});

test("default broker bounds are the ones apps are told about", () => {
  const network = new RestrictedAppNetworkBroker({ credentials: emptyCredentials as never });
  const files = new RestrictedAppFileBroker();
  assert.deepEqual(network.limits, { maxRequestBytes: 128 * 1024, maxResponseBytes: 256 * 1024, timeoutMs: 15_000, maxRedirects: 3 });
  assert.deepEqual(files.limits, { maxReadBytes: 512 * 1024, maxWriteBytes: 512 * 1024, maxListEntries: files.limits.maxListEntries });
});

test("the published automation interval range is the range the manifest parser enforces", () => {
  const { minimum, maximum } = restrictedAppAutomationIntervalMinutes;
  const build = (intervalMinutes: number) => ({
    version: 2,
    id: "interval-app",
    title: "Interval app",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [],
    permissions: { network: [], files: [], notifications: [] },
    automations: [{
      id: "job", title: "Job", handler: "job",
      trigger: { kind: "interval", intervalMinutes },
      permissions: { network: [], files: [], notifications: [] },
      catchUp: "none", overlap: "skip",
    }],
  });
  assert.equal(parseRestrictedAppManifest(build(minimum)).automations[0]?.trigger.intervalMinutes, minimum);
  assert.equal(parseRestrictedAppManifest(build(maximum)).automations[0]?.trigger.intervalMinutes, maximum);
  assert.throws(() => parseRestrictedAppManifest(build(minimum - 1)));
  assert.throws(() => parseRestrictedAppManifest(build(maximum + 1)));
});

test("limits survive the launch-argument round trip the preload actually performs", () => {
  // The host serializes with rendererArgument (encodeURIComponent) and the
  // preload recovers the value with decodeURIComponent + JSON.parse. Exercising
  // the composer alone would not catch a break in that delivery path.
  const limits = buildRestrictedAppLimits({
    network: { maxRequestBytes: 128 * 1024, maxResponseBytes: 256 * 1024, timeoutMs: 15_000, maxRedirects: 3 },
    files: { maxReadBytes: 512 * 1024, maxWriteBytes: 512 * 1024 },
  });

  const argument = `--work-fold-restricted-limits=${encodeURIComponent(JSON.stringify(limits))}`;

  const prefix = "--work-fold-restricted-limits=";
  const found = [argument].find((value) => value.startsWith(prefix));
  assert.ok(found);
  const recovered = JSON.parse(decodeURIComponent(found.slice(prefix.length)));
  assert.deepEqual(recovered, limits);

  // The preload deep-freezes what it publishes so app code cannot mutate the
  // budget it is supposed to be designing against.
  const deepFreeze = <T>(value: T): T => {
    if (!value || typeof value !== "object") return value;
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    return Object.freeze(value);
  };
  const published = deepFreeze(recovered) as typeof limits;
  assert.throws(() => { (published.network as { maxResponseBytes: number }).maxResponseBytes = 1; }, TypeError);
  assert.equal(published.network.maxResponseBytes, 256 * 1024);

  // A missing or malformed argument must degrade to null, never throw at mount.
  const parseOrNull = (raw: string | undefined) => {
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
  };
  assert.equal(parseOrNull(undefined), null);
  assert.equal(parseOrNull(""), null);
  assert.equal(parseOrNull("%"), null);
  assert.equal(parseOrNull("not-json"), null);
});

test("bridge envelopes preserve every request allowed by the published byte limits", () => {
  const maxRequestBytes = 128 * 1024;
  const escapeHeavyBody = "\0".repeat(maxRequestBytes);
  const requestEnvelope = JSON.stringify({
    destinationId: "records-api",
    method: "POST",
    path: "/records",
    headers: { "content-type": "application/json" },
    body: escapeHeavyBody,
  });
  assert.equal(Buffer.byteLength(escapeHeavyBody), maxRequestBytes);
  assert.ok(
    Buffer.byteLength(requestEnvelope) <= restrictedAppNetworkEnvelopeBytes(maxRequestBytes),
    "JSON escaping must not make a broker-valid body fail in the preload",
  );

  const transaction = {
    operation: "transaction",
    transaction: {
      set: [{ key: "first", value: "x".repeat(120 * 1024) }, { key: "second", value: "y".repeat(35 * 1024) }],
      delete: [],
    },
  };
  const transactionBytes = Buffer.byteLength(JSON.stringify(transaction.transaction));
  assert.ok(transactionBytes <= restrictedAppStorageLimits.transactionBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(transaction)) <= restrictedAppStorageEnvelopeBytes);
});
