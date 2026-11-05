// Local development only: the bridge on the in-memory PostgreSQL stand-in the
// bridge tests use (pg-mem), with public enrollment on, so the remote client
// and the whole online-pages flow run without a database server. Every
// address, session, and pairing is lost when the process stops. Online pages
// use the same WORKFOLD_PAGES_* settings as production; without them the page
// routes answer "Online pages aren't available yet."
//
//   PORT=8790 npm run dev:memory --prefix services/bridge
import { newDb } from "pg-mem";

import { BridgeDatabase } from "../database.mjs";
import { startBridgeServer } from "../server.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = parsePort(process.env.PORT ?? "8790");
const memory = newDb({ autoCreateForeignKeyIndices: true });
const adapter = memory.adapters.createPg();
const pool = new adapter.Pool();
const database = new BridgeDatabase({ pool });

const service = await startBridgeServer({
  host,
  port,
  database,
  publicEnrollment: true,
  metrics: process.env.WORKFOLD_BRIDGE_DEV_METRICS === "1" ? undefined : false,
});
const origin = `http://${host.includes(":") ? `[${host}]` : host}:${service.port}`;
const pagesOn = Boolean(process.env.WORKFOLD_PAGES_INTERNAL_URL);
console.log(`work-fold bridge (in-memory database) listening on ${origin}`);
console.log(`  Desktop:  WORKFOLD_REMOTE_BRIDGE_URL=${origin}`);
console.log(`  Browser:  ${origin}/?slug=<your address>`);
console.log(`  Online pages: ${pagesOn ? "on (WORKFOLD_PAGES_* settings)" : "off (set WORKFOLD_PAGES_INTERNAL_URL, WORKFOLD_PAGES_INTERNAL_SECRET, and WORKFOLD_PAGES_PUBLIC_ORIGIN)"}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await service.close();
  await pool.end();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function parsePort(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535) {
    console.error("PORT must be an integer from 0 through 65535.");
    process.exit(1);
  }
  return number;
}
