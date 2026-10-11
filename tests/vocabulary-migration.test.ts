import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  migrateVocabularyState,
  migrateVocabularyValue,
  migrateWorkFolderMetadata,
  vocabularyMigrationBackupDir,
  vocabularyMigrationMarker,
} from "../src/local/vocabulary-migration.js";

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** A profile shaped like a real pre-2026-10-10 install (keys and values seen in the wild). */
async function legacyProfile(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-vocabulary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "spaces", "taxes");
  await put(join(folder, ".work-fold", "space.json"), { version: 1, id: "space-0123456789abcdef", name: "Taxes" });
  await put(join(folder, ".work-fold", "conversations", "chat-1.jsonl"), `${JSON.stringify({ role: "user", content: "space" })}\n`);
  await put(join(root, "space-registry.json"), { version: 1, spaces: [{ name: "Taxes", spaceRoot: folder, location: { kind: "local", storage: "managed" }, id: "space-0123456789abcdef" }] });
  await put(join(root, "assistant-model-preferences.json"), { version: 2, scopes: { management: { instructions: "Be brief.", updatedAt: "2026-10-01T00:00:00.000Z" }, "space:space-0123456789abcdef": { model: { provider: "p", id: "m" }, updatedAt: "2026-10-01T00:00:00.000Z" } } });
  await put(join(root, "glance-seen.json"), { version: 1, seen: {} });
  await put(join(root, "routings", "routings.json"), { schemaVersion: 1, routings: [] });
  await put(join(root, "routings", "receipts.jsonl"), [
    JSON.stringify({ scope: "routing", routingId: "routing-5500ca1f070231af", fromSpaceId: "space-0123456789abcdef", hopKind: "chat" }),
    "{ damaged line",
  ].join("\n"));
  await put(join(root, "trash", "entries", "trash-20261007211827-a472add1", "manifest.json"), { kind: "space", reason: "spaces.delete", spaceName: "Old", id: "trash-20261007211827-a472add1" });
  await put(join(root, "state", "spaces", "taxes-0011223344556677", "history", "meta.json"), { spaceRoot: folder });
  await put(join(root, "checks", "spaces", "space-0123456789abcdef-aa.json"), { spaceId: "space-0123456789abcdef" });
  await put(join(root, "fold", "publications.json"), { publications: [{ spaceId: "space-0123456789abcdef", title: "space" }] });
  await put(join(root, "requests", "requests.jsonl"), `${JSON.stringify({ kind: "management", owner: { spaceId: "work-fold-management", spaceRoot: join(root, "management") }, content: "routing" })}\n`);
  await put(join(root, "turns", "turns.jsonl"), `${JSON.stringify({ spaceId: "work-fold-management", assistantText: "space" })}\n`);
  await put(join(root, "cli", "receipts", "act.jsonl"), [
    JSON.stringify({ command: "manage.send", outcome: "ok" }),
    JSON.stringify({ command: "routings.enable", undoRef: { kind: "routing-id", value: "routing-156e9b8e0c99ce4e" } }),
    JSON.stringify({ command: "spaces.rename", undoRef: { kind: "space-name", value: "Old" } }),
    JSON.stringify({ command: "manage.glance", outcome: "ok" }),
  ].join("\n"));
  await put(join(root, "restricted-apps", "registry.json"), { schemaVersion: 6, acceptedAutomationRuns: [], historicalAutomationRuns: [] });
  await put(join(root, "management", "weekly.work-fold-routing.json"), { kind: "work-fold.routing-proposal" });
  await put(join(root, "management", ".work-fold", "conversations", "chat-2.jsonl"), `${JSON.stringify({ role: "assistant", content: "routing" })}\n`);
  return { root, folder };
}

test("a legacy profile moves to the new store names, keys, and values once", async (t) => {
  const { root, folder } = await legacyProfile(t);
  const report = await migrateVocabularyState(root);
  assert.equal(report.alreadyMigrated, false);

  // Stores moved to their new names; the agent's own folder and managed folders stay put.
  for (const gone of ["space-registry.json", "assistant-model-preferences.json", "glance-seen.json", "routings", "trash", join("state", "spaces"), join("checks", "spaces"), join("fold", "publications.json")]) {
    assert.equal(existsSync(join(root, gone)), false, `${gone} moved`);
  }
  assert.ok(existsSync(join(root, "management")), "the work-fold agent's working folder keeps its name");
  assert.ok(existsSync(join(root, "spaces", "taxes")), "managed work-folders stay where they are");
  assert.ok(existsSync(join(root, "automations", "automations.json")));
  assert.ok(existsSync(join(root, "management", "weekly.work-fold-automation.json")), "proposals take the new suffix");

  // Keys and enum values follow the code; ids keep their shape where they are portable.
  const registry = await json(join(root, "work-folder-registry.json"));
  assert.deepEqual(Object.keys(registry), ["version", "workFolders"]);
  assert.equal(registry.workFolders[0].workFolderRoot, folder);
  assert.equal(registry.workFolders[0].id, "space-0123456789abcdef");
  assert.equal(registry.workFolders[0].location.storage, "managed");

  const preferences = await json(join(root, "model-preferences.json"));
  assert.deepEqual(Object.keys(preferences.scopes).sort(), ["agent", "work-folder:space-0123456789abcdef"]);
  assert.equal(preferences.scopes.agent.instructions, "Be brief.");

  const [receipt, damaged] = (await readFile(join(root, "automations", "receipts.jsonl"), "utf8")).split("\n");
  assert.deepEqual(JSON.parse(receipt!), { scope: "automation", automationId: "automation-5500ca1f070231af", fromWorkFolderId: "space-0123456789abcdef", hopKind: "chat" });
  assert.equal(damaged, "{ damaged line", "a damaged line survives untouched");

  const entry = await json(join(root, "recently-deleted", "entries", "trash-20261007211827-a472add1", "manifest.json"));
  assert.deepEqual(entry, { kind: "work-folder", reason: "work-folders.delete", workFolderName: "Old", id: "trash-20261007211827-a472add1" });

  const [request] = (await readFile(join(root, "requests", "requests.jsonl"), "utf8")).split("\n");
  const parsedRequest = JSON.parse(request!);
  assert.equal(parsedRequest.kind, "agent");
  assert.equal(parsedRequest.owner.workFolderId, "work-fold-agent");
  assert.equal(parsedRequest.owner.workFolderRoot, join(root, "management"), "paths are data, not vocabulary");
  assert.equal(parsedRequest.content, "routing", "a person's words are never remapped");

  const turn = JSON.parse((await readFile(join(root, "turns", "turns.jsonl"), "utf8")).trim());
  assert.deepEqual(turn, { workFolderId: "work-fold-agent", assistantText: "space" });

  const acts = (await readFile(join(root, "cli", "receipts", "act.jsonl"), "utf8")).split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(acts.map((act) => act.command), ["agent.send", "automations.enable", "work-folders.rename", "agent.overview"]);
  assert.deepEqual(acts[1].undoRef, { kind: "automation-id", value: "automation-156e9b8e0c99ce4e" });
  assert.deepEqual(acts[2].undoRef, { kind: "work-folder-name", value: "Old" });

  const publications = await json(join(root, "shared-pages", "publications.json"));
  assert.deepEqual(publications.publications[0], { workFolderId: "space-0123456789abcdef", title: "space" });

  assert.deepEqual(Object.keys(await json(join(root, "restricted-apps", "registry.json"))), ["schemaVersion", "acceptedAppAutomationRuns", "historicalAppAutomationRuns"]);

  // Conversation logs carry people's words and are never rewritten.
  assert.equal((await readFile(join(folder, ".work-fold", "conversations", "chat-1.jsonl"), "utf8")).trim(), JSON.stringify({ role: "user", content: "space" }));
  assert.equal((await readFile(join(root, "management", ".work-fold", "conversations", "chat-2.jsonl"), "utf8")).trim(), JSON.stringify({ role: "assistant", content: "routing" }));

  // The registered folder's portable manifest moved too.
  assert.equal(existsSync(join(folder, ".work-fold", "space.json")), false);
  assert.equal((await json(join(folder, ".work-fold", "work-folder.json"))).id, "space-0123456789abcdef");
  assert.deepEqual(report.workFolders, [folder]);

  // Every rewritten file has a backup of its original bytes.
  assert.ok(report.rewritten.length > 0);
  for (const file of report.rewritten) assert.ok(existsSync(join(root, vocabularyMigrationBackupDir, file)), `${file} was backed up`);
  assert.ok(existsSync(join(root, vocabularyMigrationMarker)));

  // A second start changes nothing.
  const again = await migrateVocabularyState(root);
  assert.equal(again.alreadyMigrated, true);
});

test("a store whose new name already exists is never overwritten", async (t) => {
  const { root } = await legacyProfile(t);
  await put(join(root, "work-folder-registry.json"), { version: 1, workFolders: [] });
  await migrateVocabularyState(root);
  assert.deepEqual(await json(join(root, "work-folder-registry.json")), { version: 1, workFolders: [] });
  assert.ok(existsSync(join(root, "space-registry.json")), "the old store is left for the person to inspect");
});

test("a fresh state root and a folder without legacy metadata are no-ops", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-vocabulary-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await migrateVocabularyState(root);
  assert.deepEqual(report, { alreadyMigrated: false, moved: [], rewritten: [], workFolders: [] });
  assert.equal(await migrateWorkFolderMetadata(join(root, "nowhere")), false);
});

test("a folder's legacy manifest moves only when it is a plain file in a plain directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-vocabulary-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const elsewhere = join(root, "elsewhere");
  await put(join(elsewhere, "space.json"), { id: "space-0123456789abcdef" });
  const linked = join(root, "linked");
  await mkdir(linked);
  await symlink(elsewhere, join(linked, ".work-fold"));
  assert.equal(await migrateWorkFolderMetadata(linked), false);
  assert.ok(existsSync(join(elsewhere, "space.json")), "a linked metadata directory is never followed");

  const plain = join(root, "plain");
  await put(join(plain, ".work-fold", "space.json"), { id: "space-0123456789abcdef" });
  assert.equal(await migrateWorkFolderMetadata(plain), true);
  assert.equal(await migrateWorkFolderMetadata(plain), false, "the second call has nothing to move");
  assert.ok(existsSync(join(plain, ".work-fold", "work-folder.json")));
});

test("value mapping leaves human text and opaque ids alone", () => {
  assert.deepEqual(
    migrateVocabularyValue({ kind: "space", title: "space", id: "space-0123456789abcdef", entry: "trash-20261007211827-a472add1", scope: "personal" }),
    { kind: "work-folder", title: "space", id: "space-0123456789abcdef", entry: "trash-20261007211827-a472add1", scope: "everywhere" },
  );
});
