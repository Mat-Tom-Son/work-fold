import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { PAGE_FRAME_CONTENT_SECURITY_POLICY, PAGE_FRAME_HTML, PAGE_FRAME_SCRIPT } from "../src/local/pages/frame/page-frame-assets.js";
import { PAGE_SHELL_CSS, PAGE_SHELL_SCRIPT } from "../services/pages/src/shell.js";
import { newPageId, publishBody, rsvpDeclaration, startTestPageService } from "./support/page-service.js";

/**
 * What visitors reach on the page service's public port (docs/pages.md,
 * "Public routes"): the trusted shell and its policy, the document, page
 * calls with the visitor cookie and the declared rules, origin checks,
 * limits, the intermediary, health, and robots.txt.
 */

const directives = (policy: string | null) => new Map((policy ?? "").split("; ").map((directive) => [directive.split(" ")[0], directive]));

test("the shell runs the page under a strict policy", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId, publishBody({ title: "Garden <Party> & \"Friends\"" }));
  const shell = await pages.get(`/p/${pageId}`);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(shell.text, /<title>Garden &lt;Party&gt; &amp; &quot;Friends&quot;<\/title>/u);
  assert.match(shell.text, /<script src="\/page-shell\.js" defer><\/script>/u);
  assert.match(shell.text, /<link rel="stylesheet" href="\/page-shell\.css">/u);
  assert.equal([...shell.text.matchAll(/<script/gu)].length, 1, "no inline script");
  assert.doesNotMatch(shell.text, /style=|<style/u, "no inline style");
  const policy = directives(shell.headers.get("content-security-policy"));
  assert.equal(policy.get("default-src"), "default-src 'none'");
  assert.equal(policy.get("script-src"), "script-src 'self'");
  assert.equal(policy.get("style-src"), "style-src 'self'");
  assert.equal(policy.get("connect-src"), "connect-src 'self'");
  assert.equal(policy.get("frame-src"), "frame-src 'self'");
  assert.equal(policy.get("frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(policy.get("form-action"), "form-action 'none'");
  assert.equal(policy.get("base-uri"), "base-uri 'none'");
  assert.doesNotMatch(shell.headers.get("content-security-policy")!, /unsafe|https?:|\*/u);
  assert.equal(shell.headers.get("x-frame-options"), "DENY");
  assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  assert.equal(shell.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.match(shell.headers.get("permissions-policy") ?? "", /camera=\(\), microphone=\(\), geolocation=\(\)/u);
  assert.equal(shell.headers.get("set-cookie"), null, "the visitor cookie comes with the first call");
  assert.equal(shell.headers.get("strict-transport-security"), null, "no HSTS on loopback");
  assert.equal((await pages.get(`/p/${pageId}/`)).status, 200);

  const script = await pages.get("/page-shell.js");
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(script.text, PAGE_SHELL_SCRIPT);
  const etag = script.headers.get("etag")!;
  assert.equal((await pages.get("/page-shell.js", { "if-none-match": etag })).status, 304);
  assert.equal((await pages.get("/page-shell.css")).text, PAGE_SHELL_CSS);
  new Function(PAGE_SHELL_SCRIPT);

  const frame = await pages.get("/page-frame.html");
  assert.equal(frame.text, PAGE_FRAME_HTML);
  const framePolicy = frame.headers.get("content-security-policy")!;
  assert.ok(framePolicy.startsWith(PAGE_FRAME_CONTENT_SECURITY_POLICY), "the intermediary keeps the desktop's policy");
  assert.equal(directives(framePolicy).get("sandbox"), "sandbox allow-scripts allow-forms");
  assert.equal(directives(framePolicy).get("webrtc"), "webrtc 'block'", "and closes WebRTC where browsers support it");
  assert.equal(frame.headers.get("x-frame-options"), "SAMEORIGIN");
  const frameScript = await pages.get("/page-frame.js");
  assert.equal(frameScript.text, PAGE_FRAME_SCRIPT);
  assert.equal(frameScript.headers.get("content-security-policy"), framePolicy);
});

test("the document is the active revision's, with what the form helper needs", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);
  const document = await pages.get(`/p/${pageId}/document`);
  assert.equal(document.status, 200);
  assert.deepEqual(document.body, {
    html: publishBody().html,
    title: "Garden Party RSVP",
    tables: { rsvps: { name: "text", email: "email", note: "long-text" } },
  });
  assert.equal(document.headers.get("cache-control"), "no-cache");
  const etag = document.headers.get("etag")!;
  assert.equal((await pages.get(`/p/${pageId}/document`, { "if-none-match": etag })).status, 304);

  await pages.publish(pageId, publishBody({ html: "<p>Changed</p>", contentDigest: "sha256:0000000000000002" }));
  const changed = await pages.get(`/p/${pageId}/document`, { "if-none-match": etag });
  assert.equal(changed.status, 200, "a new revision is a new document");
  assert.equal(changed.body.html, "<p>Changed</p>");
  const missing = await pages.get(`/p/${newPageId()}/document`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "UNAVAILABLE");
  assert.equal(missing.body.message, "Nothing is published here.");
});

test("the first call makes the visitor cookie, and visitors stay apart", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);

  const first = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } });
  assert.equal(first.status, 200);
  assert.match(first.setCookie!, new RegExp(`^wfv=v_[0-9a-f]{32}; Path=/p/${pageId}; Max-Age=34560000; HttpOnly; SameSite=Lax$`, "u"));
  assert.deepEqual(Object.keys(first.body.result).sort(), ["createdAt", "email", "id", "name", "note", "updatedAt"], "visitors never see visitor ids");
  const again = await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: first.cookie });
  assert.equal(again.cookie, first.cookie, "a returning visitor keeps their id");
  assert.deepEqual(again.body.result.map((row: { name: string }) => row.name), ["Ada"]);
  assert.equal(again.body.result[0].visitor, undefined);

  const second = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo", email: "bo@example.com" } });
  assert.notEqual(second.cookie, first.cookie);
  assert.deepEqual((await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: second.cookie })).body.result.map((row: { name: string }) => row.name), ["Bo"]);
  assert.deepEqual((await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: first.cookie })).body.result.map((row: { name: string }) => row.name), ["Ada"]);
  const otherRow = await pages.call(pageId, { op: "update", table: "rsvps", id: first.body.result.id, values: { note: "hi" } }, { cookie: second.cookie });
  assert.equal(otherRow.status, 403);
  assert.equal(otherRow.body.code, "NOT_ALLOWED");

  for (const forged of ["wfv=owner", "wfv=v_123", `wfv=${"v_".padEnd(34, "Z")}`, "wfv="]) {
    const answer = await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: forged });
    assert.deepEqual(answer.body.result, [], forged);
    assert.match(answer.cookie!, /^wfv=v_[0-9a-f]{32}$/u, "a malformed cookie is replaced");
  }
  assert.equal((await pages.call(pageId, { op: "isOwner", table: "rsvps" })).body.result, false, "online, the viewer is never the owner");

  const secure = await new Promise<string>((resolve, reject) => {
    const url = new URL(`${pages.service.publicUrl}/p/${pageId}/call`);
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { host: "pages.example.com", "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(String(res.headers["set-cookie"]?.[0] ?? ""));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ call: { op: "count", table: "rsvps" } }));
  });
  assert.match(secure, /; Secure$/u, "Secure everywhere but loopback");
});

test("visitors are held to the page's declared rules", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  const declaration = rsvpDeclaration({
    tables: {
      rsvps: { columns: { name: { type: "text", required: true } }, visitors: ["add"], limit: 2 },
      board: { columns: { message: { type: "text" } }, visitors: ["see-all"] },
    },
  });
  await pages.publish(pageId, publishBody({ declaration }));
  const visitor = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada" } });
  assert.equal(visitor.status, 200);
  const cookie = visitor.cookie;
  const expectations: Array<[unknown, number, string]> = [
    [{ op: "mine", table: "rsvps" }, 403, "NOT_ALLOWED"],
    [{ op: "list", table: "rsvps" }, 403, "NOT_ALLOWED"],
    [{ op: "remove", table: "rsvps", id: visitor.body.result.id }, 403, "NOT_ALLOWED"],
    [{ op: "add", table: "board", values: { message: "hi" } }, 403, "NOT_ALLOWED"],
    [{ op: "add", table: "rsvps", values: {} }, 400, "INVALID"],
    [{ op: "add", table: "nope", values: {} }, 404, "NOT_FOUND"],
    [{ op: "drop", table: "rsvps" }, 400, "INVALID"],
    ["not a call", 400, "INVALID"],
  ];
  for (const [pageCall, status, code] of expectations) {
    const answer = await pages.call(pageId, pageCall, { cookie });
    assert.equal(answer.status, status, JSON.stringify(pageCall));
    assert.equal(answer.body.code, code, JSON.stringify(pageCall));
    assert.equal(typeof answer.body.message, "string");
  }
  assert.equal((await pages.call(pageId, { op: "count", table: "rsvps" }, { cookie })).body.result, 1, "anyone can count");
  assert.deepEqual((await pages.call(pageId, { op: "list", table: "board" }, { cookie })).body.result, []);
  await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo" } });
  const full = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Cy" } });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, "LIMIT_REACHED");
  const huge = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "x".repeat(1024 * 1024) } });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.code, "TOO_LARGE");
});

test("page calls come only from the page's own origin", async (t) => {
  const pages = await startTestPageService(t, { publicOrigin: "https://pages.example.com", limits: { maxCallBytes: 4096 } });
  const pageId = newPageId();
  await pages.publish(pageId);
  const count = { op: "count", table: "rsvps" };
  const origin = new URL(pages.service.publicUrl).origin;
  const allowed: Array<Record<string, string>> = [{ origin }, { origin: "https://pages.example.com" }, { "sec-fetch-site": "same-origin", origin }];
  for (const headers of allowed) {
    assert.equal((await pages.call(pageId, count, { headers })).status, 200, JSON.stringify(headers));
  }
  const refusedHeaders: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: `${origin.replace("http:", "https:")}1` }];
  for (const headers of refusedHeaders) {
    const refused = await pages.call(pageId, count, { headers });
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.equal(refused.body.code, "NOT_ALLOWED");
    assert.equal(refused.setCookie, null);
  }
  const form = await fetch(`${pages.service.publicUrl}/p/${pageId}/call`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ call: count }) });
  assert.equal(form.status, 415, "a plain HTML form can't post a call");
  const large = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "x".repeat(5000), email: "a@example.com" } });
  assert.equal(large.status, 413);
  assert.equal(large.body.code, "TOO_LARGE");
});

test("calls are limited per address and per page", async (t) => {
  const pages = await startTestPageService(t, { trustProxy: true, limits: { callsPerAddressPerMinute: 3, callsPerPagePerMinute: 5 } });
  const pageId = newPageId();
  const otherPageId = newPageId();
  await pages.publish(pageId);
  await pages.publish(otherPageId);
  const count = { op: "count", table: "rsvps" };
  const from = (address: string) => ({ headers: { "x-real-ip": address } });
  for (let index = 0; index < 3; index += 1) assert.equal((await pages.call(pageId, count, from("203.0.113.1"))).status, 200);
  const overAddress = await pages.call(pageId, count, from("203.0.113.1"));
  assert.equal(overAddress.status, 429);
  assert.equal(overAddress.body.code, "UNAVAILABLE");
  assert.match(overAddress.body.message, /Try again in a minute/u);
  assert.equal(overAddress.headers.get("retry-after"), "60");
  assert.equal((await pages.call(otherPageId, count, from("203.0.113.1"))).status, 429, "the address limit covers every page");

  for (let index = 0; index < 2; index += 1) assert.equal((await pages.call(pageId, count, from("203.0.113.2"))).status, 200);
  const overPage = await pages.call(pageId, count, from("203.0.113.3"));
  assert.equal(overPage.status, 429, "600 a minute per page, here 5");
  assert.equal((await pages.call(otherPageId, count, from("203.0.113.3"))).status, 200, "another page has its own budget");
});

test("health, robots.txt, and anything else", async (t) => {
  const pages = await startTestPageService(t);
  const health = await pages.get("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, service: "work-fold-pages", internal: "on", backups: { enabled: false } });
  const robots = await pages.get("/robots.txt");
  assert.equal(robots.text, "User-agent: *\nDisallow: /\n");
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
  const notFound = await pages.get(`/p/${newPageId()}`);
  for (const path of ["/", "/index.html", "/p", "/p/", "/internal/accounts", "/p/x/y/z"]) {
    const answer = await pages.get(path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.text, notFound.text, path);
  }
  const head = await fetch(`${pages.service.publicUrl}/robots.txt`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
