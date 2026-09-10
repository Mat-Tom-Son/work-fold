import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
} from "../src/local/cli/index.js";
import type { WorkFoldCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

const token = "a".repeat(64);

type ReceiptEntry = Omit<WorkFoldCliActReceiptV3, "v" | "at">;

/**
 * End-to-end coverage of the formerly gated verbs through the installed act
 * lane: argv → executor → the real facade inside startLocalApi → the
 * prepared-act path — with the executor's own receipts capture proving every
 * verb executes on the first call, journals `accepted` before the effect and
 * a terminal line after, and stamps no decision id anywhere
 * (docs/receipts-not-gates.md, F19).
 */
async function directVerbHarness(prefix: string): Promise<{
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  execute: (argv: string[]) => ReturnType<typeof executeWorkFoldCliActRequest>;
  lastOk: () => ReceiptEntry;
  close: () => Promise<void>;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-direct-verbs-${prefix}-`));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  const records: ReceiptEntry[] = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveManagementLineageParent(taskId),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push(structuredClone(record));
          return true;
        },
      },
    },
  );
  return {
    sandbox,
    api,
    records,
    execute,
    lastOk: () => records.filter((record) => record.outcome === "ok").at(-1)!,
    close: async () => {
      await api.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

function errorCodeOf(stderr: string): string | undefined {
  try {
    return (JSON.parse(stderr) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

test("pages stage shares the page on the first call with receipts and no decision id", async () => {
  const h = await directVerbHarness("pages");
  try {
    const space = await h.api.actFacade.createSpace({ name: "Fold Space" });
    await writeFile(join(space.space.spaceRoot, "weekly.md"), "# Weekly\n\nAll clear.\n", "utf8");

    const shared = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "./weekly.md", "--title", "Weekly report", "--json"]);
    assert.equal(shared.exitCode, 0, shared.stderr);
    const sharedJson = JSON.parse(shared.stdout) as {
      ok: boolean;
      data: {
        publication: { publicationId: string; state: string; relativePath: string; snapshotEnabled: boolean; serveRatePerMinute: number; viewerPath: string };
        staged?: unknown;
      };
    };
    assert.equal(sharedJson.ok, true);
    assert.equal(sharedJson.data.publication.state, "active", "the page is shared on the first call");
    assert.equal(sharedJson.data.publication.relativePath, "weekly.md", "the pins carry the exact normalized relative path");
    assert.equal(sharedJson.data.publication.snapshotEnabled, false);
    assert.equal(sharedJson.data.publication.serveRatePerMinute, 60);
    assert.equal(sharedJson.data.staged, undefined, "no pending record exists");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal((h.lastOk() as { decisionId?: unknown }).decisionId, undefined, "receipts carry no decision id");
    assert.equal(h.lastOk().spaceId, space.space.id);
    assert.match(h.lastOk().detail ?? "", /^publish\.viewer\.expose; source weekly\.md; publication /);
    assert.deepEqual(h.lastOk().undoRef, { kind: "publicationId", value: sharedJson.data.publication.publicationId });
    const live = await h.api.publications.list();
    assert.equal(live.length, 1);
    assert.equal(live[0]?.publicationId, sharedJson.data.publication.publicationId);

    // A second identical call refuses: the page is already shared. The
    // refusal is journaled as an error under a fresh request id.
    h.records.length = 0;
    const again = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "weekly.md", "--title", "Weekly report", "--json"]);
    assert.notEqual(again.exitCode, 0);
    assert.equal(errorCodeOf(again.stderr), "conflict");
    assert.match(again.stderr, /already shared/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "error"]);
    assert.equal((await h.api.publications.list()).length, 1);

    // Sources the publication service could not serve refuse before anything
    // is exposed.
    await writeFile(join(space.space.spaceRoot, "tool.exe"), "bytes", "utf8");
    const badType = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "tool.exe", "--title", "Nope", "--json"]);
    assert.equal(errorCodeOf(badType.stderr), "usage");
    const missing = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "ghost.md", "--title", "Nope", "--json"]);
    assert.equal(errorCodeOf(missing.stderr), "notFound");
    assert.equal((await h.api.publications.list()).length, 1);

    // The human form names the address and where the link lives.
    await writeFile(join(space.space.spaceRoot, "notes.md"), "# Notes\n", "utf8");
    const human = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "notes.md", "--title", "Notes"]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /^Sharing "Notes" \(notes\.md\) from Fold Space \[[^\]]+\] at \/p\/[^.]+\. Reveal the link in Settings → The fold\.\n$/);

    // The pending-decision family and permanent deletion are unknown commands.
    for (const argv of [["staged", "list"], ["staged", "show"], ["files", "destroy"], ["routings", "stage"]]) {
      h.records.length = 0;
      const unknown = await h.execute(argv);
      assert.equal(unknown.exitCode, 2, `'${argv.join(" ")}' must be a usage error`);
      assert.match(unknown.stderr, /Unknown command/);
      assert.deepEqual(h.records, [], "an unknown command leaves no receipt");
    }
  } finally {
    await h.close();
  }
});

test("spaces delete deletes a managed folder on the first call, refuses a linked registration, and executes nothing for an inactive parent", async () => {
  const h = await directVerbHarness("spaces");
  try {
    const managed = await h.api.actFacade.createSpace({ name: "Managed" });
    await writeFile(join(managed.space.spaceRoot, "note.md"), "gone soon", "utf8");
    const deleted = await h.execute(["spaces", "delete", "--space", managed.space.id, "--json"]);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    const deletedJson = JSON.parse(deleted.stdout) as { data: { removed: boolean; storage: string; cleanupPending: boolean; staged?: unknown } };
    assert.equal(deletedJson.data.removed, true);
    assert.equal(deletedJson.data.storage, "managed");
    assert.equal(deletedJson.data.staged, undefined);
    assert.equal(existsSync(managed.space.spaceRoot), false, "the managed folder is deleted on the first call");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, "space.delete-folder");
    assert.equal(h.lastOk().spaceId, managed.space.id);

    // A linked registration is never deletable through this verb.
    const linkedRoot = join(h.sandbox, "linked-folder");
    await mkdir(linkedRoot, { recursive: true });
    const linked = await h.api.actFacade.registerSpace({ spaceRoot: linkedRoot });
    h.records.length = 0;
    const refused = await h.execute(["spaces", "delete", "--space", linked.space.id, "--json"]);
    assert.notEqual(refused.exitCode, 0);
    assert.equal(errorCodeOf(refused.stderr), "conflict");
    assert.match(refused.stderr, /Only a managed Space's folder can be deleted/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "error"]);
    assert.equal(existsSync(linkedRoot), true);

    // An inactive management parent is refused before anything is accepted,
    // and nothing executes.
    const other = await h.api.actFacade.createSpace({ name: "Other" });
    h.records.length = 0;
    const orphan = await h.execute(["spaces", "delete", "--space", other.space.id, "--parent-task", "task-inactive", "--json"]);
    assert.notEqual(orphan.exitCode, 0);
    assert.equal(errorCodeOf(orphan.stderr), "conflict");
    assert.match(orphan.stderr, /no longer active/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["rejected"]);
    assert.equal(existsSync(other.space.spaceRoot), true, "a refused act changes nothing");
  } finally {
    await h.close();
  }
});
