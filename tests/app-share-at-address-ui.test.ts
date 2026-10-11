import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDomHarness } from "./support/dom.js";

import { appCanBeSharedAtAddress, activeSharedAppFor, type SharedPageView } from "../web-local/src/lib/page-sharing.js";
import type { RestrictedAppInstalled, WorkFolderSummary } from "../web-local/src/types.js";

/**
 * Settings → Apps offers "Share at your address" only where the host's viewer
 * adapter would accept it (docs/shared-pages.md, rung 3): an installed App
 * Instance of a prepared Release whose reviewed manifest declares a viewer.
 */
const workFolder = { id: "work-folder-one", name: "Quotes", workFolderRoot: "/synthetic/quotes" } as WorkFolderSummary;
const viewer = { entry: "viewer.html", readable: ["public/"] };

function app(id: string, options: { kind: "development" | "app"; viewer?: typeof viewer }): RestrictedAppInstalled {
  return {
    workFolderId: workFolder.id, sourceWorkFolderId: workFolder.id, featureInstallationId: `feature-installation_${id}`,
    runtimeInstanceKind: options.kind, runtimeInstanceId: `runtime-instance_${id}`, releaseDigest: options.kind === "app" ? `sha256:${"c".repeat(64)}` : null,
    packageName: id, version: "1.0.0", digest: "a".repeat(64), installedAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z",
    networkGrants: [], fileGrants: [], notificationGrants: [], automations: [],
    manifest: { id, title: `App ${id}`, version: 2, runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], automations: [],
      permissions: { network: [], files: [], notifications: [] }, ...(options.viewer ? { viewer: options.viewer } : {}) },
  } as unknown as RestrictedAppInstalled;
}

test("the eligibility rule matches the host's viewer adapter", () => {
  assert.equal(appCanBeSharedAtAddress(app("release", { kind: "app", viewer })), true);
  assert.equal(appCanBeSharedAtAddress(app("no-viewer", { kind: "app" })), false, "nothing to serve without a viewer");
  assert.equal(appCanBeSharedAtAddress(app("preview", { kind: "development", viewer })), false, "a local preview is never shareable");
  const released = { ...app("orphan", { kind: "app", viewer }), releaseDigest: null } as RestrictedAppInstalled;
  assert.equal(appCanBeSharedAtAddress(released), false, "an App Instance needs its prepared Release");
  const publication = { kind: "app", state: "active", app: { appInstanceId: "feature-installation_release" } } as SharedPageView;
  assert.equal(activeSharedAppFor([publication], "feature-installation_release"), publication);
  assert.equal(activeSharedAppFor([{ ...publication, state: "revoked" }], "feature-installation_release"), null);
  assert.equal(activeSharedAppFor(null, "feature-installation_release"), null);
});

test("an app's details offer Share at your address only when eligible, share on the click, and point to Shared Pages", async (t) => {
  const compiled = await mkdtemp(resolve("node_modules/.app-share-at-address-test-"));
  t.after(() => rm(compiled, { recursive: true, force: true }));
  const entry = join(compiled, "entry.ts");
  const outfile = join(compiled, "component.mjs");
  await writeFile(entry, [
    `export { RestrictedAppsSection } from ${JSON.stringify(resolve("web-local/src/components/panes/RestrictedAppsSection.tsx"))};`,
    `export { ToastHost } from ${JSON.stringify(resolve("web-local/src/ui/feedback.tsx"))};`,
    `export { setSharedPages } from ${JSON.stringify(resolve("web-local/src/lib/page-sharing.ts"))};`,
  ].join("\n"));
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".css": "empty" },
    plugins: [{ name: "renderer-icons", setup(builder) {
      builder.onResolve({ filter: /^@fluentui\/react-icons$/ }, () => ({ path: resolve("node_modules/@fluentui/react-icons/lib/index.js") }));
    } }],
    logLevel: "silent",
  });
  const bundle = await import(pathToFileURL(outfile).href) as {
    RestrictedAppsSection: typeof import("../web-local/src/components/panes/RestrictedAppsSection.js").RestrictedAppsSection;
    ToastHost: typeof import("../web-local/src/ui/feedback.js").ToastHost;
    setSharedPages: typeof import("../web-local/src/lib/page-sharing.js").setSharedPages;
  };

  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const eligible = app("release", { kind: "app", viewer });
  const shares: unknown[] = [];
  let publications: SharedPageView[] = [];
  let noAddress = false;
  globalThis.fetch = (async (input: unknown, options?: { method?: string; body?: string; signal?: AbortSignal }) => {
    const path = String(input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (path.endsWith("/api/events")) {
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true }));
    }
    if (path.endsWith("/api/settings/publications/share-app")) {
      shares.push(JSON.parse(options?.body ?? "null"));
      if (noAddress) return json({ error: "Set up web access before sharing an app.", code: "NO_ADDRESS" }, 409);
      const publication = { publicationId: "pub-1", kind: "app", workFolderId: workFolder.id, title: eligible.manifest.title, state: "active",
        app: { appInstanceId: eligible.featureInstallationId, releaseDigest: eligible.releaseDigest, viewerEntry: "viewer.html", viewerSurface: ["entry:viewer.html", "data:public/"] },
        live: true, serveRatePerMinute: 60, byteBudgetPerDay: 1, snapshotEnabled: false, createdAt: "2026-10-11T00:00:00.000Z", bridgeSlot: "pending", viewerPath: "/a/pub-1" } as unknown as SharedPageView;
      publications = [publication];
      return json({ publication, revealable: true });
    }
    if (path.endsWith("/api/settings/publications")) return json({ publications, status: { damaged: false, activeCount: publications.length, pendingBridgeWork: 0 } });
    if (path.includes("assistant-tasks")) return json({ tasks: [] });
    if (path.includes("inference")) return json({ receipts: [] });
    if (path.includes("build-context")) return json({ context: { sourceWorkFolderId: workFolder.id, sourcePath: null, buildConversationId: null, updateTargetRuntimeInstanceId: null } });
    if (path.includes("connections")) return json({ connections: [] });
    if (path.includes("storage/recovery")) return json({ recovery: null });
    if (path.includes("storage")) return json({ usage: { revision: 0, usageBytes: 0, quotaBytes: 1000, keyCount: 0, keyLimit: 512 } });
    throw new Error(`Unexpected API read: ${path}`);
  }) as typeof globalThis.fetch;

  const opened: string[] = [];
  const errors: (string | null)[] = [];
  const apps = [app("preview", { kind: "development", viewer }), app("no-viewer", { kind: "app" }), eligible];
  await dom.render(createElement("main", null,
    createElement(bundle.RestrictedAppsSection, {
      workFolder, apps, loading: false, onOpenAppStudio() {}, onUpsertApp() {}, onRemoveApp() {},
      onOpenSharedPages: () => { opened.push("shared-pages"); },
      onOpenWebAccess: () => { opened.push("web-access"); },
      onError(message: string | null) { errors.push(message); },
    }),
    createElement(bundle.ToastHost, null)));

  const buttons = (label: string) => Array.from(document.querySelectorAll("button")).filter((item) => item.textContent === label);
  const openDetails = async (title: string) => {
    const card = Array.from(document.querySelectorAll(".restricted-app-card")).find((item) => item.textContent?.includes(title))!;
    await dom.act(() => Array.from(card.querySelectorAll("button")).at(-1)!.click());
    await dom.waitFor(() => Boolean(document.querySelector('[role="dialog"]')));
    await dom.settle();
  };
  const closeDetails = async () => {
    await dom.act(() => buttons("Done")[0]!.click());
    await dom.waitFor(() => !document.querySelector('[role="dialog"]'));
  };

  for (const title of ["App preview", "App no-viewer"]) {
    await openDetails(title);
    assert.equal(buttons("Share at your address").length, 0, `${title} is not offered for sharing`);
    assert.equal(document.querySelector(".restricted-app-share-note"), null);
    await closeDetails();
  }

  await openDetails("App release");
  const dialog = document.querySelector('[role="dialog"]')!;
  const lifecycle = Array.from(dialog.querySelectorAll(".restricted-app-lifecycle")).find((section) => section.querySelector("h3")?.textContent === "Lifecycle");
  assert.match(lifecycle?.textContent ?? "", /Share at your address/, "the button sits in Lifecycle");
  assert.match(dialog.querySelector(".restricted-app-share-note")?.textContent ?? "",
    /Sharing shows viewer\.html to anyone with the link\. Viewers can read public\/ in this app's data, and never write, act, or reach connections\./);

  // No address yet: the click shares nothing and points to Web Access.
  noAddress = true;
  await dom.act(() => buttons("Share at your address")[0]!.click());
  await dom.waitFor(() => document.body.textContent?.includes("Set up web access before sharing an app.") === true);
  await dom.act(() => buttons("Web Access")[0]!.click());
  assert.deepEqual(opened, ["web-access"]);
  assert.deepEqual(errors, [], "a missing address is guidance, not an error");

  // With an address the click shares at once and points to Shared Pages.
  noAddress = false;
  opened.length = 0;
  await openDetails("App release");
  await dom.act(() => buttons("Share at your address")[0]!.click());
  await dom.waitFor(() => document.body.textContent?.includes("App release is at your address. Show its link in Settings → Shared Pages.") === true);
  assert.deepEqual(shares.at(-1), { workFolderId: workFolder.id, instance: eligible.featureInstallationId });
  await dom.waitFor(() => buttons("Open Shared Pages").length > 0);
  assert.equal(buttons("Share at your address").length, 0, "a shared app opens Shared Pages instead of sharing again");
  await dom.act(() => buttons("Open Shared Pages")[0]!.click());
  assert.ok(opened.includes("shared-pages"));
  assert.equal(shares.length, 2, "each click is one call; nothing asked first");
  bundle.setSharedPages(null);
});
