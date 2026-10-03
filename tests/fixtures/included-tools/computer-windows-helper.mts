import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The helper module reads its host configuration once, at import.
process.env.PI_COMPUTER_USE_NO_RUNTIME_INSTALL = "1";
process.env.PI_COMPUTER_USE_HOST_OWNED_HELPER = "1";
const helper = await import("@injaneity/pi-computer-use/src/platform/windows/helper.ts");
const { windowsBackend } = await import("@injaneity/pi-computer-use/src/platform/windows/backend.ts");

const root = await mkdtemp(join(tmpdir(), "workfold-windows-helper-"));
const fake = join(root, "fake-helper.cjs");
const started = join(root, "started.log");
// A stand-in for the Rust helper's JSON-lines protocol with scriptable timing.
await writeFile(fake, `
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(started)}, "start\\n");
process.stderr.write("x".repeat(256 * 1024)); // Never drained, this would block the pipe.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let index; (index = buffer.indexOf("\\n")) >= 0;) {
    const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const reply = (result) => process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result }) + "\\n");
    if (request.cmd === "exit") process.exit(3);
    setTimeout(() => reply({ cmd: request.cmd, protocolVersion: 4 }), request.args?.delayMs ?? 0);
  }
});
process.stdin.on("end", () => process.exit(0));
`);
const starts = async () => existsSync(started) ? (await import("node:fs/promises")).readFile(started, "utf8").then(text => text.split("\n").filter(Boolean).length) : 0;
const client = () => new helper.WindowsHelperClient({ path: process.execPath, args: [fake] });
const elapsed = async (run: () => Promise<unknown>) => { const start = Date.now(); await run(); return Date.now() - start; };
const clients: InstanceType<typeof helper.WindowsHelperClient>[] = [];
try {
  // A launch-free inspection never starts a helper.
  const idle = client(); clients.push(idle);
  await assert.rejects(() => idle.command("diagnostics", {}, { launch: false }), /not running/);
  assert.equal(idle.running, false);
  assert.equal(await starts(), 0, "a launch-free inspection starts no process");

  // The first real command starts one helper; stderr is drained so it never blocks.
  const live = client(); clients.push(live);
  assert.equal((await live.command<any>("diagnostics", {}, { timeoutMs: 5_000 })).cmd, "diagnostics");
  assert.equal(live.running, true);
  assert.equal((await live.command<any>("diagnostics", {}, { launch: false })).cmd, "diagnostics", "a live helper answers launch-free inspections");

  // A cancelled read is abandoned at once; its late reply is ignored.
  const readAbort = new AbortController();
  setTimeout(() => readAbort.abort(), 50);
  assert.ok(await elapsed(() => assert.rejects(() => live.command("look", { delayMs: 600 }, { signal: readAbort.signal }), /aborted/)) < 450, "a read does not wait for its abandoned reply");

  // A cancelled effect keeps its slot until the helper answers, then is uncertain.
  const effectAbort = new AbortController();
  setTimeout(() => effectAbort.abort(), 50);
  let effectError: any;
  const effectWait = await elapsed(async () => { try { await live.command("act", { delayMs: 500 }, { signal: effectAbort.signal }); } catch (error) { effectError = error; } });
  assert.equal(effectError?.code, "interrupted_unknown");
  assert.match(effectError.message, /outcome is uncertain/);
  assert.ok(effectWait >= 400, `an effect releases only after the helper finished (${effectWait}ms)`);

  // An effect whose reply never comes is released after a bounded settle window.
  const stuck = new AbortController();
  setTimeout(() => stuck.abort(), 20);
  let stuckError: any;
  const stuckWait = await elapsed(async () => { try { await live.command("actBatch", { delayMs: 10_000 }, { signal: stuck.signal }); } catch (error) { stuckError = error; } });
  assert.equal(stuckError?.code, "interrupted_unknown");
  assert.ok(stuckWait >= 1_800 && stuckWait < 4_000, `the settle window is bounded (${stuckWait}ms)`);

  // A timed-out read fails plainly and is never retried.
  await assert.rejects(() => live.command("look", { delayMs: 2_000 }, { timeoutMs: 100 }), /timed out/);
  assert.equal((await live.command<any>("diagnostics")).cmd, "diagnostics", "the shared helper survives abandoned requests");

  // Losing the helper fails a pending effect as uncertain and a read plainly.
  const pendingEffect = live.command("focusWindow", { delayMs: 5_000 }).catch(error => error);
  const pendingRead = live.command("look", { delayMs: 5_000 }).catch(error => error);
  await live.command("exit").catch(() => undefined);
  assert.equal((await pendingEffect)?.code, "interrupted_unknown");
  assert.match((await pendingRead)?.message, /exited/);
  assert.equal(live.running, false);

  // Host disposal is uncertain for dispatched effects too.
  const disposed = client(); clients.push(disposed);
  await disposed.command("diagnostics");
  const inFlight = disposed.command("act", { delayMs: 5_000 }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 50));
  disposed.dispose();
  assert.equal((await inFlight)?.code, "interrupted_unknown");

  // A host-owned helper is never installed at runtime or stopped by one session.
  const missing = new helper.WindowsHelperClient({ path: join(root, "missing.exe") });
  const before = await starts();
  await assert.rejects(() => missing.command("diagnostics"), /runtime installation is disabled/);
  assert.equal(await starts(), before, "no setup process runs for a host-owned helper");
  assert.equal(helper.WINDOWS_HELPER_HOST_OWNED, true);
  const shared = helper.windowsHelper as any;
  let disposals = 0;
  const original = shared.dispose;
  shared.dispose = () => { disposals++; };
  try { windowsBackend.shutdown?.(); } finally { shared.dispose = original; }
  assert.equal(disposals, 0, "ending one session leaves the host-owned helper for its peers");

  // The reviewed helper built from source answers the same protocol (read-only).
  const built = fileURLToPath(new URL("../../../out/included-tools/computer-helper/work-fold Computer/work-fold Computer.exe", import.meta.url));
  if (process.platform === "win32" && existsSync(built)) {
    const real = new helper.WindowsHelperClient({ path: built }); clients.push(real);
    const diagnostics = await real.command<any>("diagnostics", {}, { timeoutMs: 10_000 });
    assert.equal(diagnostics.protocolVersion, helper.WINDOWS_HELPER_PROTOCOL_VERSION);
    assert.equal(diagnostics.architectureVersion, 1);
    console.log("PASS built Windows helper diagnostics");
  }
  console.log("PASS windows helper client: launch-free inspection, drained stderr, abandoned reads, held and uncertain effects, bounded settle, crash and disposal, host ownership");
} finally {
  for (const item of clients) item.dispose();
  await rm(root, { recursive: true, force: true });
}
