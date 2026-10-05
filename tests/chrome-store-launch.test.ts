import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openChromeStore } from "../desktop/src/chrome-native-host.js";
import { IncludedChromeConnectionService, type ChromeDistribution } from "../src/local/agent/included-chrome-connection.js";

test("a newly launched Linux Chrome process cannot hold connection setup until browser exit", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "workfold-chrome-launch-"));
  const browser = join(root, "google-chrome"), record = join(root, "browser.json");
  const originalPath = process.env.PATH;
  // A real long-lived process reproduces launching Chrome when it was closed.
  // The usual already-running-browser handoff exits immediately and hid this bug.
  await writeFile(browser, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)})); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  const distribution: ChromeDistribution = { version: 1, storeId: "a".repeat(32), nativeHostName: "com.work_fold.chrome_test", bootstrapVersion: 1, extensionVersion: "1.0.1", bridge: { major: 3, minor: 0, capabilities: ["profile-binding"] } };
  const service = await IncludedChromeConnectionService.create({
    stateRoot: join(root, "state"), distribution,
    registerNativeHost: async () => {}, openStore: () => openChromeStore(distribution.storeId, "linux"),
    startTransport: async () => ({ close() {} }), probe: async () => {},
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let child: { pid: number; args: string[] } | undefined;
  try {
    const preparing = service.prepare();
    for (let attempt = 0; attempt < 100; attempt++) {
      try { child = JSON.parse(await readFile(record, "utf8")); break; } catch { await delay(20); }
    }
    assert.ok(child, "The browser fixture must actually start");
    assert.deepEqual(child.args, [`https://chromewebstore.google.com/detail/${distribution.storeId}`]);
    const connected = preparing.then(() => service.bootstrap(`chrome-extension://${distribution.storeId}/`, {
      version: 1, action: "connect", requestId: randomUUID(), clientId: randomUUID(),
      clientProof: randomBytes(32).toString("hex"), extensionVersion: "1.0.1", bridge: distribution.bridge,
    }));
    const result = await Promise.race([connected, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Chrome setup waited for browser exit")), 2000);
    })]);
    assert.equal(result.state, "lease_ready");
    process.kill(child.pid, 0); // Connection completed while the browser stayed open.
  } finally {
    clearTimeout(timeout);
    if (child) process.kill(child.pid, "SIGTERM");
    process.env.PATH = originalPath;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Store identity is rejected before launching Chrome", async () => {
  await assert.rejects(openChromeStore("../other", "linux"), /not available/);
});
