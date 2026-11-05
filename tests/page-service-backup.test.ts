import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import { backupSettingsFromEnv, type BackupSettings } from "../services/pages/src/backup.js";
import { amzDateOf, s3ObjectUrl, sha256Hex, signAwsV4 } from "../services/pages/src/s3.js";
import { newPageId, publishBody, startTestPageService } from "./support/page-service.js";

/**
 * Backups (docs/pages.md, "Page service"): a minimal AWS Signature V4
 * PutObject checked against the AWS documentation's own examples, and a
 * backup pass that uploads only what changed to an S3-compatible bucket.
 */

const exampleCredentials = { region: "us-east-1", service: "s3", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

test("signing reproduces the AWS Signature Version 4 examples for S3", () => {
  // "Signature Calculations for the Authorization Header: Transferring
  // Payload in a Single Chunk", Example: GET Object.
  const emptyHash = sha256Hex("");
  assert.equal(emptyHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const get = signAwsV4({
    ...exampleCredentials,
    method: "GET",
    path: "/test.txt",
    payloadHash: emptyHash,
    headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": emptyHash, "x-amz-date": "20130524T000000Z" },
  });
  assert.equal(get.canonicalRequest, [
    "GET",
    "/test.txt",
    "",
    "host:examplebucket.s3.amazonaws.com",
    "range:bytes=0-9",
    `x-amz-content-sha256:${emptyHash}`,
    "x-amz-date:20130524T000000Z",
    "",
    "host;range;x-amz-content-sha256;x-amz-date",
    emptyHash,
  ].join("\n"));
  assert.equal(get.stringToSign, "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
  assert.equal(get.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(get.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");

  // Example: PUT Object, with a character the path must encode.
  const bodyHash = sha256Hex("Welcome to Amazon S3.");
  assert.equal(bodyHash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const put = signAwsV4({
    ...exampleCredentials,
    method: "PUT",
    path: "/test$file.text",
    payloadHash: bodyHash,
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
      "x-amz-content-sha256": bodyHash,
    },
  });
  assert.match(put.canonicalRequest, /^PUT\n\/test%24file\.text\n\n/u);
  assert.equal(sha256Hex(put.canonicalRequest), "9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d");
  assert.equal(put.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");

  assert.equal(amzDateOf(new Date("2013-05-24T00:00:00.000Z")), "20130524T000000Z");
  const settings = { endpoint: "https://storage.example.com", region: "auto", bucket: "pages-backup", accessKeyId: "k", secretAccessKey: "s", pathStyle: false };
  assert.equal(s3ObjectUrl(settings, "work-fold-pages/registry.sqlite").href, "https://pages-backup.storage.example.com/work-fold-pages/registry.sqlite");
  assert.equal(s3ObjectUrl({ ...settings, pathStyle: true }, "a/b.sqlite").href, "https://storage.example.com/pages-backup/a/b.sqlite");
});

test("backup settings come from WORKFOLD_PAGES_BACKUP_*; without them backups are off", async (t) => {
  assert.deepEqual(backupSettingsFromEnv({}), { settings: null });
  const partial = backupSettingsFromEnv({ WORKFOLD_PAGES_BACKUP_BUCKET: "pages" });
  assert.equal(partial.settings, null);
  assert.match(partial.problem!, /WORKFOLD_PAGES_BACKUP_ENDPOINT, WORKFOLD_PAGES_BACKUP_ACCESS_KEY_ID, WORKFOLD_PAGES_BACKUP_SECRET_ACCESS_KEY are missing/u);
  const full = backupSettingsFromEnv({
    WORKFOLD_PAGES_BACKUP_ENDPOINT: "https://storage.example.com/",
    WORKFOLD_PAGES_BACKUP_BUCKET: "pages-backup",
    WORKFOLD_PAGES_BACKUP_ACCESS_KEY_ID: "key",
    WORKFOLD_PAGES_BACKUP_SECRET_ACCESS_KEY: "secret",
  });
  assert.deepEqual(full, { settings: { endpoint: "https://storage.example.com", region: "auto", bucket: "pages-backup", accessKeyId: "key", secretAccessKey: "secret", pathStyle: false, prefix: "work-fold-pages/" } });
  assert.match(backupSettingsFromEnv({ ...withAll(), WORKFOLD_PAGES_BACKUP_PREFIX: "../x" }).problem!, /PREFIX/u);
  assert.match(backupSettingsFromEnv({ ...withAll(), WORKFOLD_PAGES_BACKUP_ENDPOINT: "ftp://x" }).problem!, /ENDPOINT/u);

  const pages = await startTestPageService(t, { backupProblem: partial.problem! });
  const health = await pages.get("/health");
  assert.deepEqual(health.body.backups, { enabled: false, problem: partial.problem });
  assert.deepEqual(await pages.service.backups.run(), { uploaded: [], failed: 0 });
});

function withAll(): NodeJS.ProcessEnv {
  return {
    WORKFOLD_PAGES_BACKUP_ENDPOINT: "https://storage.example.com",
    WORKFOLD_PAGES_BACKUP_BUCKET: "pages-backup",
    WORKFOLD_PAGES_BACKUP_ACCESS_KEY_ID: "key",
    WORKFOLD_PAGES_BACKUP_SECRET_ACCESS_KEY: "secret",
  };
}

/** A path-style S3 stand-in that checks each PutObject's signature and payload hash. */
async function fakeBucket(t: TestContext, settings: Omit<BackupSettings, "endpoint">) {
  const objects = new Map<string, Buffer>();
  const log: string[] = [];
  let failWith = 0;
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://bucket");
    const headers = { host: String(req.headers.host), "x-amz-content-sha256": String(req.headers["x-amz-content-sha256"]), "x-amz-date": String(req.headers["x-amz-date"]) };
    const expected = signAwsV4({ method: req.method ?? "", path: decodeURIComponent(url.pathname), headers, payloadHash: headers["x-amz-content-sha256"], region: settings.region, service: "s3", accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey });
    const valid = req.method === "PUT"
      && req.headers.authorization === expected.authorization
      && headers["x-amz-content-sha256"] === sha256Hex(body)
      && Number(req.headers["content-length"]) === body.length
      && url.pathname.startsWith(`/${settings.bucket}/`);
    if (!valid) { res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>"); return; }
    if (failWith) { res.writeHead(failWith).end(); return; }
    const key = decodeURIComponent(url.pathname.slice(settings.bucket.length + 2));
    objects.set(key, body);
    log.push(key);
    res.writeHead(200, { etag: "\"x\"" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    log,
    fail(status: number) { failWith = status; },
  };
}

test("a backup pass uploads changed databases, new documents, and the registry", async (t) => {
  const credentials = { region: "auto", bucket: "pages-backup", accessKeyId: "test-key", secretAccessKey: "test-secret", pathStyle: true, prefix: "work-fold-pages/" };
  const bucket = await fakeBucket(t, credentials);
  const pages = await startTestPageService(t, { backup: { ...credentials, endpoint: bucket.endpoint } });
  assert.deepEqual(pages.service.health().backups, { enabled: true, intervalSeconds: 300, lastRunAt: null, lastSuccessAt: null, lastError: null, failed: 0 });

  const pageId = newPageId();
  await pages.publish(pageId);
  const first = await pages.service.backups.run();
  assert.deepEqual(first, { uploaded: [`pages/${pageId}/data.sqlite`, `pages/${pageId}/rev-1.html`, "registry.sqlite"], failed: 0 });
  assert.deepEqual([...bucket.objects.keys()].sort(), [`work-fold-pages/pages/${pageId}/data.sqlite`, `work-fold-pages/pages/${pageId}/rev-1.html`, "work-fold-pages/registry.sqlite"]);
  assert.equal(bucket.objects.get("work-fold-pages/registry.sqlite")!.subarray(0, 16).toString("latin1"), "SQLite format 3\0");
  assert.equal(bucket.objects.get(`work-fold-pages/pages/${pageId}/data.sqlite`)!.subarray(0, 16).toString("latin1"), "SQLite format 3\0");
  const health = pages.service.health().backups;
  assert.equal(health.lastError, null);
  assert.ok(health.lastSuccessAt);

  assert.deepEqual(await pages.service.backups.run(), { uploaded: [], failed: 0 }, "nothing changed, nothing uploaded");
  await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } });
  assert.deepEqual((await pages.service.backups.run()).uploaded, [`pages/${pageId}/data.sqlite`, "registry.sqlite"], "only the page whose data revision moved");

  await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo", email: "bo@example.com" } });
  bucket.fail(500);
  const failing = await pages.service.backups.run();
  assert.deepEqual(failing, { uploaded: [], failed: 2 });
  assert.equal(pages.service.health().backups.lastError, "The bucket refused the upload (500).");
  assert.equal(pages.service.health().backups.failed, 2);
  bucket.fail(0);
  assert.deepEqual((await pages.service.backups.run()).uploaded, [`pages/${pageId}/data.sqlite`, "registry.sqlite"], "a failed upload is tried again next time");
  assert.equal(pages.service.health().backups.lastError, null);

  await pages.publish(pageId, publishBody({ html: "<p>v2</p>", contentDigest: "sha256:0000000000000002" }));
  assert.deepEqual((await pages.service.backups.run()).uploaded, [`pages/${pageId}/rev-2.html`, "registry.sqlite"]);
  assert.equal(bucket.objects.get(`work-fold-pages/pages/${pageId}/rev-2.html`)!.toString("utf8"), "<p>v2</p>");
});

test("wrong credentials fail the pass without saying where the bucket is", async (t) => {
  const credentials = { region: "auto", bucket: "pages-backup", accessKeyId: "test-key", secretAccessKey: "test-secret", pathStyle: true, prefix: "p/" };
  const bucket = await fakeBucket(t, credentials);
  const logs: Array<Record<string, unknown>> = [];
  const pages = await startTestPageService(t, { backup: { ...credentials, secretAccessKey: "wrong", endpoint: bucket.endpoint }, log: (record) => logs.push(record) });
  await pages.publish(newPageId());
  const result = await pages.service.backups.run();
  assert.equal(result.failed, 3);
  assert.equal(pages.service.health().backups.lastError, "The bucket refused the upload (403).");
  assert.equal(bucket.objects.size, 0);
  assert.ok(logs.some((record) => record.event === "backup.failed"));
  assert.ok(logs.every((record) => !/pg_[a-z2-7]{26}/u.test(JSON.stringify(record))), "logs never hold a whole page id");
  assert.ok(logs.some((record) => /^pages\/pg_[a-z2-7]{5}\/data\.sqlite$/u.test(String(record.object))), "they name a page by its first 8 characters");

  const unreachable = await startTestPageService(t, { backup: { ...credentials, endpoint: "http://127.0.0.1:1" } });
  await unreachable.publish(newPageId());
  await unreachable.service.backups.run();
  assert.equal(unreachable.service.health().backups.lastError, "The bucket couldn't be reached.");
});
