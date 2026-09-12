import type { ModelContextDiagnosticsBridge } from "../../src/shared/model-context-diagnostics";

declare global {
  interface Window {
    workFoldDiagnostics?: ModelContextDiagnosticsBridge;
  }
}
