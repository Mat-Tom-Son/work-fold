import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { scanSpaceTree } from "../src/local/space.js";

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

  // A parent Folder cannot delete, move, or rename what a nested Folder owns,
  // and a refused change leaves no restore point behind.
  const checkpoints = async () => {
    const response = await call(`/api/spaces/${repo.id}/history/checkpoints`);
    assert.equal(response.status, 200);
    return JSON.stringify(response.body);
  };
  const historyBefore = await checkpoints();
  for (const [path, method, body] of [
    [`/api/spaces/${repo.id}/local-file`, "DELETE", { path: "packages" }],
    [`/api/spaces/${repo.id}/local-file`, "DELETE", { path: "packages/api/server.ts" }],
    [`/api/spaces/${repo.id}/rename-local-entry`, "POST", { path: "packages", newName: "pkgs" }],
    [`/api/spaces/${repo.id}/move-local-entry`, "POST", { sourcePath: "README.md", targetFolderPath: "packages/api" }],
    [`/api/spaces/${repo.id}/move-local-entry`, "POST", { sourcePath: "packages/api/server.ts", targetFolderPath: "" }],
  ] as const) {
    const response = await call(path, { method, body });
    assert.equal(response.status, 409, `${method} ${path} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
  }
  assert.equal(await checkpoints(), historyBefore);
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

  // Addressed Workers: bounded, own id dropped, unknown ids dropped, never a refusal.
  const conversation = (await call(`/api/spaces/${repo.id}/conversations`, { method: "POST", body: {} })).body!.conversation;
  const tooMany = await call(`/api/spaces/${repo.id}/conversations/${conversation.id}/messages`, {
    method: "POST", body: { content: "hello", addressedSpaceIds: Array.from({ length: 9 }, (_, index) => `space-${index}`) },
  });
  assert.equal(tooMany.status, 400);
  const notArray = await call(`/api/spaces/${repo.id}/conversations/missing-chat/messages`, { method: "POST", body: { content: "hello", addressedSpaceIds: "api" } });
  assert.equal(notArray.status, 400);
  const unknownDropped = await call(`/api/spaces/${repo.id}/conversations/missing-chat/messages`, {
    method: "POST", body: { content: "hello", addressedSpaceIds: ["space-gone", repo.id, child.id] },
  });
  assert.equal(unknownDropped.status, 404, "validation passes and the missing Chat is what refuses");
});
