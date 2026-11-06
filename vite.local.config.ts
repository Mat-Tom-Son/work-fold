import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { PAGE_FRAME_CONTENT_SECURITY_POLICY, PAGE_FRAME_HTML, PAGE_FRAME_SCRIPT } from "./src/local/pages/frame/page-frame-assets";

const apiPort = process.env.WORKFOLD_LOCAL_API_PORT ?? "4327";

export default defineConfig({
  root: "web-local",
  plugins: [react(), pageFrame()],
  server: {
    host: "localhost",
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: "../dist/web-local",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("web-local/index.html", import.meta.url)),
        popover: fileURLToPath(new URL("web-local/popover.html", import.meta.url)),
      },
    },
  },
});

/**
 * The page sandbox intermediary, served by the dev server the way the local
 * API serves it (docs/pages.md, "How a page runs"): same bytes, same policy.
 * The browser preview reaches it same-origin, so it needs no API running.
 */
function pageFrame(): Plugin {
  return {
    name: "work-fold-page-frame",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        const asset = path === "/page-frame.html" ? { body: PAGE_FRAME_HTML, type: "text/html; charset=utf-8" }
          : path === "/page-frame.js" ? { body: PAGE_FRAME_SCRIPT, type: "text/javascript; charset=utf-8" } : null;
        if (!asset) return next();
        response.writeHead(200, {
          "content-type": asset.type,
          "cache-control": "no-store",
          "content-security-policy": PAGE_FRAME_CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
        });
        response.end(asset.body);
      });
    },
  };
}
