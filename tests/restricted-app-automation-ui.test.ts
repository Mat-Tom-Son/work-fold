import assert from "node:assert/strict";
import test from "node:test";

import {
  restrictedAppAutomationOutcomeLabel,
} from "../web-local/src/lib/restricted-app-automation.js";

test("automation history distinguishes interrupted work from an explicit cancellation", () => {
  assert.equal(restrictedAppAutomationOutcomeLabel({ outcome: "cancelled", state: "cancelled" }), "Cancelled");
  assert.equal(
    restrictedAppAutomationOutcomeLabel({ outcome: "interrupted", state: "expired" }),
    "Interrupted — completion unknown",
  );
});
