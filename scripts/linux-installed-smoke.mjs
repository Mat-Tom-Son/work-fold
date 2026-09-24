import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Agent as HttpAgent, fetch as localModelFetch } from "undici-pi-reviewed";

const fixtureSchema = "work-fold.linux-installed-fixture.v1";
const provider = "linux-installed-fixture", model = "fixture-model";
const note = "The installed Linux app copied this file through its authenticated CLI.\n";
const workerNote = "Pi's native write tool created this file in the installed Linux app.\n";
const markerName = "fixture.json";
// CPU-only model acceptance includes Pi's complete installed tool catalog. Its
// prefill can exceed ordinary network-idle defaults; never retry accepted work.
const liveRequestTimeoutMs = 30 * 60_000;
const liveTurnTimeoutMs = 40 * 60_000;

// Verification must never initialize a missing profile and turn data loss green.
export async function prepareFixture(root, phase) {
  assert.ok(["seed", "verify"].includes(phase), "Invalid fixture phase");
  root = resolve(root);
  const stat = await lstat(root).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  assert.ok(!stat?.isSymbolicLink(), "Fixture root must not be a symlink");
  if (!stat) {
    assert.equal(phase, "seed", "Retained fixture is missing");
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  assert.equal(await realpath(root), root, "Fixture path must not contain symlink ancestors");
  if (phase === "seed") {
    assert.deepEqual(await readdir(root), [], "Seed requires an empty disposable directory");
    const fixture = { schema: fixtureSchema, nonce: randomUUID(), complete: false };
    await writeFile(join(root, markerName), JSON.stringify(fixture), { flag: "wx", mode: 0o600 });
    await mkdir(join(root, "Linux test folder"));
    await mkdir(join(root, "pi"));
    return fixture;
  }
  const fixture = JSON.parse(await readFile(join(root, markerName), "utf8"));
  assert.equal(fixture.schema, fixtureSchema, "Unrecognized fixture directory");
  assert.equal(fixture.complete, true, "Seed did not finish successfully");
  for (const directory of ["state", "pi", "Linux test folder"]) {
    assert.ok((await lstat(join(root, directory))).isDirectory(), `Retained ${directory} must exist`);
    assert.equal(await realpath(join(root, directory)), join(root, directory), "Fixture directories must not be symlinks");
  }
  return fixture;
}

async function startProvider(nonce, live) {
  let calls = 0; const observations = [];
  const dispatcher = live ? new HttpAgent({ headersTimeout: liveRequestTimeoutMs, bodyTimeout: liveRequestTimeoutMs }) : undefined;
  const requests = new Set();
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.ok(++calls <= 20, "Unexpected fixture model loop");
      let body = "";
      for await (const chunk of request) {
        body += chunk; assert.ok(body.length <= 4 * 1024 * 1024, "Fixture request too large");
      }
      const payload = JSON.parse(body);
      assert.equal(payload.model, live?.model ?? model);
      const lastUser = payload.messages.findLastIndex(message => message.role === "user" && JSON.stringify(message.content).includes("LINUX_SMOKE_"));
      assert.ok(lastUser >= 0, "Expected a synthetic test prompt");
      observations.push({ tools: payload.tools?.map(tool => tool.function?.name), roles: payload.messages.map(message => message.role), marker: JSON.stringify(payload.messages[lastUser]?.content).includes(`LINUX_SMOKE_WRITE_${nonce}`) });
      const wantsWrite = JSON.stringify(payload.messages[lastUser]?.content || "").includes(`LINUX_SMOKE_WRITE_${nonce}`)
        && payload.tools?.some(tool => tool.function?.name === "write")
        && !payload.messages.slice(lastUser + 1).some(message => message.role === "tool");
      if (live) {
        const abort = new AbortController(); requests.add(abort);
        const timeout = setTimeout(() => abort.abort(), liveRequestTimeoutMs);
        response.once("close", () => abort.abort());
        try {
          const upstream = await localModelFetch(`${live.url}/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json" }, body, signal: abort.signal, dispatcher, redirect: "error",
          });
          assert.equal(upstream.status, 200, `Local model returned HTTP ${upstream.status}`);
          response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          let bytes = 0;
          for await (const chunk of upstream.body) {
            bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024, "Local model response exceeded test bound");
            response.write(chunk);
          }
          response.end();
        } finally { clearTimeout(timeout); requests.delete(abort); }
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const send = (delta, reason) => response.write(`data: ${JSON.stringify({
        id: `fixture-${calls}`, object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta, finish_reason: reason }],
      })}\n\n`);
      if (wantsWrite) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: `write-${calls}`, type: "function", function: {
          name: "write", arguments: JSON.stringify({ path: "worker-created.txt", content: workerNote }),
        } }] }, null);
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: `Linux fixture completed ${nonce}.` }, null);
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (live) console.error("Local-model test transport:", error.name, String(error.message).slice(0, 240));
      if (!response.headersSent) response.writeHead(500);
      response.end("Synthetic provider rejected the request");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, calls: () => calls, observations,
    close: async () => { for (const request of requests) request.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await dispatcher?.close(); },
  };
}

// Observe only descendants of the GUI process this test launched. Do not log
// command lines: Electron arguments may carry private per-launch configuration.
async function assertRendererSandbox(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pending = [pid], seen = new Set();
    let renderers = 0;
    while (pending.length && seen.size < 256) {
      const current = pending.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      let args, status, threads;
      try {
        [args, status, threads] = await Promise.all([
          readFile(`/proc/${current}/cmdline`, "utf8"), readFile(`/proc/${current}/status`, "utf8"),
          readdir(`/proc/${current}/task`),
        ]);
      } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
      // Chromium can rewrite Linux argv into one process-title string. Accept
      // both normal NUL-delimited argv and that space-delimited representation.
      const command = args.split(/[\0\s]+/);
      assert.ok(!command.includes("--no-sandbox"), "No application process may disable the sandbox");
      if (command.includes("--type=renderer")) {
        assert.ok(command.includes("--enable-sandbox"), "Renderer must enable Chromium sandboxing");
        assert.match(status, /^NoNewPrivs:\s+1$/m, "Renderer must prevent privilege gain");
        assert.match(status, /^Seccomp:\s+2$/m, "Renderer must install a seccomp filter");
        renderers++;
      }
      // Linux records children under the thread that forked them. Chromium's
      // zygote need not be a child of the browser's main thread.
      assert.ok(threads.length < 1024, "Unexpected number of application threads");
      const children = await Promise.all(threads.map(thread => readFile(`/proc/${current}/task/${thread}/children`, "utf8")
        .catch(error => { if (error.code === "ENOENT" || error.code === "ESRCH") return ""; throw error; })));
      pending.push(...children.join(" ").trim().split(/\s+/).filter(Boolean).map(Number));
    }
    if (renderers > 0) return;
    await delay(100);
  }
  assert.fail("No sandboxed application renderer appeared");
}

export async function runInstalledSmoke(args = process.argv.slice(2)) {
  assert.equal(process.platform, "linux", "Run this smoke on Linux");
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "profile-root": { type: "string" }, phase: { type: "string", default: "seed" }, "expect-version": { type: "string" },
    "live-ollama-url": { type: "string" }, "live-model": { type: "string" },
  } });
  let live;
  if (values["live-ollama-url"] || values["live-model"]) {
    assert.ok(values["live-ollama-url"] && values["live-model"], "Provide both local model URL and model id");
    const url = new URL(values["live-ollama-url"]);
    assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/v1"
      && !url.username && !url.password && !url.search && !url.hash, "Real-model smoke requires an explicit loopback Ollama /v1 endpoint");
    assert.match(values["live-model"], /^[a-zA-Z0-9_.:/-]{1,128}$/);
    live = { url: url.href, model: values["live-model"] };
  }
  assert.ok(positionals.length <= 2, "Provide only the GUI executable and optional CLI path");
  const phase = values.phase;
  assert.ok(["seed", "verify"].includes(phase), "--phase must be seed or verify");
  assert.ok(phase === "seed" || values["profile-root"], "verify requires --profile-root");
  const executable = resolve(positionals[0] || "out/linux/linux-unpacked/work-fold-desktop");
  const cli = resolve(positionals[1] || join(dirname(executable), "bin/work-fold"));
  const retained = Boolean(values["profile-root"]);
  const root = retained ? resolve(values["profile-root"]) : await mkdtemp(join(tmpdir(), "workfold-installed-smoke-"));
  let child, peer, closed, successMessage;
  try {
    const fixture = await prepareFixture(root, phase);
    const state = join(root, "state"), folder = join(root, "Linux test folder"), agent = join(root, "pi");
    const modelsPath = join(agent, "models.json");
    // Pi's supported setting covers a CPU-only model's long initial prefill.
    // This remains local to the explicitly created test profile.
    if (live && phase === "seed") await writeFile(join(agent, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: liveRequestTimeoutMs, retry: { enabled: false } }), { flag: "wx", mode: 0o600 });
    const config = { api: "openai-completions", apiKey: "synthetic-not-a-secret", models: [{
      id: live?.model ?? model, name: "Installed Linux fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: live ? 2048 : 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] };
    if (phase === "verify") {
      const saved = JSON.parse(await readFile(modelsPath, "utf8"));
      const { baseUrl, ...persisted } = saved.providers[provider];
      assert.deepEqual(persisted, config, "Native Pi model configuration survives restart");
      assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    }
    peer = await startProvider(fixture.nonce, live);
    // Only the local fixture server's ephemeral port changes between launches.
    await writeFile(modelsPath, JSON.stringify({ providers: { [provider]: { ...config, baseUrl: peer.url } } }), { mode: 0o600 });
    const env = { ...process.env, WORKFOLD_STATE_DIR: state, WORKFOLD_DESKTOP_STATE_DIR: state, WORKFOLD_CLI_STATE_DIR: state,
      WORKFOLD_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, WORKFOLD_CLI_TIMEOUT_MS: "30000", WORKFOLD_DISABLE_LOGIN_SHELL_ENV: "1" };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const tokenPath = join(state, "cli/act-token.json");
    const previousToken = await readFile(tokenPath, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    // Own a process group: AppImage extraction mode keeps a launcher between
    // this harness and Electron. Stopping only the launcher can orphan the GUI.
    child = spawn(executable, [], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-16_384); });
    closed = new Promise(resolve => child.once("close", resolve));
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    async function command(...argv) {
      const { stdout } = await promisify(execFile)(cli, [...argv, "--json"], { env, cwd: root, timeout: 40_000, maxBuffer: 2 * 1024 * 1024 });
      const result = JSON.parse(stdout);
      assert.notEqual(result.ok, false, `CLI ${argv[0]} ${argv[1] || ""} failed`);
      return result;
    }
    let ready = false;
    // Require both a new launch token and a live response; a retained profile
    // may contain a stale token. Bound startup independently of act timeouts.
    const readyDeadline = Date.now() + 45_000;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`App exited before ready:\n${output}`);
      try {
        assert.notEqual(await readFile(tokenPath, "utf8"), previousToken);
        await promisify(execFile)(cli, ["context", "--json"], { cwd: root,
          // The installed launcher starts Electron before its RPC deadline.
          // Allow cold ASAR loading under concurrent distro/model acceptance;
          // killing that launcher after two seconds can orphan its child.
          env: { ...env, WORKFOLD_CLI_TIMEOUT_MS: "5000" }, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
        ready = true; break;
      } catch { await delay(250); }
    }
    assert.ok(ready, `App did not become ready:\n${output}`);
    const version = await command("version");
    if (values["expect-version"]) assert.equal(version.data.version, values["expect-version"]);
    const source = join(root, "Linux-ready.txt");
    if (phase === "seed") {
      await command("spaces", "register", "--path", folder);
      const manifest = JSON.parse(await readFile(join(folder, ".work-fold/space.json"), "utf8"));
      fixture.spaceId = manifest.id;
      assert.equal(typeof fixture.spaceId, "string");
      await writeFile(source, note);
      await command("files", "add", "--space", fixture.spaceId, "--from", source);
      await command("library", "add", "--from", source);
      await command("spaces", "assistant", "model", "--space", fixture.spaceId, "--provider", provider, "--model", live?.model ?? model);
      const created = await command("chat", "create", "--space", fixture.spaceId);
      fixture.conversationId = created.data.conversation.id;
      await command("chat", "rename", "--space", fixture.spaceId, "--conversation", fixture.conversationId, "--title", "Linux persistence fixture");
    } else {
      const manifest = JSON.parse(await readFile(join(folder, ".work-fold/space.json"), "utf8"));
      assert.equal(manifest.id, fixture.spaceId, "Portable Folder identity survives");
      const conversations = (await command("chats", "list", "--space", fixture.spaceId)).data.conversations;
      assert.ok(conversations.some(chat => chat.id === fixture.conversationId && chat.title === "Linux persistence fixture"), "Chat identity/title survive");
      const history = (await command("history", "list", "--space", fixture.spaceId)).data.checkpoints;
      assert.ok(history.some(item => item.checkpointId === fixture.checkpointId), "History checkpoint survives");
      const result = (await command("chat", "result", "--space", fixture.spaceId, "--conversation", fixture.conversationId)).data;
      assert.ok(result.messages.some(message => message.content.includes(`LINUX_SMOKE_WRITE_${fixture.nonce}`)), "User message survives");
      assert.ok(result.messages.some(message => message.content.includes(`Linux fixture completed ${fixture.nonce}`)), "Worker result survives");
      const request = await command("requests", "show", "--request", fixture.requestId);
      assert.equal(request.data.request.state, "done", "Durable request survives reconciliation");
      assert.equal(await readFile(join(folder, "worker-created.txt"), "utf8"), workerNote);
    }
    const selected = (await command("spaces", "assistant", "show", "--space", fixture.spaceId)).data.model;
    assert.deepEqual(selected, { provider, id: live?.model ?? model }, "Folder model choice is preserved");
    const livePrompt = !live ? "" : phase === "seed"
      ? `\nUse the native write tool to create worker-created.txt with exactly this text (including the final newline): ${JSON.stringify(workerNote)}. After the tool succeeds, reply exactly: Linux fixture completed ${fixture.nonce}. /no_think`
      : `\nRead worker-created.txt to confirm it exists. Then reply exactly: Linux fixture completed ${fixture.nonce}. /no_think`;
    const sent = await command("chat", "send", "--space", fixture.spaceId, "--conversation", fixture.conversationId,
      "--message", `LINUX_SMOKE_${phase === "seed" ? "WRITE" : "RESUME"}_${fixture.nonce}${livePrompt}`);
    let settled;
    const deadline = Date.now() + (live ? liveTurnTimeoutMs : 30_000);
    do {
      try {
        settled = await command("chat", "wait", "--space", fixture.spaceId, "--task", sent.data.taskId, "--timeout", "30");
      } catch (error) {
        // A CLI wait timeout does not retry the accepted model turn. Continue
        // following that same task while the real local model is processing.
        if (live && error.code === 7 && /chat wait timed out/.test(error.stderr ?? "")) continue;
        throw error;
      }
      if (!["queued", "running"].includes(settled.data.task.state)) break;
    } while (Date.now() < deadline);
    assert.ok(settled, "The real local model did not settle within its bounded test deadline");
    assert.equal(settled.data.task.state, "succeeded", `Worker fixture must succeed: ${JSON.stringify(settled.data.task)}`);
    assert.ok(peer.calls() >= (phase === "seed" ? 2 : 1), `The installed Pi runtime reached the local provider: ${JSON.stringify(peer.observations)}`);
    assert.equal(await readFile(join(folder, "worker-created.txt"), "utf8"), workerNote);
    assert.equal(await readFile(join(folder, "Linux-ready.txt"), "utf8"), note);
    const library = (await command("library", "list")).data.items;
    assert.ok(library.some(item => item.path === "Linux-ready.txt" && item.sizeBytes === Buffer.byteLength(note)), "Library entry survives");
    const copied = (await command("library", "copy", "--item", "Linux-ready.txt", "--space", fixture.spaceId)).data.copied;
    assert.equal(await readFile(join(folder, copied), "utf8"), note, "Library bytes survive, not only its index entry");
    const capabilities = await command("capabilities", "list", "--space", fixture.spaceId);
    assert.match(JSON.stringify(capabilities), /included-tools/);
    await assertRendererSandbox(child.pid);
    if (phase === "seed") {
      fixture.checkpointId = (await command("history", "save", "--space", fixture.spaceId, "--label", "Linux persistence fixture")).data.checkpoint.checkpointId;
      fixture.requestId = settled.data.request.id;
      fixture.version = version.data;
      fixture.complete = true;
      await writeFile(join(root, markerName), JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
    }
    successMessage = `PASS installed Linux ${phase}: sandboxed renderer, real Pi turn with ${live ? `real local Ollama model ${live.model}` : "local synthetic provider"}, Folder identity, Chat, History, Library, request, model choice and exact file bytes${retained ? "; profile retained" : "; disposable profile"}`;
  } finally {
    try {
      if (child?.pid) {
        const signal = value => {
          try { process.kill(-child.pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; }
        };
        signal("SIGTERM");
        const force = setTimeout(() => signal("SIGKILL"), 5_000);
        let deadline;
        try {
          await Promise.race([closed, new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Owned application process group did not close")), 10_000);
          })]);
        } finally {
          clearTimeout(force); clearTimeout(deadline);
          child.stdout.destroy(); child.stderr.destroy();
        }
      }
    } finally {
      await peer?.close();
      if (!retained) await rm(root, { recursive: true, force: true });
    }
  }
  console.log(successMessage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runInstalledSmoke();
