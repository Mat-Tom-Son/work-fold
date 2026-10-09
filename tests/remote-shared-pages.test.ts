import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";

test("paired browsers list only existing shared pages and reveal one current key on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-remote-pages-"));
  const keys = new Map<string, string>();
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), loadEnv: false,
    publicationKeys: { async get(id) { return keys.get(id) ?? null; }, async set(id, key) { keys.set(id, key); }, async remove(id) { keys.delete(id); } },
    publicationBridge: { async upsertSlot() {}, async deleteSlot() {}, async putSnapshot() {}, async deleteSnapshot() {}, async addressConfigured() { return true; } },
  });
  const principal = { browserId: "browser", grantId: "grant", requestId: "read-shared-pages" };
  try {
    const { space } = await api.actFacade.createSpace({ name: "Reports" });
    await writeFile(join(space.spaceRoot, "report.md"), "# Shared report\n");
    const record = await api.publications.activate({ spaceId: space.id, relativePath: "report.md", title: "Quarterly report" }, { requestId: "share-report", surface: "main-window" });
    const listed = await api.remoteFacade.execute("pages.list", {}, principal) as { pages: Array<Record<string, unknown>> };
    assert.equal(listed.pages.length, 1);
    assert.deepEqual(Object.keys(listed.pages[0]!).sort(), ["health", "kind", "publicationId", "snapshotEnabled", "title"]);
    assert.equal(listed.pages[0]!.title, "Quarterly report");
    assert.equal(listed.pages[0]!.publicationId, record.publicationId);
    assert.ok(!JSON.stringify(listed).includes(keys.get(record.publicationId)!));
    assert.ok(!JSON.stringify(listed).includes(root));
    const chats = await api.remoteFacade.execute("management.chats", {}, principal) as { capabilities: { sharedPages: boolean } };
    assert.equal(chats.capabilities.sharedPages, true);
    assert.deepEqual(await api.remoteFacade.execute("pages.link", { publicationId: record.publicationId }, principal), { viewerPath: `/p/${record.publicationId}`, key: keys.get(record.publicationId) });
    await assert.rejects(api.remoteFacade.execute("pages.list", { spaceId: space.id }, principal));
    await assert.rejects(api.remoteFacade.execute("pages.link", { publicationId: "../secret" }, principal));
    await assert.rejects(api.remoteFacade.execute("pages.link", { publicationId: record.publicationId, path: "report.md" }, principal));
    await assert.rejects(api.remoteFacade.execute("pages.link", { publicationId: record.publicationId }, { ...principal, grantId: "" }));
    const savedKey = keys.get(record.publicationId)!;
    keys.delete(record.publicationId);
    await assert.rejects(api.remoteFacade.execute("pages.link", { publicationId: record.publicationId }, principal), /key is missing/);
    keys.set(record.publicationId, savedKey);
    await api.publications.revoke(record.publicationId, { requestId: "revoke-report", surface: "main-window" });
    assert.deepEqual(await api.remoteFacade.execute("pages.list", {}, principal), { pages: [] });
    await assert.rejects(api.remoteFacade.execute("pages.link", { publicationId: record.publicationId }, principal), /not shared/);
  } finally { await api.close(); await rm(root, { recursive: true, force: true }); }
});
