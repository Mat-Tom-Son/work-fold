import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { hostContext } from "../host.ts";

export default async function mcp(pi: ExtensionAPI) {
  const host = hostContext(pi);
  // The host supplies only its native global file and this registered Space's
  // native project file. Never discover another application's connections.
  const config = host ? await host.getMcpConfig() : { mcpServers: {} };
  return createMcpAdapter({
    config,
    ...(host ? { agentDir: host.agentDir } : {}),
    initializeAtLoad: false,
    initializeOnSessionStart: host?.mode !== "catalog",
    bootstrapLazyServers: false,
    hostSetupOnly: true,
    hostSetupMessage: "Open Skills & Extensions → Service connections to add, connect, or reconnect this service.",
  })(pi);
}
