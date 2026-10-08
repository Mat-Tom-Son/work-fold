import { createMcpExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostContext } from "../host.ts";

/** Native Pi MCP. Trusted settings own setup, and catalog sessions never connect. */
export default async function serviceConnections(pi: ExtensionAPI) {
  const host = hostContext(pi);
  const options = host?.getMcpOptions?.() ?? { loadConfig: () => ({ servers: [], errors: [] }) };
  pi.on("session_shutdown", () => { host?.getMcpOptions?.().disposeCredentials?.(); });
  const native = createMcpExtension(options);
  return native({ ...pi, registerCommand(name, command) {
    if (name !== "mcp") return pi.registerCommand(name, command);
    pi.registerCommand(name, { ...command, description: "Show service connections; use Skills & Extensions for setup",
      async handler(args, ctx) {
        if (args.trim()) { ctx.ui.notify("Open Skills & Extensions → Service Connections to sign in or change a connection.", "info"); return; }
        return command.handler("", ctx);
      },
    });
  } });
}
