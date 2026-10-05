import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { currentWindowsUserSid, ensurePrivateDirectory, windowsPrivateSids } from "../src/local/private-access.js";
import { ensurePrivateDirectory as ensureIncludedToolDirectory } from "../resources/included-tools/private-directory.js";
import { readWindowsAccess } from "./support/windows-acl.js";

test("private directories are owner-only on POSIX", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const ensure of [ensurePrivateDirectory, ensureIncludedToolDirectory]) {
    const directory = join(root, ensure === ensurePrivateDirectory ? "local" : "included", "secret");
    await ensure(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
});

test("Windows private directories replace an inherited ACL with this user, SYSTEM and Administrators", { skip: process.platform !== "win32", timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = await currentWindowsUserSid();
  const expected = [user, windowsPrivateSids.system, windowsPrivateSids.administrators].sort();
  // An inherited grant to another principal, as a shared or sandbox-tooled profile can carry.
  const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  await promisify(execFile)(icacls, [root, "/grant", "*S-1-5-32-545:(OI)(CI)(R)"], { windowsHide: true });
  const directory = join(root, "secret");
  await mkdir(directory);
  await writeFile(join(directory, "existing.json"), "{}");
  assert.ok((await readWindowsAccess(join(directory, "existing.json"))).allowed.includes("S-1-5-32-545"), "the fixture starts readable by Users");
  await ensurePrivateDirectory(directory);
  await writeFile(join(directory, "token.json"), "{}");
  for (const path of [directory, join(directory, "existing.json"), join(directory, "token.json")]) {
    const access = await readWindowsAccess(path);
    assert.deepEqual(access.allowed.sort(), expected, path);
    assert.equal(access.owner, user);
  }
  assert.equal((await readWindowsAccess(directory)).protected, true);
  // A directory removed and recreated in the same process is hardened again.
  await rm(directory, { recursive: true });
  await ensurePrivateDirectory(directory);
  assert.deepEqual((await readWindowsAccess(directory)).allowed.sort(), expected);
  const included = join(root, "included-tool");
  await ensureIncludedToolDirectory(included);
  assert.deepEqual(await readWindowsAccess(included), await readWindowsAccess(directory), "included tools apply the identical ACL");
});
