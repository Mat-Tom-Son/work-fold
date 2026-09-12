import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
for (const [path, marker] of [
  ["./fixtures/included-tools/chrome-native.mts", "PASS native Chrome"],
  ["./fixtures/included-tools/chrome-readiness.mts", "PASS Chrome readiness"],
  ["../node_modules/pi-chrome/test-suite/unit/embedded-host.test.mjs", "# fail 0"],
]) test(`included Chrome native boundary: ${path}`, { timeout: 45_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL(path, import.meta.url))], { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer); assert.equal(code, 0, output); assert.ok(output.includes(marker) || output.includes("ℹ fail 0"), output);
});
