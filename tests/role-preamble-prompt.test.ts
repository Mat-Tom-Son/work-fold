import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText, type Message, type SystemMessage } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { piDefaultPreamble, workFoldRolePreamble, workFoldRolePreambleExtension } from "../src/local/agent/role-preamble.js";

/**
 * work-fold is for general computer work, so a Worker's and the work-fold
 * agent's requests open with their own role instead of Pi's coding-assistant
 * sentence. Only that sentence changes: the tool list, the tool rules, and the
 * docs section are still Pi's, and the transcript still records Pi's sections.
 * The prompt is read from what a real turn sends to a fixture provider.
 */
test("each request opens with the session's role and keeps Pi's tool list, rules, and docs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-role-preamble-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "fixture-role", models: [{ id: "chat" }] });
  const requests: Message[][] = [];
  const runtime = await ModelRuntime.create({ credentials: FileCredentialStore.inMemory(), modelsPath: null });
  runtime.registerNativeProvider({ ...faux.provider, streamSimple(model, context, options) {
    requests.push(structuredClone(context.messages));
    return faux.provider.streamSimple(model, context, options);
  } });

  for (const role of ["worker", "work-fold-agent"] as const) {
    const cwd = join(root, role);
    await mkdir(cwd, { recursive: true });
    const client = new PiConversationClient(role, cwd, { resolveRuntime: async () => ({
      agentDir: join(root, "pi"), modelRuntime: runtime, preferredModel: { provider: "fixture-role", id: "chat" },
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    }) }, undefined, { role });
    t.after(() => client.stop());
    faux.setResponses([fauxAssistantMessage("Done.")]);
    assert.equal(await client.prompt("Hello."), "Done.");

    const sent = requests.at(-1)!;
    const prompt = getSystemMessageText(sent[0] as SystemMessage);
    assert.ok(prompt.startsWith(`${workFoldRolePreamble(role)}\n\n<tools>\n`), `${role} request opens with its role`);
    assert.doesNotMatch(prompt, /expert coding assistant|coding agent harness\. You help users/);
    assert.match(prompt, /<tools>\n- read: [^\n]+\n- bash: /);
    assert.match(prompt, /<rules>\n- [^\n]+\n[\s\S]*- Show file paths clearly when working with files\n<\/rules>/);
    assert.match(prompt, /<docs>\nPi documentation \(read only when the user asks about pi itself/);
    assert.match(prompt, new RegExp(`<cwd>\\n${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n</cwd>`));

    // The hidden turn context reaches the same request with the host's clock.
    assert.match(JSON.stringify(sent.slice(1)), /Host environment at the start of this turn \(host-owned\): local time /);

    // The swap is request-local: the transcript keeps Pi's own sections.
    const entries = (await readFile((await client.getState()).sessionFile!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const recorded = entries.find((entry) => entry.type === "message" && entry.message?.role === "system");
    assert.equal(recorded.message.sections.preamble, piDefaultPreamble);
  }
  assert.notEqual(workFoldRolePreamble("worker"), workFoldRolePreamble("work-fold-agent"));
});

test("the role hook replaces only Pi's default preamble and leaves a person's own SYSTEM.md alone", () => {
  const handlers = new Map<string, (event: { type: string; messages: unknown[] }) => { messages: SystemMessage[] } | undefined>();
  workFoldRolePreambleExtension("worker")({ on: (name: string, handler: never) => handlers.set(name, handler) } as never);
  const handler = handlers.get("context_with_system")!;

  const sections = { preamble: piDefaultPreamble, tools: "<tools>\n- read: Read files\n</tools>", cwd: "<cwd>\n/folder\n</cwd>" };
  const result = handler({ type: "context_with_system", messages: [{ role: "system", content: "", sections, timestamp: 0 }] })!;
  assert.deepEqual(Object.keys(result.messages[0]!.sections!), ["preamble", "tools", "cwd"], "the preamble still leads");
  assert.equal(result.messages[0]!.sections!.preamble, workFoldRolePreamble("worker"));
  assert.equal(result.messages[0]!.sections!.tools, sections.tools);
  assert.equal(sections.preamble, piDefaultPreamble, "the transcript's own message is not mutated");

  const own = { role: "system", content: "", sections: { preamble: "You are my research partner.", cwd: "<cwd>\n/folder\n</cwd>" }, timestamp: 0 };
  assert.equal(handler({ type: "context_with_system", messages: [own] }), undefined);
});
