import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

const { ChatActionsPopover } = await import("../web-local/src/components/chat/ChatActionsPopover.js");

const workFolder = { id: "disposable", name: "Test folder" } as never;
const conversation = { id: "chat-one", title: "Trip plan", updatedAt: "2026-10-30T12:00:00Z" };

test("the native menu's Rename… opens the popover straight to the name, and Cancel closes it", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let closed = 0;
  const renamed: string[] = [];
  await dom.render(createElement(ChatActionsPopover, {
    state: { workFolder, conversation, x: 40, y: 40, view: "rename" },
    onRename: async (_workFolder, _conversation, title) => { renamed.push(title); },
    onLifecycle: async () => {},
    onDelete: async () => {},
    onClose: () => { closed++; },
  }));
  const input = dom.container.querySelector<HTMLInputElement>("input");
  assert.equal(input?.value, "Trip plan");
  assert.equal(dom.container.querySelector(".chat-actions-back"), null, "no way back to a menu it never showed");
  assert.equal(dom.container.querySelector(".chat-actions-menu"), null);
  const cancel = [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  await dom.act(async () => { cancel.click(); });
  assert.equal(closed, 1);
  assert.deepEqual(renamed, []);
});

test("the popover opened from a right-click still starts at its menu", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(ChatActionsPopover, {
    state: { workFolder, conversation, x: 40, y: 40 },
    onRename: async () => {},
    onLifecycle: async () => {},
    onDelete: async () => {},
    onClose: () => {},
  }));
  assert.ok(dom.container.querySelector(".chat-actions-menu"));
  const rename = [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "Rename")!;
  await dom.act(async () => { rename.click(); });
  assert.ok(dom.container.querySelector(".chat-actions-back"), "Rename from the menu can go back to it");
});
