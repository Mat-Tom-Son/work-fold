import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { validateToolArguments } from "@earendil-works/pi-ai";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FileCredentialStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { withInputContract } from "../resources/included-tools/input-contracts.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const engines = await jiti.import<any>(new URL("../resources/included-tools/documents/engines.mjs", import.meta.url).pathname);
function declarations(factory: (api: any) => void) {
  const tools = new Map<string, any>();
  const api = new Proxy({ registerTool: (tool: any) => tools.set(tool.name, tool), events: { emit() {} } }, {
    get(target, key) { return Reflect.get(target, key) ?? (() => {}); },
  });
  factory(api);
  return tools;
}
const documentTools = declarations(api => engines.registerDocumentEngineTools(api, {}));
function validate(tool: any, args: Record<string, unknown>) {
  const nested = tool.parameters.properties.input;
  const result = validateToolArguments(tool, { name: tool.name, id: "input-fixture", type: "toolCall", arguments: nested ? { input: args } : args });
  return nested ? result.input : result;
}

test("native validation enforces each document operation before engine execution", () => {
  const tool = documentTools.get("document_engine");
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.anyOf, undefined, "OpenAI rejects function-root alternatives");
  assert.ok(tool.parameters.properties.input.anyOf.every((branch: any) => branch.type === "object"));
  assert.throws(() => validateToolArguments(tool, { name: tool.name, id: "flat", type: "toolCall", arguments: { operation: "status" } }), /input/);
  assert.deepEqual(validate(tool, { operation: "status" }), { operation: "status" });
  for (const operation of ["render", "recalculate", "ocr"]) {
    assert.throws(() => validate(tool, { operation, output: "out.txt" }), /source/);
    assert.throws(() => validate(tool, { operation, source: "input.png" }), /output/);
    assert.throws(() => validate(tool, { operation, source: "", output: "out.txt" }), /Validation failed/);
    assert.equal(validate(tool, { operation, source: "input.png", output: "out.txt" }).source, "input.png");
  }
  assert.match(tool.description, /"source":"\.worker\/task\/page.png"/);
});

test("Chrome element, pointer, drag and upload requirements are declared without removing valid defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-tool-contracts-"));
  const agentDir = join(root, "pi"), cwd = join(root, "folder");
  await mkdir(agentDir); await mkdir(cwd);
  const client = new PiConversationClient("contract-audit", cwd, { resolveRuntime: async () => ({ agentDir, credentials: FileCredentialStore.inMemory(), settingsManager: SettingsManager.inMemory(), projectTrust: { override: true }, includedTools: { rootPath: resolve("resources/included-tools"), stateRoot: join(root, "state"), helperAppPath: join(root, "Missing Computer.app") } }) });
  t.after(async () => { await client.stop(); await rm(root, { recursive: true, force: true }); });
  await client.getCatalog();
  const session = (client as any).session;
  const chromeTools = new Map<string, any>(session.agent.state.tools.map((tool: any) => [tool.name, tool]));
  for (const name of ["chrome_inspect", "chrome_click", "chrome_hover", "chrome_tap", "chrome_drag", "chrome_upload_file"]) {
    const tool = chromeTools.get(name);
    assert.ok(tool, name);
    assert.throws(() => validate(tool, name === "chrome_upload_file" ? { paths: ["file.pdf"] } : {}), /Validation failed/, name);
  }
  for (const name of ["chrome_click", "chrome_hover", "chrome_tap"]) {
    const tool = chromeTools.get(name);
    assert.equal(validate(tool, { uid: "observed-ref" }).uid, "observed-ref");
    assert.equal(validate(tool, { selector: "#target" }).selector, "#target");
    assert.deepEqual(validate(tool, { x: 0, y: 0 }), { x: 0, y: 0 });
    assert.throws(() => validate(tool, { x: 10 }), /Validation failed/);
    assert.throws(() => validate(tool, { uid: "" }), /Validation failed/);
  }
  for (const from of [{ fromUid: "from" }, { fromSelector: "#from" }, { fromX: 0, fromY: 0 }]) {
    for (const to of [{ toUid: "to" }, { toSelector: "#to" }, { toX: 0, toY: 0 }]) validate(chromeTools.get("chrome_drag"), { ...from, ...to });
    assert.throws(() => validate(chromeTools.get("chrome_drag"), from), /Validation failed/);
  }
  validate(chromeTools.get("chrome_upload_file"), { selector: "input[type=file]", paths: ["file.pdf"] });
  // Native defaults remain useful: blank new tab, viewport scrolling, focused
  // input typing/filling (including clearing), and observation without a target.
  for (const [name, args] of [["chrome_tab", { action: "new" }], ["chrome_scroll", {}], ["chrome_snapshot", {}], ["chrome_type", { text: "" }], ["chrome_fill", { text: "" }]] as const) validate(chromeTools.get(name), args);
});

test("input contracts forward exact inputs and native lifecycle arguments without repairs", () => {
  const calls: unknown[][] = [];
  const execute = (...args: unknown[]) => { calls.push(args); return "same execution"; };
  const tool = { name: "generic", description: "Generic operation", parameters: { type: "object", properties: { target: { type: "string" } } }, execute };
  const decorated = withInputContract(tool, { variants: [{ required: ["target"] }], examples: [{ target: "observed-id" }] });
  const input = { target: "observed-id" }, signal = new AbortController().signal, update = () => {}, context = { cwd: "/fixture" };
  assert.equal(decorated.execute("call-id", { input }, signal, update, context), "same execution");
  assert.deepEqual(calls, [["call-id", input, signal, update, context]]);
  assert.equal(calls[0]![1], input, "the declared input is forwarded unchanged");
  assert.deepEqual(tool.parameters, { type: "object", properties: { target: { type: "string" } } });
  assert.throws(() => withInputContract(tool, { variants: [{ required: ["unknown"] }], examples: [] }), /Unknown input field/);
});
