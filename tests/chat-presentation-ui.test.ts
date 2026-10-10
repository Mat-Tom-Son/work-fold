import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDomHarness } from "./support/dom.js";
import { assistantTurnView } from "../web-local/src/lib/chat-work-trail.js";
import type { AssistantPresentation } from "../src/shared/chat-presentation.js";
import type { ChatMessage, RuntimePreviewEntry } from "../web-local/src/types.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const hook = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:presentation-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === "test:presentation-icons" ? { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true } : next(url, context); },
});
const { ChatMessageRow, copyMarkdownToClipboard } = await import("../web-local/src/components/chat/messages.js");
const { RuntimeContextPreview } = await import("../web-local/src/components/chat/activity.js");
hook.deregister();

function text(...parts: Array<["progress" | "final" | "command", number, string]>) {
  let offset = 0;
  const presentation: AssistantPresentation = { version: 1, truncated: false, segments: parts.map(([kind, order, value]) => {
    const segment = { kind, order, start: offset, end: offset + value.length }; offset = segment.end + 2; return segment;
  }) };
  return { content: parts.map((part) => part[2]).join("\n\n"), presentation };
}
const tool: RuntimePreviewEntry = { id: "tool:edit", kind: "tool", toolName: "edit", text: "Edited", detail: "notes.txt", phase: "complete", order: 2,
  edit: { path: "notes.txt", diff: "-<script>old()</script>\n+New text", firstChangedLine: 4, truncated: true } };

test("Chat Copy keeps the full Markdown and safe rich formatting on the native clipboard route", async (t) => {
  const dom = await createDomHarness(); t.after(dom.cleanup);
  const copies: Array<{ text: string; html?: string }> = [];
  window.workFoldDesktop = { clipboard: { write: async (content) => { copies.push(content); } } } as NonNullable<Window["workFoldDesktop"]>;
  const input = "Checking the notes.\n\n## Final answer\n\n**Ready** <script>bad()</script> 🌍";
  await copyMarkdownToClipboard(input);
  assert.equal(copies.length, 1);
  assert.equal(copies[0]!.text, input);
  assert.match(copies[0]!.html!, /<h2>Final answer<\/h2>/);
  assert.match(copies[0]!.html!, /<strong>Ready<\/strong>/);
  assert.match(copies[0]!.html!, /&lt;script&gt;/);
  assert.doesNotMatch(copies[0]!.html!, /<script>/);
});

test("new presentation interleaves progress and tool evidence, keeping the full reply authoritative", () => {
  const input = text(["progress", 1, "Checking the notes."], ["progress", 3, "Checking the edit."], ["final", 5, "The notes are ready."]);
  const view = assistantTurnView(input.content, input.presentation, [tool, { id: "thinking:1", kind: "thinking", text: "", phase: "complete", durationMs: 2500, order: 0 }]);
  assert.deepEqual(view.steps.map((entry) => entry.order), [0, 1, 2, 3]);
  assert.equal(view.answer, "The notes are ready."); assert.equal(view.hasFinal, true);
  assert.equal(view.steps[2]?.edit?.diff, tool.edit?.diff);
  assert.equal(input.content, "Checking the notes.\n\nChecking the edit.\n\nThe notes are ready.");
});

test("legacy, incomplete and inconsistent metadata never hides or invents historical text", () => {
  const input = text(["progress", 1, "Progress."], ["final", 3, "Final."]);
  const legacy = { ...input.presentation, segments: input.presentation.segments.map(({ order: _order, ...segment }) => segment) };
  for (const metadata of [undefined, legacy, { ...input.presentation, truncated: true }, { ...input.presentation, segments: [{ ...input.presentation.segments[0]!, end: 999 }] }]) {
    const view = assistantTurnView(input.content, metadata, [tool]);
    assert.equal(view.answer, input.content); assert.equal(view.segmented, false); assert.deepEqual(view.steps, [tool]);
  }
  const duplicate = assistantTurnView(input.content, input.presentation, [{ ...tool, order: 1 }]);
  assert.equal(duplicate.answer, input.content);
});

test("raw progress stays open until canonical final classification; stopped progress is still accessible", () => {
  const initial = assistantTurnView("Checking", undefined, [], { canonicalText: "", pendingOrder: 1 });
  assert.equal(initial.hasFinal, false); assert.equal(initial.answer, ""); assert.equal(initial.steps[0]?.text, "Checking");
  const input = text(["progress", 1, "Checking."]);
  const continued = assistantTurnView(input.content + "\n\nNext step", input.presentation, [tool], { canonicalText: input.content, pendingOrder: 3 });
  assert.deepEqual(continued.steps.map((entry) => entry.order), [1, 2, 3]); assert.equal(continued.hasFinal, false);
  const html = renderToStaticMarkup(createElement(RuntimeContextPreview, { entries: continued.steps, running: true, replyStarted: continued.hasFinal }));
  assert.match(html, /work-steps running open/); assert.doesNotMatch(html, /work-steps-summary/);
  const stopped = assistantTurnView(input.content, input.presentation, [tool]);
  assert.equal(stopped.steps[0]?.text, "Checking."); assert.equal(stopped.hasFinal, false);
  const currentOnly = renderToStaticMarkup(createElement(RuntimeContextPreview, { entries: continued.steps, running: true, runningView: "current-step" }));
  assert.match(currentOnly, /Next step/); assert.doesNotMatch(currentOnly, /Checking\./);
  const whitespace = assistantTurnView("  Checking.\n\nNext", input.presentation, [tool], { canonicalText: input.content, pendingOrder: 3 });
  assert.equal(whitespace.answer, "  Checking.\n\nNext"); assert.equal(whitespace.segmented, false, "mismatched canonical whitespace never hides pending text");
});

test("saved rows expose captured edit text safely, and Copy retains progress plus the final reply", async (t) => {
  const dom = await createDomHarness(); t.after(dom.cleanup);
  const input = text(["progress", 1, "Checking [the notes](notes.txt)."], ["final", 3, "The notes are ready."]);
  const message: ChatMessage = { id: "reply", role: "assistant", createdAt: "2026-09-27T12:00:00Z", content: input.content,
    assistantPresentation: input.presentation, workTrail: [{ ...tool, kind: "tool" }] };
  const copies: string[] = [];
  const opened: string[] = [];
  await dom.render(createElement(ChatMessageRow, { message, copied: false, showLanding: true, suppressEnterAnimation: true,
    showRuntimePreview: false, runtimePreviews: [], spaceId: "folder", spaceRoot: "/folder", onCopyMessage: (_id, value) => { copies.push(value); },
    onOpenSpaceFile: (path) => { opened.push(path); }, resolveSpacePathLinks: async () => new Map([["notes.txt", "notes.txt"]]) }));
  assert.equal(dom.container.querySelector(".message-surface > .message-body")?.textContent, "The notes are ready.");
  const summary = dom.container.querySelector<HTMLButtonElement>(".work-steps-summary")!;
  await dom.act(() => summary.click()); assert.equal(summary.getAttribute("aria-expanded"), "true");
  const details = dom.container.querySelector<HTMLDetailsElement>(".work-step-edit")!;
  assert.ok(details.querySelector("summary")?.textContent?.includes("line 4"));
  assert.match(details.textContent!, /preview is incomplete/);
  assert.match(details.querySelector("pre")!.textContent!, /<script>old\(\)<\/script>/);
  assert.equal(dom.container.querySelector("script"), null);
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>(".work-step-progress .space-file-link")!.click());
  assert.deepEqual(opened, ["notes.txt"], "progress keeps ordinary Folder file links");
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());
  assert.deepEqual(copies, [input.content]);
});
