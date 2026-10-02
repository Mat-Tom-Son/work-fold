import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { buildSpaceTurnContext } from "../src/local/agent/space-turn-context.js";
import { scanSpaceTree } from "../src/local/space.js";
import {
  childFolderPaths,
  childFolders,
  descendantFolders,
  folderAncestors,
  folderParentIds,
  folderRootContains,
  folderTreeRows,
} from "../src/shared/folder-nesting.js";
import {
  activeFolderMention,
  addressedFolderIds,
  insertFolderMention,
  matchingMentionFolders,
} from "../web-local/src/lib/folder-mentions.js";
import { combineActivityStatuses } from "../web-local/src/lib/folder-nesting.js";
import { backgroundRunningTransition, folderActivityStatuses } from "../web-local/src/hooks/useChatActivity.js";
import { mentionNames } from "../web-local/src/lib/folder-mentions.js";
import { spaceTreePathMissing } from "../web-local/src/lib/tree.js";

/**
 * Folders inside Folders (2026-10-01): one shared reading of nesting for the
 * switcher, Files, the composer, and the Workers' turn context.
 */

const repo = { id: "repo", name: "workspace", spaceRoot: "/Users/me/dev/workspace" };
const api = { id: "api", name: "api", spaceRoot: "/Users/me/dev/workspace/packages/api" };
const web = { id: "web", name: "web", spaceRoot: "/Users/me/dev/workspace/packages/web/" };
const routes = { id: "routes", name: "routes", spaceRoot: "/Users/me/dev/workspace/packages/api/src/routes" };
const sibling = { id: "sibling", name: "workspace-notes", spaceRoot: "/Users/me/dev/workspace-notes" };
const notes = { id: "notes", name: "Notes", spaceRoot: "/Users/me/Notes" };
const all = [routes, notes, web, sibling, api, repo];

test("the deepest containing Folder is the parent, and a name prefix is not containment", () => {
  assert.equal(folderRootContains(repo.spaceRoot, api.spaceRoot), true);
  assert.equal(folderRootContains(repo.spaceRoot, sibling.spaceRoot), false, "workspace-notes is beside workspace, not inside it");
  assert.equal(folderRootContains(repo.spaceRoot, repo.spaceRoot), false);
  assert.equal(folderRootContains("C:\\Work\\Repo", "c:\\work\\repo\\pkg"), true, "drive paths compare case-insensitively");

  const parents = folderParentIds(all);
  assert.equal(parents.get(repo.id), null);
  assert.equal(parents.get(api.id), repo.id);
  assert.equal(parents.get(web.id), repo.id, "a trailing slash does not change the answer");
  assert.equal(parents.get(routes.id), api.id, "the nearest container wins over the outer one");
  assert.equal(parents.get(sibling.id), null);
});

test("tree rows list top-level Folders A–Z, each followed by its children", () => {
  assert.deepEqual(folderTreeRows(all).map((row) => `${"  ".repeat(row.depth)}${row.space.name}`), [
    "Notes",
    "workspace",
    "  api",
    "    routes",
    "  web",
    "workspace-notes",
  ]);
  assert.deepEqual(folderAncestors(routes, all).map((item) => item.id), [repo.id, api.id]);
  assert.deepEqual(childFolders(repo, all).map((item) => item.id), [api.id, web.id]);
  assert.deepEqual(descendantFolders(repo, all).map((item) => item.id).sort(), [api.id, routes.id, web.id]);
  assert.deepEqual([...childFolderPaths(repo, all)].map(([path, item]) => [path, item.id]), [
    ["packages/api", api.id],
    ["packages/web", web.id],
  ]);
});

test("Files stops at a nested Folder's boundary and a read below it returns nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-nested-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages", "api", "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "packages", "api", "src", "server.ts"), "export {};\n");
  await writeFile(join(root, "packages", "readme.md"), "# packages\n");
  await writeFile(join(root, "docs", "guide.md"), "# guide\n");

  const plain = await scanSpaceTree(root);
  const plainPackages = plain.entries.find((entry) => entry.name === "packages");
  assert.ok(plainPackages?.children?.some((entry) => entry.name === "api" && entry.children?.length), "without boundaries the walk descends");

  const bounded = await scanSpaceTree(root, 20, "", { nestedFolderPaths: ["packages/api"] });
  const packages = bounded.entries.find((entry) => entry.name === "packages");
  const nested = packages?.children?.find((entry) => entry.name === "api");
  assert.equal(nested?.nestedFolder, true);
  assert.equal(nested?.hasChildren, false);
  assert.deepEqual(nested?.children, []);
  assert.ok(packages?.children?.some((entry) => entry.name === "readme.md"), "the parent's own files stay listed");

  assert.deepEqual((await scanSpaceTree(root, 1, "packages/api", { nestedFolderPaths: ["packages/api"] })).entries, []);
  assert.deepEqual((await scanSpaceTree(root, 1, "packages/api/src", { nestedFolderPaths: ["packages/api"] })).entries, []);
});

test("an @ query starts a word, matches by prefix first, and inserts the Folder's name", () => {
  assert.equal(activeFolderMention("email@example", 13), null, "an address is not a mention");
  assert.deepEqual(activeFolderMention("ask @ap", 7), { query: "ap", start: 4, end: 7 });
  assert.deepEqual(activeFolderMention("@", 1), { query: "", start: 0, end: 1 });
  assert.equal(activeFolderMention("ask @api now", 12), null, "the caret has left the mention");

  const folders = [{ id: "1", name: "Design notes" }, { id: "2", name: "api" }, { id: "3", name: "Rapid tests" }];
  assert.deepEqual(matchingMentionFolders(folders, "ap").map((item) => item.id), ["2", "3"]);
  assert.deepEqual(matchingMentionFolders(folders, "notes").map((item) => item.id), ["1"]);

  const mention = activeFolderMention("hey @des please", 8)!;
  assert.deepEqual(insertFolderMention("hey @des please", mention, folders[0]!), { value: "hey @Design notes please", caret: 18 });
  const inside = activeFolderMention("ask @api", 7)!;
  assert.deepEqual(insertFolderMention("ask @api now", inside, folders[1]!), { value: "ask @api now", caret: 9 }, "choosing mid-word replaces the whole word");
});

test("a message addresses each Folder whose @Name it contains, longest names first", () => {
  const folders = [{ id: "api", name: "api" }, { id: "docs", name: "api docs" }, { id: "web", name: "web" }];
  assert.deepEqual(addressedFolderIds("@api docs and @web, please", folders), ["docs", "web"]);
  assert.deepEqual(addressedFolderIds("Ask @API to add paging.", folders), ["api"]);
  assert.deepEqual(addressedFolderIds("email me@api.dev or @apiary", folders), [], "no word start or no boundary means no mention");
  assert.deepEqual(addressedFolderIds("(@web) then @api", folders), ["api", "web"], "results keep the caller's order");
});

test("one dot per Folder: running wins, and a waiting reply counts only for an open-able Chat", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  const chat = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, updatedAt: "2026-10-01T11:00:00.000Z", ...extra });
  const conversations = {
    a: [chat("1"), chat("2")],
    b: [chat("3")],
    c: [chat("4", { archivedAt: "2026-10-01T10:00:00.000Z" })],
  };
  const statuses = { "a:1": "attention", "a:2": "running", "b:3": "attention", "c:4": "attention", "gone:9": "attention", "d:5": "running" } as const;
  assert.deepEqual(folderActivityStatuses(statuses, conversations, now), { a: "running", b: "attention", d: "running" });
  assert.equal(combineActivityStatuses([null, "attention", undefined]), "attention");
  assert.equal(combineActivityStatuses(["attention", "running"]), "running");
  assert.equal(combineActivityStatuses([]), null);
});

test("a background turn that ends unwatched earns a new-reply mark; a watched one does not", () => {
  const watched = new Set(["a:open"]);
  const transition = backgroundRunningTransition(new Set(["a:open", "a:hidden", "b:still"]), new Set(["b:still", "c:new"]), (key) => watched.has(key));
  assert.deepEqual(transition.started, ["c:new"]);
  assert.deepEqual(transition.finished.sort(), ["a:hidden", "a:open"]);
  assert.deepEqual(transition.finishedUnwatched, ["a:hidden"]);
  assert.equal(transition.changed, true);
  assert.equal(backgroundRunningTransition(new Set(["x:1"]), new Set(["x:1"]), () => false).changed, false, "an unchanged report re-renders nothing");
});

test("Folders that share a name are addressed by a qualified name", () => {
  const folders = [
    { id: "a", name: "docs", spaceRoot: "/work/projA/docs" },
    { id: "b", name: "docs", spaceRoot: "/work/projB/docs" },
    { id: "c", name: "api", spaceRoot: "/work/projA/api" },
  ];
  const names = mentionNames(folders);
  assert.deepEqual([...names], [["a", "projA/docs"], ["b", "projB/docs"], ["c", "api"]]);
  const labeled = folders.map((folder) => ({ id: folder.id, name: names.get(folder.id)! }));
  assert.deepEqual(addressedFolderIds("@projB/docs, please", labeled), ["b"]);
  assert.deepEqual(addressedFolderIds("@docs please", labeled), [], "an ambiguous bare name addresses nobody");
});

test("a deleted folder is recognized whatever the server's capitalization", () => {
  assert.equal(spaceTreePathMissing("Requested Space tree path is not a folder."), true);
  assert.equal(spaceTreePathMissing("ENOENT: no such file"), true);
  assert.equal(spaceTreePathMissing("Something else"), false);
});

test("a parent's Worker learns its nested Folders and the Workers the person addressed", () => {
  const spaceTurn = buildSpaceTurnContext({ spaceId: "repo", taskId: "task-1", requestId: "req-1", handleSalt: "salt" });
  spaceTurn.nestedFolders = [{ spaceId: "api", name: "api", path: "packages/api" }];
  const context = buildTurnContextMessage({ spaceTurn, addressedFolders: [{ spaceId: "api", name: "api" }] });
  assert.match(context, /work-folders inside this one, each with its own Worker/);
  assert.match(context, /"path": "packages\/api"/);
  assert.match(context, /chat handoff --to-space <spaceId>/);
  assert.match(context, /addressed these Workers with @/);
  assert.ok(context.indexOf("work-folders inside this one") < context.indexOf("Work only in this Space"), "the stay-inside rule still closes the block");

  const plain = buildTurnContextMessage({ spaceTurn: buildSpaceTurnContext({ spaceId: "notes", taskId: "t", requestId: "r", handleSalt: "salt" }) });
  assert.doesNotMatch(plain, /work-folders inside this one|addressed these Workers/, "a Folder without nesting or mentions hears nothing new");

  const management = buildTurnContextMessage({
    managementSpaces: [{ id: "repo", name: "workspace", spaceRoot: repo.spaceRoot }, { id: "api", name: "api", spaceRoot: api.spaceRoot, parentSpaceId: "repo" }],
    managementTaskId: "task-m",
    addressedFolders: [{ spaceId: "api", name: "api" }],
  });
  assert.match(management, /"parentSpaceId": "repo"/);
  assert.match(management, /chat send --space <spaceId> --new --parent-task/);
});
