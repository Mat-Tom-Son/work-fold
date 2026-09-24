/**
 * Shared presentation for routings (user-facing: Automations). Settings →
 * Automations, the Folder-owned Automations tab, and the local API's
 * `GET /api/spaces/:id/automations` read all describe a trigger with the one
 * summary here, so the three never drift (docs/fold-routings.md).
 */

export type RoutingTriggerView =
  | { kind: "files-changed"; spaceId: string; watch: { kind: "tree"; path: string; recursive: boolean; extensions: string[] }; debounceSeconds: number; cooldownMinutes: number; summary?: string }
  | { kind: "manual"; summary?: string }
  | { kind: "interval"; intervalMinutes: number; summary?: string }
  | { kind: "at"; at: string; ifMissed: "run" | "skip"; summary?: string }
  | {
    kind: "on-settled";
    summary?: string;
    source: {
      kind: "check-run" | "app-automation-run";
      spaceId: string;
      spaceName?: string;
      checkId?: string;
      appId?: string;
      automationId?: string;
      outcomes?: string[];
    };
  };

export type RoutingOutcome = "accepted" | "succeeded" | "failed" | "stopped" | "interrupted" | "skipped" | "lapsed";

export function routingTriggerSummary(trigger: RoutingTriggerView): string {
  if (trigger.summary) return trigger.summary;
  if (trigger.kind === "files-changed") return `When ${trigger.watch.path} changes · wait ${trigger.debounceSeconds}s · ${trigger.cooldownMinutes} minute cooldown`;
  if (trigger.kind === "manual") return "Manual only";
  if (trigger.kind === "interval") return `Every ${formatRoutingMinutes(trigger.intervalMinutes)}`;
  if (trigger.kind === "at") return `Once · ${formatRoutingDateTime(trigger.at)}`;
  const source = trigger.source;
  const space = source.spaceName ?? source.spaceId;
  if (source.kind === "check-run") return `After a Check settles in ${space}`;
  return `After ${source.appId} · ${source.automationId} settles in ${space}`;
}

export function formatRoutingMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

export function formatRoutingDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * What an automation does in one Folder, from its declaration: its trigger
 * watches the Folder (a folder change, or a Check or app automation settling
 * there), a files step copies into or out of it, a chat step starts a Chat
 * there, or a check step runs a Check there.
 */
export type FolderAutomationRole = "watches" | "copies-to" | "copies-from" | "chats-here" | "checks-here";
export const folderAutomationRoles: readonly FolderAutomationRole[] = ["watches", "copies-to", "copies-from", "chats-here", "checks-here"];

/** One state word per row; `completed` is a one-time automation that already ran. */
export type FolderAutomationState = "on" | "off" | "running" | "suspended" | "completed";

export interface FolderAutomationView {
  routingId: string;
  title: string;
  state: FolderAutomationState;
  triggerSummary: string;
  nextRunAt: string | null;
  lastRun: { at: string; outcome: RoutingOutcome } | null;
  roles: FolderAutomationRole[];
}

export interface FolderAutomationsResponse {
  automations: FolderAutomationView[];
}
