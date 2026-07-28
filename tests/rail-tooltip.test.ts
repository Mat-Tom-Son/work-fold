import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRailTooltipRequest,
  railTooltipNativeBounds,
} from "../src/shared/rail-tooltip.js";

test("rail tooltip requests stay bounded and reject unsupported renderer input", () => {
  assert.deepEqual(parseRailTooltipRequest({
    text: "Connected inbox · Sandboxed app · This Space",
    bounds: { x: 96, y: 112, width: 260, height: 28 },
    theme: "light",
  }), {
    text: "Connected inbox · Sandboxed app · This Space",
    bounds: { x: 96, y: 112, width: 260, height: 28 },
    theme: "light",
  });
  assert.throws(() => parseRailTooltipRequest({
    text: "Inbox",
    bounds: { x: 96, y: 112, width: 600, height: 28 },
    theme: "light",
  }), /width is invalid/);
  assert.throws(() => parseRailTooltipRequest({
    text: "Inbox",
    bounds: { x: 96, y: 112, width: 100, height: 28 },
    theme: "light",
    html: "<script>",
  }), /unsupported fields/);
});

test("rail tooltip native bounds respect zoom and window edges", () => {
  assert.deepEqual(
    railTooltipNativeBounds({ x: 100, y: 40, width: 220, height: 28 }, { width: 1_000, height: 700 }, 1.25),
    { x: 125, y: 50, width: 275, height: 35 },
  );
  assert.deepEqual(
    railTooltipNativeBounds({ x: 920, y: 680, width: 120, height: 28 }, { width: 1_000, height: 700 }, 1),
    { x: 920, y: 680, width: 80, height: 20 },
  );
});
