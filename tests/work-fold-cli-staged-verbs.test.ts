import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
} from "../src/local/cli/index.js";
import type { WorkFoldCliActReceiptV2 } from "../src/local/cli/act-receipts.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

const token = "a".repeat(64);

type ReceiptEntry = Omit<WorkFoldCliActReceiptV2, "v" | "at">;

/**
 * End-to-end staged-verb coverage through the installed act lane: argv →
 * executor → the real facade inside startLocalApi → the staged-act store —
 * with the executor's own receipts capture proving the staging receipts stamp
 * `decisionId` per receipts v2 (docs/fold-act-ledger.md), and `staged
 * list|show|cancel` reading and settling the same machine-local store
 * (docs/fold-consecrations.md).
 */
async function stagedVerbHarness(prefix: string): Promise<{
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  execute: (argv: string[]) => ReturnType<typeof executeWorkFoldCliActRequest>;
  lastOk: () => ReceiptEntry;
  close: () => Promise<void>;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-staged-verbs-${prefix}-`));
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

test("pages stage composes pins from live state; staged list, show, and cancel run over the store with receipts", async () => {
  const h = await stagedVerbHarness("pages");
  try {
    const space = await h.api.actFacade.createSpace({ name: "Fold Space" });
    await writeFile(join(space.space.spaceRoot, "weekly.md"), "# Weekly\n\nAll clear.\n", "utf8");

    const staged = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "./weekly.md", "--title", "Weekly report", "--json"]);
    assert.equal(staged.exitCode, 0, staged.stderr);
    const stagedJson = JSON.parse(staged.stdout) as {
      ok: boolean;
      data: {
        staged: { decisionId: string; kind: string; category: string; state: string; deduplicated: boolean };
        relativePath: string;
        snapshotEnabled: boolean;
        serveRatePerMinute: number;
        byteBudgetPerDay: number;
      };
    };
    assert.equal(stagedJson.ok, true);
    assert.equal(stagedJson.data.staged.kind, "publish.viewer.expose");
    assert.equal(stagedJson.data.staged.category, "widen-power");
    assert.equal(stagedJson.data.staged.state, "staged");
    assert.equal(stagedJson.data.staged.deduplicated, false);
    assert.equal(stagedJson.data.relativePath, "weekly.md", "the pins carry the exact normalized relative path");
    assert.equal(stagedJson.data.snapshotEnabled, false);
    const decisionId = stagedJson.data.staged.decisionId;
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().decisionId, decisionId, "the staging receipt stamps decisionId per receipts v2");
    assert.equal(h.lastOk().spaceId, space.space.id);
    assert.match(h.lastOk().detail ?? "", /^staged publish\.viewer\.expose; source weekly\.md; serveRatePerMinute=60 /);

    // The staged act is real, inert store state — not model prose.
    const act = await h.api.stagedActs.get(decisionId);
    assert.equal(act?.state, "staged");
    assert.equal(act?.pins.title, "Weekly report");
    assert.equal(act?.provenance.stagedVia, "act-cli");
    assert.ok(act?.provenance.requestId, "the staging act's journal id is the provenance request id");

    // Identical pins dedupe onto the existing card instead of a second one.
    const duplicate = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "weekly.md", "--title", "Weekly report", "--json"]);
    const duplicateJson = JSON.parse(duplicate.stdout) as { data: { staged: { decisionId: string; deduplicated: boolean } } };
    assert.equal(duplicateJson.data.staged.decisionId, decisionId);
    assert.equal(duplicateJson.data.staged.deduplicated, true);
    assert.match(duplicate.stdout, /"deduplicated": true/);

    // A source the publication service could not serve refuses at staging.
    await writeFile(join(space.space.spaceRoot, "tool.exe"), "bytes", "utf8");
    const badType = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "tool.exe", "--title", "Nope"]);
    assert.equal(badType.exitCode, 2);
    assert.match(badType.stderr, /Only Markdown, plain text, PNG, JPEG, and PDF files/);
    const missing = await h.execute(["pages", "stage", "--space", space.space.id, "--path", "ghost.md", "--title", "Nope"]);
    assert.equal(missing.exitCode, 3);

    // staged list renders the pending card; staged show renders the exact
    // host-composed facts, provenance, and the surface rules.
    const listed = await h.execute(["staged", "list"]);
    assert.match(listed.stdout, /1 staged act \(1 pending a decision\):/);
    assert.match(listed.stdout, new RegExp(`- ${decisionId} — publish\\.viewer\\.expose \\(widen-power\\) — expires `));
    const shown = await h.execute(["staged", "show", "--id", decisionId, "--json"]);
    const shownJson = JSON.parse(shown.stdout) as {
      data: {
        act: {
          id: string;
          pins: Record<string, unknown>;
          provenance: { stagedVia: string };
          restrictions: { desktopOnly: boolean };
        };
      };
    };
    assert.equal(shownJson.data.act.id, decisionId);
    assert.equal(shownJson.data.act.pins.relativePath, "weekly.md");
    assert.equal(shownJson.data.act.pins.byteBudget, 268435456);
    assert.equal(shownJson.data.act.provenance.stagedVia, "act-cli");
    assert.equal(shownJson.data.act.restrictions.desktopOnly, false);
    const shownHuman = await h.execute(["staged", "show", "--id", decisionId]);
    assert.match(shownHuman.stdout, /grants a standing power/);
    assert.match(shownHuman.stdout, /relativePath: weekly\.md/);
    assert.match(shownHuman.stdout, /Deciding happens on a work-fold decision surface; the act lane can only cancel\./);

    // Cancel settles the card exactly once; the receipt names it, a second
    // cancel is a typed refusal, and an unknown id is not found.
    const canceled = await h.execute(["staged", "cancel", "--id", decisionId]);
    assert.equal(canceled.exitCode, 0);
    assert.match(canceled.stdout, /Canceled staged act .*publish\.viewer\.expose.*Nothing was decided or executed/s);
    assert.equal(h.lastOk().decisionId, decisionId);
    assert.equal(h.lastOk().detail, "canceled staged publish.viewer.expose; state canceled");
    assert.equal((await h.api.stagedActs.get(decisionId))?.state, "canceled");
    const again = await h.execute(["staged", "cancel", "--id", decisionId]);
    assert.equal(again.exitCode, 5);
    assert.match(again.stderr, /already canceled; settling it again is a refusal/);
    const unknown = await h.execute(["staged", "show", "--id", "act-ghost"]);
    assert.equal(unknown.exitCode, 3);
    assert.match(unknown.stderr, /No staged act has this id/);

    // A canceled card can never be decided; approval never survives settling.
    await assert.rejects(
      h.api.foldDecisions.decide(decisionId, { decision: "approved", surface: "main-window" }),
      (error: unknown) => (error as { code?: string }).code === "ALREADY_SETTLED",
    );

    // The settled card remains in the bounded listing history.
    const listedAfter = await h.execute(["staged", "list", "--json"]);
    const listedJson = JSON.parse(listedAfter.stdout) as { data: { acts: Array<{ id: string; state: string }> } };
    assert.deepEqual(listedJson.data.acts.map((act) => [act.id, act.state]), [[decisionId, "canceled"]]);
  } finally {
    await h.close();
  }
});

test("files destroy and spaces delete stage from live state with the ledger's refusals", async () => {
  const h = await stagedVerbHarness("destroy");
  try {
    const managed = await h.api.actFacade.createSpace({ name: "Doomed" });
    const content = "irreplaceable bytes\n";
    await writeFile(join(managed.space.spaceRoot, "big.bin"), content, "utf8");
    const expectedHash = createHash("sha256").update(content, "utf8").digest("hex");

    const destroy = await h.execute(["files", "destroy", "--space", managed.space.id, "--path", "big.bin", "--json"]);
    assert.equal(destroy.exitCode, 0, destroy.stderr);
    const destroyJson = JSON.parse(destroy.stdout) as {
      data: { staged: { decisionId: string; kind: string }; paths: string[]; contentIdentities: string[] };
    };
    assert.equal(destroyJson.data.staged.kind, "files.destroy");
    assert.deepEqual(destroyJson.data.paths, ["big.bin"]);
    assert.deepEqual(
      destroyJson.data.contentIdentities,
      [`file:sha256:${expectedHash}:${Buffer.byteLength(content)}`],
      "observed content identities pin the exact bytes for decision-time recheck",
    );
    assert.equal(h.lastOk().decisionId, destroyJson.data.staged.decisionId);

    // Reserved metadata is never a valid destroy target, and a missing path
    // is a typed not-found — nothing half-stages.
    const reserved = await h.execute(["files", "destroy", "--space", managed.space.id, "--path", ".work-fold/space.json"]);
    assert.equal(reserved.exitCode, 2);
    const ghost = await h.execute(["files", "destroy", "--space", managed.space.id, "--path", "missing.bin"]);
    assert.equal(ghost.exitCode, 3);
    assert.match(ghost.stderr, /Not found in this Space: missing\.bin\./);

    // spaces delete stages consecration 3 for a managed Space and refuses a
    // linked registration toward `spaces unregister`.
    const linkedRoot = join(h.sandbox, "linked-folder");
    await mkdir(linkedRoot, { recursive: true });
    const linked = await h.api.actFacade.registerSpace({ spaceRoot: linkedRoot });
    const refused = await h.execute(["spaces", "delete", "--space", linked.space.id]);
    assert.equal(refused.exitCode, 5);
    assert.match(refused.stderr, /Only a managed Space's folder can be deleted/);

    const stagedDelete = await h.execute(["spaces", "delete", "--space", managed.space.id, "--json"]);
    assert.equal(stagedDelete.exitCode, 0, stagedDelete.stderr);
    const deleteJson = JSON.parse(stagedDelete.stdout) as { data: { staged: { decisionId: string; kind: string; category: string } } };
    assert.equal(deleteJson.data.staged.kind, "space.delete-folder");
    assert.equal(deleteJson.data.staged.category, "destroy");
    const act = await h.api.stagedActs.get(deleteJson.data.staged.decisionId);
    assert.equal(act?.pins.spaceRoot, managed.space.spaceRoot);

    // Approving the CLI-staged card executes the shared managed removal.
    const approved = await h.api.foldDecisions.decide(deleteJson.data.staged.decisionId, {
      decision: "approved",
      surface: "main-window",
    });
    assert.equal(approved.act.execution?.outcome, "executed");
    assert.equal(existsSync(managed.space.spaceRoot), false, "the managed folder is deleted after the click");

    // An explicitly named lineage parent must be an active management
    // request; the executor refuses before any staging happens.
    const before = (await h.api.stagedActs.list()).length;
    const inactiveParent = await h.execute([
      "files", "destroy", "--space", linked.space.id, "--path", "anything.bin", "--parent-task", "task-ghost",
    ]);
    assert.equal(inactiveParent.exitCode, 5);
    assert.match(inactiveParent.stderr, /no longer active/);
    assert.equal((await h.api.stagedActs.list()).length, before, "a refused lineage stages nothing");
  } finally {
    await h.close();
  }
});
