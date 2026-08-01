import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.WORKFOLD_LOCAL_API_PORT ?? "4327";

export default defineConfig({
  root: "web-local",
  plugins: [react()],
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
