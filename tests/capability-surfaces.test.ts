import assert from "node:assert/strict";
import test from "node:test";

import { contributedSurfaces, resolveSurfaceForKey, surfaceMatchesTab } from "../web-local/src/lib/capability-surfaces.js";
import type { AgentExtensionSurface, SpaceSurfaceTab } from "../web-local/src/types.js";

const piSurface: AgentExtensionSurface = {
  id: "inbox",
  title: "Pi inbox",
  extensionPath: ".pi/extensions/inbox.ts",
  manifestPath: ".pi/extensions/surface.json",
  source: "project",
  scope: "project",
  views: [{ id: "overview", title: "Overview", blocks: [] }],
};

test("Pi surfaces remain in their native full-trust manifest lane", () => {
  const surfaces = contributedSurfaces("space-1", [piSurface]);
  assert.deepEqual(surfaces.map((surface) => [surface.key, surface.execution]), [["pi:space-1:inbox", "full-trust-pi"]]);
  assert.equal(resolveSurfaceForKey(surfaces, "inbox")?.execution, "full-trust-pi");
});

test("Pi surface tabs resolve against the namespaced Space surface", () => {
  const surface = contributedSurfaces("space-1", [piSurface])[0]!;
  const tab: SpaceSurfaceTab = {
    id: `extension:space-1:${surface.key}:overview`,
    kind: "extension",
    spaceId: "space-1",
    surfaceId: surface.key,
    surfaceExecution: "full-trust-pi",
    viewId: "overview",
    title: "Overview",
  };
  assert.equal(surfaceMatchesTab(surface, tab), true);
  assert.equal(surfaceMatchesTab({ ...surface, key: "pi:space-2:inbox" }, tab), false);
});
