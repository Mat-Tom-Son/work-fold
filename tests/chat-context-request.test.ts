import assert from "node:assert/strict";
import test from "node:test";

import { chatContextRequestForTab } from "../web-local/src/lib/chat-context-request.js";

const request = {
  id: 7,
  path: "budget.csv",
  spaceId: "space-source",
  surfaceTabId: "chat:space-source:new:7",
};

test("a file attachment request reaches only its exact Space-bound Chat tab", () => {
  assert.equal(chatContextRequestForTab(request, "space-source", "chat:space-source:new:7"), request);
  assert.equal(chatContextRequestForTab(request, "space-target", "chat:space-source:new:7"), null);
  assert.equal(chatContextRequestForTab(request, "space-source", "chat:space-source:new:8"), null);
  assert.equal(chatContextRequestForTab(null, "space-source", "chat:space-source:new:7"), null);
});
