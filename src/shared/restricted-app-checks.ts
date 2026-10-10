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

/**
 * `permissions` is a manifest count. `findings` and `resultBytes` only keep one
 * read's memory finite; in practice an app sees every finding the Check holds.
 */
export const restrictedAppCheckLimits = Object.freeze({ permissions: 256, findings: 10_000, resultBytes: 16 * 1024 * 1024 });
