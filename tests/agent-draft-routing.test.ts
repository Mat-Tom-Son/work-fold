import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";

test("a draft goes to this window's agent panel when it answers, otherwise to the menu-bar popover", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const { openWorkFoldAgentDraft, workFoldAgentDraftEvent } = await import("../web-local/src/lib/agent-draft.js");
  const popover: string[] = [];
  Object.assign(window, { workFoldDesktop: { agent: { openWorkFoldAgentDraft: async (text: string) => { popover.push(text); return true; } } } });

  await openWorkFoldAgentDraft("Set up a Check");
  assert.deepEqual(popover, ["Set up a Check"], "without a panel the popover takes it");

  const panel: string[] = [];
  const take = (event: Event) => { event.preventDefault(); panel.push((event as CustomEvent<{ text: string }>).detail.text); };
  window.addEventListener(workFoldAgentDraftEvent, take);
  await openWorkFoldAgentDraft("Review this automation");
  assert.deepEqual(panel, ["Review this automation"]);
  assert.deepEqual(popover, ["Set up a Check"], "the popover is not opened when the panel answered");
});

test("Checks and Automations hand their drafts to the shared router, and the panel opens to take them", async () => {
  const read = (path: string) => readFile(resolve(import.meta.dirname, "..", path), "utf8");
  const [checks, automations, app] = await Promise.all([read("web-local/src/components/panes/ChecksPane.tsx"), read("web-local/src/components/modals/AutomationsPane.tsx"), read("web-local/src/App.tsx")]);
  assert.match(checks, /await openWorkFoldAgentDraft\(draft\);/);
  assert.match(automations, /await openWorkFoldAgentDraft\(draft\);/);
  assert.match(app, /window\.addEventListener\(workFoldAgentDraftEvent, takeDraft\);/);
  assert.match(app, /updateAgentPanel\(\(current\) => \(\{ \.\.\.current, open: true \}\)\);/);
  assert.match(app, /if \(event\.defaultPrevented\) setSettingsOpen\(false\);/, "Settings closes so the panel is visible");
});
