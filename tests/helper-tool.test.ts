import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  createHelperReadTools,
  createHelperTool,
  helperGlobMatcher,
  HelperPathRefusal,
  HelperPathScope,
  helperResultToolName,
  helperSystemPrompt,
  helperToolName,
} from "../src/local/agent/helper-tool.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { buildWorkFolderTurnContext } from "../src/local/agent/work-folder-turn-context.js";
import { startLocalApi } from "../src/local/server.js";

/** A work-folder with ordinary files, reserved metadata, and links that lead out of it or into metadata. */
async function fixture(t: { after(fn: () => unknown): void }) {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-helper-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "Research");
  const outside = join(sandbox, "Private");
  await mkdir(join(root, "notes", "deep"), { recursive: true });
  await mkdir(join(root, ".work-fold"), { recursive: true });
  await mkdir(join(root, ".pi"), { recursive: true });
  await mkdir(join(root, ".workspace"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "notes", "a.md"), "alpha needle\nsecond line\n");
  await writeFile(join(root, "notes", "deep", "b.txt"), "nothing here\n");
  await writeFile(join(root, "README.md"), "Research folder\n");
  await writeFile(join(root, ".work-fold", "work-folder.json"), "{\"needle\":true}\n");
  await writeFile(join(root, ".pi", "settings.json"), "{\"needle\":true}\n");
  await writeFile(join(root, ".workspace", "legacy.json"), "needle\n");
  await writeFile(join(outside, "secret.txt"), "outside needle\n");
  await symlink(outside, join(root, "link-out"));
  await symlink(join(outside, "secret.txt"), join(root, "link-file.txt"));
  await symlink(join(root, ".work-fold"), join(root, "meta"));
  return { sandbox, root, outside };
}

function runtimeWith(root: string) {
  const faux = fauxProvider({ provider: "fixture-helper", models: [{ id: "chat", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] });
  const credentials = FileCredentialStore.inMemory();
  return {
    faux,
    async provider() {
      const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
      modelRuntime.registerNativeProvider(faux.provider);
      return {
        resolveRuntime: async () => ({
          agentDir: join(root, "..", "pi"), credentials, modelRuntime,
          preferredModel: { provider: "fixture-helper", id: "chat" },
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        }),
      };
    },
  };
}

test("a helper accepts explicit null defaults through native argument validation and inherits the connected parent", async t => {
  const { root } = await fixture(t); const setup = runtimeWith(root);
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(helperToolName, { task: "Return a short acknowledgement.", model: null, thinking: null, tools: null, paths: null })),
    fauxAssistantMessage(fauxToolCall(helperResultToolName, { summary: "Acknowledged", outcome: "succeeded" })),
    fauxAssistantMessage("Done."),
  ]);
  const client = new PiConversationClient("null-defaults", root, await setup.provider(), undefined, { helperTool: true });
  t.after(() => client.stop());
  const workFolderTurn = buildWorkFolderTurnContext({ workFolderId: "space-0123456789abcdef", taskId: "turn-null", requestId: "req-null", handleSalt: "salt" });
  assert.equal(await client.prompt("Do focused reading as appropriate.", { workFolderTurn }), "Done.");
  const runs = client.getTurnHelperRuns(); assert.equal(runs.length, 1); assert.equal(runs[0]!.outcome, "succeeded");
  assert.deepEqual(runs[0]!.model, { provider: "fixture-helper", id: "chat" });
});

function texts(value: unknown): string {
  return JSON.stringify(value);
}

test("helper paths are enforced by real path: outside, home, links out and reserved metadata are refused", async (t) => {
  const { root, outside } = await fixture(t);
  const scope = new HelperPathScope(root);
  assert.equal((await scope.resolve("notes/a.md")).relative, "notes/a.md");
  assert.equal((await scope.resolve(join(root, "notes"))).relative, "notes");
  assert.equal((await scope.resolve("")).relative, ".");
  for (const refused of [
    "../Private/secret.txt", join(outside, "secret.txt"), "~/.ssh/id_rsa", "/etc/hosts",
    ".work-fold/work-folder.json", ".PI/settings.json", ".workspace/legacy.json", "notes/../.pi",
    "link-file.txt", "link-out/secret.txt", "meta/work-folder.json", "missing/../../Private",
  ]) {
    await assert.rejects(scope.resolve(refused), HelperPathRefusal, refused);
  }
  await assert.rejects(scope.resolve("does-not-exist.md"), /not found/);
});

test("helper grep, find, ls and read stay inside the work-folder and never enter reserved folders or links", async (t) => {
  const { root } = await fixture(t);
  const scope = new HelperPathScope(root);
  const tools = Object.fromEntries(createHelperReadTools(scope).map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ["find", "grep", "ls", "read"]);
  const signal = new AbortController().signal;
  const run = async (name: string, params: Record<string, unknown>) =>
    (await tools[name]!.execute(params, signal)).content.map((part) => part.text).join("\n");

  const grep = await run("grep", { pattern: "needle" });
  assert.equal(grep, "notes/a.md:1: alpha needle", "only the ordinary file matches");
  assert.equal(await run("grep", { pattern: "NEEDLE", ignoreCase: true, glob: "*.md" }), "notes/a.md:1: alpha needle");
  assert.equal(await run("grep", { pattern: "needle", path: "notes/deep" }), "No matches found");
  assert.match(await run("grep", { pattern: "second", context: 1 }), /notes\/a\.md-1- alpha needle\nnotes\/a\.md:2: second line/);
  await assert.rejects(run("grep", { pattern: "needle", path: ".pi" }), HelperPathRefusal);
  await assert.rejects(run("grep", { pattern: "needle", path: "link-out" }), HelperPathRefusal);

  const found = (await run("find", { pattern: "*" })).split("\n");
  assert.deepEqual(found.sort(), ["README.md", "notes/a.md", "notes/deep/b.txt"]);
  assert.equal(await run("find", { pattern: "**/*.txt" }), "notes/deep/b.txt");

  const listed = (await run("ls", {})).split("\n");
  assert.deepEqual(listed, ["link-file.txt@", "link-out@", "meta@", "notes/", "README.md"]);
  await assert.rejects(run("ls", { path: ".work-fold" }), HelperPathRefusal);

  assert.match(await run("read", { path: "notes/a.md" }), /alpha needle/);
  await assert.rejects(run("read", { path: "../Private/secret.txt" }), /outside this work-folder/);
  await assert.rejects(run("read", { path: "link-file.txt" }), /outside this work-folder/);
  await assert.rejects(run("read", { path: ".work-fold/work-folder.json" }), /reserved/);
  await assert.rejects(run("read", { path: "meta/work-folder.json" }), /reserved/);
});

test("helper globs match names without a slash and paths with one", () => {
  assert.ok(helperGlobMatcher("*.md")("notes/a.md"));
  assert.ok(!helperGlobMatcher("*.md")("notes/a.txt"));
  assert.ok(helperGlobMatcher("notes/**/*.txt")("notes/deep/b.txt"));
  assert.ok(helperGlobMatcher("**/*.txt")("b.txt"));
  assert.ok(helperGlobMatcher("*.{md,txt}")("x/y.txt"));
  assert.ok(!helperGlobMatcher("notes/*.txt")("notes/deep/b.txt"));
});

test("a Worker's helper runs in its own context inside the turn, returns the F29 result and is counted in the turn's usage", async (t) => {
  const { root } = await fixture(t);
  const setup = runtimeWith(root);
  const helperContexts: unknown[] = [];
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(helperToolName, { task: "Find which file mentions the needle and quote it.", paths: ["notes"] }, { id: "helper-1" })),
    (context) => {
      helperContexts.push(context);
      return fauxAssistantMessage(fauxToolCall("grep", { pattern: "needle" }, { id: "grep-1" }));
    },
    (context) => {
      helperContexts.push(context);
      assert.match(texts(context), /notes\/a\.md:1: alpha needle/, "the helper sees its own tool results");
      return fauxAssistantMessage(fauxToolCall(helperResultToolName, {
        summary: "notes/a.md line 1 says \"alpha needle\".", data: { file: "notes/a.md", line: 1 }, files: ["notes/a.md"], outcome: "succeeded",
      }, { id: "submit-1" }));
    },
    (context) => {
      const result = texts(context);
      assert.match(result, /\\"outcome\\": \\"succeeded\\"/, "the parent receives the envelope");
      assert.match(result, /\\"sha256\\"/, "named files carry their digest");
      return fauxAssistantMessage("The needle is in notes/a.md.");
    },
  ]);
  const client = new PiConversationClient("helper-chat", root, await setup.provider(), undefined, { helperTool: true });
  t.after(() => client.stop());
  const workFolderTurn = buildWorkFolderTurnContext({ workFolderId: "space-0123456789abcdef", taskId: "turn-helper-1", requestId: "req-helper-1", handleSalt: "salt" });
  assert.equal(await client.prompt("PARENT-ONLY-CONTEXT: where is the needle?", { workFolderTurn }), "The needle is in notes/a.md.");

  assert.equal(helperContexts.length, 2);
  const first = texts(helperContexts[0]);
  assert.ok(first.includes(JSON.stringify(helperSystemPrompt).slice(1, 60)), "the helper has its own system prompt");
  assert.ok(!first.includes("PARENT-ONLY-CONTEXT"), "the parent's transcript never reaches the helper");
  assert.match(first, /Find which file mentions the needle/);
  assert.match(first, /Start from these paths in the work-folder:\\n- notes/);
  const toolNames = [...first.matchAll(/"name":"([a-z_]+)"/g)].map((match) => match[1]);
  for (const name of ["read", "grep", "find", "ls", helperResultToolName]) assert.ok(toolNames.includes(name), name);
  for (const name of ["bash", "edit", "write", helperToolName, "codemode", "generate_image"]) assert.ok(!toolNames.includes(name), `no ${name}`);

  const runs = client.getTurnHelperRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.outcome, "succeeded");
  assert.equal(runs[0]!.taskId, "turn-helper-1");
  assert.equal(runs[0]!.modelCalls, 2);
  assert.deepEqual(runs[0]!.activity.map((entry) => entry.tool), ["grep", helperResultToolName]);
  assert.ok(runs[0]!.usage.input > 0);

  // Pi counts the tool result's usage, so the helper's spend is in the turn's.
  const entries = (await readFile((await client.getState()).sessionFile!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const helperResult = entries.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === helperToolName);
  assert.equal(helperResult.message.usage.input, runs[0]!.usage.input);
  const parentInput = entries.filter((entry) => entry.message?.role === "assistant").reduce((sum, entry) => sum + (entry.message.usage.input + (entry.message.usage.cacheRead ?? 0) + (entry.message.usage.cacheWrite ?? 0)), 0);
  assert.equal(client.getTurnUsage()!.inputTokens, parentInput + runs[0]!.usage.input + runs[0]!.usage.cacheRead + runs[0]!.usage.cacheWrite);
});

test("the helper refuses to start outside an accepted turn", async (t) => {
  const { root } = await fixture(t);
  let tracked = 0;
  const tool = createHelperTool({
    root, session: () => ({ model: null, agent: { streamFunction: () => { throw new Error("no model call"); } } }),
    turn: () => null, track: () => { tracked += 1; }, record: () => undefined,
  });
  await assert.rejects(tool.execute("helper-1", { task: "Read everything." } as never, undefined, undefined, undefined as never), /only inside an accepted turn/);
  assert.equal(tracked, 0);
});

test("a helper given a path outside the work-folder returns a failed result instead of reading", async (t) => {
  const { root } = await fixture(t);
  const setup = runtimeWith(root);
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(helperToolName, { task: "Read the secret.", paths: ["../Private/secret.txt"] }, { id: "helper-1" })),
    (context) => {
      assert.match(texts(context), /could not use \.\.\/Private\/secret\.txt/);
      assert.match(texts(context), /\\"outcome\\": \\"failed\\"/);
      return fauxAssistantMessage("I cannot read that.");
    },
  ]);
  const client = new PiConversationClient("helper-refusal", root, await setup.provider(), undefined, { helperTool: true });
  t.after(() => client.stop());
  assert.equal(await client.prompt("Read the secret."), "I cannot read that.");
  assert.equal(client.getTurnHelperRuns()[0]!.outcome, "failed");
  assert.equal(client.getTurnHelperRuns()[0]!.modelCalls, 0, "no model call was spent on a refused input");
});

test("Stop aborts a running helper and the turn does not settle until the helper has unwound", { timeout: 15_000 }, async (t) => {
  const { root } = await fixture(t);
  const setup = runtimeWith(root);
  let entered!: () => void;
  const helperEntered = new Promise<void>((resolve) => { entered = resolve; });
  let unwound = false;
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(helperToolName, { task: "Read everything slowly." }, { id: "helper-1" })),
    async (_context, options) => {
      entered();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      // A slow unwind: the turn must wait for it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      unwound = true;
      return fauxAssistantMessage("late");
    },
  ]);
  const client = new PiConversationClient("helper-stop", root, await setup.provider(), undefined, { helperTool: true });
  t.after(() => client.stop());
  const turn = client.prompt("Survey the folder.", { workFolderTurn: buildWorkFolderTurnContext({ workFolderId: "space-0123456789abcdef", taskId: "turn-stop-1", requestId: "req-stop-1", handleSalt: "salt" }) });
  const settled = turn.then(() => "resolved", (error: unknown) => (error as Error).name);
  await helperEntered;
  assert.equal(await client.abort(), true);
  assert.equal(await settled, "PiTurnCancelledError");
  assert.equal(unwound, true, "the prompt settled only after the helper unwound");
  const runs = client.getTurnHelperRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.outcome, "stopped");
  assert.equal(setup.faux.getPendingResponseCount(), 0);
});

test("Stop drains a helper before the host takes the final History checkpoint and releases the turn's reservation", { timeout: 30_000 }, async (t) => {
  const { sandbox, root } = await fixture(t);
  const previous = process.env.WORKFOLD_DEV_HELPER_TOOL;
  process.env.WORKFOLD_DEV_HELPER_TOOL = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFOLD_DEV_HELPER_TOOL;
    else process.env.WORKFOLD_DEV_HELPER_TOOL = previous;
  });
  const setup = runtimeWith(root);
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: await setup.provider(),
  });
  t.after(() => api.close());
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${api.origin}${path}`, {
      method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${method} ${path} ${response.status}`);
    return response.json() as Promise<T>;
  };
  const { workFolder } = await call<{ workFolder: { id: string } }>("POST", "/api/work-folders/local-folder", { workFolderRoot: root });
  const { conversation } = await call<{ conversation: { id: string } }>("POST", `/api/work-folders/${workFolder.id}/conversations`, { title: "Helper stop" });

  let entered!: () => void;
  const helperEntered = new Promise<void>((resolve) => { entered = resolve; });
  let stateWhileUnwinding = "";
  let unwoundAt = 0;
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(helperToolName, { task: "Survey everything." }, { id: "helper-1" })),
    async (_context, options) => {
      entered();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Still this turn's work: the reservation must be held, and the final
      // checkpoint not yet taken, while the helper unwinds.
      stateWhileUnwinding = (await api.actFacade.conversationStatus({ workFolder: workFolder.id, conversationId: conversation.id })).state;
      await writeFile(join(root, "unwound.txt"), "written while the helper unwound\n");
      unwoundAt = Date.now();
      return fauxAssistantMessage("late");
    },
  ]);

  await call("POST", `/api/work-folders/${workFolder.id}/conversations/${conversation.id}/messages`, { content: "Survey the folder." });
  await helperEntered;
  await call("POST", `/api/work-folders/${workFolder.id}/conversations/${conversation.id}/abort`, {});
  let idleAt = 0;
  for (let attempt = 0; attempt < 200 && !idleAt; attempt += 1) {
    const status = await api.actFacade.conversationStatus({ workFolder: workFolder.id, conversationId: conversation.id });
    if (status.state === "idle" && unwoundAt) idleAt = Date.now();
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(stateWhileUnwinding, "running", "the turn's reservation is held while the helper unwinds");
  assert.ok(idleAt >= unwoundAt, "the reservation is released only after the helper unwound");

  const versions = await api.actFacade.historyVersions({ workFolder: workFolder.id, path: "unwound.txt" });
  assert.ok(versions.versions.length >= 1, "the final History checkpoint was taken after the helper unwound");
  const { checkpoints } = await api.actFacade.historyList({ workFolder: workFolder.id });
  const finalCheckpoint = checkpoints.find((checkpoint) => checkpoint.checkpointId === versions.versions[0]!.checkpointId);
  assert.equal(finalCheckpoint?.reason, "post_turn");

  const turns = (await readFile(join(sandbox, "state", "turns", "turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const settledTurn = turns.filter((record) => record.conversationId === conversation.id).at(-1);
  assert.equal(settledTurn.status, "aborted");
  assert.equal(settledTurn.helpers?.[0]?.outcome, "stopped", "the stopped helper is recorded under its turn");
});
