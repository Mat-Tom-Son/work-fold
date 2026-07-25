import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { searchWorkspace } from "../src/local/search.js";
import { configureWorkspaceStateRoot } from "../src/local/state-paths.js";
import { setWorkspaceIgnoreState } from "../src/local/workspace-ignore.js";

async function space(name: string): Promise<{ root: string; dispose: () => Promise<void> }> {
  const sandbox = await mkdtemp(join(tmpdir(), `workspace-search-${name}-`));
  const root = join(sandbox, "space");
  configureWorkspaceStateRoot(join(sandbox, "state"));
  await mkdir(root, { recursive: true });
  return {
    root,
    dispose: async () => {
      configureWorkspaceStateRoot(undefined);
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

test("search finds file contents and Chat messages with locating detail", async (t) => {
  const { root, dispose } = await space("basic");
  t.after(dispose);
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), "intro\nthe Quarterly budget is due\ntail", "utf8");
  await writeFile(join(root, "other.txt"), "nothing relevant here", "utf8");
  await appendMessage(root, "chat-1", {
    id: "m1",
    role: "user",
    content: "can you check the quarterly budget spreadsheet",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  await appendMessage(root, "chat-1", {
    id: "m2",
    role: "assistant",
    content: `${"context\n".repeat(40)}the quarterly budget is ready`,
    createdAt: "2026-07-01T00:01:00.000Z",
  });

  const result = await searchWorkspace(root, "quarterly budget");
  assert.deepEqual(result.files, [{
    path: "notes/plan.md",
    line: 2,
    preview: "the Quarterly budget is due",
  }], "a file match carries the path and line needed to open it");
  assert.equal(result.files.length, 1, "unrelated files do not match");
  assert.equal(result.chats.length, 2);
  assert.equal(result.chats[0]?.conversationId, "chat-1");
  assert.equal(result.chats[0]?.role, "user");
  assert.match(result.chats[0]?.preview ?? "", /quarterly budget spreadsheet/);
  assert.match(result.chats[1]?.preview ?? "", /quarterly budget is ready/, "preview indices are computed after whitespace normalization");
  assert.equal(result.truncated, false);
});

test("search honours ignore rules and skips binary and oversized files", async (t) => {
  const { root, dispose } = await space("bounds");
  t.after(dispose);
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor", "bundled.js"), "needle in ignored dependency", "utf8");
  await writeFile(join(root, "kept.txt"), "needle in ordinary content", "utf8");
  await writeFile(join(root, "image.bin"), Buffer.concat([Buffer.from("needle"), Buffer.alloc(64)]));
  await writeFile(join(root, "huge.txt"), `${"padding\n".repeat(200)}needle\n`, "utf8");

  await setWorkspaceIgnoreState(root, ["vendor"], true);
  const result = await searchWorkspace(root, "needle", { maxFileBytes: 64 });

  assert.deepEqual(result.files.map((match) => match.path), ["kept.txt"]);
  assert.equal(result.truncated, false, "skipping content by policy is not truncation");
});

test("search stops at its bounds and reports that it did", async (t) => {
  const { root, dispose } = await space("truncate");
  t.after(dispose);
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(root, `file-${index}.txt`), "needle\nneedle\n", "utf8");
  }

  const capped = await searchWorkspace(root, "needle", { maxMatches: 5 });
  assert.equal(capped.files.length, 5);
  assert.equal(capped.truncated, true, "hitting the match cap is disclosed");

  const scanned = await searchWorkspace(root, "needle", { maxScannedFiles: 2, maxMatches: 1_000 });
  assert.ok(scanned.scannedFiles <= 2);
  assert.equal(scanned.truncated, true, "hitting the scan cap is disclosed");
});

test("search rejects an empty or oversized query", async (t) => {
  const { root, dispose } = await space("invalid");
  t.after(dispose);
  await assert.rejects(() => searchWorkspace(root, "   "), /Enter something to search for/);
  await assert.rejects(() => searchWorkspace(root, "x".repeat(201)), /Search text is too long/);
});

test("search stops immediately when its caller is cancelled", async (t) => {
  const { root, dispose } = await space("cancelled");
  t.after(dispose);
  await writeFile(join(root, "note.txt"), "needle", "utf8");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => searchWorkspace(root, "needle", { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
