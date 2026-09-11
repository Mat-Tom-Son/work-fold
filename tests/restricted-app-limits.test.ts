import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRestrictedAppLimits,
  restrictedAppAssistantEnvelopeBytes,
  restrictedAppInferenceEnvelopeBytes,
  restrictedAppNetworkEnvelopeBytes,
  restrictedAppStorageEnvelopeBytes,
} from "../src/local/agent/restricted-app-limits.js";
import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";
import { restrictedAppAssistantLimits, restrictedAppSubscriptionLimits } from "../src/shared/restricted-app-tasks.js";
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
  // The AI lanes publish their bounds the same way, so an app can design to
  // them instead of discovering them by being refused.
  assert.deepEqual(limits.inference, {
    instructionsBytes: restrictedAppInferenceLimits.instructionsBytes,
    inputBytes: restrictedAppInferenceLimits.inputBytes,
    schemaBytes: restrictedAppInferenceLimits.schemaBytes,
    defaultOutputBytes: restrictedAppInferenceLimits.defaultOutputBytes,
    maxOutputBytes: restrictedAppInferenceLimits.maxOutputBytes,
    runningPerInstallation: restrictedAppInferenceLimits.runningPerInstallation,
    timeoutMs: restrictedAppInferenceLimits.timeoutMs,
  });
  assert.deepEqual(limits.assistant, {
    instructionsBytes: restrictedAppAssistantLimits.instructions,
    inputBytes: restrictedAppAssistantLimits.inputBytes,
    resultBytes: restrictedAppAssistantLimits.resultBytes,
    summaryBytes: restrictedAppAssistantLimits.summaryBytes,
    dataBytes: restrictedAppAssistantLimits.dataBytes,
    resultFiles: restrictedAppAssistantLimits.resultFiles,
    runningPerInstallation: restrictedAppAssistantLimits.runningPerInstallation,
  });
  // The hint cadence is published for the same reason: a view designs its
  // refresh around the hints it will get instead of counting them.
  assert.deepEqual(limits.subscriptions, {
    minHintIntervalMs: restrictedAppSubscriptionLimits.minHintIntervalMs,
    filePollIntervalMs: restrictedAppSubscriptionLimits.filePollIntervalMs,
    fileDebounceMs: restrictedAppSubscriptionLimits.fileDebounceMs,
    fileMinHintIntervalMs: restrictedAppSubscriptionLimits.fileMinHintIntervalMs,
    fileMaxFiles: restrictedAppSubscriptionLimits.fileMaxFiles,
  });
  // F29's envelope numbers are the report verb's numbers, not a second set.
  assert.equal(limits.assistant.summaryBytes, 32 * 1024);
  assert.equal(limits.assistant.dataBytes, 256 * 1024);
  assert.equal(limits.inference.inputBytes, 256 * 1024);
  assert.equal(limits.assistant.inputBytes, 64 * 1024);
  assert.equal(limits.inference.runningPerInstallation, 4);
  assert.equal(limits.assistant.runningPerInstallation, 4);
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

  // The published inference input bound must stay reachable for text that
  // escapes into six bytes per character, instructions and schema included.
  const inferenceEnvelope = JSON.stringify({
    request: {
      instructions: "x".repeat(restrictedAppInferenceLimits.instructionsBytes),
      input: "\0".repeat(restrictedAppInferenceLimits.inputBytes),
      maxOutputBytes: restrictedAppInferenceLimits.maxOutputBytes,
    },
  });
  assert.ok(
    Buffer.byteLength(inferenceEnvelope) <= restrictedAppInferenceEnvelopeBytes,
    "JSON escaping must not make an allowed inference input fail in the preload",
  );
  const assistantEnvelope = JSON.stringify({
    operation: "request",
    request: { requestId: "r", requestedAt: "2026-09-10T12:00:00.000Z", actionId: "compare", input: "\0".repeat(restrictedAppAssistantLimits.inputBytes - 2) },
  });
  assert.ok(
    Buffer.byteLength(assistantEnvelope) <= restrictedAppAssistantEnvelopeBytes,
    "JSON escaping must not make an allowed Assistant request input fail in the preload",
  );
});
