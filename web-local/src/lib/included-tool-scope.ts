/**
 * The included tools are machine-wide (2026-10-11): their setup reads and acts
 * through a work-folder when one is open, and the work-fold agent's scope
 * otherwise, as on first run.
 */
export function includedToolsPath(workFolderId?: string): string {
  return workFolderId ? `/api/agent/included-tools?workFolderId=${encodeURIComponent(workFolderId)}` : "/api/agent/included-tools";
}

export function includedToolSetupBody(workFolderId: string | undefined, id: string, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(workFolderId ? { workFolderId } : {}), id, action, ...extra };
}
