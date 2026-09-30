import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

test("folder creation keeps its destination, shows a duplicate error, and allows correction", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  // Node cannot import Fluent's named exports through its CommonJS entry;
  // shell glyphs are inert in this form interaction test.
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const icons = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:folder-fluent-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      return url === "test:folder-fluent-icons"
        ? { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true }
        : next(url, context);
    },
  });
  t.after(async () => { globalThis.fetch = originalFetch; await dom.cleanup(); icons.deregister(); });
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    return body.name === "Existing"
      ? new Response(JSON.stringify({ error: "A file or folder named Existing already exists there." }), { status: 400 })
      : new Response(JSON.stringify({ folder: { path: `Notes/${body.name}`, name: body.name } }));
  }) as typeof fetch;
  const { NewFolderModal } = await import("../web-local/src/components/modals/NewFolderModal.js");
  const created: unknown[] = [];
  let closed = 0;
  await dom.render(createElement(NewFolderModal, {
    target: { spaceId: "original-folder", spaceName: "Planning", parentPath: "Notes" },
    onCreated: (folder) => created.push(folder),
    onClose: () => { closed += 1; },
  }));
  assert.match(dom.container.textContent ?? "", /Create inside Notes/);
  const input = dom.container.querySelector<HTMLInputElement>("input")!;
  const submit = dom.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.disabled, true);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  async function enter(value: string) {
    await dom.act(() => {
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await enter("Existing");
  await dom.act(() => { submit.click(); });
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("already exists"));
  assert.equal(closed, 0);
  assert.equal(created.length, 0);
  await enter("  Research  ");
  await dom.act(() => { submit.click(); });
  await dom.waitFor(() => closed === 1);
  assert.deepEqual(calls, [
    { url: "/api/spaces/original-folder/folders", body: { parentPath: "Notes", name: "Existing" } },
    { url: "/api/spaces/original-folder/folders", body: { parentPath: "Notes", name: "Research" } },
  ]);
  assert.deepEqual(created, [{ path: "Notes/Research", name: "Research" }]);
});
