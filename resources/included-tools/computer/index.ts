import { createHash } from "node:crypto";
import { homedir, release } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostContext } from "../host.ts";
import { includedComputerStatus } from "../readiness.ts";

export type IncludedComputerConfig = { helperAppPath: string; stateRoot: string; prepareComputerHelper?: () => Promise<void>; repairComputerHelper?: (beforeReplace: () => Promise<void>) => Promise<void> };
export type IncludedComputerSetupAction = "request-permissions" | "accessibility" | "screen-recording" | "recheck";
type ProbeOptions = { launch?: boolean; signal?: AbortSignal };

/** The platform's helper lifecycle. Tools themselves always go through the native factory. */
type HelperAdapter = {
  probe(options: ProbeOptions): Promise<Record<string, any>>;
  setup(action: IncludedComputerSetupAction, signal?: AbortSignal): Promise<Record<string, any>>;
  /** Stops a helper before its files are replaced; trusted setup holds the capability fence. */
  stopForRepair(signal?: AbortSignal): Promise<void>;
  /** Host shutdown only. Never launches a helper just to stop it. */
  shutdown(): Promise<void>;
};
type NativeModules = {
  factory: typeof import("@injaneity/pi-computer-use/extensions/computer-use.ts").default;
  helper: HelperAdapter;
  scheduler: InstanceType<typeof import("@injaneity/pi-computer-use/src/runtime.ts").ResourceScheduler>;
};
type HostRuntime = { config: IncludedComputerConfig; native: Promise<NativeModules>; readinessAt?: number; readinessPending?: Promise<void> };
const runtimeKey = Symbol.for("work-fold:included-computer-host:v1");
const globals = globalThis as typeof globalThis & { [runtimeKey]?: HostRuntime };

/** One immutable helper identity per host process; no Chat state or credentials live here. */
function runtime(config: IncludedComputerConfig): HostRuntime {
  const normalized = { helperAppPath: resolve(config.helperAppPath), stateRoot: resolve(config.stateRoot) };
  const existing = globals[runtimeKey];
  if (existing) {
    if (existing.config.helperAppPath !== normalized.helperAppPath || existing.config.stateRoot !== normalized.stateRoot) {
      throw new Error("The computer helper is already configured for another work-fold profile in this process.");
    }
    return existing;
  }
  const native = process.platform === "win32" ? windowsNative(normalized) : macosNative(normalized);
  return globals[runtimeKey] = { config: normalized, native };
}

/** Sets the helper configuration the native modules read once, at import. */
function configureNativeEnvironment(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] && process.env[key] !== value) throw new Error(`Conflicting computer helper configuration: ${key}.`);
  }
  Object.assign(process.env, values);
}

function macosNative(normalized: { helperAppPath: string; stateRoot: string }): Promise<NativeModules> {
  if (process.env.PI_CU_SOCKET_PATH) throw new Error("The included computer helper cannot use an externally configured PI_CU_SOCKET_PATH.");
  // Unix sockets have a short path limit. The profile digest isolates development,
  // smoke and production without depending on the length of their state roots.
  const profile = createHash("sha256").update(normalized.stateRoot).digest("hex").slice(0, 20);
  const socketPath = join(homedir(), "Library", "Caches", "work-fold", `computer-${profile}.sock`);
  if (Buffer.byteLength(socketPath) >= 104) throw new Error("The computer helper socket path exceeds macOS's supported length.");
  configureNativeEnvironment({
    PI_COMPUTER_USE_HELPER_APP_PATH: normalized.helperAppPath,
    PI_COMPUTER_USE_OWNED_SOCKET_PATH: socketPath,
    PI_COMPUTER_USE_NO_RUNTIME_INSTALL: "1",
  });
  return (async () => {
    // Import only after resolving the immutable native helper configuration.
    // These modules share an import graph. Load its root first so native Pi
    // loaders never observe a partially initialized helper during setup.
    const factory = await import("@injaneity/pi-computer-use/extensions/computer-use.ts");
    const permissions = await import("@injaneity/pi-computer-use/src/platform/macos/permissions.ts");
    const helper = await import("@injaneity/pi-computer-use/src/platform/macos/helper.ts");
    const scheduling = await import("@injaneity/pi-computer-use/src/runtime.ts");
    if (helper.HELPER_APP_PATH !== normalized.helperAppPath || helper.HELPER_SOCKET_PATH !== socketPath) {
      throw new Error("The computer runtime was loaded before its included helper configuration. Restart work-fold to use the configured helper.");
    }
    return {
      factory: factory.default, scheduler: new scheduling.ResourceScheduler(),
      helper: {
        probe: (options) => permissions.probeMacosComputerUse(options),
        setup: (action, signal) => supportsIncludedComputer() ? permissions.setupMacosComputerUse(action, signal) : permissions.probeMacosComputerUse({ signal }),
        async stopForRepair(signal) {
          try {
            await helper.macosHelper.daemonCommand("shutdown", {}, 2_000, signal);
            // The native shutdown acknowledgement precedes its scheduled exit by 200ms.
            await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
          } catch (error) {
            if (!/ENOENT|ECONNREFUSED/.test(String((error as Error).message))) throw new Error("Quit work-fold and reopen it before repairing the computer helper.");
          }
        },
        async shutdown() {
          try { await helper.macosHelper.daemonCommand("shutdown", {}, 2_000); }
          catch { /* A helper that has never started or already quit has nothing to shut down. */ }
        },
      },
    };
  })();
}

/** Windows runs the reviewed UI Automation helper as one host-owned child process.
 * It needs no privacy grants; it cannot operate windows of elevated apps. */
function windowsNative(normalized: { helperAppPath: string; stateRoot: string }): Promise<NativeModules> {
  const executablePath = join(normalized.helperAppPath, "work-fold Computer.exe");
  configureNativeEnvironment({
    PI_COMPUTER_USE_WINDOWS_HELPER_PATH: executablePath,
    PI_COMPUTER_USE_NO_RUNTIME_INSTALL: "1",
    PI_COMPUTER_USE_HOST_OWNED_HELPER: "1",
  });
  return (async () => {
    const factory = await import("@injaneity/pi-computer-use/extensions/computer-use.ts");
    const windows = await import("@injaneity/pi-computer-use/src/platform/windows/helper.ts");
    const { assertPlatformArchitecture } = await import("@injaneity/pi-computer-use/src/platform/architecture.ts");
    const scheduling = await import("@injaneity/pi-computer-use/src/runtime.ts");
    if (windows.WINDOWS_HELPER_PATH !== executablePath || !windows.WINDOWS_HELPER_HOST_OWNED) {
      throw new Error("The computer runtime was loaded before its included helper configuration. Restart work-fold to use the configured helper.");
    }
    const client = windows.windowsHelper;
    const helperFacts = { appPath: normalized.helperAppPath, executablePath, name: "work-fold Computer" };
    async function probe(options: ProbeOptions) {
      if (!supportsIncludedComputer()) return { status: "unavailable" as const, supportedOS: false, permissionModel: "none" as const, reason: "This included helper requires Windows 10 or later." };
      // A plain Check observes a running helper only; it never starts one.
      if (!options.launch && !client.running) return { status: "not_running" as const, supportedOS: true, permissionModel: "none" as const, helper: helperFacts };
      try {
        const diagnostics = await client.command<any>("diagnostics", {}, { signal: options.signal, timeoutMs: 5_000, launch: options.launch === true });
        if (diagnostics?.protocolVersion !== windows.WINDOWS_HELPER_PROTOCOL_VERSION) {
          throw new Error("The running computer helper does not match this application. Recheck setup while no Assistant turn is running.");
        }
        assertPlatformArchitecture("Windows", diagnostics);
        return { status: "ready" as const, supportedOS: true, permissionModel: "none" as const, helper: { ...helperFacts, protocolVersion: diagnostics.protocolVersion, pid: diagnostics.pid } };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { status: "error" as const, supportedOS: true, permissionModel: "none" as const, helper: helperFacts, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    async function stop() {
      client.dispose();
      // The executable stays locked until the terminated process has fully exited.
      for (let attempt = 0; attempt < 20 && client.running; attempt++) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
    return {
      factory: factory.default, scheduler: new scheduling.ResourceScheduler(),
      helper: {
        probe,
        async setup(_action, signal) {
          await stop();
          signal?.throwIfAborted();
          return probe({ launch: true, signal });
        },
        stopForRepair: async () => stop(),
        shutdown: async () => stop(),
      },
    };
  })();
}

export async function probeIncludedComputer(config: IncludedComputerConfig, options: ProbeOptions = {}) {
  options.signal?.throwIfAborted();
  // A deliberate start verifies/materializes the immutable helper but never
  // repairs it or disposes peer sessions. Repair remains a separate setup act.
  if (options.launch && supportsIncludedComputer()) await config.prepareComputerHelper?.();
  options.signal?.throwIfAborted();
  const { helper } = await runtime(config).native;
  return helper.probe(options);
}

export async function setupIncludedComputer(config: IncludedComputerConfig, action: IncludedComputerSetupAction, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Refuse macOS privacy actions before touching, stopping or repairing anything.
  if (process.platform === "win32" && supportsIncludedComputer() && action !== "recheck") throw new Error("Windows does not use separate permissions for Computer Control. Use Restart and Recheck.");
  if (supportsIncludedComputer()) await prepareForSetup(config, signal);
  signal?.throwIfAborted();
  const { helper } = await runtime(config).native;
  if (!supportsIncludedComputer()) return helper.probe({ signal });
  return helper.setup(action, signal);
}

async function prepareForSetup(config: IncludedComputerConfig, signal?: AbortSignal) {
  if (!config.repairComputerHelper) { await config.prepareComputerHelper?.(); return; }
  // These exported setup functions are called by the trusted host under its
  // global capability mutation fence. Native model tools receive no repair callback.
  await config.repairComputerHelper(async () => {
    signal?.throwIfAborted();
    const { helper } = await runtime(config).native;
    await helper.stopForRepair(signal);
    signal?.throwIfAborted();
  });
}

/** Called after host sessions stop. Never launches a helper just to shut it down. */
export async function shutdownIncludedComputer(config: IncludedComputerConfig): Promise<void> {
  if (!globals[runtimeKey]) return;
  const { helper, scheduler } = await runtime(config).native;
  await globals[runtimeKey]?.readinessPending;
  await scheduler.close();
  await helper.shutdown();
}

export default async function includedComputer(pi: ExtensionAPI) {
  const context = hostContext(pi);
  if (!context?.helperAppPath) throw new Error("The included computer Extension requires its bundled helper configuration.");
  const host = runtime({ helperAppPath: context.helperAppPath, stateRoot: context.stateRoot });
  const native = await host.native;
  async function observeReadiness(signal?: AbortSignal, force = false) {
    if (!context?.beginIncludedToolObservation || signal?.aborted) return;
    if (host.readinessPending) return host.readinessPending;
    if (!force && host.readinessAt !== undefined && Date.now() - host.readinessAt < 30_000) return;
    const finish = context.beginIncludedToolObservation("computer");
    host.readinessPending = (async () => {
      try {
        // Execution has already used the helper. Observe its real permissions,
        // without launching it or prompting merely to refresh the UI.
        const result = await native.helper.probe({ launch: false, signal });
        if (!signal?.aborted) { finish(includedComputerStatus(result)); host.readinessAt = Date.now(); }
      } catch { /* Readiness evidence must never change the tool's result. */ }
      finally { host.readinessPending = undefined; }
    })();
    return host.readinessPending;
  }
  // Each factory owns its states, handles, output references and cancellation.
  // Only scheduling of the shared physical computer crosses Chat boundaries.
  const api = new Proxy(pi, {
    get(target, key, receiver) {
      if (key !== "registerTool") return Reflect.get(target, key, receiver);
      return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => pi.registerTool({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
        if (supportsIncludedComputer()) {
          args[2]?.throwIfAborted();
          try { await context.prepareComputerHelper?.(); }
          catch (error) {
            if (!args[2]?.aborted) context.beginIncludedToolObservation?.("computer")?.({ id: "computer", state: "unavailable", checkedAt: new Date().toISOString(), detail: "The computer helper could not be verified. Open setup to repair it." });
            throw error;
          }
          args[2]?.throwIfAborted();
          let failed = false;
          try { return await tool.execute(...args); }
          catch (error) { failed = true; throw error; }
          finally { void observeReadiness(args[2], failed); }
        }
        return {
        isError: true,
        content: [{ type: "text" as const, text: "Included computer control requires macOS 14 or later, or Windows 10 or later. This computer can still use the other Assistant tools." }],
        details: { error: "unsupported_platform", supportedOS: false },
        };
      } });
    },
  });
  return native.factory(api, {
    scheduler: native.scheduler,
    setupOnStart: false,
    restoreObservations: false,
    requireExplicitRoot: true,
    enableCdp: false,
    browserTools: false,
    interactiveSetup: false,
  });
}

function supportsIncludedComputer(): boolean {
  const major = Number.parseInt(release(), 10);
  return process.platform === "darwin" ? major >= 23 : process.platform === "win32" && major >= 10;
}
