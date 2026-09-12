import assert from "node:assert/strict";
import childProcess from "node:child_process";
import net from "node:net";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = await mkdtemp(join(tmpdir(), "workfold-included-catalog-"));
const agentDir = join(root, "agent"), stateRoot = join(root, "state");
process.env.PI_CODING_AGENT_DIR = agentDir;
await Promise.all([agentDir, stateRoot, join(root, "space-a"), join(root, "space-b")].map(path => mkdir(path)));
await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { eager: { command: process.execPath, args: ["-e", "throw new Error('catalog started an MCP server')"], lifecycle: "eager" } } }));
async function snapshot(path: string): Promise<unknown> {
  return Promise.all((await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name)).map(async entry => [entry.name, entry.isDirectory() ? await snapshot(join(path, entry.name)) : (await readFile(join(path, entry.name))).toString("base64")]));
}
const events: string[] = [], restore: Array<() => void> = [];
function forbid(target: any, key: string, label: string) {
  const original = target[key]; restore.push(() => { target[key] = original; });
  target[key] = (..._args: unknown[]) => { events.push(label); throw new Error(`Catalog attempted ${label}`); };
}
try {
  const { AuthStorage, ModelRegistry, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { loadAgentSkillCatalog } = await import("../../../src/local/agent/skill-catalog.ts");
  const authStorage = AuthStorage.inMemory(), modelRegistry = ModelRegistry.inMemory(authStorage);
  const provider = { resolveRuntime: async () => ({ agentDir, authStorage, modelRegistry, settingsManager: SettingsManager.inMemory(), projectTrust: { override: true }, includedTools: { rootPath: resolve("resources/included-tools"), stateRoot, helperAppPath: join(root, "Missing Computer.app") } }) };
  const before = await snapshot(root);
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) forbid(childProcess, key, `child_process.${key}`);
  forbid(workerThreads, "Worker", "worker thread");
  forbid(net.Server.prototype, "listen", "listener"); forbid(net.Socket.prototype, "connect", "socket connection"); forbid(globalThis, "fetch", "network fetch");
  syncBuiltinESMExports();
  for (const space of ["space-a", "space-b", "space-a"]) {
    const catalog = await loadAgentSkillCatalog(join(root, space), provider);
    assert.deepEqual(catalog.diagnostics.filter(item => item.type === "error" || item.type === "collision"), []);
    const included = catalog.extensions.filter(item => item.source.source === "Included with work-fold");
    assert.equal(included.length, 5, JSON.stringify(catalog.extensions));
    for (const name of ["find_roots", "chrome_tab", "web_search", "mcp", "document_run"]) assert.ok(catalog.tools.some(tool => tool.name === name), `Missing native tool ${name}`);
    assert.ok(catalog.skills.some(skill => skill.name === "document-work"), "Ordinary document Skill is present");
  }
  assert.deepEqual(events, [], "Catalog/session_start never starts a helper, bridge, MCP process, or network request");
  assert.deepEqual(await snapshot(root), before, "Catalog never writes credentials, capture files, or app-owned state");
  console.log("PASS included catalog: five native Extensions and ordinary document Skill, two Spaces and repeat catalog, no process/listener/network or filesystem effects");
} finally {
  for (const action of restore.reverse()) action(); syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
