import { logicalEventController } from "./support/local-events.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { createElement, StrictMode, type ComponentProps } from "react";
import type { AgentModel, AgentStatus, WorkFolderSummary } from "../web-local/src/types.js";
import { useModalDialog } from "../web-local/src/hooks/useModalDialog.js";
import { createDomHarness } from "./support/dom.js";

// Fluent's browser barrel needs an ESM projection in Node, as in the Settings
// modal tests. Browser verification checks the artwork; these tests exercise
// the actual key editor and its requests.
const icons = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:ai-models-key-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === "test:ai-models-key-icons" ? { format: "module", source: "export const Eye20Regular=()=>null; export const EyeOff20Regular=()=>null;", shortCircuit: true } : next(url, context); },
});
const { AiModelsPane } = await import("../web-local/src/components/panes/AiModelsPane.js");
icons.deregister();

const status: AgentStatus = { configured: true, ready: true, provider: "openrouter", model: "model-a", error: null, piVersion: "fixture" };
const workFolder = (id: string): WorkFolderSummary => ({ id, name: `work-folder ${id}`, workFolderRoot: `/synthetic/${id}` } as WorkFolderSummary);
const models: AgentModel[] = [
  { provider: "openrouter", providerName: "OpenRouter", id: "model-a", name: "Model A", authConfigured: true, authSource: "stored", authType: "api_key", oauthSupported: false },
  { provider: "openrouter", providerName: "OpenRouter", id: "model-b", name: "Model B", authConfigured: true, authSource: "stored", authType: "api_key", oauthSupported: false },
  { provider: "anthropic", providerName: "Anthropic", id: "claude", name: "Claude", authConfigured: false, oauthSupported: true },
];
function modelResponse(overrides: Record<string, unknown> = {}) {
  return { status, models, catalogs: [{ provider: "openrouter", refreshable: true, source: "built_in" }], instructions: "Original instructions", ...overrides };
}
interface Request {
  path: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
  finish: (body: unknown, status?: number) => void;
}
/** The model the closed dropdown currently shows as chosen. */
function selectedModel(dom: { container: HTMLElement }): string | undefined {
  return dom.container.querySelector('#ai-model[aria-haspopup="listbox"]')?.getAttribute("data-model-id") || undefined;
}

async function setup(t: TestContext) {
  const dom = await createDomHarness();
  const previous = globalThis.fetch;
  const requests: Request[] = [];
  const eventStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  globalThis.fetch = ((input, init = {}) => {
    if (String(input) === "/api/events") return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        eventStreams.add(logicalEventController(controller, init));
        init.signal?.addEventListener("abort", () => { eventStreams.clear(); controller.close(); }, { once: true });
      },
    })));
    return new Promise<Response>((resolve) => {
    requests.push({ path: String(input), init, body: init.body ? JSON.parse(String(init.body)) : null,
      finish: (body, responseStatus = 200) => resolve(new Response(JSON.stringify(body), { status: responseStatus, headers: { "content-type": "application/json" } })),
    });
  }); }) as typeof fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previous; });
  const callbacks: AgentStatus[] = [];
  const changes: string[] = [];
  const render = (selected: WorkFolderSummary | null, initialScope: "work-folder" | "agent" = "work-folder", strict = false, extra: Partial<ComponentProps<typeof AiModelsPane>> = {}) => {
    const component = createElement(AiModelsPane, { workFolder: selected, status, embedded: true, initialScope,
      onConfigured: (next) => callbacks.push(next), onModelChanged: (scope) => changes.push(scope), ...extra });
    return dom.render(strict ? createElement(StrictMode, null, component) : component);
  };
  const finish = async (request: Request, body: unknown, responseStatus = 200) => { await dom.act(async () => { request.finish(body, responseStatus); }); };
  const select = async (selector: string, value: string) => {
    const field = dom.container.querySelector<HTMLElement>(selector)!;
    if (field.getAttribute("aria-haspopup") === "listbox") {
      // The model dropdown (2026-09-27): open it, then pick the option that carries the model id.
      if (field.getAttribute("aria-expanded") !== "true") await dom.act(() => field.click());
      await dom.act(() => dom.container.querySelector<HTMLButtonElement>(`[role="option"][data-model-id="${value}"]`)!.click());
      return;
    }
    await dom.act(() => {
      (field as HTMLSelectElement).value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const type = async (selector: string, value: string) => { await dom.act(() => {
    const field = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const prototype = field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }); };
  const submit = async (section: string, duplicate = false) => { await dom.act(() => {
    const heading = ({ model: "ai-model", instructions: "worker-instructions", connection: "ai-models-connection" } as Record<string, string>)[section] ?? section;
    const form = dom.container.querySelector<HTMLFormElement>(`[aria-labelledby="${heading}-heading"] form`)!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    if (duplicate) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }); };
  const button = (text: string) => [...dom.container.querySelectorAll("button")].find((item) => item.textContent === text)!;
  const hint = async () => { await dom.act(async () => {
    for (const controller of eventStreams) controller.enqueue(new TextEncoder().encode('data: {"type":"models"}\n\n'));
  }); };
  return { dom, requests, render, finish, select, type, submit, button, callbacks, changes, hint };
}

test("obsolete scope reads and Strict Mode replay cannot overwrite the current target or request a missing work-folder", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"), "work-folder", true);
  const workFolderRead = ui.requests.at(-1)!;
  assert.match(workFolderRead.path, /scope=work-folder&workFolderId=a/);
  await ui.render(null, "work-folder", true);
  const workFoldAgentRead = ui.requests.at(-1)!;
  assert.match(workFoldAgentRead.path, /scope=agent$/);
  assert.ok(workFolderRead.init.signal?.aborted);
  await ui.finish(workFoldAgentRead, modelResponse({ status: { ...status, model: "model-b" }, instructions: null }));
  await ui.finish(workFolderRead, { error: "work-folder id is required." }, 400);
  assert.equal(selectedModel(ui.dom), "model-b");
  assert.equal(ui.dom.container.querySelector("textarea"), null);
  assert.doesNotMatch(ui.dom.container.textContent!, /work-folder id is required|work-folder not found/);
  assert.ok(ui.requests.every((request) => !request.path.endsWith("scope=work-folder")));
  assert.equal(ui.dom.container.querySelectorAll('input[name="ai-model-scope"]').length, 0);
  assert.match(ui.dom.container.textContent!, /work-fold agent/);
});

test("model writes submit once, remain bound to the original work-folder and cannot finish into a replacement form", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.select("#ai-model", "model-b");
  await ui.submit("model", true);
  const write = ui.requests.at(-1)!;
  assert.equal(ui.requests.filter((item) => item.path === "/api/agent/configure").length, 1);
  assert.deepEqual(write.body, { scope: "work-folder", workFolderId: "a", provider: "openrouter", model: "model-b" });
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.disabled, true);
  // The work-fold agent's scope is read alongside so switching scopes never reloads; count only this work-folder's reads.
  const workFolderReads = () => ui.requests.filter((item) => /scope=work-folder/.test(item.path));
  await ui.render(workFolder("b"));
  assert.equal(workFolderReads().length, 1, "replacement read waits for the accepted write to settle");
  await ui.finish(write, { status: { ...status, model: "model-b" } });
  await ui.dom.waitFor(() => workFolderReads().length === 2);
  assert.match(workFolderReads()[1]!.path, /workFolderId=b/);
  await ui.finish(workFolderReads()[1]!, modelResponse({ instructions: "B instructions" }));
  assert.deepEqual(ui.callbacks, [], "old work-folder cannot replace the current app status");
  assert.deepEqual(ui.changes, []);
  assert.equal(selectedModel(ui.dom), "model-a");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "B instructions");
  assert.doesNotMatch(ui.dom.container.textContent!, /Model saved/);
});

test("refresh is provider-owned and preserves edits made while the same provider catalog loads", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.dom.act(() => { ui.button("Refresh").click(); ui.button("Refresh").click(); });
  const refresh = ui.requests.at(-1)!;
  assert.equal(ui.requests.filter((item) => item.path.endsWith("models/refresh")).length, 1);
  await ui.select('select[aria-label="Provider"]', "anthropic");
  await ui.type("#ai-models-api-key", "synthetic-secret-for-anthropic");
  await ui.finish(refresh, { ...modelResponse(), refresh: { modelCount: 2 } });
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "anthropic");
  assert.equal(selectedModel(ui.dom), "model-a", "changing the connection provider leaves model selection alone");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "synthetic-secret-for-anthropic");
  assert.doesNotMatch(ui.dom.container.textContent!, /models refreshed/);
  await ui.select('select[aria-label="Provider"]', "openrouter");
  await ui.dom.act(() => ui.button("Refresh").click());
  await ui.select("#ai-model", "model-b");
  await ui.finish(ui.requests.at(-1)!, { ...modelResponse(), refresh: { modelCount: 2 } });
  assert.equal(selectedModel(ui.dom), "model-b");
  assert.equal(ui.button("Save Model").disabled, false);
  assert.deepEqual(ui.changes, [], "catalog refresh does not save a model");
});

test("instructions keep newer edits through an in-flight save and errors stay with their own form", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.type("textarea", "First edit");
  await ui.submit("instructions", true);
  const write = ui.requests.at(-1)!;
  assert.equal(ui.requests.filter((item) => item.path.endsWith("/instructions")).length, 1);
  await ui.type("textarea", "Newer edit");
  await ui.finish(write, { instructions: "First edit" });
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Newer edit");
  assert.equal(ui.button("Save Instructions").disabled, false);
  assert.doesNotMatch(ui.dom.container.querySelector('[aria-labelledby="worker-instructions-heading"]')!.textContent!, /Instructions saved/);
  await ui.submit("instructions");
  await ui.finish(ui.requests.at(-1)!, { error: "An turn is still running." }, 409);
  const alert = ui.dom.container.querySelector('[role="alert"]')!;
  assert.ok(alert.closest('[aria-labelledby="worker-instructions-heading"]'));
  assert.equal(ui.dom.container.querySelector('[aria-labelledby="ai-model-heading"] [role="alert"]'), null);
  await ui.select("#ai-model", "model-b");
  await ui.submit("model");
  await ui.finish(ui.requests.at(-1)!, { status: { ...status, model: "model-b" } });
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Newer edit");
});

test("saved credentials are readable status, with separate explicit connection and no secret carried across providers", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  assert.equal(ui.dom.container.querySelector('input[type="password"]'), null);
  assert.match(ui.dom.container.textContent!, /API key saved on this computer/);
  await ui.dom.act(() => ui.button("Remove API Key").click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ models: models.map((item) => ({ ...item, authConfigured: false })), status: { ...status, configured: false } }));
  await ui.type("#ai-models-api-key", "do-not-send-to-another-provider");
  await ui.select('select[aria-label="Provider"]', "anthropic");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "");
  await ui.type("#ai-models-api-key", "synthetic-new-provider-key");
  assert.equal(ui.button("Save Model").disabled, true, "model action cannot silently submit a connection key");
  await ui.submit("connection", true);
  const write = ui.requests.at(-1)!;
  assert.deepEqual(write.body, { scope: "work-folder", workFolderId: "a", provider: "anthropic", apiKey: "synthetic-new-provider-key" });
  assert.equal(ui.requests.filter((item) => item.path === "/api/agent/configure").length, 1);
  await ui.finish(write, { status: { ...status, provider: "anthropic", model: "claude" } });
  assert.equal(ui.dom.container.querySelector('input[type="password"]'), null);
  assert.match(ui.dom.container.textContent!, /Connection saved/);
  assert.deepEqual([...ui.dom.container.querySelectorAll("h3")].map((item) => item.textContent), ["Provider connections", "Worker Instructions"]);
});

test("Settings uses Pi's account labels and connects providers before they have chat models", async t => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  const providers = [
    { id: "openrouter", name: "OpenRouter", configured: true, authSource: "stored", authType: "api_key", apiKey: true, oauth: false, oauthAvailable: false, guidedSetup: true, modelCount: 2 },
    { id: "account-only", name: "Account provider", configured: false, apiKey: false, oauth: true, oauthLabel: "Sign in with Example", oauthAvailable: true, guidedSetup: false, modelCount: 0 },
    { id: "images-only", name: "Image provider", configured: false, apiKey: true, oauth: false, oauthAvailable: false, guidedSetup: true, modelCount: 3 },
  ];
  await ui.finish(ui.requests[0]!, modelResponse({ providers }));
  await ui.select('select[aria-label="Provider"]', "account-only");
  assert.equal(ui.dom.container.querySelector("#ai-models-api-key"), null);
  assert.equal(ui.button("Sign in with Example").disabled, false);
  await ui.dom.act(() => ui.button("Sign in with Example").click());
  const account = ui.requests.at(-1)!;
  assert.equal(account.path, "/api/agent/oauth");
  assert.deepEqual(account.body, { scope: "work-folder", workFolderId: "a", provider: "account-only" });
  await ui.finish(account, { status, models, providers: providers.map(item => item.id === "account-only" ? { ...item, configured: true, authSource: "stored", authType: "oauth" } : item) });
  assert.match(ui.dom.container.textContent!, /Connection saved/);
  assert.equal(ui.button("Reconnect account").disabled, false);
  await ui.select('select[aria-label="Provider"]', "images-only");
  await ui.type("#ai-models-api-key", "synthetic-image-key");
  await ui.submit("connection", true);
  const key = ui.requests.at(-1)!;
  assert.deepEqual(key.body, { scope: "work-folder", workFolderId: "a", provider: "images-only", apiKey: "synthetic-image-key" });
  await ui.finish(key, { status, providers: providers.map(item => item.id === "images-only" ? { ...item, configured: true, authSource: "stored", authType: "api_key" } : item) });
  assert.match(ui.dom.container.textContent!, /API key saved on this computer/);
  assert.equal(ui.button("Save Model").disabled, true);
  await ui.dom.act(() => ui.button("Guided setup").click());
  const guidedRequest = ui.requests.at(-1)!;
  assert.equal(guidedRequest.path, "/api/agent/login");
  assert.deepEqual(guidedRequest.body, { scope: "work-folder", workFolderId: "a", provider: "images-only", method: "api_key" });
  await ui.finish(guidedRequest, { status, models, providers });
});

test("Settings allows an API key for Copilot when Pi advertises it and reports desktop-only account setup", async t => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  const providers = [{ id: "github-copilot", name: "GitHub Copilot", configured: false, apiKey: true,
    oauth: true, oauthLabel: "Sign in with GitHub", oauthAvailable: false, guidedSetup: false, modelCount: 1 }];
  await ui.finish(ui.requests[0]!, modelResponse({ providers, models: [{ ...models[0]!, provider: "github-copilot", authConfigured: false }], status: { ...status, provider: "github-copilot" } }));
  assert.ok(ui.dom.container.querySelector("#ai-models-api-key"));
  assert.equal(ui.button("Sign in with GitHub"), undefined);
  await ui.type("#ai-models-api-key", "synthetic-copilot-key");
  await ui.submit("connection");
  await ui.finish(ui.requests.at(-1)!, { status });
});

test("all connected providers share one model picker and connection writes preserve its independent draft", async t => {
  const ui = await setup(t);
  const connected = [
    ...models,
    { ...models[0]!, provider: "openai", providerName: "OpenAI", id: "model-a", name: "Account model", authType: "oauth" as const },
  ];
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse({ models: connected }));
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLButtonElement>("#ai-model")!.click());
  assert.equal(ui.dom.container.querySelector('[role="option"][data-provider="anthropic"]'), null, "disconnected catalogs stay in connection setup");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLButtonElement>('[role="option"][data-provider="openai"]')!.click());
  assert.equal(ui.dom.container.querySelector("#ai-model")?.getAttribute("data-provider"), "openai");
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "openrouter", "choosing a model never retargets the credential editor");
  await ui.dom.act(() => ui.button("Change API Key").click());
  await ui.type("#ai-models-api-key", "synthetic-router-replacement");
  await ui.submit("connection");
  assert.equal(ui.requests.at(-1)!.body.model, undefined);
  await ui.finish(ui.requests.at(-1)!, modelResponse({ models: connected }));
  assert.equal(ui.dom.container.querySelector("#ai-model")?.getAttribute("data-provider"), "openai", "fresh connection catalog preserves the selected model draft");
  await ui.submit("model");
  assert.deepEqual(ui.requests.at(-1)!.body, { scope: "work-folder", workFolderId: "a", provider: "openai", model: "model-a" });
  const saved = { ...status, provider: "openai" };
  await ui.finish(ui.requests.at(-1)!, { status: saved });
  await ui.dom.render(null);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests.at(-1)!, modelResponse({ models: connected, status: saved }));
  assert.equal(ui.dom.container.querySelector("#ai-model")?.getAttribute("data-provider"), "openai");
  assert.equal(ui.dom.container.querySelectorAll('optgroup[label="Connected"] option').length, 2);
  await ui.select("#ai-model", "model-b");
  await ui.submit("model");
  assert.deepEqual(ui.requests.at(-1)!.body, { scope: "work-folder", workFolderId: "a", provider: "openrouter", model: "model-b" });
  await ui.finish(ui.requests.at(-1)!, { status: { ...status, model: "model-b" } });
  assert.equal(ui.dom.container.querySelector("#ai-models-api-key"), null, "switching between saved connections needs no repeated key entry");
});

test("changing a saved API key keeps the old connection until an explicit save, and Cancel discards the replacement", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.dom.act(() => ui.button("Change API Key").click());
  const key = () => ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")!;
  assert.equal(key().value, "", "saved keys are never read back into the editor");
  assert.equal(key().type, "password");
  await ui.type("#ai-models-api-key", "synthetic-replacement");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLButtonElement>('[aria-label="Show API key"]')!.click());
  assert.equal(key().type, "text");
  await ui.dom.act(() => ui.button("Cancel").click());
  assert.equal(ui.dom.container.querySelector("#ai-models-api-key"), null);
  assert.equal(ui.requests.filter((request) => request.init.method === "DELETE" || request.init.method === "POST").length, 0);
  await ui.dom.act(() => ui.button("Change API Key").click());
  assert.equal(key().value, "");
  assert.equal(key().type, "password");
  await ui.type("#ai-models-api-key", "synthetic-replacement");
  await ui.submit("connection", true);
  const write = ui.requests.at(-1)!;
  assert.deepEqual(write.body, { scope: "work-folder", workFolderId: "a", provider: "openrouter", apiKey: "synthetic-replacement" });
  assert.equal(ui.requests.filter((request) => request.path === "/api/agent/configure").length, 1);
  assert.equal(ui.requests.some((request) => request.init.method === "DELETE"), false);
  await ui.finish(write, { error: "Synthetic save failure" }, 409);
  assert.equal(key().value, "synthetic-replacement");
  assert.match(ui.dom.container.textContent!, /API key saved on this computer/);
  await ui.submit("connection");
  await ui.finish(ui.requests.at(-1)!, { status });
  assert.equal(ui.dom.container.querySelector("#ai-models-api-key"), null);
  assert.match(ui.dom.container.textContent!, /Connection saved/);
});

test("a model-only save preserves an unsaved key replacement and never submits it", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.dom.act(() => ui.button("Change API Key").click());
  await ui.type("#ai-models-api-key", "synthetic-unsaved-key");
  await ui.select("#ai-model", "model-b");
  await ui.submit("model");
  const write = ui.requests.at(-1)!;
  assert.deepEqual(write.body, { scope: "work-folder", workFolderId: "a", provider: "openrouter", model: "model-b" });
  await ui.finish(write, { status: { ...status, model: "model-b" } });
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "synthetic-unsaved-key");
  await ui.select('select[aria-label="Provider"]', "anthropic");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.type, "password");
});


test("Azure setup starts with user-entered deployments, accepts multiple names, and preserves failed edits", async (t) => {
  const ui = await setup(t);
  const azureStatus = { ...status, configured: false, provider: "azure", model: null };
  const azureModels = [{ ...models[0]!, provider: "azure", providerName: "Azure OpenAI", id: "catalog-model", name: "Catalog model", authConfigured: false }];
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse({ status: azureStatus, models: azureModels, azure: { baseUrl: "", deployments: [] } }));
  assert.equal(ui.dom.container.querySelector<HTMLButtonElement>("#ai-model")?.disabled, true, "connection setup needs no catalog model");
  assert.equal(ui.button("Save Azure settings").disabled, true);
  await ui.type("#ai-models-azure-endpoint", "https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview");
  await ui.type("#ai-models-api-key", "synthetic-key");
  await ui.type("#ai-models-azure-deployments", "team=wrong");
  await ui.submit("connection");
  assert.match(ui.dom.container.querySelector('[role="alert"]')!.textContent!, /Use deployment names/);
  assert.equal(ui.requests.filter((request) => request.path === "/api/agent/configure").length, 0);
  await ui.type("#ai-models-azure-deployments", "my-deployment, fast\nthird");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "synthetic-key");
  await ui.submit("connection", true);
  const write = ui.requests.at(-1)!;
  const azure = { baseUrl: "https://example.cognitiveservices.azure.com/openai/v1", deployments: ["my-deployment", "fast", "third"] };
  assert.deepEqual(write.body, { scope: "work-folder", workFolderId: "a", provider: "azure", apiKey: "synthetic-key", azure });
  assert.equal(ui.requests.filter((request) => request.path === "/api/agent/configure").length, 1);
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-azure-endpoint")?.disabled, true);
  const savedStatus = azureStatus;
  const savedModels = azure.deployments.map((id) => ({ ...azureModels[0]!, id, name: id, authConfigured: true, authSource: "stored", authType: "api_key" }));
  await ui.finish(write, { status: savedStatus, azure, models: savedModels });
  assert.match(ui.dom.container.textContent!, /Azure settings saved/);
  assert.equal(ui.button("Save Azure settings").disabled, true);
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "");
  await ui.select("#ai-model", "fast");
  await ui.submit("model");
  assert.deepEqual(ui.requests.at(-1)!.body, { scope: "work-folder", workFolderId: "a", provider: "azure", model: "fast" });
  await ui.finish(ui.requests.at(-1)!, { status: { ...azureStatus, configured: true, model: "fast" } });
  await ui.type("#ai-models-azure-endpoint", "https://new.openai.azure.com");
  await ui.hint();
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: savedStatus, models: savedModels, azure: { ...azure, baseUrl: "https://external.openai.azure.com" } }));
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-azure-endpoint")?.value, "https://new.openai.azure.com");
  assert.match(ui.dom.container.textContent!, /Saved settings have changed/);
  await ui.submit("connection");
  assert.equal(ui.requests.at(-1)!.body.apiKey, undefined, "edits keep the existing key");
  await ui.finish(ui.requests.at(-1)!, { error: "An turn is still running." }, 409);
  assert.match(ui.dom.container.querySelector('[role="alert"]')!.textContent!, /still running/);
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-azure-endpoint")?.value, "https://new.openai.azure.com");
  await ui.type("#ai-models-azure-deployments", "my-deployment");
  assert.equal(ui.dom.container.querySelector("#ai-models-azure-selected"), null);
  await ui.submit("connection");
  assert.equal(ui.requests.at(-1)!.body.model, undefined, "connection changes never choose a Worker model");
  await ui.finish(ui.requests.at(-1)!, { status: { ...savedStatus, model: "fast" }, azure: { ...azure, baseUrl: "https://new.openai.azure.com/openai/v1", deployments: ["my-deployment"] }, models: [savedModels[0]] });
});

test("outside settings changes refresh clean forms without replacing unsaved drafts", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.hint();
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" } }));
  assert.equal(selectedModel(ui.dom), "model-b");
  assert.doesNotMatch(ui.dom.container.textContent!, /Loading AI Models/);
  await ui.type("textarea", "Local unsaved instructions");
  await ui.hint();
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" }, instructions: "Changed using CLI" }));
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Local unsaved instructions");
  assert.ok(ui.button("Reload Saved Settings"));
  await ui.dom.act(() => ui.button("Reload Saved Settings").click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" }, instructions: "Changed using CLI" }));
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Changed using CLI");
});


test("an outside read begun before a local save cannot replace its result or later instruction edits", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.type("textarea", "Instructions being saved");
  await ui.hint();
  const outsideRead = ui.requests.at(-1)!;
  await ui.submit("instructions");
  const write = ui.requests.at(-1)!;
  await ui.hint();
  assert.equal(ui.requests.at(-1), write, "an accepted mutation owns its completion; its hint does not launch another read");
  await ui.type("textarea", "Even newer local instructions");
  await ui.finish(write, { instructions: "Instructions being saved" });
  await ui.finish(outsideRead, modelResponse({ status: { ...status, model: "model-b" }, instructions: "Older outside value" }));
  assert.equal(selectedModel(ui.dom), "model-a");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Even newer local instructions");
  assert.equal(ui.button("Save Instructions").disabled, false);
  assert.doesNotMatch(ui.dom.container.textContent!, /Saved settings have changed/);
});


test("model focus is an opening request, yields to user navigation and is not repeated on a page revisit", async (t) => {
  const ui = await setup(t);
  const navigation = document.createElement("button");
  navigation.textContent = "Appearance";
  document.body.append(navigation);
  t.after(() => navigation.remove());
  navigation.focus();
  await ui.render(workFolder("a"), "work-folder", false, { focusModelOnOpen: true });
  await ui.finish(ui.requests[0]!, modelResponse());
  assert.equal(document.activeElement?.id, "ai-model", "initial request focuses its model once the data is ready");
  await ui.render(workFolder("a"), "work-folder", false, { focusModelOnOpen: true, active: false });
  navigation.focus();
  await ui.render(workFolder("a"), "work-folder", false, { focusModelOnOpen: true, active: true });
  assert.equal(document.activeElement, navigation, "a persistent opening flag cannot steal focus on revisit");
  await ui.dom.render(null);
  await ui.render(workFolder("a"), "work-folder", false, { focusModelOnOpen: true });
  const radio = ui.dom.container.querySelector<HTMLInputElement>('input[value="work-folder"]')!;
  radio.focus();
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(document.activeElement, radio, "moving to a scope control while loading cancels delayed focus");
  await ui.dom.render(null);
  navigation.focus();
  await ui.render(workFolder("a"), "work-folder", false, { focusModelOnOpen: true });
  const pending = ui.requests.at(-1)!;
  await ui.render(workFolder("a"), "work-folder", false, { focusModelOnOpen: true, active: false });
  await ui.finish(pending, modelResponse());
  assert.equal(document.activeElement, navigation, "a response must never focus a hidden agent page");
});

test("scope round trips preserve model and instruction drafts, omit credentials and prune a removed work-folder", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.select('select[aria-label="Provider"]', "anthropic");
  await ui.type("#ai-models-api-key", "never-cache-this-secret");
  await ui.type("textarea", "A draft to keep");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="agent"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ instructions: null }));
  await ui.select("#ai-model", "model-b");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="work-folder"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "anthropic");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "A draft to keep");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#ai-models-api-key")?.value, "");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="agent"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ instructions: null }));
  assert.equal(selectedModel(ui.dom), "model-b");
  await ui.render(null);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Original instructions", "removing a work-folder drops its cached draft");
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "openrouter");
});

test("closing and reopening Settings waits for an accepted write before loading saved values", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.select("#ai-model", "model-b");
  await ui.submit("model");
  const accepted = ui.requests.at(-1)!;
  await ui.dom.render(null);
  await ui.render(workFolder("a"));
  // The work-fold agent's scope is read ahead once a form has loaded; only this work-folder's reads count here.
  const own = () => ui.requests.filter((item) => !/scope=agent/.test(item.path));
  assert.equal(own().length, 2, "the new dialog still owns the previous accepted operation's completion");
  await ui.finish(accepted, { status: { ...status, model: "model-b" } });
  await ui.dom.waitFor(() => own().length === 3);
  await ui.finish(own().at(-1)!, modelResponse({ status: { ...status, model: "model-b" } }));
  assert.equal(selectedModel(ui.dom), "model-b");
  assert.equal(ui.button("Save Model").disabled, true);
});

test("a control hint during initial loading invalidates that read instead of showing a stale default", async (t) => {
  const ui = await setup(t);
  await ui.render(workFolder("a"));
  const obsolete = ui.requests[0]!;
  await ui.hint();
  const fresh = ui.requests.at(-1)!;
  assert.notEqual(fresh, obsolete);
  assert.equal(obsolete.init.signal?.aborted, true);
  await ui.finish(fresh, modelResponse({ status: { ...status, model: "model-b" } }));
  await ui.finish(obsolete, modelResponse());
  assert.equal(selectedModel(ui.dom), "model-b");
});


test("delayed model focus accepts the parent modal's owned opening focus", async (t) => {
  const ui = await setup(t);
  function Dialog() {
    const ref = useModalDialog({ onClose: () => {} });
    return createElement("div", { ref, role: "dialog", tabIndex: -1 },
      createElement("button", { id: "modal-close" }, "Close"),
      createElement(AiModelsPane, { workFolder: workFolder("a"), status, focusModelOnOpen: true, onConfigured: () => {} }));
  }
  await ui.dom.render(createElement(StrictMode, null, createElement(Dialog)));
  assert.equal(document.activeElement?.id, "modal-close");
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(document.activeElement?.id, "ai-model");
});

async function returnToCachedWorkFolder(ui: Awaited<ReturnType<typeof setup>>): Promise<Request> {
  await ui.render(workFolder("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  const prefetched = ui.requests.at(-1)!;
  assert.match(prefetched.path, /scope=agent$/);
  await ui.finish(prefetched, modelResponse({ instructions: null }));
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="agent"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ instructions: null }));
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="work-folder"]')!.click());
  assert.equal(selectedModel(ui.dom), "model-a", "the cached form remains usable while its quiet read is pending");
  assert.doesNotMatch(ui.dom.container.textContent!, /Loading AI Models/);
  const quietRead = ui.requests.at(-1)!;
  assert.match(quietRead.path, /scope=work-folder&workFolderId=a/);
  return quietRead;
}

test("a cached scope's quiet read cannot replace a model saved after that read began", async (t) => {
  const ui = await setup(t);
  const quietRead = await returnToCachedWorkFolder(ui);
  await ui.select("#ai-model", "model-b");
  await ui.submit("model");
  await ui.finish(ui.requests.at(-1)!, { status: { ...status, model: "model-b" } });
  await ui.finish(quietRead, modelResponse());
  assert.equal(selectedModel(ui.dom), "model-b");
  assert.equal(ui.button("Save Model").disabled, true);
  assert.match(ui.dom.container.textContent!, /Model saved/);

  // A later scope revisit must also use the accepted save, not re-cache the
  // stale quiet response as the saved model.
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="agent"]')!.click());
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="work-folder"]')!.click());
  assert.equal(selectedModel(ui.dom), "model-b");
});

test("a cached scope's obsolete load error cannot hide successfully saved instructions", async (t) => {
  const ui = await setup(t);
  const quietRead = await returnToCachedWorkFolder(ui);
  await ui.type("textarea", "Saved after the quiet read started");
  await ui.submit("instructions");
  await ui.finish(ui.requests.at(-1)!, { instructions: "Saved after the quiet read started" });
  await ui.finish(quietRead, { error: "An obsolete read failed" }, 500);
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Saved after the quiet read started");
  assert.equal(ui.button("Save Instructions").disabled, true);
  assert.match(ui.dom.container.textContent!, /Instructions saved/);
  assert.doesNotMatch(ui.dom.container.textContent!, /An obsolete read failed/);
});

test("a newer control-event refresh supersedes a cached scope's older quiet read", async (t) => {
  const ui = await setup(t);
  const quietRead = await returnToCachedWorkFolder(ui);
  await ui.hint();
  const outsideRead = ui.requests.at(-1)!;
  assert.notEqual(outsideRead, quietRead);
  await ui.finish(outsideRead, modelResponse({ status: { ...status, model: "model-b" }, instructions: "Updated externally" }));
  await ui.finish(quietRead, modelResponse());
  assert.equal(selectedModel(ui.dom), "model-b");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Updated externally");
});
