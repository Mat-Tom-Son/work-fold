import { startLocalApi } from "./server.js";

await startLocalApi({ appMode: "dev" }).then((api) => {
  console.log(`work-fold local API listening on ${api.origin}`);
});
