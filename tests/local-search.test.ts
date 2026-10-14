import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { searchWorkFolder } from "../src/local/search.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";
import { setWorkFolderIgnoreState } from "../src/local/work-folder-ignore.js";

async function workFolder(name: string): Promise<{ root: string; dispose: () => Promise<void> }> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-folder-search-${name}-`));
  const root = join(sandbox, "work-folder");
  configureWorkFoldStateRoot(join(sandbox, "state"));
  await mkdir(root, { recursive: true });
  return {
    root,
    dispose: async () => {
      configureWorkFoldStateRoot(undefined);
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

test("search finds file contents and Chat messages with locating detail", async (t) => {
  const { root, dispose } = await workFolder("basic");
  t.after(dispose);
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), "intro\nthe Quarterly budget is due\ntail", "utf8");
  await writeFile(join(root, "other.txt"), "nothing relevant here", "utf8");
  await appendMessage(root, "chat-1", {
    id: "m1",
    role: "user",
    content: "can you check the quarterly budget spreadsheet",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  await appendMessage(root, "chat-1", {
    id: "m2",
    role: "assistant",
    content: `${"context\n".repeat(40)}the quarterly budget is ready`,
    createdAt: "2026-07-01T00:01:00.000Z",
  });

  const result = await searchWorkFolder(root, "quarterly budget");
  assert.deepEqual(result.files, [{
    path: "notes/plan.md",
    line: 2,
    preview: "the Quarterly budget is due",
  }], "a file match carries the path and line needed to open it");
  assert.equal(result.files.length, 1, "unrelated files do not match");
  assert.equal(result.chats.length, 2);
  assert.equal(result.chats[0]?.conversationId, "chat-1");
  assert.equal(result.chats[0]?.role, "user");
  assert.match(result.chats[0]?.preview ?? "", /quarterly budget spreadsheet/);
  assert.match(result.chats[1]?.preview ?? "", /quarterly budget is ready/, "preview indices are computed after whitespace normalization");
  assert.equal(result.truncated, false);
});

test("search honours ignore rules and identifies binary files without skipping large text", async (t) => {
  const { root, dispose } = await workFolder("bounds");
  t.after(dispose);
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor", "bundled.js"), "needle in ignored dependency", "utf8");
  await writeFile(join(root, "kept.txt"), "needle in ordinary content", "utf8");
  await writeFile(join(root, "image.bin"), Buffer.concat([Buffer.from("needle"), Buffer.alloc(64)]));
  await writeFile(join(root, "huge.txt"), `${"padding\n".repeat(200)}needle\n`, "utf8");

  await setWorkFolderIgnoreState(root, ["vendor"], true);
  const result = await searchWorkFolder(root, "needle");

  assert.deepEqual(result.files.map((match) => match.path), ["huge.txt", "kept.txt"]);
  assert.equal(result.coverage.binary, 1);
  assert.equal(result.coverage.ignored, 1);
  assert.equal(result.truncated, false, "skipping content by policy is not truncation");
});

test("search stops at its bounds and reports that it did", async (t) => {
  const { root, dispose } = await workFolder("truncate");
  t.after(dispose);
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(root, `file-${index}.txt`), "needle\nneedle\n", "utf8");
  }

  const capped = await searchWorkFolder(root, "needle", { maxMatches: 5 });
  assert.equal(capped.files.length, 5);
  assert.equal(capped.truncated, true, "hitting the match cap is disclosed");

  const scanned = await searchWorkFolder(root, "needle", { maxScannedFiles: 2, maxMatches: 1_000 });
  assert.ok(scanned.scannedFiles <= 2);
  assert.equal(scanned.truncated, true, "hitting the scan cap is disclosed");
});

test("search rejects an empty or oversized query", async (t) => {
  const { root, dispose } = await workFolder("invalid");
  t.after(dispose);
  await assert.rejects(() => searchWorkFolder(root, "   "), /Enter something to search for/);
  await assert.rejects(() => searchWorkFolder(root, "x".repeat(64 * 1024 + 1)), /Search text is too long/);
});

test("search stops immediately when its caller is cancelled", async (t) => {
  const { root, dispose } = await workFolder("cancelled");
  t.after(dispose);
  await writeFile(join(root, "note.txt"), "needle", "utf8");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => searchWorkFolder(root, "needle", { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("search pages through byte, match and traversal budgets with a match beyond 1 MiB in one line", async (t) => {
  const { root, dispose } = await workFolder("continuation"); t.after(dispose);
  await writeFile(join(root, "large.txt"), `${"x".repeat(1024 * 1024 + 7)}NEEDLE😀\nneedle\nneedle\n`);
  await writeFile(join(root, "last.txt"), "needle\n");
  const matches = []; let cursor: string | undefined; let pages = 0;
  do {
    const page = await searchWorkFolder(root, "needle", { includeChats: false, maxMatches: 1, maxScannedFiles: 2, maxScannedBytes: 32768, cursor });
    assert.ok(page.coverage.scannedBytes <= 32771, "at most a UTF-8 character crosses the byte budget");
    matches.push(...page.files); cursor = page.nextCursor ?? undefined; pages++;
    assert.ok(pages < 100);
  } while (cursor);
  assert.deepEqual(matches.map(({path,line}) => [path,line]), [["large.txt",1],["large.txt",2],["large.txt",3],["last.txt",1]]);
  assert.ok(pages > 32);
});

test("search narrows a subtree and rejects changed sources or a cursor from another selection", async (t) => {
  const { root, dispose } = await workFolder("source"); t.after(dispose);
  await mkdir(join(root,"selected"));
  await writeFile(join(root,"selected","one.txt"), "needle\nneedle\n");
  await writeFile(join(root,"elsewhere.txt"), "needle");
  const page = await searchWorkFolder(root,"needle", {path:"selected",includeChats:false,maxMatches:1});
  assert.equal(page.files[0]?.path,"selected/one.txt"); assert.ok(page.nextCursor);
  await assert.rejects(searchWorkFolder(root,"other", {path:"selected",includeChats:false,cursor:page.nextCursor!}),/selection/);
  await writeFile(join(root,"selected","one.txt"), "changed\nneedle\n");
  await assert.rejects(searchWorkFolder(root,"needle", {path:"selected",includeChats:false,cursor:page.nextCursor!}),/changed/);
});

test("directory depth and Chat count are continuation work, while symlinks stay excluded", async (t) => {
  const { root, dispose } = await workFolder("depth"); t.after(dispose);
  const deep = Array.from({length:40},()=>"d").join("/");
  await mkdir(join(root,deep),{recursive:true}); await writeFile(join(root,deep,"deep.txt"),"needle");
  await symlink(join(root,deep,"deep.txt"),join(root,"link.txt"));
  let cursor: string | undefined; const files=[]; let links=0;
  do {
    const page=await searchWorkFolder(root,"needle",{includeChats:false,maxScannedFiles:3,cursor});
    files.push(...page.files); links+=page.coverage.symbolicLink; cursor=page.nextCursor??undefined;
  } while(cursor);
  assert.deepEqual(files.map(file=>file.path),[`${deep}/deep.txt`]); assert.equal(links,1);
  for(let index=0;index<3;index++) await appendMessage(root,`chat-${index}`,{id:`m-${index}`,role:"user",content:"needle",createdAt:"2026-09-27T00:00:00.000Z"});
  const chats=[];
  do { const page=await searchWorkFolder(root,"needle",{includeFiles:false,maxMatches:1,cursor}); chats.push(...page.chats); cursor=page.nextCursor??undefined; } while(cursor);
  assert.equal(chats.length,3); assert.equal(new Set(chats.map(chat=>chat.conversationId)).size,3);
});

test("registered nested work-folders and reserved paths cannot enter a narrowed search", async (t) => {
  const {root,dispose}=await workFolder("nested");t.after(dispose);
  const {registerLinkedWorkFolder}=await import("../src/local/work-folder.js");
  await registerLinkedWorkFolder(root);
  await mkdir(join(root,"Child")); await writeFile(join(root,"Child","private.txt"),"needle");
  await registerLinkedWorkFolder(join(root,"Child"));
  const result=await searchWorkFolder(root,"needle",{includeChats:false});
  assert.deepEqual(result.files,[]); assert.ok(result.coverage.internal>=1);
  const narrowed=await searchWorkFolder(root,"needle",{includeChats:false,path:"Child"}); assert.deepEqual(narrowed.files,[]);
  if(process.platform==="darwin") { const alias=await searchWorkFolder(root,"needle",{includeChats:false,path:"child"}); assert.deepEqual(alias.files,[]); }
  await assert.rejects(searchWorkFolder(root,"needle",{path:".work-fold"}),/reserved/);
  await assert.rejects(searchWorkFolder(root,"needle",{path:"../outside"}),/escapes/);
});

test("large match payloads continue before the response budget instead of losing results", async (t) => {
  const {root,dispose}=await workFolder("response-budget");t.after(dispose);
  const parent=Array.from({length:6},(_,index)=>`${index}${"x".repeat(99)}`).join("/");
  await mkdir(join(root,parent),{recursive:true});
  await writeFile(join(root,parent,"matches.txt"),`${"x".repeat(100)}needle${"x".repeat(100)}\n`.repeat(1000));
  let cursor: string|undefined; const lines=[]; let pages=0;
  do { const page=await searchWorkFolder(root,"needle",{includeChats:false,maxMatches:1000,cursor});
    assert.ok(Buffer.byteLength(JSON.stringify(page.files))<530000); lines.push(...page.files.map(match=>match.line));cursor=page.nextCursor??undefined;pages++;
  } while(cursor);
  assert.deepEqual(lines,Array.from({length:1000},(_,index)=>index+1)); assert.ok(pages>1);
});
