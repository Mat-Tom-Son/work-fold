import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";

import { createDomHarness } from "./support/dom.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:connect-ai-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:connect-ai-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { ChatMessageRow } = await import("../web-local/src/components/chat/messages.js");
const { onConnectAiRequested, requestConnectAi } = await import("../web-local/src/lib/connect-ai.js");
assets.deregister();

test("a turn that stopped for want of a model offers Connect AI instead of repeating itself", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const requests: Array<(() => void) | undefined> = [];
  const stopListening = onConnectAiRequested((then) => { requests.push(then); });
  await dom.render(createElement(ChatMessageRow, {
    message: {
      id: "reply", role: "assistant", createdAt: "2026-10-11T00:00:00Z",
      content: "The Worker couldn’t reach an AI model. Connect an AI provider, or check the one in Settings → AI Models, then try again.",
      interruption: { reason: "setup_error" },
    } as never,
    copied: false, showLanding: false, suppressEnterAnimation: true, showRuntimePreview: false, runtimePreviews: [],
    workFolderId: "w", workFolderRoot: "/synthetic/w", onCopyMessage: () => {},
  }));
  const card = document.querySelector<HTMLElement>('[aria-label="Worker setup needed"]')!;
  assert.equal(card.querySelector("strong")?.textContent, "Connect your AI to continue");
  assert.doesNotMatch(card.textContent!, /Settings → AI Models/, "the card adds a way forward, not the reply's sentence again");
  await dom.act(() => card.querySelector("button")!.click());
  assert.equal(requests.length, 1);
  assert.equal(requests[0], undefined, "a click is not taken for a follow-up action");

  let resumed = 0;
  requestConnectAi(() => { resumed += 1; });
  requests.at(-1)?.();
  assert.equal(resumed, 1, "an action that needed AI carries on once connected");
  stopListening();
});
