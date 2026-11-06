import { startLocalApi } from "./server.js";
import { includedToolsRoot } from "./agent/included-tools.js";
import { workFoldStateRoot } from "./state-paths.js";
import { createDevelopmentPagesBridge, loadLocalEnvironmentFile } from "./server-dev-options.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The API loads .env too; reading it first lets .env name the development bridge.
loadLocalEnvironmentFile(fileURLToPath(new URL("../../.env", import.meta.url)));
const pagesBridge = createDevelopmentPagesBridge();

await startLocalApi({ appMode: "dev", ...(pagesBridge ? { pagesBridge } : {}), piRuntimeProvider: { resolveRuntime: async () => ({ includedTools: {
  rootPath: includedToolsRoot(), stateRoot: join(workFoldStateRoot(), "assistant-tools"),
  helperAppPath: join(includedToolsRoot(), "..", "..", "out", "included-tools", "computer-helper", "work-fold Computer.app"),
} }) } }).then((api) => {
  console.log(`work-fold local API listening on ${api.origin}`);
  if (pagesBridge) console.log("Publishing pages through the development bridge (WORKFOLD_DEV_BRIDGE_URL).");
});
