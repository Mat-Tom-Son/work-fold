import { logicalEventController } from "./support/local-events.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement, StrictMode, type ComponentProps } from "react";
import { AssistantSetupPane } from "../web-local/src/components/panes/AssistantSetupPane.js";
import type { AgentModel, AgentStatus, SpaceSummary } from "../web-local/src/types.js";
import { useModalDialog } from "../web-local/src/hooks/useModalDialog.js";
import { createDomHarness } from "./support/dom.js";

const status: AgentStatus = { configured: true, ready: true, provider: "openrouter", model: "model-a", error: null, piVersion: "fixture" };
const space = (id: string): SpaceSummary => ({ id, name: `Space ${id}`, spaceRoot: `/synthetic/${id}` } as SpaceSummary);
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
  const render = (selected: SpaceSummary | null, initialScope: "space" | "management" = "space", strict = false, extra: Partial<ComponentProps<typeof AssistantSetupPane>> = {}) => {
    const component = createElement(AssistantSetupPane, { space: selected, status, embedded: true, initialScope,
      onConfigured: (next) => callbacks.push(next), onAssistantChanged: (scope) => changes.push(scope), ...extra });
    return dom.render(strict ? createElement(StrictMode, null, component) : component);
  };
  const finish = async (request: Request, body: unknown, responseStatus = 200) => { await dom.act(async () => { request.finish(body, responseStatus); }); };
  const select = async (selector: string, value: string) => { await dom.act(() => {
    const field = dom.container.querySelector<HTMLSelectElement>(selector)!;
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }); };
  const type = async (selector: string, value: string) => { await dom.act(() => {
    const field = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const prototype = field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }); };
  const submit = async (section: string, duplicate = false) => { await dom.act(() => {
    const form = dom.container.querySelector<HTMLFormElement>(`[aria-labelledby="assistant-${section}-heading"] form`)!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    if (duplicate) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }); };
  const button = (text: string) => [...dom.container.querySelectorAll("button")].find((item) => item.textContent === text)!;
  const hint = async () => { await dom.act(async () => {
    for (const controller of eventStreams) controller.enqueue(new TextEncoder().encode('data: {"type":"assistant"}\n\n'));
  }); };
  return { dom, requests, render, finish, select, type, submit, button, callbacks, changes, hint };
}

test("obsolete scope reads and Strict Mode replay cannot overwrite the current target or request a missing Space", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"), "space", true);
  const spaceRead = ui.requests.at(-1)!;
  assert.match(spaceRead.path, /scope=space&spaceId=a/);
  await ui.render(null, "space", true);
  const foldRead = ui.requests.at(-1)!;
  assert.match(foldRead.path, /scope=management$/);
  assert.ok(spaceRead.init.signal?.aborted);
  await ui.finish(foldRead, modelResponse({ status: { ...status, model: "model-b" }, instructions: null }));
  await ui.finish(spaceRead, { error: "Space id is required." }, 400);
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-b");
  assert.equal(ui.dom.container.querySelector("textarea"), null);
  assert.doesNotMatch(ui.dom.container.textContent!, /Space id is required|Space not found/);
  assert.ok(ui.requests.every((request) => !request.path.endsWith("scope=space")));
  assert.equal(ui.dom.container.querySelectorAll('input[name="assistant-model-scope"]').length, 0);
  assert.match(ui.dom.container.textContent!, /work-fold agent/);
});

test("model writes submit once, remain bound to the original Space and cannot finish into a replacement form", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.select("#assistant-model", "model-b");
  await ui.submit("model", true);
  const write = ui.requests.at(-1)!;
  assert.equal(ui.requests.filter((item) => item.path === "/api/agent/configure").length, 1);
  assert.deepEqual(write.body, { scope: "space", spaceId: "a", provider: "openrouter", model: "model-b" });
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.disabled, true);
  await ui.render(space("b"));
  assert.equal(ui.requests.length, 2, "replacement read waits for the accepted write to settle");
  await ui.finish(write, { status: { ...status, model: "model-b" } });
  await ui.dom.waitFor(() => ui.requests.length === 3);
  assert.match(ui.requests[2]!.path, /spaceId=b/);
  await ui.finish(ui.requests[2]!, modelResponse({ instructions: "B instructions" }));
  assert.deepEqual(ui.callbacks, [], "old Space cannot replace the current app status");
  assert.deepEqual(ui.changes, []);
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-a");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "B instructions");
  assert.doesNotMatch(ui.dom.container.textContent!, /Model saved/);
});

test("refresh is provider-owned and preserves edits made while the same provider catalog loads", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.dom.act(() => { ui.button("Refresh").click(); ui.button("Refresh").click(); });
  const refresh = ui.requests.at(-1)!;
  assert.equal(ui.requests.filter((item) => item.path.endsWith("models/refresh")).length, 1);
  await ui.select('select[aria-label="Provider"]', "anthropic");
  await ui.type("#assistant-api-key", "synthetic-secret-for-anthropic");
  await ui.finish(refresh, { ...modelResponse(), refresh: { modelCount: 2 } });
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "anthropic");
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "claude");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#assistant-api-key")?.value, "synthetic-secret-for-anthropic");
  assert.doesNotMatch(ui.dom.container.textContent!, /models refreshed/);
  await ui.select('select[aria-label="Provider"]', "openrouter");
  await ui.dom.act(() => ui.button("Refresh").click());
  await ui.select("#assistant-model", "model-b");
  await ui.finish(ui.requests.at(-1)!, { ...modelResponse(), refresh: { modelCount: 2 } });
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-b");
  assert.equal(ui.button("Save model").disabled, false);
  assert.deepEqual(ui.changes, [], "catalog refresh does not save a model");
});

test("instructions keep newer edits through an in-flight save and errors stay with their own form", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.type("textarea", "First edit");
  await ui.submit("instructions", true);
  const write = ui.requests.at(-1)!;
  assert.equal(ui.requests.filter((item) => item.path.endsWith("/instructions")).length, 1);
  await ui.type("textarea", "Newer edit");
  await ui.finish(write, { instructions: "First edit" });
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Newer edit");
  assert.equal(ui.button("Save instructions").disabled, false);
  assert.doesNotMatch(ui.dom.container.querySelector('[aria-labelledby="assistant-instructions-heading"]')!.textContent!, /Instructions saved/);
  await ui.submit("instructions");
  await ui.finish(ui.requests.at(-1)!, { error: "An Assistant turn is still running." }, 409);
  const alert = ui.dom.container.querySelector('[role="alert"]')!;
  assert.ok(alert.closest('[aria-labelledby="assistant-instructions-heading"]'));
  assert.equal(ui.dom.container.querySelector('[aria-labelledby="assistant-model-heading"] [role="alert"]'), null);
  await ui.select("#assistant-model", "model-b");
  await ui.submit("model");
  await ui.finish(ui.requests.at(-1)!, { status: { ...status, model: "model-b" } });
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Newer edit");
});

test("saved credentials are readable status, with separate explicit connection and no secret carried across providers", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  assert.equal(ui.dom.container.querySelector('input[type="password"]'), null);
  assert.match(ui.dom.container.textContent!, /API key saved on this computer/);
  await ui.dom.act(() => ui.button("Remove API key").click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ models: models.map((item) => ({ ...item, authConfigured: false })), status: { ...status, configured: false } }));
  await ui.type("#assistant-api-key", "do-not-send-to-another-provider");
  await ui.select('select[aria-label="Provider"]', "anthropic");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#assistant-api-key")?.value, "");
  await ui.type("#assistant-api-key", "synthetic-new-provider-key");
  assert.equal(ui.button("Save model").disabled, true, "model action cannot silently submit a connection key");
  await ui.submit("connection", true);
  const write = ui.requests.at(-1)!;
  assert.deepEqual(write.body, { scope: "space", spaceId: "a", provider: "anthropic", model: "claude", apiKey: "synthetic-new-provider-key" });
  assert.equal(ui.requests.filter((item) => item.path === "/api/agent/configure").length, 1);
  await ui.finish(write, { status: { ...status, provider: "anthropic", model: "claude" } });
  assert.equal(ui.dom.container.querySelector('input[type="password"]'), null);
  assert.match(ui.dom.container.textContent!, /Connected and model saved/);
  assert.deepEqual([...ui.dom.container.querySelectorAll("h3")].map((item) => item.textContent), ["Worker instructions"]);
});


test("outside settings changes refresh clean forms without replacing unsaved drafts", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.hint();
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" } }));
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-b");
  assert.doesNotMatch(ui.dom.container.textContent!, /Loading Assistant settings/);
  await ui.type("textarea", "Local unsaved instructions");
  await ui.hint();
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" }, instructions: "Changed using CLI" }));
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Local unsaved instructions");
  assert.ok(ui.button("Reload saved settings"));
  await ui.dom.act(() => ui.button("Reload saved settings").click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" }, instructions: "Changed using CLI" }));
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Changed using CLI");
});


test("an outside read begun before a local save cannot replace its result or later instruction edits", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
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
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-a");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Even newer local instructions");
  assert.equal(ui.button("Save instructions").disabled, false);
  assert.doesNotMatch(ui.dom.container.textContent!, /Saved settings have changed/);
});


test("model focus is an opening request, yields to user navigation and is not repeated on a page revisit", async (t) => {
  const ui = await setup(t);
  const navigation = document.createElement("button");
  navigation.textContent = "Appearance";
  document.body.append(navigation);
  t.after(() => navigation.remove());
  navigation.focus();
  await ui.render(space("a"), "space", false, { focusModelOnOpen: true });
  await ui.finish(ui.requests[0]!, modelResponse());
  assert.equal(document.activeElement?.id, "assistant-model", "initial request focuses its model once the data is ready");
  await ui.render(space("a"), "space", false, { focusModelOnOpen: true, active: false });
  navigation.focus();
  await ui.render(space("a"), "space", false, { focusModelOnOpen: true, active: true });
  assert.equal(document.activeElement, navigation, "a persistent opening flag cannot steal focus on revisit");
  await ui.dom.render(null);
  await ui.render(space("a"), "space", false, { focusModelOnOpen: true });
  const radio = ui.dom.container.querySelector<HTMLInputElement>('input[value="space"]')!;
  radio.focus();
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(document.activeElement, radio, "moving to a scope control while loading cancels delayed focus");
  await ui.dom.render(null);
  navigation.focus();
  await ui.render(space("a"), "space", false, { focusModelOnOpen: true });
  const pending = ui.requests.at(-1)!;
  await ui.render(space("a"), "space", false, { focusModelOnOpen: true, active: false });
  await ui.finish(pending, modelResponse());
  assert.equal(document.activeElement, navigation, "a response must never focus a hidden Assistant page");
});

test("scope round trips preserve model and instruction drafts, omit credentials and prune a removed Space", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.select('select[aria-label="Provider"]', "anthropic");
  await ui.type("#assistant-api-key", "never-cache-this-secret");
  await ui.type("textarea", "A draft to keep");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="management"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ instructions: null }));
  await ui.select("#assistant-model", "model-b");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="space"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "anthropic");
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "A draft to keep");
  assert.equal(ui.dom.container.querySelector<HTMLInputElement>("#assistant-api-key")?.value, "");
  await ui.dom.act(() => ui.dom.container.querySelector<HTMLInputElement>('input[value="management"]')!.click());
  await ui.finish(ui.requests.at(-1)!, modelResponse({ instructions: null }));
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-b");
  await ui.render(null);
  await ui.render(space("a"));
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(ui.dom.container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Original instructions", "removing a Space drops its cached draft");
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value, "openrouter");
});

test("closing and reopening Settings waits for an accepted write before loading saved values", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  await ui.finish(ui.requests[0]!, modelResponse());
  await ui.select("#assistant-model", "model-b");
  await ui.submit("model");
  const accepted = ui.requests.at(-1)!;
  await ui.dom.render(null);
  await ui.render(space("a"));
  assert.equal(ui.requests.length, 2, "the new dialog still owns the previous accepted operation's completion");
  await ui.finish(accepted, { status: { ...status, model: "model-b" } });
  await ui.dom.waitFor(() => ui.requests.length === 3);
  await ui.finish(ui.requests.at(-1)!, modelResponse({ status: { ...status, model: "model-b" } }));
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-b");
  assert.equal(ui.button("Save model").disabled, true);
});

test("a control hint during initial loading invalidates that read instead of showing a stale default", async (t) => {
  const ui = await setup(t);
  await ui.render(space("a"));
  const obsolete = ui.requests[0]!;
  await ui.hint();
  const fresh = ui.requests.at(-1)!;
  assert.notEqual(fresh, obsolete);
  assert.equal(obsolete.init.signal?.aborted, true);
  await ui.finish(fresh, modelResponse({ status: { ...status, model: "model-b" } }));
  await ui.finish(obsolete, modelResponse());
  assert.equal(ui.dom.container.querySelector<HTMLSelectElement>("#assistant-model")?.value, "model-b");
});


test("delayed model focus accepts the parent modal's owned opening focus", async (t) => {
  const ui = await setup(t);
  function Dialog() {
    const ref = useModalDialog({ onClose: () => {} });
    return createElement("div", { ref, role: "dialog", tabIndex: -1 },
      createElement("button", { id: "modal-close" }, "Close"),
      createElement(AssistantSetupPane, { space: space("a"), status, focusModelOnOpen: true, onConfigured: () => {} }));
  }
  await ui.dom.render(createElement(StrictMode, null, createElement(Dialog)));
  assert.equal(document.activeElement?.id, "modal-close");
  await ui.finish(ui.requests.at(-1)!, modelResponse());
  assert.equal(document.activeElement?.id, "assistant-model");
});
