import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";

import {
  BridgeDatabase,
  BridgeDatabaseError,
  assertSlug,
  isReservedViewerSlug,
  isValidSlug,
  publicationWindowServedBytes,
} from "./database.mjs";

test("single-grant revocation cannot mutate another account", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const accountA = await insertAccount(pool, "account-a");
  const accountB = await insertAccount(pool, "account-b");
  await insertGrant(pool, accountA.id, "grant-a");
  await insertGrant(pool, accountB.id, "grant-b");
  const sessionA = await createBoundSession(database, pool, accountA, "grant-a");
  const sessionB = await createBoundSession(database, pool, accountB, "grant-b");
  await insertOperation(pool, {
    id: "operation-a",
    accountId: accountA.id,
    grantId: "grant-a",
    requestId: "request-a",
    state: "running",
  });
  await insertOperation(pool, {
    id: "operation-b",
    accountId: accountB.id,
    grantId: "grant-b",
    requestId: "request-b",
    state: "running",
  });

  assert.equal(await database.revokeGrant(accountA.id, "grant-b"), false);
  assert.deepEqual(await grantAndOperationState(pool, "grant-b", "operation-b"), {
    grant: "approved",
    operation: "running",
  });
  assert.equal(await sessionExists(pool, sessionB.id), true);

  assert.equal(await database.revokeGrant(accountB.id, "grant-b"), true);
  assert.deepEqual(await grantAndOperationState(pool, "grant-b", "operation-b"), {
    grant: "revoked",
    operation: "lost",
  });
  assert.equal(await sessionExists(pool, sessionB.id), false);
  assert.deepEqual(await grantAndOperationState(pool, "grant-a", "operation-a"), {
    grant: "approved",
    operation: "running",
  });
  assert.equal(await sessionExists(pool, sessionA.id), true);
});

test("operation progress can repeat and reconnect-late results can leave lost", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const account = await insertAccount(pool, "operation-owner");
  const otherAccount = await insertAccount(pool, "operation-outsider");
  await insertGrant(pool, account.id, "operation-grant");

  await insertOperation(pool, {
    id: "repeated-progress",
    accountId: account.id,
    grantId: "operation-grant",
    requestId: "progress-request",
    state: "accepted",
  });
  assert.equal((await database.setOperationState(account.id, "repeated-progress", "running"))?.state, "running");
  const repeated = await database.setOperationState(account.id, "repeated-progress", "running");
  assert.equal(repeated?.state, "running");
  assert.equal(repeated?.browserGrantId, "operation-grant");
  assert.equal(repeated?.requestId, "progress-request");
  assert.equal(repeated?.generation, 1);

  for (const target of ["running", "done", "failed"]) {
    const operationId = `late-${target}`;
    await insertOperation(pool, {
      id: operationId,
      accountId: account.id,
      grantId: "operation-grant",
      requestId: `request-${target}`,
      state: "lost",
    });
    assert.equal(await database.operationForDevice(otherAccount.id, operationId), null);
    assert.equal(await database.setOperationState(otherAccount.id, operationId, target), null);
    const transitioned = await database.setOperationState(account.id, operationId, target);
    assert.equal(transitioned?.state, target);
    assert.equal(transitioned?.accountId, account.id);
    assert.equal(transitioned?.browserGrantId, "operation-grant");
    assert.equal(transitioned?.requestId, `request-${target}`);
    assert.equal(transitioned?.generation, 1);
  }
});

test("session CSRF issuance is stable across tabs", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const account = await insertAccount(pool, "csrf-account");
  const created = await database.createSession(account);
  const initial = await database.session(created.token, { touch: false });
  await assert.doesNotReject(database.assertCsrf(initial, created.csrfToken));

  const [tabTwoToken, tabThreeToken] = await Promise.all([
    database.issueSessionCsrf(created.token),
    database.issueSessionCsrf(created.token),
  ]);
  assert.equal(tabTwoToken, created.csrfToken);
  assert.equal(tabThreeToken, created.csrfToken);
  assert.equal(await database.rotateSessionCsrf(created.token), created.csrfToken, "the compatibility API no longer rotates");

  const sharedSession = await database.session(created.token, { touch: false });
  await assert.doesNotReject(database.assertCsrf(sharedSession, created.csrfToken));
  await assert.rejects(
    database.assertCsrf(sharedSession, "not-the-session-token"),
    (error) => error instanceof BridgeDatabaseError && error.code === "csrf",
  );
  assert.equal(await database.issueSessionCsrf("unknown-session-token"), null);
});

test("stable CSRF issuance preserves an already-open legacy tab", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const account = await insertAccount(pool, "legacy-csrf-account");
  const created = await database.createSession(account);
  const legacyCsrfToken = "legacy-random-csrf-token";
  await pool.query(
    "UPDATE bridge_sessions SET csrf_hash = $1, csrf_previous_hash = NULL WHERE id = $2",
    [sha256(legacyCsrfToken), created.id],
  );

  const beforeMigration = await database.session(created.token, { touch: false });
  await assert.doesNotReject(database.assertCsrf(beforeMigration, legacyCsrfToken));
  const stableToken = await database.issueSessionCsrf(created.token);
  assert.equal(stableToken, created.csrfToken);

  const migrated = await database.session(created.token, { touch: false });
  await assert.doesNotReject(database.assertCsrf(migrated, legacyCsrfToken));
  await assert.doesNotReject(database.assertCsrf(migrated, stableToken));
  assert.equal(await database.issueSessionCsrf(created.token), stableToken);
  const repeated = await database.session(created.token, { touch: false });
  await assert.doesNotReject(database.assertCsrf(repeated, legacyCsrfToken));
  assert.equal(repeated.csrfPreviousHash, sha256(legacyCsrfToken));
});

test("the viewer namespace is reserved by real prefix logic, not only exact slugs", async (context) => {
  const { database } = await databaseFixture(context);
  assert.equal(isValidSlug("pages"), false);
  assert.equal(isValidSlug("pages-anything"), false);
  assert.equal(isValidSlug("PAGES-Mixed"), false);
  assert.equal(isValidSlug("pagesmith"), true, "only the exact pages label and the pages- prefix are reserved");
  assert.equal(isReservedViewerSlug("pages"), true);
  assert.equal(isReservedViewerSlug("pages-a"), true);
  assert.equal(isReservedViewerSlug("pagesmith"), false);
  assert.equal(isReservedViewerSlug(undefined), false);
  assert.throws(
    () => assertSlug("pages-team"),
    (error) => error instanceof BridgeDatabaseError && error.code === "invalid_slug",
  );
  await assert.rejects(
    database.enroll({ slug: "pages-team", password: "a viewer namespace password" }),
    (error) => error instanceof BridgeDatabaseError && error.code === "invalid_slug",
    "enrollment rejects viewer-namespace addresses before any other validation",
  );
});

test("publication slots are content-free, account-scoped, and idempotent by operation id", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const owner = await insertAccount(pool, "publisher-a");
  const outsider = await insertAccount(pool, "publisher-b");
  const fields = Object.freeze({
    operationId: "operation-create-1",
    kind: "page",
    serveRatePerMinute: 30,
    byteBudgetPerDay: 64 * 1024 * 1024,
    snapshotEnabled: true,
  });

  const created = await database.upsertPublication(owner, "publication-1", fields);
  assert.equal(created.created, true);
  assert.equal(created.duplicate, false);
  assert.equal(created.state, "active");
  assert.equal(created.servedBytes, 0);

  const replayed = await database.upsertPublication(owner, "publication-1", fields);
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.created, false);

  await assert.rejects(
    database.upsertPublication(owner, "publication-1", { ...fields, serveRatePerMinute: 31 }),
    (error) => error instanceof BridgeDatabaseError && error.code === "request_conflict",
    "one operation id cannot carry two different mutations",
  );
  await assert.rejects(
    database.upsertPublication(outsider, "publication-1", { operationId: "operation-steal", kind: "page" }),
    (error) => error instanceof BridgeDatabaseError && error.code === "request_conflict",
    "another account cannot claim an existing slot id",
  );
  await assert.rejects(
    database.upsertPublication(outsider, "publication-other", { operationId: "operation-create-1", kind: "page" }),
    (error) => error instanceof BridgeDatabaseError && error.code === "request_conflict",
    "an operation id cannot be replayed onto a different slot",
  );

  const stored = await pool.query("SELECT * FROM bridge_publications WHERE id = 'publication-1'");
  assert.deepEqual(Object.keys(stored.rows[0]).sort(), [
    "account_id", "byte_budget_per_day", "created_at", "expires_at", "id", "kind",
    "operation_id", "serve_rate_per_minute", "served_bytes", "served_bytes_window_started_at",
    "snapshot_enabled", "state", "updated_at",
  ], "the slot schema stores identifiers, budgets, counters, and state — never titles, paths, or content");

  const updated = await database.upsertPublication(owner, "publication-1", {
    ...fields,
    operationId: "operation-update-1",
    serveRatePerMinute: 10,
    byteBudgetPerDay: 1024,
  });
  assert.equal(updated.created, false);
  assert.equal(updated.duplicate, false);
  assert.equal(updated.serveRatePerMinute, 10);
  assert.equal(updated.operationId, "operation-update-1");

  for (let index = 2; index <= 32; index += 1) {
    await database.upsertPublication(owner, `publication-${index}`, { operationId: `operation-fill-${index}`, kind: "page" });
  }
  await assert.rejects(
    database.upsertPublication(owner, "publication-33", { operationId: "operation-overflow", kind: "page" }),
    (error) => error instanceof BridgeDatabaseError && error.code === "publication_limit",
    "an address holds at most 32 publication slots",
  );

  const squatted = await insertAccount(pool, "pages-victim");
  const victim = await insertAccount(pool, "victim");
  await assert.rejects(
    database.upsertPublication(victim, "publication-contested", { operationId: "operation-contested", kind: "page" }),
    (error) => error instanceof BridgeDatabaseError && error.code === "publication_contested",
    "a legacy pages- account contests the viewer origin and publishing fails closed",
  );
  await assert.rejects(
    database.upsertPublication(squatted, "publication-squatted", { operationId: "operation-squatted", kind: "page" }),
    (error) => error instanceof BridgeDatabaseError && error.code === "publication_contested",
    "the squatting pages- account cannot publish either",
  );

  await database.putPublicationSnapshot(owner.id, "publication-1", {
    ciphertext: "A".repeat(64),
    iv: "AAAAAAAAAAAAAAAA",
    contentDigest: "sha256:cascade",
    capturedAt: new Date().toISOString(),
  });
  assert.equal(await database.deletePublication(outsider.id, "publication-1"), false, "deletion is account-scoped");
  assert.equal(await database.deletePublication(owner.id, "publication-1"), true);
  assert.equal(await database.deletePublication(owner.id, "publication-1"), false, "revocation is idempotent");
  const orphaned = await pool.query("SELECT publication_id FROM bridge_publication_snapshots WHERE publication_id = 'publication-1'");
  assert.equal(orphaned.rowCount, 0, "snapshot rows are deleted with their slot");

  const expiring = await database.upsertPublication(outsider, "publication-expiring", {
    operationId: "operation-expiring",
    kind: "page",
    snapshotEnabled: true,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(expiring.created, true);
  await database.putPublicationSnapshot(outsider.id, "publication-expiring", {
    ciphertext: "B".repeat(64),
    iv: "AAAAAAAAAAAAAAAA",
    contentDigest: "sha256:expiring",
    capturedAt: new Date().toISOString(),
  });
  await database.cleanup();
  const expired = await pool.query("SELECT id FROM bridge_publications WHERE id = 'publication-expiring'");
  assert.equal(expired.rowCount, 0, "expired slots are cleaned up");
  const expiredSnapshot = await pool.query("SELECT publication_id FROM bridge_publication_snapshots WHERE publication_id = 'publication-expiring'");
  assert.equal(expiredSnapshot.rowCount, 0);

  await database.removeAccount(owner.id);
  const survivors = await pool.query("SELECT COUNT(*)::int AS count FROM bridge_publications WHERE account_id = 'publisher-a'");
  assert.equal(Number(survivors.rows[0].count), 0, "publications die with their account");
});

test("publication snapshots are opt-in, bounded, and newest-wins by digest and timestamp", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const account = await insertAccount(pool, "snapshot-account");
  const other = await insertAccount(pool, "snapshot-outsider");
  const iv = "AAAAAAAAAAAAAAAA";
  const base = Date.parse("2026-08-10T12:00:00Z");
  const at = (offsetMs) => new Date(base + offsetMs).toISOString();

  await database.upsertPublication(account, "snapshot-off", { operationId: "operation-off", kind: "page", snapshotEnabled: false });
  await assert.rejects(
    database.putPublicationSnapshot(account.id, "snapshot-off", { ciphertext: "AAAA", iv, contentDigest: "sha256:off", capturedAt: at(0) }),
    (error) => error instanceof BridgeDatabaseError && error.code === "snapshot_disabled",
    "snapshots exist only for explicitly opted-in publications",
  );
  await assert.rejects(
    database.putPublicationSnapshot(account.id, "snapshot-missing", { ciphertext: "AAAA", iv, contentDigest: "sha256:missing", capturedAt: at(0) }),
    (error) => error instanceof BridgeDatabaseError && error.code === "not_found",
  );
  await database.upsertPublication(account, "snapshot-revoked", { operationId: "operation-revoked", kind: "page", state: "revoked", snapshotEnabled: true });
  await assert.rejects(
    database.putPublicationSnapshot(account.id, "snapshot-revoked", { ciphertext: "AAAA", iv, contentDigest: "sha256:revoked", capturedAt: at(0) }),
    (error) => error instanceof BridgeDatabaseError && error.code === "not_found",
    "a revoked slot is indistinguishable from a missing one",
  );

  await database.upsertPublication(account, "snapshot-on", { operationId: "operation-on", kind: "page", snapshotEnabled: true });
  const stored = await database.putPublicationSnapshot(account.id, "snapshot-on", {
    ciphertext: "A".repeat(128), iv, contentDigest: "sha256:one", capturedAt: at(0),
  });
  assert.equal(stored.stored, true);
  assert.equal(stored.snapshot.byteSize, 128);

  const replay = await database.putPublicationSnapshot(account.id, "snapshot-on", {
    ciphertext: "A".repeat(128), iv, contentDigest: "sha256:one", capturedAt: at(0),
  });
  assert.equal(replay.stored, false, "an identical capture is a no-op");

  const older = await database.putPublicationSnapshot(account.id, "snapshot-on", {
    ciphertext: "C".repeat(64), iv, contentDigest: "sha256:two", capturedAt: at(-3_600_000),
  });
  assert.equal(older.stored, false, "a strictly older capture never replaces the stored row");
  assert.equal(older.snapshot.contentDigest, "sha256:one");

  const newer = await database.putPublicationSnapshot(account.id, "snapshot-on", {
    ciphertext: "B".repeat(256), iv, contentDigest: "sha256:two", capturedAt: at(3_600_000),
  });
  assert.equal(newer.stored, true);
  const rows = await pool.query("SELECT content_digest, byte_size FROM bridge_publication_snapshots WHERE publication_id = 'snapshot-on'");
  assert.equal(rows.rowCount, 1, "one bounded row per publication");
  assert.equal(rows.rows[0].content_digest, "sha256:two");
  assert.equal(Number(rows.rows[0].byte_size), 256);

  await assert.rejects(
    database.putPublicationSnapshot(account.id, "snapshot-on", {
      ciphertext: "A".repeat(Math.floor(2 * 1024 * 1024 * 1.4) + 1), iv, contentDigest: "sha256:big", capturedAt: at(7_200_000),
    }),
    (error) => error instanceof BridgeDatabaseError && error.code === "snapshot_too_large",
  );

  await database.upsertPublication(account, "snapshot-full", { operationId: "operation-full", kind: "page", snapshotEnabled: true });
  await pool.query(
    `INSERT INTO bridge_publication_snapshots (publication_id, ciphertext, iv, content_digest, byte_size, captured_at)
     VALUES ('snapshot-full', 'AAAA', $1, 'sha256:full', $2, $3)`,
    [iv, 23 * 1024 * 1024, new Date(base)],
  );
  await assert.rejects(
    database.putPublicationSnapshot(account.id, "snapshot-on", {
      ciphertext: "D".repeat(1024 * 1024), iv, contentDigest: "sha256:three", capturedAt: at(10_800_000),
    }),
    (error) => error instanceof BridgeDatabaseError && error.code === "snapshot_budget",
    "the per-account snapshot budget fails closed",
  );
  const replacing = await database.putPublicationSnapshot(account.id, "snapshot-full", {
    ciphertext: "E".repeat(512), iv, contentDigest: "sha256:shrunk", capturedAt: at(10_800_000),
  });
  assert.equal(replacing.stored, true, "replacing a publication's own snapshot never counts itself against the budget");

  assert.equal(await database.deletePublicationSnapshot(other.id, "snapshot-full"), false, "snapshot deletion is account-scoped");
  assert.equal(await database.deletePublicationSnapshot(account.id, "snapshot-full"), true);
  assert.equal(await database.deletePublicationSnapshot(account.id, "snapshot-full"), false, "snapshot deletion is idempotent");

  await database.upsertPublication(account, "snapshot-on", {
    operationId: "operation-opt-out", kind: "page", snapshotEnabled: false,
  });
  const removed = await pool.query("SELECT publication_id FROM bridge_publication_snapshots WHERE publication_id = 'snapshot-on'");
  assert.equal(removed.rowCount, 0, "turning the snapshot flag off deletes the stored row");
});

test("viewer serving reads are scoped and indistinct, and byte charges keep a rolling day window", async (context) => {
  const { database, pool } = await databaseFixture(context);
  const owner = await insertAccount(pool, "serving-owner");
  const outsider = await insertAccount(pool, "serving-outsider");
  await database.upsertPublication(owner, "serving-live", { operationId: "operation-serving-live", kind: "page", snapshotEnabled: true });
  await database.upsertPublication(owner, "serving-revoked", { operationId: "operation-serving-revoked", kind: "page", state: "revoked" });
  await database.upsertPublication(owner, "serving-expired", {
    operationId: "operation-serving-expired",
    kind: "page",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const visible = await database.publicationForViewer(owner.id, "serving-live");
  assert.equal(visible.id, "serving-live");
  assert.equal(await database.publicationForViewer(owner.id, "serving-revoked"), null, "a revoked slot reads as nothing");
  assert.equal(await database.publicationForViewer(owner.id, "serving-expired"), null, "an expired slot reads as nothing");
  assert.equal(await database.publicationForViewer(owner.id, "serving-missing"), null);
  assert.equal(await database.publicationForViewer(outsider.id, "serving-live"), null, "viewer reads are account-scoped");
  assert.equal(await database.publicationForViewer(owner.id, "../serving-live"), null, "malformed ids read as nothing");

  await database.putPublicationSnapshot(owner.id, "serving-live", {
    ciphertext: "A".repeat(64),
    iv: "AAAAAAAAAAAAAAAA",
    contentDigest: "sha256:serving",
    capturedAt: new Date().toISOString(),
  });
  assert.equal((await database.publicationSnapshot(owner.id, "serving-live")).contentDigest, "sha256:serving");
  assert.equal(await database.publicationSnapshot(outsider.id, "serving-live"), null, "snapshot reads are account-scoped");
  assert.equal(await database.publicationSnapshot(owner.id, "serving-revoked"), null);

  const chargedOnce = await database.chargePublicationServedBytes(owner.id, "serving-live", 1_000);
  const chargedTwice = await database.chargePublicationServedBytes(owner.id, "serving-live", 500);
  assert.equal(chargedTwice.servedBytes, 1_500, "charges accumulate inside the current window");
  assert.equal(publicationWindowServedBytes(chargedTwice), 1_500);
  assert.equal(await database.chargePublicationServedBytes(outsider.id, "serving-live", 9_999), null, "charging is account-scoped");
  await assert.rejects(
    database.chargePublicationServedBytes(owner.id, "serving-live", -1),
    (error) => error instanceof BridgeDatabaseError && error.code === "invalid_input",
  );

  await pool.query(
    "UPDATE bridge_publications SET served_bytes_window_started_at = NOW() - INTERVAL '25 hours' WHERE id = 'serving-live'",
  );
  const lapsed = await database.publicationForViewer(owner.id, "serving-live");
  assert.equal(publicationWindowServedBytes(lapsed), 0, "a lapsed window no longer counts against the budget");
  const restarted = await database.chargePublicationServedBytes(owner.id, "serving-live", 250);
  assert.equal(restarted.servedBytes, 250, "the first charge after a lapsed window restarts it");
  assert.equal(publicationWindowServedBytes(restarted), 250);
  assert.equal(publicationWindowServedBytes({ servedBytes: 10, servedBytesWindowStartedAt: "not a date" }), 0);
  assert.equal(chargedOnce.servedBytes, 1_000, "charge results are immutable snapshots");
});

async function databaseFixture(context) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const database = new BridgeDatabase({ pool });
  await database.initialize();
  context.after(async () => {
    await database.close();
    await pool.end();
  });
  return { database, pool };
}

async function insertAccount(pool, id) {
  const now = new Date();
  await pool.query(
    `INSERT INTO bridge_accounts (
      id,slug,password_salt,password_hash,password_n,password_r,password_p,device_token_hash,
      device_signing_public_jwk,device_encryption_public_jwk,grant_generation,auth_generation,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,2,1,1,$5,$6::jsonb,$6::jsonb,1,1,$7,$7)`,
    [id, id, Buffer.alloc(16).toString("base64"), Buffer.alloc(64).toString("base64"), `device-${id}`, JSON.stringify({}), now],
  );
  return Object.freeze({ id, slug: id, authGeneration: 1 });
}

async function insertGrant(pool, accountId, grantId) {
  await pool.query(
    `INSERT INTO bridge_browser_grants (
      id,account_id,browser_id,label,signing_public_jwk,encryption_public_jwk,generation,status,
      approval_certificate,approval_signature,approved_at,revoked_at
    ) VALUES ($1,$2,$3,'Test browser',$4::jsonb,$4::jsonb,1,'approved',$4::jsonb,'signature',NOW(),NULL)`,
    [grantId, accountId, `browser-${grantId}`, JSON.stringify({})],
  );
}

async function createBoundSession(database, pool, account, grantId) {
  const created = await database.createSession(account);
  await pool.query("UPDATE bridge_sessions SET browser_grant_id = $1 WHERE id = $2", [grantId, created.id]);
  return created;
}

async function insertOperation(pool, { id, accountId, grantId, requestId, state }) {
  const now = new Date();
  await pool.query(
    `INSERT INTO bridge_operations (
      id,account_id,browser_grant_id,request_id,operation,generation,state,created_at,updated_at,expires_at
    ) VALUES ($1,$2,$3,$4,'management.summary',1,$5,$6,$6,$7)`,
    [id, accountId, grantId, requestId, state, now, new Date(now.getTime() + 10 * 60_000)],
  );
}

async function grantAndOperationState(pool, grantId, operationId) {
  const grant = await pool.query("SELECT status FROM bridge_browser_grants WHERE id = $1", [grantId]);
  const operation = await pool.query("SELECT state FROM bridge_operations WHERE id = $1", [operationId]);
  return { grant: grant.rows[0]?.status ?? null, operation: operation.rows[0]?.state ?? null };
}

async function sessionExists(pool, sessionId) {
  const result = await pool.query("SELECT id FROM bridge_sessions WHERE id = $1", [sessionId]);
  return result.rowCount > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
