import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { hashAppPlatformArtifact } from "../src/local/agent/app-platform-artifact.js";
import {
  inspectRestrictedAppPackage,
  restrictedAppPackageLimits,
  stageRestrictedAppReleaseArtifact,
  stageRestrictedAppPackage,
  type RestrictedAppReleaseArtifactEntry,
} from "../src/local/agent/restricted-app-package.js";

test("restricted app packages are inspected and content-addressed without evaluating their code", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-app-"));
  const source = join(sandbox, "source");
  const staged = join(sandbox, "staged");
  const canary = join(sandbox, "executed.txt");
  try {
    await writePackage(source, `throw new Error(${JSON.stringify(`code executed and would write ${canary}`)});\n`);
    const inspection = await inspectRestrictedAppPackage(source);
    assert.equal(inspection.manifest.id, "connected-inbox");
    assert.equal(inspection.manifest.runtime.entry, "index.html");
    assert.equal(inspection.manifest.runtime.worker, "worker.js");
    assert.equal(inspection.digest.length, 64);

    const receipt = await stageRestrictedAppPackage(source, staged);
    assert.equal(receipt.digest, inspection.digest);
    assert.equal(receipt.stagedRoot, join(staged, inspection.digest));
    assert.equal(await missing(canary), true, "inspection and staging must not evaluate app.js");

    await writeFile(join(source, "worker.js"), "globalThis.changed = true;\n", "utf8");
    const stagedEntry = await readFile(join(receipt.stagedRoot, "worker.js"), "utf8");
    assert.match(stagedEntry, /throw new Error/);
    assert.notEqual((await inspectRestrictedAppPackage(source)).digest, receipt.digest);
    assert.equal((await inspectRestrictedAppPackage(receipt.stagedRoot)).digest, receipt.digest);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("restricted app package staging supports a flush-compatible atomic commit for nested bytes", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-app-durable-"));
  const source = join(sandbox, "source");
  const staged = join(sandbox, "staged");
  try {
    await writePackage(source, "export {};\n");
    await mkdir(join(source, "assets", "nested"), { recursive: true });
    const nestedSource = join(source, "assets", "nested", "content.txt");
    await writeFile(nestedSource, "durable content\n", "utf8");
    await chmod(nestedSource, 0o444);

    const first = await stageRestrictedAppPackage(source, staged);
    const second = await stageRestrictedAppPackage(source, staged, first.digest);

    assert.equal(second.stagedRoot, first.stagedRoot);
    assert.equal(await readFile(join(first.stagedRoot, "assets", "nested", "content.txt"), "utf8"), "durable content\n");
    assert.deepEqual((await readdir(staged)).filter((name) => name.startsWith(".staging-")), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("verified App Release artifact entries stage through a private, content-addressed package boundary", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-release-package-"));
  const source = join(sandbox, "source");
  const staged = join(sandbox, "staged");
  try {
    await writePackage(source, "export {};\n");
    await mkdir(staged, { recursive: true });
    const inspection = await inspectRestrictedAppPackage(source);
    const entries = await encodeReleaseEntries(source, inspection.files);

    const receipt = await stageRestrictedAppReleaseArtifact(entries, inspection.artifactDigest, staged);

    assert.equal(receipt.artifactDigest, inspection.artifactDigest);
    assert.equal(receipt.digest, inspection.digest);
    assert.equal(receipt.manifest.id, "connected-inbox");
    assert.equal((await inspectRestrictedAppPackage(receipt.stagedRoot)).artifactDigest, inspection.artifactDigest);
    assert.deepEqual((await readdir(staged)).filter((name) => name.startsWith(".release-")), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("App Release artifact staging rejects unsafe or noncanonical input before installation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-release-package-invalid-"));
  const source = join(sandbox, "source");
  const staged = join(sandbox, "staged");
  try {
    await writePackage(source, "export {};\n");
    await mkdir(staged, { recursive: true });
    const inspection = await inspectRestrictedAppPackage(source);
    const entries = await encodeReleaseEntries(source, inspection.files);
    const mismatchedDigest = hashAppPlatformArtifact([{ path: "different.txt", bytes: Buffer.from("different") }]);

    await assert.rejects(
      stageRestrictedAppReleaseArtifact(
        entries.map((entry, index) => index === 0 ? { ...entry, path: "../package.json" } : entry),
        inspection.artifactDigest,
        staged,
      ),
      /portable relative package path/i,
    );
    for (const reservedPath of ["nested/.work-fold/private.json", "nested/.WORKSPACE/private.json", "nested/.Pi/private.json"]) {
      await assert.rejects(
        stageRestrictedAppReleaseArtifact(
          entries.map((entry, index) => index === 0 ? { ...entry, path: reservedPath } : entry),
          inspection.artifactDigest,
          staged,
        ),
        /portable relative package path/i,
      );
    }
    await assert.rejects(
      stageRestrictedAppReleaseArtifact([...entries, { ...entries[0]! }], inspection.artifactDigest, staged),
      /duplicated/i,
    );
    await assert.rejects(
      stageRestrictedAppReleaseArtifact(
        entries.map((entry, index) => index === 0 ? { ...entry, bytesBase64: "YR==" } : entry),
        inspection.artifactDigest,
        staged,
      ),
      /canonical RFC 4648 base64/i,
    );
    await assert.rejects(
      stageRestrictedAppReleaseArtifact(entries, mismatchedDigest, staged),
      /digest does not match/i,
    );

    const colliding = [...entries, { path: "PACKAGE.JSON", bytesBase64: entries.find((entry) => entry.path === "package.json")!.bytesBase64 }];
    await assert.rejects(
      stageRestrictedAppReleaseArtifact(colliding, digestReleaseEntries(colliding), staged),
      /collide on portable filesystems/i,
    );

    const directoryAlias: RestrictedAppReleaseArtifactEntry[] = [
      { path: "assets/first.js", bytesBase64: Buffer.from("first").toString("base64") },
      { path: "ASSETS/second.js", bytesBase64: Buffer.from("second").toString("base64") },
    ];
    await assert.rejects(
      stageRestrictedAppReleaseArtifact(directoryAlias, digestReleaseEntries(directoryAlias), staged),
      /collide on portable filesystems/i,
    );

    const ancestorConflict: RestrictedAppReleaseArtifactEntry[] = [
      { path: "asset", bytesBase64: Buffer.from("file").toString("base64") },
      { path: "asset/child.js", bytesBase64: Buffer.from("child").toString("base64") },
    ];
    await assert.rejects(
      stageRestrictedAppReleaseArtifact(ancestorConflict, digestReleaseEntries(ancestorConflict), staged),
      /conflicts with a file ancestor/i,
    );
    assert.deepEqual(await readdir(staged), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("App Release artifact staging re-inspects package and declaration policy and cleans temporary bytes", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-release-package-policy-"));
  const source = join(sandbox, "source");
  const staged = join(sandbox, "staged");
  try {
    await writePackage(source, "export {};\n", { scripts: { postinstall: "node setup.js" } });
    const files = ["agent-app.json", "app.js", "index.html", "package.json", "worker.js"];
    const entries = await encodeReleaseEntries(source, files);

    await assert.rejects(
      stageRestrictedAppReleaseArtifact(entries, digestReleaseEntries(entries), staged),
      /cannot declare scripts/i,
    );
    assert.deepEqual(await readdir(staged), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("checked-in restricted app example stays valid for the staged contract", async () => {
  const inspection = await inspectRestrictedAppPackage(join(process.cwd(), "examples", "packages", "restricted-connected-inbox"));
  assert.equal(inspection.manifest.id, "restricted-connected-inbox");
  assert.deepEqual(inspection.manifest.permissions.network[0]?.target, { kind: "public-https", origin: "https://mail.example.com" });
  assert.deepEqual(inspection.manifest.permissions.notifications, [{
    id: "inbox-refresh-finished",
    title: "Inbox refresh finished",
      description: "The inbox refresh automation finished. Open work-fold to review the connection result.",
  }]);
  assert.equal(inspection.manifest.runtime.entry, "index.html");
  assert.deepEqual(inspection.manifest.automations, [{
    id: "refresh-inbox",
    title: "Refresh inbox",
    description: "Check the connected inbox and save the latest connection result.",
    handler: "refresh-inbox",
    trigger: { kind: "interval", intervalMinutes: 30 },
    permissions: { network: ["mail-api"], files: [], notifications: ["inbox-refresh-finished"] },
    catchUp: "latest",
    overlap: "skip",
  }]);
});

test("checked-in example records failed automation network checks after requesting its static notification", async () => {
  type ExampleBridge = {
    request: () => Promise<never>;
    notifications: { show: (request: { permissionId: string }) => Promise<void> };
    storage: { set: (key: string, value: unknown) => Promise<void> };
  };
  const runtime = globalThis as typeof globalThis & { workFoldRestrictedApp?: ExampleBridge };
  const previousBridge = runtime.workFoldRestrictedApp;
  const operations: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  runtime.workFoldRestrictedApp = {
    request: async () => {
      operations.push("network");
      throw Object.assign(new Error("Network access is off."), { code: "NETWORK_DENIED" });
    },
    notifications: {
      show: async ({ permissionId }) => {
        operations.push(`notification:${permissionId}`);
      },
    },
    storage: {
      set: async (key, value) => {
        operations.push(`storage:${key}`);
        writes.push({ key, value });
      },
    },
  };

  try {
    const workerUrl = pathToFileURL(join(process.cwd(), "examples", "packages", "restricted-connected-inbox", "worker.js"));
    workerUrl.searchParams.set("test", String(Date.now()));
    const worker = await import(workerUrl.href) as { handleAutomation: (event: {
      runId: string;
      automationId: string;
      handler: string;
      reason: string;
      scheduledAt: string;
    }) => Promise<void> };
    await worker.handleAutomation({
      runId: "manual-test-run",
      automationId: "refresh-inbox",
      handler: "refresh-inbox",
      reason: "manual",
      scheduledAt: "2026-07-13T12:00:00.000Z",
    });

    assert.deepEqual(operations, ["network", "notification:inbox-refresh-finished", "storage:last-automation-refresh"]);
    assert.equal(writes.length, 1);
    assert.deepEqual((writes[0]?.value as { network: unknown }).network, { state: "unavailable", code: "NETWORK_DENIED" });
    assert.deepEqual((writes[0]?.value as { notification: unknown }).notification, { state: "requested" });
    assert.equal((writes[0]?.value as { reason: unknown }).reason, "manual");
    assert.match((writes[0]?.value as { completedAt: string }).completedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    if (previousBridge === undefined) delete runtime.workFoldRestrictedApp;
    else runtime.workFoldRestrictedApp = previousBridge;
  }
});

test("restricted app package preflight rejects native Pi and package-manager execution paths", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-fields-"));
  try {
    for (const [field, value] of [
      ["scripts", { postinstall: "node setup.js" }],
      ["pi", { extensions: ["app.js"] }],
      ["bin", { command: "app.js" }],
    ] as const) {
      const root = join(sandbox, field);
      await writePackage(root, "export {};\n", { [field]: value });
      await assert.rejects(inspectRestrictedAppPackage(root), new RegExp(`cannot declare ${field}`));
    }
    const dependencies = join(sandbox, "dependencies");
    await writePackage(dependencies, "export {};\n", { dependencies: { library: "1.0.0" } });
    assert.equal((await inspectRestrictedAppPackage(dependencies)).manifest.runtime.entry, "index.html");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("restricted app package preflight rejects missing entries and linked files", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-links-"));
  try {
    const missingEntry = join(sandbox, "missing-entry");
    await writePackage(missingEntry, "export {};\n");
    await rm(join(missingEntry, "index.html"));
    await assert.rejects(inspectRestrictedAppPackage(missingEntry), /entry does not exist/);

    const linked = join(sandbox, "linked");
    await writePackage(linked, "export {};\n");
    try {
      await symlink(join(linked, "worker.js"), join(linked, "linked.js"), "file");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EPERM" || code === "EACCES") {
        t.diagnostic("Symlink assertion skipped because this Windows host disallows file symlinks.");
        return;
      }
      throw error;
    }
    await assert.rejects(inspectRestrictedAppPackage(linked), /cannot contain links/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("restricted app package inspection rejects a file that grows after bounded enumeration", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-restricted-package-race-"));
  const root = join(sandbox, "source");
  try {
    await writePackage(root, "export {};\n");
    await assert.rejects(
      inspectRestrictedAppPackage(root, {
        afterCollection: async () => {
          await writeFile(join(root, "worker.js"), Buffer.alloc(restrictedAppPackageLimits.fileBytes + 1, 0x61));
        },
      }),
      /file changed after enumeration/i,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function writePackage(root: string, appSource: string, extraPackageFields: Record<string, unknown> = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "connected-inbox",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
    ...extraPackageFields,
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "connected-inbox",
    title: "Connected inbox",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [],
    automations: [{
      id: "refresh-inbox",
      title: "Refresh inbox",
      handler: "refresh-inbox",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: { network: ["inbox-api"], files: [], notifications: [] },
      catchUp: "latest",
      overlap: "skip",
    }],
    permissions: {
      network: [{
        id: "inbox-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET"],
        auth: [{
          kind: "oauth2-pkce",
          issuer: "https://identity.example.com",
          clientId: "work-fold-connected-inbox",
          scopes: ["mail.read"],
        }],
      }],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(join(root, "worker.js"), `${appSource}\nexport async function handleAutomation() {}\n`, "utf8");
}

async function encodeReleaseEntries(root: string, files: readonly string[]): Promise<RestrictedAppReleaseArtifactEntry[]> {
  return Promise.all(files.map(async (path) => ({
    path,
    bytesBase64: (await readFile(join(root, ...path.split("/")))).toString("base64"),
  })));
}

function digestReleaseEntries(entries: readonly RestrictedAppReleaseArtifactEntry[]) {
  return hashAppPlatformArtifact(entries.map((entry) => ({
    path: entry.path,
    bytes: Buffer.from(entry.bytesBase64, "base64"),
  })));
}

async function missing(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
