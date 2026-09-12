/** The developer window receives diagnostics, never the local API credential. */
export interface ModelContextDiagnosticsBridge {
  request(input: { path: string; body?: unknown }): Promise<unknown>;
  close(): Promise<void>;
}
