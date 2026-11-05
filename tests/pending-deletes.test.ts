import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";
import { deleteLocalFileRequest, deleteLocalFilesRequest, pendingDeleteGroups, settledPendingDeletes, type PendingDelete } from "../web-local/src/lib/pending-deletes.js";

const pending = (path: string, extra: Partial<PendingDelete> = {}): PendingDelete => ({
  workFolderId: "space-a", path, name: path.split("/").pop()!, selectedPath: null, deletedTabPaths: new Set(), ...extra,
});

test("rows deleted together reach the host together; every other row goes on its own", () => {
  const groups = pendingDeleteGroups([
    pending("a.txt", { batchId: 1 }),
    pending("solo.txt"),
    pending("b.txt", { batchId: 1 }),
    pending("other.txt", { batchId: 1, workFolderId: "space-b" }),
    pending("c.txt", { batchId: 2 }),
  ]);
  assert.deepEqual(groups.map((group) => group.map((item) => item.path)), [["a.txt", "b.txt"], ["solo.txt"], ["other.txt"], ["c.txt"]]);
});

test("a several-row delete closes only the deleted rows' tabs and names the ones in Recently Deleted", () => {
  const waiting = [
    pending("a.txt", { deletedTabPaths: new Set(["a.txt"]) }),
    pending("bulk", { deletedTabPaths: new Set(["bulk/one.bin"]) }),
    pending("c.txt", { deletedTabPaths: new Set(["c.txt"]) }),
  ];
  const settled = settledPendingDeletes(waiting, {
    deleted: [
      { path: "a.txt", kind: "file" },
      { path: "bulk", kind: "folder", recentlyDeleted: { entryId: "rd-1", restoreBy: "2026-12-05T00:00:00.000Z", uncoveredCount: 1 } },
    ],
    safetyCheckpointId: "cp-1",
    failed: { path: "c.txt", error: "EACCES" },
    notDeleted: [],
  });
  assert.deepEqual(settled.deleted.map((item) => item.path), ["a.txt", "bulk"]);
  assert.deepEqual([...settled.closedTabPaths], ["a.txt", "bulk/one.bin"], "a row that failed keeps its tab");
  assert.deepEqual(settled.inRecentlyDeleted, ["bulk"]);
});

test("several rows go to the host in one request, and one row keeps its own route", async (t) => {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = previousFetch; await dom.cleanup(); });
  const sent: Array<{ url: string; method?: string; body: unknown; keepalive?: boolean }> = [];
  globalThis.fetch = (async (input, init) => {
    sent.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)), keepalive: init?.keepalive });
    if (String(input).endsWith("/local-files")) {
      return Response.json({ deleted: [{ path: "a.txt", kind: "file" }, { path: "b.txt", kind: "file" }], safetyCheckpointId: "cp-1" });
    }
    return Response.json({ deleted: true, path: "solo.txt", kind: "file" });
  }) as typeof fetch;

  const result = await deleteLocalFilesRequest("space-a", ["a.txt", "b.txt"], true);
  assert.equal(result.safetyCheckpointId, "cp-1");
  await deleteLocalFileRequest(pending("solo.txt"));
  assert.deepEqual(sent, [
    { url: "/api/work-folders/space-a/local-files", method: "DELETE", body: { paths: ["a.txt", "b.txt"] }, keepalive: true },
    { url: "/api/work-folders/space-a/local-file", method: "DELETE", body: { path: "solo.txt" }, keepalive: false },
  ]);

  globalThis.fetch = (async () => Response.json({ error: "Finish or stop this work-folder's outstanding work before deleting." }, { status: 409 })) as typeof fetch;
  await assert.rejects(() => deleteLocalFilesRequest("space-a", ["a.txt", "b.txt"]), /outstanding work/);
});
