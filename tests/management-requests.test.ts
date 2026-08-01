import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ManagementRequestRegistry,
  managementAttachmentDispositions,
} from "../src/local/management-requests.js";

test("the request registry attributes actions only to an explicit management task", () => {
  const registry = new ManagementRequestRegistry();

  registry.begin({ taskId: "task-1", conversationId: "chat-1", content: "file this", attachments: [] });
  assert.equal(registry.isActive("task-1"), true);

  const attributed = registry.recordAction("task-1", {
    command: "chat.send",
    at: new Date().toISOString(),
    spaceId: "space-1",
    spaceName: "Target",
    conversationId: "chat-child",
    taskId: "task-child",
  });
  assert.equal(attributed, "task-1");
  assert.equal(registry.get("task-1")?.childTasks.length, 1);
  assert.equal(registry.get("task-1")?.childTasks[0]?.taskId, "task-child");

  // A concurrent turn does not make attribution ambiguous because the caller
  // carries the exact parent id instead of relying on ambient running state.
  registry.begin({ taskId: "task-2", conversationId: "chat-2", content: "also this", attachments: [] });
  assert.equal(registry.isActive("task-2"), true);
  const attributedSecond = registry.recordAction("task-2", {
    command: "spaces.create",
    at: new Date().toISOString(),
    spaceId: "space-2",
    spaceName: "Elsewhere",
  });
  assert.equal(attributedSecond, "task-2");
  assert.equal(registry.get("task-1")?.actions.length, 1);
  assert.equal(registry.get("task-2")?.actions.length, 1);
  assert.equal(registry.recordAction(undefined, {
    command: "spaces.create",
    at: new Date().toISOString(),
    spaceId: "space-3",
    spaceName: "Unrelated",
  }), null, "an unrelated CLI action is never inferred from ambient state");

  registry.finish("task-2", "succeeded");
  assert.equal(registry.isActive("task-2"), false);
  registry.finish("task-1", "aborted");
  assert.equal(registry.isActive("task-1"), false);
  assert.equal(registry.get("task-1")?.outcome, "aborted");
  assert.ok(registry.get("task-1")?.endedAt);
  assert.equal(registry.latest()?.taskId, "task-2");

  // Finishing twice never overwrites the first recorded outcome.
  registry.finish("task-1", "succeeded");
  assert.equal(registry.get("task-1")?.outcome, "aborted");
});

test("attachment dispositions account for every attachment and never guess", () => {
  const registry = new ManagementRequestRegistry();
  const record = registry.begin({
    taskId: "task-1",
    conversationId: "chat-1",
    content: "place these",
    attachments: [
      { kind: "file", target: "/tmp/report.pdf", name: "report.pdf" },
      { kind: "folder", target: "/tmp/project", name: "project" },
      { kind: "url", target: "https://example.com/repo", name: "example.com/repo" },
    ],
  });
  registry.recordAction("task-1", {
    command: "files.add",
    at: new Date().toISOString(),
    spaceId: "space-1",
    spaceName: "Vendor Audits",
    sources: ["/tmp/report.pdf"],
    copied: ["Inbox/report.pdf"],
    checkpointId: "cp-1",
  });
  registry.recordAction("task-1", {
    command: "spaces.register",
    at: new Date().toISOString(),
    spaceId: "space-2",
    spaceName: "Project",
    spaceRoot: "/tmp/project",
  });

  const dispositions = managementAttachmentDispositions(record);
  assert.equal(dispositions.length, 3, "every attachment appears in the story");
  assert.equal(dispositions[0]!.status, "placed");
  assert.equal(dispositions[0]!.spaceName, "Vendor Audits");
  assert.deepEqual(dispositions[0]!.copied, ["Inbox/report.pdf"]);
  assert.equal(dispositions[0]!.checkpointId, "cp-1");
  assert.equal(dispositions[1]!.status, "registered");
  assert.equal(dispositions[1]!.spaceName, "Project");
  assert.equal(dispositions[2]!.status, "unrecorded", "a link with no mechanical match stays honestly unrecorded");
});

test("a needs-you continuation preserves the request trail without replaying the old turn", () => {
  const registry = new ManagementRequestRegistry();
  registry.begin({
    taskId: "task-1",
    conversationId: "chat-1",
    content: "where should this go?",
    attachments: [{ kind: "file", target: "/tmp/report.pdf", name: "report.pdf" }],
  });
  registry.recordAction("task-1", {
    command: "spaces.create",
    at: new Date().toISOString(),
    spaceId: "space-1",
    spaceName: "Audits",
  });
  registry.finish("task-1", "succeeded");

  const continued = registry.begin({
    taskId: "task-2",
    conversationId: "chat-1",
    content: "Use Audits",
    attachments: [{ kind: "url", target: "https://example.com/context", name: "example.com/context" }],
    continuedFromTaskId: "task-1",
  });
  assert.equal(continued.continuedFromTaskId, "task-1");
  assert.deepEqual(continued.attachments.map((attachment) => attachment.kind), ["file", "url"]);
  assert.equal(continued.actions.length, 1);
  assert.equal(continued.content, "Use Audits");
});
