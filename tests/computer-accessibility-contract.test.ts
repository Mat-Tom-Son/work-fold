import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Mac accessibility dispatches once, refuses changed identities and retains incomplete reads", { skip: process.platform !== "darwin", timeout: 45_000 }, async () => {
  const exec = promisify(execFile);
  const scratch = await mkdtemp(join(tmpdir(), "workfold-computer-contract-"));
  try {
    const source = fileURLToPath(new URL("../node_modules/@injaneity/pi-computer-use/native/macos/", import.meta.url));
    const executable = join(scratch, "accessibility-tests");
    await exec("xcrun", ["swiftc", "-O", "-framework", "ApplicationServices",
      join(source, "accessibility_contract.swift"), join(source, "accessibility_contract_tests.swift"), "-o", executable], { timeout: 35_000 });
    const result = await exec(executable, [], { timeout: 5_000 });
    assert.match(result.stdout, /PASS accessibility dispatch, retained identity and incomplete-tree contracts/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
