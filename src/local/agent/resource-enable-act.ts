import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolvePiRuntime, type PiRuntimeProvider } from "./pi-runtime-config.js";
import { resolveNativeResources, setNativeResourceEnabled, type NativeResourceKind } from "./resource-lifecycle.js";
import { prepareFoldAct, type FoldPreparedAct, type FoldPreparedActAdapter } from "../fold-prepared-acts.js";

export interface ResourceEnableInput { path: string; kind: NativeResourceKind; enabled: boolean; scope: "personal" | "space"; spaceId?: string }
async function identity(root: string, input: ResourceEnableInput, provider?: PiRuntimeProvider) {
  const runtime = await resolvePiRuntime(root, provider, { requestProjectTrust: false });
  const nativeScope = input.scope === "space" ? "project" : "user";
  const resource = (await resolveNativeResources(root, runtime)).find((item) => resolve(item.path) === resolve(input.path) && item.kind === input.kind && item.metadata.scope === nativeScope);
  if (!resource) throw new Error("The resource is no longer present in the requested scope.");
  const settings = nativeScope === "project" ? runtime.settingsManager.getProjectSettings() : runtime.settingsManager.getGlobalSettings();
  const digest = createHash("sha256").update(await readFile(resource.path)).update(JSON.stringify({ metadata: resource.metadata, settings })).digest("hex");
  return { resource, digest };
}
export async function prepareResourceEnable(root: string, input: ResourceEnableInput, provider?: PiRuntimeProvider): Promise<FoldPreparedAct> {
  const { resource, digest } = await identity(root, input, provider);
  return prepareFoldAct({ kind: "capability.resource.enabled", parameters: { path: resource.path, kind: input.kind, enabled: input.enabled, scope: input.scope, ...(input.spaceId ? { spaceId: input.spaceId } : {}) }, pins: { path: resource.path, digest, scope: input.scope } });
}
export function resourceEnableAdapter(rootFor: (act: FoldPreparedAct) => Promise<string>, provider?: PiRuntimeProvider): FoldPreparedActAdapter {
  const inputFor = (act: FoldPreparedAct): ResourceEnableInput => ({ path: String(act.parameters.path), kind: act.parameters.kind as NativeResourceKind, enabled: act.parameters.enabled === true, scope: act.parameters.scope as "personal" | "space" });
  const recheck = async (act: FoldPreparedAct) => {
    try { return (await identity(await rootFor(act), inputFor(act), provider)).digest === act.pins.digest ? null : "The resource or its native settings changed. Refresh and try again."; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  return {
    recheckPins: recheck,
    async execute(act) {
      const issue = await recheck(act); if (issue) throw new Error(issue);
      const input = inputFor(act);
      await setNativeResourceEnabled(await rootFor(act), { ...input, scope: input.scope === "space" ? "project" : "user" }, provider);
      return { detail: `Turned ${input.enabled ? "on" : "off"} ${input.kind} resource ${input.path}.` };
    },
  };
}
