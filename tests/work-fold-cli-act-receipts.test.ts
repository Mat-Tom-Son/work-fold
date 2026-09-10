import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WORKFOLD_CLI_ACT_LEGACY_SURFACES, WORKFOLD_CLI_ACT_SURFACES, WorkFoldCliActReceipts, WorkFoldCliError } from "../src/local/cli/index.js";

const bellCharacter = String.fromCharCode(7);
const replacementCharacter = String.fromCharCode(0xfffd);

test("act receipts append ordered JSON lines and rotate only aged entries", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-receipts-test-"));
  try {
    const startTime = Date.parse("2026-07-31T12:00:00.000Z");
    let currentTime = startTime;
    const receipts = new WorkFoldCliActReceipts({ stateRoot: sandbox, maxBytes: 512, now: () => new Date(currentTime) });
    const requestId = randomUUID();
    assert.equal(await receipts.append({
      requestId,
      command: "chat.send",
      spaceId: "space-1",
      conversationId: "chat-1",
      outcome: "ok",
      taskId: "task-1",
      detail: `accepted${bellCharacter}`,
      surface: "remote_web",
      browserId: "browser-1",
      grantId: "grant-1",
      undoRef: { kind: "title", value: `Old title${bellCharacter}` },
    }), true);
    assert.equal(await receipts.append({ requestId: randomUUID(), command: "files.add", outcome: "error", errorCode: "conflict" }), true);

    const lines = (await readFile(receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      v: 3,
      at: new Date(startTime).toISOString(),
      requestId,
      command: "chat.send",
      spaceId: "space-1",
      conversationId: "chat-1",
      outcome: "ok",
      taskId: "task-1",
      detail: `accepted${replacementCharacter}`,
      surface: "remote_web",
      browserId: "browser-1",
      grantId: "grant-1",
      undoRef: { kind: "title", value: `Old title${replacementCharacter}` },
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
    const receipts = new WorkFoldCliActReceipts({ stateRoot: sandbox, maxBytes: 256, now: () => new Date(currentTime) });
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
    const receipts = new WorkFoldCliActReceipts({ stateRoot: sandbox });
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

test("readers accept version 1 and 2 lines beside version 3 appends", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-receipts-v1-test-"));
  try {
    const receipts = new WorkFoldCliActReceipts({ stateRoot: sandbox });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const versionOneId = randomUUID();
    const versionTwoId = randomUUID();
    await mkdir(dirname(receipts.path), { recursive: true });
    // A version 2 line an older build wrote for a gated act: it still carries
    // a decision id, a policy id, and a legacy surface. It stays readable
    // history and still gates a replay of its request id.
    await writeFile(
      receipts.path,
      `${JSON.stringify({ v: 1, at: "2026-07-31T12:00:00.000Z", requestId: versionOneId, command: "files.add", outcome: "accepted" })}\n`
        + `${JSON.stringify({
          v: 2, at: "2026-07-31T12:01:00.000Z", requestId: versionTwoId, command: "decision.approve", outcome: "accepted",
          surface: "unrestricted", decisionId: "act-1", policyId: "policy-1", detail: "space.delete-folder (destroy)",
        })}\n`,
      "utf8",
    );
    assert.equal(await receipts.hasAccepted(versionOneId), true, "a version 1 accepted record must keep gating replays");
    assert.equal(await receipts.hasAccepted(versionTwoId), true, "a version 2 decision record must keep gating replays");

    const versionThreeId = randomUUID();
    await receipts.append({ requestId: versionThreeId, command: "chat.send", outcome: "accepted", surface: "cli" });
    assert.equal(await receipts.hasAccepted(versionThreeId), true);
    assert.equal(await receipts.hasAccepted(randomUUID()), false);
    const lines = (await readFile(receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line.v), [1, 2, 3], "append writes the current version beside the older lines");
    assert.equal("decisionId" in lines[2]!, false, "a version 3 line carries no decision id");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the recorded surface vocabulary is the closed four-value set", () => {
  assert.deepEqual([...WORKFOLD_CLI_ACT_SURFACES], ["cli", "popover", "main-window", "remote_web"]);
  // The two surfaces older builds wrote on decision receipts are read-only history.
  assert.deepEqual([...WORKFOLD_CLI_ACT_LEGACY_SURFACES], ["policy", "unrestricted"]);
});

test("a damaged receipt ledger fails closed instead of permitting a replay", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-receipts-damaged-test-"));
  try {
    const receipts = new WorkFoldCliActReceipts({ stateRoot: sandbox });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(receipts.path), { recursive: true });
    await writeFile(receipts.path, "{damaged journal line\n", "utf8");
    await assert.rejects(
      () => receipts.hasAccepted(randomUUID()),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "failure"
        && /verify the act receipt journal/.test(error.message),
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
