import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const [fixture, marker] of [
  ["mcp-setup-native.mts", "ALL MCP SETUP CHECKS PASSED"],
  ["mcp-native.mts", "ALL NATIVE MCP CHECKS PASSED"],
  ["web-native.mts", "ALL NATIVE WEB CHECKS PASSED"],
  ["web-failures.mts", "PASS"],
]) {
  test(`included native toolkit: ${fixture}`, { timeout: 120_000 }, async () => {
    // Each process owns a disposable Pi root, servers, and synthetic keys.
    // Fixtures use actual native loaders/AgentSessions, never personal resources.
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL(`./fixtures/included-tools/${fixture}`, import.meta.url))], {
        cwd: root,
        env: { ...process.env, PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory", PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 110_000);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(marker), result.output);
  });
}
