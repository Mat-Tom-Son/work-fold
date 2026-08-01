import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyManagementAttachments,
  loadManagementAttachmentsForTurn,
  managementAttachmentLinks,
  maxManagementAttachments,
} from "../src/local/management-attachments.js";

test("management attachments classify files, folders, and links as typed references", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "management-attachments-test-"));
  try {
    await writeFile(join(sandbox, "report.txt"), "external report", "utf8");
    await mkdir(join(sandbox, "incoming"), { recursive: true });
    for (const reserved of [".work-fold", ".WORKSPACE", ".Pi"]) {
      await mkdir(join(sandbox, "nested", reserved), { recursive: true });
      await writeFile(join(sandbox, "nested", reserved, "private.txt"), "private", "utf8");
    }

    const refs = await classifyManagementAttachments(
      [join(sandbox, "report.txt"), "incoming", "https://example.com/owner/project"],
      sandbox,
    );
    assert.deepEqual(refs.map((ref) => ref.kind), ["file", "folder", "url"]);
    assert.equal(refs[0]!.target, join(sandbox, "report.txt"));
    assert.equal(refs[0]!.name, "report.txt");
    assert.equal(refs[1]!.target, join(sandbox, "incoming"), "relative paths resolve against the caller's cwd");
    assert.equal(refs[2]!.target, "https://example.com/owner/project");
    assert.equal(refs[2]!.name, "example.com/owner/project");
    assert.deepEqual(managementAttachmentLinks(refs), ["https://example.com/owner/project"]);

    // Duplicates collapse to one reference.
    const deduped = await classifyManagementAttachments(
      [join(sandbox, "report.txt"), join(sandbox, "report.txt")],
      sandbox,
    );
    assert.equal(deduped.length, 1);

    await assert.rejects(() => classifyManagementAttachments(["missing.txt"], sandbox), /not found/);
    await assert.rejects(() => classifyManagementAttachments(["ftp://example.com/file"], sandbox), /Only http\(s\) links/);
    await assert.rejects(() => classifyManagementAttachments(["https://[broken"], sandbox), /Invalid link/);
    await assert.rejects(() => classifyManagementAttachments(["https://user:secret@example.com/file"], sandbox), /embedded credentials/);
    await assert.rejects(() => classifyManagementAttachments([""], sandbox), /cannot be empty/);
    for (const reserved of [".work-fold", ".WORKSPACE", ".Pi"]) {
      await assert.rejects(
        () => classifyManagementAttachments([join(sandbox, "nested", reserved, "private.txt")], sandbox),
        /reserved/i,
      );
    }
    await assert.rejects(
      () => classifyManagementAttachments(Array.from({ length: maxManagementAttachments + 1 }, () => join(sandbox, "report.txt")), sandbox),
      /At most/,
    );
    if (process.platform !== "win32") {
      await symlink(join(sandbox, "report.txt"), join(sandbox, "linked.txt"));
      await assert.rejects(() => classifyManagementAttachments([join(sandbox, "linked.txt")], sandbox), /Symbolic links/);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("management attachment loading inlines readable files and keeps folders and binaries path-only", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "management-attachments-load-test-"));
  try {
    await writeFile(join(sandbox, "notes.md"), "# Notes\nplain readable text\n", "utf8");
    await writeFile(join(sandbox, "binary.bin"), Buffer.from([0, 1, 2, 0, 3, 4, 0, 5]));
    await mkdir(join(sandbox, "material"), { recursive: true });

    const refs = await classifyManagementAttachments(
      [join(sandbox, "notes.md"), join(sandbox, "binary.bin"), join(sandbox, "material"), "https://example.com"],
      sandbox,
    );
    const loaded = await loadManagementAttachmentsForTurn(refs);

    // Links never masquerade as files: three filesystem references load.
    assert.equal(loaded.length, 3);

    const notes = loaded.find((item) => item.sourceFileName === "notes.md")!;
    assert.equal(notes.mode, "full_original_text");
    assert.equal(notes.includedInPrompt, true);
    assert.match(notes.text ?? "", /plain readable text/);
    assert.equal(notes.sourcePath, join(sandbox, "notes.md"), "management attachments carry absolute paths");

    const binary = loaded.find((item) => item.sourceFileName === "binary.bin")!;
    assert.equal(binary.mode, "path_only_reference");
    assert.equal(binary.includedInPrompt, false);
    assert.equal(binary.text, null);

    const folder = loaded.find((item) => item.sourceFileName === "material")!;
    assert.equal(folder.mode, "path_only_reference");
    assert.match(folder.reason ?? "", /Folders are attached by path/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
