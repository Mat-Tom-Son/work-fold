import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { savedWorkTrailPreviews } from "../web-local/src/lib/chat-work-trail.js";
import type { RuntimePreviewEntry } from "../web-local/src/types.js";

// The strip draws its icons from the Fluent set, whose package exposes no ESM
// names to Node. These tests check the markup around the icons, so they stub
// to nothing, the same way the Settings window tests load their icons.
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const icons = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:chat-activity-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:chat-activity-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    return next(url, context);
  },
});
const { RuntimeContextPreview, formatDuration, workFolderRelativeToolPath, thoughtPreview, workStepsSummary } = await import("../web-local/src/components/chat/activity.js");
icons.deregister();

const read = (id: string, detail: string): RuntimePreviewEntry => ({ id, kind: "tool", toolName: "read", text: "Read finished", detail, phase: "complete" });
const bash = (id: string, detail: string): RuntimePreviewEntry => ({ id, kind: "tool", toolName: "bash", text: "Bash finished", detail, phase: "complete" });
const thought = (id: string, text: string, extra: Partial<RuntimePreviewEntry> = {}): RuntimePreviewEntry => ({ id, kind: "thinking", text, phase: "complete", ...extra });
const render = (props: Parameters<typeof RuntimeContextPreview>[0]) => renderToStaticMarkup(createElement(RuntimeContextPreview, props));

test("reasoning cleanup removes orphan emphasis without damaging valid Markdown or code", () => {
  const html = render({
    running: true,
    entries: [{
      id: "thinking-1",
      kind: "thinking",
      phase: "streaming",
      text: [
        "And **pushToast exists. **Valid emphasis** stays valid.",
        "Inline `2 ** 3` and fenced code stay literal:",
        "~~~js",
        "const value = 2 ** 3;",
        "~~~",
      ].join("\n\n"),
    }],
  });

  assert.match(html, /And pushToast exists\./);
  assert.match(html, /<strong>Valid emphasis<\/strong>/);
  assert.match(html, /<code>2 \*\* 3<\/code>/);
  assert.match(html, /const value = 2 \*\* 3;/);
  assert.doesNotMatch(html, /And \*\*pushToast/);
  assert.match(html, /class="work-step-thought live"/);
});

test("steps keep the order they happened and fold into a plain summary once the reply starts", () => {
  const entries = [
    thought("t1", "Let me read the notes first."),
    read("r1", "/Users/mat/Folder/notes.md"),
    thought("t2", "Now the budget."),
    bash("b1", "rg -n total budget.csv"),
  ];
  const running = render({ entries, running: true, workFolderRoot: "/Users/mat/Folder" });
  const order = ["Let me read the notes first.", ">Read<", "notes.md", "Now the budget.", ">Ran<", "rg -n total budget.csv"]
    .map((needle) => running.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), running);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(running, /class="work-steps running open"/);
  assert.doesNotMatch(running, /work-steps-summary/);

  const folded = render({ entries, running: true, replyStarted: true });
  assert.match(folded, /class="work-steps settled"/);
  assert.match(folded, /class="work-steps-summary" aria-expanded="false"/);
  assert.match(folded, />Read a file, ran a command</);
  assert.match(folded, /class="work-steps-rows" inert=""/);
});

test("the summary names tool kinds in first-use order and counts what they touched", () => {
  const edit: RuntimePreviewEntry = { id: "e1", kind: "tool", toolName: "edit", text: "Edit finished", detail: "a.md", phase: "complete" };
  const other: RuntimePreviewEntry = { id: "x1", kind: "tool", toolName: "browser_navigate", text: "Browser Navigate finished", detail: "https://example.com", phase: "complete" };
  assert.equal(workStepsSummary([read("r1", "docs/a.md")]), "Read a.md");
  assert.equal(workStepsSummary([bash("b1", "ls -la")]), "Ran ls -la");
  assert.equal(workStepsSummary([read("r1", "a.md"), read("r2", "b.md"), bash("b1", "ls"), bash("b2", "ls -la"), edit]), "Read files, ran commands, edited a file");
  assert.equal(workStepsSummary([read("r1", "a.md"), thought("t1", "Thinking text.")]), "Read a.md");
  assert.equal(workStepsSummary([thought("t1", "Only reasoning.")]), "Thought it through");
  assert.equal(workStepsSummary([thought("t1", "", { durationMs: 2_400 }), thought("t2", "", { durationMs: 1_100 })]), "Thought for 4s");
  assert.equal(workStepsSummary([other, read("r1", "a.md")]), "Used Browser Navigate, read a file");
  assert.equal(workStepsSummary([]), "");
});

test("hidden reasoning shows its time while running and stays as a timed thought when kept", () => {
  const live = render({ running: true, entries: [{ id: "t1", kind: "thinking", text: "", phase: "streaming", startedAt: Date.now() - 3_000 }] });
  assert.match(live, />Thinking…</);
  assert.match(live, /class="work-step-timer">3s</);
  assert.doesNotMatch(live, /Working…/);

  const kept = render({ entries: [thought("t1", "", { durationMs: 2_600 }), read("r1", "a.md")] });
  assert.match(kept, />Thought for 3s</);
  assert.match(kept, /class="work-step thinking silent"/);

  assert.equal(render({ entries: [thought("t1", "")] }), "");
  assert.match(render({ running: true, entries: [] }), /class="work-step working active"[\s\S]*?>Working…</);
  assert.equal(render({ running: true, replyStarted: true, entries: [] }), "");
});

test("a finished thought shows its first sentence until opened, and file targets link only inside the work-folder", () => {
  const html = render({
    entries: [
      thought("t1", "**Checking the files.** I'm matching the notes against the budget.\n\n```\nlong code line\n```"),
      read("r1", "/Users/mat/Folder/Kitchen refresh/ideas.md"),
      read("r2", "/elsewhere/secret.txt"),
    ],
    workFolderRoot: "/Users/mat/Folder",
    resolvedWorkFolderPaths: new Map([["Kitchen refresh/ideas.md", "Kitchen refresh/ideas.md"]]),
    onOpenWorkFolderFile: () => undefined,
  });
  assert.match(html, /aria-expanded="false"><span class="work-step-verb">Thought<\/span><span class="work-step-target">Checking the files\.<\/span>/);
  assert.doesNotMatch(html, /long code line/);
  assert.match(html, /<button type="button" class="work-step-target file" title="Kitchen refresh\/ideas\.md">ideas\.md<\/button>/);
  assert.match(html, /<span class="work-step-target" title="\/elsewhere\/secret\.txt">secret\.txt<\/span>/);
});

test("tool paths become work-folder-relative only when they sit inside the work-folder", () => {
  assert.equal(workFolderRelativeToolPath("/Users/mat/Folder/notes/a.md", "/Users/mat/Folder"), "notes/a.md");
  assert.equal(workFolderRelativeToolPath("/Users/mat/Folder-2/a.md", "/Users/mat/Folder"), null);
  assert.equal(workFolderRelativeToolPath("/tmp/a.md", "/Users/mat/Folder"), null);
  assert.equal(workFolderRelativeToolPath("notes/a.md", "/Users/mat/Folder"), "notes/a.md");
  assert.equal(workFolderRelativeToolPath("budget variance", "/Users/mat/Folder"), null);
  assert.equal(workFolderRelativeToolPath("/Users/mat/Folder/a.md", undefined), null);
});

test("durations and thought previews read plainly", () => {
  assert.equal(formatDuration(400), "1s");
  assert.equal(formatDuration(2_600), "3s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(thoughtPreview("The user said \"anything else in there we have addressed.\" Let me double check."), "The user said \"anything else in there we have addressed.\"");
  assert.equal(thoughtPreview("```\ncode\n```\n\nAfter the code."), "After the code.");
  assert.equal(thoughtPreview("x".repeat(200)).length, 108);
});

test("saved successful-turn work trails restore thinking and tools without a spinner", () => {
  const previews = savedWorkTrailPreviews({
    id: "assistant-1",
    role: "assistant",
    content: "Done.",
    createdAt: "2026-08-31T20:00:00.000Z",
    workTrail: [
      { kind: "thinking", text: "I should inspect the file.", phase: "complete" },
      { kind: "thinking", text: "", phase: "complete", durationMs: 2_600 },
      { kind: "tool", text: "Read complete", detail: "notes.md", toolName: "read", phase: "complete" },
    ],
  });

  assert.deepEqual(previews.map(({ kind, text, phase }) => ({ kind, text, phase })), [
    { kind: "thinking", text: "I should inspect the file.", phase: "complete" },
    { kind: "thinking", text: "", phase: "complete" },
    { kind: "tool", text: "Read complete", phase: "complete" },
  ]);
  assert.equal(previews[1]?.durationMs, 2_600);
  assert.equal(previews[2]?.detail, "notes.md");
});
