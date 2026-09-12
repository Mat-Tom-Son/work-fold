import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { startLocalApi } from "../src/local/server.js";
import { WorkFoldRequestStore } from "../src/local/requests/request-store.js";

test("API close drains startup retention even when management cannot initialize", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-retention-close-"));
  const stateBase = join(root, "state");
  await mkdir(stateBase); await writeFile(join(stateBase, "management"), "not a directory");
  const original = WorkFoldRequestStore.prototype.purgeExpiredIfDue;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = false, purgeFinished = false;
  WorkFoldRequestStore.prototype.purgeExpiredIfDue = async function (intervalMs) {
    started = true;
    await held;
    const result = await original.call(this, intervalMs);
    purgeFinished = true;
    return result;
  };
  let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  let closing: Promise<void> | undefined;
  try {
    api = await startLocalApi({ port: 0, stateBase, spaceBase: join(root, "content"), loadEnv: false,
      piRuntimeProvider: { resolveRuntime: async () => ({ agentDir: join(root, "pi") }) },
    });
    assert.equal(started, true, "startup schedules retention without delaying API availability");
    await assert.rejects(api.actFacade.manageList(), /required instructions/);
    let closed = false;
    closing = api.close().then(() => { closed = true; });
    // Reach the end of ordinary API shutdown without guessing how long its
    // other services need. The held retention operation is the only work left.
    await until(async () => !await listening(api!.port));
    await setImmediate();
    assert.equal(closed, false, "close must not release state while its startup purge can still write");
    assert.equal(purgeFinished, false);
    release(); await closing;
    assert.equal(purgeFinished, true);
    const settings = JSON.parse(await readFile(join(stateBase, "requests", "settings.json"), "utf8"));
    assert.equal(typeof settings.lastPurgeAt, "string", "close includes the real retention commit, not just the wrapper");
    await rm(stateBase, { recursive: true, force: true });
    await setImmediate();
    await assert.rejects(readFile(join(stateBase, "requests", "settings.json")), { code: "ENOENT" });
  } finally {
    release();
    if (closing) await closing;
    else await api?.close();
    WorkFoldRequestStore.prototype.purgeExpiredIfDue = original;
    await rm(root, { recursive: true, force: true });
  }
});

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}
async function until(predicate: () => Promise<boolean>) {
  for (let count = 0; count < 1000; count++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("API listener did not close.");
}
