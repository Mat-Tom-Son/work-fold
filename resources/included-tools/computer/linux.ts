import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IncludedComputerConfig } from "./index.ts";
import type { ComputerHostFacilities } from "../../../src/shared/computer-session.js";

type Native = {
  path: string; stateRoot: string;
  factory: typeof import("@injaneity/pi-computer-use/extensions/computer-use.ts").default;
  helper: typeof import("@injaneity/pi-computer-use/src/platform/linux/helper.ts").linuxHelper;
  scheduler: InstanceType<typeof import("@injaneity/pi-computer-use/src/runtime.ts").ResourceScheduler>;
};
const key = Symbol.for("work-fold:included-linux-computer-host:v1");
const host = globalThis as typeof globalThis & { [key]?: Promise<Native> };

async function verify(config: IncludedComputerConfig) {
  const binary = resolve(config.helperAppPath);
  const source = JSON.parse(await readFile(join(dirname(binary), "source.json"), "utf8"));
  if (source.schema !== "work-fold.computer-helper-source.v1" || source.target !== "x86_64-unknown-linux-gnu" || source.protocolVersion !== 4
    || source.binarySha256 !== createHash("sha256").update(await readFile(binary)).digest("hex")
    || !((await stat(binary)).mode & 0o111)) throw new Error("The bundled Linux computer helper changed. Rebuild or reinstall work-fold.");
}
async function native(config: IncludedComputerConfig): Promise<Native> {
  const path = resolve(config.helperAppPath), stateRoot = resolve(config.stateRoot);
  if (!host[key]) {
    const overrides = { PI_COMPUTER_USE_LINUX_HELPER_PATH: path, PI_COMPUTER_USE_NO_RUNTIME_INSTALL: "1" };
    for (const [name, value] of Object.entries(overrides)) {
      if (process.env[name] && process.env[name] !== value) throw new Error(`Conflicting computer helper configuration: ${name}`);
    }
    Object.assign(process.env, overrides);
    host[key] = (async () => {
      const factory = await import("@injaneity/pi-computer-use/extensions/computer-use.ts");
      const helper = await import("@injaneity/pi-computer-use/src/platform/linux/helper.ts");
      const runtime = await import("@injaneity/pi-computer-use/src/runtime.ts");
      if (helper.LINUX_HELPER_PATH !== path) throw new Error("Restart work-fold to load its bundled Linux computer helper.");
      return { path, stateRoot, factory: factory.default, helper: helper.linuxHelper, scheduler: new runtime.ResourceScheduler() };
    })();
  }
  const result = await host[key]!;
  if (result.path !== path || result.stateRoot !== stateRoot) throw new Error("The Linux helper is already owned by another work-fold profile.");
  return result;
}
export async function probeLinuxComputer(config: IncludedComputerConfig, options: { launch?: boolean; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const runtime = await native(config);
  if (!options.launch) return { platform: "linux", sessionType: process.env.XDG_SESSION_TYPE, status: "not_running", reason: "Check Linux accessibility to verify computer control." };
  try {
    await verify(config);
    const result = await runtime.helper.command<Record<string, unknown>>("diagnostics", {}, { signal: options.signal, timeoutMs: 10_000 });
    const wayland = result.sessionType === "wayland";
    return {
      platform: "linux", sessionType: String(result.sessionType),
      status: result.accessibility ? "ready" : "setup_required", accessibility: result.accessibility === true,
      screenRecording: !wayland && result.screenRecording === true,
      reason: !result.accessibility ? "Linux accessibility is unavailable. Enable accessibility in your desktop session, then check again."
        : wayland ? "Accessibility actions are ready. Use desktop sharing setup to share a screen with work-fold for Wayland screenshots and physical input in any Chat."
          : "Linux accessibility and X11 computer control are ready.",
      helper: { appPath: config.helperAppPath },
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
export async function shutdownLinuxComputer() {
  if (!host[key]) return;
  const runtime = await host[key]!;
  await runtime.scheduler.close(); runtime.helper.dispose();
}
export async function linuxComputer(pi: ExtensionAPI, config: IncludedComputerConfig, screens?: Partial<ComputerHostFacilities>) {
  const runtime = await native(config);
  const sharedScreens = screens?.listSharedScreens && screens.observeSharedScreen && screens.actOnSharedScreen ? {
    list: screens.listSharedScreens, observe: screens.observeSharedScreen, act: screens.actOnSharedScreen,
    shutdown: screens.releaseSharedScreenSession,
  } : undefined;
  const screenGuidance: Record<string, string> = {
    find_roots: 'For Wayland screenshots and physical input, discover the granted monitor with kind: "shared_screen". It represents a whole monitor, so omit application-title, PID and application filters when finding it.',
    observe_ui: 'For a shared_screen root, use mode: "visual" or "fused". It has no semantic tree; an application accessibility root is separate from the shared monitor.',
    act_ui: 'For shared_screen states, use physical actions without refs. To scroll, first moveMouse to x/y inside the intended area, then scroll with scrollY/scrollX and no ref; these can be in one actions array. To drag, supply a path of x/y points. For keyboard shortcuts, pass separate key names, for example keys: ["ctrl", "a"], not ["ctrl+a"]. Keyboard input affects the focused application; click the intended field first and verify the successor image.',
  };
  const api = new Proxy(pi, { get(target, key, receiver) {
    if (key !== "registerTool") return Reflect.get(target, key, receiver);
    return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => pi.registerTool({ ...tool,
      description: sharedScreens && screenGuidance[tool.name] ? `${tool.description}\n\n${screenGuidance[tool.name]}` : tool.description,
      ...(sharedScreens && screenGuidance[tool.name] ? { promptGuidelines: [...(tool.promptGuidelines ?? []), screenGuidance[tool.name]] } : {}),
      execute: async (...args: Parameters<typeof tool.execute>) => {
      args[2]?.throwIfAborted(); await verify(config); args[2]?.throwIfAborted();
      return tool.execute(...args);
    } });
  } });
  return runtime.factory(api, { scheduler: runtime.scheduler, setupOnStart: false, restoreObservations: false,
    ...(sharedScreens ? { sharedScreens } : {}),
    requireExplicitRoot: true, enableCdp: false, browserTools: false, interactiveSetup: false });
}
