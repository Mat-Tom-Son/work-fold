import type { IncludedToolStatus } from "../../src/shared/included-tools.js";

/** Only the helper's actual Accessibility and capture checks establish readiness. */
export function includedComputerStatus(result: Record<string, any>): IncludedToolStatus {
  return { id: "computer", checkedAt: new Date().toISOString(),
    state: result.status === "ready" ? "ready" : result.status === "not_running" ? "unknown" : result.status === "unavailable" || result.status === "error" ? "unavailable" : "setup_required",
    detail: result.status === "not_running" ? "The computer helper is idle. It starts when you use Computer Control; an idle helper is not a lost connection." : result.reason ?? (result.status === "ready" ? "Computer control is ready." : "Allow work-fold Computer in Accessibility and Screen Recording."),
    // screenRecordingAllowed is macOS's answer; screenRecording is whether the running helper can capture,
    // which needs a helper restart after the person allows it.
    facts: { ...(result.platform ? { platform: String(result.platform) } : {}), ...(result.sessionType ? { session: String(result.sessionType) } : {}), accessibility: result.accessibility === true, screenRecording: result.screenRecording === true,
      ...(result.screenRecordingPreflight !== undefined ? { screenRecordingAllowed: result.screenRecordingPreflight === true } : {}),
      ...(result.supportedOS === false ? { supportedOS: false } : {}),
      ...(result.helper?.bundleId ? { helper: String(result.helper.bundleId) } : {}), ...(result.helper?.appPath ? { path: String(result.helper.appPath) } : {}) },
  };
}
