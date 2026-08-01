import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceCliActReceipts } from "../src/local/cli/index.js";

const bellCharacter = String.fromCharCode(7);
const replacementCharacter = String.fromCharCode(0xfffd);

test("act receipts append ordered JSON lines and rotate only aged entries", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-receipts-test-"));
  try {
    const startTime = Date.parse("2026-07-31T12:00:00.000Z");
    let currentTime = startTime;
    const receipts = new WorkspaceCliActReceipts({ stateRoot: sandbox, maxBytes: 512, now: () => new Date(currentTime) });
    const requestId = randomUUID();
    assert.equal(await receipts.append({
      requestId,
      command: "chat.send",
      spaceId: "space-1",
      conversationId: "chat-1",
      outcome: "ok",
      taskId: "task-1",
      detail: `accepted${bellCharacter}`,
    }), true);
    assert.equal(await receipts.append({ requestId: randomUUID(), command: "files.add", outcome: "error", errorCode: "conflict" }), true);

    const lines = (await readFile(receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      v: 1,
      at: new Date(startTime).toISOString(),
      requestId,
      command: "chat.send",
      spaceId: "space-1",
      conversationId: "chat-1",
      outcome: "ok",
      taskId: "task-1",
      detail: `accepted${replacementCharacter}`,
    });
    assert.equal(lines[1]?.errorCode, "conflict");

    // Size pressure alone must not rotate while entries are inside the broker
    // freshness window; once they age out, rotation resumes.
    for (let index = 0; index < 8; index += 1) {
      await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok", detail: "x".repeat(96) });
    }
    assert.equal(existsSync(receipts.rotatedPath), false, "fresh journal entries must hold rotation");
    currentTime = startTime + 6 * 60 * 1000;
    await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok" });
    assert.ok(existsSync(receipts.rotatedPath), "aged entries must rotate once the live file exceeds maxBytes");
    const liveLines = (await readFile(receipts.path, "utf8")).trim().split("\n");
    assert.ok(liveLines.length < 10, "rotation must move older lines aside");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("accepted records gate duplicate request ids across the broker freshness window", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-receipts-test-"));
  try {
    const startTime = Date.parse("2026-07-31T12:00:00.000Z");
    let currentTime = startTime;
    const receipts = new WorkspaceCliActReceipts({ stateRoot: sandbox, maxBytes: 256, now: () => new Date(currentTime) });
    const acceptedId = randomUUID();
    assert.equal(await receipts.hasAccepted(acceptedId), false, "an empty journal has no accepted records");
    await receipts.append({ requestId: acceptedId, command: "files.add", outcome: "accepted" });
    assert.equal(await receipts.hasAccepted(acceptedId), true);
    assert.equal(await receipts.hasAccepted(randomUUID()), false);

    // A terminal or rejected record alone must not read as executed.
    const rejectedId = randomUUID();
    await receipts.append({ requestId: rejectedId, command: "files.add", outcome: "rejected", errorCode: "unavailable" });
    assert.equal(await receipts.hasAccepted(rejectedId), false);

    // While the accepted record is inside the freshness window, size pressure
    // must not rotate it out of reach.
    for (let index = 0; index < 6; index += 1) {
      await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok", detail: "y".repeat(64) });
    }
    assert.equal(existsSync(receipts.rotatedPath), false, "fresh ledger entries must hold rotation");
    assert.equal(await receipts.hasAccepted(acceptedId), true);

    // After the window passes, a single rotation still keeps it findable in
    // the rotated file. Longer retention is unnecessary because the broker
    // refuses requests older than the freshness window anyway.
    currentTime = startTime + 6 * 60 * 1000;
    await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok" });
    assert.ok(existsSync(receipts.rotatedPath), "aged entries must rotate");
    assert.equal(await receipts.hasAccepted(acceptedId), true, "one rotation keeps the accepted record findable");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("receipt append failures report false instead of throwing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-receipts-test-"));
  try {
    const receipts = new WorkspaceCliActReceipts({ stateRoot: sandbox });
    // Occupy the receipts directory path with a regular file so mkdir fails.
    await rm(join(sandbox, "cli"), { recursive: true, force: true });
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(sandbox, "cli"), { recursive: true });
    await writeFile(join(sandbox, "cli", "receipts"), "not a directory", "utf8");
    assert.equal(await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok" }), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
