import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createElement, useMemo, useState } from "react";
import test from "node:test";
import { applicationPalettes } from "../src/shared/application-appearance.js";
import { accentIdentityFromHex, resolveWorkFolderAppearance, wcagContrast } from "../src/shared/work-folder-appearance.js";
import { createDomHarness } from "./support/dom.js";
import type { WorkFolderSummary } from "../web-local/src/types.js";

test("work-folder roles resolve against every application palette without altering saved identities", async (t) => {
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:appearance-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:appearance-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  const { applicationWorkFolderGrounds, WorkFolderAppearanceProvider, useWorkFolderIdentityResolver } = await import("../web-local/src/lib/work-folder-appearance-context.js");
  const { workFolderIdentityStyle } = await import("../web-local/src/lib/work-folder-identity.js");
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const workFolder = { id: "workshop", name: "Workshop", workFolderRoot: "/tmp/workshop", location: { kind: "local", storage: "linked" } } as WorkFolderSummary;
  const customizations = { workshop: { color: "#953ea3", color2: "#cc4e00", bannerName: "mist" } };
  const saved = JSON.stringify(customizations);
  function MemoizedConversation() {
    const resolve = useWorkFolderIdentityResolver();
    const identity = useMemo(() => resolve(workFolder, customizations), [resolve]);
    const [draft, setDraft] = useState("Keep my draft");
    return createElement("div", { style: workFolderIdentityStyle(identity, "light") }, createElement("input", { value: draft, onChange: (event) => setDraft(event.currentTarget.value) }), createElement("output", null, identity.color));
  }
  for (const palette of Object.keys(applicationPalettes) as Array<keyof typeof applicationPalettes>) {
    await dom.render(createElement(WorkFolderAppearanceProvider, { palette, children: createElement(MemoizedConversation) }));
    const expected = resolveWorkFolderAppearance({ primary: accentIdentityFromHex(customizations.workshop.color), secondary: accentIdentityFromHex(customizations.workshop.color2), grounds: applicationWorkFolderGrounds(palette) });
    assert.equal((dom.container.firstElementChild as HTMLElement).style.getPropertyValue("--work-folder-accent-soft-fill"), expected.light.softFill);
    assert.equal((dom.container.firstElementChild as HTMLElement).style.getPropertyValue("--work-folder-accent-text-body"), expected.light.textBody);
    assert.equal(dom.container.querySelector("input")!.value, "Keep my draft");
    assert.equal(dom.container.querySelector("output")!.textContent, customizations.workshop.color);
    assert.equal(expected.passes, true);
    for (const mode of ["light", "dark"] as const) {
      assert.ok(wcagContrast(expected[mode].textBody, applicationPalettes[palette][mode].surface) >= 4.5);
      assert.ok(wcagContrast(expected[mode].textBody, expected[mode].softFill) >= 4.5);
    }
  }
  assert.equal(JSON.stringify(customizations), saved);
});
