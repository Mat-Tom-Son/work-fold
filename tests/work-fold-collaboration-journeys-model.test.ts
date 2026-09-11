import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { restrictedAppTaskAuthorityDigest } from "../src/local/agent/restricted-app-tasks.js";
import { RestrictedAppService } from "../src/local/agent/restricted-app-service.js";
import {
  workFoldSpaceOperationsGuide,
  workFoldSpaceOperationsGuideHeading,
  workFoldSpaceOperationsGuideMaxBytes,
} from "../src/local/agent/space-operations-guide.js";
import type { WorkFoldCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { createWorkFoldCliActRequest, executeWorkFoldCliActRequest } from "../src/local/cli/index.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";

/**
 * The two acceptance journeys of docs/collaboration-contract.md that only a
 * real model turn can prove, driven through the installed act lane against a
 * scripted provider that records the exact bytes each turn sent:
 *
 * - **Compose Spaces and apps.** An app's assistant task runs an ordinary Pi
 *   turn that produces a deliverable, returns the one F29 result envelope for
 *   it, hands the deliverable to a second Space, and that Space's report
 *   comes back under the same root — with no fold turn anywhere in the
 *   composition.
 * - **Discover and build.** What a fresh Space Assistant actually receives:
 *   the operations guide in its system prompt beside the person's Space
 *   instructions, a hidden context naming this turn's own ids, the
 *   app-authoring tool, and none of the fold's conversation, the Space
 *   registry, or any other Space.
 *
 * The journeys that need no model (delegate and clarify, request help from a
 * Space) live in tests/work-fold-collaboration-journeys.test.ts.
 *
 * A turn is held by holding its provider request open, which is the only way
 * to act inside a genuinely running model turn; `/hold`-style extension
 * commands cannot be used here because a registered extension command skips
 * the turn-context message entirely (src/local/agent/pi-client.ts).
 */

const token = "m".repeat(64);

type ReceiptEntry = Omit<WorkFoldCliActReceiptV3, "v" | "at">;

type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arguments: unknown }
  | { kind: "hold" };

interface ScriptedProvider {
  /** Every provider request body, in order, exactly as the model received it. */
  bodies: string[];
  baseUrl: string;
  /** Resolves once at least `count` requests are being held open. */
  waitForHolds(count: number): Promise<void>;
  /** Finish every held request with one plain answer. */
  release(text: string): void;
  close(): Promise<void>;
}

interface ProviderBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string }; name?: string }>;
}

async function startScriptedProvider(script: (body: string, index: number) => ScriptedReply): Promise<ScriptedProvider> {
  const bodies: string[] = [];
  const holds: ServerResponse[] = [];
  const watchers: Array<{ count: number; resolve: () => void }> = [];
  const finish = (res: ServerResponse, reply: Exclude<ScriptedReply, { kind: "hold" }>, id: number): void => {
    const chunk = (delta: unknown, finishReason: string | null = null): void => {
      res.write(`data: ${JSON.stringify({
        id: `completion-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "journey-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };
    if (reply.kind === "tool") {
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call-${id}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: reply.text });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      const index = bodies.length;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const reply = script(body, index);
      if (reply.kind !== "hold") {
        finish(res, reply, index);
        return;
      }
      res.write(": waiting\n\n");
      holds.push(res);
      for (const watcher of watchers.splice(0).filter((entry) => {
        if (holds.length < entry.count) return true;
        entry.resolve();
        return false;
      })) watchers.push(watcher);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    waitForHolds: (count) => holds.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { watchers.push({ count, resolve }); }),
    release: (text) => {
      for (const [offset, res] of holds.splice(0).entries()) finish(res, { kind: "text", text }, 1_000 + offset);
    },
    close: async () => {
      for (const res of holds.splice(0)) res.end("data: [DONE]\n\n");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ModelJourney {
  sandbox: string;
  api: LocalApiHandle;
  provider: ScriptedProvider;
  records: ReceiptEntry[];
  prompts: Array<{ spaceId: string; conversationId: string; taskId: string }>;
  run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  ok<T>(argv: string[]): Promise<T>;
  lastOk(): ReceiptEntry;
  close(): Promise<void>;
}

async function startModelJourney(prefix: string, options: {
  script: (body: string, index: number) => ScriptedReply;
  assistantInstructions?: string;
  restrictedApps?: RestrictedAppService;
}): Promise<ModelJourney> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-journey-${prefix}-`));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const provider = await startScriptedProvider(options.script);
  await writeFile(join(agentDir, "extensions", "journey-provider.ts"), `export default function(pi) { pi.registerProvider("journey-provider", { api: "openai-completions", baseUrl: ${JSON.stringify(provider.baseUrl)}, apiKey: "synthetic", models: [{ id: "journey-model", name: "Journey Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] }); }\n`, "utf8");
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "journey-provider", defaultModel: "journey-model", defaultThinkingLevel: "off" });
  const prompts: Array<{ spaceId: string; conversationId: string; taskId: string }> = [];
  const records: ReceiptEntry[] = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    ...(options.restrictedApps ? { restrictedAppService: options.restrictedApps } : {}),
    piRuntimeProvider: {
      async resolveRuntime() {
        return {
          agentDir,
          settingsManager,
          ...(options.assistantInstructions ? { assistantInstructions: options.assistantInstructions } : {}),
        };
      },
    },
    beforeAgentPrompt: async (event) => {
      prompts.push({ spaceId: event.spaceId, conversationId: event.conversationId, taskId: event.taskId });
    },
  });
  const run = (argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveManagementLineageParent(taskId),
      receipts: {
        hasAccepted: async (requestId) => records.some((record) => record.requestId === requestId && record.outcome === "accepted"),
        append: async (record) => {
          records.push(structuredClone(record));
          return true;
        },
      },
    },
  );
  return {
    sandbox,
    api,
    provider,
    records,
    prompts,
    run,
    async ok<T>(argv: string[]): Promise<T> {
      const result = await run(argv);
      assert.equal(result.exitCode, 0, `${argv.join(" ")}\n${result.stderr}`);
      return (JSON.parse(result.stdout) as { data: T }).data;
    },
    lastOk: () => records.filter((record) => record.outcome === "ok").at(-1)!,
    close: async () => {
      provider.release("Done.");
      await api.close();
      await provider.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface ResultEnvelope {
  summary: string;
  data?: unknown;
  files?: Array<{ path: string; sha256: string; sizeBytes: number }>;
  outcome: "succeeded" | "partial" | "failed";
}

/** F29 and principle 7: wherever an envelope came from, it is checked the same way. */
function assertResultEnvelope(envelope: ResultEnvelope, expected: {
  summary: string;
  outcome: "succeeded" | "partial" | "failed";
  data?: unknown;
  files?: Array<{ path: string; bytes: string }>;
}): void {
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["data", "files", "outcome", "summary"].filter((key) => key in envelope).sort(),
    "an envelope carries summary, outcome, and the optional data and files — nothing undeclared",
  );
  assert.equal(envelope.summary, expected.summary);
  assert.equal(envelope.outcome, expected.outcome);
  if (expected.data === undefined) {
    assert.equal("data" in envelope, false, "no declared data means the key is absent, never null");
  } else {
    assert.deepEqual(envelope.data, expected.data);
  }
  const files = envelope.files ?? [];
  assert.equal(files.length, expected.files?.length ?? 0);
  for (const [index, file] of files.entries()) {
    const want = expected.files![index]!;
    assert.equal(file.path, want.path);
    assert.equal(file.path.startsWith("/"), false, "a deliverable path is Space-relative");
    assert.equal(file.sha256, createHash("sha256").update(want.bytes).digest("hex"), "the digest is the bytes on disk");
    assert.equal(file.sizeBytes, Buffer.byteLength(want.bytes, "utf8"));
  }
}

function parseBody(raw: string): ProviderBody {
  return JSON.parse(raw) as ProviderBody;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: string }).text ?? "").join("\n");
}

function messagesOf(raw: string, role: string): string[] {
  return parseBody(raw).messages.filter((message) => message.role === role).map((message) => textOf(message.content));
}

/** The host's hidden identity block, wherever the session put it among the turn's messages. */
const turnContextMarker = "This turn's work-fold identity (host-owned; use these exact ids):";

function turnContextOf(raw: string): string {
  const blocks = messagesOf(raw, "user").filter((text) => text.includes(turnContextMarker));
  assert.equal(blocks.length, 1, "exactly one hidden identity block per turn");
  return blocks[0]!;
}

test("journey: an app's assistant task produces a deliverable, returns the one result envelope, and composes with a second Space without a fold turn", { timeout: 60_000 }, async () => {
  const comparisonBytes = "# Comparison\nNorth: $42\nSouth: $50\n";
  const runtimeInvocations: Array<{ action: string; input: unknown }> = [];
  const sandboxRoot = await mkdtemp(join(tmpdir(), "work-fold-journey-compose-service-"));
  const restrictedApps = await RestrictedAppService.create({
    rootPath: join(sandboxRoot, "restricted-apps"),
    deferAutomationStart: true,
    runtimeHost: {
      async invoke(_app: unknown, action: string, input: unknown) {
        runtimeInvocations.push({ action, input: structuredClone(input) });
        return { count: 2 };
      },
      async runAutomation() { /* unused */ },
      async stop() { /* unused */ },
      async close() { /* unused */ },
    } as never,
  });
  const j = await startModelJourney("compose", {
    restrictedApps,
    // The app's own task writes the deliverable; every other turn is held
    // open so a verb can run inside it.
    script: (body) => (/App request:/.test(body) && !/"role":"tool"/.test(body)
      ? { kind: "tool", name: "write", arguments: { path: "comparison.md", content: comparisonBytes } }
      : { kind: "hold" }),
  });
  try {
    const quotes = (await j.api.actFacade.createSpace({ name: "Quotes" })).space;
    const reviews = (await j.api.actFacade.createSpace({ name: "Reviews" })).space;
    await writeAppPackage(join(quotes.spaceRoot, "apps", "quote-desk"));

    // 1. The app is installed and its declared surface is readable from the
    //    act lane without opening the package.
    const review = await restrictedApps.inspect({ spaceId: quotes.id, spaceRoot: quotes.spaceRoot, sourcePath: "apps/quote-desk" });
    const app = await restrictedApps.install({
      spaceId: quotes.id,
      spaceRoot: quotes.spaceRoot,
      sourcePath: "apps/quote-desk",
      expectedDigest: review.digest,
    });
    const listed = await j.ok<{ apps: Array<{ appId: string; tools: Array<{ name: string }>; assistantActions: Array<{ id: string }> }> }>([
      "apps", "list", "--space", quotes.id, "--json",
    ]);
    assert.deepEqual(listed.apps.map((entry) => entry.appId), ["quote-desk"]);
    assert.deepEqual(listed.apps[0]!.tools.map((tool) => tool.name), ["quote_count"]);
    assert.deepEqual(listed.apps[0]!.assistantActions.map((action) => action.id), ["compare"]);

    // 2. A declared tool runs on the first call, with a receipt naming it.
    const invoked = await j.ok<{ result: unknown; action: string }>([
      "apps", "invoke", "--space", quotes.id, "--app", "quote-desk", "--tool", "quote_count", "--input", '{"region":"north"}', "--json",
    ]);
    assert.deepEqual(invoked.result, { count: 2 });
    assert.deepEqual(runtimeInvocations, [{ action: "count", input: { region: "north" } }]);
    assert.match(j.lastOk().detail ?? "", /quote-desk/);
    assert.match(j.lastOk().detail ?? "", /quote_count/);

    // 3. The app asks its Space Assistant for work. It runs at once — there is
    //    no state in which it waits for someone to let it through.
    const scope = {
      spaceId: app.spaceId,
      appId: app.manifest.id,
      featureInstallationId: app.featureInstallationId,
      digest: app.digest,
      authorityDigest: restrictedAppTaskAuthorityDigest(app.authority),
    };
    const requestId = randomUUID();
    const started = await j.api.appAssistantTasks.request(scope, {
      actionId: "compare",
      input: { quote: "North $42" },
      requestId,
      requestedAt: new Date().toISOString(),
    });
    assert.equal(started.status, "running");
    assert.equal("approvedAt" in started, false, "there is no approval step to record");

    // 4. That turn really writes the deliverable, then holds; the task id it
    //    reports under is its own running turn's.
    await waitFor(() => j.prompts.some((prompt) => prompt.conversationId === `chat-app-${started.id}`), "the app's task to prompt");
    const appTaskId = j.prompts.find((prompt) => prompt.conversationId === `chat-app-${started.id}`)!.taskId;
    await j.provider.waitForHolds(1);
    assert.equal(await readFile(join(quotes.spaceRoot, "comparison.md"), "utf8"), comparisonBytes);
    const appRequest = j.api.requests.byTaskId(appTaskId)!;
    assert.equal(appRequest.kind, "app");
    assert.equal(appRequest.requestId, appRequest.rootId, "an app-requested task is its own root");

    // 5. It returns the one result envelope: a summary, declared data, and the
    //    file it produced with a digest this test recomputes from disk.
    const reported = await j.ok<{ result: ResultEnvelope; request: { id: string; rootId: string; kind: string } }>([
      "chat", "report", "--space", quotes.id, "--task", appTaskId,
      "--summary", "North is cheaper by $8.", "--data", '{"winner":"North","delta":8}',
      "--file", "comparison.md", "--outcome", "succeeded", "--json",
    ]);
    assertResultEnvelope(reported.result, {
      summary: "North is cheaper by $8.",
      outcome: "succeeded",
      data: { winner: "North", delta: 8 },
      files: [{ path: "comparison.md", bytes: comparisonBytes }],
    });
    assert.equal(reported.request.kind, "app");
    assert.equal(reported.request.id, appRequest.requestId);

    // 6. The deliverable moves to the second Space, and only the deliverable.
    const handed = await j.ok<{ taskId: string; conversationId: string; copied: string[]; request: { rootId: string; depth: number } }>([
      "chat", "handoff", "--space", quotes.id, "--task", appTaskId, "--to-space", reviews.id,
      "--message", "Check the comparison and say whether the figures hold.", "--file", "comparison.md", "--json",
    ]);
    assert.deepEqual(handed.copied, ["comparison.md"]);
    assert.equal(j.api.requests.byTaskId(handed.taskId)!.rootId, appRequest.rootId, "the second Space's Chat is a child of the app's request");
    // A Space-scoped verb never hands back the id above the caller: it comes
    // out as the opaque handle no verb accepts (F9 as amended, F26).
    assert.match(handed.request.rootId, /^parent-[0-9a-f]{16}$/);
    assert.equal(handed.request.depth, 1);
    await waitFor(() => j.prompts.some((prompt) => prompt.taskId === handed.taskId), "the destination turn to prompt");
    await j.provider.waitForHolds(2);
    const handoffBody = j.provider.bodies.find((body) => body.includes("Check the comparison"))!;
    assert.ok(handoffBody, "the destination turn received the handoff message");
    for (const secret of [`chat-app-${started.id}`, quotes.id, appRequest.requestId, appTaskId, "App request:"]) {
      assert.equal(handoffBody.includes(secret), false, `the destination turn must not see ${secret}`);
    }

    // 7. Its report comes back under the same root, and the two envelopes are
    //    one shape.
    const reviewBytes = "# Check\nThe figures hold.\n";
    await writeFile(join(reviews.spaceRoot, "check.md"), reviewBytes, "utf8");
    const back = await j.ok<{ result: ResultEnvelope; request: { rootId: string } }>([
      "chat", "report", "--space", reviews.id, "--task", handed.taskId,
      "--summary", "The figures hold.", "--file", "check.md", "--outcome", "succeeded", "--json",
    ]);
    assertResultEnvelope(back.result, {
      summary: "The figures hold.",
      outcome: "succeeded",
      files: [{ path: "check.md", bytes: reviewBytes }],
    });
    assert.match(back.request.rootId, /^parent-[0-9a-f]{16}$/);
    assert.equal(j.api.requests.byTaskId(handed.taskId)!.rootId, appRequest.rootId);
    assert.deepEqual(
      Object.keys(back.result).filter((key) => key !== "data").sort(),
      Object.keys(reported.result).filter((key) => key !== "data").sort(),
      "an app's envelope and a Space's envelope are the same shape",
    );

    // 8. Nothing in the composition needed the fold.
    const whole = await j.ok<{ request: { kind: string; resultRecords: Array<{ envelope: ResultEnvelope | null }>; childRequests: Array<{ spaceName: string; resultRecords: Array<{ envelope: ResultEnvelope | null }> }> } }>([
      "requests", "show", "--request", appRequest.requestId, "--json",
    ]);
    assert.equal(whole.request.resultRecords[0]!.envelope!.summary, "North is cheaper by $8.");
    assert.equal(whole.request.childRequests[0]!.spaceName, "Reviews");
    assert.equal(whole.request.childRequests[0]!.resultRecords[0]!.envelope!.summary, "The figures hold.");
    assert.equal(j.prompts.some((prompt) => prompt.spaceId === workFoldManagementScopeId), false, "no fold turn ran to transport anything");
    assert.equal(
      (await j.ok<{ requests: Array<{ kind: string }> }>(["requests", "list", "--json"])).requests.some((request) => request.kind === "management"),
      false,
    );

    // 9. The held turns finish honestly, and the app's task settles as the
    //    ordinary Pi turn it always was.
    j.provider.release("Saved comparison.md.");
    await waitFor(async () => (await j.api.appAssistantTasks.get(scope, requestId)).status === "succeeded", "the app task to settle");
    // What the app itself reads back is the same envelope vocabulary the act
    // lane returned: a summary, an F29 outcome, and deliverables whose digests
    // are the bytes on disk.
    const delivered = (await j.api.appAssistantTasks.get(scope, requestId)).result!;
    assert.ok(delivered.summary.length > 0, "the app is given a summary of its own task");
    assert.ok(["succeeded", "partial", "failed"].includes(delivered.outcome), delivered.outcome);
    for (const file of delivered.files ?? []) {
      assert.equal(file.path.startsWith("/"), false, "a deliverable path is Space-relative");
      assert.equal(
        file.sha256,
        createHash("sha256").update(await readFile(join(quotes.spaceRoot, file.path), "utf8")).digest("hex"),
      );
    }
    const journal = (await readFile(join(j.sandbox, "state", "turns", "turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { conversationId?: string; status?: string; fileChanges?: { files?: Array<{ path: string }> } });
    const settled = journal.filter((record) => record.conversationId === `chat-app-${started.id}` && record.status === "succeeded").at(-1)!;
    assert.deepEqual(settled.fileChanges?.files?.map((file) => file.path), ["comparison.md"], "the deliverable has durable evidence of its own");
  } finally {
    await j.close();
    await restrictedApps.close();
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

test("journey: a fresh Space turn receives the operations guide, its own ids, and nothing from the fold or the Space registry", { timeout: 60_000 }, async () => {
  const j = await startModelJourney("discover", {
    assistantInstructions: "Prefer short answers.",
    script: () => ({ kind: "text", text: "I can work on files in this Space." }),
  });
  try {
    const workshop = (await j.api.actFacade.createSpace({ name: "Workshop" })).space;
    // A second Space exists before the turn, so "the registry never enters a
    // Space turn" is a claim with something to leak.
    const elsewhere = (await j.api.actFacade.createSpace({ name: "Elsewhere" })).space;

    const sent = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--space", workshop.id, "--new", "--message", "What can you do here?", "--json",
    ]);
    await waitFor(() => j.provider.bodies.length > 0, "the Space turn to reach the model");
    const raw = j.provider.bodies[0]!;
    const requestId = j.api.requests.byTaskId(sent.taskId)!.requestId;

    // The guide rides the system prompt the way Space instructions do: both
    // blocks, in that order, sourced from the one exported constant.
    const system = messagesOf(raw, "system").join("\n");
    assert.ok(system.includes("## Space instructions\n\nPrefer short answers."), "the person's instructions are still there");
    assert.ok(system.includes(workFoldSpaceOperationsGuide()), "the guide is the exported constant, not a retyped copy");
    assert.ok(
      system.indexOf("## Space instructions") < system.indexOf(workFoldSpaceOperationsGuideHeading),
      "the guide follows the person's instructions",
    );
    assert.ok(
      Buffer.byteLength(workFoldSpaceOperationsGuide(), "utf8") <= workFoldSpaceOperationsGuideMaxBytes,
      "the guide stays compact",
    );
    for (const verb of ["chat report", "chat ask", "chat answer", "chat handoff", "chat wait"]) {
      assert.ok(system.includes(verb), `the guide names ${verb}`);
    }
    assert.match(system, /Read and change this Space's folder only/);
    assert.match(system, /Never write cross-Space context into this Chat: it travels with the folder\./);
    // Discover and build: the Assistant and Check bridges are reachable from
    // what it was told, without reading this repository.
    assert.match(system, /apps list --space <id> --json/);
    assert.match(system, /checks status --space <id> --json/);
    const tools = (parseBody(raw).tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    assert.ok(tools.includes("propose_space_app"), "the app-authoring path is offered as a tool, not documented elsewhere");

    // The hidden context names this turn and this request, and nothing above.
    const users = messagesOf(raw, "user");
    assert.ok(users.includes("What can you do here?"), "the person's own message went as itself");
    const context = turnContextOf(raw);
    assert.ok(context.includes(sent.taskId), "the turn's own task id");
    assert.ok(context.includes(requestId), "the durable request id");
    assert.ok(context.includes(workshop.id));
    assert.doesNotMatch(context, /Another request delegated this work/, "nothing delegated this turn");
    assert.doesNotMatch(context, /Your assignment/);

    // Nothing from above reached it, by name.
    for (const [label, marker] of [
      ["the Space registry snapshot", "Current work-fold profile snapshot"],
      ["another Space's id", elsewhere.id],
      ["another Space's name", "Elsewhere"],
      ["another Space's folder", elsewhere.spaceRoot],
      ["the management scope", workFoldManagementScopeId],
    ] as const) {
      assert.equal(raw.includes(marker), false, `a Space turn must not carry ${label}`);
    }
  } finally {
    await j.close();
  }
});

test("journey: a delegated Space turn sees an opaque handle and its assignment, never the fold's task id or conversation", { timeout: 60_000 }, async () => {
  const j = await startModelJourney("delegated", {
    // The fold's own turn is held open so the delegation happens inside it.
    script: (body) => (/work-fold profile snapshot/.test(body) ? { kind: "hold" } : { kind: "text", text: "Comparing." }),
  });
  try {
    const quotes = (await j.api.actFacade.createSpace({ name: "Quotes" })).space;
    const root = await j.ok<{ conversationId: string; taskId: string }>([
      "manage", "send", "--new", "--message", "Have Quotes compare the vendor quotes.", "--json",
    ]);
    await j.provider.waitForHolds(1);
    const foldBody = j.provider.bodies[0]!;
    assert.ok(foldBody.includes("Current work-fold profile snapshot"), "the fold's own turn is the one that sees the registry");

    const assignment = "Compare the North and South quotes and report the winner.";
    const child = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--space", quotes.id, "--new", "--message", assignment, "--parent-task", root.taskId, "--json",
    ]);
    await waitFor(() => j.provider.bodies.length > 1, "the delegated turn to reach the model");
    const raw = j.provider.bodies[1]!;
    const context = turnContextOf(raw);
    assert.ok(context.includes(child.taskId));
    assert.ok(context.includes(j.api.requests.byTaskId(child.taskId)!.requestId));
    assert.match(context, /Another request delegated this work\. Refer to it as parent-[0-9a-f]{16}/);
    assert.match(context, /Your assignment is the message in this turn\./);
    assert.ok(messagesOf(raw, "user").includes(assignment), "the assignment is the message it was sent");
    for (const [label, marker] of [
      ["the parent's real task id", root.taskId],
      ["the fold's conversation", root.conversationId],
      ["the fold's own prompt", "Have Quotes compare the vendor quotes"],
      ["the Space registry snapshot", "Current work-fold profile snapshot"],
    ] as const) {
      assert.equal(raw.includes(marker), false, `a delegated Space turn must not carry ${label}`);
    }
  } finally {
    await j.close();
  }
});

async function writeAppPackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "quote-desk",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "quote-desk",
    title: "Quote desk",
    description: "Keeps vendor quotes together.",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "receipt" },
    tools: [{
      name: "quote_count",
      description: "Count the quotes on file for one region.",
      action: "count",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", maxLength: 100 } },
        required: ["region"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    }],
    assistantActions: [{
      id: "compare",
      title: "Compare quotes",
      instructions: "Compare the quote and write comparison.md.",
      inputSchema: {
        type: "object",
        properties: { quote: { type: "string", maxLength: 1_000 } },
        required: ["quote"],
        additionalProperties: false,
      },
    }],
    automations: [],
    permissions: { network: [], files: [], notifications: [] },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(join(root, "worker.js"), "export async function handleAction() { return { count: 0 }; }\n", "utf8");
}
