import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "workfold-computer-native-"));
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const computer = await jiti.import<any>(new URL("../../../resources/included-tools/computer/index.ts", import.meta.url).pathname);
const config = { stateRoot: root, helperAppPath: join(root, "Missing Helper.app") };
const created: any[] = [];
try {
  const piFixture = (mode: string) => {
    const tools = new Map(), handlers = new Map();
    const pi = { tools, handlers, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (name: string, fn: any) => handlers.set(name, fn), events: { emit: (_name: string, event: any) => { event.context = { ...config, version: 1, mode, cwd: root, agentDir: join(root, "agent") }; } } };
    created.push(pi); return pi;
  };
  for (const mode of ["catalog", "session", "session"]) {
    const pi = piFixture(mode);
    await computer.default(pi);
    await pi.handlers.get("session_start")({}, { cwd: root, hasUI: false, sessionManager: { getBranch: () => [] } });
    assert.equal(pi.tools.size, 8);
    assert.equal(pi.tools.has("browser_navigate"), false);
  }
  assert.notEqual(created[1].tools.get("find_roots").execute, created[2].tools.get("find_roots").execute);
  if (process.platform !== "darwin") {
    const unavailable = await created[1].tools.get("find_roots").execute("unsupported", {});
    assert.equal(unavailable.details.error, "unsupported_platform");
    assert.equal((await computer.setupIncludedComputer(config, "request-permissions")).status, "unavailable");
  }
  const result = await computer.probeIncludedComputer(config, { launch: false });
  assert.ok(["not_running", "unavailable"].includes(result.status), JSON.stringify(result));
  assert.equal(result.helper?.appPath ?? config.helperAppPath, config.helperAppPath);
  await assert.rejects(() => computer.probeIncludedComputer({ ...config, stateRoot: join(root, "other") }, { launch: false }), /another work-fold profile/);
  console.log("PASS computer wrapper: catalog and session startup without helper, private native factories, read-only missing-helper probe, immutable host identity");
} finally {
  for (const pi of created) await pi.handlers.get("session_shutdown")?.();
  await computer.shutdownIncludedComputer(config);
  await rm(root, { recursive: true, force: true });
}
