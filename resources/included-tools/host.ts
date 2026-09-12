import type { McpConfig } from "pi-mcp-adapter/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Optional native host context. It never crosses a renderer or restricted-app bridge. */
export function hostContext(pi: ExtensionAPI) {
  const query: { version: 1; context?: {
    version: 1; mode: "catalog" | "session"; cwd: string; agentDir: string; stateRoot: string;
    companionPath: string; helperAppPath?: string;
    getMcpConfig(): Promise<McpConfig>;
    getSearchConfig(): Promise<{ provider: "duckduckgo" } | { provider: "brave"; apiKey: string }>;
  } } = { version: 1 };
  pi.events.emit("work-fold:extension-host:v1", query);
  return query.context;
}
