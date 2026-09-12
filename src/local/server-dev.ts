import { startLocalApi } from "./server.js";
import { includedToolsRoot } from "./agent/included-tools.js";
import { workFoldStateRoot } from "./state-paths.js";
import { join } from "node:path";

await startLocalApi({ appMode: "dev", piRuntimeProvider: { resolveRuntime: async () => ({ includedTools: {
  rootPath: includedToolsRoot(), stateRoot: join(workFoldStateRoot(), "assistant-tools"),
  helperAppPath: join(includedToolsRoot(), "..", "..", "out", "included-tools", "computer-helper", "work-fold Computer.app"),
} }) } }).then((api) => {
  console.log(`work-fold local API listening on ${api.origin}`);
});
