import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { secureStorageAvailable } from "../desktop/src/secure-storage.js";

const run = promisify(execFile);
const cli = resolve("out/included-tools/linux-cli/work-fold-cli");
const chrome = resolve("out/included-tools/chrome-native-host/work-fold-chrome-host");
const native = process.platform === "linux" && existsSync(cli) && existsSync(chrome);

test("Linux credentials require an actual keyring and retain other platform behavior", () => {
  for (const backend of ["basic_text", "unknown", ""]) assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, "linux"), false);
  for (const backend of ["gnome_libsecret", "kwallet5", "kwallet6"]) assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, "linux"), true);
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "gnome_libsecret" }, "linux"), false);
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => { throw new Error("Linux only"); } }, "darwin"), true);
});

test("native Linux CLI preserves read/act lanes, payloads, waiting, and response identity", { skip: !native }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-linux-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "profile"); const app = join(root, "fake-app");
  await mkdir(join(state, "cli"), { recursive: true });
  await writeFile(app, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const id = process.argv[3], root = path.join(process.env.WORKFOLD_CLI_STATE_DIR, 'cli');
const request = JSON.parse(fs.readFileSync(path.join(root, 'requests', id + '.json')));
fs.writeFileSync(path.join(root, 'last.json'), JSON.stringify(request));
const data = request.argv.includes('status') ? {task:{state:'running'},requestGraph:{state:'waiting'},waiting:{questionId:'q'}} : request;
const response = {protocolVersion:1,id:process.env.WRONG_ID ? 'wrong' : id,exitCode:0,stdout:JSON.stringify({data}),stderr:''};
fs.writeFileSync(path.join(root,'responses',id+'.json'),JSON.stringify(response),{mode:0o600});
`); await chmod(app, 0o755);
  const env = { ...process.env, WORKFOLD_CLI_STATE_DIR: state, WORKFOLD_CLI_APP: app, WORKFOLD_CLI_TIMEOUT_MS: "2000" };
  const bin = join(root, "package/bin"), system = join(root, "system-bin");
  await mkdir(bin, { recursive: true }); await mkdir(system);
  await copyFile("desktop/cli/work-fold", join(bin, "work-fold"));
  await copyFile(cli, join(bin, "work-fold-cli"));
  await chmod(join(bin, "work-fold"), 0o755); await chmod(join(bin, "work-fold-cli"), 0o755);
  await symlink(join(bin, "work-fold"), join(system, "work-fold"));
  assert.equal(JSON.parse((await run(join(system, "work-fold"), ["context", "--json"], { env })).stdout).data.protocolVersion, 1, "installed CLI resolves its native sibling through the system symlink");
  let reply = JSON.parse((await run(cli, ["context", "--json"], { env })).stdout).data;
  assert.equal(reply.protocolVersion, 1); assert.equal(reply.actToken, undefined);
  await assert.rejects(run(cli, ["files", "list", "--space", "Test"], { env }), (error: any) => error.code === 6);
  await writeFile(join(state, "cli/act-token.json"), JSON.stringify({ version: 1, actToken: "a".repeat(64) }), { mode: 0o600 });
  const message = join(root, "message.txt"); await writeFile(message, "A real\nUTF-8 message: café");
  reply = JSON.parse((await run(cli, ["chat", "send", "--space", "Test", "--message-file", message, "--json"], { env })).stdout).data;
  assert.equal(reply.protocolVersion, 3); assert.equal(reply.lane, "act"); assert.equal(reply.payload.messageFile, "A real\nUTF-8 message: café"); assert.ok(reply.argv.includes("--message-from-payload"));
  reply = JSON.parse((await run(cli, ["manage", "wait", "--task", "t", "--json"], { env })).stdout).data;
  assert.equal(reply.requestGraph.state, "waiting");
  const last = JSON.parse(await readFile(join(state, "cli/last.json"), "utf8")); assert.equal(last.argv[1], "status");
  await assert.rejects(run(cli, ["context"], { env: { ...env, WRONG_ID: "1" } }), /Invalid CLI response identity/);
  await writeFile(message, "x".repeat(262145)); await assert.rejects(run(cli, ["chat", "send", "--message-file", message], { env }), (error: any) => error.code === 2);
});

test("Linux Chrome host validates origin, private descriptor, framing, and loopback forwarding", { skip: !native }, async t => {
  const root = await mkdtemp(join(tmpdir(), "workfold-linux-chrome-")); t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "host"); await copyFile(chrome, binary); await chmod(binary, 0o755);
  const distribution = JSON.parse(await readFile("src/shared/chrome-distribution.json", "utf8"));
  const origin = `chrome-extension://${distribution.storeId}/`; const token = "a".repeat(64);
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(envelope.extensionOrigin, origin); assert.equal(envelope.request.action, "status");
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ version: 1, state: "status", status: { state: "connected" } }));
  }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const descriptor = join(root, "launch.json");
  await writeFile(descriptor, JSON.stringify({ version: 1, launchId: "12345678-1234-4123-8123-123456789abc", bootstrapToken: token, endpoint: `http://127.0.0.1:${port}/bootstrap` }), { mode: 0o600 });
  async function request(caller: string) {
    const child = spawn(binary, [caller], { stdio: ["pipe", "pipe", "pipe"] });
    const bytes = Buffer.from(JSON.stringify({ version: 1, action: "status" })); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    child.stdin.on("error", () => {}); child.stdin.end(Buffer.concat([header, bytes]));
    const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(chunk));
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
    const reply = Buffer.concat(chunks); assert.equal(reply.readUInt32LE(), reply.length - 4); return JSON.parse(reply.subarray(4).toString());
  }
  assert.equal((await request("chrome-extension://invalid/")).status.state, "connection_error");
  assert.equal((await request(origin)).status.state, "connected");
  await chmod(descriptor, 0o644); assert.equal((await request(origin)).status.state, "app_not_running");
});
