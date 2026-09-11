import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDomHarness } from "./support/dom.js";

import {
  restrictedAppAutomationOutcomeLabel,
} from "../web-local/src/lib/restricted-app-automation.js";
import {
  restrictedAppAssistantTaskCanStop,
  restrictedAppAssistantTaskStatusLabel,
} from "../web-local/src/lib/restricted-app-assistant.js";
import type { RestrictedAppInstalled, SpaceSummary } from "../web-local/src/types.js";

test("automation history distinguishes interrupted work from an explicit cancellation", () => {
  assert.equal(restrictedAppAutomationOutcomeLabel({ outcome: "cancelled", state: "cancelled" }), "Cancelled");
  assert.equal(
    restrictedAppAutomationOutcomeLabel({ outcome: "interrupted", state: "expired" }),
    "Interrupted — completion unknown",
  );
});

test("Assistant request rows show plain status words and offer Stop only while work can still be stopped", () => {
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "dispatching" }), "Starting");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "running" }), "Running");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "running", cancellationRequested: true }), "Stopping");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "succeeded" }), "Done");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "failed" }), "Failed");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "cancelled" }), "Stopped");
  assert.equal(restrictedAppAssistantTaskStatusLabel({ status: "interrupted" }), "Interrupted");
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "running" }), true);
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "dispatching" }), true);
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "running", cancellationRequested: true }), false);
  assert.equal(restrictedAppAssistantTaskCanStop({ status: "succeeded" }), false);
});

// Apps come up with their schedules already on (docs/receipts-not-gates.md,
// F21), so the toggle in the Apps tab is the person's own direct control.
// Turning one back on must act on the click, not open a second question about
// powers the installation already granted. The confirm host is mounted from
// the same bundle as the section, so a dialog request would be observable
// here; its absence is the assertion.
test("turning an automation back on acts on the click and leaves a receipt, with no second question", async (t) => {
  const compiled = await mkdtemp(resolve("node_modules/.app-automation-renderer-test-"));
  t.after(() => rm(compiled, { recursive: true, force: true }));
  const entry = join(compiled, "entry.ts");
  const outfile = join(compiled, "component.mjs");
  await writeFile(entry, [
    `export { RestrictedAppsSection } from ${JSON.stringify(resolve("web-local/src/components/panes/RestrictedAppsSection.tsx"))};`,
    `export { ConfirmDialogHost } from ${JSON.stringify(resolve("web-local/src/ui/feedback.tsx"))};`,
  ].join("\n"));
  await build({ entryPoints: [entry], outfile,
    bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
    plugins: [{ name: "renderer-icons", setup(builder) {
      builder.onResolve({ filter: /^@fluentui\/react-icons$/ }, () => ({ path: resolve("node_modules/@fluentui/react-icons/lib/index.js") }));
    } }], logLevel: "silent" });
  const { RestrictedAppsSection, ConfirmDialogHost } = await import(pathToFileURL(outfile).href) as {
    RestrictedAppsSection: typeof import("../web-local/src/components/panes/RestrictedAppsSection.js").RestrictedAppsSection;
    ConfirmDialogHost: typeof import("../web-local/src/ui/feedback.js").ConfirmDialogHost;
  };

  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });

  const automation = { id: "digest", title: "Daily digest", handler: "digest", trigger: { kind: "interval", intervalMinutes: 1440 },
    permissions: { network: ["mail"], files: [], notifications: [] }, catchUp: "latest", overlap: "skip" } as const;
  const app = { spaceId: "space-one", sourceSpaceId: "space-one", featureInstallationId: "feature-one", runtimeInstanceKind: "development", runtimeInstanceId: "runtime-one",
    packageName: "digests", version: "1.0.0", digest: "b".repeat(64), installedAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    networkGrants: ["mail"], fileGrants: [], notificationGrants: [], automations: [{ id: automation.id, enabled: false }],
    manifest: { id: "digests", title: "Digests", version: 1, runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" }, ui: {}, tools: [],
      automations: [automation], permissions: { network: [], files: [], notifications: [] } } } as unknown as RestrictedAppInstalled;

  const writes: { method: string; path: string }[] = [];
  globalThis.fetch = (async (input: unknown, options?: { method?: string; signal?: AbortSignal }) => {
    const path = String(input);
    const method = (options?.method ?? "GET").toUpperCase();
    if (path.includes("control-events")) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true });
      });
    }
    let value: unknown;
    if (path.includes("/automations/")) {
      writes.push({ method, path });
      value = { app: { ...app, automations: [{ id: automation.id, enabled: true, nextRunAt: "2026-09-10T00:00:00.000Z" }] } };
    } else if (path.includes("assistant-tasks")) value = { tasks: [] };
    else if (path.includes("inference")) value = { receipts: [] };
    else if (path.includes("build-context")) value = { context: { sourceSpaceId: app.spaceId, sourcePath: null, buildConversationId: null, updateTargetRuntimeInstanceId: null } };
    else if (path.includes("connections")) value = { connections: [] };
    else if (path.includes("storage/recovery")) value = { recovery: null };
    else if (path.includes("storage")) value = { usage: { revision: 0, usageBytes: 0, quotaBytes: 1000, keyCount: 0, keyLimit: 512 } };
    else throw new Error(`Unexpected API read: ${path}`);
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  const changed: RestrictedAppInstalled[] = [];
  const errors: (string | null)[] = [];
  await dom.render(createElement("main", null,
    createElement(RestrictedAppsSection, {
      space: { id: app.spaceId, name: "Digests", spaceRoot: "/synthetic" } as SpaceSummary,
      apps: [app], loading: false, onBuildApp() {}, onOpenAppStudio() {},
      onUpsertApp(next: RestrictedAppInstalled) { changed.push(next); },
      onRemoveApp() {}, onError(message: string | null) { errors.push(message); },
    }),
    createElement(ConfirmDialogHost, null)));

  const button = (label: string) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label);
  await dom.act(() => button("Review access")!.click());
  await dom.waitFor(() => Boolean(button("Enable")));
  await dom.act(() => button("Enable")!.click());
  await dom.waitFor(() => writes.length > 0);
  await dom.settle();

  assert.deepEqual(writes.map((write) => write.method), ["PUT"], "enabling sends exactly one direct call");
  assert.ok(writes[0]!.path.includes("/automations/digest"), "the call names the automation");
  assert.equal(changed.at(-1)?.automations[0]?.enabled, true, "the receipted result turns the schedule on");
  assert.deepEqual(errors, [], "nothing failed");
  const dialogTitles = Array.from(document.querySelectorAll('[role="dialog"] h2')).map((heading) => heading.textContent);
  assert.ok(!dialogTitles.some((title) => title?.startsWith("Enable ")), `no second question was asked: ${dialogTitles.join(", ")}`);
  assert.equal(document.body.textContent?.includes("still require their separate grants"), false, "the retired separate-grants warning is gone");
});
