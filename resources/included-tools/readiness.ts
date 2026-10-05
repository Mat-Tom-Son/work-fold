import type { IncludedToolStatus } from "../../src/shared/included-tools.js";

/** Only the helper's actual checks establish readiness: Accessibility and capture
 * on macOS, a live protocol-compatible UI Automation helper on Windows. */
export function includedComputerStatus(result: Record<string, any>): IncludedToolStatus {
  const permissions = result.permissionModel === "none" ? "none" as const : "macos" as const;
  return { id: "computer", checkedAt: new Date().toISOString(), computer: { permissions },
    state: result.status === "ready" ? "ready" : result.status === "not_running" ? "unknown" : result.status === "unavailable" || result.status === "error" ? "unavailable" : "setup_required",
    detail: result.status === "not_running" ? "The computer helper is idle. It starts when you use Computer Control; an idle helper is not a lost connection." : result.reason ?? (result.status === "ready" ? "Computer control is ready." : permissions === "none" ? "The computer helper could not be verified. Restart and recheck it." : "Allow work-fold Computer in Accessibility and Screen Recording, then recheck."),
    facts: {
      ...(permissions === "macos" ? { accessibility: result.accessibility === true, screenRecording: result.screenRecording === true } : {}),
      ...(result.helper?.bundleId ? { helper: String(result.helper.bundleId) } : result.helper?.name && permissions === "none" ? { helper: String(result.helper.name) } : {}),
      ...(result.helper?.appPath ? { path: String(result.helper.appPath) } : {}) },
  };
}
