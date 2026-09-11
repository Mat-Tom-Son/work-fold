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

test("pages share shares the page on the first call with receipts and no decision id", async () => {
  const h = await directVerbHarness("pages");
  try {
    const space = await h.api.actFacade.createSpace({ name: "Fold Space" });
    await writeFile(join(space.space.spaceRoot, "weekly.md"), "# Weekly\n\nAll clear.\n", "utf8");

    const shared = await h.execute(["pages", "share", "--space", space.space.id, "--path", "./weekly.md", "--title", "Weekly report", "--json"]);
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
    const again = await h.execute(["pages", "share", "--space", space.space.id, "--path", "weekly.md", "--title", "Weekly report", "--json"]);
    assert.notEqual(again.exitCode, 0);
    assert.equal(errorCodeOf(again.stderr), "conflict");
    assert.match(again.stderr, /already shared/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "error"]);
    assert.equal((await h.api.publications.list()).length, 1);

    // Sources the publication service could not serve refuse before anything
    // is exposed.
    await writeFile(join(space.space.spaceRoot, "tool.exe"), "bytes", "utf8");
    const badType = await h.execute(["pages", "share", "--space", space.space.id, "--path", "tool.exe", "--title", "Nope", "--json"]);
    assert.equal(errorCodeOf(badType.stderr), "usage");
    const missing = await h.execute(["pages", "share", "--space", space.space.id, "--path", "ghost.md", "--title", "Nope", "--json"]);
    assert.equal(errorCodeOf(missing.stderr), "notFound");
    assert.equal((await h.api.publications.list()).length, 1);

    // The human form names the address and where the link lives.
    await writeFile(join(space.space.spaceRoot, "notes.md"), "# Notes\n", "utf8");
    const human = await h.execute(["pages", "share", "--space", space.space.id, "--path", "notes.md", "--title", "Notes"]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /^Sharing "Notes" \(notes\.md\) from Fold Space \[[^\]]+\] at \/p\/[^.]+\. Reveal the link in Settings → The fold\.\n$/);

    // The pending-decision family, permanent deletion, and the retired holding
    // spellings of the routing and outward-exposure verbs are unknown commands.
    for (const argv of [
      ["staged", "list"], ["staged", "show"], ["files", "destroy"],
      ["routings", "stage"], ["pages", "stage"],
    ]) {
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
    // The folder is moved, not erased: the receipt names the Recently deleted
    // item that puts it back (docs/receipts-not-gates.md, F20).
    const keptSpace = (await h.api.trash.list()).entries;
    assert.equal(keptSpace.length, 1);
    assert.equal(keptSpace[0]?.kind, "space");
    assert.equal(h.lastOk().detail, `space.delete-folder; trash ${keptSpace[0]!.id}`);
    assert.deepEqual(h.lastOk().undoRef, { kind: "trash-entry", value: keptSpace[0]!.id });
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

/**
 * A file permission that names a single file is granted from the act lane by
 * naming that file (docs/receipts-not-gates.md, F21). The folder permission
 * beside it keeps binding to the whole Space and takes no file at all.
 */
async function writeSingleFilePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "ledger-demo",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "ledger-demo",
    title: "Ledger demo",
    description: "Declares one single-file permission beside a folder permission.",
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    ui: { icon: "shield" },
    tools: [],
    automations: [],
    permissions: {
      network: [],
      files: [
        { id: "ledger", target: "file", access: "read-write" },
        { id: "exports", target: "directory", access: "read-write" },
      ],
      notifications: [],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
}

test("apps grant --kind files --path binds a single-file permission to that exact file", async () => {
  const h = await directVerbHarness("grants");
  try {
    const space = await h.api.actFacade.createSpace({ name: "Ledger Space" });
    await writeSingleFilePackage(join(space.space.spaceRoot, "apps", "ledger-demo"));
    const installed = await h.execute(["apps", "install-preview", "--space", space.space.id, "--package", "apps/ledger-demo", "--json"]);
    assert.equal(installed.exitCode, 0, installed.stderr);
    const installedJson = JSON.parse(installed.stdout) as {
      data: {
        app: { appId: string; digest: string };
        granted: { wholeSpaceFolders: number };
        needs: { files: string[] };
      };
    };
    const digest = installedJson.data.app.digest;
    assert.equal(installedJson.data.granted.wholeSpaceFolders, 1, "the folder permission is on from install");
    assert.deepEqual(
      installedJson.data.needs.files,
      ["ledger"],
      "the single-file permission is what installation leaves open",
    );

    await mkdir(join(space.space.spaceRoot, "books"), { recursive: true });
    await writeFile(join(space.space.spaceRoot, "books", "ledger.csv"), "date,amount\n", "utf8");

    const grantArgv = ["apps", "grant", "--space", space.space.id, "--app", "ledger-demo", "--digest", digest, "--kind", "files"];

    // Nothing but an existing ordinary file inside the Space can be named, and
    // reserved metadata is not a file endpoint.
    for (const [path, code] of [
      ["ghost.csv", "notFound"],
      ["books", "notFound"],
      ["../outside.csv", "usage"],
      [".work-fold/space.json", "usage"],
      [".pi/config.json", "usage"],
      [".workspace/legacy.json", "usage"],
    ] as const) {
      const refused = await h.execute([...grantArgv, "--declaration", "ledger", "--path", path, "--json"]);
      assert.notEqual(refused.exitCode, 0, `'${path}' must be refused`);
      assert.equal(errorCodeOf(refused.stderr), code, `'${path}' refuses as ${code}`);
    }

    // A single-file permission with no file named says what it needs; the
    // folder permission beside it refuses a file outright.
    const unnamed = await h.execute([...grantArgv, "--declaration", "ledger", "--json"]);
    assert.equal(errorCodeOf(unnamed.stderr), "usage");
    assert.match(unnamed.stderr, /needs one file/);
    const folderWithPath = await h.execute([...grantArgv, "--declaration", "exports", "--path", "books/ledger.csv", "--json"]);
    assert.equal(errorCodeOf(folderWithPath.stderr), "usage");
    assert.match(folderWithPath.stderr, /covers the whole Space/);

    // A file is not part of the network or notification shapes, and revoking
    // names a declaration rather than a root: both are usage errors at parse
    // time, before anything is journaled.
    h.records.length = 0;
    const networkWithPath = await h.execute([
      "apps", "grant", "--space", space.space.id, "--app", "ledger-demo", "--digest", digest,
      "--kind", "network", "--declaration", "mail-api", "--path", "books/ledger.csv", "--json",
    ]);
    assert.equal(errorCodeOf(networkWithPath.stderr), "usage");
    assert.match(networkWithPath.stderr, /--path can be used only with 'apps grant --kind files'/);
    const revokeWithPath = await h.execute([
      "apps", "revoke", "--space", space.space.id, "--app", "ledger-demo", "--digest", digest,
      "--kind", "files", "--declaration", "ledger", "--path", "books/ledger.csv", "--json",
    ]);
    assert.equal(errorCodeOf(revokeWithPath.stderr), "usage");
    assert.match(revokeWithPath.stderr, /--path cannot be used with 'apps revoke'/);
    assert.deepEqual(h.records, [], "a usage error leaves no receipt");

    // The grant binds to the exact file, and the receipt names that root.
    h.records.length = 0;
    const granted = await h.execute([...grantArgv, "--declaration", "ledger", "--path", "./books/ledger.csv", "--json"]);
    assert.equal(granted.exitCode, 0, granted.stderr);
    const grantedJson = JSON.parse(granted.stdout) as { data: { granted: boolean; grantKind: string; declaration: string; root: string } };
    assert.equal(grantedJson.data.granted, true);
    assert.equal(grantedJson.data.grantKind, "files");
    assert.equal(grantedJson.data.declaration, "ledger");
    assert.equal(grantedJson.data.root, "books/ledger.csv", "the root is the canonical Space-relative file");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, "app.grant.files; app ledger-demo; declaration ledger; root books/ledger.csv");
    assert.deepEqual(h.lastOk().undoRef, { kind: "declaration", value: "ledger" });

    // The human form says what the app can reach, and re-granting the same
    // file changes nothing.
    const human = await h.execute([...grantArgv, "--declaration", "ledger", "--path", "books/ledger.csv"]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /^Granted files ledger to ledger-demo in Ledger Space \[[^\]]+\]\. It covers books\/ledger\.csv and nothing else\.\n$/);

    // Revoking takes the file grant away; the whole-Space folder grant is
    // untouched and still reports its own root.
    const revoked = await h.execute([
      "apps", "revoke", "--space", space.space.id, "--app", "ledger-demo", "--digest", digest,
      "--kind", "files", "--declaration", "ledger", "--json",
    ]);
    assert.equal(revoked.exitCode, 0, revoked.stderr);
    assert.equal((JSON.parse(revoked.stdout) as { data: { revoked: boolean } }).data.revoked, true);
    const folderGrant = await h.execute([...grantArgv, "--declaration", "exports", "--json"]);
    assert.equal(folderGrant.exitCode, 0, folderGrant.stderr);
    assert.equal((JSON.parse(folderGrant.stdout) as { data: { root: string } }).data.root, ".");
  } finally {
    await h.close();
  }
});
