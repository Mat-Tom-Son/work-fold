import assert from "node:assert/strict";
import test from "node:test";

import {
  restrictedAppAutomationOutcomeLabel,
} from "../web-local/src/lib/restricted-app-automation.js";
import {
  restrictedAppAssistantTaskCanStop,
  restrictedAppAssistantTaskStatusLabel,
} from "../web-local/src/lib/restricted-app-assistant.js";

test("automation history distinguishes interrupted work from an explicit cancellation", () => {
  assert.equal(restrictedAppAutomationOutcomeLabel({ outcome: "cancelled", state: "cancelled" }), "Cancelled");
  assert.equal(
    restrictedAppAutomationOutcomeLabel({ outcome: "interrupted", state: "expired" }),
    "Interrupted — completion unknown",
  );
});

test("Assistant request rows show plain status words and offer Stop only while work can still be stopped", () => {
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "dispatching" }), "Starting");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "running" }), "Running");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "running", cancellationRequested: true }), "Stopping");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "succeeded" }), "Done");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "failed" }), "Failed");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "cancelled" }), "Stopped");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "interrupted" }), "Interrupted");
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "running" }), true);
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "dispatching" }), true);
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "running", cancellationRequested: true }), false);
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "succeeded" }), false);
});
