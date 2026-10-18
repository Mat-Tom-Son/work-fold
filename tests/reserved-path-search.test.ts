import assert from "node:assert/strict";
import test from "node:test";

import { reservedPathSearchExtension, reservedSearchExclusionGlob } from "../src/local/agent/reserved-path-search.js";

function handlers() {
  const registered = new Map<string, (event: any) => any>();
  reservedPathSearchExtension({ on: (name: string, handler: any) => registered.set(name, handler) } as any);
  return { call: registered.get("tool_call")!, result: registered.get("tool_result")! };
}

test("grep without its own glob leaves .work-fold and .workspace out at any depth", () => {
  const { call } = handlers();
  const input: Record<string, unknown> = { pattern: "export bug" };
  call({ toolName: "grep", input });
  assert.equal(input.glob, reservedSearchExclusionGlob);
  assert.equal(reservedSearchExclusionGlob, "!**/{.work-fold,.workspace}/**");

  const own: Record<string, unknown> = { pattern: "export bug", glob: "*.md" };
  call({ toolName: "grep", input: own });
  assert.equal(own.glob, "*.md", "a search's own glob is kept");

  const other: Record<string, unknown> = { path: "." };
  call({ toolName: "find", input: other });
  assert.deepEqual(other, { path: "." }, "only grep's input changes");
});

test("grep and find results drop reserved paths but keep content that merely mentions them", () => {
  const { result } = handlers();
  const grep = result({
    toolName: "grep",
    isError: false,
    content: [{ type: "text", text: [
      ".work-fold/conversations/c1.jsonl:1: export bug",
      "nested/.work-fold/work-folder.json:3: export bug",
      ".workspace/old.json:9: export bug",
      ".pi/skills/review/SKILL.md:2: export bug",
      "docs/notes.md:1: export bug, see .work-fold/x",
    ].join("\n") }],
  });
  assert.equal(grep.content[0].text, [".pi/skills/review/SKILL.md:2: export bug", "docs/notes.md:1: export bug, see .work-fold/x"].join("\n"));

  const find = result({
    toolName: "find",
    isError: false,
    content: [{ type: "text", text: [".work-fold/", ".work-fold/conversations/c1.jsonl", "docs/", "docs/notes.md", "nested/.work-fold/work-folder.json", ".workspace"].join("\n") }],
  });
  assert.equal(find.content[0].text, ["docs/", "docs/notes.md"].join("\n"));

  const onlyReserved = result({ toolName: "grep", isError: false, content: [{ type: "text", text: ".work-fold/conversations/c1.jsonl:1: export bug" }] });
  assert.deepEqual(onlyReserved.content, [{ type: "text", text: "No matches found" }]);

  assert.equal(result({ toolName: "grep", isError: false, content: [{ type: "text", text: "docs/notes.md:1: export bug" }] }), undefined, "an untouched result is not replaced");
  assert.equal(result({ toolName: "read", isError: false, content: [{ type: "text", text: ".work-fold/work-folder.json" }] }), undefined, "a deliberate read is untouched");
  assert.equal(result({ toolName: "grep", isError: true, content: [{ type: "text", text: ".work-fold/x:1: y" }] }), undefined, "errors pass through");
});
