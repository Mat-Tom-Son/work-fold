import assert from "node:assert/strict";
import test from "node:test";

import { thinkingLevelLabel } from "../web-local/src/lib/thinking-levels.js";

test("reasoning level ids read as plain words", () => {
  assert.equal(thinkingLevelLabel("off"), "Off");
  assert.equal(thinkingLevelLabel("minimal"), "Minimal");
  assert.equal(thinkingLevelLabel("low"), "Low");
  assert.equal(thinkingLevelLabel("medium"), "Medium");
  assert.equal(thinkingLevelLabel("high"), "High");
  assert.equal(thinkingLevelLabel("xhigh"), "Extra high");
});

test("unknown reasoning level ids keep their text with a capital first letter", () => {
  assert.equal(thinkingLevelLabel("adaptive"), "Adaptive");
  assert.equal(thinkingLevelLabel("max-effort"), "Max-effort");
  assert.equal(thinkingLevelLabel(""), "");
});
