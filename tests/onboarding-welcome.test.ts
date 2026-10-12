import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createElement } from "react";

import { defaultApplicationAppearance } from "../src/shared/application-appearance.js";
import type { AgentStatus } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const assets = registerHooks({
  load(url, context, next) {
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { OnboardingFlow } = await import("../web-local/src/components/onboarding/OnboardingFlow.js");
const { ConnectAi } = await import("../web-local/src/components/onboarding/ConnectAi.js");
assets.deregister();

const root = process.cwd();
const read = (path: string) => readFile(join(root, path), "utf8");

const provider = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, configured: false, apiKey: true, oauth: false, oauthAvailable: false, guidedSetup: false, modelCount: 3, ...extra,
});
const providers = [
  provider("anthropic", "Anthropic", { oauth: true, oauthLabel: "Anthropic (Claude Pro/Max)" }),
  provider("azure", "Azure OpenAI"),
  provider("google", "Google"),
  provider("openai", "OpenAI", { oauth: true, oauthLabel: "Sign in with ChatGPT", oauthAvailable: true }),
  provider("openai-codex", "OpenAI Codex (legacy)", { apiKey: false, oauth: true }),
  provider("openrouter", "OpenRouter"),
  provider("xai", "xAI"),
];
const connectedStatus: AgentStatus = { ready: true, configured: true, provider: "openrouter", model: "openai/gpt-6-luna", piVersion: null, error: null };

/** Stubs fetch with the providers list; each POST is recorded and answered by `reply`. */
function stubApi(t: TestContext, reply: (path: string, body: Record<string, unknown>) => unknown) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/agent/models")) return Response.json({ providers, models: [], status: { ...connectedStatus, configured: false, provider: null, model: null } });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    posts.push({ path, body });
    return Response.json(reply(path, body));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return posts;
}

const buttons = () => [...document.querySelectorAll("button")];
const button = (text: string | RegExp) => buttons().find((item) => typeof text === "string" ? item.textContent === text : text.test(item.textContent ?? ""));

test("first run says what work-fold is, connects AI, then picks the first folder", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const posts = stubApi(t, () => ({ status: connectedStatus, models: [{ provider: "openrouter", id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" }] }));
  const connected: AgentStatus[] = [];
  const chosen: string[] = [];
  await dom.render(createElement(OnboardingFlow, {
    agentConfigured: false,
    onAiConnected: (status: AgentStatus) => { connected.push(status); },
    onCreateWorkFolder: () => { chosen.push("create"); },
    onOpenFolder: () => { chosen.push("open"); },
  }));
  assert.equal(document.querySelector("h1")?.textContent, "Put your folders to work");
  await dom.act(() => button("Get started")!.click());
  await dom.waitFor(() => Boolean(button(/^OpenRouter/)));
  assert.equal(document.querySelector("h1")?.textContent, "Connect your AI");
  assert.match(document.body.textContent!, /Step 2 of 3/);
  assert.deepEqual(buttons().filter((item) => item.classList.contains("connect-ai-card")).map((item) => item.querySelector("strong")?.textContent), ["ChatGPT", "Claude", "OpenRouter", "Another provider"]);
  assert.match(button(/^ChatGPT/)!.textContent!, /Sign in with your ChatGPT account/, "sign-in where the desktop app can run it");
  assert.match(button(/^OpenRouter/)!.textContent!, /Paste your OpenRouter API key/, "a key where it cannot");

  await dom.act(() => button(/^OpenRouter/)!.click());
  const key = document.querySelector<HTMLInputElement>("#connect-ai-key")!;
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(key, "synthetic-openrouter-key");
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dom.act(() => key.form!.requestSubmit());
  await dom.waitFor(() => /Connected to OpenRouter/.test(document.body.textContent!));
  assert.deepEqual(posts, [{ path: "/api/agent/configure", body: { scope: "agent", provider: "openrouter", apiKey: "synthetic-openrouter-key" } }]);
  assert.match(document.body.textContent!, /Your Workers will use OpenAI: GPT-6 Luna\./);
  assert.deepEqual(connected, [connectedStatus]);

  await dom.act(() => button("Continue")!.click());
  assert.equal(document.querySelector("h1")?.textContent, "Pick a folder to start with");
  assert.match(document.body.textContent!, /Step 3 of 3/);
  await dom.act(() => button(/^Add existing folder/)!.click());
  await dom.act(() => button(/^Create new work-folder/)!.click());
  assert.deepEqual(chosen, ["open", "create"]);
});

test("first run skips the AI step when a provider is already connected, and lets a person skip it", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  stubApi(t, () => ({}));
  await dom.render(createElement(OnboardingFlow, { agentConfigured: true, onAiConnected: () => {}, onCreateWorkFolder: () => {}, onOpenFolder: () => {} }));
  await dom.act(() => button("Get started")!.click());
  assert.equal(document.querySelector("h1")?.textContent, "Pick a folder to start with");
  assert.match(document.body.textContent!, /Step 2 of 2/);
  assert.doesNotMatch(document.body.textContent!, /No AI connected yet/);

  await dom.render(createElement(OnboardingFlow, { key: "fresh", agentConfigured: false, onAiConnected: () => {}, onCreateWorkFolder: () => {}, onOpenFolder: () => {} }));
  await dom.act(() => button("Get started")!.click());
  await dom.waitFor(() => Boolean(button("Skip for now")));
  await dom.act(() => button("Skip for now")!.click());
  assert.equal(document.querySelector("h1")?.textContent, "Pick a folder to start with");
  assert.match(document.body.textContent!, /No AI connected yet\. Your Worker will offer to connect one when you need it\./);
  await dom.act(() => button("Back")!.click());
  assert.equal(document.querySelector("h1")?.textContent, "Connect your AI");
});

test("Connect your AI signs in where it can, searches the rest, and sends Azure to Settings", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const posts = stubApi(t, (_path, body) => ({ status: { ...connectedStatus, provider: body.provider, model: "gpt-6.1-sol" }, models: [{ provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] }));
  const results: string[] = [];
  let settingsOpened = 0;
  await dom.render(createElement(ConnectAi, {
    onConnected: (result: { providerName: string; modelName: string | null }) => { results.push(`${result.providerName}: ${result.modelName}`); },
    onOpenSettings: () => { settingsOpened += 1; },
  }));
  await dom.waitFor(() => Boolean(button(/^ChatGPT/)));
  await dom.act(() => button(/^ChatGPT/)!.click());
  await dom.waitFor(() => results.length === 1);
  assert.deepEqual(posts.at(-1), { path: "/api/agent/oauth", body: { scope: "agent", provider: "openai" } });
  assert.deepEqual(results, ["OpenAI: GPT-6.1 Sol"]);

  await dom.act(() => button(/^Another provider/)!.click());
  const listed = () => [...document.querySelectorAll(".connect-ai-others button")].map((item) => item.textContent);
  assert.deepEqual(listed(), ["Azure OpenAI", "Google", "xAI"], "featured providers and the legacy ChatGPT entry stay out of the list");
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "goo");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(listed(), ["Google"]);
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dom.act(() => button("Azure OpenAI")!.click());
  assert.match(document.body.textContent!, /Azure OpenAI needs a few more details/);
  await dom.act(() => button(/Set it up in Settings/)!.click());
  assert.equal(settingsOpened, 1);
  await dom.act(() => button("xAI")!.click());
  assert.equal(document.querySelector("label[for=connect-ai-key]")?.textContent, "Paste your xAI API key");
});

test("first run keeps the App's folder registration contract and the dark default", async () => {
  const app = await read("web-local/src/App.tsx");
  assert.equal(defaultApplicationAppearance.mode, "dark");
  assert.match(app, /useApplicationAppearance/);
  assert.match(app, /body:\s*\{ workFolderRoot: selected\.path, folderGrantId: selected\.folderGrantId \}/);
  assert.match(app, /await checksControl\?\.suspend\(\);[\s\S]*?\/api\/work-folders\/local-folder/);
  assert.match(app, /finally \{ void checksControl\?\.resume\(\); \}/);
  // Set up for me waits for an AI connection instead of sending a turn that cannot start.
  assert.match(app, /if \(!agent\.configured\) \{ requestConnectAi\(\(\) => void sendSetUp\(mode\)\); return; \}/);
});
