const metricsType = "work-fold.bridge.metrics.v1";
const defaultReportIntervalMs = 60_000;
const defaultFrameRateWarningPerSecond = 100;
const defaultEventLoopLagWarningMs = 250;
const defaultPasswordQueueWarningRatio = 0.75;

/**
 * Process-local, aggregate bridge telemetry. Callers supply only numeric or
 * boolean gauges; request paths, account/browser ids, payloads, tokens, and
 * operation ids never enter this record.
 */
export function createBridgeMetrics({
  enabled = true,
  reportIntervalMs = defaultReportIntervalMs,
  sink = consoleBridgeMetricsSink,
  gauges = () => ({}),
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  frameRateWarningPerSecond = defaultFrameRateWarningPerSecond,
  eventLoopLagWarningMs = defaultEventLoopLagWarningMs,
  passwordQueueWarningRatio = defaultPasswordQueueWarningRatio,
} = {}) {
  const intervalMs = positiveNumber(reportIntervalMs, defaultReportIntervalMs);
  const thresholds = Object.freeze({
    frameRatePerSecond: positiveNumber(frameRateWarningPerSecond, defaultFrameRateWarningPerSecond),
    eventLoopLagMs: positiveNumber(eventLoopLagWarningMs, defaultEventLoopLagWarningMs),
    passwordQueueRatio: ratio(passwordQueueWarningRatio, defaultPasswordQueueWarningRatio),
  });
  let httpRequestsTotal = 0;
  let httpRequestsInterval = 0;
  let deviceFramesTotal = 0;
  let deviceFramesInterval = 0;
  let lastReportAt = now();
  let lastEventLoopLagMs = 0;
  let expectedTickAt = lastReportAt + intervalMs;
  let timer = null;
  let stopped = false;

  const snapshot = ({
    at = now(),
    eventLoopLagMs = lastEventLoopLagMs,
    reason = "snapshot",
  } = {}) => {
    const observedAt = finiteNumber(at, now());
    const elapsedMs = Math.max(1, observedAt - lastReportAt);
    const current = safeGauges(gauges());
    const frameRate = rate(deviceFramesInterval, elapsedMs);
    const httpRate = rate(httpRequestsInterval, elapsedMs);
    const lagMs = Math.max(0, finiteNumber(eventLoopLagMs, 0));
    const queueRatio = current.passwordChecks.maximumQueued > 0
      ? current.passwordChecks.queued / current.passwordChecks.maximumQueued
      : 0;
    const warnings = [];
    if (frameRate >= thresholds.frameRatePerSecond) warnings.push("device_frame_rate");
    if (lagMs >= thresholds.eventLoopLagMs) warnings.push("event_loop_lag");
    if (queueRatio >= thresholds.passwordQueueRatio) warnings.push("password_queue_saturation");
    return Object.freeze({
      type: metricsType,
      severity: warnings.length ? "warning" : "info",
      reason: safeReason(reason),
      at: new Date(observedAt).toISOString(),
      intervalMs: elapsedMs,
      publicEnrollment: current.publicEnrollment,
      http: Object.freeze({
        requestsTotal: httpRequestsTotal,
        requestsInterval: httpRequestsInterval,
        requestsPerSecond: httpRate,
      }),
      deviceWebSocket: Object.freeze({
        framesTotal: deviceFramesTotal,
        framesInterval: deviceFramesInterval,
        framesPerSecond: frameRate,
      }),
      passwordChecks: current.passwordChecks,
      connections: Object.freeze({
        devicesCurrent: current.devicesCurrent,
        sseClientsCurrent: current.sseClientsCurrent,
      }),
      eventLoop: Object.freeze({ lagMs }),
      warnings: Object.freeze(warnings),
    });
  };

  const report = ({ reason = "manual", at = now(), eventLoopLagMs = lastEventLoopLagMs } = {}) => {
    if (!enabled || stopped) return null;
    const record = snapshot({ reason, at, eventLoopLagMs });
    try {
      sink(record);
    } catch {
      // Observability must never become bridge availability authority.
    }
    lastReportAt = finiteNumber(at, now());
    lastEventLoopLagMs = Math.max(0, finiteNumber(eventLoopLagMs, 0));
    httpRequestsInterval = 0;
    deviceFramesInterval = 0;
    return record;
  };

  return Object.freeze({
    recordHttpRequest() {
      if (!enabled || stopped) return;
      httpRequestsTotal = increment(httpRequestsTotal);
      httpRequestsInterval = increment(httpRequestsInterval);
    },
    recordDeviceWebSocketFrame() {
      if (!enabled || stopped) return;
      deviceFramesTotal = increment(deviceFramesTotal);
      deviceFramesInterval = increment(deviceFramesInterval);
    },
    snapshot,
    report,
    start() {
      if (!enabled || stopped || timer) return false;
      const startedAt = now();
      lastReportAt = startedAt;
      expectedTickAt = startedAt + intervalMs;
      report({ reason: "startup", at: startedAt, eventLoopLagMs: 0 });
      timer = setIntervalFn(() => {
        if (stopped || !timer) return;
        const observedAt = now();
        const lagMs = Math.max(0, observedAt - expectedTickAt);
        expectedTickAt = observedAt + intervalMs;
        report({ reason: "periodic", at: observedAt, eventLoopLagMs: lagMs });
      }, intervalMs);
      timer?.unref?.();
      return true;
    },
    stop() {
      if (stopped) return false;
      stopped = true;
      if (timer) clearIntervalFn(timer);
      timer = null;
      return true;
    },
  });
}

export function consoleBridgeMetricsSink(record) {
  const line = JSON.stringify(record);
  if (record.severity === "warning") console.warn(line);
  else console.log(line);
}

function safeGauges(value) {
  const gauges = value && typeof value === "object" ? value : {};
  const password = gauges.passwordChecks && typeof gauges.passwordChecks === "object"
    ? gauges.passwordChecks
    : {};
  return {
    publicEnrollment: gauges.publicEnrollment === true,
    devicesCurrent: nonNegativeInteger(gauges.devicesCurrent),
    sseClientsCurrent: nonNegativeInteger(gauges.sseClientsCurrent),
    passwordChecks: Object.freeze({
      active: nonNegativeInteger(password.active),
      queued: nonNegativeInteger(password.queued),
      maximumActive: nonNegativeInteger(password.maximumActive),
      maximumQueued: nonNegativeInteger(password.maximumQueued),
    }),
  };
}

function rate(count, elapsedMs) {
  return Number((count * 1_000 / elapsedMs).toFixed(3));
}

function increment(value) {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function ratio(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function safeReason(value) {
  return value === "startup" || value === "periodic" || value === "manual" || value === "snapshot"
    ? value
    : "manual";
}
