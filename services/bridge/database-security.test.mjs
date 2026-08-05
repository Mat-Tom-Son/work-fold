import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";

import { BridgeDatabase, BridgeDatabaseError } from "./database.mjs";

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
  return Object.freeze({ id, authGeneration: 1 });
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
