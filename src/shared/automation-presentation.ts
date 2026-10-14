/**
 * Shared presentation for automations (user-facing: Automations). Settings →
 * Automations, the work-folder-owned Automations tab, and the local API's
 * `GET /api/work-folders/:id/automations` read all describe a trigger with the one
 * summary here, so the three never drift (docs/automations.md).
 */

export type AutomationTriggerView =
  | { kind: "files-changed"; workFolderId: string; watch: { kind: "tree"; path: string; recursive: boolean; extensions: string[] }; debounceSeconds: number; cooldownMinutes: number; ifMissed?: "run" | "skip"; summary?: string }
  | { kind: "manual"; summary?: string }
  | { kind: "interval"; intervalMinutes: number; summary?: string }
  | { kind: "at"; at: string; ifMissed: "run" | "skip"; summary?: string }
  | {
    kind: "on-settled";
    summary?: string;
    source: {
      kind: "check-run" | "app-automation-run";
      workFolderId: string;
      workFolderName?: string;
      checkId?: string;
      appId?: string;
      appAutomationId?: string;
      outcomes?: string[];
    };
  };

export type AutomationOutcome = "accepted" | "succeeded" | "failed" | "stopped" | "interrupted" | "skipped" | "lapsed";

/**
 * Why a folder-change automation that declares `"ifMissed": "run"` caught up:
 * the gap during which work-fold could not watch its folder
 * (docs/automations.md, 2026-10-11 amendment).
 */
export type AutomationCatchUpReason = "closed" | "asleep" | "off" | "unavailable";
export const automationCatchUpReasons: readonly AutomationCatchUpReason[] = ["closed", "asleep", "off", "unavailable"];

/** The gap a catch-up covers, as the end of a plain sentence. */
export function automationCatchUpGap(reason: AutomationCatchUpReason): string {
  switch (reason) {
    case "closed":
      return "while work-fold was closed";
    case "asleep":
      return "while the computer was asleep";
    case "off":
      return "while this automation was off";
    default:
      return "while the folder could not be watched";
  }
}

/** "Caught up on 3 files that changed while work-fold was closed", or the waiting form. */
export function automationCatchUpSentence(count: number, reason: AutomationCatchUpReason, waiting = false): string {
  return `${waiting ? "Catching up" : "Caught up"} on ${count} ${count === 1 ? "file" : "files"} that changed ${automationCatchUpGap(reason)}`;
}

export function automationTriggerSummary(trigger: AutomationTriggerView): string {
  if (trigger.summary) return trigger.summary;
  if (trigger.kind === "files-changed") {
    return `When ${trigger.watch.path} changes · wait ${trigger.debounceSeconds}s · ${trigger.cooldownMinutes} minute cooldown`
      + (trigger.ifMissed === "run" ? " · catches up after work-fold was closed" : "");
  }
  if (trigger.kind === "manual") return "Manual only";
  if (trigger.kind === "interval") return `Every ${formatAutomationMinutes(trigger.intervalMinutes)}`;
  if (trigger.kind === "at") return `Once · ${formatAutomationDateTime(trigger.at)}`;
  const source = trigger.source;
  const workFolder = source.workFolderName ?? source.workFolderId;
  if (source.kind === "check-run") return `After a Check settles in ${workFolder}`;
  return `After ${source.appId} · ${source.appAutomationId} settles in ${workFolder}`;
}

export function formatAutomationMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

export function formatAutomationDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * What an automation does in one work-folder, from its declaration: its trigger
 * watches the work-folder (a folder change, or a Check or app automation settling
 * there), a files step copies into or out of it, a chat step starts a Chat
 * there, or a check step runs a Check there.
 */
export type FolderAutomationRole = "watches" | "copies-to" | "copies-from" | "chats-here" | "checks-here";
export const folderAutomationRoles: readonly FolderAutomationRole[] = ["watches", "copies-to", "copies-from", "chats-here", "checks-here"];

/** One state word per row; `completed` is a one-time automation that already ran. */
export type FolderAutomationState = "on" | "off" | "running" | "suspended" | "completed";

export interface FolderAutomationView {
  automationId: string;
  title: string;
  state: FolderAutomationState;
  triggerSummary: string;
  nextRunAt: string | null;
  /** `partial`: it succeeded, but a step's Worker reported finishing only partly. */
  lastRun: { at: string; outcome: AutomationOutcome; partial?: true } | null;
  roles: FolderAutomationRole[];
}

export interface FolderAutomationsResponse {
  automations: FolderAutomationView[];
}
