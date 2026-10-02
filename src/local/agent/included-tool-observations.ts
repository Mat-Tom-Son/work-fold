import type { IncludedToolId, IncludedToolStatus } from "../../shared/included-tools.js";
import type { ResolvedPiRuntime } from "./pi-runtime-config.js";

const observations = new Map<string, { revision: number; status?: IncludedToolStatus }>();
const key = (runtime: ResolvedPiRuntime, id: IncludedToolId) => JSON.stringify([
  runtime.config.includedTools?.stateRoot, runtime.config.includedTools?.rootPath,
  runtime.config.includedTools?.helperAppPath, runtime.agentDir, id,
]);

/** Evidence belongs to this host/profile and its exact runtime, never to a renderer. */
export function includedToolObservation(runtime: ResolvedPiRuntime, id: IncludedToolId): IncludedToolStatus | undefined {
  const status = observations.get(key(runtime, id))?.status;
  if (!status) return undefined;
  // Bundled document libraries belong to the immutable running build. Computer
  // permissions can change outside the host, so older evidence stays historical.
  return { ...status, stale: id !== "documents" && Date.now() - Date.parse(status.checkedAt) >= 5 * 60_000 };
}

/** Reserve ordering before native work starts; a later check always wins. */
export function beginIncludedToolObservation(runtime: ResolvedPiRuntime, id: IncludedToolId, invalidate = false) {
  const identity = key(runtime, id);
  const previous = observations.get(identity);
  const revision = (previous?.revision ?? 0) + 1;
  observations.set(identity, { revision, ...(!invalidate && previous?.status ? { status: previous.status } : {}) });
  return (status: IncludedToolStatus): IncludedToolStatus => {
    if (observations.get(identity)?.revision === revision) {
      const next = { ...status, id, checkedAt: new Date().toISOString(), stale: false };
      observations.set(identity, { revision, status: next });
      return next;
    }
    return includedToolObservation(runtime, id) ?? { id, state: "unknown", detail: "A newer setup check started.", checkedAt: new Date().toISOString() };
  };
}
