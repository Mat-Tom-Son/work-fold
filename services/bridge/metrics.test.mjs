import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeMetrics } from "./metrics.mjs";

test("bridge metrics report aggregate counters, rates, gauges, and warnings", () => {
  const baseTime = Date.parse("2026-08-05T12:00:00.000Z");
  let currentTime = baseTime;
  let intervalCallback = null;
  let clearedTimer = null;
  let unrefCalls = 0;
  const timer = { unref() { unrefCalls += 1; } };
  const reports = [];
  const gauges = {
    publicEnrollment: true,
    devicesCurrent: 2,
    sseClientsCurrent: 3,
    viewerActiveFetches: 2,
    viewerInFlightCiphertextChars: 4_096,
    passwordChecks: { active: 2, queued: 3, maximumActive: 3, maximumQueued: 4 },
  };
  const metrics = createBridgeMetrics({
    reportIntervalMs: 1_000,
    sink: (record) => reports.push(record),
    gauges: () => gauges,
    now: () => currentTime,
    setIntervalFn(callback, delay) {
      assert.equal(delay, 1_000);
      intervalCallback = callback;
      return timer;
    },
    clearIntervalFn(value) { clearedTimer = value; },
    frameRateWarningPerSecond: 2,
    eventLoopLagWarningMs: 50,
    passwordQueueWarningRatio: 0.75,
  });

  assert.equal(metrics.start(), true);
  assert.equal(unrefCalls, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(
    { type: reports[0].type, reason: reports[0].reason, severity: reports[0].severity, publicEnrollment: reports[0].publicEnrollment },
    { type: "work-fold.bridge.metrics.v1", reason: "startup", severity: "warning", publicEnrollment: true },
    "startup evidence includes the enrollment switch and current queue saturation",
  );

  metrics.recordHttpRequest();
  metrics.recordHttpRequest();
  metrics.recordDeviceWebSocketFrame();
  metrics.recordDeviceWebSocketFrame();
  metrics.recordDeviceWebSocketFrame();
  metrics.recordViewerRequest();
  metrics.recordViewerRequest();
  metrics.recordViewerFetchDispatched();
  metrics.recordViewerBudgetExhaustion();
  metrics.recordViewerSnapshotStoredBytes(2_048);
  metrics.recordViewerSnapshotStoredBytes(-5);
  currentTime += 1_100;
  intervalCallback();

  assert.equal(reports.length, 2);
  const periodic = reports[1];
  assert.equal(periodic.reason, "periodic");
  assert.equal(periodic.severity, "warning");
  assert.equal(periodic.http.requestsTotal, 2);
  assert.equal(periodic.http.requestsInterval, 2);
  assert.equal(periodic.deviceWebSocket.framesTotal, 3);
  assert.equal(periodic.deviceWebSocket.framesInterval, 3);
  assert.equal(periodic.eventLoop.lagMs, 100);
  assert.deepEqual(periodic.passwordChecks, {
    active: 2,
    queued: 3,
    maximumActive: 3,
    maximumQueued: 4,
  });
  assert.deepEqual(periodic.connections, { devicesCurrent: 2, sseClientsCurrent: 3 });
  assert.deepEqual(periodic.viewer, {
    requestsTotal: 2,
    requestsInterval: 2,
    requestsPerSecond: Number((2 * 1_000 / 1_100).toFixed(3)),
    fetchesDispatchedTotal: 1,
    fetchesDispatchedInterval: 1,
    budgetExhaustionsTotal: 1,
    budgetExhaustionsInterval: 1,
    snapshotBytesStoredTotal: 2_048,
    snapshotBytesStoredInterval: 2_048,
    activeFetches: 2,
    inFlightCiphertextChars: 4_096,
  }, "viewer traffic reports as aggregate counters and gauges only");
  assert.deepEqual(periodic.warnings, ["device_frame_rate", "event_loop_lag", "password_queue_saturation"]);
  assert.doesNotMatch(JSON.stringify(periodic), /account|browser|grant|token|slug|path|content|requestId|publication[iI]d|ciphertext"/i);

  const afterReport = metrics.snapshot();
  assert.equal(afterReport.http.requestsTotal, 2);
  assert.equal(afterReport.http.requestsInterval, 0);
  assert.equal(afterReport.deviceWebSocket.framesTotal, 3);
  assert.equal(afterReport.deviceWebSocket.framesInterval, 0);
  assert.equal(afterReport.viewer.requestsInterval, 0);
  assert.equal(afterReport.viewer.snapshotBytesStoredInterval, 0);
  assert.equal(afterReport.viewer.fetchesDispatchedTotal, 1);
});

test("bridge metrics can be disabled and stop clears its unrefed timer exactly once", () => {
  let callback = null;
  let clearCalls = 0;
  let reports = 0;
  const timer = { unref() {} };
  const metrics = createBridgeMetrics({
    sink: () => { reports += 1; },
    setIntervalFn(value) {
      callback = value;
      return timer;
    },
    clearIntervalFn(value) {
      assert.equal(value, timer);
      clearCalls += 1;
    },
  });
  assert.equal(metrics.start(), true);
  assert.equal(reports, 1);
  assert.equal(metrics.stop(), true);
  assert.equal(metrics.stop(), false);
  assert.equal(clearCalls, 1);
  callback();
  assert.equal(reports, 1, "a cleared late callback cannot report after shutdown");

  let disabledTimerCalls = 0;
  const disabled = createBridgeMetrics({
    enabled: false,
    sink: () => { reports += 1; },
    setIntervalFn() { disabledTimerCalls += 1; },
  });
  disabled.recordHttpRequest();
  disabled.recordDeviceWebSocketFrame();
  assert.equal(disabled.start(), false);
  assert.equal(disabled.report(), null);
  assert.equal(disabledTimerCalls, 0);
  assert.equal(disabled.snapshot().http.requestsTotal, 0);
});
