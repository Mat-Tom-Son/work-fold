import assert from "node:assert/strict";
import test from "node:test";

import {
  RestrictedAppNotificationBroker,
  restrictedAppNotificationLimits,
  type RestrictedAppNotificationDisplay,
  type RestrictedAppNotificationHandle,
} from "../src/local/agent/restricted-app-notifications.js";

class Sink {
  readonly shown: Array<{
    notification: RestrictedAppNotificationDisplay;
    callbacks: { onClick: () => void; onClose: () => void };
    handle: RestrictedAppNotificationHandle & { closed: boolean };
  }> = [];
  supported = true;

  isSupported(): boolean { return this.supported; }

  show(notification: RestrictedAppNotificationDisplay, callbacks: { onClick: () => void; onClose: () => void }) {
    const handle = {
      closed: false,
      close: () => {
        handle.closed = true;
        callbacks.onClose();
      },
    };
    this.shown.push({ notification, callbacks, handle });
    return handle;
  }
}

const digestOne = "1".repeat(64);
const digestTwo = "2".repeat(64);

test("notification handles and click targets distinguish installations with the same work-folder, app, and revision", () => {
  const sink = new Sink();
  const broker = new RestrictedAppNotificationBroker({ sink });
  const opened: unknown[] = [];
  const source = context({ featureInstallationId: "feature-source" });
  const release = context({ featureInstallationId: "feature-release" });
  try {
    assert.equal(broker.show(source, { permissionId: "new-mail" }, (request) => opened.push(request)).status, "shown");
    assert.equal(broker.show(release, { permissionId: "new-mail" }, (request) => opened.push(request)).status, "shown");
    assert.equal(sink.shown[0]!.handle.closed, false, "a sibling category must not replace the source notification");
    broker.closeApp(source, digestOne);
    assert.equal(sink.shown[0]!.handle.closed, true);
    assert.equal(sink.shown[1]!.handle.closed, false);
    sink.shown[1]!.callbacks.onClick();
    assert.deepEqual(opened, [{ workFolderId: release.workFolderId, appId: release.appId, digest: digestOne,
      featureInstallationId: "feature-release", permissionId: "new-mail" }]);
  } finally { broker.dispose(); }
});

function context(overrides: Record<string, unknown> = {}) {
  return {
    workFolderId: "ws-1111111111111111",
    appId: "connected-inbox",
    digest: digestOne,
    appTitle: "Connected inbox",
    declarations: [
      { id: "new-mail", title: "New mail", description: "New messages are ready." },
      { id: "sync-error", title: "Sync paused", description: "Open the app to reconnect." },
      { id: "export-ready", title: "Export ready", description: "Your export is ready." },
    ],
    grants: ["new-mail", "sync-error", "export-ready"],
    appAutomationEnabled: true,
    invocationId: "invocation-one",
    ...overrides,
  };
}

test("notification broker renders only reviewed static copy during an enabled automation", () => {
  const sink = new Sink();
  const opened: unknown[] = [];
  const broker = new RestrictedAppNotificationBroker({ sink });
  assert.deepEqual(broker.show(context(), { permissionId: "new-mail" }, (request) => opened.push(request)), { status: "shown" });
  assert.deepEqual(sink.shown[0]?.notification, {
    workFolderId: "ws-1111111111111111",
    appId: "connected-inbox",
    digest: digestOne,
    permissionId: "new-mail",
    title: "work-fold · Connected inbox — New mail",
    body: "New messages are ready.",
  });
  sink.shown[0]?.callbacks.onClick();
  assert.deepEqual(opened, [{ workFolderId: "ws-1111111111111111", appId: "connected-inbox", digest: digestOne, permissionId: "new-mail" }]);
  assert.equal(sink.shown[0]?.handle.closed, true, "clicking consumes and closes the current notification");
  sink.shown[0]?.callbacks.onClick();
  assert.equal(opened.length, 1, "a stale native click cannot reopen the app");
  broker.dispose();
});

test("notification broker rejects dynamic payloads, missing grants, and disabled automation authority", () => {
  const sink = new Sink();
  const broker = new RestrictedAppNotificationBroker({ sink });
  assert.throws(() => broker.show(context(), { permissionId: "new-mail", body: "injected" }, () => undefined), /only a valid permissionId/);
  assert.throws(() => broker.show(context({ grants: [] }), { permissionId: "new-mail" }, () => undefined), /not granted/);
  assert.throws(() => broker.show(context({ appAutomationEnabled: false }), { permissionId: "new-mail" }, () => undefined), /Enable this automation/);
  assert.equal(sink.shown.length, 0);
  broker.dispose();
});

const categories = ["new-mail", "sync-error", "export-ready"] as const;

test("notification spam guards are generous: the hourly rate is reachable with one category's spacing", () => {
  const { perHour, perInvocation, categoryIntervalMs, outstandingPerApp } = restrictedAppNotificationLimits;
  assert.deepEqual([perHour, perInvocation, categoryIntervalMs, outstandingPerApp], [120, 20, 30_000, 3]);
  assert.ok(categoryIntervalMs * perHour <= 60 * 60_000, "a single category can reach the hourly rate");
});

test("notification anti-spam quota survives close, permission churn, automation churn, and digest updates", () => {
  const { perHour, categoryIntervalMs } = restrictedAppNotificationLimits;
  // Rotate categories so per-category spacing never refuses; only the hourly volume can.
  const step = Math.floor((60 * 60_000 - 1) / perHour);
  assert.ok(step * categories.length > categoryIntervalMs);
  let now = 1_000;
  const sink = new Sink();
  const broker = new RestrictedAppNotificationBroker({ sink, now: () => now });
  for (let index = 0; index < perHour; index += 1) {
    assert.deepEqual(broker.show(context({ invocationId: `invocation-${index}` }), { permissionId: categories[index % categories.length]! }, () => undefined), { status: "shown" });
    now += step;
  }
  broker.closeApp({ workFolderId: "ws-1111111111111111", appId: "connected-inbox" }, digestOne);
  const permissionId = categories[perHour % categories.length]!;
  const updated = context({ digest: digestTwo, invocationId: "after-update", grants: [], appAutomationEnabled: false });
  assert.throws(() => broker.show(updated, { permissionId }, () => undefined), /Enable this automation/);
  assert.deepEqual(broker.show({ ...updated, grants: [...categories], appAutomationEnabled: true }, { permissionId }, () => undefined), { status: "rate-limited" });
  assert.equal(sink.shown.length, perHour);
  broker.dispose();
});

test("notification broker enforces invocation and outstanding limits", () => {
  const { perInvocation, categoryIntervalMs, outstandingPerApp } = restrictedAppNotificationLimits;
  let now = 1_000;
  const sink = new Sink();
  const broker = new RestrictedAppNotificationBroker({ sink, now: () => now });
  for (let index = 0; index < perInvocation; index += 1) {
    assert.equal(broker.show(context(), { permissionId: categories[index % categories.length]! }, () => undefined).status, "shown");
    now += categoryIntervalMs + 1;
  }
  const next = categories[perInvocation % categories.length]!;
  assert.equal(broker.show(context(), { permissionId: next }, () => undefined).status, "rate-limited", "one invocation shows at most perInvocation");
  assert.equal(broker.show(context({ invocationId: "two" }), { permissionId: next }, () => undefined).status, "shown");
  now += categoryIntervalMs + 1;
  const outstanding = sink.shown.filter((item) => !item.handle.closed);
  assert.equal(outstanding.length, outstandingPerApp);
  assert.equal(broker.show(context({ invocationId: "three", declarations: [...context().declarations, { id: "digest-ready", title: "Digest ready", description: "Your digest is ready." }], grants: [...context().grants, "digest-ready"] }), { permissionId: "digest-ready" }, () => undefined).status, "shown");
  assert.equal(outstanding[0]?.handle.closed, true, "the oldest outstanding notification is closed at the per-app cap");
  broker.dispose();
});

test("notification lifecycle cleanup filters digest handles and tolerates synchronous native close", () => {
  const sink = new Sink();
  const broker = new RestrictedAppNotificationBroker({ sink });
  broker.show(context(), { permissionId: "new-mail" }, () => undefined);
  broker.show(context({ digest: digestTwo, invocationId: "two" }), { permissionId: "sync-error" }, () => undefined);
  broker.closeApp({ workFolderId: "ws-1111111111111111", appId: "connected-inbox" }, digestOne);
  assert.equal(sink.shown[0]?.handle.closed, true);
  assert.equal(sink.shown[1]?.handle.closed, false);
  broker.closeAll();
  assert.equal(sink.shown[1]?.handle.closed, true);
  broker.dispose();

  const synchronousSink = {
    isSupported: () => true,
    show: (_notification: RestrictedAppNotificationDisplay, callbacks: { onClick: () => void; onClose: () => void }) => {
      callbacks.onClose();
      return { close: () => undefined };
    },
  };
  const synchronous = new RestrictedAppNotificationBroker({ sink: synchronousSink });
  assert.equal(synchronous.show(context(), { permissionId: "new-mail" }, () => undefined).status, "shown");
  synchronous.closeAll();
  synchronous.dispose();
});
