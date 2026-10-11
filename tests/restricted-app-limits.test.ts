import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRestrictedAppLimits,
  restrictedAppAssistantEnvelopeBytes,
  restrictedAppFileEnvelopeBytes,
  restrictedAppInferenceEnvelopeBytes,
  restrictedAppNetworkEnvelopeBytes,
  restrictedAppStorageEnvelopeBytes,
} from "../src/local/agent/restricted-app-limits.js";
import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";
import { restrictedAppAssistantLimits, restrictedAppSubscriptionLimits } from "../src/shared/restricted-app-tasks.js";
import { workFoldRequestLimits } from "../src/shared/work-fold-limits.js";
import { RestrictedAppNetworkBroker, restrictedAppNetworkDefaultLimits } from "../src/local/agent/restricted-app-connections.js";
import { RestrictedAppFileBroker, restrictedAppFileDefaultLimits } from "../src/local/agent/restricted-app-files.js";
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
    timeoutMs: null,
  });
  assert.deepEqual(limits.assistant, {
    instructionsBytes: null,
    inputBytes: restrictedAppAssistantLimits.inputBytes,
    resultBytes: restrictedAppAssistantLimits.resultBytes,
    summaryBytes: restrictedAppAssistantLimits.summaryBytes,
    dataBytes: restrictedAppAssistantLimits.dataBytes,
    resultFiles: null,
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
  assert.equal(limits.assistant.summaryBytes, workFoldRequestLimits.maxResultSummaryBytes);
  assert.equal(limits.assistant.dataBytes, workFoldRequestLimits.maxResultDataBytes);
});

test("the AI lanes' bounds keep memory finite rather than ration the app", () => {
  // These are the owner's chosen generous values: the context window and the
  // model's own output limit are the real bounds on a model call, and a
  // request quota no longer exists at all.
  assert.equal(restrictedAppInferenceLimits.instructionsBytes, 1024 * 1024);
  assert.equal(restrictedAppInferenceLimits.inputBytes, 16 * 1024 * 1024);
  assert.equal(restrictedAppInferenceLimits.schemaBytes, 1024 * 1024);
  assert.equal(restrictedAppInferenceLimits.defaultOutputBytes, restrictedAppInferenceLimits.maxOutputBytes);
  assert.equal(restrictedAppInferenceLimits.maxOutputBytes, 16 * 1024 * 1024);
  assert.deepEqual(
    [restrictedAppInferenceLimits.runningPerInstallation, restrictedAppInferenceLimits.waitingPerInstallation, restrictedAppInferenceLimits.runningMachineWide],
    [16, 256, 32],
  );
  assert.equal(restrictedAppAssistantLimits.inputBytes, 4 * 1024 * 1024);
  assert.equal(restrictedAppAssistantLimits.resultBytes, 32 * 1024 * 1024);
  assert.equal(restrictedAppAssistantLimits.runningPerInstallation, 32);
  assert.equal(Object.hasOwn(restrictedAppAssistantLimits, "records"), false, "there is no rolling request quota");
});

test("default broker bounds are the ones apps are told about", () => {
  const network = new RestrictedAppNetworkBroker({ credentials: emptyCredentials as never });
  const files = new RestrictedAppFileBroker();
  assert.deepEqual(network.limits, { ...restrictedAppNetworkDefaultLimits });
  assert.deepEqual(network.limits, { maxRequestBytes: 16 * 1024 * 1024, maxResponseBytes: 64 * 1024 * 1024, timeoutMs: 120_000, maxRedirects: 3 });
  assert.deepEqual(files.limits, { ...restrictedAppFileDefaultLimits });
  assert.deepEqual(files.limits, { maxReadBytes: 64 * 1024 * 1024, maxWriteBytes: 64 * 1024 * 1024, maxListEntries: 10_000 });
});

test("the published automation interval range is the range the manifest parser enforces", () => {
  const { minimum, maximum } = restrictedAppAutomationIntervalMinutes;
  assert.deepEqual({ minimum, maximum }, { minimum: 1, maximum: 366 * 24 * 60 }, "one minute to a leap year");
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

  // A file write's published bound stays reachable for text that escapes badly.
  const maxWriteBytes = restrictedAppFileDefaultLimits.maxWriteBytes;
  const fileEnvelope = JSON.stringify({
    operation: "write",
    request: { grantId: "exports", path: "report.txt", encoding: "utf8", data: "\0".repeat(maxWriteBytes), mode: "replace" },
  });
  assert.ok(Buffer.byteLength(fileEnvelope) <= restrictedAppFileEnvelopeBytes(maxWriteBytes));

  // The published inference bounds must stay reachable together for text that
  // escapes into six bytes per character: instructions, input, and schema.
  const inferenceEnvelope = JSON.stringify({
    request: {
      instructions: "\u0001".repeat(restrictedAppInferenceLimits.instructionsBytes),
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
    "JSON escaping must not make an allowed Worker request input fail in the preload",
  );
});
