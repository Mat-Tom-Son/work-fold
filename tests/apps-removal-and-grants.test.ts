import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRestrictedAppStorage } from "../src/local/agent/restricted-app-storage.js";
import { RestrictedAppService } from "../src/local/agent/restricted-app-service.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * Two receipts-not-gates properties of the app verbs, over the running local
 * API.
 *
 * F20: nothing work-fold destroys is permanent at the moment it happens.
 * Removing a Development preview, and unregistering a work-folder that holds one,
 * both take the app's local data with them, so both owe a recoverable copy in
 * Recently deleted first — the same export-then-destroy order "Clear data"
 * and uninstall-with-purge already use.
 *
 * F21: an installed app comes up able to work, and a folder permission binds
 * to the whole work-folder. A single-file permission has no whole-work-folder reading, so
 * `apps grant` takes the work-folder file it covers and binds to exactly that file.
 */

interface Harness {
  api: LocalApiHandle;
  workFolderId: string;
  workFolderRoot: string;
  appDigest: string;
}

async function withApp(run: (context: Harness) => Promise<void>): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-apps-removal-"));
  const stateBase = join(sandbox, "state");
  const restrictedAppRoot = join(stateBase, "restricted-apps");
  const storage = new FileRestrictedAppStorage(join(restrictedAppRoot, "data"));
  const service = await RestrictedAppService.create({ rootPath: restrictedAppRoot, storage });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "work-folders"),
    loadEnv: false,
    restrictedAppService: service,
  });
  try {
    const created = await api.actFacade.createWorkFolder({ name: "Apps" });
    const workFolder = created.workFolder;
    const sourcePath = "tools/ledger-app";
    await writePackage(join(workFolder.workFolderRoot, "tools", "ledger-app"));

    const inspected = await request<{ review: { digest: string } }>(
      api.origin,
      `/api/work-folders/${workFolder.id}/restricted-apps/inspect`,
      { method: "POST", body: { sourcePath } },
    );
    const installed = await request<{ app: { digest: string; tenantId: string; runtimeInstanceId: string; featureInstallationId: string; dataNamespaceId: string } }>(
      api.origin,
      `/api/work-folders/${workFolder.id}/restricted-apps`,
      { method: "POST", body: { sourcePath, expectedDigest: inspected.review.digest } },
    );
    // Data worth losing: the removal has to carry this into Recently deleted.
    await storage.set({
      ownerClass: "instance",
      tenantId: installed.app.tenantId,
      runtimeInstanceId: installed.app.runtimeInstanceId,
      featureInstallationId: installed.app.featureInstallationId,
      dataNamespaceId: installed.app.dataNamespaceId,
    }, "rows", { entries: ["one", "two"] });

    await run({ api, workFolderId: workFolder.id, workFolderRoot: workFolder.workFolderRoot, appDigest: installed.app.digest });
  } finally {
    await api.close();
    await service.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function request<T>(origin: string, path: string, init: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(new URL(path, origin), {
    method: init.method,
    ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  const value = await response.json() as T & { error?: string };
  assert.equal(response.ok, true, value.error);
  return value;
}

async function recentlyDeletedEntries(api: LocalApiHandle): Promise<Array<{ id: string; kind: string; reason: string; sizeBytes: number }>> {
  const listed = await api.actFacade.recentlyDeletedList({});
  return listed.entries.map((entry) => ({ id: entry.id, kind: entry.kind, reason: entry.reason, sizeBytes: entry.sizeBytes }));
}

test("a folder permission grants over the whole work-folder; a single-file permission binds to the named file", async () => {
  await withApp(async ({ api, workFolderId, workFolderRoot, appDigest }) => {
    await api.actFacade.appsRevoke({
      workFolder: workFolderId, app: "ledger-app", digest: appDigest, kind: "files", declaration: "exports",
    });

    const granted = await api.actFacade.appsGrant({
      workFolder: workFolderId, app: "ledger-app", digest: appDigest, kind: "files", declaration: "exports",
    });
    assert.equal(granted.granted, true);
    assert.equal(granted.root, ".", "a folder permission binds to the whole work-folder");

    // A folder permission has nothing to narrow to, and a single-file
    // permission has no whole-work-folder reading: both refuse before journaling,
    // rather than letting the broker answer with an unavailable-file error.
    await assert.rejects(
      () => api.actFacade.appsGrant({
        workFolder: workFolderId, app: "ledger-app", digest: appDigest, kind: "files", declaration: "exports", path: "books/ledger.csv",
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "usage");
        assert.match(error.message, /covers the whole work-folder/);
        return true;
      },
    );
    await assert.rejects(
      () => api.actFacade.appsGrant({
        workFolder: workFolderId, app: "ledger-app", digest: appDigest, kind: "files", declaration: "ledger",
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "usage");
        assert.match(error.message, /needs one file/);
        assert.match(error.message, /Settings → Apps/);
        assert.doesNotMatch(error.message, /unavailable/);
        return true;
      },
    );

    // Nothing was granted for the file declaration, so nothing is pinned to a
    // root the broker would reject at read time.
    const before = await api.actFacade.appsList({ workFolder: workFolderId });
    assert.deepEqual((before.apps[0]?.grants.files ?? []).map((grant) => grant.declarationId), ["exports"]);

    // Naming the file grants it, and the grant binds to that file alone.
    await mkdir(join(workFolderRoot, "books"), { recursive: true });
    await writeFile(join(workFolderRoot, "books", "ledger.csv"), "date,amount\n", "utf8");
    const file = await api.actFacade.appsGrant({
      workFolder: workFolderId, app: "ledger-app", digest: appDigest, kind: "files", declaration: "ledger", path: "./books/ledger.csv",
    });
    assert.equal(file.granted, true);
    assert.equal(file.root, "books/ledger.csv", "the grant root is the canonical work-folder-relative file");
    const after = await api.actFacade.appsList({ workFolder: workFolderId });
    assert.deepEqual(
      (after.apps[0]?.grants.files ?? []).map((grant) => [grant.declarationId, grant.root]).sort(),
      [["exports", "."], ["ledger", "books/ledger.csv"]],
    );
  });
});

test("removing a preview leaves a recoverable copy of its data in Recently deleted", async () => {
  await withApp(async ({ api, workFolderId }) => {
    assert.deepEqual(await recentlyDeletedEntries(api), [], "nothing is waiting before the removal");

    const removed = await api.actFacade.appsRemove({ workFolder: workFolderId, app: "ledger-app" });
    assert.equal(removed.removed, true);
    assert.ok(removed.recentlyDeleted, "the removal reports the entry it left behind");

    const entries = await recentlyDeletedEntries(api);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, removed.recentlyDeleted?.entryId);
    assert.equal(entries[0]?.kind, "app-storage");
    assert.equal(entries[0]?.reason, "apps.remove");
    assert.ok((entries[0]?.sizeBytes ?? 0) > 0, "the copy carries the app's bytes");
  });
});

test("unregistering a work-folder carries every preview's data into Recently deleted with the folder", async () => {
  await withApp(async ({ api, workFolderId }) => {
    const removal = await api.actFacade.workFoldersDelete({ workFolder: workFolderId });
    assert.equal(removal.removed, true);
    assert.equal(removal.appRecentlyDeletedEntries.length, 1, "the work-folder's one preview left a recoverable copy");

    const entries = await recentlyDeletedEntries(api);
    const appEntry = entries.find((entry) => entry.kind === "app-storage");
    assert.ok(appEntry, "the app's data is recoverable after the work-folder is gone");
    assert.equal(appEntry?.reason, "apps.work-folder.removed");
    assert.equal(appEntry?.id, removal.appRecentlyDeletedEntries[0]?.entryId);
    assert.ok(
      entries.some((entry) => entry.kind === "work-folder"),
      "the folder itself travels into Recently deleted too",
    );
  });
});

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: "ledger-app",
      version: "0.1.0",
      private: true,
      type: "module",
      agentApp: "agent-app.json",
    }), "utf8"),
    writeFile(join(root, "agent-app.json"), JSON.stringify({
      version: 2,
      id: "ledger-app",
      title: "Ledger",
      description: "A deliberately small app with one folder and one file permission.",
      runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
      ui: { icon: "mail" },
      tools: [{
        name: "ledger_total",
        description: "Total the ledger.",
        action: "total",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        resultSchema: {
          type: "object",
          properties: { total: { type: "integer", minimum: 0 } },
          required: ["total"],
          additionalProperties: false,
        },
      }],
      automations: [],
      permissions: {
        files: [
          { id: "exports", target: "directory", access: "read-write" },
          { id: "ledger", target: "file", access: "read" },
        ],
        notifications: [],
        network: [],
      },
    }), "utf8"),
    writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8"),
    writeFile(join(root, "app.js"), "export {};\n", "utf8"),
    writeFile(join(root, "worker.js"), "export async function handleAction() { return { total: 0 }; }\n", "utf8"),
  ]);
}
