import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * Settings → The fold → Pages your fold serves over the running local API
 * (docs/fold-publishing.md, plan item 5): the renderer-session routes list
 * grant records with budgets, tallies, and health notes; the reveal route
 * composes the secret link fragment transiently; and the narrowing verbs —
 * revoke, budget cuts, snapshot off — are direct receipted acts with a
 * per-request id and the main-window surface. Widening has no route at all.
 */

async function withApi(
  run: (context: { api: LocalApiHandle; sandbox: string; stateBase: string }) => Promise<void>,
): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-publication-settings-test-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
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

    // Activation is the consecration's execution path; the Settings surface
    // never creates exposure. Drive the service directly as the approved
    // decision adapter does.
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
