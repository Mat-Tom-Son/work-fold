/**
 * Entry point of the page service bundle (`dist/server.mjs`); see
 * services/pages/README.md for configuration.
 */
import { pageServiceOptionsFromEnv, startPageService } from "./service.js";

const service = await startPageService(pageServiceOptionsFromEnv(process.env));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void service.close().finally(() => process.exit(0));
  });
}
