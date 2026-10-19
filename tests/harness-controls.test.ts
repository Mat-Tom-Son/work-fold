import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";
import { createCollaborationTools } from "../src/local/agent/collaboration-tools.js";
import { parseWorkFoldCliActArgv } from "../src/local/cli/act-commands.js";

const exec = promisify(execFile);
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 20)); }
  throw new Error("Timed out waiting for harness state.");
}
async function harness(t: { after(callback: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-controls-"));
  await mkdir(join(root, "pi/extensions"), { recursive: true });
  await writeFile(join(root, "pi/extensions/hold.ts"), `export default pi => pi.registerCommand("hold", { description: "test", handler: async () => { await new Promise(done => setTimeout(done, 50)); return "finished"; } });`);
  let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let first = true;
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), workFolderBase: join(root, "folders"), loadEnv: false,
    piRuntimeProvider: { resolveRuntime: async () => ({ agentDir: join(root, "pi") }) },
    beforeAgentPrompt: async () => { if (first) { first = false; await gate; } },
  });
  t.after(async () => { release(); await api.close(); await rm(root, { recursive: true, force: true }); });
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Source" });
  const { conversation } = await api.actFacade.createConversation({ workFolder: workFolder.id });
  const turn = await api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId: conversation.id, content: "/hold" });
  return { root, api, workFolder, conversation, turn, release };
}

test("typed collaboration preserves literal code and injects only the current turn identity", async () => {
  const invocations: unknown[] = [];
  const tools = createCollaborationTools({ invoke: async (...args) => { invocations.push(args); return { ok: true }; } }, () => "turn-own");
  const message = 'Run `node child.cjs`; keep $(touch SHOULD_NOT_EXIST) literal. "quotes"\nnext line';
  await tools.find(tool => tool.name === "chat_handoff")!.execute("call-1", { message }, undefined, undefined, {} as never);
  assert.deepEqual(invocations[0], ["handoff", "turn-own", { message }, undefined]);
  const idle = createCollaborationTools({ invoke: async () => { throw new Error("must not dispatch"); } }, () => undefined);
  await assert.rejects(idle[0]!.execute("call-2", { message }, undefined, undefined, {} as never), /running turn/);
});

test("an asynchronous answer can arrive during independent work and continues exactly once after it", async t => {
  const h = await harness(t);
  const asked = await h.api.actFacade.chatAsk({ workFolder: h.workFolder.id, taskId: h.turn.taskId, question: "Which format?", options: ["PDF", "Text"], respondent: "person", asynchronous: true });
  assert.equal(h.api.requests.byTaskId(h.turn.taskId)!.state, "working");
  const answer = await h.api.actFacade.chatAnswer({ workFolder: h.workFolder.id, questionId: asked.question.questionId, answer: "/hold" });
  assert.equal(answer.queued, true); assert.equal(answer.continuation, null);
  await assert.rejects(h.api.actFacade.chatAnswer({ workFolder: h.workFolder.id, questionId: asked.question.questionId, answer: "different" }), /different recorded answer/);
  assert.equal(h.api.requests.byTaskId(h.turn.taskId)!.turns.length, 1);
  await writeFile(join(h.workFolder.workFolderRoot, "independent.txt"), "independent work finished");
  h.release();
  await until(() => { const record = h.api.requests.byTaskId(h.turn.taskId)!; return record.turns.length === 2 && record.state === "done"; });
  const question = h.api.requests.question(asked.question.questionId)!;
  assert.ok(question.continuationTaskId);
  await assert.rejects(h.api.actFacade.chatAnswer({ workFolder: h.workFolder.id, questionId: asked.question.questionId, answer: "again" }), /already has an answer/);
  assert.equal(await readFile(join(h.workFolder.workFolderRoot, "independent.txt"), "utf8"), "independent work finished");
});

test("Stop closes a queued asynchronous answer without starting its continuation", async t => {
  const h = await harness(t);
  const asked = await h.api.actFacade.chatAsk({ workFolder: h.workFolder.id, taskId: h.turn.taskId, question: "Format?", respondent: "person", asynchronous: true });
  await h.api.actFacade.chatAnswer({ workFolder: h.workFolder.id, questionId: asked.question.questionId, answer: "/hold" });
  await h.api.actFacade.abortTurn({ workFolder: h.workFolder.id, conversationId: h.conversation.id });
  h.release();
  await until(async () => (await h.api.actFacade.conversationStatus({ workFolder: h.workFolder.id, conversationId: h.conversation.id })).state === "idle");
  assert.equal(h.api.requests.byTaskId(h.turn.taskId)!.turns.length, 1);
  assert.equal(h.api.requests.byTaskId(h.turn.taskId)!.state, "stopped");
});

test("a service outlives request completion but fences deletion until explicitly stopped", async t => {
  const h = await harness(t);
  const started = await h.api.actFacade.jobsStart({ workFolder: h.workFolder.id, taskId: h.turn.taskId, command: "sleep 60", service: true });
  h.release(); await until(() => h.api.requests.byTaskId(h.turn.taskId)!.state === "done");
  assert.equal((await h.api.actFacade.jobsShow({ workFolder: h.workFolder.id, jobId: started.job.jobId })).job.state, "running");
  await assert.rejects(h.api.actFacade.workFoldersUnregister({ workFolder: h.workFolder.id }), /job|running|finish/i);
  await h.api.actFacade.jobsStop({ workFolder: h.workFolder.id, jobId: started.job.jobId });
  assert.equal(h.api.requests.byTaskId(h.turn.taskId)!.turns.length, 1);
});

test("managed working copies isolate writes and preserve dirty files through archive and restore", async t => {
  const h = await harness(t); const cwd = h.workFolder.workFolderRoot;
  await exec("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "source.txt"), "original\n");
  // People may commit portable metadata: a copy still needs its own identity
  // and must not inherit the source Chat's transcripts.
  await exec("git", ["add", "source.txt", ".work-fold"], { cwd });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd });
  const copy = await h.api.actFacade.worktreesManage({ workFolder: h.workFolder.id, taskId: h.turn.taskId, action: "create" }) as any;
  assert.equal(copy.state, "active"); assert.notEqual(copy.workFolderId, h.workFolder.id);
  await writeFile(join(copy.path, "source.txt"), "independent edit\n");
  await writeFile(join(copy.path, "untracked.txt"), "keep this too\n");
  const child = await h.api.actFacade.chatHandoff({ workFolder: h.workFolder.id, taskId: h.turn.taskId, toWorkFolder: copy.workFolderId, message: "/hold", files: [] });
  await assert.rejects(h.api.actFacade.worktreesManage({ workFolder: h.workFolder.id, taskId: h.turn.taskId, action: "archive", id: copy.id }), /running|finish|work/i);
  await until(async () => (await h.api.actFacade.turnStatus({ workFolder: copy.workFolderId, taskId: child.taskId })).task.state === "succeeded");
  await h.api.actFacade.worktreesManage({ workFolder: h.workFolder.id, taskId: h.turn.taskId, action: "archive", id: copy.id });
  const restored = await h.api.actFacade.worktreesManage({ workFolder: h.workFolder.id, taskId: h.turn.taskId, action: "restore", id: copy.id }) as any;
  assert.equal(restored.workFolderId, copy.workFolderId);
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "original\n");
  assert.equal(await readFile(join(copy.path, "source.txt"), "utf8"), "independent edit\n");
  assert.equal(await readFile(join(copy.path, "untracked.txt"), "utf8"), "keep this too\n");
});

test("CLI exposes asynchronous questions, interactive input and managed working copies", () => {
  assert.equal(parseWorkFoldCliActArgv(["chat", "ask", "--work-folder", "wf-1", "--task", "turn-1", "--question", "Format?", "--asynchronous"]).asynchronous, true);
  assert.equal(parseWorkFoldCliActArgv(["jobs", "start", "--work-folder", "wf-1", "--task", "turn-1", "--command", "node", "--interactive", "--service"]).interactive, true);
  assert.equal(parseWorkFoldCliActArgv(["jobs", "input", "--work-folder", "wf-1", "--task", "turn-1", "--job", "job-1", "--text", "answer\n"]).terminalText, "answer\n");
  assert.equal(parseWorkFoldCliActArgv(["worktrees", "manage", "--work-folder", "wf-1", "--task", "turn-1", "--action", "create"]).worktreeAction, "create");
});
