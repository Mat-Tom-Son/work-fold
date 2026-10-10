import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WorkFoldCliError,
  createWorkFoldCliRequest,
  executeWorkFoldCliRequest,
  type WorkFoldCliKernel,
} from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { listPendingSpaceRemovals, scanSpaceTree } from "../src/local/space.js";

/**
 * Folders inside Folders on the host (2026-10-01): the CLI and routes the
 * work-fold agent and the renderer read, and the boundary a parent Folder's
 * file operations stop at.
 */

test("spaces list --json names a nested Folder's parent and leaves top-level Folders unchanged", async () => {
  const kernel: WorkFoldCliKernel = {
    async getContext(actor) { return { cwd: actor.cwd, space: null }; },
    async listSpaces() {
      return [
        { id: "space-repo", name: "repo", spaceRoot: "/work/repo", active: false },
        { id: "space-api", name: "api", spaceRoot: "/work/repo/packages/api", active: false, parentSpaceId: "space-repo" },
      ];
    },
    async listTasks() { return []; },
    async listCapabilities() { return []; },
    async getChecksStatus() { throw new WorkFoldCliError("unavailable", "unavailable"); },
  };
  const result = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["spaces", "list", "--json"], cwd: resolve(".") }),
    kernel,
    { version: "1.2.3" },
  );
  const envelope = JSON.parse(result.stdout) as { data: { spaces: Array<Record<string, unknown>> } };
  const [repo, api] = envelope.data.spaces;
  assert.equal("parentSpaceId" in repo!, false);
  assert.equal(api!.parentSpaceId, "space-repo");
});

test("the tree boundary holds for path spellings that resolve to a nested Folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-nested-spelling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages", "api", "src"), { recursive: true });
  await writeFile(join(root, "packages", "api", "src", "index.ts"), "export {};\n");
  const options = { nestedFolderPaths: ["packages/api"] };
  for (const spelling of ["packages/api", "packages//api", "packages/./api", "packages/api/src"]) {
    assert.deepEqual((await scanSpaceTree(root, 1, spelling, options)).entries, [], spelling);
  }
  if (process.platform === "darwin") assert.deepEqual((await scanSpaceTree(root, 1, "Packages/API", options)).entries, []);
});

test("activity, outline, addressed Workers, and nested-Folder file guards over the local API", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-nested-host-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), spaceBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${api.origin}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  const upload = async (path: string, targetFolderPath: string, files: Array<{ name: string; content: string; relativePath?: string }>) => {
    const body = new FormData();
    body.set("targetFolderPath", targetFolderPath);
    body.set("relativePaths", JSON.stringify(files.map((file) => file.relativePath ?? file.name)));
    for (const file of files) body.append("files", new Blob([file.content], { type: "text/plain" }), file.name);
    const response = await fetch(`${api.origin}${path}`, { method: "POST", body });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };

  const repoRoot = join(sandbox, "repo");
  await mkdir(join(repoRoot, "packages", "api"), { recursive: true });
  await writeFile(join(repoRoot, "packages", "api", "server.ts"), "export {};\n");
  await writeFile(join(repoRoot, "README.md"), "# repo\n");
  const repo = (await call("/api/spaces/local-folder", { method: "POST", body: { spaceRoot: repoRoot } })).body!.space;
  const child = (await call("/api/spaces/local-folder", { method: "POST", body: { spaceRoot: join(repoRoot, "packages", "api") } })).body!.space;

  assert.deepEqual((await call("/api/spaces/activity")).body, { running: [] });
  const outline = (await call("/api/spaces/outline")).body!.spaces as Array<{ id: string; name: string }>;
  assert.deepEqual(outline.map((item) => item.id).sort(), [repo.id, child.id].sort());

  const boot = (await call("/api/bootstrap")).body!.spaces as Array<{ id: string; parentSpaceId?: string }>;
  assert.equal(boot.find((item) => item.id === child.id)?.parentSpaceId, repo.id);
  assert.equal(boot.find((item) => item.id === repo.id)?.parentSpaceId, undefined);

  const tree = (await call(`/api/spaces/${repo.id}/tree?maxDepth=3`)).body!.tree as Array<{ name: string; children?: Array<{ name: string; nestedFolder?: boolean; children?: unknown[] }> }>;
  const nested = tree.find((entry) => entry.name === "packages")?.children?.find((entry) => entry.name === "api");
  assert.equal(nested?.nestedFolder, true);
  assert.deepEqual(nested?.children, []);

  // Every parent mutation stops at the nested boundary, and a refused change
  // leaves both the child's bytes and each Folder's restore points intact.
  const checkpoints = async (spaceId = repo.id) => {
    const response = await call(`/api/spaces/${spaceId}/history/checkpoints`);
    assert.equal(response.status, 200);
    return JSON.stringify(response.body);
  };
  const historyBefore = await checkpoints();
  const childHistoryBefore = await checkpoints(child.id);
  for (const [path, method, body] of [
    [`/api/spaces/${repo.id}/local-file`, "DELETE", { path: "packages" }],
    [`/api/spaces/${repo.id}/local-file`, "DELETE", { path: "packages/api/server.ts" }],
    [`/api/spaces/${repo.id}/rename-local-entry`, "POST", { path: "packages", newName: "pkgs" }],
    [`/api/spaces/${repo.id}/move-local-entry`, "POST", { sourcePath: "README.md", targetFolderPath: "packages/api" }],
    [`/api/spaces/${repo.id}/move-local-entry`, "POST", { sourcePath: "packages/api/server.ts", targetFolderPath: "" }],
    [`/api/spaces/${repo.id}/file`, "PUT", { path: "packages//./api/server.ts", text: "parent overwrite" }],
    [`/api/spaces/${repo.id}/folders`, "POST", { parentPath: "packages/api", name: "parent-folder" }],
    [`/api/spaces/${repo.id}/files`, "POST", { parentPath: "packages/api", name: "parent-file.txt", text: "parent create" }],
  ] as const) {
    const response = await call(path, { method, body });
    assert.equal(response.status, 409, `${method} ${path} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
  }
  for (const [targetFolder, files] of [
    ["packages//./api", [{ name: "parent-upload.txt", content: "parent upload" }]],
    ["", [
      { name: "first.txt", relativePath: "Batch/first.txt", content: "first" },
      { name: "second.txt", relativePath: "packages/api/parent-directory/second.txt", content: "second" },
    ]],
  ] as const) {
    const response = await upload(`/api/spaces/${repo.id}/upload-local-files`, targetFolder, [...files]);
    assert.equal(response.status, 409, JSON.stringify(response.body));
  }
  assert.equal(await readFile(join(repoRoot, "packages", "api", "server.ts"), "utf8"), "export {};\n");
  for (const path of ["parent-folder", "parent-file.txt", "parent-upload.txt", "parent-directory"]) {
    assert.equal(existsSync(join(repoRoot, "packages", "api", path)), false, path);
  }
  assert.equal(existsSync(join(repoRoot, "Batch")), false, "a refused upload does not write its earlier allowed destination");
  assert.equal(await checkpoints(), historyBefore);
  assert.equal(await checkpoints(child.id), childHistoryBefore);

  // The parent can create and change siblings under a folder that contains a
  // nested Folder, and the child retains all ordinary file operations.
  for (const [path, method, body, status] of [
    [`/api/spaces/${repo.id}/folders`, "POST", { parentPath: "packages", name: "sibling" }, 201],
    [`/api/spaces/${repo.id}/files`, "POST", { parentPath: "packages/sibling", name: "note.txt", text: "sibling" }, 201],
    [`/api/spaces/${repo.id}/file`, "PUT", { path: "packages/sibling/note.txt", text: "updated sibling" }, 200],
    [`/api/spaces/${child.id}/file`, "PUT", { path: "server.ts", text: "child update" }, 200],
    [`/api/spaces/${child.id}/folders`, "POST", { parentPath: "", name: "own-folder" }, 201],
    [`/api/spaces/${child.id}/files`, "POST", { parentPath: "own-folder", name: "own-file.txt", text: "child create" }, 201],
  ] as const) {
    const response = await call(path, { method, body });
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
  }
  assert.equal((await upload(`/api/spaces/${repo.id}/upload-local-files`, "packages/sibling", [{ name: "upload.txt", content: "sibling upload" }])).status, 201);
  assert.equal((await upload(`/api/spaces/${child.id}/upload-local-files`, "own-folder", [{ name: "upload.txt", content: "child upload" }])).status, 201);
  assert.equal(await readFile(join(repoRoot, "packages", "sibling", "note.txt"), "utf8"), "updated sibling");
  assert.equal(await readFile(join(repoRoot, "packages", "sibling", "upload.txt"), "utf8"), "sibling upload");
  assert.equal(await readFile(join(repoRoot, "packages", "api", "server.ts"), "utf8"), "child update");
  assert.equal(await readFile(join(repoRoot, "packages", "api", "own-folder", "own-file.txt"), "utf8"), "child create");
  assert.equal(await readFile(join(repoRoot, "packages", "api", "own-folder", "upload.txt"), "utf8"), "child upload");
  // The nested Folder still changes its own files.
  assert.equal((await call(`/api/spaces/${child.id}/rename-local-entry`, { method: "POST", body: { path: "server.ts", newName: "main.ts" } })).status, 200);

  // "Make a work-folder": a plain folder inside a Folder becomes a nested
  // Folder; hidden data, missing folders, and existing or inner Folders refuse.
  await mkdir(join(repoRoot, "docs", "guides"), { recursive: true });
  const given = await call(`/api/spaces/${repo.id}/nested-folders`, { method: "POST", body: { path: "docs" } });
  assert.equal(given.status, 201);
  assert.equal(given.body!.space.name, "docs");
  const nowNested = (await call("/api/bootstrap")).body!.spaces as Array<{ id: string; parentSpaceId?: string }>;
  assert.equal(nowNested.find((item) => item.id === given.body!.space.id)?.parentSpaceId, repo.id);
  for (const [path, status] of [["docs", 409], ["packages/api", 409], ["docs/guides", 409], [".work-fold", 400], ["missing", 404], ["", 400], ["../outside", 400]] as const) {
    const refused = await call(`/api/spaces/${repo.id}/nested-folders`, { method: "POST", body: { path } });
    assert.equal(refused.status, status, `${path}: ${JSON.stringify(refused.body)}`);
  }

  // Addressed Workers: any number, own id dropped, unknown ids dropped, never a refusal.
  const many = await call(`/api/spaces/${repo.id}/conversations/missing-chat/messages`, {
    method: "POST", body: { content: "hello", addressedSpaceIds: Array.from({ length: 64 }, (_, index) => `space-${index}`) },
  });
  assert.equal(many.status, 404, "any number of addressed Workers passes validation; the missing Chat is what refuses");
  const notArray = await call(`/api/spaces/${repo.id}/conversations/missing-chat/messages`, { method: "POST", body: { content: "hello", addressedSpaceIds: "api" } });
  assert.equal(notArray.status, 400);
  const unknownDropped = await call(`/api/spaces/${repo.id}/conversations/missing-chat/messages`, {
    method: "POST", body: { content: "hello", addressedSpaceIds: ["space-gone", repo.id, child.id] },
  });
  assert.equal(unknownDropped.status, 404, "validation passes and the missing Chat is what refuses");

  // Even an idle nested Folder prevents managed parent deletion before any
  // removal intent or App Project cleanup is accepted.
  const managedResponse = await call("/api/spaces", { method: "POST", body: { name: "Managed nested parent" } });
  assert.equal(managedResponse.status, 201);
  const managed = managedResponse.body!.space;
  const managedChildRoot = join(managed.spaceRoot, "Child");
  await mkdir(managedChildRoot);
  await writeFile(join(managedChildRoot, "keep.txt"), "nested retained content");
  const managedChildResponse = await call(`/api/spaces/${managed.id}/nested-folders`, { method: "POST", body: { path: "Child" } });
  assert.equal(managedChildResponse.status, 201);
  const managedChild = managedChildResponse.body!.space;
  assert.equal((await call(`/api/spaces/${managed.id}/app-studio`, { method: "PUT", body: { title: "Parent retained App", description: null, icon: null } })).status, 200);
  assert.equal((await call(`/api/spaces/${managedChild.id}/app-studio`, { method: "PUT", body: { title: "Child retained App", description: null, icon: null } })).status, 200);
  const parentStudioBefore = (await call(`/api/spaces/${managed.id}/app-studio`)).body;
  const childStudioBefore = (await call(`/api/spaces/${managedChild.id}/app-studio`)).body;
  const intentsBefore = await listPendingSpaceRemovals();
  assert.deepEqual((await call("/api/spaces/activity")).body, { running: [] });
  const refusedDelete = await call(`/api/spaces/${managed.id}`, { method: "DELETE" });
  assert.equal(refusedDelete.status, 409, JSON.stringify(refusedDelete.body));
  assert.match(refusedDelete.body!.error, /nested work-folder/);
  assert.deepEqual(await listPendingSpaceRemovals(), intentsBefore);
  assert.deepEqual((await call(`/api/spaces/${managed.id}/app-studio`)).body, parentStudioBefore);
  assert.deepEqual((await call(`/api/spaces/${managedChild.id}/app-studio`)).body, childStudioBefore);
  assert.equal(await readFile(join(managedChildRoot, "keep.txt"), "utf8"), "nested retained content");
  const finalSpaces = (await call("/api/bootstrap")).body!.spaces as Array<{ id: string }>;
  assert.equal(finalSpaces.some((item) => item.id === managed.id), true);
  assert.equal(finalSpaces.some((item) => item.id === managedChild.id), true);
});
