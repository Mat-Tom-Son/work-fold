// Types for the TypeScript callers of engines.mjs (the document evaluation
// checker and tests). The runtime module stays plain JavaScript.
import type { DocumentEngineSearch, DocumentEnginesDiscovery } from "../readiness.ts";

export function discoverDocumentEngines(search?: DocumentEngineSearch): Promise<DocumentEnginesDiscovery>;

export interface DocumentEngineRunOptions {
  operation: "render" | "recalculate" | "ocr" | "preview";
  source: string;
  output: string;
  enginePath?: string;
  language?: string;
  slide?: number;
  timeoutMs?: number;
  cwd?: string;
  stateRoot?: string;
  search?: DocumentEngineSearch;
  signal?: AbortSignal;
}

export interface DocumentEngineRunResult {
  operation: DocumentEngineRunOptions["operation"];
  source: unknown;
  output: { path: string; sha256: string; sizeBytes: number };
  engine: { name: "libreoffice" | "tesseract" | "quicklook"; executable: string; version: unknown };
  logPath: string;
  shows?: string;
  note: string;
  retention: string;
}

export function runDocumentEngine(options: DocumentEngineRunOptions): Promise<DocumentEngineRunResult>;

export function registerDocumentEngineTools(pi: any, host?: any): void;
