import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { startLocalApi } from "../src/local/server.js";

// Real HTTP setup routing, disposable app/Pi state, no model or OS credentials.
test("MCP setup sessions bind to their Space, pin shown targets, and close without replay", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-mcp-settings-api-"));
  const agentDir = join(root, "pi"); const included = join(root, "included");
  await mkdir(agentDir); await mkdir(included);
  await mkdir(join(agentDir, "extensions"));
  await writeFile(join(agentDir, "extensions", "hold.ts"), "export default function(pi){pi.registerCommand('hold-setup-test',{description:'Hold a test turn',handler:async()=>await new Promise(resolve=>setTimeout(resolve,400))});}");
  await writeFile(join(included, "package.json"), JSON.stringify({ name: "fixture-included", pi: { extensions: [], skills: [] } }));
  const options = { port: 0, loadEnv: false, stateBase: join(root, "state"), spaceBase: join(root, "spaces"), piRuntimeProvider: {
    resolveRuntime: async () => ({ agentDir, authStorage: AuthStorage.inMemory(), includedTools: { rootPath: included, stateRoot: join(root, "included-state") } }),
  } };
  let api = await startLocalApi(options);
  async function post(body: object) {
    const response = await fetch(`${api.origin}/api/agent/mcp-setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text(); return { status: response.status, text, body: JSON.parse(text) };
  }
  try {
    const first = (await api.actFacade.createSpace({ name: "MCP setup A" })).space;
    const second = (await api.actFacade.createSpace({ name: "MCP setup B" })).space;
    const opened = await post({ spaceId: first.id, operation: "open" }); assert.equal(opened.status, 200, opened.text);
    const sessionId: string = opened.body.sessionId;
    assert.ok(sessionId);
    assert.ok((await post({ spaceId: second.id, sessionId, operation: "list" })).status >= 400);
    assert.ok((await post({ spaceId: first.id, sessionId: "forged-session", operation: "list" })).status >= 400);
    const holding = await api.actFacade.manageSend({ content: "/hold-setup-test", newConversation: true });
    const blocked = await post({ spaceId: first.id, sessionId, operation: "save", scope: "global", name: "blocked", definition: { command: "must-not-start" } });
    assert.equal(blocked.status, 409, "connection changes must not invalidate active Assistant work");
    for (let count = 0; count < 200 && (await api.actFacade.manageTurnStatus({ taskId: holding.taskId })).task.state === "running"; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await api.actFacade.manageTurnStatus({ taskId: holding.taskId })).task.state, "succeeded");
    const saved = await post({ spaceId: first.id, sessionId, operation: "save", scope: "project", name: "demo", definition: { url: "https://example.invalid/mcp?private=fixture-query-secret", auth: false, headers: { "X-Private": "fixture-header-secret" } } });
    assert.equal(saved.status, 200, saved.text);
    assert.doesNotMatch(saved.text, /fixture-query-secret|fixture-header-secret/);
    const oldRevision: string = saved.body.servers[0].revision;
    for (const operation of ["check", "remove", "enabled", "bearer", "disconnect", "oauth"]) {
      const unpinned = await post({ spaceId: first.id, sessionId, operation, scope: "project", name: "demo" });
      assert.ok(unpinned.status >= 400, `${operation} must require the displayed target revision`);
      assert.match(unpinned.text, /Refresh service setup/);
    }

    const path = join(first.spaceRoot, ".pi", "mcp.json");
    const beforeToggle = JSON.parse(await readFile(path, "utf8"));
    for (const invalid of [undefined, "false", 0, null]) {
      const invalidToggle = await post({ spaceId: first.id, sessionId, operation: "enabled", scope: "project", name: "demo", expectedRevision: oldRevision, enabled: invalid });
      assert.equal(invalidToggle.status, 400, invalidToggle.text);
    }
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), beforeToggle, "invalid enabled payloads never change native config");
    const off = await post({ spaceId: first.id, sessionId, operation: "enabled", scope: "project", name: "demo", expectedRevision: oldRevision, enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.servers[0].disabled, true);
    assert.notEqual(off.body.servers[0].revision, oldRevision);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...beforeToggle, mcpServers: { ...beforeToggle.mcpServers, demo: { ...beforeToggle.mcpServers.demo, disabled: true } } }, "turning off preserves every unrelated native field");
    const staleToggle = await post({ spaceId: first.id, sessionId, operation: "enabled", scope: "project", name: "demo", expectedRevision: oldRevision, enabled: true });
    assert.ok(staleToggle.status >= 400, staleToggle.text);
    assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.demo.disabled, true, "an outdated view cannot re-enable the connection");
    const on = await post({ spaceId: first.id, sessionId, operation: "enabled", scope: "project", name: "demo", expectedRevision: off.body.servers[0].revision, enabled: true });
    assert.equal(on.status, 200, on.text); assert.equal(on.body.servers[0].disabled, false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...beforeToggle, mcpServers: { ...beforeToggle.mcpServers, demo: { ...beforeToggle.mcpServers.demo, disabled: false } } }, "turning on only updates the disabled flag");
    assert.doesNotMatch(off.text + on.text, /fixture-query-secret|fixture-header-secret/);
    const raw = JSON.parse(await readFile(path, "utf8")); raw.mcpServers.demo.url = "https://changed.invalid/mcp"; await writeFile(path, JSON.stringify(raw));
    const stale = await post({ spaceId: first.id, sessionId, operation: "remove", scope: "project", name: "demo", expectedRevision: oldRevision });
    assert.ok(stale.status >= 400, "a stale UI must not remove a replacement connection");
    assert.ok(JSON.parse(await readFile(path, "utf8")).mcpServers.demo);
    const duplicate = await post({ spaceId: first.id, sessionId, operation: "save", scope: "project", name: "demo", definition: { command: "must-not-replace" } });
    assert.ok(duplicate.status >= 400);
    assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.demo.url, "https://changed.invalid/mcp");
    assert.equal((await post({ spaceId: first.id, sessionId, operation: "close" })).status, 200);
    assert.ok((await post({ spaceId: first.id, sessionId, operation: "oauth-status", jobId: "unknown" })).status >= 400);
    const retained = await post({ spaceId: first.id, operation: "open" }); assert.equal(retained.status, 200);
    await api.close(); api = await startLocalApi(options);
    assert.ok((await post({ spaceId: first.id, sessionId: retained.body.sessionId, operation: "list" })).status >= 400, "setup sessions never resume after app restart");
    assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.demo.url, "https://changed.invalid/mcp", "ordinary native config survives restart");
    // A bad config must not leave an unreachable setup session consuming slots.
    await writeFile(path, "{fixture-malformed-secret");
    for (let count = 0; count < 17; count++) {
      const failed = await post({ spaceId: first.id, operation: "open" }); assert.ok(failed.status >= 400);
      assert.doesNotMatch(failed.text, /Close another service setup|fixture-malformed-secret/);
    }
    await writeFile(path, JSON.stringify({ mcpServers: {} }));
    const recovered = await post({ spaceId: first.id, operation: "open" }); assert.equal(recovered.status, 200, recovered.text);
    await api.actFacade.spacesUnregister({ space: first.id });
    const closedRemoved = await post({ spaceId: first.id, sessionId: recovered.body.sessionId, operation: "close" });
    assert.equal(closedRemoved.status, 200, "closing setup remains safe after its Space has been removed");
  } finally { await api.close(); await rm(root, { recursive: true, force: true }); }
});
