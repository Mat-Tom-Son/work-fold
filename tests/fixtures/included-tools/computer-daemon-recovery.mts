import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

// Real IPC, with the OS launch effect replaced by a disposable helper server.
// No installed helper, desktop permissions, or personal socket is touched.
const directory = await mkdtemp("/tmp/workfold-cu-recovery-");
const socketPath = join(directory, "helper.sock");
process.env.PI_COMPUTER_USE_OWNED_SOCKET_PATH = socketPath;
delete process.env.PI_CU_SOCKET_PATH;
const { MacosHelperClient } = await import("../../../node_modules/@injaneity/pi-computer-use/src/platform/macos/helper.ts");
const sockets = new Set<net.Socket>();
const completed: string[] = [];
let server: net.Server | undefined;
let mode: "normal" | "hold-diagnostics" | "drop-action" | "reject-diagnostics" = "normal";
let diagnostics = 0, effects = 0, launches = 0;
let diagnosticStarted: (() => void) | undefined;

async function start() {
  assert.equal(server, undefined);
  server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk); const index = buffer.indexOf("\n"); if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index)); buffer = "";
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      if (request.cmd === "diagnostics") {
        diagnostics++;
        diagnosticStarted?.();
        if (mode === "hold-diagnostics") return;
        if (mode === "reject-diagnostics") { socket.end(`${JSON.stringify({ id: request.id, ok: false, error: { code: "unavailable", message: "Helper diagnostics failed" } })}\n`); return; }
        answer({ protocolVersion: 7, recentCompletedRequestIds: completed }); return;
      }
      assert.equal(request.cmd, "act"); effects++;
      if (mode === "drop-action") { completed.push(request.id); socket.destroy(); return; }
      answer({ performed: effects });
    });
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socketPath, resolve); });
}
async function stop() {
  const previous = server; server = undefined;
  for (const socket of sockets) socket.destroy();
  if (previous) await new Promise<void>((resolve, reject) => previous.close((error) => error ? reject(error) : resolve()));
  await rm(socketPath, { force: true });
}
class FixtureClient extends MacosHelperClient {
  override async launchDaemon(signal?: AbortSignal) {
    signal?.throwIfAborted(); launches++; await start();
  }
}
const client = new FixtureClient();
try {
  await start();
  await client.command("diagnostics");
  assert.equal(launches, 0);
  await stop(); // macOS Quit & Reopen killed the cached helper and its socket.
  const recovered = await client.command<{ protocolVersion: number }>("diagnostics");
  assert.equal(recovered.protocolVersion, 7, "the first Check after helper disappearance must recover");
  assert.equal(launches, 1); assert.equal(effects, 0);

  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  const beforeCancelled = diagnostics;
  await assert.rejects(client.command("act", {}, { signal: alreadyCancelled.signal }), /abort/i);
  assert.equal(diagnostics, beforeCancelled); assert.equal(launches, 1); assert.equal(effects, 0);

  mode = "hold-diagnostics";
  const abort = new AbortController();
  const entered = new Promise<void>((resolve) => { diagnosticStarted = resolve; });
  const stopped = client.command("act", {}, { signal: abort.signal });
  await entered; abort.abort();
  await assert.rejects(stopped, /abort/i);
  diagnosticStarted = undefined;
  assert.equal(launches, 1, "canceling the liveness check must not launch a replacement");
  assert.equal(effects, 0, "canceling before dispatch must not send an action");

  mode = "reject-diagnostics";
  await assert.rejects(client.command("act"), /Helper diagnostics failed/);
  assert.equal(launches, 1, "a responding helper's command failure is not a dead daemon");
  assert.equal(effects, 0);

  mode = "normal";
  await client.command("act"); assert.equal(effects, 1);
  mode = "drop-action";
  await assert.rejects(client.command("act"), (error: any) => error.code === "interrupted_unknown" && /uncertain/.test(error.message));
  assert.equal(effects, 2, "an effect followed by transport loss must not be replayed");
  assert.equal(launches, 1, "post-dispatch failure never triggers automatic recovery/replay");
  console.log("PASS stale daemon relaunch, bounded preflight, abort before dispatch, no effect replay");
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
