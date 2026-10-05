import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildChromeNativeHost, buildWindowsChromeNativeHost } from "../scripts/build-chrome-native-host.mjs";
import { ensurePrivateDirectory } from "../src/local/private-access.js";
import { peContentSha256 } from "../desktop/src/pe-image.js";
import { simulateSignature, syntheticPe } from "./support/pe.js";
import { ChromeNativeHostRegistration } from "../desktop/src/chrome-native-host.js";

const distribution = { version: 1, storeId: "a".repeat(32), nativeHostName: "com.work_fold.chrome_test", bootstrapVersion: 1, extensionVersion: "1.0.0", bridge: { major: 3, minor: 0, capabilities: ["cancellation", "hard-background", "profile-binding"] } };
const origin = `chrome-extension://${distribution.storeId}/`;
function frame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]);
}
async function invoke(binary: string, bytes: Buffer, caller = origin, extra: string[] = []) {
  const child = spawn(binary, [caller, ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => errors.push(bytes));
  child.stdin.on("error", () => {});
  child.stdin.write(bytes.subarray(0, 2)); child.stdin.end(bytes.subarray(2));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Native bootstrap did not finish")); }, 12_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Native bootstrap exited ${code}`)); });
  });
  assert.equal(Buffer.concat(errors).toString(), "", "bootstrap must not log protocol data");
  const reply = Buffer.concat(output); assert.ok(reply.length > 4);
  assert.equal(reply.readUInt32LE(), reply.length - 4, "stdout contains exactly one framed response");
  return JSON.parse(reply.subarray(4).toString());
}

test("signed-lane Swift bootstrap rejects malformed input and forwards only its bounded private launch descriptor", { skip: process.platform !== "darwin", timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-native-chrome-frame-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "native");
  await buildChromeNativeHost({ destination, distribution });
  const binary = join(destination, "work-fold-chrome-host");
  const request = { version: 1, action: "status", clientId: "synthetic-client-id", requestId: "synthetic-request-id", extensionVersion: "1.0.0", bridge: distribution.bridge };
  assert.equal((await invoke(binary, frame(request))).status.state, "app_not_running");
  assert.equal((await invoke(binary, frame(request), "chrome-extension://" + "b".repeat(32) + "/")).status.state, "connection_error");
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(16 * 1024 + 1);
  for (const bytes of [Buffer.from([1, 0]), oversized, frame(request).subarray(0, 8), frame(null)]) assert.equal((await invoke(binary, bytes)).status.state, "connection_error");
  const bootstrapToken = randomBytes(32).toString("hex");
  const launchId = "3316d9e5-fd3f-40db-906b-708f3cd69a66";
  let requests = 0;
  const peer = createServer(async (incoming, response) => {
    requests++;
    assert.equal(incoming.headers.authorization, `Bearer ${bootstrapToken}`);
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { version: 1, launchId, extensionOrigin: origin, request });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ version: 1, state: "status", status: { state: "not_connected", checkedAt: new Date().toISOString() } }));
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
  t.after(() => { peer.closeAllConnections(); return new Promise<void>(resolve => peer.close(() => resolve())); });
  const address = peer.address(); assert.ok(address && typeof address !== "string");
  const descriptor = { version: 1, launchId, bootstrapToken, endpoint: `http://127.0.0.1:${address.port}/bootstrap` };
  const descriptorPath = join(destination, "launch.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  assert.equal((await invoke(binary, frame(request))).status.state, "not_connected"); assert.equal(requests, 1);
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, endpoint: "https://example.invalid/bootstrap" }));
  assert.equal((await invoke(binary, frame(request))).status.state, "app_not_running"); assert.equal(requests, 1);
});

test("Windows Rust bootstrap admits Chrome's window argument and forwards only an owner-only launch descriptor", { skip: process.platform !== "win32", timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-native-chrome-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "native");
  // A separate target keeps the test origin from rebuilding the product host.
  await buildWindowsChromeNativeHost({ destination, distribution, targetDirectory: fileURLToPath(new URL("../out/test-chrome-host-cargo", import.meta.url)) });
  await ensurePrivateDirectory(destination);
  const binary = join(destination, "work-fold-chrome-host.exe");
  const window = ["--parent-window=4242"];
  const request = { version: 1, action: "status", clientId: "synthetic-client-id", requestId: "synthetic-request-id", extensionVersion: "1.0.0", bridge: distribution.bridge };
  assert.equal((await invoke(binary, frame(request), origin, window)).status.state, "app_not_running");
  assert.equal((await invoke(binary, frame(request), "chrome-extension://" + "b".repeat(32) + "/", window)).status.state, "connection_error");
  for (const extra of [["--parent-window="], ["--parent-window=12x"], ["--other=1"], [...window, "extra"]]) {
    assert.equal((await invoke(binary, frame(request), origin, extra)).status.state, "connection_error", extra.join(" "));
  }
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(16 * 1024 + 1);
  for (const bytes of [Buffer.from([1, 0]), oversized, frame(request).subarray(0, 8), frame(null)]) assert.equal((await invoke(binary, bytes, origin, window)).status.state, "connection_error");
  const bootstrapToken = randomBytes(32).toString("hex");
  const launchId = "3316d9e5-fd3f-40db-906b-708f3cd69a66";
  let requests = 0;
  const peer = createServer(async (incoming, response) => {
    requests++;
    assert.equal(incoming.headers.authorization, `Bearer ${bootstrapToken}`);
    assert.equal(incoming.headers.origin, undefined, "the bootstrap never presents a web origin");
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { version: 1, launchId, extensionOrigin: origin, request });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ version: 1, state: "status", status: { state: "not_connected", checkedAt: new Date().toISOString() } }));
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
  t.after(() => { peer.closeAllConnections(); return new Promise<void>(resolve => peer.close(() => resolve())); });
  const address = peer.address(); assert.ok(address && typeof address !== "string");
  const descriptor = { version: 1, launchId, bootstrapToken, endpoint: `http://127.0.0.1:${address.port}/bootstrap` };
  const descriptorPath = join(destination, "launch.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  assert.equal((await invoke(binary, frame(request), origin, window)).status.state, "not_connected"); assert.equal(requests, 1);
  assert.equal((await invoke(binary, frame(request))).status.state, "not_connected", "the macOS-style two-argument call is accepted too"); assert.equal(requests, 2);
  // Readable by another principal: refused before any request, like mode & 0o077 on macOS.
  const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  await promisify(execFile)(icacls, [descriptorPath, "/grant", "*S-1-5-32-545:(R)"], { windowsHide: true });
  assert.equal((await invoke(binary, frame(request), origin, window)).status.state, "app_not_running"); assert.equal(requests, 2);
  await rm(descriptorPath); await writeFile(descriptorPath, JSON.stringify(descriptor));
  // A second name for the same bytes is not a private descriptor.
  await link(descriptorPath, join(destination, "alias.json"));
  assert.equal((await invoke(binary, frame(request), origin, window)).status.state, "app_not_running"); assert.equal(requests, 2);
  await rm(join(destination, "alias.json"));
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, endpoint: "https://example.invalid/bootstrap" }));
  assert.equal((await invoke(binary, frame(request), origin, window)).status.state, "app_not_running"); assert.equal(requests, 2);
  // Open work-fold starts only an absolute work-fold.exe named by the private app record.
  const openApp = frame({ version: 1, action: "open-app" });
  assert.equal((await invoke(binary, openApp, origin, window)).status.state, "app_not_running", "no app record");
  const stand_in = join(root, "Programs", "work-fold.exe");
  await mkdir(join(root, "Programs"));
  await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), stand_in);
  await writeFile(join(destination, "app.json"), JSON.stringify({ version: 1, executable: join(root, "Programs", "other.exe") }));
  assert.equal((await invoke(binary, openApp, origin, window)).status.state, "app_not_running", "only work-fold.exe is started");
  await writeFile(join(destination, "app.json"), JSON.stringify({ version: 1, executable: stand_in }));
  assert.equal((await invoke(binary, openApp, origin, window)).status.state, "connecting");
});

test("Chrome native registration preserves exact origin, stable copied binaries and ownership on repair", async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-chrome-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "app-resources"), stateRoot = join(root, "state"), chromeUserDataRoot = join(root, "isolated-chrome");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "work-fold-chrome-host"), "synthetic binary v1");
  await writeFile(join(sourceDirectory, "source.json"), JSON.stringify({ schema: "work-fold.chrome-native-host-source.v1", origin, nativeHostName: distribution.nativeHostName, bootstrapVersion: 1 }));
  const options = { sourceDirectory, stateRoot, chromeUserDataRoot, distribution, enabled: true, verifySignature: false, platform: "darwin" as const };
  const registration = new ChromeNativeHostRegistration(options);
  const manifestPath = join(chromeUserDataRoot, "NativeMessagingHosts", `${distribution.nativeHostName}.json`);
  await assert.rejects(() => new ChromeNativeHostRegistration({ ...options, enabled: false }).register(true), /installed work-fold/);
  await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
  await registration.register(true);
  const first = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(first.allowed_origins, [origin]); assert.equal(first.type, "stdio");
  assert.ok(first.path.startsWith(join(stateRoot, "chrome/native-host/work-fold-chrome-host-")));
  await writeFile(join(sourceDirectory, "work-fold-chrome-host"), "synthetic binary v2");
  await registration.register(false);
  const second = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.notEqual(second.path, first.path); assert.equal(await readFile(first.path, "utf8"), "synthetic binary v1");
  await writeFile(manifestPath, JSON.stringify({ ...second, path: "/another-installation/native-host" }));
  await assert.rejects(() => registration.register(false), /Another work-fold installation/);
  await registration.register(true);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).path, second.path);
  await writeFile(second.path, "altered copied bootstrap");
  await assert.rejects(() => registration.register(false), /bootstrap has changed/);
  await registration.register(true);
  assert.equal(await readFile(second.path, "utf8"), "synthetic binary v2", "explicit repair installs the exact verified source");
  await rm(manifestPath);
  await assert.rejects(() => registration.register(false), /registration was removed/);
  await registration.register(true);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).path, second.path);
});

test("Windows Chrome registration names a private manifest through HKCU and keeps the same ownership rules", async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-chrome-registration-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "app-resources"), stateRoot = join(root, "state");
  await mkdir(sourceDirectory);
  const host = join(sourceDirectory, "work-fold-chrome-host.exe");
  const provenance = (bytes: Buffer) => writeFile(join(sourceDirectory, "source.json"), JSON.stringify({ schema: "work-fold.chrome-native-host-source.v1", origin, nativeHostName: distribution.nativeHostName, bootstrapVersion: 1, executableContentSha256: peContentSha256(bytes) }));
  const v1 = syntheticPe("synthetic binary v1"), v2 = syntheticPe("synthetic binary v2");
  await writeFile(host, v1); await provenance(v1);
  let value: string | undefined;
  const writes: string[] = [];
  const registry = { read: async () => value, write: async (path: string) => { writes.push(path); value = path; } };
  const appExecutable = join(root, "Programs", "work-fold", "work-fold.exe");
  const options = { sourceDirectory, stateRoot, distribution, enabled: true, platform: "win32" as const, registry, appExecutable };
  const registration = new ChromeNativeHostRegistration(options);
  const manifestPath = join(stateRoot, "chrome", "native-host", `${distribution.nativeHostName}.json`);
  await assert.rejects(() => registration.register(false), /registration was removed/, "startup never creates a registration");
  assert.deepEqual(writes, []);
  await registration.register(true);
  assert.deepEqual(writes, [manifestPath], "the HKCU value names work-fold's own private manifest");
  const first = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(first.allowed_origins, [origin]); assert.equal(first.type, "stdio");
  assert.match(first.path, /work-fold-chrome-host-[a-f0-9]{24}\.exe$/);
  assert.deepEqual(await readFile(first.path), v1);
  assert.deepEqual(JSON.parse(await readFile(join(stateRoot, "chrome", "native-host", "app.json"), "utf8")), { version: 1, executable: appExecutable });
  await registration.register(false);
  await writeFile(host, syntheticPe("tampered"));
  await assert.rejects(() => registration.register(true), /reviewed build/, "the shipped bootstrap must match its build record");
  await writeFile(host, simulateSignature(v2)); await provenance(v2);
  await registration.register(false);
  const second = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.notEqual(second.path, first.path); assert.deepEqual(await readFile(first.path), v1);
  assert.deepEqual(await readFile(second.path), simulateSignature(v2), "a signed release of the recorded build is admitted and copied exactly");
  value = join(root, "another-installation", `${distribution.nativeHostName}.json`);
  await mkdir(join(root, "another-installation"));
  await writeFile(value, JSON.stringify({ ...second, path: join(root, "another-installation", "host.exe") }));
  await assert.rejects(() => registration.register(false), /Another work-fold installation/, "another profile's HKCU registration is never taken over automatically");
  await registration.register(true);
  assert.equal(value, manifestPath, "an explicit Connect chooses this installation");
  value = undefined;
  await assert.rejects(() => registration.register(false), /registration was removed/);
  await assert.rejects(() => new ChromeNativeHostRegistration({ ...options, appExecutable: undefined }).register(true), /installed work-fold app/);
});
