import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RestrictedAppFileBroker,
  RestrictedAppFileError,
  type RestrictedAppFileContext,
} from "../src/local/agent/restricted-app-files.js";

function context(workspaceRoot: string, options: {
  declarationAccess?: "read" | "read-write";
  grantAccess?: "read" | "read-write";
  root?: string;
  target?: "file" | "directory";
  authorizeCommit?: () => void;
} = {}): RestrictedAppFileContext {
  return {
    workspaceRoot,
    declarations: [{
      id: "project-files",
      target: options.target ?? "directory",
      access: options.declarationAccess ?? "read-write",
    }],
    grants: [{
      id: "selected-project-files",
      declarationId: "project-files",
      root: options.root ?? ".",
      access: options.grantAccess ?? "read-write",
    }],
    ...(options.authorizeCommit ? { authorizeCommit: options.authorizeCommit } : {}),
  };
}

function fileError(code: RestrictedAppFileError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RestrictedAppFileError && error.code === code;
}

test("Space file broker lists and reads only bounded grant-relative data", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await mkdir(join(root, "docs"));
  await mkdir(join(root, ".workspace"));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, "docs", "notes.txt"), "hello Workspace", "utf8");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(root, ".workspace", "space.json"), "secret", "utf8");
  await writeFile(join(root, ".pi", "extension.ts"), "secret", "utf8");
  const broker = new RestrictedAppFileBroker();

  const listed = await broker.list(context(root), { grantId: "selected-project-files", path: "." });
  assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.kind]), [
    ["docs", "directory"],
    ["binary.bin", "file"],
  ]);
  assert.equal(listed.truncated, false);
  assert.equal(JSON.stringify(listed).includes(root), false);
  assert.equal(JSON.stringify(listed).includes("workspaceRoot"), false);

  const text = await broker.read(context(root), { grantId: "selected-project-files", path: "docs/notes.txt" });
  assert.deepEqual({ path: text.path, encoding: text.encoding, data: text.data, sizeBytes: text.sizeBytes }, {
    path: "docs/notes.txt",
    encoding: "utf8",
    data: "hello Workspace",
    sizeBytes: 15,
  });
  const binary = await broker.read(context(root), { grantId: "selected-project-files", path: "binary.bin", encoding: "base64" });
  assert.equal(binary.data, Buffer.from([0, 1, 2, 255]).toString("base64"));
});

test("Space file broker honors safe relative grant roots and file targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await mkdir(join(root, "selected"));
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "selected", "inside.txt"), "inside", "utf8");
  await writeFile(join(root, "outside", "outside.txt"), "outside", "utf8");
  const broker = new RestrictedAppFileBroker();

  const selected = context(root, { root: "selected" });
  assert.equal((await broker.read(selected, { grantId: "selected-project-files", path: "inside.txt" })).data, "inside");
  await assert.rejects(
    broker.read(selected, { grantId: "selected-project-files", path: "../outside/outside.txt" }),
    fileError("FILE_DENIED"),
  );

  const file = context(root, { root: "selected/inside.txt", target: "file" });
  assert.equal((await broker.read(file, { grantId: "selected-project-files", path: "." })).data, "inside");
  const replaced = await broker.write(file, {
    grantId: "selected-project-files",
    path: ".",
    data: "updated",
    mode: "replace",
  });
  assert.equal(replaced.path, ".");
  assert.equal(await readFile(join(root, "selected", "inside.txt"), "utf8"), "updated");
  await assert.rejects(
    broker.read(file, { grantId: "selected-project-files", path: "anything.txt" }),
    fileError("FILE_DENIED"),
  );
});

test("Space file broker rejects hidden ownership, unsafe paths, and metadata roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await writeFile(join(root, "notes.txt"), "hello", "utf8");
  await mkdir(join(root, ".workspace"));
  await writeFile(join(root, ".workspace", "space.json"), "hidden", "utf8");
  const broker = new RestrictedAppFileBroker();
  const authority = context(root);

  const requests: unknown[] = [
    { grantId: "selected-project-files", path: "../notes.txt" },
    { grantId: "selected-project-files", path: "/notes.txt" },
    { grantId: "selected-project-files", path: "C:/notes.txt" },
    { grantId: "selected-project-files", path: "folder\\notes.txt" },
    { grantId: "selected-project-files", path: ".workspace/space.json" },
    { grantId: "selected-project-files", path: ".PI/extension.ts" },
    { grantId: "selected-project-files", path: "notes.txt", workspaceRoot: root },
    { grantId: "selected-project-files", path: "notes.txt", appId: "spoofed-app" },
  ];
  for (const request of requests) await assert.rejects(broker.read(authority, request), fileError("FILE_DENIED"));
  await assert.rejects(
    broker.read({ ...authority, grants: [{ ...authority.grants[0]!, root: ".workspace" }] }, { grantId: "selected-project-files", path: "." }),
    fileError("FILE_DENIED"),
  );
});

test("Space file broker denies links and junction escapes", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  const root = join(sandbox, "space");
  const outside = join(sandbox, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside secret", "utf8");
  const linked = join(root, "linked");
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This environment cannot create a link or junction.");
      return;
    }
    throw error;
  }
  const broker = new RestrictedAppFileBroker();

  await assert.rejects(
    broker.read(context(root), { grantId: "selected-project-files", path: "linked/secret.txt" }),
    fileError("FILE_DENIED"),
  );
  await assert.rejects(
    broker.list(context(root, { root: "linked" }), { grantId: "selected-project-files", path: "." }),
    fileError("FILE_DENIED"),
  );
  assert.equal((await broker.list(context(root), { grantId: "selected-project-files", path: "." })).entries.some((entry) => entry.name === "linked"), false);
});

test("Space file broker requires reviewed and effective read-write authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await writeFile(join(root, "notes.txt"), "before", "utf8");
  const broker = new RestrictedAppFileBroker();
  const request = { grantId: "selected-project-files", path: "notes.txt", data: "after", mode: "replace" };

  await assert.rejects(broker.write(context(root, { declarationAccess: "read", grantAccess: "read" }), request), fileError("FILE_DENIED"));
  await assert.rejects(broker.write(context(root, { declarationAccess: "read-write", grantAccess: "read" }), request), fileError("FILE_DENIED"));
  await assert.rejects(broker.write(context(root, { declarationAccess: "read", grantAccess: "read-write" }), request), fileError("FILE_DENIED"));
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "before");
});

test("Space file broker creates and replaces bounded files without leaving partials", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "notes.txt"), "before", "utf8");
  const broker = new RestrictedAppFileBroker({ maxWriteBytes: 32 });
  const authority = context(root);

  const replaced = await broker.write(authority, {
    grantId: "selected-project-files",
    path: "docs/notes.txt",
    data: "after",
    mode: "replace",
  });
  assert.equal(replaced.path, "docs/notes.txt");
  assert.equal(await readFile(join(root, "docs", "notes.txt"), "utf8"), "after");

  await broker.write(authority, {
    grantId: "selected-project-files",
    path: "docs/new.bin",
    encoding: "base64",
    data: Buffer.from([1, 2, 3]).toString("base64"),
    mode: "create",
  });
  assert.deepEqual(await readFile(join(root, "docs", "new.bin")), Buffer.from([1, 2, 3]));
  await assert.rejects(
    broker.write(authority, { grantId: "selected-project-files", path: "docs/new.bin", data: "duplicate", mode: "create" }),
    fileError("FILE_CONFLICT"),
  );
  assert.deepEqual((await readdir(join(root, "docs"))).filter((name) => name.startsWith(".workspace-app-write-")), []);
});

test("Space file broker reauthorizes immediately before an atomic write commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await writeFile(join(root, "notes.txt"), "before", "utf8");
  const broker = new RestrictedAppFileBroker();
  let checks = 0;
  let revoked = false;
  let reachedCommit!: () => void;
  let releaseCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });

  const mutation = broker.write(context(root, {
    authorizeCommit: async () => {
      checks += 1;
      reachedCommit();
      await release;
      if (revoked) throw new Error("authority changed");
    },
  }), {
    grantId: "selected-project-files",
    path: "notes.txt",
    data: "after",
    mode: "replace",
  });
  await commitReached;
  revoked = true;
  releaseCommit();

  await assert.rejects(mutation, /authority changed/);
  assert.equal(checks, 1);
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "before");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".workspace-app-write-")), []);
});

test("Space file broker enforces read, write, and list output limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await writeFile(join(root, "large.txt"), "12345", "utf8");
  await writeFile(join(root, "one.txt"), "1", "utf8");
  await writeFile(join(root, "two.txt"), "2", "utf8");
  const broker = new RestrictedAppFileBroker({ maxReadBytes: 4, maxWriteBytes: 4, maxListEntries: 1 });
  const authority = context(root);

  await assert.rejects(broker.read(authority, { grantId: "selected-project-files", path: "large.txt" }), fileError("FILE_TOO_LARGE"));
  await assert.rejects(
    broker.write(authority, { grantId: "selected-project-files", path: "large.txt", data: "12345", mode: "replace" }),
    fileError("FILE_TOO_LARGE"),
  );
  const listed = await broker.list(authority, { grantId: "selected-project-files", path: "." });
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.truncated, true);
});

test("file grants cannot exceed their reviewed declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-app-files-"));
  await writeFile(join(root, "notes.txt"), "hello", "utf8");
  const broker = new RestrictedAppFileBroker();
  await assert.rejects(
    broker.read(context(root, { declarationAccess: "read", grantAccess: "read-write" }), { grantId: "selected-project-files", path: "notes.txt" }),
    fileError("FILE_DENIED"),
  );
  await assert.rejects(
    broker.read({ ...context(root), declarations: [] }, { grantId: "selected-project-files", path: "notes.txt" }),
    fileError("FILE_DENIED"),
  );
});
