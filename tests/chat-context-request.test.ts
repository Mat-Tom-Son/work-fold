import assert from "node:assert/strict";
import test from "node:test";

import { chatContextRequestForTab } from "../web-local/src/lib/chat-context-request.js";

const request = {
  id: 7,
  path: "budget.csv",
  workFolderId: "work-folder-source",
  surfaceTabId: "chat:work-folder-source:new:7",
};

test("a file attachment request reaches only its exact work-folder-bound Chat tab", () => {
  assert.equal(chatContextRequestForTab(request, "work-folder-source", "chat:work-folder-source:new:7"), request);
  assert.equal(chatContextRequestForTab(request, "work-folder-target", "chat:work-folder-source:new:7"), null);
  assert.equal(chatContextRequestForTab(request, "work-folder-source", "chat:work-folder-source:new:8"), null);
  assert.equal(chatContextRequestForTab(null, "work-folder-source", "chat:work-folder-source:new:7"), null);
});
