import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChromeHostFacilities } from "../../src/shared/chrome-connection.js";
import type { IncludedToolStatus } from "../../src/shared/included-tools.js";

/** Optional native host context. It never crosses a renderer or restricted-app bridge. */
export function hostContext(pi: ExtensionAPI) {
  const query: { version: 1; context?: Partial<ChromeHostFacilities> & {
    version: 1; mode: "catalog" | "session"; cwd: string; agentDir: string; stateRoot: string;
    companionPath: string; helperAppPath?: string;
    prepareComputerHelper?: () => Promise<void>;
    beginIncludedToolObservation?: (id: "computer" | "documents") => (status: IncludedToolStatus) => IncludedToolStatus;
    getMcpOptions(): McpExtensionOptions & { disposeCredentials?: () => void };
    getSearchConfig(): Promise<{ provider: "duckduckgo" } | { provider: "brave"; apiKey: string }>;
  } } = { version: 1 };
  pi.events.emit("work-fold:extension-host:v1", query);
  return query.context;
}
