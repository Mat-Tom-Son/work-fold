import assert from "node:assert/strict";
import test from "node:test";

import { externalLinkHost, monogramHue, monogramInitials } from "../web-local/src/lib/capability-identity.js";

test("monogram initials read naturally for package-style, scoped, and camel-case names", () => {
  assert.equal(monogramInitials("brave-search"), "BS");
  assert.equal(monogramInitials("Anthropic Skills"), "AS");
  assert.equal(monogramInitials("@pi-work-fold/web-tools"), "WT");
  assert.equal(monogramInitials("piReview"), "PR");
  assert.equal(monogramInitials("gccli"), "GC");
  assert.equal(monogramInitials("last30days"), "LA");
  assert.equal(monogramInitials("---"), "?");
});

test("monogram hues are stable per name and drawn from a small distinct set", () => {
  const hues = new Set<number>();
  for (const name of ["brave-search", "browser-tools", "gccli", "gdcli", "gmcli", "Anthropic Skills", "research-workbench", "pi-web-tools"]) {
    const hue = monogramHue(name);
    assert.equal(monogramHue(name), hue, "deterministic");
    assert.equal(monogramHue(name.toUpperCase()), hue, "case-insensitive");
    hues.add(hue);
  }
  assert.ok(hues.size >= 4, "neighbouring catalog entries do not all collapse onto one hue");
  for (const hue of hues) assert.ok([212, 262, 322, 12, 36, 150, 180, 95].includes(hue));
});

test("external link hosts drop www and tolerate junk", () => {
  assert.equal(externalLinkHost("https://github.com/anthropics/skills"), "github.com");
  assert.equal(externalLinkHost("https://www.npmjs.com/package/x"), "npmjs.com");
  assert.equal(externalLinkHost("https://pi.dev/packages"), "pi.dev");
  assert.equal(externalLinkHost("not a url"), "");
});
