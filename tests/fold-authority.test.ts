import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FoldAuthorityError,
  FoldAuthorityStore,
  mintFoldAuthoritySettingsWriter,
  type FoldAuthoritySettingsWriter,
} from "../src/local/fold-authority.js";
import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { startLocalApi } from "../src/local/server.js";

test("fold authority defaults to Reviewed, persists journal-first, and fails closed on live tampering", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-authority-store-test-"));
  const path = join(sandbox, "fold", "authority.json");
  const journalPath = join(sandbox, "fold", "authority-changes.jsonl");
  try {
    const store = await FoldAuthorityStore.create({ path, journalPath });
    assert.deepEqual(await store.status(), {
      mode: "reviewed",
      revision: 0,
      updatedAt: null,
      damaged: false,
    });
    await assert.rejects(
      store.setMode(
        { lane: "desktop-settings", authority: "fold-root" } as FoldAuthoritySettingsWriter,
        "unrestricted",
      ),
      (error: unknown) => error instanceof FoldAuthorityError && error.code === "SETTINGS_ONLY",
      "a lookalike writer never changes root authority",
    );

    const writer = mintFoldAuthoritySettingsWriter();
    const unrestricted = await store.setMode(writer, "unrestricted");
    assert.equal(unrestricted.mode, "unrestricted");
    assert.equal(unrestricted.revision, 1);
    assert.equal((await store.setMode(writer, "unrestricted")).revision, 1, "a no-op does not journal a new revision");
    const journal = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(journal.map((entry) => [entry.from, entry.to, entry.revision]), [["reviewed", "unrestricted", 1]]);

    const reopened = await FoldAuthorityStore.create({ path, journalPath });
    assert.equal((await reopened.status()).mode, "unrestricted", "the machine-local choice survives restart");

    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...file, mode: "reviewed" }, null, 2)}\n`, "utf8");
    const damaged = await reopened.status();
    assert.equal(damaged.mode, "reviewed", "tampered authority always fails toward Reviewed");
    assert.equal(damaged.damaged, true);
    let ran = false;
    const inherited = await reopened.runIfUnrestricted(async () => { ran = true; });
    assert.equal(inherited.matched, false);
    assert.equal(ran, false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Settings Unrestricted mode executes new staged acts, including permanent deletion, with explicit receipts", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-authority-api-test-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    const initial = await getJson(api.origin, "/api/settings/fold-authority");
    assert.equal(initial.status, 200);
    assert.equal((initial.body as { status: { mode: string } }).status.mode, "reviewed");

    const widenedBody = await putJson(api.origin, "/api/settings/fold-authority", {
      mode: "reviewed",
      unexpected: true,
    });
    assert.equal(widenedBody.status, 400, "the root-authority route rejects unrecognized fields");

    const space = await api.actFacade.createSpace({ name: "Unrestricted Delete" });
    const alreadyPending = join(space.space.spaceRoot, "already-pending.txt");
    await writeFile(alreadyPending, "keep pending", "utf8");
    const waiting = await api.actFacade.filesDestroy({ space: space.space.id, paths: ["already-pending.txt"] });
    assert.equal(waiting.staged.state, "staged");

    const enabled = await putJson(api.origin, "/api/settings/fold-authority", { mode: "unrestricted" });
    assert.equal(enabled.status, 200);
    assert.equal((enabled.body as { status: { mode: string; revision: number } }).status.mode, "unrestricted");
    assert.equal(existsSync(alreadyPending), true, "changing the mode never drains an existing pending card");
    const decisionsAfterModeChange = (await getJson(api.origin, "/api/management/decisions")).body as {
      decisions: Array<{ id: string }>;
    };
    assert.equal(decisionsAfterModeChange.decisions.some((decision) => decision.id === waiting.staged.decisionId), true);
    await api.actFacade.stagedCancel({ id: waiting.staged.decisionId });

    const doomed = join(space.space.spaceRoot, "doomed.txt");
    await writeFile(doomed, "delete me", "utf8");
    const result = await api.actFacade.filesDestroy({ space: space.space.id, paths: ["doomed.txt"] });
    assert.equal(result.staged.state, "approved");
    assert.equal(result.staged.autoApproval?.basis, "unrestricted");
    assert.equal(result.staged.autoApproval?.executionOutcome, "executed");
    assert.equal(existsSync(doomed), false);
    assert.deepEqual((await getJson(api.origin, "/api/management/decisions")).body, { decisions: [] });

    const receipts = new WorkFoldCliActReceipts({ stateRoot: stateBase });
    const decisionLines = (await readFile(receipts.path, "utf8"))
      .trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.decisionId === result.staged.decisionId);
    assert.deepEqual(decisionLines.map((entry) => entry.outcome), ["accepted", "ok"]);
    for (const entry of decisionLines) {
      assert.equal(entry.surface, "unrestricted");
      assert.match(String(entry.detail), /Unrestricted authority/);
    }

    const reviewed = await putJson(api.origin, "/api/settings/fold-authority", { mode: "reviewed" });
    assert.equal((reviewed.body as { status: { mode: string } }).status.mode, "reviewed");
    await writeFile(doomed, "keep me", "utf8");
    const pending = await api.actFacade.filesDestroy({ space: space.space.id, paths: ["doomed.txt"] });
    assert.equal(pending.staged.state, "staged");
    assert.equal(existsSync(doomed), true);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an approved browser's management request inherits Unrestricted authority from the desktop", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-authority-remote-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; },
    },
  });
  try {
    await putJson(api.origin, "/api/settings/fold-authority", { mode: "unrestricted" });
    const space = await api.actFacade.createSpace({ name: "Remote Authority" });
    const bundlePath = join(sandbox, "SKILL.md");
    await writeFile(bundlePath, "---\nname: inherited\ndescription: remote inheritance test\n---\n\nUse carefully.\n", "utf8");
    const principal = { browserId: "browser-inherited", grantId: "grant-inherited", requestId: "request-inherited" };
    const sent = await api.remoteFacade.execute("management.send", { content: "/hold" }, principal) as { taskId: string };
    const installed = await api.actFacade.toolsImportSkill({
      scope: "space",
      space: space.space.id,
      from: bundlePath,
      cwd: sandbox,
      parentTaskId: sent.taskId,
    });
    assert.equal(installed.staged.autoApproval?.basis, "unrestricted");

    const receipts = new WorkFoldCliActReceipts({ stateRoot: stateBase });
    const lines = (await readFile(receipts.path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.decisionId === installed.staged.decisionId);
    for (const entry of lines) {
      assert.equal(entry.surface, "unrestricted");
      assert.equal(entry.browserId, principal.browserId);
      assert.equal(entry.grantId, principal.grantId);
    }
    await api.actFacade.manageStop({ taskId: sent.taskId });
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function getJson(origin: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, origin));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function putJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, origin), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
