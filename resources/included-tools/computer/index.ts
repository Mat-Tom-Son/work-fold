import { createHash } from "node:crypto";
import { homedir, release } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostContext } from "../host.ts";

export type IncludedComputerConfig = { helperAppPath: string; stateRoot: string; prepareComputerHelper?: () => Promise<void>; repairComputerHelper?: (beforeReplace: () => Promise<void>) => Promise<void> };
export type IncludedComputerSetupAction = "request-permissions" | "accessibility" | "screen-recording" | "recheck";

type NativeModules = {
  factory: typeof import("@injaneity/pi-computer-use/extensions/computer-use.ts").default;
  permissions: typeof import("@injaneity/pi-computer-use/src/platform/macos/permissions.ts");
  helper: typeof import("@injaneity/pi-computer-use/src/platform/macos/helper.ts");
  scheduler: InstanceType<typeof import("@injaneity/pi-computer-use/src/runtime.ts").ResourceScheduler>;
};
type HostRuntime = { config: IncludedComputerConfig; socketPath: string; native: Promise<NativeModules> };
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
  if (process.env.PI_CU_SOCKET_PATH) throw new Error("The included computer helper cannot use an externally configured PI_CU_SOCKET_PATH.");
  // Unix sockets have a short path limit. The profile digest isolates development,
  // smoke and production without depending on the length of their state roots.
  const profile = createHash("sha256").update(normalized.stateRoot).digest("hex").slice(0, 20);
  const socketPath = join(homedir(), "Library", "Caches", "work-fold", `computer-${profile}.sock`);
  if (Buffer.byteLength(socketPath) >= 104) throw new Error("The computer helper socket path exceeds macOS's supported length.");
  for (const [key, value] of Object.entries({
    PI_COMPUTER_USE_HELPER_APP_PATH: normalized.helperAppPath,
    PI_COMPUTER_USE_OWNED_SOCKET_PATH: socketPath,
    PI_COMPUTER_USE_NO_RUNTIME_INSTALL: "1",
  })) {
    if (process.env[key] && process.env[key] !== value) throw new Error(`Conflicting computer helper configuration: ${key}.`);
  }
  Object.assign(process.env, {
    PI_COMPUTER_USE_HELPER_APP_PATH: normalized.helperAppPath,
    PI_COMPUTER_USE_OWNED_SOCKET_PATH: socketPath,
    PI_COMPUTER_USE_NO_RUNTIME_INSTALL: "1",
  });
  const native = (async () => {
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
    return { factory: factory.default, permissions, helper, scheduler: new scheduling.ResourceScheduler() };
  })();
  return globals[runtimeKey] = { config: normalized, socketPath, native };
}

export async function probeIncludedComputer(config: IncludedComputerConfig, options: { launch?: boolean; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  if (options.launch && supportsIncludedComputer()) await prepareForSetup(config, options.signal);
  options.signal?.throwIfAborted();
  const { permissions } = await runtime(config).native;
  return permissions.probeMacosComputerUse(options);
}

export async function setupIncludedComputer(config: IncludedComputerConfig, action: IncludedComputerSetupAction, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (supportsIncludedComputer()) await prepareForSetup(config, signal);
  signal?.throwIfAborted();
  const { permissions } = await runtime(config).native;
  if (!supportsIncludedComputer()) return permissions.probeMacosComputerUse({ signal });
  return permissions.setupMacosComputerUse(action, signal);
}

async function prepareForSetup(config: IncludedComputerConfig, signal?: AbortSignal) {
  if (!config.repairComputerHelper) { await config.prepareComputerHelper?.(); return; }
  // These exported setup functions are called by the trusted host under its
  // global capability mutation fence. Native model tools receive no repair callback.
  await config.repairComputerHelper(async () => {
    signal?.throwIfAborted();
    const { helper } = await runtime(config).native;
    try {
      await helper.macosHelper.daemonCommand("shutdown", {}, 2_000, signal);
      // The native shutdown acknowledgement precedes its scheduled exit by 200ms.
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      if (!/ENOENT|ECONNREFUSED/.test(String((error as Error).message))) throw new Error("Quit work-fold and reopen it before repairing the computer helper.");
    }
    signal?.throwIfAborted();
  });
}

/** Called after host sessions stop. Never launches a helper just to shut it down. */
export async function shutdownIncludedComputer(config: IncludedComputerConfig): Promise<void> {
  if (!globals[runtimeKey]) return;
  const { helper, scheduler } = await runtime(config).native;
  await scheduler.close();
  try {
    await helper.macosHelper.daemonCommand("shutdown", {}, 2_000);
  } catch {
    // A helper that has never started or already quit has nothing to shut down.
  }
}

export default async function includedComputer(pi: ExtensionAPI) {
  const context = hostContext(pi);
  if (!context?.helperAppPath) throw new Error("The included computer Extension requires its bundled helper configuration.");
  const native = await runtime({ helperAppPath: context.helperAppPath, stateRoot: context.stateRoot }).native;
  // Each factory owns its states, handles, output references and cancellation.
  // Only scheduling of the shared physical computer crosses Chat boundaries.
  const api = new Proxy(pi, {
    get(target, key, receiver) {
      if (key !== "registerTool") return Reflect.get(target, key, receiver);
      return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => pi.registerTool({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
        if (supportsIncludedComputer()) {
          args[2]?.throwIfAborted();
          await context.prepareComputerHelper?.();
          args[2]?.throwIfAborted();
          return tool.execute(...args);
        }
        return {
        isError: true,
        content: [{ type: "text" as const, text: "Included computer control requires macOS 14 or later. This computer can still use the other Assistant tools." }],
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
  return process.platform === "darwin" && Number.parseInt(release(), 10) >= 23;
}
