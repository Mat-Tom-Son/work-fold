import type { ModelContextDiagnosticsBridge } from "../../src/shared/model-context-diagnostics.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const diagnostics: ModelContextDiagnosticsBridge = {
  request: (input) => ipcRenderer.invoke("work-fold:diagnostics:request", input),
  close: () => ipcRenderer.invoke("work-fold:diagnostics:close"),
  clipboard: {
    write: (content) => ipcRenderer.invoke("work-fold:clipboard:write", content),
  },
};

contextBridge.exposeInMainWorld("workFoldDiagnostics", diagnostics);
