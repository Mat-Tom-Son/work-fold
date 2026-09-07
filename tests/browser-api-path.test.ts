import assert from "node:assert/strict";
import test from "node:test";
import { browserApiPath } from "../services/bridge/public/api-path.js";

test("loopback browser requests retain their selected account across all API lanes", () => {
  for (const host of ["localhost", "127.0.0.1"]) {
    const href = `http://${host}:4319/?slug=paired-qa`;
    for (const path of ["/api/auth/session", "/api/pairings", "/api/events", "/api/operations/one"]) {
      assert.equal(browserApiPath(path, href), `${path}?slug=paired-qa`);
    }
    assert.equal(browserApiPath("/api/public/context?slug=old&limit=2", href), "/api/public/context?slug=paired-qa&limit=2");
    assert.equal(browserApiPath("https://elsewhere.example/api/session", href), "https://elsewhere.example/api/session");
    assert.equal(browserApiPath("/app.js", href), "/app.js");
  }
  assert.equal(browserApiPath("/api/auth/session", "https://mine.work-fold.com/?slug=other"), "/api/auth/session");
  assert.equal(browserApiPath("/api/auth/session", "http://127.0.0.1:4319/"), "/api/auth/session");
});
