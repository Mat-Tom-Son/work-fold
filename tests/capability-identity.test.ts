import assert from "node:assert/strict";
import test from "node:test";

import { externalLinkHost } from "../web-local/src/lib/capability-identity.js";

test("external link hosts drop www and tolerate junk", () => {
  assert.equal(externalLinkHost("https://github.com/anthropics/skills"), "github.com");
  assert.equal(externalLinkHost("https://www.npmjs.com/package/x"), "npmjs.com");
  assert.equal(externalLinkHost("https://pi.dev/packages"), "pi.dev");
  assert.equal(externalLinkHost("not a url"), "");
});
