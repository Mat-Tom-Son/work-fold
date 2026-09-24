import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import type { WorkFoldPublicationBridgeSync } from "../src/local/publications.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import {
  workFoldPublicationHealth,
  workFoldPublicationHealthWithConnection,
} from "../src/shared/publications.js";

/**
 * Settings → Shared pages over the running local API
 * (docs/fold-publishing.md, plan item 5): the renderer-session routes list
 * grant records with budgets, tallies, and health notes; the reveal route
 * composes the secret link fragment transiently; and the narrowing verbs —
 * revoke, budget cuts, snapshot off — are direct receipted acts with a
 * per-request id and the main-window surface. Sharing from a file tab and
 * widening in place (amended 2026-09-24) run the act lane's domain paths
 * under the Settings act wrapper.
 */

/** A recording relay fake: an enrolled address unless told otherwise. */
function recordingRelay(options: { address?: boolean; reachable?: boolean } = {}): WorkFoldPublicationBridgeSync & {
  upserts: Array<{ publicationId: string; serveRatePerMinute: number; byteBudgetPerDay: number; snapshotEnabled: boolean }>;
  snapshots: string[];
} {
  const upserts: Array<{ publicationId: string; serveRatePerMinute: number; byteBudgetPerDay: number; snapshotEnabled: boolean }> = [];
  const snapshots: string[] = [];
  return {
    upserts,
    snapshots,
    async upsertSlot(input) {
      if (options.reachable === false) throw new Error("relay unreachable");
      upserts.push({
        publicationId: input.publicationId,
        serveRatePerMinute: input.serveRatePerMinute,
        byteBudgetPerDay: input.byteBudgetPerDay,
        snapshotEnabled: input.snapshotEnabled,
      });
    },
    async deleteSlot() {},
    async putSnapshot(input) { snapshots.push(input.publicationId); },
    async deleteSnapshot() {},
    async addressConfigured() { return options.address !== false; },
  };
}

async function withApi(
  run: (context: { api: LocalApiHandle; sandbox: string; stateBase: string }) => Promise<void>,
  options: { publicationBridge?: WorkFoldPublicationBridgeSync | null } = {},
): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-publication-settings-test-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    ...(options.publicationBridge !== undefined ? { publicationBridge: options.publicationBridge } : {}),
  });
  try {
    await run({ api, sandbox, stateBase });
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

test("the publication Settings routes list, reveal transiently, narrow, and revoke as receipted main-window acts", async (t) => {
  await withApi(async ({ api, stateBase }) => {
    const space = await api.actFacade.createSpace({ name: "Page Space" });
    await writeFile(join(space.space.spaceRoot, "report.md"), "# Shared report\n");

    const empty = await getJson(api.origin, "/api/settings/publications");
    assert.deepEqual(empty.publications, []);
    assert.equal((empty.status as { damaged: boolean }).damaged, false);

    // Activation is the share act's execution path; the Settings surface
    // never creates exposure. Drive the service directly, as the prepared-act
    // adapter does.
    const view = await api.publications.activate(
      { spaceId: space.space.id, relativePath: "report.md", title: "Quarterly report", snapshotEnabled: true },
      { requestId: "req-settings-activate", surface: "main-window" },
    );

    const listed = await getJson(api.origin, "/api/settings/publications");
    const publications = listed.publications as Array<Record<string, unknown>>;
    assert.equal(publications.length, 1);
    assert.equal(publications[0]!.publicationId, view.publicationId);
    assert.equal(publications[0]!.title, "Quarterly report");
    assert.equal(publications[0]!.spaceName, "Page Space", "the list resolves the registered Space name");
    assert.equal(publications[0]!.snapshotEnabled, true);
    assert.equal(publications[0]!.viewerPath, `/p/${view.publicationId}`);
    assert.equal("key" in publications[0]!, false, "the list never carries key material");

    // The reveal is on demand and transient: the fragment key comes from the
    // key store, matches what the serve path encrypts under, and never
    // appears in the receipts journal.
    const revealed = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/reveal-link`, {});
    assert.equal(revealed.status, 200);
    const link = revealed.body as { viewerPath: string; key: string };
    assert.equal(link.viewerPath, `/p/${view.publicationId}`);
    assert.match(link.key, /^[A-Za-z0-9_-]{43}$/, "a 32-byte base64url page key");

    const narrowRefused = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/narrow`, {
      serveRatePerMinute: 500,
    });
    assert.equal(narrowRefused.status, 400);
    assert.equal((narrowRefused.body as { code?: string }).code, "WIDEN_REFUSED", "raising a budget has no Settings path");

    const narrowed = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/narrow`, {
      serveRatePerMinute: 12,
      byteBudgetPerDay: 5 * 1024 * 1024,
    });
    assert.equal(narrowed.status, 200);
    assert.equal((narrowed.body as { publication: { serveRatePerMinute: number } }).publication.serveRatePerMinute, 12);

    const snapshotOff = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/snapshot-off`, {});
    assert.equal(snapshotOff.status, 200);
    assert.equal((snapshotOff.body as { publication: { snapshotEnabled: boolean } }).publication.snapshotEnabled, false);

    const revoked = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/revoke`, {});
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body as { publication: { state: string } }).publication.state, "revoked");
    const afterRevoke = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/reveal-link`, {});
    assert.equal(afterRevoke.status, 404, "a revoked page has no link to reveal");
    assert.equal((await postJson(api.origin, "/api/settings/publications/publication-missing/revoke", {})).status, 404);

    // Every Settings mutation is a receipted act: accepted + terminal pairs,
    // minted per-request ids, main-window surface — and the key appears in
    // no journal line.
    const receiptsProbe = new WorkFoldCliActReceipts({ stateRoot: stateBase });
    const journal = (await readFile(receiptsProbe.path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const settingsActs = journal.filter((entry) => String(entry.requestId).startsWith("settings:"));
    assert.deepEqual(
      settingsActs.map((entry) => [entry.command, entry.outcome]),
      [
        ["pages narrow-budgets", "accepted"],
        ["pages narrow-budgets", "ok"],
        ["pages snapshot-off", "accepted"],
        ["pages snapshot-off", "ok"],
        ["pages revoke", "accepted"],
        ["pages revoke", "ok"],
      ],
      "each Settings act journals accepted then terminal under its own minted id",
    );
    for (const entry of settingsActs) assert.equal(entry.surface, "main-window");
    const requestIds = new Set(settingsActs.map((entry) => entry.requestId));
    assert.equal(requestIds.size, 3, "each act gets its own request id");
    assert.doesNotMatch(JSON.stringify(journal), new RegExp(link.key), "the link fragment never reaches the journal");

    await t.test("the reveal is refused when no active grant exists", async () => {
      const missing = await postJson(api.origin, "/api/settings/publications/publication-none/reveal-link", {});
      assert.equal(missing.status, 404);
    });
  });
});

function journalOf(stateBase: string): Promise<Array<Record<string, unknown>>> {
  const receiptsProbe = new WorkFoldCliActReceipts({ stateRoot: stateBase });
  return readFile(receiptsProbe.path, "utf8").then((text) => text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>));
}

test("sharing a file from its tab runs the pages share path under a Settings receipt", async () => {
  const relay = recordingRelay();
  await withApi(async ({ api, stateBase }) => {
    const space = await api.actFacade.createSpace({ name: "Tab Space" });
    await writeFile(join(space.space.spaceRoot, "notes.md"), "# Notes\n");
    await writeFile(join(space.space.spaceRoot, "tool.exe"), "bytes");

    const shared = await postJson(api.origin, "/api/settings/publications/share", {
      spaceId: space.space.id,
      path: "./notes.md",
      title: "notes",
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const body = shared.body as {
      publication: { publicationId: string; state: string; relativePath: string; title: string; spaceName: string; live: boolean; health: { state: string }; viewerPath: string };
      revealable: boolean;
    };
    assert.equal(body.publication.state, "active");
    assert.equal(body.publication.relativePath, "notes.md", "the pins carry the normalized relative path");
    assert.equal(body.publication.title, "notes");
    assert.equal(body.publication.spaceName, "Tab Space");
    assert.equal(body.publication.live, true, "the relay confirmed the slot");
    assert.equal(body.publication.health.state, "live");
    assert.equal(body.revealable, true, "a fresh page's key is in secure settings");
    assert.equal("key" in body.publication, false, "the share answer never carries key material");
    assert.equal(relay.upserts.length, 1);

    // The Settings wrapper and the activation each journal an accepted and a
    // terminal line under one minted id family, surface main-window.
    const journal = await journalOf(stateBase);
    const share = journal.filter((entry) => entry.command === "pages.share");
    assert.deepEqual(share.map((entry) => entry.outcome), ["accepted", "ok"]);
    assert.match(String(share[0]!.requestId), /^settings:/);
    assert.equal(share[0]!.surface, "main-window");
    const activation = journal.filter((entry) => entry.command === "pages activate");
    assert.deepEqual(activation.map((entry) => entry.outcome), ["accepted", "ok"]);
    assert.equal(activation[0]!.requestId, `${share[0]!.requestId}:activate`);
    assert.equal(activation[0]!.surface, "main-window");

    // Already shared: the same refusal as the act lane, receipted as an error.
    const again = await postJson(api.origin, "/api/settings/publications/share", { spaceId: space.space.id, path: "notes.md", title: "notes" });
    assert.equal(again.status, 409);
    assert.match((again.body as { error: string }).error, /already shared/);
    const afterAgain = (await journalOf(stateBase)).filter((entry) => entry.command === "pages.share");
    assert.deepEqual(afterAgain.map((entry) => entry.outcome), ["accepted", "ok", "accepted", "error"]);

    // Same source rules as the act lane.
    const badType = await postJson(api.origin, "/api/settings/publications/share", { spaceId: space.space.id, path: "tool.exe", title: "tool" });
    assert.equal(badType.status, 400);
    const missing = await postJson(api.origin, "/api/settings/publications/share", { spaceId: space.space.id, path: "ghost.md", title: "ghost" });
    assert.equal(missing.status, 404);
    const unregistered = await postJson(api.origin, "/api/settings/publications/share", { spaceId: "space-none", path: "notes.md", title: "notes" });
    assert.equal(unregistered.status, 404);
    const longTitle = await postJson(api.origin, "/api/settings/publications/share", { spaceId: space.space.id, path: "notes.md", title: "x".repeat(81) });
    assert.equal(longTitle.status, 400);
    assert.equal((await api.publications.list()).length, 1);
  }, { publicationBridge: relay });
});

test("a share with no address fails up front on both surfaces and leaves nothing behind", async () => {
  for (const publicationBridge of [null, recordingRelay({ address: false })]) {
    await withApi(async ({ api, stateBase }) => {
      const space = await api.actFacade.createSpace({ name: "No Address" });
      await writeFile(join(space.space.spaceRoot, "notes.md"), "# Notes\n");

      const refused = await postJson(api.origin, "/api/settings/publications/share", { spaceId: space.space.id, path: "notes.md", title: "notes" });
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.body, { error: "Set up web access before sharing a page.", code: "NO_ADDRESS" });

      await assert.rejects(
        () => api.actFacade.pagesShare({ space: space.space.id, path: "notes.md", title: "notes", requestId: "req-no-address" }),
        (error: unknown) => error instanceof WorkFoldCliError && error.code === "conflict"
          && error.message === "Set up web access before sharing a page.",
      );
      assert.deepEqual(await api.publications.list(), [], "no slot exists for a page nobody can reach");
      const journal = await journalOf(stateBase);
      assert.equal(journal.some((entry) => entry.command === "pages activate"), false);
      assert.deepEqual(journal.filter((entry) => entry.command === "pages.share").map((entry) => entry.outcome), ["accepted", "error"]);
    }, { publicationBridge });
  }
});

test("an enrolled address with an unreachable relay still shares and stays honestly asleep", async () => {
  await withApi(async ({ api }) => {
    const space = await api.actFacade.createSpace({ name: "Offline Relay" });
    await writeFile(join(space.space.spaceRoot, "notes.md"), "# Notes\n");
    const shared = await postJson(api.origin, "/api/settings/publications/share", { spaceId: space.space.id, path: "notes.md", title: "notes" });
    assert.equal(shared.status, 200);
    const publication = (shared.body as { publication: { live: boolean; bridgeSlot: string; health: { state: string; reason: string } } }).publication;
    assert.equal(publication.live, false);
    assert.equal(publication.bridgeSlot, "pending");
    assert.deepEqual(publication.health, { state: "asleep", reason: "The relay has not confirmed this page yet." });
  }, { publicationBridge: recordingRelay({ reachable: false }) });
});

test("widening in place raises budgets and turns the sleep copy on under a receipt, capped at the ceilings", async () => {
  const relay = recordingRelay();
  await withApi(async ({ api, stateBase }) => {
    const space = await api.actFacade.createSpace({ name: "Widen Space" });
    await writeFile(join(space.space.spaceRoot, "report.md"), "# Report\n");
    const view = await api.publications.activate(
      { spaceId: space.space.id, relativePath: "report.md", title: "Report" },
      { requestId: "req-widen-activate", surface: "main-window" },
    );
    const keyBefore = (await postJson(api.origin, `/api/settings/publications/${view.publicationId}/reveal-link`, {})).body as { key: string; viewerPath: string };

    const widened = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/widen`, {
      serveRatePerMinute: 600,
      byteBudgetPerDay: 1024 * 1024 * 1024,
      snapshotEnabled: true,
    });
    assert.equal(widened.status, 200, JSON.stringify(widened.body));
    const publication = (widened.body as { publication: { publicationId: string; serveRatePerMinute: number; byteBudgetPerDay: number; snapshotEnabled: boolean; viewerPath: string } }).publication;
    assert.equal(publication.publicationId, view.publicationId, "the slot is unchanged");
    assert.equal(publication.viewerPath, view.viewerPath);
    assert.equal(publication.serveRatePerMinute, 600);
    assert.equal(publication.byteBudgetPerDay, 1024 * 1024 * 1024);
    assert.equal(publication.snapshotEnabled, true);
    assert.deepEqual(relay.upserts.at(-1), {
      publicationId: view.publicationId,
      serveRatePerMinute: 600,
      byteBudgetPerDay: 1024 * 1024 * 1024,
      snapshotEnabled: true,
    }, "the relay slot is updated in place with the wider values");
    assert.ok(relay.snapshots.includes(view.publicationId), "turning the sleep copy on seeds the relay copy");
    const keyAfter = (await postJson(api.origin, `/api/settings/publications/${view.publicationId}/reveal-link`, {})).body as { key: string };
    assert.equal(keyAfter.key, keyBefore.key, "the key — and so the link — is unchanged");

    // Over the ceilings, lower than current, turning the copy off here, or
    // naming nothing: refused without touching the slot.
    for (const [body, pattern] of [
      [{ serveRatePerMinute: 601 }, /from 1 through 600/],
      [{ byteBudgetPerDay: 1024 * 1024 * 1024 + 1 }, /from 1 through 1073741824/],
      [{ serveRatePerMinute: 10 }, /use pages narrow/],
      [{ snapshotEnabled: false }, /snapshot-off/],
      [{}, /Name a serve rate/],
    ] as const) {
      const refused = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/widen`, body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.match((refused.body as { error: string }).error, pattern);
    }
    assert.equal((await api.publications.get(view.publicationId))?.serveRatePerMinute, 600);

    // Receipts: the Settings wrapper and the service journal the widening
    // under one minted id, surface main-window, naming old and new values.
    const journal = await journalOf(stateBase);
    const wrapper = journal.filter((entry) => entry.command === "pages.widen");
    assert.equal(wrapper[0]?.outcome, "accepted");
    assert.equal(wrapper[1]?.outcome, "ok");
    assert.equal(wrapper[0]?.surface, "main-window");
    const service = journal.filter((entry) => entry.command === "pages widen");
    assert.deepEqual(service.map((entry) => entry.outcome), ["accepted", "ok"], "refusals never reach the service journal as effects");
    assert.equal(service[0]?.requestId, wrapper[0]?.requestId);
    assert.match(String(service[1]?.detail), /serveRatePerMinute=60->600 byteBudgetPerDay=268435456->1073741824 snapshot=off->on bridgeSync=confirmed/);
    assert.doesNotMatch(JSON.stringify(journal), new RegExp(keyBefore.key), "the link fragment never reaches the journal");

    // A stopped page cannot be widened.
    await postJson(api.origin, `/api/settings/publications/${view.publicationId}/revoke`, {});
    const afterRevoke = await postJson(api.origin, `/api/settings/publications/${view.publicationId}/widen`, { serveRatePerMinute: 600 });
    assert.equal(afterRevoke.status, 409);
  }, { publicationBridge: relay });
});

test("the page state word derives from the record, then the desktop's relay connection", () => {
  const live = workFoldPublicationHealth({ state: "active", bridgeSlot: "confirmed" });
  assert.deepEqual(live, { state: "live", reason: "Your desktop is serving this page." });
  assert.deepEqual(
    workFoldPublicationHealth({ state: "active", bridgeSlot: "pending" }),
    { state: "asleep", reason: "The relay has not confirmed this page yet." },
  );
  assert.deepEqual(
    workFoldPublicationHealth({ state: "active", bridgeSlot: "confirmed", lastProblem: { state: "resting", reason: "its daily byte budget at the relay is used up" } }),
    { state: "resting", reason: "This page's daily byte budget at the relay is used up." },
  );
  assert.deepEqual(
    workFoldPublicationHealth({ state: "active", bridgeSlot: "pending", lastProblem: { state: "not-available", reason: "The designated file does not exist as a regular file." } }),
    { state: "not-available", reason: "The designated file does not exist as a regular file." },
    "a page problem outranks an unconfirmed slot",
  );
  assert.deepEqual(
    workFoldPublicationHealth({ state: "revoked", bridgeSlot: "confirmed", bridgeCleanup: "pending", lastProblem: { state: "resting", reason: "x" } }),
    { state: "stopped", reason: "You stopped sharing this page. The relay is still removing it." },
  );
  assert.equal(workFoldPublicationHealth({ state: "expired", bridgeSlot: "confirmed" }).state, "stopped");

  const connected = { configured: true, enabled: true, connection: "connected" as const };
  assert.deepEqual(workFoldPublicationHealthWithConnection(live, connected), live);
  assert.deepEqual(workFoldPublicationHealthWithConnection(live, null), live, "no desktop status leaves the record's word");
  assert.deepEqual(workFoldPublicationHealthWithConnection(live, { ...connected, connection: "error" }), { state: "asleep", reason: "Your desktop cannot reach the relay." });
  assert.deepEqual(workFoldPublicationHealthWithConnection(live, { ...connected, connection: "connecting" }), { state: "asleep", reason: "Your desktop is not connected to the relay." });
  assert.deepEqual(workFoldPublicationHealthWithConnection(live, { ...connected, enabled: false }), { state: "asleep", reason: "Web access is turned off." });
  const resting = workFoldPublicationHealth({ state: "active", bridgeSlot: "confirmed", lastProblem: { state: "resting", reason: "it hit its serves-per-minute budget at the relay" } });
  assert.deepEqual(workFoldPublicationHealthWithConnection(resting, { ...connected, connection: "error" }), resting, "a page problem keeps its own word");
});

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200, `${path} must answer 200`);
  return await response.json() as Record<string, unknown>;
}

async function postJson(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
