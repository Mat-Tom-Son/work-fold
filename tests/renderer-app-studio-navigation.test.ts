import assert from "node:assert/strict";
import { createElement, useState } from "react";
import test from "node:test";

import { useAppStudioNavigation } from "../web-local/src/hooks/useAppStudioNavigation.js";
import { createDomHarness } from "./support/dom.js";

const instances = ["first", "second"].map((spaceId) => ({ spaceId, runtimeInstanceId: `runtime-${spaceId}` }));
const registeredSpaceIds = new Set(["first", "second"]);
function TargetControl({ navigation, loading = false, onError }: {
  navigation: { id: string; runtimeInstanceId: string }; loading?: boolean; onError: (message: string) => void;
}) {
  const [target, setTarget] = useState("first");
  useAppStudioNavigation({ active: true, loading, instances, navigation, registeredSpaceIds,
    selectId: "target", onSelect: setTarget, onError });
  return createElement("select", { id: "target", value: target, onChange: (event: any) => setTarget(event.target.value) },
    createElement("option", { value: "", disabled: true }, "Choose a Space"),
    ...instances.map((item) => createElement("option", { value: item.spaceId, key: item.spaceId }, item.spaceId)));
}

test("App Studio navigation waits for data, selects its exact installation once, and preserves later manual selection", async (context) => {
  const dom = await createDomHarness();
  context.after(() => dom.cleanup());
  const errors: string[] = [];
  const props = { navigation: { id: "open-second", runtimeInstanceId: "runtime-second" }, onError: (message: string) => errors.push(message) };
  const select = () => dom.container.querySelector<HTMLSelectElement>("#target")!;
  await dom.render(createElement(TargetControl, { ...props, loading: true }));
  assert.equal(select().value, "first");
  await dom.render(createElement(TargetControl, props));
  await dom.settle();
  assert.equal(select().value, "second");
  assert.equal(document.activeElement, select());
  await dom.act(() => { select().value = "first"; select().dispatchEvent(new Event("change", { bubbles: true })); });
  await dom.render(createElement(TargetControl, { ...props, navigation: { ...props.navigation } }));
  await dom.settle();
  assert.equal(select().value, "first", "refreshes must preserve a person's subsequent choice");
  await dom.render(createElement(TargetControl, { ...props, navigation: { id: "missing", runtimeInstanceId: "runtime-removed" } }));
  assert.match(errors[0]!, /no longer available/);
  assert.equal(select().value, "", "a removed target cannot fall back to a different installation");
});
