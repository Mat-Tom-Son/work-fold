import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";

import { useRestrictedApps } from "../web-local/src/hooks/useRestrictedApps.js";
import type { RestrictedAppInstalled } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

test("app catalog updates and removal preserve a sibling installation of the same app", async (context) => {
  const dom = await createDomHarness();
  context.after(() => dom.cleanup());
  const preview = { spaceId: "source", manifest: { id: "quotes", title: "Quotes" }, digest: "a".repeat(64),
    featureInstallationId: "feature-installation_preview", version: "1", runtimeInstanceId: "runtime-instance_preview" } as RestrictedAppInstalled;
  const release = { ...preview, featureInstallationId: "feature-installation_release", runtimeInstanceId: "runtime-instance_release" };
  const fixtureApps = { source: [preview, release] };
  const onError = (error: unknown) => { throw error; };
  function Catalog() {
    const catalog = useRestrictedApps({ activeSpaceId: "source", fixtureMode: true, fixtureApps, onError });
    return createElement("div", null,
      createElement("button", { id: "update", onClick: () => catalog.upsertApp({ ...preview, version: "2", digest: "b".repeat(64) }) }, "Update preview"),
      createElement("button", { id: "remove", onClick: () => catalog.removeApp("source", preview.featureInstallationId) }, "Remove preview"),
      createElement("button", { id: "reinstall", onClick: () => catalog.upsertApp({ ...preview, featureInstallationId: "feature-installation_new" }) }, "Reinstall preview"),
      ...(catalog.appsBySpace.source ?? []).map((app) => createElement("output", {
        key: app.featureInstallationId, "data-installation": app.featureInstallationId,
      }, app.version)));
  }
  const values = () => [...dom.container.querySelectorAll("output")].map((item) => [item.getAttribute("data-installation"), item.textContent]);
  const click = async (id: string) => dom.act(() => dom.container.querySelector<HTMLButtonElement>(`#${id}`)!.click());
  await dom.render(createElement(Catalog));
  await click("update");
  assert.deepEqual(values(), [[preview.featureInstallationId, "2"], [release.featureInstallationId, "1"]]);
  await click("remove");
  assert.deepEqual(values(), [[release.featureInstallationId, "1"]]);
  await click("reinstall");
  assert.deepEqual(values(), [[release.featureInstallationId, "1"], ["feature-installation_new", "1"]]);
});
