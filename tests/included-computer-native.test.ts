import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const [name, path, marker] of [
  ["native session ownership and quiet startup", "./fixtures/included-tools/computer-native.mts", "PASS computer wrapper"],
  ["unsupported hosts never enter native setup", "./fixtures/included-tools/computer-unsupported.mts", "PASS computer wrapper"],
  ["observation, output and scheduler isolation", "../node_modules/@injaneity/pi-computer-use/scripts/check-embedded.mjs", "PASS embedded"],
  ["stale daemon recovery before dispatch and no action replay", "./fixtures/included-tools/computer-daemon-recovery.mts", "PASS stale daemon relaunch"],
  ["native transport cancellation and uncertain outcomes", "../node_modules/@injaneity/pi-computer-use/scripts/check-helper-cancellation.mjs", "PASS cancelled-before-dispatch"],
]) test(`included computer: ${name}`, { timeout: 45_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL(path, import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.ok(output.includes(marker), output);
});

test("included computer: native peer closure and human takeover guard", { skip: process.platform !== "darwin", timeout: 45_000 }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const scratch = await mkdtemp(join(tmpdir(), "workfold-computer-lifecycle-"));
  try {
    const source = fileURLToPath(new URL("../node_modules/@injaneity/pi-computer-use/native/macos/", import.meta.url));
    const executable = join(scratch, "request-lifecycle-tests");
    await exec("xcrun", ["swiftc", "-O", "-framework", "ApplicationServices", join(source, "request_lifecycle.swift"), join(source, "request_lifecycle_tests.swift"), "-o", executable], { timeout: 35_000 });
    const result = await exec(executable, [], { timeout: 5_000 });
    assert.match(result.stdout, /PASS closed-peer cancellation and human generation withdrawal/);
  } finally { await rm(scratch, { force: true, recursive: true }); }
});
