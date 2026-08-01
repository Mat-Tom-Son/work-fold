import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const defaultHost = "0.0.0.0";
const defaultPort = 3000;

export async function startBridgeServer({
  host = process.env.HOST || defaultHost,
  port = parsePort(process.env.PORT),
} = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(response, "GET, HEAD");
      }
      return writeJson(response, 200, { ok: true, service: "work-fold-bridge", status: "ready" }, request.method);
    }

    if (url.pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(response, "GET, HEAD");
      }
      return writeJson(
        response,
        200,
        {
          ok: true,
          service: "work-fold-bridge",
          status: "placeholder",
          message: "The work-fold bridge endpoint is online.",
        },
        request.method,
      );
    }

    return writeJson(response, 404, { ok: false, error: "Not found" }, request.method);
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen({ host, port }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Bridge service did not bind a TCP address.");
  }

  return Object.freeze({
    host,
    port: address.port,
    close: () => closeServer(server),
  });
}

function parsePort(value) {
  if (value === undefined || value === "") return defaultPort;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("PORT must be an integer from 0 through 65535.");
  }
  return port;
}

function methodNotAllowed(response, allow) {
  response.setHeader("allow", allow);
  return writeJson(response, 405, { ok: false, error: "Method not allowed" });
}

function writeJson(response, status, value, method = "GET") {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : body);
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function run() {
  const service = await startBridgeServer();
  console.log(`work-fold bridge listening on ${service.host}:${service.port}`);

  const stop = async () => {
    await service.close();
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not start the work-fold bridge.");
    process.exitCode = 1;
  });
}
