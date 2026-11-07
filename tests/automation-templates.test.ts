import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { automationTemplateAutomationId, automationTemplates, isAutomationTemplateId } from "../src/shared/automation-templates.js";
import { automationTemplateDeclaration } from "../src/local/automations/automation-templates.js";
import { normalizeWorkFoldAutomationDeclaration } from "../src/local/automations/automation-declarations.js";
import { observeWorkFoldAutomationFiles } from "../src/local/automations/automation-file-observer.js";
import { automationTriggerSummary } from "../src/shared/automation-presentation.js";
import { registerLinkedWorkFolder } from "../src/local/work-folder.js";
import { automationCardRows } from "../web-local/src/components/file-manager/file-manager-automations.js";
import { readableLine, snippet } from "../web-local/src/components/file-manager/useFileManagerSearch.js";

const workFolderId = "space-0123456789abcdef";
const now = new Date("2026-11-07T10:00:00.000Z");

test("every ready-made Automation is a valid declaration with one stable id per work-folder", () => {
  for (const template of automationTemplates) {
    const { declaration, digest } = automationTemplateDeclaration(template.id, workFolderId, now);
    assert.equal(declaration.id, automationTemplateAutomationId(template.id, workFolderId));
    assert.equal(declaration.title, template.title);
    assert.equal(declaration.steps.length, 1);
    const [step] = declaration.steps;
    assert.equal(step!.kind, "chat");
    assert.ok(step!.kind === "chat" && step!.workFolder === workFolderId, "it messages this work-folder's own Worker");
    assert.ok(step!.kind === "chat" && /Don't (rename, change, or delete|move, change, or delete)/.test(step!.message), "it never asks the Worker to delete");
    assert.equal(automationTemplateDeclaration(template.id, workFolderId, now).digest, digest, "the same work-folder and time give the same digest");
  }
  assert.notEqual(automationTemplateAutomationId("organize-new-files", workFolderId), automationTemplateAutomationId("organize-new-files", "space-fedcba9876543210"));
  assert.equal(isAutomationTemplateId("weekly-tidy"), true);
  assert.equal(isAutomationTemplateId("delete-everything"), false);
  const organize = automationTemplateDeclaration("organize-new-files", workFolderId, now).declaration;
  assert.equal(organize.trigger.kind, "files-changed");
  assert.ok(organize.trigger.kind === "files-changed" && organize.trigger.watch.path === "" && organize.trigger.watch.recursive === false && organize.trigger.ifMissed === "run");
  assert.match(automationTriggerSummary(organize.trigger as never), /^When files arrive at the top level · wait 30s/);
  assert.equal(automationTemplateDeclaration("weekly-tidy", workFolderId, now).declaration.trigger.kind, "interval");
});

test("only version 6 watches a work-folder's top level, and never recursively", () => {
  const base = automationTemplateDeclaration("organize-new-files", workFolderId, now).declaration;
  const trigger = base.trigger as Record<string, unknown>;
  assert.throws(() => normalizeWorkFoldAutomationDeclaration({ ...base, version: 5 }), /top level requires contract version 6/);
  assert.throws(() => normalizeWorkFoldAutomationDeclaration({ ...base, trigger: { ...trigger, watch: { kind: "tree", path: "", recursive: true, extensions: [".pdf"] } } }), /only without recursion/);
  assert.throws(() => normalizeWorkFoldAutomationDeclaration({ ...base, trigger: { ...trigger, watch: { kind: "tree", path: ".", recursive: false, extensions: [".pdf"] } } }), /normalized relative path/);
  // A named subfolder still works exactly as before.
  const named = normalizeWorkFoldAutomationDeclaration({ ...base, version: 5, trigger: { ...trigger, watch: { kind: "tree", path: "Incoming", recursive: true, extensions: [".pdf"] } } });
  assert.ok(named.trigger.kind === "files-changed" && named.trigger.watch.path === "Incoming");
});

test("a top-level watch sees only the files directly in the work-folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "top-level-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workFolder = await registerLinkedWorkFolder(root);
  await writeFile(join(root, "receipt.pdf"), "pdf");
  await writeFile(join(root, "notes.txt"), "not watched: .txt is not in this list");
  await writeFile(join(root, ".hidden.pdf"), "hidden");
  await writeFile(join(root, "~$draft.pdf"), "office lock file");
  await mkdir(join(root, "Receipts"));
  await writeFile(join(root, "Receipts", "old.pdf"), "already filed");
  const nested = join(root, "Taxes");
  await mkdir(nested);
  await writeFile(join(nested, "w2.pdf"), "belongs to its own Worker");
  await registerLinkedWorkFolder(nested);

  const snapshot = await observeWorkFoldAutomationFiles({
    kind: "files-changed",
    workFolder: workFolder.id,
    watch: { kind: "tree", path: "", recursive: false, extensions: [".pdf"] },
    debounceSeconds: 30,
    cooldownMinutes: 5,
  });
  assert.deepEqual(Object.keys(snapshot.entries), ["receipt.pdf"]);
  await writeFile(join(root, "invoice.pdf"), "new");
  const after = await observeWorkFoldAutomationFiles({
    kind: "files-changed",
    workFolder: workFolder.id,
    watch: { kind: "tree", path: "", recursive: false, extensions: [".pdf"] },
    debounceSeconds: 30,
    cooldownMinutes: 5,
  });
  assert.deepEqual(Object.keys(after.entries).sort(), ["invoice.pdf", "receipt.pdf"]);
  assert.notEqual(after.digest, snapshot.digest);
});

test("the Automations card lists the folder's own first, then each ready-made one as it stands here", () => {
  const organizeId = automationTemplateAutomationId("organize-new-files", workFolderId);
  const rows = automationCardRows(workFolderId, [
    { automationId: "automation-own-12345678", title: "Budget check-in", state: "off", triggerSummary: "Every week", nextRunAt: null, lastRun: null, roles: [] },
    { automationId: organizeId, title: "Organize New Files", state: "on", triggerSummary: "When files arrive at the top level", nextRunAt: null, lastRun: null, roles: [] },
  ]);
  assert.deepEqual(rows.map((row) => [row.title, row.on, row.templateId ?? null]), [
    ["Budget check-in", false, null],
    ["Organize New Files", true, "organize-new-files"],
    ["Give New Files Clear Names", false, "name-new-files"],
    ["Keep Screenshots Together", false, "screenshots"],
    ["Weekly Tidy-Up", false, "weekly-tidy"],
  ]);
});

test("a search snippet keeps whole words around the match", () => {
  assert.deepEqual(snippet("Kitchen refresh: three quotes are in", "quotes"), { pre: "Kitchen refresh: three ", hit: "quotes", post: " are in" });
  const long = snippet(`${"word ".repeat(20)}budget ${"more ".repeat(20)}`, "budget");
  assert.ok(long.pre.startsWith("…") && long.post.endsWith("…"));
  assert.equal(long.hit, "budget");
  assert.deepEqual(snippet("nothing here", "missing"), { pre: "nothing here", hit: "", post: "" });
  // Markdown's marks are left out of the preview.
  assert.deepEqual(snippet("- **Fixed-price quote:** $18,400 from [Oak & Pine](https://example.com)", "quote"), { pre: "Fixed-price ", hit: "quote", post: ": $18,400 from Oak & Pine" });
  assert.equal(readableLine("## Next `steps` for _the_ garden"), "Next steps for the garden");
  assert.equal(readableLine("- [x] Compare scope"), "Compare scope");
});
