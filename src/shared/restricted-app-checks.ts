/** A declaration requests one Check choice; only the host supplies its identity. */
export interface RestrictedAppCheckPermission {
  id: string;
  title: string;
}

export interface RestrictedAppCheckGrant {
  permissionId: string;
  title?: string;
  checkId: string;
  declarationDigest: string;
}

/** Content from exactly one selected Check. No transcript, run authority or file API. */
export interface RestrictedAppCheckResult {
  checkId: string;
  declarationDigest: string;
  title: string;
  state: "current-clear" | "needs-attention" | "never-run" | "stale" | "blocked" | "check-error" | "running";
  lastRunAt: string | null;
  findings: Array<{
    id: string;
    fingerprint: string;
    title: string;
    detail?: string;
    suggestion?: string;
    path: string;
    severity: "info" | "warning" | "error";
    observedAt: string;
    quotes: string[];
  }>;
  truncated: boolean;
}

export const restrictedAppCheckLimits = Object.freeze({ permissions: 8, findings: 64, resultBytes: 256 * 1024 });
