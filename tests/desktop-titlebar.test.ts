import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

test("Linux title bar routes each control and follows native maximize changes", async t => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls: string[] = [];
  let notify: (value: boolean) => void = () => {};
  let unsubscribed = false;
  let resolveState!: (state: { maximized: boolean }) => void;
  Object.assign(window, { workFoldDesktop: {
    app: { platform: "linux", name: "work-fold" },
    window: {
      control: (action: string) => {
        calls.push(action);
        return action === "state" ? new Promise(resolve => { resolveState = resolve; }) : Promise.resolve({ maximized: false });
      },
      onMaximized: (callback: typeof notify) => { notify = callback; return () => { unsubscribed = true; }; },
    },
    menu: { popup: async (id: string) => { calls.push(`menu:${id}`); } },
  } });
  const { DesktopTitleBar } = await import("../web-local/src/components/chrome/DesktopTitleBar.js");
  await dom.render(createElement(DesktopTitleBar));
  const button = (label: string) => {
    const element = dom.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(element); return element;
  };
  assert.equal(dom.container.querySelector(".desktop-titlebar-brand"), null);
  await dom.act(() => button("Minimize").click());
  await dom.act(() => button("Maximize").click());
  await dom.act(() => notify(true));
  await dom.act(() => resolveState({ maximized: false }));
  await dom.act(() => button("Restore window").click());
  await dom.act(() => notify(false));
  assert.ok(button("Maximize"));
  await dom.press("f", { altKey: true });
  await dom.act(() => button("Quit work-fold").click());
  assert.deepEqual(calls, ["state", "minimize", "toggle-maximize", "toggle-maximize", "menu:file", "quit"]);
  await dom.cleanup();
  assert.equal(unsubscribed, true);
});
