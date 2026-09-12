export const includedToolDefinitions = [
  { id: "computer", title: "Computer control", package: "@injaneity/pi-computer-use", version: "0.5.1", description: "Observe and operate desktop apps, with screenshots and accessibility information." },
  { id: "chrome", title: "Chrome", package: "pi-chrome", version: "0.15.51", description: "Work in your signed-in Chrome profile using separate targets for each Chat." },
  { id: "web", title: "Web", package: "pi-web-access", version: "0.29.0", description: "Search the web and read pages. An optional Brave connection is available." },
  { id: "mcp", title: "Service connections", package: "pi-mcp-adapter", version: "2.33.0", description: "Connect standard MCP tools and services using native Pi discovery." },
  { id: "documents", title: "Documents", package: "work-fold-document-tools", version: "1.0.0", description: "Create and inspect ordinary documents, spreadsheets, presentations, and PDFs." },
] as const;
export type IncludedToolDefinition = typeof includedToolDefinitions[number];
export type IncludedToolId = typeof includedToolDefinitions[number]["id"];

export type IncludedToolReadiness = "ready" | "setup_required" | "unavailable" | "unknown";
export interface IncludedToolStatus { id: IncludedToolId; state: IncludedToolReadiness; detail: string; checkedAt: string; facts?: Record<string, string | boolean>; }
