import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { newDb } from "pg-mem";

import { BridgeDatabase } from "./database.mjs";
import {
  isValidPageId,
  maximumPagePublishBytes,
  normalizePagesConfiguration,
  pagesConfigurationFromEnvironment,
} from "./pages-proxy.mjs";
import {
  cellText,
  entriesLabel,
  humanizeName,
  newestFirst,
  pageIdPattern as clientPageIdPattern,
  publishedPageLink,
  spreadsheetFileName,
} from "./public/published.js";
import { pageIdPattern } from "./pages-proxy.mjs";
import { startBridgeServer } from "./server.mjs";

// Online pages through the bridge (docs/pages.md, "Publishing (stage 2)"). A
// fake page service stands in for services/pages and checks that every call
// carries the shared secret and the authenticated account's id.

const secret = "a-shared-test-secret-for-pages";
const pagesOrigin = "https://pages.work-fold.test";
const pageId = "pg_abcdefghijklmnopqrstuvwxyz";
const otherPageId = `pg_${"234567".repeat(5).slice(0, 26)}`;

test("page ids are pg_ plus 26 lowercase base32 characters, and settings come all together or not at all", () => {
  assert.equal(isValidPageId(pageId), true);
  assert.equal(isValidPageId(otherPageId), true);
  for (const invalid of [
    "pg_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "pg_abcdefghijklmnopqrstuvwxy",
    "pg_abcdefghijklmnopqrstuvwxyz2",
    "pg_0bcdefghijklmnopqrstuvwxyz",
    "pg_1bcdefghijklmnopqrstuvwxyz",
    "pg_8bcdefghijklmnopqrstuvwxyz",
    "xx_abcdefghijklmnopqrstuvwxyz",
    "pg-abcdefghijklmnopqrstuvwxyz",
    "",
    undefined,
  ]) assert.equal(isValidPageId(invalid), false, String(invalid));

  const warnings = [];
  assert.equal(pagesConfigurationFromEnvironment({}, (line) => warnings.push(line)), null);
  assert.deepEqual(warnings, [], "no settings is simply off");
  const shortSecret = "short-secret";
  assert.equal(pagesConfigurationFromEnvironment({
    WORKFOLD_PAGES_INTERNAL_URL: "http://pages.railway.internal:8081",
    WORKFOLD_PAGES_INTERNAL_SECRET: shortSecret,
    WORKFOLD_PAGES_PUBLIC_ORIGIN: pagesOrigin,
  }, (line) => warnings.push(line)), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /online pages are off: WORKFOLD_PAGES_INTERNAL_SECRET must be/);
  assert.equal(warnings[0].includes(shortSecret), false, "a warning never repeats a setting's value");
  assert.equal(pagesConfigurationFromEnvironment({ WORKFOLD_PAGES_INTERNAL_URL: "http://pages.railway.internal:8081" }, (line) => warnings.push(line)), null);
  assert.equal(warnings.length, 2, "a partial setup leaves pages off with a warning");

  const configured = pagesConfigurationFromEnvironment({
    WORKFOLD_PAGES_INTERNAL_URL: "http://pages.railway.internal:8081/base/",
    WORKFOLD_PAGES_INTERNAL_SECRET: secret,
    WORKFOLD_PAGES_PUBLIC_ORIGIN: `${pagesOrigin}/`,
  });
  assert.equal(configured.internalBase, "http://pages.railway.internal:8081/base");
  assert.equal(configured.publicOrigin, pagesOrigin);
  for (const publicOrigin of ["http://pages.work-fold.test", "https://pages.work-fold.test/p", "https://pages.work-fold.test/?x=1", "not a url"]) {
    assert.throws(() => normalizePagesConfiguration({ internalUrl: "http://127.0.0.1:1", secret, publicOrigin }), /WORKFOLD_PAGES_PUBLIC_ORIGIN/, publicOrigin);
  }
  assert.equal(normalizePagesConfiguration({ internalUrl: "http://127.0.0.1:1", secret, publicOrigin: "http://127.0.0.1:8791" }).publicOrigin,
    "http://127.0.0.1:8791", "loopback page origins may use http for local development");
  assert.throws(() => normalizePagesConfiguration({ internalUrl: "ftp://pages", secret, publicOrigin: pagesOrigin }), /WORKFOLD_PAGES_INTERNAL_URL/);
  assert.throws(() => normalizePagesConfiguration({ internalUrl: "http://user:pass@pages", secret, publicOrigin: pagesOrigin }), /WORKFOLD_PAGES_INTERNAL_URL/);
  assert.equal(normalizePagesConfiguration(null), null);
});

test("the Published view reads pages, links, and entries as plain text", () => {
  assert.equal(String(clientPageIdPattern), String(pageIdPattern), "the client and the bridge agree on page ids");
  assert.equal(publishedPageLink(pagesOrigin, pageId), `${pagesOrigin}/p/${pageId}`);
  assert.equal(publishedPageLink(`${pagesOrigin}/`, pageId), `${pagesOrigin}/p/${pageId}`);
  assert.equal(publishedPageLink(pagesOrigin, "pg_../../admin"), "", "an id the bridge would refuse never becomes a link");
  assert.equal(publishedPageLink("javascript:alert(1)", pageId), "");
  assert.equal(publishedPageLink("not a url", pageId), "");
  assert.deepEqual([0, 1, 2, 12_345].map(entriesLabel), ["No entries", "1 entry", "2 entries", "12,345 entries"]);
  assert.equal(entriesLabel(undefined), "");
  assert.equal(humanizeName("first_course"), "First Course");
  assert.equal(cellText(true, "boolean"), "Yes");
  assert.equal(cellText(false, "boolean"), "No");
  assert.equal(cellText(1234.5, "number"), "1,234.5");
  assert.equal(cellText(null, "text"), "");
  assert.equal(cellText("2026-11-05", "date"), "Nov 5, 2026");
  assert.equal(cellText("<b>Ada</b>", "text"), "<b>Ada</b>", "text is returned for textContent-style escaping by the caller");
  assert.deepEqual(newestFirst([
    { id: "a", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "c", createdAt: "2026-11-03T00:00:00.000Z" },
    { id: "b", createdAt: "2026-11-02T00:00:00.000Z" },
  ]).map((row) => row.id), ["c", "b", "a"]);
  assert.equal(spreadsheetFileName("RSVP: Garden/Party?", "rsvps"), "RSVP Garden Party - Rsvps.csv");
});

test("every page route answers 503 until online pages are configured", async (context) => {
  const fixture = await pagesFixture(context, { pages: null });
  const device = await jsonRequest(`${fixture.baseUrl}/api/device/pages`, { headers: fixture.deviceHeaders });
  assert.equal(device.response.status, 503);
  assert.deepEqual(device.body, {
    ok: false,
    error: "Online pages aren't available yet.",
    code: "UNAVAILABLE",
    message: "Online pages aren't available yet.",
  });
  for (const [path, method] of [[`/api/device/pages/${pageId}`, "PUT"], [`/api/device/pages/${pageId}`, "DELETE"],
    [`/api/device/pages/${pageId}/data.sqlite`, "GET"], [`/api/device/pages/${pageId}/data/update`, "POST"]]) {
    const response = await fetch(`${fixture.baseUrl}${path}`, { method, headers: fixture.deviceHeaders, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal((await response.json()).error, "Online pages aren't available yet.");
  }

  const owner = await signIn(fixture);
  const list = await jsonRequest(fixture.ownerUrl("/api/pages"), { headers: owner.headers });
  assert.equal(list.response.status, 503);
  assert.equal(list.body.message, "Online pages aren't available yet.");
  const unpublish = await jsonRequest(fixture.ownerUrl(`/api/pages/${pageId}/unpublish`), { method: "POST", headers: owner.changeHeaders, body: {} });
  assert.equal(unpublish.response.status, 503);

  // Authentication still comes first: nobody learns anything without it.
  assert.equal((await fetch(`${fixture.baseUrl}/api/device/pages`)).status, 401);
  assert.equal((await fetch(fixture.ownerUrl("/api/pages"))).status, 401);
});

test("device page routes reach the page service with the secret and the device's account", async (context) => {
  const output = captureConsole(context);
  const fixture = await pagesFixture(context, {
    handler: async (record, response) => {
      if (record.method === "GET" && record.path.endsWith("/pages")) {
        return sendJson(response, 200, { pages: [{ pageId, title: "Garden Party RSVP", status: "online", entries: 3 }], internal: "dropped" });
      }
      if (record.method === "PUT") return sendJson(response, 200, { page: { pageId, title: "Garden Party RSVP", status: "online", revision: 1 } });
      if (record.method === "DELETE") return sendJson(response, 200, { page: { pageId, status: "unpublished" } });
      if (record.path.endsWith("/data.sqlite")) {
        response.writeHead(200, { "content-type": "application/vnd.sqlite3", "x-work-fold-data-revision": "7", "x-internal-detail": "dropped" });
        return response.end(Buffer.from("SQLite format 3\0snapshot", "binary"));
      }
      return sendJson(response, 200, { echoed: JSON.parse(record.body.toString("utf8")) });
    },
  });
  const accountPath = `/internal/accounts/${fixture.accountId}/pages`;

  const unauthorized = await fetch(`${fixture.baseUrl}/api/device/pages`, { headers: { authorization: "Bearer not-a-device-token" } });
  assert.equal(unauthorized.status, 401);
  assert.equal(fixture.pageService.requests.length, 0, "an unauthorized call never reaches the page service");

  const list = await jsonRequest(`${fixture.baseUrl}/api/device/pages`, { headers: fixture.deviceHeaders });
  assert.equal(list.response.status, 200);
  assert.equal(list.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(list.body, { pages: [{ pageId, title: "Garden Party RSVP", status: "online", entries: 3 }], pagesOrigin });
  assert.deepEqual(fixture.pageService.last(), { method: "GET", path: accountPath, query: "", secret, body: "" });

  const publishBody = JSON.stringify({ title: "Garden Party RSVP", html: "<!doctype html><p>Hi</p>", declaration: { format: "work-fold.page/1", title: "Garden Party RSVP" }, files: 3, contentDigest: "a".repeat(64) });
  const published = await fetch(`${fixture.baseUrl}/api/device/pages/${pageId}`, {
    method: "PUT",
    headers: { ...fixture.deviceHeaders, "content-type": "application/json" },
    body: publishBody,
  });
  assert.equal(published.status, 200);
  assert.deepEqual(await published.json(), { page: { pageId, title: "Garden Party RSVP", status: "online", revision: 1 }, pagesOrigin });
  assert.deepEqual(fixture.pageService.last(), { method: "PUT", path: `${accountPath}/${pageId}`, query: "", secret, body: publishBody });
  assert.match(fixture.pageService.requests.at(-1).headers["content-type"], /^application\/json/);

  const unpublished = await jsonRequest(`${fixture.baseUrl}/api/device/pages/${pageId}`, { method: "DELETE", headers: fixture.deviceHeaders });
  assert.equal(unpublished.response.status, 200);
  assert.equal(unpublished.body.page.status, "unpublished");
  assert.equal(fixture.pageService.last().method, "DELETE");
  assert.equal(fixture.pageService.last().path, `${accountPath}/${pageId}`);

  const snapshot = await fetch(`${fixture.baseUrl}/api/device/pages/${pageId}/data.sqlite`, { headers: fixture.deviceHeaders });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("x-work-fold-data-revision"), "7");
  assert.equal(snapshot.headers.get("content-type"), "application/vnd.sqlite3");
  assert.equal(snapshot.headers.get("x-internal-detail"), null, "only the documented headers pass through");
  assert.equal(snapshot.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from(await snapshot.arrayBuffer()).toString("binary"), "SQLite format 3\0snapshot");
  assert.equal(fixture.pageService.last().path, `${accountPath}/${pageId}/data.sqlite`);

  for (const action of ["update", "delete", "restore"]) {
    const body = action === "update" ? { table: "rsvps", id: "row-1", values: { guests: 2 } } : { table: "rsvps", ids: ["row-1", "row-2"] };
    const changed = await jsonRequest(`${fixture.baseUrl}/api/device/pages/${pageId}/data/${action}`, { method: "POST", headers: fixture.deviceHeaders, body });
    assert.equal(changed.response.status, 200, action);
    assert.deepEqual(changed.body.echoed, body);
    assert.equal(fixture.pageService.last().method, "POST");
    assert.equal(fixture.pageService.last().path, `${accountPath}/${pageId}/data/${action}`);
  }

  // Routes outside the contract, and the wrong method, are not proxied.
  const before = fixture.pageService.requests.length;
  for (const [path, method] of [[`/api/device/pages/${pageId}`, "GET"], [`/api/device/pages/${pageId}/data`, "GET"],
    [`/api/device/pages/${pageId}/data/export`, "GET"], [`/api/device/pages/${pageId}/data/purge`, "POST"], ["/api/device/pages", "POST"]]) {
    const response = await fetch(`${fixture.baseUrl}${path}`, { method, headers: fixture.deviceHeaders, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(fixture.pageService.requests.length, before);

  // A second desktop reaches only its own account's pages.
  const second = await enrollTestAccount(fixture.baseUrl, { slug: "pages-device-other", password: "another device password" }).catch(() => null);
  assert.equal(second, null, "pages- addresses stay reserved");
  const other = await enrollTestAccount(fixture.baseUrl, { slug: "other-publisher", password: "another device password" });
  await jsonRequest(`${fixture.baseUrl}/api/device/pages`, { headers: { authorization: `Bearer ${other.deviceToken}` } });
  assert.equal(fixture.pageService.last().path, `/internal/accounts/${other.account.id}/pages`);

  assert.equal(output.text().includes(pageId), false, "the bridge never logs a page id");
});

test("owner page routes need only a signed-in session, with same-origin and CSRF on unpublish", async (context) => {
  const output = captureConsole(context);
  const csv = "﻿name,guests\nAda,2\n";
  const fixture = await pagesFixture(context, {
    handler: async (record, response) => {
      if (record.method === "GET" && record.path.endsWith("/pages")) return sendJson(response, 200, { pages: [{ pageId, title: "Garden Party RSVP", status: "online", entries: 1 }] });
      if (record.path.endsWith("/data/export")) {
        response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="rsvps.csv"' });
        return response.end(csv);
      }
      if (record.path.endsWith("/data")) return sendJson(response, 200, { tables: [{ name: "rsvps", retired: false, limit: 50, live: 1, deleted: 0, newCount: 1, lastSeen: null }] });
      if (record.method === "DELETE") return sendJson(response, 200, { page: { pageId, status: "unpublished" } });
      return sendJson(response, 500, { error: "unexpected" });
    },
  });
  const owner = await signIn(fixture);
  const accountPath = `/internal/accounts/${fixture.accountId}/pages`;

  // Signed in, never paired, and no desktop connected.
  const list = await jsonRequest(fixture.ownerUrl("/api/pages"), { headers: owner.headers });
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.body, { pages: [{ pageId, title: "Garden Party RSVP", status: "online", entries: 1 }], pagesOrigin });
  assert.deepEqual(fixture.pageService.last(), { method: "GET", path: accountPath, query: "", secret, body: "" });

  const data = await jsonRequest(fixture.ownerUrl(`/api/pages/${pageId}/data`, "&table=rsvps&deleted=1&visitor=v_x&secret=nope"), { headers: owner.headers });
  assert.equal(data.response.status, 200);
  assert.equal(data.body.tables[0].name, "rsvps");
  assert.equal(fixture.pageService.last().path, `${accountPath}/${pageId}/data`);
  assert.equal(fixture.pageService.last().query, "?table=rsvps&deleted=1", "only table and deleted are passed on");

  const exported = await fetch(fixture.ownerUrl(`/api/pages/${pageId}/data/export`, "&table=rsvps&deleted=1"), { headers: owner.headers });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type"), /^text\/csv/);
  assert.equal(exported.headers.get("content-disposition"), 'attachment; filename="rsvps.csv"');
  assert.equal(Buffer.from(await exported.arrayBuffer()).toString("utf8"), csv);
  assert.equal(fixture.pageService.last().query, "?table=rsvps");

  const before = fixture.pageService.requests.length;
  const unpublishUrl = fixture.ownerUrl(`/api/pages/${pageId}/unpublish`);
  const noOrigin = await jsonRequest(unpublishUrl, { method: "POST", headers: { cookie: owner.cookie, "x-work-fold-csrf": owner.csrfToken }, body: {} });
  assert.equal(noOrigin.response.status, 403);
  const foreignOrigin = await jsonRequest(unpublishUrl, { method: "POST", headers: { ...owner.changeHeaders, origin: "http://evil.example" }, body: {} });
  assert.equal(foreignOrigin.response.status, 403);
  const noCsrf = await jsonRequest(unpublishUrl, { method: "POST", headers: { cookie: owner.cookie, origin: fixture.baseUrl }, body: {} });
  assert.equal(noCsrf.response.status, 403);
  const wrongCsrf = await jsonRequest(unpublishUrl, { method: "POST", headers: { ...owner.changeHeaders, "x-work-fold-csrf": "not-the-token" }, body: {} });
  assert.equal(wrongCsrf.response.status, 403);
  const signedOut = await jsonRequest(unpublishUrl, { method: "POST", headers: { origin: fixture.baseUrl, "x-work-fold-csrf": owner.csrfToken }, body: {} });
  assert.equal(signedOut.response.status, 401);
  assert.equal(fixture.pageService.requests.length, before, "refused unpublishes never reach the page service");
  const getUnpublish = await fetch(unpublishUrl, { headers: owner.headers });
  assert.equal(getUnpublish.status, 404, "unpublishing is a POST");

  const unpublished = await jsonRequest(unpublishUrl, { method: "POST", headers: owner.changeHeaders, body: {} });
  assert.equal(unpublished.response.status, 200);
  assert.equal(unpublished.body.page.status, "unpublished");
  assert.deepEqual(fixture.pageService.last(), { method: "DELETE", path: `${accountPath}/${pageId}`, query: "", secret, body: "" });

  // Without a session, or with another account's session, nothing is proxied.
  const count = fixture.pageService.requests.length;
  assert.equal((await fetch(fixture.ownerUrl("/api/pages"))).status, 401);
  assert.equal((await fetch(fixture.ownerUrl(`/api/pages/${pageId}/data`), { headers: { cookie: "work_fold_session=forged" } })).status, 401);
  await enrollTestAccount(fixture.baseUrl, { slug: "other-owner", password: "the other owner's password" });
  assert.equal((await fetch(`${fixture.baseUrl}/api/pages?slug=other-owner`, { headers: owner.headers })).status, 401,
    "a session for one address cannot read another address's pages");
  // The device token is not a browser session.
  assert.equal((await fetch(fixture.ownerUrl("/api/pages"), { headers: fixture.deviceHeaders })).status, 401);
  assert.equal(fixture.pageService.requests.length, count);

  assert.equal(output.text().includes(pageId), false, "the bridge never logs a page id");
});

test("page ids are validated before anything reaches the page service", async (context) => {
  const fixture = await pagesFixture(context, { handler: async (_record, response) => sendJson(response, 200, {}) });
  const owner = await signIn(fixture);
  const invalidIds = [
    "pg_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "pg_abcdefghijklmnopqrstuvwxy",
    "pg_abcdefghijklmnopqrstuvwxyz2",
    "pg_0bcdefghijklmnopqrstuvwxyz",
    "pg_abcdefghijklmnopqrstuvwxy%7A",
    "pg_abcdefghijklmnopqrstuvwxyz%2F..",
  ];
  for (const id of invalidIds) {
    for (const [path, init] of [
      [`/api/device/pages/${id}`, { method: "PUT", headers: fixture.deviceHeaders, body: "{}" }],
      [`/api/device/pages/${id}`, { method: "DELETE", headers: fixture.deviceHeaders }],
      [`/api/device/pages/${id}/data.sqlite`, { headers: fixture.deviceHeaders }],
      [`/api/device/pages/${id}/data/delete`, { method: "POST", headers: fixture.deviceHeaders, body: "{}" }],
    ]) {
      const response = await fetch(`${fixture.baseUrl}${path}`, init);
      assert.equal(response.status, 400, `${init.method ?? "GET"} ${path}`);
      const body = await response.json();
      assert.equal(body.code, "INVALID");
      assert.equal(body.message, "That page id isn't valid.");
    }
    for (const [path, init] of [
      [`/api/pages/${id}/data`, { headers: owner.headers }],
      [`/api/pages/${id}/data/export`, { headers: owner.headers }],
      [`/api/pages/${id}/unpublish`, { method: "POST", headers: owner.changeHeaders, body: "{}" }],
    ]) {
      const response = await fetch(fixture.ownerUrl(path), init);
      assert.equal(response.status, 400, `${init.method ?? "GET"} ${path}`);
    }
  }
  // Dot segments resolve before routing; whatever they land on is never proxied.
  for (const path of [`/api/device/pages/%2e%2e`, `/api/device/pages/${pageId}/%2e%2e/%2e%2e/accounts`, `/api/pages/%2e%2e/data`]) {
    const response = await fetch(`${fixture.baseUrl}${path}?slug=${fixture.slug}`, { headers: { ...fixture.deviceHeaders, ...owner.headers } });
    assert.notEqual(response.status, 200, path);
  }
  assert.equal(fixture.pageService.requests.length, 0);
});

test("page-service refusals pass through, and failures to reach it become a plain 502", async (context) => {
  const output = captureConsole(context);
  let mode = "refuse";
  const fixture = await pagesFixture(context, {
    handler: async (_record, response) => {
      if (mode === "refuse") {
        return sendJson(response, 404, { error: "Nothing is published here.", code: "NOT_FOUND", message: "Nothing is published here.", stack: "internal detail", pageId });
      }
      if (mode === "limit") return sendJson(response, 409, { error: "No more entries can be added.", code: "LIMIT_REACHED", message: "No more entries can be added.", field: "email" });
      if (mode === "html") {
        response.writeHead(500, { "content-type": "text/html" });
        return response.end(`<h1>crash at ${pageId}</h1>`);
      }
      if (mode === "redirect") {
        response.writeHead(302, { location: "http://elsewhere.example/" });
        return response.end();
      }
      if (mode === "secret") return sendJson(response, 401, { error: "Wrong secret.", code: "NOT_ALLOWED", message: "Wrong secret." });
      response.socket.destroy();
    },
  });
  const owner = await signIn(fixture);

  const refused = await jsonRequest(`${fixture.baseUrl}/api/device/pages/${pageId}`, { method: "DELETE", headers: fixture.deviceHeaders });
  assert.equal(refused.response.status, 404);
  assert.deepEqual(refused.body, { ok: false, error: "Nothing is published here.", code: "NOT_FOUND", message: "Nothing is published here." });

  mode = "limit";
  const limited = await jsonRequest(`${fixture.baseUrl}/api/device/pages/${pageId}/data/restore`, { method: "POST", headers: fixture.deviceHeaders, body: { table: "rsvps", ids: ["a"] } });
  assert.equal(limited.response.status, 409);
  assert.deepEqual(limited.body, { ok: false, error: "No more entries can be added.", code: "LIMIT_REACHED", message: "No more entries can be added.", field: "email" });

  for (const failing of ["html", "redirect", "secret", "reset"]) {
    mode = failing;
    const failed = await jsonRequest(fixture.ownerUrl(`/api/pages/${pageId}/data`), { headers: owner.headers });
    assert.equal(failed.response.status, 502, failing);
    assert.deepEqual(failed.body, {
      ok: false,
      error: "Online pages can't be reached right now. Try again in a moment.",
      code: "UNAVAILABLE",
      message: "Online pages can't be reached right now. Try again in a moment.",
    });
  }
  mode = "reset";
  const listFailed = await jsonRequest(`${fixture.baseUrl}/api/device/pages`, { headers: fixture.deviceHeaders });
  assert.equal(listFailed.response.status, 502);

  await fixture.pageService.close();
  const unreachable = await jsonRequest(fixture.ownerUrl("/api/pages"), { headers: owner.headers });
  assert.equal(unreachable.response.status, 502);
  assert.equal(unreachable.body.message, "Online pages can't be reached right now. Try again in a moment.");
  const publishUnreachable = await jsonRequest(`${fixture.baseUrl}/api/device/pages/${pageId}`, { method: "PUT", headers: fixture.deviceHeaders, body: { title: "x" } });
  assert.equal(publishUnreachable.response.status, 502);

  assert.match(output.text(), /the page service refused the internal secret/, "a wrong secret is an operator warning, never a 401 to the caller");
  assert.equal(output.text().includes(secret), false, "the warning never repeats the secret");
  assert.equal(output.text().includes(pageId), false, "neither the bridge nor its errors log a page id");
});

test("the 26 MiB limit applies only to publishing, and an oversized upload never completes", async (context) => {
  const fixture = await pagesFixture(context, {
    handler: async (record, response) => sendJson(response, 200, {
      page: { pageId, status: "online" },
      received: record.body.length,
      digest: createHash("sha256").update(record.body).digest("hex"),
    }),
  });
  const owner = await signIn(fixture);
  const url = `${fixture.baseUrl}/api/device/pages/${pageId}`;

  const exact = jsonPadding(maximumPagePublishBytes);
  const accepted = await upload(url, { headers: { ...fixture.deviceHeaders, "content-type": "application/json", "content-length": String(exact.length) }, body: exact });
  assert.equal(accepted.status, 200);
  const receipt = JSON.parse(accepted.body.toString("utf8"));
  assert.equal(receipt.received, maximumPagePublishBytes);
  assert.equal(receipt.digest, createHash("sha256").update(exact).digest("hex"), "the publish body arrives intact");

  const tooLarge = jsonPadding(maximumPagePublishBytes + 1);
  const declared = await upload(url, { headers: { ...fixture.deviceHeaders, "content-type": "application/json", "content-length": String(tooLarge.length) }, body: tooLarge });
  assert.equal(declared.status, 413);
  assert.equal(JSON.parse(declared.body.toString("utf8")).code, "TOO_LARGE");
  assert.equal(fixture.pageService.requests.length, 1, "a declared oversized upload is refused before the page service is called");

  // Without a declared length the bridge counts while it streams and stops
  // the forwarded upload at the bound.
  const chunks = Array.from({ length: 27 }, (_, index) => Buffer.alloc(1024 * 1024, 97 + (index % 26)));
  const streamed = await upload(url, { headers: { ...fixture.deviceHeaders, "content-type": "application/json" }, chunks });
  assert.equal(streamed.status, 413);
  assert.equal(JSON.parse(streamed.body.toString("utf8")).code, "TOO_LARGE");
  await waitFor(() => fixture.pageService.aborted.length === 1);
  assert.equal(fixture.pageService.requests.length, 1, "the page service never finished receiving the oversized upload");

  // Data changes take up to 8 MiB, like the page service, so deleting
  // thousands of entries at once fits; every other page route keeps 96 KiB.
  const large = { table: "rsvps", ids: Array.from({ length: 3_000 }, (_, index) => `row-${String(index).padStart(32, "0")}`) };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 96 * 1024);
  const change = await jsonRequest(`${url}/data/delete`, { method: "POST", headers: fixture.deviceHeaders, body: large });
  assert.notEqual(change.response.status, 413, "a large delete reaches the page service");
  assert.equal(fixture.pageService.requests.length, 2);
  const unpublish = await jsonRequest(fixture.ownerUrl(`/api/pages/${pageId}/unpublish`), { method: "POST", headers: owner.changeHeaders, body: large });
  assert.equal(unpublish.response.status, 413);
  const smallPublish = await jsonRequest(url, { method: "PUT", headers: fixture.deviceHeaders, body: large });
  assert.equal(smallPublish.response.status, 200, "the same body is fine as a publish");
  assert.equal(fixture.pageService.requests.length, 3);
});

test("snapshots and spreadsheets stream through without waiting for the whole file", async (context) => {
  const releases = [];
  const finished = [];
  const firstChunk = Buffer.alloc(256 * 1024, 1);
  const secondChunk = Buffer.alloc(512 * 1024, 2);
  const fixture = await pagesFixture(context, {
    handler: async (record, response) => {
      const csv = record.path.endsWith("/data/export");
      response.writeHead(200, csv
        ? { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="rsvps.csv"' }
        : { "content-type": "application/vnd.sqlite3", "x-work-fold-data-revision": "42" });
      response.write(firstChunk);
      await new Promise((resolve) => releases.push(resolve));
      response.end(secondChunk);
      finished.push(record.path);
    },
  });
  const owner = await signIn(fixture);

  for (const [url, headers] of [
    [`${fixture.baseUrl}/api/device/pages/${pageId}/data.sqlite`, fixture.deviceHeaders],
    [fixture.ownerUrl(`/api/pages/${pageId}/data/export`, "&table=rsvps"), owner.headers],
  ]) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let received = 0;
    while (received < firstChunk.length) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      received += value.length;
    }
    assert.equal(received, firstChunk.length, "the first bytes arrive while the page service is still sending");
    assert.equal(finished.length, releases.length - 1);
    releases.at(-1)();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
    }
    assert.equal(received, firstChunk.length + secondChunk.length);
  }
  assert.equal(finished.length, 2);
});

test("owner page routes are rate limited per account", async (context) => {
  const fixture = await pagesFixture(context, { handler: async (_record, response) => sendJson(response, 200, { page: { pageId, status: "unpublished" } }) });
  const owner = await signIn(fixture);
  for (let index = 0; index < 30; index += 1) {
    const response = await fetch(fixture.ownerUrl(`/api/pages/${pageId}/unpublish`), { method: "POST", headers: owner.changeHeaders, body: "{}" });
    assert.equal(response.status, 200);
  }
  const limited = await jsonRequest(fixture.ownerUrl(`/api/pages/${pageId}/unpublish`), { method: "POST", headers: owner.changeHeaders, body: {} });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.code, "UNAVAILABLE");
  assert.equal(fixture.pageService.requests.length, 30);
  const reading = await fetch(fixture.ownerUrl("/api/pages"), { headers: owner.headers });
  assert.equal(reading.status, 200, "reading keeps its own budget");
});

// --- Fixtures ------------------------------------------------------------

async function pagesFixture(context, { handler = async (_record, response) => sendJson(response, 200, {}), pages } = {}) {
  const pageService = await fakePageService(context, handler);
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const database = new BridgeDatabase({ pool });
  const service = await startBridgeServer({
    host: "127.0.0.1",
    port: 0,
    baseDomain: "work-fold.test",
    publicEnrollment: true,
    metrics: false,
    database,
    pages: pages === undefined ? { internalUrl: pageService.url, secret, publicOrigin: pagesOrigin } : pages,
  });
  context.after(async () => {
    await service.close();
    await pool.end();
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const slug = "garden-host";
  const password = "a garden party password";
  const enrolled = await enrollTestAccount(baseUrl, { slug, password });
  return {
    baseUrl,
    slug,
    password,
    pageService,
    accountId: enrolled.account.id,
    deviceHeaders: { authorization: `Bearer ${enrolled.deviceToken}` },
    ownerUrl: (path, extraQuery = "") => `${baseUrl}${path}?slug=${slug}${extraQuery}`,
  };
}

async function signIn(fixture) {
  const loggedIn = await jsonRequest(`${fixture.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin: fixture.baseUrl },
    body: { slug: fixture.slug, password: fixture.password },
  });
  assert.equal(loggedIn.response.status, 200);
  assert.equal(loggedIn.body.paired, false);
  assert.equal(loggedIn.body.desktopOnline, false);
  const cookie = loggedIn.response.headers.get("set-cookie").split(";", 1)[0];
  return {
    cookie,
    csrfToken: loggedIn.body.csrfToken,
    headers: { cookie },
    changeHeaders: { cookie, origin: fixture.baseUrl, "x-work-fold-csrf": loggedIn.body.csrfToken, "content-type": "application/json" },
  };
}

/** A stand-in for the page service's internal port that records every call. */
async function fakePageService(context, handler) {
  const requests = [];
  const aborted = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const target = new URL(request.url, "http://pages.internal");
    const chunks = [];
    try {
      for await (const chunk of request) chunks.push(chunk);
    } catch {
      aborted.push(target.pathname);
      return;
    }
    if (!request.complete) {
      aborted.push(target.pathname);
      return;
    }
    const record = {
      method: request.method,
      path: target.pathname,
      query: target.search,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(record);
    if (request.headers["x-work-fold-pages-secret"] !== secret) return sendJson(response, 401, { error: "Wrong secret." });
    try {
      await handler(record, response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  context.after(close);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    aborted,
    close,
    last() {
      const record = requests.at(-1);
      return {
        method: record.method,
        path: record.path,
        query: record.query,
        secret: record.headers["x-work-fold-pages-secret"],
        body: record.body.toString("utf8"),
      };
    },
  };
}

async function enrollTestAccount(baseUrl, { slug, password }) {
  const key = (use) => ({ ...generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" }), use });
  const enrolled = await jsonRequest(`${baseUrl}/api/device/enroll`, {
    method: "POST",
    body: { slug, password, deviceSigningPublicJwk: key("sig"), deviceEncryptionPublicJwk: key("enc") },
  });
  if (enrolled.response.status !== 201) throw new Error(`Enrollment failed: ${enrolled.response.status}`);
  return enrolled.body;
}

async function jsonRequest(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/** A JSON object padded to exactly `bytes` bytes. */
function jsonPadding(bytes) {
  const prefix = '{"html":"';
  const suffix = '"}';
  return Buffer.concat([Buffer.from(prefix), Buffer.alloc(bytes - prefix.length - suffix.length, 97), Buffer.from(suffix)]);
}

/**
 * An upload that keeps the response even when the bridge answers before the
 * body is sent and then closes the connection.
 */
function upload(url, { method = "PUT", headers, body, chunks }) {
  return new Promise((resolve, reject) => {
    let responded = false;
    const request = httpRequest(url, { method, headers }, (response) => {
      responded = true;
      const parts = [];
      response.on("data", (part) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
      response.on("error", reject);
    });
    request.on("error", (error) => { if (!responded) reject(error); });
    if (!chunks) {
      request.end(body);
      return;
    }
    (async () => {
      for (const chunk of chunks) {
        if (responded || request.destroyed) return;
        if (!request.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              request.off("drain", done);
              request.off("close", done);
              resolve();
            };
            request.on("drain", done);
            request.on("close", done);
          });
        }
      }
      if (!request.destroyed) request.end();
    })().catch(() => undefined);
  });
}

function captureConsole(context) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(original)) console[name] = (...values) => lines.push(values.map(String).join(" "));
  context.after(() => Object.assign(console, original));
  return { text: () => lines.join("\n") };
}

async function waitFor(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
