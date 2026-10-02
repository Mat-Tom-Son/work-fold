import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "workfold-computer-native-"));
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const computer = await jiti.import<any>(new URL("../../../resources/included-tools/computer/index.ts", import.meta.url).pathname);
let prepared = 0, reservations = 0, repairs = 0;
let preparationWait: Promise<void> | undefined;
const observations: any[] = [];
const config = { stateRoot: root, helperAppPath: join(root, "Missing Helper.app"), repairComputerHelper: async () => { repairs++; throw new Error("Unexpected helper repair"); }, prepareComputerHelper: async () => { prepared++; await preparationWait; throw new Error("Synthetic preparation boundary"); } };
const created: any[] = [];
try {
  const piFixture = (mode: string) => {
    const tools = new Map(), handlers = new Map();
    const pi = { tools, handlers, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (name: string, fn: any) => handlers.set(name, fn), events: { emit: (_name: string, event: any) => { event.context = { ...config, version: 1, mode, cwd: root, agentDir: join(root, "agent"), ...(mode === "session" ? { beginIncludedToolObservation: (id: string) => { reservations++; return (status: any) => { assert.equal(id, "computer"); observations.push(status); return status; }; } } : {}) }; } } };
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
  assert.equal(prepared, 0, "catalog, session startup and non-launching probe never materialize the helper");
  assert.equal(observations.length, 0, "catalog and startup cannot claim readiness");
  assert.ok(["not_running", "unavailable"].includes(result.status), JSON.stringify(result));
  assert.equal(result.helper?.appPath ?? config.helperAppPath, config.helperAppPath);
  await assert.rejects(() => computer.probeIncludedComputer({ ...config, stateRoot: join(root, "other") }, { launch: false }), /another work-fold profile/);
  if (process.platform === "darwin" && Number.parseInt(release(), 10) >= 23) {
    await assert.rejects(() => computer.probeIncludedComputer(config, { launch: true }), /Synthetic preparation boundary/);
    assert.equal(prepared, 1);
    assert.equal(repairs, 0, "a deliberate start checks the immutable helper without entering the repair path");
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(() => created[1].tools.get("find_roots").execute("cancelled", {}, aborted.signal), /abort/i);
    assert.equal(prepared, 1, "cancelled tools never materialize or launch");
    assert.equal(observations.length, 0, "cancelled tools cannot claim readiness");
    await assert.rejects(() => created[1].tools.get("find_roots").execute("explicit", {}), /Synthetic preparation boundary/);
    assert.equal(prepared, 2, "native execution waits for the verified helper before effects");
    assert.equal(observations.at(-1)?.state, "unavailable", "failed helper verification cannot leave a healthy badge");
    let release!: () => void;
    preparationWait = new Promise<void>(resolve => { release = resolve; });
    const before = reservations;
    const held = created[1].tools.get("find_roots").execute("held", {});
    const rejected = assert.rejects(held, /Synthetic preparation boundary/);
    assert.equal(reservations, before, "starting a tool cannot supersede an explicit Check or another Chat's pending probe");
    release(); await rejected;
    assert.equal(reservations, before + 1, "a preparation failure reserves and publishes its actual observation together");
  }
  console.log("PASS computer wrapper: catalog and session startup without helper, private native factories, read-only missing-helper probe, immutable host identity");
} finally {
  for (const pi of created) await pi.handlers.get("session_shutdown")?.();
  await computer.shutdownIncludedComputer(config);
  await rm(root, { recursive: true, force: true });
}
