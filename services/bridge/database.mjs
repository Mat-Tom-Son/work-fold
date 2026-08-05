import { createHash, createPublicKey, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual, verify } from "node:crypto";
import { promisify } from "node:util";

import pg from "pg";

const scrypt = promisify(scryptCallback);
const scryptParameters = Object.freeze({ N: 2 ** 16, r: 8, p: 2, maxmem: 96 * 1024 * 1024 });
const passwordBytes = 64;
const sessionIdleMs = 12 * 60 * 60 * 1_000;
const sessionAbsoluteMs = 7 * 24 * 60 * 60 * 1_000;
const pairingTtlMs = 10 * 60 * 1_000;
const operationTtlMs = 10 * 60 * 1_000;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const reservedSlugs = new Set([
  "admin", "api", "app", "assets", "auth", "billing", "bridge", "cdn", "docs", "help",
  "login", "mail", "root", "status", "support", "www",
]);
const dummyPassword = Object.freeze({
  salt: Buffer.alloc(16, 0x45).toString("base64"),
  hash: Buffer.alloc(passwordBytes, 0xa7).toString("base64"),
  N: scryptParameters.N,
  r: scryptParameters.r,
  p: scryptParameters.p,
});

export class BridgeDatabaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeDatabaseError";
    this.code = code;
  }
}

export class BridgeDatabase {
  #pool;
  #ownsPool;

  constructor({ connectionString = process.env.DATABASE_URL, pool } = {}) {
    if (pool) {
      this.#pool = pool;
      this.#ownsPool = false;
      return;
    }
    if (!connectionString) throw new Error("DATABASE_URL is required for the work-fold bridge.");
    const ssl = sslOptions();
    this.#pool = new pg.Pool({
      connectionString,
      max: numberFromEnv("WORKFOLD_BRIDGE_DB_POOL", 10, 1, 50),
      ...(ssl === undefined ? {} : { ssl }),
    });
    this.#ownsPool = true;
  }

  async initialize() {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS bridge_accounts (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_n INTEGER NOT NULL,
        password_r INTEGER NOT NULL,
        password_p INTEGER NOT NULL,
        device_token_hash TEXT NOT NULL UNIQUE,
        device_signing_public_jwk JSONB NOT NULL,
        device_encryption_public_jwk JSONB NOT NULL,
        grant_generation BIGINT NOT NULL DEFAULT 1,
        auth_generation BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_browser_grants (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES bridge_accounts(id) ON DELETE CASCADE,
        browser_id TEXT NOT NULL,
        label TEXT NOT NULL,
        signing_public_jwk JSONB NOT NULL,
        encryption_public_jwk JSONB NOT NULL,
        generation BIGINT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'revoked')),
        approval_certificate JSONB NOT NULL,
        approval_signature TEXT NOT NULL,
        approved_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE(account_id, browser_id)
      );
      CREATE TABLE IF NOT EXISTS bridge_sessions (
        token_hash TEXT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL REFERENCES bridge_accounts(id) ON DELETE CASCADE,
        browser_grant_id TEXT REFERENCES bridge_browser_grants(id) ON DELETE SET NULL,
        csrf_hash TEXT NOT NULL,
        login_challenge TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        absolute_expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_pairings (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES bridge_accounts(id) ON DELETE CASCADE,
        session_token_hash TEXT NOT NULL REFERENCES bridge_sessions(token_hash) ON DELETE CASCADE,
        browser_id TEXT NOT NULL,
        label TEXT NOT NULL,
        signing_public_jwk JSONB NOT NULL,
        encryption_public_jwk JSONB NOT NULL,
        code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
        approval_certificate JSONB,
        approval_signature TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        decided_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS bridge_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES bridge_accounts(id) ON DELETE CASCADE,
        browser_grant_id TEXT NOT NULL REFERENCES bridge_browser_grants(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        generation BIGINT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'delivered', 'running', 'done', 'failed', 'lost')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        UNIQUE(browser_grant_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS bridge_sessions_account_idx ON bridge_sessions(account_id);
      CREATE INDEX IF NOT EXISTS bridge_pairings_account_status_idx ON bridge_pairings(account_id, status);
      CREATE INDEX IF NOT EXISTS bridge_operations_account_state_idx ON bridge_operations(account_id, state);
      ALTER TABLE bridge_accounts ADD COLUMN IF NOT EXISTS auth_generation BIGINT NOT NULL DEFAULT 1;
    `);
    // A restart loses only transient delivery state. The browser may safely
    // resubmit the exact same signed envelope and request id; the desktop owns
    // the durable semantic deduplication boundary for effectful operations.
    await this.#pool.query("UPDATE bridge_operations SET state = 'lost', updated_at = NOW() WHERE state IN ('accepted', 'delivered', 'running')");
    await this.cleanup();
  }

  async close() {
    if (this.#ownsPool) await this.#pool.end();
  }

  async cleanup() {
    await this.#pool.query("DELETE FROM bridge_sessions WHERE absolute_expires_at <= NOW() OR expires_at <= NOW()");
    await this.#pool.query("UPDATE bridge_pairings SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()");
    await this.#pool.query("DELETE FROM bridge_operations WHERE expires_at <= NOW()");
  }

  async enroll({ slug: rawSlug, password, deviceSigningPublicJwk, deviceEncryptionPublicJwk }) {
    const slug = assertSlug(rawSlug);
    assertPassword(password);
    assertPublicJwk(deviceSigningPublicJwk, "device signing key", "sig");
    assertPublicJwk(deviceEncryptionPublicJwk, "device encryption key", "enc");
    const id = randomUUID();
    const now = new Date();
    const deviceToken = randomBytes(32).toString("base64url");
    const record = await passwordRecord(password);
    try {
      await this.#pool.query(
        `INSERT INTO bridge_accounts (
          id, slug, password_salt, password_hash, password_n, password_r, password_p,
          device_token_hash, device_signing_public_jwk, device_encryption_public_jwk,
          grant_generation, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,1,$11,$11)`,
        [id, slug, record.salt, record.hash, record.N, record.r, record.p, tokenHash(deviceToken),
          JSON.stringify(deviceSigningPublicJwk), JSON.stringify(deviceEncryptionPublicJwk), now],
      );
    } catch (error) {
      if (error?.code === "23505") throw new BridgeDatabaseError("slug_taken", "That work-fold address is already in use.");
      throw error;
    }
    return { account: await this.accountById(id), deviceToken };
  }

  async authenticatePassword(slugValue, password) {
    const slug = normalizeSlug(slugValue);
    const result = await this.#pool.query("SELECT * FROM bridge_accounts WHERE slug = $1", [slug]);
    const row = result.rows[0];
    const record = row ? passwordFromRow(row) : dummyPassword;
    const candidate = await derivePassword(typeof password === "string" ? password : "", record);
    const matches = safeEqual(candidate, Buffer.from(record.hash, "base64"));
    return row && matches ? accountFromRow(row) : null;
  }

  async accountBySlug(slugValue) {
    const result = await this.#pool.query("SELECT * FROM bridge_accounts WHERE slug = $1", [normalizeSlug(slugValue)]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async accountById(id) {
    const result = await this.#pool.query("SELECT * FROM bridge_accounts WHERE id = $1", [id]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async authenticateDevice(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    const result = await this.#pool.query("SELECT * FROM bridge_accounts WHERE device_token_hash = $1", [tokenHash(token)]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async updateAccount(accountId, { slug: rawSlug, password }) {
    const updates = [];
    const values = [];
    if (rawSlug !== undefined) {
      values.push(assertSlug(rawSlug));
      updates.push(`slug = $${values.length}`);
    }
    if (password !== undefined) {
      assertPassword(password);
      const record = await passwordRecord(password);
      for (const [column, value] of Object.entries({
        password_salt: record.salt,
        password_hash: record.hash,
        password_n: record.N,
        password_r: record.r,
        password_p: record.p,
      })) {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
    }
    if (!updates.length) return this.accountById(accountId);
    values.push(accountId);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE bridge_accounts SET ${updates.join(", ")}, auth_generation = auth_generation + 1, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
        values,
      );
      if (!result.rows[0]) throw new BridgeDatabaseError("not_found", "Remote access is no longer registered.");
      if (password !== undefined || rawSlug !== undefined) {
        await client.query("DELETE FROM bridge_sessions WHERE account_id = $1", [accountId]);
      }
      await client.query("COMMIT");
      return accountFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error?.code === "23505") throw new BridgeDatabaseError("slug_taken", "That work-fold address is already in use.");
      throw error;
    } finally {
      client.release();
    }
  }

  async removeAccount(accountId) {
    const result = await this.#pool.query("DELETE FROM bridge_accounts WHERE id = $1", [accountId]);
    return result.rowCount > 0;
  }

  async createSession(account) {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const challenge = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionIdleMs);
    const absoluteExpiresAt = new Date(now.getTime() + sessionAbsoluteMs);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM bridge_sessions WHERE account_id = $1 AND (absolute_expires_at <= NOW() OR expires_at <= NOW())", [account.id]);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM bridge_sessions WHERE account_id = $1", [account.id]);
      if (Number(count.rows[0]?.count ?? 0) >= 10) {
        await client.query(
          "DELETE FROM bridge_sessions WHERE token_hash IN (SELECT token_hash FROM bridge_sessions WHERE account_id = $1 ORDER BY last_seen_at ASC LIMIT 1)",
          [account.id],
        );
      }
      const result = await client.query(
        `INSERT INTO bridge_sessions (
          token_hash,id,account_id,browser_grant_id,csrf_hash,login_challenge,created_at,last_seen_at,expires_at,absolute_expires_at
        ) SELECT $1,$2,id,NULL,$3,$4,$5::timestamptz,$5::timestamptz,$6::timestamptz,$7::timestamptz FROM bridge_accounts
          WHERE id = $8 AND auth_generation = $9 RETURNING account_id`,
        [tokenHash(token), id, tokenHash(csrfToken), challenge, now, expiresAt, absoluteExpiresAt, account.id, account.authGeneration],
      );
      if (!result.rows[0]) throw new BridgeDatabaseError("credentials_changed", "The account changed during sign-in. Try again.");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { token, csrfToken, challenge, id, accountId: account.id, browserGrantId: null, expiresAt: expiresAt.toISOString() };
  }

  async session(token, { touch = true } = {}) {
    if (typeof token !== "string" || !token) return null;
    const hash = tokenHash(token);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT s.*, a.slug, a.grant_generation, g.browser_id, g.signing_public_jwk, g.encryption_public_jwk,
          g.status AS grant_status, g.generation AS browser_grant_generation
         FROM (
           SELECT * FROM bridge_sessions
           WHERE token_hash = $1 AND expires_at > NOW() AND absolute_expires_at > NOW()
           FOR UPDATE
         ) s
         JOIN bridge_accounts a ON a.id = s.account_id
         LEFT JOIN bridge_browser_grants g ON g.id = s.browser_grant_id
        `,
        [hash],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      if (touch) {
        await client.query(
          `UPDATE bridge_sessions SET last_seen_at = NOW(), expires_at =
            CASE WHEN absolute_expires_at < NOW() + INTERVAL '12 hours'
              THEN absolute_expires_at ELSE NOW() + INTERVAL '12 hours' END
           WHERE token_hash = $1`,
          [hash],
        );
      }
      await client.query("COMMIT");
      return sessionFromRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async assertCsrf(session, value) {
    if (!session || typeof value !== "string" || !safeEqual(Buffer.from(session.csrfHash, "hex"), Buffer.from(tokenHash(value), "hex"))) {
      throw new BridgeDatabaseError("csrf", "The browser session could not be verified. Refresh and try again.");
    }
  }

  async deleteSession(token) {
    if (!token) return false;
    const result = await this.#pool.query("DELETE FROM bridge_sessions WHERE token_hash = $1", [tokenHash(token)]);
    return result.rowCount > 0;
  }

  async rotateSessionCsrf(token) {
    if (typeof token !== "string" || !token) return null;
    const csrfToken = randomBytes(24).toString("base64url");
    const result = await this.#pool.query(
      `UPDATE bridge_sessions SET csrf_hash = $1, last_seen_at = NOW(),
        expires_at = CASE WHEN absolute_expires_at < NOW() + INTERVAL '12 hours'
          THEN absolute_expires_at ELSE NOW() + INTERVAL '12 hours' END
       WHERE token_hash = $2 AND expires_at > NOW() AND absolute_expires_at > NOW()
       RETURNING id`,
      [tokenHash(csrfToken), tokenHash(token)],
    );
    return result.rows[0] ? csrfToken : null;
  }

  async revokeSessions(accountId) {
    const result = await this.#pool.query("DELETE FROM bridge_sessions WHERE account_id = $1", [accountId]);
    return result.rowCount;
  }

  async bindSessionToBrowser(token, { browserId, signature }) {
    const session = await this.session(token, { touch: false });
    if (!session) throw new BridgeDatabaseError("unauthorized", "Sign in to continue.");
    const result = await this.#pool.query(
      `SELECT * FROM bridge_browser_grants
       WHERE account_id = $1 AND browser_id = $2 AND status = 'approved' AND generation = $3`,
      [session.accountId, browserId, session.grantGeneration],
    );
    const grant = result.rows[0];
    if (!grant) throw new BridgeDatabaseError("pairing_required", "Approve this browser from the work-fold desktop app.");
    const proof = canonicalizeJson({
      type: "work-fold.browser-bind.v1",
      accountId: session.accountId,
      browserId,
      challenge: session.loginChallenge,
    });
    if (!verifyP1363(grant.signing_public_jwk, proof, signature)) {
      throw new BridgeDatabaseError("unauthorized", "This browser could not prove its approved identity.");
    }
    await this.#pool.query(
      "UPDATE bridge_sessions SET browser_grant_id = $1, login_challenge = $2 WHERE token_hash = $3",
      [grant.id, randomBytes(32).toString("base64url"), tokenHash(token)],
    );
    return grantFromRow(grant);
  }

  async createPairing(token, { browserId, label, signingPublicJwk, encryptionPublicJwk }) {
    const session = await this.session(token, { touch: false });
    if (!session) throw new BridgeDatabaseError("unauthorized", "Sign in to continue.");
    assertStableId(browserId, "browser id", 128);
    assertLabel(label);
    assertPublicJwk(signingPublicJwk, "browser signing key", "sig");
    assertPublicJwk(encryptionPublicJwk, "browser encryption key", "enc");
    const now = new Date();
    const pairing = {
      id: randomUUID(),
      accountId: session.accountId,
      browserId,
      label: label.trim(),
      signingPublicJwk,
      encryptionPublicJwk,
      code: String(randomInt(100_000, 1_000_000)),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + pairingTtlMs).toISOString(),
    };
    await this.#pool.query("UPDATE bridge_pairings SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()");
    const pending = await this.#pool.query(
      "SELECT COUNT(*)::int AS count FROM bridge_pairings WHERE account_id = $1 AND status = 'pending'",
      [session.accountId],
    );
    if (Number(pending.rows[0]?.count ?? 0) >= 10) {
      throw new BridgeDatabaseError("pairing_limit", "Too many browser approvals are pending. Wait for one to expire or finish it first.");
    }
    await this.#pool.query("UPDATE bridge_pairings SET status = 'expired' WHERE session_token_hash = $1 AND status = 'pending'", [tokenHash(token)]);
    await this.#pool.query(
      `INSERT INTO bridge_pairings (
        id,account_id,session_token_hash,browser_id,label,signing_public_jwk,encryption_public_jwk,code,status,created_at,expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'pending',$9,$10)`,
      [pairing.id, pairing.accountId, tokenHash(token), pairing.browserId, pairing.label,
        JSON.stringify(signingPublicJwk), JSON.stringify(encryptionPublicJwk), pairing.code, now, pairing.expiresAt],
    );
    return pairing;
  }

  async pairingForSession(token, pairingId) {
    const session = await this.session(token, { touch: false });
    if (!session) return null;
    const result = await this.#pool.query(
      "SELECT * FROM bridge_pairings WHERE id = $1 AND account_id = $2 AND session_token_hash = $3",
      [pairingId, session.accountId, tokenHash(token)],
    );
    return result.rows[0] ? pairingFromRow(result.rows[0]) : null;
  }

  async pendingPairings(accountId) {
    const result = await this.#pool.query(
      "SELECT * FROM bridge_pairings WHERE account_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at",
      [accountId],
    );
    return result.rows.map(pairingFromRow);
  }

  async decidePairing(account, { pairingId, approved, certificate, signature }) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM bridge_pairings WHERE id = $1 AND account_id = $2 AND status = 'pending' AND expires_at > NOW() FOR UPDATE",
        [pairingId, account.id],
      );
      const pairing = result.rows[0];
      if (!pairing) throw new BridgeDatabaseError("not_found", "That browser approval has expired.");
      if (!approved) {
        await client.query("UPDATE bridge_pairings SET status = 'declined', decided_at = NOW() WHERE id = $1", [pairingId]);
        await client.query("COMMIT");
        return { status: "declined" };
      }
      assertApprovalCertificate(account, pairing, certificate);
      if (!verifyP1363(account.deviceSigningPublicJwk, canonicalizeJson(certificate), signature)) {
        throw new BridgeDatabaseError("invalid_signature", "The desktop approval signature is invalid.");
      }
      const previous = await client.query(
        "SELECT id FROM bridge_browser_grants WHERE account_id = $1 AND browser_id = $2 FOR UPDATE",
        [account.id, pairing.browser_id],
      );
      if (previous.rows[0]) {
        await client.query("DELETE FROM bridge_sessions WHERE browser_grant_id = $1", [previous.rows[0].id]);
        await client.query("DELETE FROM bridge_operations WHERE browser_grant_id = $1", [previous.rows[0].id]);
        await client.query("DELETE FROM bridge_browser_grants WHERE id = $1", [previous.rows[0].id]);
      }
      await client.query(
        `INSERT INTO bridge_browser_grants (
          id,account_id,browser_id,label,signing_public_jwk,encryption_public_jwk,generation,status,
          approval_certificate,approval_signature,approved_at,revoked_at
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,'approved',$8::jsonb,$9,NOW(),NULL)
        `,
        [certificate.grantId, account.id, pairing.browser_id, pairing.label, JSON.stringify(pairing.signing_public_jwk),
          JSON.stringify(pairing.encryption_public_jwk), account.grantGeneration, JSON.stringify(certificate), signature],
      );
      await client.query(
        `UPDATE bridge_pairings SET status = 'approved', approval_certificate = $1::jsonb,
          approval_signature = $2, decided_at = NOW() WHERE id = $3`,
        [JSON.stringify(certificate), signature, pairingId],
      );
      await client.query("UPDATE bridge_sessions SET browser_grant_id = $1 WHERE token_hash = $2", [certificate.grantId, pairing.session_token_hash]);
      await client.query("COMMIT");
      return { status: "approved", grantId: certificate.grantId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listGrants(accountId) {
    const result = await this.#pool.query(
      "SELECT * FROM bridge_browser_grants WHERE account_id = $1 ORDER BY approved_at DESC",
      [accountId],
    );
    return result.rows.map(grantFromRow);
  }

  async revokeGrant(accountId, grantId) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "UPDATE bridge_browser_grants SET status = 'revoked', revoked_at = NOW() WHERE id = $1 AND account_id = $2 AND status = 'approved'",
        [grantId, accountId],
      );
      await client.query("DELETE FROM bridge_sessions WHERE browser_grant_id = $1", [grantId]);
      await client.query(
        "UPDATE bridge_operations SET state = 'lost', updated_at = NOW() WHERE browser_grant_id = $1 AND state IN ('accepted','delivered','running')",
        [grantId],
      );
      await client.query("COMMIT");
      return result.rowCount > 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeAllGrants(accountId) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE bridge_accounts SET grant_generation = grant_generation + 1, updated_at = NOW() WHERE id = $1", [accountId]);
      const result = await client.query(
        "UPDATE bridge_browser_grants SET status = 'revoked', revoked_at = NOW() WHERE account_id = $1 AND status = 'approved'",
        [accountId],
      );
      await client.query("DELETE FROM bridge_sessions WHERE account_id = $1", [accountId]);
      await client.query("UPDATE bridge_operations SET state = 'lost', updated_at = NOW() WHERE account_id = $1 AND state IN ('accepted','delivered','running')", [accountId]);
      await client.query("COMMIT");
      return result.rowCount;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptOperation(session, { requestId, operation, generation }, { recover = false } = {}) {
    if (!session?.browserGrantId || session.grantStatus !== "approved"
      || session.browserGrantGeneration !== session.grantGeneration || String(generation) !== String(session.grantGeneration)) {
      throw new BridgeDatabaseError("pairing_required", "Approve this browser from the work-fold desktop app.");
    }
    assertStableId(requestId, "request id", 128);
    const id = randomUUID();
    const now = new Date();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM bridge_operations WHERE browser_grant_id = $1 AND expires_at <= NOW()", [session.browserGrantId]);
      const existing = await client.query(
        "SELECT * FROM bridge_operations WHERE browser_grant_id = $1 AND request_id = $2 FOR UPDATE",
        [session.browserGrantId, requestId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.account_id !== session.accountId || row.operation !== operation || String(row.generation) !== String(generation)) {
          throw new BridgeDatabaseError("request_conflict", "That request id was already used for a different remote operation.");
        }
        const reopened = recover && new Set(["lost", "done", "failed"]).has(row.state)
          ? await client.query(
            "UPDATE bridge_operations SET state = 'accepted', updated_at = NOW(), expires_at = $1 WHERE id = $2 RETURNING *",
            [new Date(now.getTime() + operationTtlMs), row.id],
          )
          : existing;
        await client.query("COMMIT");
        return { ...operationFromRow(reopened.rows[0]), duplicate: true };
      }
      const count = await client.query(
        "SELECT COUNT(*)::int AS count FROM bridge_operations WHERE browser_grant_id = $1 AND expires_at > NOW()",
        [session.browserGrantId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= 128) {
        throw new BridgeDatabaseError("operation_limit", "Too many remote requests are still recent. Wait a moment and try again.");
      }
      const result = await client.query(
        `INSERT INTO bridge_operations (
          id,account_id,browser_grant_id,request_id,operation,generation,state,created_at,updated_at,expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,$7,$8) RETURNING *`,
        [id, session.accountId, session.browserGrantId, requestId, operation, generation, now, new Date(now.getTime() + operationTtlMs)],
      );
      await client.query("COMMIT");
      return { ...operationFromRow(result.rows[0]), duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error?.code !== "23505") throw error;
      await client.query("BEGIN");
      try {
        const existing = await client.query(
          "SELECT * FROM bridge_operations WHERE browser_grant_id = $1 AND request_id = $2 FOR UPDATE",
          [session.browserGrantId, requestId],
        );
        const row = existing.rows[0];
        if (!row) throw error;
        if (row.account_id !== session.accountId || row.operation !== operation || String(row.generation) !== String(generation)) {
          throw new BridgeDatabaseError("request_conflict", "That request id was already used for a different remote operation.");
        }
        const reopened = recover && new Set(["lost", "done", "failed"]).has(row.state)
          ? await client.query(
            "UPDATE bridge_operations SET state = 'accepted', updated_at = NOW(), expires_at = $1 WHERE id = $2 RETURNING *",
            [new Date(now.getTime() + operationTtlMs), row.id],
          )
          : existing;
        await client.query("COMMIT");
        return { ...operationFromRow(reopened.rows[0]), duplicate: true };
      } catch (duplicateError) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw duplicateError;
      }
    } finally {
      client.release();
    }
  }

  async claimOperationDelivery(accountId, operationId) {
    const result = await this.#pool.query(
      `UPDATE bridge_operations SET state = 'delivered', updated_at = NOW()
       WHERE id = $1 AND account_id = $2 AND state = 'accepted' AND expires_at > NOW() RETURNING *`,
      [operationId, accountId],
    );
    return result.rows[0] ? operationFromRow(result.rows[0]) : null;
  }

  async markActiveOperationsLost(accountId) {
    const result = await this.#pool.query(
      `UPDATE bridge_operations SET state = 'lost', updated_at = NOW()
       WHERE account_id = $1 AND state IN ('accepted','delivered','running') RETURNING id`,
      [accountId],
    );
    return result.rows.map((row) => row.id);
  }

  async operationForSession(session, operationId) {
    if (!session?.browserGrantId) return null;
    const result = await this.#pool.query(
      "SELECT * FROM bridge_operations WHERE id = $1 AND account_id = $2 AND browser_grant_id = $3 AND expires_at > NOW()",
      [operationId, session.accountId, session.browserGrantId],
    );
    return result.rows[0] ? operationFromRow(result.rows[0]) : null;
  }

  async operationForDevice(accountId, operationId) {
    const result = await this.#pool.query(
      "SELECT * FROM bridge_operations WHERE id = $1 AND account_id = $2 AND expires_at > NOW()",
      [operationId, accountId],
    );
    return result.rows[0] ? operationFromRow(result.rows[0]) : null;
  }

  async setOperationState(accountId, operationId, state) {
    const previousStates = {
      running: ["accepted", "delivered"],
      done: ["accepted", "delivered", "running"],
      failed: ["accepted", "delivered", "running"],
      lost: ["accepted", "delivered", "running"],
    }[state];
    if (!previousStates) throw new Error("Invalid operation state.");
    const placeholders = previousStates.map((_, index) => `$${index + 4}`).join(",");
    const result = await this.#pool.query(
      `UPDATE bridge_operations SET state = $1, updated_at = NOW(),
         expires_at = CASE WHEN $1 IN ('done','failed') AND expires_at > NOW() + INTERVAL '2 minutes'
           THEN NOW() + INTERVAL '2 minutes' ELSE expires_at END
       WHERE id = $2 AND account_id = $3 AND state IN (${placeholders}) AND expires_at > NOW() RETURNING *`,
      [state, operationId, accountId, ...previousStates],
    );
    return result.rows[0] ? operationFromRow(result.rows[0]) : null;
  }
}

export function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidSlug(value) {
  const slug = normalizeSlug(value);
  return slugPattern.test(slug) && slug.length >= 3 && !reservedSlugs.has(slug);
}

export function assertSlug(value) {
  const slug = normalizeSlug(value);
  if (!isValidSlug(slug)) {
    throw new BridgeDatabaseError("invalid_slug", "Choose 3–32 lowercase letters, numbers, or hyphens, beginning and ending with a letter or number.");
  }
  return slug;
}

export function assertPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw new BridgeDatabaseError("invalid_password", "Use a password of at least 8 characters.");
  }
}

export function canonicalizeJson(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("Only JSON values can be canonicalized.");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
}

export function verifyP1363(publicJwk, text, signature) {
  try {
    return verify("sha256", Buffer.from(text), { key: createPublicKey({ key: publicJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function assertApprovalCertificate(account, pairing, certificate) {
  const expected = {
    type: "work-fold.browser-grant.v1",
    accountId: account.id,
    deviceId: account.id,
    grantId: certificate?.grantId,
    pairingId: pairing.id,
    pairingCode: pairing.code,
    browserId: pairing.browser_id,
    browserSigningPublicJwk: pairing.signing_public_jwk,
    browserEncryptionPublicJwk: pairing.encryption_public_jwk,
    generation: account.grantGeneration,
    approvedAt: certificate?.approvedAt,
  };
  assertStableId(certificate?.grantId, "grant id", 128);
  if (typeof certificate?.approvedAt !== "string" || !Number.isFinite(Date.parse(certificate.approvedAt))) {
    throw new BridgeDatabaseError("invalid_certificate", "The desktop approval certificate is invalid.");
  }
  if (canonicalizeJson(certificate) !== canonicalizeJson(expected)) {
    throw new BridgeDatabaseError("invalid_certificate", "The desktop approval certificate does not match this browser.");
  }
}

function assertPublicJwk(value, label, use) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.kty !== "EC" || value.crv !== "P-256"
    || typeof value.x !== "string" || typeof value.y !== "string" || value.d !== undefined) {
    throw new BridgeDatabaseError("invalid_key", `A valid P-256 ${label} is required.`);
  }
  if (value.use !== undefined && value.use !== use) throw new BridgeDatabaseError("invalid_key", `The ${label} has the wrong use.`);
  try { createPublicKey({ key: value, format: "jwk" }); } catch { throw new BridgeDatabaseError("invalid_key", `The ${label} is invalid.`); }
}

function assertStableId(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new BridgeDatabaseError("invalid_input", `A valid ${label} is required.`);
  }
}

function assertLabel(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\r\n]/.test(value)) {
    throw new BridgeDatabaseError("invalid_input", "A short browser name is required.");
  }
}

async function passwordRecord(password) {
  const salt = randomBytes(16);
  const base = { salt: salt.toString("base64"), hash: "", N: scryptParameters.N, r: scryptParameters.r, p: scryptParameters.p };
  return { ...base, hash: (await derivePassword(password, base)).toString("base64") };
}

function passwordFromRow(row) {
  return { salt: row.password_salt, hash: row.password_hash, N: row.password_n, r: row.password_r, p: row.password_p };
}

async function derivePassword(password, record) {
  return scrypt(password, Buffer.from(record.salt, "base64"), passwordBytes, {
    N: record.N, r: record.r, p: record.p, maxmem: scryptParameters.maxmem,
  });
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function accountFromRow(row) {
  return Object.freeze({
    id: row.id,
    slug: row.slug,
    deviceSigningPublicJwk: row.device_signing_public_jwk,
    deviceEncryptionPublicJwk: row.device_encryption_public_jwk,
    grantGeneration: Number(row.grant_generation),
    authGeneration: Number(row.auth_generation),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function sessionFromRow(row) {
  return Object.freeze({
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    slug: row.slug,
    browserGrantId: row.browser_grant_id,
    csrfHash: row.csrf_hash,
    loginChallenge: row.login_challenge,
    grantGeneration: Number(row.grant_generation),
    browserId: row.browser_id ?? null,
    browserSigningPublicJwk: row.signing_public_jwk ?? null,
    browserEncryptionPublicJwk: row.encryption_public_jwk ?? null,
    grantStatus: row.grant_status ?? null,
    browserGrantGeneration: row.browser_grant_generation === null || row.browser_grant_generation === undefined ? null : Number(row.browser_grant_generation),
    expiresAt: timestamp(row.expires_at),
  });
}

function pairingFromRow(row) {
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    browserId: row.browser_id,
    label: row.label,
    signingPublicJwk: row.signing_public_jwk,
    encryptionPublicJwk: row.encryption_public_jwk,
    code: row.code,
    status: row.status,
    approvalCertificate: row.approval_certificate ?? null,
    approvalSignature: row.approval_signature ?? null,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
  });
}

function grantFromRow(row) {
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    browserId: row.browser_id,
    label: row.label,
    signingPublicJwk: row.signing_public_jwk,
    encryptionPublicJwk: row.encryption_public_jwk,
    generation: Number(row.generation),
    status: row.status,
    approvalCertificate: row.approval_certificate,
    approvalSignature: row.approval_signature,
    approvedAt: timestamp(row.approved_at),
    revokedAt: row.revoked_at ? timestamp(row.revoked_at) : null,
  });
}

function operationFromRow(row) {
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    browserGrantId: row.browser_grant_id,
    requestId: row.request_id,
    operation: row.operation,
    generation: Number(row.generation),
    state: row.state,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function timestamp(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sslOptions() {
  const mode = String(process.env.WORKFOLD_BRIDGE_DB_SSL || "").trim().toLowerCase();
  if (!mode) return undefined;
  if (mode === "disable") return false;
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "verify-full") return { rejectUnauthorized: true };
  throw new Error("WORKFOLD_BRIDGE_DB_SSL must be disable, require, or verify-full.");
}

function numberFromEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
