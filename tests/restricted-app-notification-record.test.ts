import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RestrictedAppNotificationRecord,
  type RestrictedAppNotificationOutcome,
} from "../src/local/agent/restricted-app-notification-record.js";
import {
  RestrictedAppNotificationBroker,
  restrictedAppNotificationLimits,
  type RestrictedAppNotificationDisplay,
} from "../src/local/agent/restricted-app-notifications.js";
import { startLocalApi } from "../src/local/server.js";
import type { RestrictedAppInstalled } from "../src/local/agent/restricted-app-service.js";
import {
  formatNotificationRecordTime,
  notificationRecordStatusLabel,
} from "../web-local/src/lib/restricted-app-notification-record.js";

const digest = "1".repeat(64);
const scope = { workFolderId: "ws-1111111111111111", appId: "screenshots", featureInstallationId: "feature-installation_one" };

function outcome(overrides: Partial<RestrictedAppNotificationOutcome> = {}): RestrictedAppNotificationOutcome {
  return {
    at: "2026-10-11T19:02:00.000Z",
    ...scope,
    digest,
    permissionId: "sorted",
    title: "New screenshots sorted",
    status: "shown",
    ...overrides,
  };
}

async function sandbox(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-notification-record-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Each `notifications.show` outcome lands in a bounded machine-local record
 * outside every work-folder (docs/restricted-app-runtime.md): when, which app
 * and installation, the reviewed category and its title, and what happened.
 */
test("the notification record keeps each outcome per installation, newest first, across a restart", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "restricted-apps", "notification-receipts.jsonl");
  const now = new Date("2026-10-11T20:00:00.000Z");
  const record = await RestrictedAppNotificationRecord.open({ path, now: () => now });
  const changes: unknown[] = [];
  record.on("changed", (change) => changes.push(change));
  await record.record(outcome());
  await record.record(outcome({ at: "2026-10-11T19:05:00.000Z", status: "rate-limited" }));
  await record.record(outcome({ at: "2026-10-11T19:06:00.000Z", status: "unsupported", digest: "2".repeat(64) }));
  await record.record(outcome({ featureInstallationId: "feature-installation_sibling", title: "Sibling" }));
  assert.equal(changes.length, 4, "every written outcome is announced");

  const listed = await record.list(scope);
  assert.deepEqual(listed.map((entry) => [entry.status, entry.at]), [
    ["unsupported", "2026-10-11T19:06:00.000Z"],
    ["rate-limited", "2026-10-11T19:05:00.000Z"],
    ["shown", "2026-10-11T19:02:00.000Z"],
  ], "one installation's outcomes, newest first, across code changes");
  assert.deepEqual(Object.keys(listed[0]!).sort(), ["appId", "at", "digest", "featureInstallationId", "id", "permissionId", "status", "title", "v", "workFolderId"].sort(),
    "the record names the category and its title — never a route, state, or other app content");
  assert.deepEqual((await record.list(scope, 1)).map((entry) => entry.status), ["unsupported"]);

  // A torn last line (a crash mid-append) is skipped, not fatal.
  await writeFile(path, `${await readFile(path, "utf8")}{"v":1,"id":`, "utf8");
  const reopened = await RestrictedAppNotificationRecord.open({ path, now: () => now });
  assert.equal((await reopened.list(scope)).length, 3);
  assert.equal((await readFile(path, "utf8")).includes(`{"v":1,"id":\n`), false, "the damaged line is rewritten away");
});

test("the notification record is generous but bounded: by age, per installation, and overall", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "notification-receipts.jsonl");
  let now = new Date("2026-10-11T20:00:00.000Z");
  const record = await RestrictedAppNotificationRecord.open({
    path,
    now: () => now,
    limits: { perInstallation: 3, records: 5, maxAgeDays: 90 },
  });
  for (let minute = 0; minute < 6; minute += 1) {
    await record.record(outcome({ at: new Date(Date.UTC(2026, 9, 11, 19, minute)).toISOString(), title: `One ${minute}` }));
  }
  for (let minute = 0; minute < 3; minute += 1) {
    await record.record(outcome({ featureInstallationId: "feature-installation_two", at: new Date(Date.UTC(2026, 9, 11, 19, 30 + minute)).toISOString(), title: `Two ${minute}` }));
  }
  // Reopening applies every bound: the chatty installation keeps its newest
  // three, the record keeps its newest five overall.
  const reopened = await RestrictedAppNotificationRecord.open({ path, now: () => now, limits: { perInstallation: 3, records: 5, maxAgeDays: 90 } });
  assert.deepEqual((await reopened.list(scope)).map((entry) => entry.title), ["One 5", "One 4"]);
  assert.deepEqual((await reopened.list({ ...scope, featureInstallationId: "feature-installation_two" })).map((entry) => entry.title), ["Two 2", "Two 1", "Two 0"]);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 5);

  // Nothing is kept past ninety days.
  now = new Date("2027-02-01T00:00:00.000Z");
  assert.deepEqual(await reopened.list(scope), [], "aged-out outcomes are not read");
  await RestrictedAppNotificationRecord.open({ path, now: () => now });
  assert.equal((await readFile(path, "utf8")).trim(), "", "and are dropped from the file");
});

class Sink {
  readonly shown: RestrictedAppNotificationDisplay[] = [];
  supported = true;
  isSupported(): boolean { return this.supported; }
  show(notification: RestrictedAppNotificationDisplay) {
    this.shown.push(notification);
    return { close() {} };
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    workFolderId: scope.workFolderId,
    appId: scope.appId,
    featureInstallationId: scope.featureInstallationId,
    digest,
    appTitle: "Screenshots",
    declarations: [{ id: "sorted", title: "New screenshots sorted", description: "Your screenshots are in folders." }],
    grants: ["sorted"],
    appAutomationEnabled: true,
    invocationId: "invocation-one",
    ...overrides,
  };
}

test("the notification broker reports shown, rate-limited, and unsupported outcomes, and nothing for a refused call", async () => {
  let now = Date.parse("2026-10-11T19:02:00.000Z");
  const sink = new Sink();
  const recorded: RestrictedAppNotificationOutcome[] = [];
  const broker = new RestrictedAppNotificationBroker({ sink, now: () => now, record: (item) => { recorded.push(item); } });
  try {
    assert.equal(broker.show(context(), { permissionId: "sorted", route: "/sorted/today", state: { count: 12 } }, () => undefined).status, "shown");
    now += 1_000;
    assert.equal(broker.show(context({ invocationId: "two" }), { permissionId: "sorted" }, () => undefined).status, "rate-limited");
    assert.throws(() => broker.show(context({ grants: [] }), { permissionId: "sorted" }, () => undefined), /not granted/);
    sink.supported = false;
    now += restrictedAppNotificationLimits.categoryIntervalMs;
    assert.equal(broker.show(context({ invocationId: "three" }), { permissionId: "sorted" }, () => undefined).status, "unsupported");
    // A recorder that fails never fails the app's call.
    const failing = new RestrictedAppNotificationBroker({ sink: new Sink(), record: () => { throw new Error("disk full"); } });
    assert.equal(failing.show(context(), { permissionId: "sorted" }, () => undefined).status, "shown");
    failing.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(recorded.map((item) => [item.status, item.at, item.title, item.featureInstallationId]), [
      ["shown", "2026-10-11T19:02:00.000Z", "New screenshots sorted", scope.featureInstallationId],
      ["rate-limited", "2026-10-11T19:02:01.000Z", "New screenshots sorted", scope.featureInstallationId],
      ["unsupported", "2026-10-11T19:02:31.000Z", "New screenshots sorted", scope.featureInstallationId],
    ]);
    assert.ok(recorded.every((item) => !JSON.stringify(item).includes("/sorted/today")), "the destination never enters the record");
  } finally { broker.dispose(); }
});

test("Settings → Apps reads one exact installation's notification record through the local API", async (t) => {
  const root = await sandbox(t);
  const record = await RestrictedAppNotificationRecord.open({ path: join(root, "record.jsonl") });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(root, "state"),
    workFolderBase: join(root, "work-folders"),
    loadEnv: false,
    appNotificationRecord: record,
  });
  try {
    const created = await api.actFacade.createWorkFolder({ name: "Screenshots" });
    const packageRoot = join(created.workFolder.workFolderRoot, "app");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "screenshots", version: "1.0.0", private: true, type: "module", agentApp: "agent-app.json" }), "utf8");
    await writeFile(join(packageRoot, "agent-app.json"), JSON.stringify({
      version: 2, id: "screenshots", title: "Screenshots", description: "Sorts screenshots.",
      runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: { icon: "image" }, tools: [], automations: [],
      permissions: { network: [], files: [], notifications: [] },
    }), "utf8");
    await writeFile(join(packageRoot, "index.html"), "<!doctype html><title>Screenshots</title>", "utf8");
    await api.actFacade.appsInstallPreview({ workFolder: created.workFolder.id, packagePath: "app" });
    const base = `${api.origin}/api/work-folders/${created.workFolder.id}/restricted-apps`;
    const app = ((await (await fetch(base)).json()) as { apps: RestrictedAppInstalled[] }).apps[0]!;
    await record.record(outcome({ workFolderId: app.workFolderId, appId: app.manifest.id, featureInstallationId: app.featureInstallationId, digest: app.digest }));
    await record.record(outcome({ workFolderId: app.workFolderId, appId: app.manifest.id, featureInstallationId: "feature-installation_other", digest: app.digest, title: "Someone else" }));

    const response = await fetch(`${base}/screenshots/notification-receipts?${new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest })}`);
    assert.equal(response.ok, true);
    const { receipts } = await response.json() as { receipts: Array<{ title: string; status: string }> };
    assert.deepEqual(receipts.map((entry) => [entry.status, entry.title]), [["shown", "New screenshots sorted"]], "only this installation's outcomes");
    const unpinned = await fetch(`${base}/screenshots/notification-receipts?featureInstallationId=${app.featureInstallationId}`);
    assert.equal(unpinned.ok, false, "a read names an exact installation and revision");
    await unpinned.json();
  } finally {
    await api.close();
  }
});

test("Settings → Apps describes each outcome in a short line", () => {
  assert.equal(notificationRecordStatusLabel("shown"), "Shown");
  assert.equal(notificationRecordStatusLabel("rate-limited"), "Not shown (too many at once)");
  assert.equal(notificationRecordStatusLabel("unsupported"), "Not shown (notifications unavailable)");
  const at = "2026-10-11T19:02:00.000Z";
  assert.match(formatNotificationRecordTime(at, "en-US"), /^Oct 11, \d{1,2}:02\s?[AP]M$/);
});
