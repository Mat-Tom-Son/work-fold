import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WorkFoldCliActReceiptV2 } from "../src/local/cli/act-receipts.js";
import { createWorkFoldGlanceViewerGrantReader } from "../src/local/glance.js";
import {
  WORKFOLD_PUBLICATION_ACTIVE_CAP,
  WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES,
  WorkFoldPublicationError,
  WorkFoldPublicationService,
  renderInertMarkdown,
  workFoldPublicationsFile,
  workFoldViewerAppAad,
  workFoldViewerAppCallFingerprint,
  workFoldViewerPageAad,
  type WorkFoldPublicationActContext,
  type WorkFoldPublicationAppServing,
  type WorkFoldPublicationBridgeSync,
  type WorkFoldPublicationKeyStore,
  type WorkFoldViewerAppServeResult,
  type WorkFoldViewerPageServeResult,
} from "../src/local/publications.js";
import {
  createDataNamespaceId,
  createFeatureInstallationId,
  createRuntimeInstanceId,
  createTenantId,
} from "../src/local/agent/app-platform-contract.js";
import { stageRestrictedAppPackage } from "../src/local/agent/restricted-app-package.js";
import { FileRestrictedAppStorage, type RestrictedAppStorageOwner } from "../src/local/agent/restricted-app-storage.js";
import {
  createRestrictedAppViewerAdapter,
  type RestrictedAppViewerInstanceProjection,
} from "../src/local/agent/restricted-app-viewer.js";

function fixedClock(iso = "2026-08-10T10:00:00.000Z"): { at: number; now: () => Date } {
  const clock = { at: Date.parse(iso), now: () => new Date(clock.at) };
  return clock;
}

function memoryKeys(): WorkFoldPublicationKeyStore & { values: Map<string, string>; reads: number } {
  const store = {
    values: new Map<string, string>(),
    reads: 0,
    async get(publicationId: string) {
      store.reads += 1;
      return store.values.get(publicationId) ?? null;
    },
    async set(publicationId: string, key: string) {
      store.values.set(publicationId, key);
    },
    async remove(publicationId: string) {
      store.values.delete(publicationId);
    },
  };
  return store;
}

interface RecordedReceipts {
  entries: Array<Omit<WorkFoldCliActReceiptV2, "v" | "at">>;
  unavailable: boolean;
  append(entry: Omit<WorkFoldCliActReceiptV2, "v" | "at">): Promise<boolean>;
}

function receiptsRecorder(): RecordedReceipts {
  const recorder: RecordedReceipts = {
    entries: [],
    unavailable: false,
    async append(entry) {
      if (recorder.unavailable) return false;
      recorder.entries.push(structuredClone(entry));
      return true;
    },
  };
  return recorder;
}

interface RecordedBridge extends WorkFoldPublicationBridgeSync {
  calls: Array<{ method: string; input: unknown }>;
  offline: boolean;
}

function bridgeRecorder(): RecordedBridge {
  const bridge: RecordedBridge = {
    calls: [],
    offline: false,
    async upsertSlot(input) {
      if (bridge.offline) throw new Error("bridge offline");
      bridge.calls.push({ method: "upsertSlot", input: structuredClone(input) });
    },
    async deleteSlot(publicationId) {
      if (bridge.offline) throw new Error("bridge offline");
      bridge.calls.push({ method: "deleteSlot", input: publicationId });
    },
    async putSnapshot(input) {
      if (bridge.offline) throw new Error("bridge offline");
      bridge.calls.push({ method: "putSnapshot", input: structuredClone(input) });
    },
    async deleteSnapshot(publicationId) {
      if (bridge.offline) throw new Error("bridge offline");
      bridge.calls.push({ method: "deleteSnapshot", input: publicationId });
    },
  };
  return bridge;
}

async function publicationFixture(options: { bridge?: RecordedBridge | null; apps?: WorkFoldPublicationAppServing | null } = {}): Promise<{
  service: WorkFoldPublicationService;
  clock: ReturnType<typeof fixedClock>;
  keys: ReturnType<typeof memoryKeys>;
  receipts: RecordedReceipts;
  bridge: RecordedBridge;
  stateRoot: string;
  spaceRoot: string;
  storePath: string;
  spaces: Map<string, string | null>;
}> {
  const base = await mkdtemp(join(tmpdir(), "work-fold-publications-"));
  const stateRoot = join(base, "state");
  const spaceRoot = join(base, "space");
  await mkdir(spaceRoot, { recursive: true });
  await writeFile(join(spaceRoot, "report.md"), "# Quarterly\n\nAll **good**.\n\n<script>alert(1)</script>\n");
  await writeFile(join(spaceRoot, "notes.txt"), "plain <notes> & text\n");
  await writeFile(join(spaceRoot, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const clock = fixedClock();
  const keys = memoryKeys();
  const receipts = receiptsRecorder();
  const bridge = options.bridge === undefined ? bridgeRecorder() : options.bridge ?? bridgeRecorder();
  const spaces = new Map<string, string | null>([["space-pub", spaceRoot]]);
  const storePath = workFoldPublicationsFile(stateRoot);
  const service = await WorkFoldPublicationService.create({
    path: storePath,
    now: clock.now,
    keys,
    receipts,
    bridge: options.bridge === null ? null : bridge,
    resolveSpaceRoot: async (spaceId) => spaces.get(spaceId) ?? null,
    ...(options.apps !== undefined ? { apps: options.apps } : {}),
  });
  return { service, clock, keys, receipts, bridge, stateRoot, spaceRoot, storePath, spaces };
}

function context(requestId: string): WorkFoldPublicationActContext {
  return { requestId, surface: "popover", parentTaskId: "task-1" };
}

function decryptServed(keyBase64Url: string, served: Extract<WorkFoldViewerPageServeResult, { state: "served" }>): unknown {
  const key = Buffer.from(keyBase64Url, "base64url");
  const bytes = Buffer.from(served.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(served.iv, "base64url"));
  decipher.setAAD(workFoldViewerPageAad(served.publicationId, served.contentDigest, served.servedAt));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

function isRefusal(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof WorkFoldPublicationError && error.code === code;
}

test("activation is journal-first, mints a durable intent with its key, and confirms the bridge slot", async () => {
  const fixture = await publicationFixture();

  fixture.receipts.unavailable = true;
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "report.md", title: "Quarterly report" }, context("req-1")),
    isRefusal("JOURNAL_UNAVAILABLE"),
    "a mutation that cannot be journaled is refused before it runs",
  );
  assert.deepEqual(await fixture.service.list(), []);
  assert.equal(fixture.bridge.calls.length, 0);
  assert.equal(fixture.keys.values.size, 0);

  fixture.receipts.unavailable = false;
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-lost", relativePath: "report.md", title: "T" }, context("req-2")),
    isRefusal("SPACE_NOT_REGISTERED"),
  );
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "report.exe", title: "T" }, context("req-3")),
    isRefusal("SOURCE_INVALID"),
    "the first-slice source set is closed",
  );
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "../outside.md", title: "T" }, context("req-4")),
    isRefusal("SOURCE_INVALID"),
    "a source outside the Space is refused at binding time",
  );
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: ".work-fold/space.json", title: "T" }, context("req-5")),
    isRefusal("SOURCE_INVALID"),
    "portable metadata cannot be designated",
  );
  await assert.rejects(
    fixture.service.activate(
      { spaceId: "space-pub", relativePath: "report.md", title: "T", serveRatePerMinute: 6_000 },
      context("req-6"),
    ),
    isRefusal("INPUT_INVALID"),
  );
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "report.md", title: "x".repeat(90) }, context("req-7")),
    isRefusal("INPUT_INVALID"),
  );

  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Quarterly report", snapshotEnabled: true },
    context("req-8"),
  );
  assert.equal(view.state, "active");
  assert.equal(view.live, true, "a confirmed bridge slot presents as live");
  assert.equal(view.bridgeSlot, "confirmed");
  assert.equal(view.viewerPath, `/p/${view.publicationId}`);
  assert.equal(view.serveRatePerMinute, 60);
  assert.equal(view.byteBudgetPerDay, 256 * 1024 * 1024);
  assert.equal(fixture.keys.values.has(view.publicationId), true, "the publication key exists only in the injected secure store");
  assert.deepEqual(
    fixture.bridge.calls.map((call) => call.method),
    ["upsertSlot", "putSnapshot"],
    "an opted-in activation seeds the relay snapshot so the page survives sleep from the first moment",
  );
  const slot = fixture.bridge.calls[0]!.input as Record<string, unknown>;
  assert.equal(slot.publicationId, view.publicationId);
  assert.equal(slot.snapshotEnabled, true);
  assert.equal("title" in slot || "relativePath" in slot || "spaceId" in slot, false, "the bridge sync is content-free");
  const seeded = fixture.bridge.calls[1]!.input as Record<string, unknown>;
  assert.equal(seeded.publicationId, view.publicationId);
  assert.match(String(seeded.contentDigest), /^sha256:/);
  assert.match(String(seeded.ciphertext), /^[A-Za-z0-9_-]+$/, "the seed carries ciphertext, never plaintext");
  assert.equal(seeded.capturedAt, fixture.clock.now().toISOString());
  const seededView = (await fixture.service.get(view.publicationId))!;
  assert.equal(seededView.counters, undefined, "a snapshot seed is not a viewer serve and is never counted");

  const outcomes = fixture.receipts.entries.filter((entry) => entry.requestId === "req-8").map((entry) => entry.outcome);
  assert.deepEqual(outcomes, ["accepted", "ok"], "accepted lands before the mutation and a terminal ok after");
  const terminal = fixture.receipts.entries.at(-1)!;
  assert.equal(terminal.command, "pages activate");
  assert.equal(terminal.spaceId, "space-pub");
  assert.equal(terminal.surface, "popover");
  assert.match(terminal.detail!, /viewerPath=\/p\//);
  assert.match(terminal.detail!, /bridgeSync=confirmed/);
  const receiptText = JSON.stringify(fixture.receipts.entries);
  assert.doesNotMatch(receiptText, new RegExp(fixture.keys.values.get(view.publicationId)!), "no receipt ever contains the key");

  const stored = JSON.parse(await readFile(fixture.storePath, "utf8")) as { publications: Array<Record<string, unknown>> };
  assert.equal(stored.publications[0]!.publicationId, view.publicationId);
  const glanceEvents = await createWorkFoldGlanceViewerGrantReader({ stateRoot: fixture.stateRoot })();
  assert.deepEqual(glanceEvents, [
    { publicationId: view.publicationId, event: "created", at: view.createdAt, spaceId: "space-pub" },
  ], "the glance reads this store's records without new wiring");
});

test("two-phase activation survives an offline bridge and the redrive lane completes it", async () => {
  const fixture = await publicationFixture();
  fixture.bridge.offline = true;
  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Pending page" },
    context("req-pending"),
  );
  assert.equal(view.live, false, "not presented as live until the bridge slot is confirmed");
  assert.equal(view.bridgeSlot, "pending");
  assert.match(fixture.receipts.entries.at(-1)!.detail!, /bridgeSync=pending/);

  const served = await fixture.service.serveViewerPage(view.publicationId);
  assert.equal(served.state, "served", "the desktop can serve its own grant while the slot sync is pending");

  fixture.bridge.offline = false;
  assert.deepEqual(await fixture.service.redriveBridgeSync(), { confirmed: 1, pending: 0 });
  assert.equal((await fixture.service.get(view.publicationId))!.live, true);
  assert.equal((await fixture.service.redriveBridgeSync()).confirmed, 0, "a confirmed slot is not re-driven");
});

test("serving renders the closed set within bounds and decrypts under the documented AAD", async () => {
  const fixture = await publicationFixture();
  const markdown = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Quarterly report" },
    context("req-md"),
  );

  const [first, second] = await Promise.all([
    fixture.service.serveViewerPage(markdown.publicationId),
    fixture.service.serveViewerPage(markdown.publicationId),
  ]);
  assert.equal(first.state, "served");
  assert.deepEqual(second, first, "concurrent fetches for one slot coalesce onto one render");
  const served = first as Extract<WorkFoldViewerPageServeResult, { state: "served" }>;
  assert.equal(served.byteSize, Buffer.from(served.ciphertext, "base64url").length);
  const payload = decryptServed(fixture.keys.values.get(markdown.publicationId)!, served) as {
    v: number; title: string; mediaType: string; body: string;
  };
  assert.equal(payload.v, 1);
  assert.equal(payload.title, "Quarterly report", "the title travels inside the encrypted payload only");
  assert.equal(payload.mediaType, "text/html");
  assert.match(payload.body, /<h1>Quarterly<\/h1>/);
  assert.match(payload.body, /<strong>good<\/strong>/);
  assert.doesNotMatch(payload.body, /<script>/, "raw HTML in Markdown is escaped, never emitted");
  assert.match(payload.body, /&lt;script&gt;/);

  const text = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "notes.txt", title: "Notes" },
    context("req-txt"),
  );
  const servedText = await fixture.service.serveViewerPage(text.publicationId) as Extract<WorkFoldViewerPageServeResult, { state: "served" }>;
  const textPayload = decryptServed(fixture.keys.values.get(text.publicationId)!, servedText) as { body: string; mediaType: string };
  assert.equal(textPayload.mediaType, "text/html");
  assert.match(textPayload.body, /^<pre class="plain-text">plain &lt;notes&gt; &amp; text/);

  const image = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "photo.png", title: "Photo" },
    context("req-png"),
  );
  const servedImage = await fixture.service.serveViewerPage(image.publicationId) as Extract<WorkFoldViewerPageServeResult, { state: "served" }>;
  const imagePayload = decryptServed(fixture.keys.values.get(image.publicationId)!, servedImage) as { body: string; mediaType: string };
  assert.equal(imagePayload.mediaType, "image/png");
  assert.deepEqual(
    Buffer.from(imagePayload.body, "base64url"),
    await readFile(join(fixture.spaceRoot, "photo.png")),
    "binary sources ship byte-exact inside the envelope",
  );

  await writeFile(join(fixture.spaceRoot, "big.md"), Buffer.alloc(WORKFOLD_PUBLICATION_MAX_SOURCE_BYTES + 1, 0x61));
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "big.md", title: "Big" }, context("req-big")),
    isRefusal("SOURCE_INVALID"),
    "the pre-render source bound applies at designation time",
  );
});

test("the effect-time recheck refuses with typed, content-free states", async () => {
  const fixture = await publicationFixture();
  assert.deepEqual(await fixture.service.serveViewerPage("publication-unknown"), {
    state: "nothing-here",
    publicationId: "publication-unknown",
  });

  const expiring = await fixture.service.activate(
    {
      spaceId: "space-pub",
      relativePath: "report.md",
      title: "Expiring",
      expiresAt: new Date(fixture.clock.at + 60_000).toISOString(),
    },
    context("req-expiring"),
  );
  assert.equal((await fixture.service.serveViewerPage(expiring.publicationId)).state, "served");
  fixture.clock.at += 120_000;
  assert.equal((await fixture.service.serveViewerPage(expiring.publicationId)).state, "nothing-here", "expiry is refused lazily at serve time");
  assert.equal((await fixture.service.get(expiring.publicationId))!.state, "expired");

  const page = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "notes.txt", title: "Notes" },
    context("req-recheck"),
  );
  fixture.spaces.set("space-pub", null);
  assert.equal((await fixture.service.serveViewerPage(page.publicationId)).state, "not-available", "an unregistered Space stops serving");
  fixture.spaces.set("space-pub", fixture.spaceRoot);

  await writeFile(join(fixture.spaceRoot, "beyond.txt"), "outside bytes");
  const escape = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "linked.txt", title: "Linked" },
    context("req-linked"),
  ).catch(() => null);
  assert.equal(escape, null, "a missing source cannot be designated");
  await symlink(join(fixture.spaceRoot, "beyond.txt"), join(fixture.spaceRoot, "linked.txt"));
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "linked.txt", title: "Linked" }, context("req-symlink")),
    isRefusal("SOURCE_INVALID"),
    "a symbolic link never binds as a source",
  );

  await writeFile(join(fixture.spaceRoot, "vanishing.md"), "# soon gone");
  const vanishing = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "vanishing.md", title: "Vanishing" },
    context("req-vanishing"),
  );
  const { rm } = await import("node:fs/promises");
  await rm(join(fixture.spaceRoot, "vanishing.md"));
  assert.equal((await fixture.service.serveViewerPage(vanishing.publicationId)).state, "not-available", "a moved or deleted source is vaguely unavailable to viewers");
});

test("revocation is desktop-first, idempotent, and its bridge cleanup is named and re-driven", async () => {
  const fixture = await publicationFixture();
  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Shared" },
    context("req-share"),
  );
  assert.equal((await fixture.service.activePublicationsForSpace("space-pub")).length, 1, "active publications block Space removal");

  fixture.bridge.offline = true;
  const revoked = await fixture.service.revoke(view.publicationId, context("req-revoke"));
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.bridgeCleanup, "pending");
  assert.match(fixture.receipts.entries.at(-1)!.detail!, /bridgeCleanup=pending/, "unconfirmed relay cleanup is named in the receipt");
  assert.deepEqual(await fixture.service.serveViewerPage(view.publicationId), {
    state: "nothing-here",
    publicationId: view.publicationId,
  }, "the effect-time recheck refuses from the instant local authority dies, regardless of bridge state");
  assert.deepEqual(await fixture.service.activePublicationsForSpace("space-pub"), []);

  const again = await fixture.service.revoke(view.publicationId, context("req-revoke-again"));
  assert.equal(again.state, "revoked");
  assert.match(fixture.receipts.entries.at(-1)!.detail!, /alreadyRevoked=true/, "a second revoke is a no-op receipt");

  fixture.bridge.offline = false;
  assert.deepEqual(await fixture.service.redriveBridgeSync(), { confirmed: 1, pending: 0 });
  assert.equal((await fixture.service.get(view.publicationId))!.bridgeCleanup, "ok");
  assert.deepEqual(
    fixture.bridge.calls.map((call) => call.method).filter((method) => method !== "upsertSlot"),
    ["deleteSlot", "deleteSnapshot"],
  );
  assert.equal(fixture.keys.values.has(view.publicationId), false, "the key dies with confirmed cleanup");

  const events = await createWorkFoldGlanceViewerGrantReader({ stateRoot: fixture.stateRoot })();
  assert.deepEqual(events.map((event) => event.event), ["created", "revoked"]);
});

test("narrowing is a direct verb and widening is refused without a fresh decision", async () => {
  const fixture = await publicationFixture();
  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Budgeted", snapshotEnabled: true },
    context("req-budget"),
  );
  await assert.rejects(
    fixture.service.narrowBudgets(view.publicationId, { serveRatePerMinute: 120 }, context("req-widen")),
    isRefusal("WIDEN_REFUSED"),
  );
  assert.equal(
    fixture.receipts.entries.some((entry) => entry.requestId === "req-widen"),
    false,
    "a refused widening never reaches the journal",
  );

  const narrowed = await fixture.service.narrowBudgets(
    view.publicationId,
    { serveRatePerMinute: 10, byteBudgetPerDay: 1024 },
    context("req-narrow"),
  );
  assert.equal(narrowed.serveRatePerMinute, 10);
  assert.equal(narrowed.byteBudgetPerDay, 1024);
  assert.match(fixture.receipts.entries.at(-1)!.detail!, /serveRatePerMinute=60->10/);

  const snapshotOff = await fixture.service.disableSnapshot(view.publicationId, context("req-snapshot-off"));
  assert.equal(snapshotOff.snapshotEnabled, false);
  assert.match(fixture.receipts.entries.at(-1)!.detail!, /snapshotDeletion=confirmed/);
  const lastSync = fixture.bridge.calls.filter((call) => call.method === "upsertSlot").at(-1)!.input as { snapshotEnabled: boolean };
  assert.equal(lastSync.snapshotEnabled, false, "the slot sync deletes the relay's stored ciphertext");

  await fixture.service.revoke(view.publicationId, context("req-final-revoke"));
  await assert.rejects(
    fixture.service.narrowBudgets(view.publicationId, { serveRatePerMinute: 1 }, context("req-after-revoke")),
    isRefusal("ALREADY_REVOKED"),
  );
});

test("a damaged store fails closed for mutations, serves, and Space-removal checks without being overwritten", async () => {
  const base = await mkdtemp(join(tmpdir(), "work-fold-publications-damaged-"));
  const storePath = join(base, "fold", "publications.json");
  await mkdir(join(base, "fold"), { recursive: true });
  await writeFile(storePath, "{ not json");
  const service = await WorkFoldPublicationService.create({
    path: storePath,
    keys: memoryKeys(),
    receipts: receiptsRecorder(),
    bridge: bridgeRecorder(),
    resolveSpaceRoot: async () => null,
  });
  const status = service.status();
  assert.equal(status.damaged, true);
  assert.match(status.damageReason!, /not valid JSON/);
  await assert.rejects(
    service.activate({ spaceId: "s", relativePath: "a.md", title: "T" }, context("req-damaged")),
    isRefusal("STORE_DAMAGED"),
  );
  await assert.rejects(service.activePublicationsForSpace("s"), isRefusal("STORE_DAMAGED"));
  assert.equal((await service.serveViewerPage("publication-any")).state, "nothing-here");
  assert.deepEqual(await service.redriveBridgeSync(), { confirmed: 0, pending: 0 });
  assert.equal(await readFile(storePath, "utf8"), "{ not json", "damaged state is never overwritten");

  const future = join(base, "fold", "future.json");
  await writeFile(future, JSON.stringify({ schemaVersion: 99, publications: [] }));
  const futureService = await WorkFoldPublicationService.create({
    path: future,
    keys: memoryKeys(),
    receipts: receiptsRecorder(),
    bridge: bridgeRecorder(),
    resolveSpaceRoot: async () => null,
  });
  assert.match(futureService.status().damageReason!, /unsupported schema version/);
});

test("an offline activation seeds the relay snapshot when the redrive lane confirms the slot", async () => {
  const fixture = await publicationFixture();
  fixture.bridge.offline = true;
  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Sleepy page", snapshotEnabled: true },
    context("req-offline-snapshot"),
  );
  assert.equal(view.bridgeSlot, "pending");
  assert.deepEqual(fixture.bridge.calls, [], "an offline bridge sees nothing; the seed fails silently with the slot sync");

  fixture.bridge.offline = false;
  assert.deepEqual(await fixture.service.redriveBridgeSync(), { confirmed: 1, pending: 0 });
  assert.deepEqual(
    fixture.bridge.calls.map((call) => call.method),
    ["upsertSlot", "putSnapshot"],
    "the redrive completes the slot and seeds the opted-in snapshot",
  );
  const seeded = fixture.bridge.calls[1]!.input as Record<string, unknown>;
  assert.equal(seeded.publicationId, view.publicationId);
  assert.equal((await fixture.service.get(view.publicationId))!.counters, undefined, "the redrive seed is not counted as a serve");

  // A publication without the opt-in never seeds, on activation or redrive.
  const plain = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "notes.txt", title: "No copy" },
    context("req-no-snapshot"),
  );
  assert.equal(
    fixture.bridge.calls.filter((call) => call.method === "putSnapshot").length,
    1,
    "snapshot-off publications never push relay copies",
  );
  await fixture.service.revoke(plain.publicationId, context("req-no-snapshot-revoke"));
});

test("serves are counted as bounded tallies and a success clears the recorded health note", async () => {
  const fixture = await publicationFixture();
  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "notes.txt", title: "Tallied" },
    context("req-tally"),
  );
  assert.equal((await fixture.service.get(view.publicationId))!.counters, undefined);

  const first = await fixture.service.serveViewerPage(view.publicationId) as Extract<WorkFoldViewerPageServeResult, { state: "served" }>;
  fixture.clock.at += 30_000;
  const second = await fixture.service.serveViewerPage(view.publicationId) as Extract<WorkFoldViewerPageServeResult, { state: "served" }>;
  const counted = (await fixture.service.get(view.publicationId))!.counters!;
  assert.equal(counted.served, 2);
  assert.equal(counted.servedBytes, first.byteSize + second.byteSize);
  assert.equal(counted.lastServedAt, second.servedAt);
  const receiptText = JSON.stringify(fixture.receipts.entries);
  assert.doesNotMatch(receiptText, /serveViewerPage|servedBytes/, "serving is counted, never journaled");

  const { rm } = await import("node:fs/promises");
  await rm(join(fixture.spaceRoot, "notes.txt"));
  fixture.clock.at += 30_000;
  assert.equal((await fixture.service.serveViewerPage(view.publicationId)).state, "not-available");
  const problem = (await fixture.service.get(view.publicationId))!.lastProblem!;
  assert.equal(problem.state, "not-available");
  assert.match(problem.reason, /does not exist as a regular file/, "the publisher gets the precise reason the audience never sees");
  assert.equal(problem.at, fixture.clock.now().toISOString());

  // An unchanged problem is not rewritten: the note keeps its first timestamp.
  fixture.clock.at += 30_000;
  assert.equal((await fixture.service.serveViewerPage(view.publicationId)).state, "not-available");
  assert.equal((await fixture.service.get(view.publicationId))!.lastProblem!.at, problem.at);

  const glanceEvents = await createWorkFoldGlanceViewerGrantReader({ stateRoot: fixture.stateRoot })();
  const problemEvent = glanceEvents.find((event) => event.event === "not-available");
  assert.deepEqual(problemEvent, {
    publicationId: view.publicationId,
    event: "not-available",
    at: problem.at,
    spaceId: "space-pub",
    title: "Tallied",
    reason: problem.reason,
  }, "the glance reads the health note with the recorded title and reason");

  await writeFile(join(fixture.spaceRoot, "notes.txt"), "back again\n");
  fixture.clock.at += 30_000;
  assert.equal((await fixture.service.serveViewerPage(view.publicationId)).state, "served");
  const recovered = (await fixture.service.get(view.publicationId))!;
  assert.equal(recovered.lastProblem, undefined, "a successful serve clears the note");
  assert.equal(recovered.counters!.served, 3);
});

test("the relay's resting notice records a publisher-facing health note until the next serve", async () => {
  const fixture = await publicationFixture();
  const view = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Busy page" },
    context("req-resting"),
  );
  const receiptCountAfterActivation = fixture.receipts.entries.length;
  await fixture.service.noteViewerResting("publication-unknown", "byte-budget");
  assert.equal((await fixture.service.get(view.publicationId))!.lastProblem, undefined, "an unknown id is a no-op");

  await fixture.service.noteViewerResting(view.publicationId, "byte-budget");
  const resting = (await fixture.service.get(view.publicationId))!.lastProblem!;
  assert.equal(resting.state, "resting");
  assert.match(resting.reason, /daily byte budget/);
  const events = await createWorkFoldGlanceViewerGrantReader({ stateRoot: fixture.stateRoot })();
  assert.equal(events.find((event) => event.event === "resting")?.title, "Busy page");

  // A different budget replaces the note; a repeat of the same one does not.
  fixture.clock.at += 30_000;
  await fixture.service.noteViewerResting(view.publicationId, "serve-rate");
  const replaced = (await fixture.service.get(view.publicationId))!.lastProblem!;
  assert.match(replaced.reason, /serves-per-minute/);
  fixture.clock.at += 30_000;
  await fixture.service.noteViewerResting(view.publicationId, "serve-rate");
  assert.equal((await fixture.service.get(view.publicationId))!.lastProblem!.at, replaced.at);

  assert.equal((await fixture.service.serveViewerPage(view.publicationId)).state, "served");
  assert.equal((await fixture.service.get(view.publicationId))!.lastProblem, undefined, "a served page is not resting");
  assert.equal(
    fixture.receipts.entries.length,
    receiptCountAfterActivation,
    "health notes and serves are bookkeeping, never receipted acts",
  );

  await fixture.service.revoke(view.publicationId, context("req-resting-revoke"));
  await fixture.service.noteViewerResting(view.publicationId, "byte-budget");
  assert.equal((await fixture.service.get(view.publicationId))!.lastProblem, undefined, "a revoked grant records no health notes");
});

test("the active cap bounds sharing and the inert markdown renderer strips active content", async () => {
  const fixture = await publicationFixture();
  for (let index = 0; index < WORKFOLD_PUBLICATION_ACTIVE_CAP; index += 1) {
    await writeFile(join(fixture.spaceRoot, `page-${index}.md`), `# Page ${index}`);
    await fixture.service.activate(
      { spaceId: "space-pub", relativePath: `page-${index}.md`, title: `Page ${index}` },
      context(`req-cap-${index}`),
    );
  }
  await assert.rejects(
    fixture.service.activate({ spaceId: "space-pub", relativePath: "report.md", title: "Over" }, context("req-cap-over")),
    isRefusal("PUBLICATION_CAP"),
  );

  const rendered = renderInertMarkdown("[ok](https://example.com/a) [bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>");
  assert.match(rendered, /href="https:\/\/example\.com\/a" target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(rendered, /href="javascript:/, "an unsafe link survives only as escaped literal text");
  assert.doesNotMatch(rendered, /<img/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// --- Rung 3: an app at your address (docs/fold-publishing.md) ---

interface HostedAppFixture {
  adapter: ReturnType<typeof createRestrictedAppViewerAdapter>;
  storage: FileRestrictedAppStorage;
  owner: RestrictedAppStorageOwner;
  releaseDigest: string;
  appInstanceId: string;
  /** Mutable seams: tests flip these to simulate updates and uninstalls. */
  state: { installed: boolean; releaseDigest: string; mutateViewer: ((viewer: { entry: string; readable: string[] }) => void) | null };
}

/**
 * A real staged package, real byte re-hashing, and real storage behind the
 * real viewer adapter — the same enforcement stack the desktop wires, minus
 * Electron. The manifest declares viewer entry `viewer.html` and one
 * viewer-readable collection `public/`.
 */
async function hostedAppFixture(): Promise<HostedAppFixture> {
  const base = await mkdtemp(join(tmpdir(), "work-fold-viewer-app-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({
    name: "viewer-app-fixture",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }));
  await writeFile(join(sourceRoot, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "viewer-app-fixture",
    title: "Viewer app fixture",
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    ui: {},
    tools: [],
    permissions: { network: [], files: [], notifications: [] },
    automations: [],
    viewer: { entry: "viewer.html", readable: ["public/"] },
  }));
  await writeFile(join(sourceRoot, "index.html"), "<!doctype html><main>desktop ui</main>");
  await writeFile(join(sourceRoot, "viewer.html"), "<!doctype html><main>viewer surface</main>");
  await writeFile(join(sourceRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
  const receipt = await stageRestrictedAppPackage(sourceRoot, join(base, "staged"));

  const storage = new FileRestrictedAppStorage(join(base, "app-data"));
  const owner: RestrictedAppStorageOwner = {
    ownerClass: "instance",
    tenantId: createTenantId(),
    runtimeInstanceId: createRuntimeInstanceId(),
    featureInstallationId: createFeatureInstallationId(),
    dataNamespaceId: createDataNamespaceId(),
  };
  await storage.set(owner, "public/greeting", "hello viewers");
  await storage.set(owner, "public/count", 3);
  await storage.set(owner, "private/secret", "never");

  const releaseDigest = `sha256:${"a".repeat(64)}`;
  const state: HostedAppFixture["state"] = { installed: true, releaseDigest, mutateViewer: null };
  const adapter = createRestrictedAppViewerAdapter({
    resolveInstance: async (appInstanceId) => {
      if (!state.installed || appInstanceId !== owner.featureInstallationId) return null;
      const manifest = structuredClone(receipt.manifest);
      if (state.mutateViewer && manifest.viewer) state.mutateViewer(manifest.viewer);
      const projection: RestrictedAppViewerInstanceProjection = {
        spaceId: "space-pub",
        packageName: receipt.packageName,
        version: receipt.version,
        digest: receipt.digest,
        artifactDigest: receipt.artifactDigest,
        releaseDigest: state.releaseDigest,
        runtimeInstanceKind: "app",
        manifest,
        tenantId: owner.tenantId,
        runtimeInstanceId: owner.runtimeInstanceId,
        featureInstallationId: owner.featureInstallationId,
        dataNamespaceId: owner.dataNamespaceId,
        fileCount: receipt.fileCount,
        totalBytes: receipt.totalBytes,
        stagedRoot: receipt.stagedRoot,
      };
      return projection;
    },
    storage,
  });
  return { adapter, storage, owner, releaseDigest, appInstanceId: owner.featureInstallationId, state };
}

function decryptServedApp(
  keyBase64Url: string,
  call: unknown,
  served: Extract<WorkFoldViewerAppServeResult, { state: "served" }>,
): { v: 1; ok: boolean; result?: unknown; code?: string; message?: string } {
  const key = Buffer.from(keyBase64Url, "base64url");
  const bytes = Buffer.from(served.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(served.iv, "base64url"));
  const fingerprint = workFoldViewerAppCallFingerprint(call);
  assert.ok(fingerprint !== null);
  decipher.setAAD(workFoldViewerAppAad(served.publicationId, fingerprint, served.contentDigest, served.servedAt));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8")) as never;
}

test("hosted-app exposure activates with the consecrated pins and serves the viewer-safe subset", async () => {
  const app = await hostedAppFixture();
  const fixture = await publicationFixture({ apps: app.adapter });

  const exposure = await app.adapter.resolveExposure(app.appInstanceId);
  assert.ok(exposure.eligible);
  assert.deepEqual(exposure.pins.viewerSurface, ["entry:viewer.html", "data:public/"]);

  const view = await fixture.service.activateApp({
    spaceId: exposure.spaceId,
    title: exposure.title,
    app: { ...exposure.pins },
  }, context("req-app-1"));
  assert.equal(view.kind, "app");
  assert.equal(view.snapshotEnabled, false, "snapshot caching does not exist for apps");
  assert.equal(view.viewerPath, `/a/${view.publicationId}`);
  assert.deepEqual(view.app, { ...exposure.pins });
  const activation = fixture.receipts.entries.filter((entry) => entry.command === "pages activate-app");
  assert.deepEqual(activation.map((entry) => entry.outcome), ["accepted", "ok"]);
  assert.match(String(activation[1]!.detail), /viewerSurface=entry:viewer\.html,data:public\//);
  const slotSync = fixture.bridge.calls.find((call) => call.method === "upsertSlot");
  assert.equal((slotSync!.input as { kind: string }).kind, "app", "the bridge slot carries kind app");

  // The entry and staged assets serve exact bytes; the shell decrypts under
  // the call-bound AAD with only the link key.
  const key = fixture.keys.values.get(view.publicationId)!;
  const entryCall = { kind: "entry" };
  const entry = await fixture.service.serveViewerAppCall(view.publicationId, entryCall);
  assert.equal(entry.state, "served");
  const entryPayload = decryptServedApp(key, entryCall, entry as Extract<WorkFoldViewerAppServeResult, { state: "served" }>);
  assert.equal(entryPayload.ok, true);
  const entryResult = entryPayload.result as { kind: string; mediaType: string; bytes: string };
  assert.equal(entryResult.kind, "entry");
  assert.equal(Buffer.from(entryResult.bytes, "base64url").toString("utf8"), "<!doctype html><main>viewer surface</main>");

  const assetCall = { kind: "asset", path: "logo.png" };
  const asset = await fixture.service.serveViewerAppCall(view.publicationId, assetCall);
  assert.equal(asset.state, "served");
  const assetPayload = decryptServedApp(key, assetCall, asset as Extract<WorkFoldViewerAppServeResult, { state: "served" }>);
  assert.equal(assetPayload.ok, true);
  assert.equal((assetPayload.result as { mediaType: string }).mediaType, "image/png");

  // Data reads: only manifest-marked viewer-readable prefixes, instance-owned.
  const getCall = { kind: "data.get", key: "public/greeting" };
  const got = decryptServedApp(key, getCall, await fixture.service.serveViewerAppCall(view.publicationId, getCall) as never);
  assert.deepEqual(got, { v: 1, ok: true, result: { kind: "data.get", key: "public/greeting", present: true, value: "hello viewers" } });
  const keysCall = { kind: "data.keys" };
  const keys = decryptServedApp(key, keysCall, await fixture.service.serveViewerAppCall(view.publicationId, keysCall) as never);
  assert.deepEqual((keys.result as { keys: string[] }).keys, ["public/count", "public/greeting"], "keys outside viewer-readable prefixes are never listed");

  // Serving is counted, never journaled per-request.
  assert.equal(fixture.receipts.entries.filter((entry) => entry.command.startsWith("pages")).length, 2);
  assert.ok(((await fixture.service.get(view.publicationId))!.counters?.served ?? 0) >= 4);
});

test("the viewer-safe broker subset refuses everything else with typed viewer-visible denials", async () => {
  const app = await hostedAppFixture();
  const fixture = await publicationFixture({ apps: app.adapter });
  const exposure = await app.adapter.resolveExposure(app.appInstanceId);
  assert.ok(exposure.eligible);
  const view = await fixture.service.activateApp(
    { spaceId: exposure.spaceId, title: exposure.title, app: { ...exposure.pins } },
    context("req-app-deny"),
  );
  const key = fixture.keys.values.get(view.publicationId)!;
  const denied = async (call: unknown, expectation: RegExp) => {
    const served = await fixture.service.serveViewerAppCall(view.publicationId, call);
    assert.equal(served.state, "served", "denials are viewer-visible typed payloads, not vague page states");
    const payload = decryptServedApp(key, call, served as Extract<WorkFoldViewerAppServeResult, { state: "served" }>);
    assert.equal(payload.ok, false);
    assert.match(String(payload.message), expectation);
    return payload;
  };

  // The doc's never-rows: writes, actions, egress, connections/credentials,
  // files, notifications, automations, OAuth, host UI — plus unknown kinds.
  await denied({ kind: "data.set", key: "public/greeting", value: "hacked" }, /Viewers mutate nothing/);
  await denied({ kind: "storage.clear" }, /Viewers mutate nothing/);
  await denied({ kind: "action", action: "send-mail" }, /person's runtime/);
  await denied({ kind: "invoke", tool: "inbox_search" }, /person's runtime/);
  await denied({ kind: "network.request", destinationId: "api" }, /network egress is not viewer-reachable/);
  await denied({ kind: "fetch", url: "https://example.com" }, /network egress is not viewer-reachable/);
  await denied({ kind: "connections.list" }, /saved credential/);
  await denied({ kind: "oauth.start" }, /saved credential/);
  await denied({ kind: "files.read", grantId: "exports" }, /person's own use of the app/);
  await denied({ kind: "notifications.show" }, /Notifications are not viewer-reachable/);
  await denied({ kind: "automation.run" }, /Viewers cannot run, schedule, or observe jobs/);
  await denied({ kind: "tabs.open" }, /outside the desktop shell/);
  await denied({ kind: "something.new" }, /not viewer-reachable/);
  await denied("not an object", /typed objects/);

  // Reads outside the reviewed viewer surface refuse without reading.
  await denied({ kind: "data.get", key: "private/secret" }, /outside the app's viewer-readable collections/);
  const missing = await denied({ kind: "asset", path: "../escape" }, /No packaged file has this path/);
  assert.equal(missing.code, "not-found");
  await denied({ kind: "asset", path: "missing.js" }, /No packaged file has this path/);

  assert.equal((await fixture.service.get(view.publicationId))!.lastProblem, undefined, "typed denials are serves, not publisher problems");
});

test("hosted-app serves recheck the grant, the surface, and the kind at effect time", async () => {
  const app = await hostedAppFixture();
  const fixture = await publicationFixture({ apps: app.adapter });
  const exposure = await app.adapter.resolveExposure(app.appInstanceId);
  assert.ok(exposure.eligible);
  const view = await fixture.service.activateApp(
    { spaceId: exposure.spaceId, title: exposure.title, app: { ...exposure.pins } },
    context("req-app-recheck"),
  );

  // A page-route serve of an app slot, and an app serve of a page slot, are
  // both nothing-here: the kinds never blur.
  assert.deepEqual(await fixture.service.serveViewerPage(view.publicationId), { state: "nothing-here", publicationId: view.publicationId });
  const page = await fixture.service.activate(
    { spaceId: "space-pub", relativePath: "report.md", title: "Beside" },
    context("req-app-page"),
  );
  assert.deepEqual(
    await fixture.service.serveViewerAppCall(page.publicationId, { kind: "entry" }),
    { state: "nothing-here", publicationId: page.publicationId },
  );

  // An unchanged-surface update (digest drift alone) keeps serving.
  app.state.releaseDigest = `sha256:${"b".repeat(64)}`;
  assert.equal((await fixture.service.serveViewerAppCall(view.publicationId, { kind: "entry" })).state, "served");

  // A widened or moved viewer surface stops serving until a fresh
  // consecration; the audience sees the vague state, the publisher the reason.
  app.state.mutateViewer = (viewer) => viewer.readable.push("private/");
  assert.equal((await fixture.service.serveViewerAppCall(view.publicationId, { kind: "entry" })).state, "not-available");
  assert.match((await fixture.service.get(view.publicationId))!.lastProblem!.reason, /viewer surface changed after approval/);
  app.state.mutateViewer = null;

  // An uninstalled instance is a publisher problem, not an audience detail.
  app.state.installed = false;
  assert.equal((await fixture.service.serveViewerAppCall(view.publicationId, { kind: "entry" })).state, "not-available");
  assert.match((await fixture.service.get(view.publicationId))!.lastProblem!.reason, /no longer installed/);
  app.state.installed = true;
  app.state.releaseDigest = app.releaseDigest;

  // Revocation is desktop-first and immediate for app slots too, and the
  // Space-removal block names active app exposures.
  assert.equal((await fixture.service.activePublicationsForSpace("space-pub")).length, 2);
  await fixture.service.revoke(view.publicationId, context("req-app-revoke"));
  assert.deepEqual(await fixture.service.serveViewerAppCall(view.publicationId, { kind: "entry" }), {
    state: "nothing-here",
    publicationId: view.publicationId,
  });
  assert.deepEqual(
    (await fixture.service.activePublicationsForSpace("space-pub")).map((item) => item.publicationId),
    [page.publicationId],
  );

  // Re-exposing after revocation is a fresh slot: the same instance can be
  // activated again only once the prior exposure is gone.
  const second = await fixture.service.activateApp(
    { spaceId: exposure.spaceId, title: exposure.title, app: { ...exposure.pins } },
    context("req-app-again"),
  );
  assert.notEqual(second.publicationId, view.publicationId);
  await assert.rejects(
    fixture.service.activateApp(
      { spaceId: exposure.spaceId, title: exposure.title, app: { ...exposure.pins } },
      context("req-app-dup"),
    ),
    isRefusal("INPUT_INVALID"),
    "one App Instance holds at most one active exposure",
  );
});
