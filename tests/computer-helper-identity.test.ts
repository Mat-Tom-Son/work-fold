import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { verifyHelperExecutable } from "../node_modules/@injaneity/pi-computer-use/src/platform/macos/helper-identity.mjs";

const run = promisify(execFile);
test("quarantined helper relocation requires the complete current signed artifact and compatible protocol", { skip: process.platform !== "darwin", timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-helper-identity-"));
  const systemTemp = (await run("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"])).stdout.trim();
  const relocation = join(await realpath(systemTemp), "AppTranslocation", randomUUID());
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(relocation, { recursive: true, force: true }); });
  const expectedApp = join(root, "helper.app"), actualApp = join(relocation, "d", "helper.app");
  const expected = join(expectedApp, "Contents/MacOS/bridge"), actual = join(actualApp, "Contents/MacOS/bridge");
  await mkdir(join(expectedApp, "Contents/MacOS"), { recursive: true });
  await mkdir(join(expectedApp, "Contents/Resources"));
  await writeFile(join(root, "tiny.c"), "int main(void) { return 0; }\n");
  await run("/usr/bin/cc", [join(root, "tiny.c"), "-o", expected]);
  await writeFile(join(expectedApp, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.work-fold.helper-identity-test</string><key>CFBundleExecutable</key><string>bridge</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  await writeFile(join(expectedApp, "Contents/Resources/icon.txt"), "exact resource");
  await run("/usr/bin/codesign", ["--force", "--sign", "-", expectedApp]);
  const reset = async () => { await rm(actualApp, { force: true, recursive: true }); await cp(expectedApp, actualApp, { recursive: true }); };
  await reset();
  assert.equal(await verifyHelperExecutable(expected, expected), true);
  assert.equal(await verifyHelperExecutable(actual, expected), true, "an identical relocated and sealed artifact is accepted");
  const unrelated = join(root, "other", "helper.app");
  await cp(expectedApp, unrelated, { recursive: true });
  assert.equal(await verifyHelperExecutable(join(unrelated, "Contents/MacOS/bridge"), expected), false, "identical bytes outside the translocation location do not replace the expected helper");
  const fakeTemp = join(root, "fake-temp"), fakeApp = join(fakeTemp, "AppTranslocation", randomUUID(), "d", "helper.app");
  await cp(expectedApp, fakeApp, { recursive: true });
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = fakeTemp;
  try {
    assert.equal(await verifyHelperExecutable(join(fakeApp, "Contents/MacOS/bridge"), expected), false, "an environment-selected temp directory cannot imitate the OS location");
    assert.equal(await verifyHelperExecutable(actual, expected), true, "the actual OS location remains valid under a changed TMPDIR");
  } finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
  for (const filename of ["Contents/MacOS/bridge", "Contents/Info.plist", "Contents/Resources/icon.txt"]) {
    await writeFile(join(actualApp, filename), "modified artifact");
    assert.equal(await verifyHelperExecutable(actual, expected), false, `modified ${filename} fails`);
    await reset();
  }
  await symlink(join(root, "tiny.c"), join(actualApp, "Contents/Resources/link"));
  assert.equal(await verifyHelperExecutable(actual, expected), false, "bundle symlinks are rejected");
  await reset();
  await writeFile(join(actualApp, "Contents/Resources/extra"), "unsealed extra file");
  assert.equal(await verifyHelperExecutable(actual, expected), false, "extra files cannot ride along with the expected code");
  await reset();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(verifyHelperExecutable(actual, expected, aborted.signal), /abort/i);

  // Exercise both native protocol comparisons without launching a helper or
  // making a computer observation/action. Only the launch effect is replaced.
  process.env.PI_COMPUTER_USE_HELPER_APP_PATH = expectedApp;
  const { MacosHelperClient, macosHelper } = await import("../node_modules/@injaneity/pi-computer-use/src/platform/macos/helper.ts");
  class Client extends MacosHelperClient {
    restarts = 0; calls = 0;
    constructor(private readonly versions: number[]) { super(); }
    override async diagnosticsCommand() {
      return { protocolVersion: this.versions[Math.min(this.calls++, this.versions.length - 1)], architectureVersion: 1, invariants: [], pid: 1,
        parentPid: undefined, parentAppName: undefined, parentBundleId: undefined, parentPath: undefined,
        executablePath: actual, os: "test", arch: "arm64", accessibility: false, screenRecording: false };
    }
    override async restart() { this.restarts++; }
  }
  const compatible = new Client([7]); await compatible.ensureProtocol();
  assert.equal(compatible.restarts, 0, "a valid relocated helper is not needlessly restarted");
  await chmod(join(expectedApp, "Contents/Resources/icon.txt"), 0);
  await chmod(join(actualApp, "Contents/Resources/icon.txt"), 0);
  const inspectionFailure = new Client([7]);
  try {
    await assert.rejects(inspectionFailure.ensureProtocol(), /Unable to verify/);
    assert.equal(inspectionFailure.restarts, 0, "an operational inspection failure cannot restart a possibly busy helper");
  } finally {
    await chmod(join(expectedApp, "Contents/Resources/icon.txt"), 0o644);
    await chmod(join(actualApp, "Contents/Resources/icon.txt"), 0o644);
  }
  const recovered = new Client([1, 7]); await recovered.ensureProtocol();
  assert.equal(recovered.restarts, 1, "the after-relaunch comparison also accepts only the current artifact");
  const wrongProtocol = new Client([1]); await assert.rejects(wrongProtocol.ensureProtocol(), /mismatch after relaunch/);
  assert.equal(wrongProtocol.restarts, 1, "artifact identity never admits a wrong protocol");

  const originalCommand = macosHelper.daemonCommand;
  const originalRestart = macosHelper.restart;
  let probeCalls = 0, probeRestarts = 0;
  macosHelper.daemonCommand = async <T>(command: string): Promise<T> => {
    probeCalls++;
    return (command === "diagnostics" ? { protocolVersion: 7, executablePath: actual, pid: 1 }
      : { accessibility: true, screenRecordingCapturable: true, source: { attribution: "helper-app" } }) as T;
  };
  macosHelper.restart = async () => { probeRestarts++; };
  try {
    const { probeMacosComputerUse } = await import("../node_modules/@injaneity/pi-computer-use/src/platform/macos/permissions.ts");
    assert.equal((await probeMacosComputerUse({ launch: false })).status, "ready", "the separate readiness comparison accepts the same pinned relocation");
    assert.equal(probeCalls, 2); assert.equal(probeRestarts, 0);
  } finally { macosHelper.daemonCommand = originalCommand; macosHelper.restart = originalRestart; }

  await writeFile(join(expectedApp, "Contents/Resources/icon.txt"), "changed after signing");
  await reset();
  assert.equal(await readFile(join(actualApp, "Contents/Resources/icon.txt"), "utf8"), "changed after signing");
  assert.equal(await verifyHelperExecutable(actual, expected), false, "identical but invalidly signed copies fail");
});
