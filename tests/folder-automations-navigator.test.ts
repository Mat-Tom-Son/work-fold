import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";

import { buildFixtureFolderAutomations } from "../web-local/src/fixtures/work-folder-fixture.js";
import type { FolderAutomationView } from "../src/shared/automation-presentation.js";
import { createDomHarness } from "./support/dom.js";

// The icon package's named exports do not load under the test runner; stand
// them in so the navigator renders.
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@fluentui/react-icons" ? { url: "test:automations-icons", shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:automations-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=()=>null;`).join("\n"), shortCircuit: true };
    return next(url, context);
  },
});
const { WorkFolderAutomationsNavigator } = await import("../web-local/src/components/panes/WorkFolderAutomationsNavigator.js");

test("the left pane lists this work-folder's automations, and a click opens that one's tab", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const fixture = buildFixtureFolderAutomations()["fixture-home"]!;
  const opened: string[] = [];
  let all = 0;
  await dom.render(createElement(WorkFolderAutomationsNavigator, {
    automations: fixture,
    activeAutomationId: fixture[1]!.automationId,
    onOpen: (automation: FolderAutomationView) => { opened.push(automation.automationId); },
    onOpenAllAutomations: () => { all += 1; },
  }));
  assert.equal(dom.container.querySelector(".history-title h2")?.textContent, "Automations");
  assert.equal(dom.container.querySelector(".history-title span")?.textContent, "2 automations");
  const rows = [...dom.container.querySelectorAll<HTMLButtonElement>(".history-entry")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.getAttribute("aria-label"), `Open ${fixture[0]!.title}`);
  assert.equal(rows[1]!.getAttribute("aria-current"), "true", "the open automation's row is marked");
  assert.match(rows[0]!.textContent ?? "", /On/);
  await dom.act(async () => { rows[0]!.click(); });
  assert.deepEqual(opened, [fixture[0]!.automationId], "the row opens a tab; it changes nothing by itself");
  await dom.act(async () => { (dom.container.querySelector(".folder-automations-footer button") as HTMLButtonElement).click(); });
  assert.equal(all, 1);

  await dom.render(createElement(WorkFolderAutomationsNavigator, { automations: [], activeAutomationId: null, onOpen: () => {}, onOpenAllAutomations: () => {} }));
  assert.match(dom.container.textContent ?? "", /No automations touch this work-folder\./);
});
