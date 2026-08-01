import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WorkspaceCheckTarget } from "../src/shared/checks.js";
import {
  resolveWorkspaceCheckTargets,
  WorkspaceCheckTargetResolutionError,
  type WorkspaceCheckTargetResolutionErrorCode,
} from "../src/local/checks/target-resolver.js";

function file(path: string, role: "primary" | "reference" = "primary"): WorkspaceCheckTarget {
  return { kind: "file", role, path };
}

function tree(
  path: string,
  extensions: string[],
  options: { recursive?: boolean; role?: "primary" | "reference" } = {},
): WorkspaceCheckTarget {
  return {
    kind: "tree",
    role: options.role ?? "primary",
    path,
    recursive: options.recursive ?? false,
    extensions,
  };
}

function resolutionError(code: WorkspaceCheckTargetResolutionErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof WorkspaceCheckTargetResolutionError && error.code === code;
}

async function temporarySpace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace checks targets "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Check targets resolve exact files and explicitly filtered trees in deterministic order", async (t) => {
  const root = await temporarySpace(t);
  await mkdir(join(root, "Trip", "nested"), { recursive: true });
  await writeFile(join(root, "Trip", "z.txt"), "zz", "utf8");
  await writeFile(join(root, "Trip", "A.MD"), "a", "utf8");
  await writeFile(join(root, "Trip", "ignored.pdf"), "pdf", "utf8");
  await writeFile(join(root, "Trip", "nested", "c.md"), "ccc", "utf8");

  const result = await resolveWorkspaceCheckTargets(root, [
    file("Trip/z.txt", "reference"),
    tree("Trip", [".txt", ".MD"], { recursive: true }),
  ]);

  assert.deepEqual(result.files.map(({ path, sizeBytes, selectorIndexes, roles }) => ({ path, sizeBytes, selectorIndexes, roles })), [
    { path: "Trip/A.MD", sizeBytes: 1, selectorIndexes: [1], roles: ["primary"] },
    { path: "Trip/nested/c.md", sizeBytes: 3, selectorIndexes: [1], roles: ["primary"] },
    { path: "Trip/z.txt", sizeBytes: 2, selectorIndexes: [0, 1], roles: ["primary", "reference"] },
  ]);
  assert.equal(result.totalBytes, 6);
  assert.deepEqual(result.missingExactTargets, []);

  const again = await resolveWorkspaceCheckTargets(root, [
    file("Trip/z.txt", "reference"),
    tree("Trip", [".MD", ".txt"], { recursive: true }),
  ]);
  assert.deepEqual(again.files.map((item) => item.path), result.files.map((item) => item.path));
});

test("tree recursion and extension membership are always explicit", async (t) => {
  const root = await temporarySpace(t);
  await mkdir(join(root, "Data", "nested"), { recursive: true });
  await writeFile(join(root, "Data", "top.csv"), "top", "utf8");
  await writeFile(join(root, "Data", "top.txt"), "ignored", "utf8");
  await writeFile(join(root, "Data", "nested", "child.csv"), "child", "utf8");

  const shallow = await resolveWorkspaceCheckTargets(root, [tree("Data", [".csv"])]);
  assert.deepEqual(shallow.files.map((item) => item.path), ["Data/top.csv"]);
  const recursive = await resolveWorkspaceCheckTargets(root, [tree("Data", [".csv"], { recursive: true })]);
  assert.deepEqual(recursive.files.map((item) => item.path), ["Data/nested/child.csv", "Data/top.csv"]);

  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("Data", [])]),
    resolutionError("INVALID_SELECTOR"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("Data", ["*"])]),
    resolutionError("INVALID_SELECTOR"),
  );
});

test("the resolver refuses the Space root, path escapes, and reserved Check material", async (t) => {
  const root = await temporarySpace(t);
  const targets = [
    tree(".", [".md"]),
    file("../outside.txt"),
    file("/tmp/outside.txt"),
    file("C:/outside.txt"),
    file("folder\\outside.txt"),
    file(".workspace/space.json"),
    file("Notes/.PI/AGENTS.md"),
    file("docs/report.txt:alternate"),
    file("docs/CON.txt"),
    file("docs/report.txt."),
    file("docs/report.txt "),
  ];

  for (const target of targets) {
    await assert.rejects(
      resolveWorkspaceCheckTargets(root, [target]),
      (error: unknown) => error instanceof WorkspaceCheckTargetResolutionError
        && (error.code === "UNSAFE_PATH" || error.code === "RESERVED_PATH"),
    );
  }
});

test("reserved metadata nested below an explicit tree is never resolved", async (t) => {
  const root = await temporarySpace(t);
  await mkdir(join(root, "Docs", ".workspace"), { recursive: true });
  await mkdir(join(root, "Docs", ".pi"), { recursive: true });
  await writeFile(join(root, "Docs", "visible.md"), "visible", "utf8");
  await writeFile(join(root, "Docs", ".workspace", "hidden.md"), "hidden", "utf8");
  await writeFile(join(root, "Docs", ".pi", "executable.md"), "executable", "utf8");

  const result = await resolveWorkspaceCheckTargets(root, [tree("Docs", [".md"], { recursive: true })]);
  assert.deepEqual(result.files.map((item) => item.path), ["Docs/visible.md"]);
});

test("exact missing files are data while missing trees and type mismatches are resolver errors", async (t) => {
  const root = await temporarySpace(t);
  await mkdir(join(root, "Expected"));
  await writeFile(join(root, "Expected", "not-a-directory.txt"), "file", "utf8");

  const missing = await resolveWorkspaceCheckTargets(root, [
    file("Expected/missing.md"),
    file("Absent/future.txt", "reference"),
  ]);
  assert.deepEqual(missing.files, []);
  assert.deepEqual(missing.missingExactTargets, [
    { path: "Absent/future.txt", selectorIndexes: [1], roles: ["reference"] },
    { path: "Expected/missing.md", selectorIndexes: [0], roles: ["primary"] },
  ]);

  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("Missing", [".md"])]),
    resolutionError("TARGET_NOT_FOUND"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("Expected/not-a-directory.txt", [".txt"])]),
    resolutionError("TYPE_MISMATCH"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [file("Expected")]),
    resolutionError("TYPE_MISMATCH"),
  );
});

test("exact and tree targets reject symbolic links and junctions", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace checks links "));
  const root = join(sandbox, "Space");
  const outside = join(sandbox, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "outside.md"), "outside", "utf8");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  try {
    await symlink(join(outside, "outside.md"), join(root, "linked.md"), "file");
    await symlink(outside, join(root, "linked-tree"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This Windows host does not allow creating symbolic links or junctions.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [file("linked.md")]),
    resolutionError("SYMLINK"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("linked-tree", [".md"], { recursive: true })]),
    resolutionError("SYMLINK"),
  );

  const linkedRoot = join(sandbox, "linked-root");
  await symlink(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    resolveWorkspaceCheckTargets(linkedRoot, [file("anything.md")]),
    resolutionError("SYMLINK"),
  );
});

test("file-count and byte bounds fail closed without returning a partial target set", async (t) => {
  const root = await temporarySpace(t);
  await mkdir(join(root, "Files"));
  await writeFile(join(root, "Files", "a.txt"), "aaa", "utf8");
  await writeFile(join(root, "Files", "b.txt"), "bbb", "utf8");
  await writeFile(join(root, "Files", "large.txt"), "12345", "utf8");

  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("Files", [".txt"])], { limits: { maxFiles: 2 } }),
    resolutionError("LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [file("Files/large.txt")], { limits: { maxFileBytes: 4 } }),
    resolutionError("LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [file("Files/a.txt"), file("Files/b.txt")], { limits: { maxTotalBytes: 5 } }),
    resolutionError("LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    resolveWorkspaceCheckTargets(root, [tree("Files", [".no-match"])], { limits: { maxVisitedEntries: 2 } }),
    resolutionError("LIMIT_EXCEEDED"),
  );
});
