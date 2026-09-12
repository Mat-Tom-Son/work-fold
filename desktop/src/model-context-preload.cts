import type { ModelContextDiagnosticsBridge } from "../../src/shared/model-context-diagnostics.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const diagnostics: ModelContextDiagnosticsBridge = {
  request: (input) => ipcRenderer.invoke("work-fold:diagnostics:request", input),
  close: () => ipcRenderer.invoke("work-fold:diagnostics:close"),
};

contextBridge.exposeInMainWorld("workFoldDiagnostics", diagnostics);
