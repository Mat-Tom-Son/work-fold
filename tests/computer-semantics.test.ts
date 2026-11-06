import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { outcomeAfterObservedValues } from "@injaneity/pi-computer-use/src/actions.ts";
import { graftScopedOutline, parseLookResponse } from "@injaneity/pi-computer-use/src/outline.ts";

test("successor text checks distinguish contradictions, unreadable values and repeated writes", () => {
  const actions = [{ action: "setText" as const, ref: "@e1", text: "old" }, { action: "setText" as const, ref: "@e1", text: "new" }];
  assert.equal(outcomeAfterObservedValues("worked", actions, () => "unchanged"), "didnt");
  assert.equal(outcomeAfterObservedValues("unknown", actions, () => "new"), "worked");
  assert.equal(outcomeAfterObservedValues("worked", actions, () => undefined), "unknown");
});

test("a scoped outline retains native incompleteness and unreadable-value evidence", () => {
  const parse = (outline: object) => parseLookResponse({ lookId: "look", window: {}, outline }).parsedOutline!;
  const base = parse({ ref: "root", role: "window", children: [{ ref: "field", role: "text", title: "Editor" }] });
  const scoped = parse({ ref: "field", role: "text", title: "Editor", truncated: true, valueReadable: false });
  graftScopedOutline(base, base.root.children[0].ref, scoped);
  assert.equal(base.root.children[0].truncated, true);
  assert.equal(base.root.children[0].valueReadable, false);
});

test("Pi tools preserve contradictory observations and uncertain native delivery", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/included-tools/computer-semantics.mts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, output); assert.match(output, /PASS computer successor/);
  } finally { clearTimeout(timer); }
});
