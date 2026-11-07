import { version as packageVersion } from "../../../package.json";
import type {
  AutomationDetailResponse,
  AutomationDetailView,
  AutomationHistoryResponse,
  AutomationProposalsResponse,
  AutomationsResponse,
  AutomationWorkFolderRef,
} from "../components/modals/AutomationsPane";
import type { RecentlyDeletedResponse } from "../components/modals/RecentlyDeletedPane";
import type { DesktopUpdateStatus } from "../types";

/**
 * Sample Settings data for the browser preview (`?fixture=work-folder`): the
 * pages that read from the desktop bridge or the local API — Recently Deleted,
 * Automations, and About — show this instead, so the preview looks
 * like the shipped Mac app. Nothing here is a real address, account, or secret.
 */

/** The release the preview stands in for: the version in the root package.json. */
export const fixtureAppVersion: string = packageVersion;

/** About → Updates as the Mac app shows it after a check found nothing newer. */
export function buildFixtureUpdateStatus(): DesktopUpdateStatus {
  return {
    supported: true,
    phase: "not_available",
    currentVersion: fixtureAppVersion,
    availableVersion: null,
    progressPercent: null,
    checkedAt: "2026-11-04T08:15:00.000Z",
    message: `work-fold ${fixtureAppVersion} is up to date.`,
    error: null,
  };
}

const days = 24 * 60 * 60 * 1_000;
const keptUntil = (deletedAt: string, retentionDays = 30) => new Date(Date.parse(deletedAt) + retentionDays * days).toISOString();

/**
 * Settings → Recently Deleted with one item of each common kind: a Chat, a
 * file too large for History, an Everywhere Skill, app data whose app is gone
 * (save-only), and a deleted work-folder held because its tree carries legacy
 * Workspace records.
 */
export function buildFixtureRecentlyDeleted(): RecentlyDeletedResponse {
  const chatDeletedAt = "2026-11-03T21:14:00.000Z";
  const fileDeletedAt = "2026-11-01T16:42:00.000Z";
  const skillDeletedAt = "2026-10-27T09:05:00.000Z";
  const appDataDeletedAt = "2026-10-19T18:30:00.000Z";
  const workFolderDeletedAt = "2026-10-02T14:20:00.000Z";
  return {
    retentionDays: 30,
    damaged: [],
    entries: [
      {
        id: "trash-20261103211400-6f1c2a9d",
        kind: "file",
        reason: "chats.delete",
        workFolderId: "fixture-home",
        workFolderName: "Home projects",
        originalPath: ".work-fold/conversations/chat-3b8e0f52-1c7a-4d2e-9a61-5f0c8e7b2d14.jsonl",
        name: "Paint color shortlist",
        sizeBytes: 38_912,
        deletedAt: chatDeletedAt,
        restoreBy: keptUntil(chatDeletedAt),
        receiptId: null,
        restorable: "in-place",
      },
      {
        id: "trash-20261101164200-a24d7e10",
        kind: "file",
        reason: "files.delete",
        workFolderId: "fixture-home",
        workFolderName: "Home projects",
        originalPath: "Kitchen refresh/walkthrough.mov",
        name: "walkthrough.mov",
        sizeBytes: 1_718_000_000,
        deletedAt: fileDeletedAt,
        restoreBy: keptUntil(fileDeletedAt),
        receiptId: null,
        uncovered: [{ path: "Kitchen refresh/walkthrough.mov", reason: "too_large" }],
        restorable: "in-place",
      },
      {
        id: "trash-20261027090500-0c9b4f63",
        kind: "skill",
        reason: "skills.remove",
        workFolderId: "work-fold-agent",
        workFolderName: "Everywhere",
        scope: "everywhere",
        originalPath: "skills/meal-planner",
        name: "meal-planner",
        sizeBytes: 12_288,
        deletedAt: skillDeletedAt,
        restoreBy: keptUntil(skillDeletedAt),
        receiptId: null,
        restorable: "in-place",
      },
      {
        id: "trash-20261019183000-5e71b2c8",
        kind: "app-storage",
        reason: "apps.remove",
        workFolderId: "fixture-trip",
        workFolderName: "Japan trip",
        originalPath: "packing-list",
        name: "packing-list",
        sizeBytes: 86_400,
        deletedAt: appDataDeletedAt,
        restoreBy: keptUntil(appDataDeletedAt),
        receiptId: null,
        restorable: "save-only",
        note: "That app is no longer installed.",
      },
      {
        id: "trash-20261002142000-d83a6b05",
        kind: "work-folder",
        reason: "work-folders.delete",
        workFolderId: "space-4f2a9c1e7b3d6a05",
        workFolderName: "Old client notes",
        originalPath: "/Users/you/Library/Application Support/work-fold/spaces/Old client notes",
        name: "Old client notes",
        sizeBytes: 248_000_000,
        sizeApproximate: true,
        deletedAt: workFolderDeletedAt,
        restoreBy: keptUntil(workFolderDeletedAt),
        receiptId: null,
        held: { reason: "legacy-metadata", noticedAt: keptUntil(workFolderDeletedAt) },
        restorable: "in-place",
      },
    ],
  };
}

const home: AutomationWorkFolderRef = { workFolderId: "fixture-home", workFolderName: "Home projects" };
const trip: AutomationWorkFolderRef = { workFolderId: "fixture-trip", workFolderName: "Japan trip" };

/**
 * Settings → Automations, matching the work-folder Automations tab's sample
 * (`buildFixtureFolderAutomations`): "Send kitchen ideas to the trip folder"
 * is on and watches Home projects, and "Budget check-in" is off and has not
 * run. One file the work-fold agent wrote is ready to turn on.
 */
export interface FixtureAutomationReads {
  list: () => Promise<AutomationsResponse>;
  proposals: () => Promise<AutomationProposalsResponse>;
  show: (automationId: string) => Promise<AutomationDetailResponse>;
  history: (automationId: string) => Promise<AutomationHistoryResponse>;
}

export function createFixtureAutomationReads(): FixtureAutomationReads {
  const kitchenToTrip: AutomationDetailView = {
    automationId: "fixture-kitchen-to-trip",
    title: "Send kitchen ideas to the trip folder",
    health: "enabled",
    trigger: {
      kind: "files-changed",
      workFolderId: "fixture-home",
      watch: { kind: "tree", path: "Kitchen refresh", recursive: true, extensions: [".md"] },
      debounceSeconds: 10,
      cooldownMinutes: 30,
    },
    fileWatch: { state: "watching", lastObservedAt: "2026-11-04T08:02:00.000Z", lastTriggeredAt: "2026-11-03T17:44:50.000Z" },
    stepCount: 1,
    workFolders: [home, trip],
    lastRun: { runId: "run-20261103174500-kitchen", outcome: "succeeded", startedAt: "2026-11-03T17:45:00.000Z", finishedAt: "2026-11-03T17:45:02.000Z" },
    createdAt: "2026-10-14T16:20:00.000Z",
    steps: [{
      id: "copy-ideas",
      kind: "files",
      fromWorkFolder: home,
      toWorkFolder: trip,
      to: "Shopping/Kitchen ideas",
      source: { kind: "tree", path: "Kitchen refresh", recursive: true, extensions: [".md"] },
    }],
  };
  const budgetCheckIn: AutomationDetailView = {
    automationId: "fixture-budget-check-in",
    title: "Budget check-in",
    health: "disabled",
    trigger: { kind: "interval", intervalMinutes: 30 },
    stepCount: 1,
    workFolders: [home],
    createdAt: "2026-10-08T15:30:00.000Z",
    steps: [{
      id: "check-in",
      kind: "chat",
      workFolder: home,
      message: "Open Kitchen refresh/budget.xlsx and tell me in three lines whether anything is over budget.",
    }],
  };
  const details: Record<string, AutomationDetailView> = {
    [kitchenToTrip.automationId]: kitchenToTrip,
    [budgetCheckIn.automationId]: budgetCheckIn,
  };
  const summary = ({ createdAt: _createdAt, createdBy: _createdBy, steps: _steps, completedAt: _completedAt, ...rest }: AutomationDetailView) => rest;
  const list: AutomationsResponse = {
    automations: [summary(kitchenToTrip), summary(budgetCheckIn)],
    status: { storeDamaged: false, journalDamaged: false, activeRunCount: 0 },
  };
  // A failed run repeats its failed hop's reason, as the run journal does.
  const driveUnavailable = "The Japan trip folder was not available. Google Drive for desktop may have been signed out or still starting.";
  const histories: Record<string, AutomationHistoryResponse> = {
    [kitchenToTrip.automationId]: {
      truncated: false,
      damagedLineCount: 0,
      runs: [
        {
          runId: "run-20261103174500-kitchen",
          outcome: "succeeded",
          startedAt: "2026-11-03T17:45:00.000Z",
          finishedAt: "2026-11-03T17:45:02.000Z",
          cause: "Folder changed · 2 file(s)",
          hops: [{ hopId: "copy-ideas", kind: "files", outcome: "succeeded", workFolderName: "Japan trip", evidence: [{ label: "Files", value: "2" }, { label: "Bytes", value: "7360" }] }],
        },
        {
          runId: "run-20261029191200-kitchen",
          outcome: "failed",
          startedAt: "2026-10-29T19:12:00.000Z",
          finishedAt: "2026-10-29T19:12:01.000Z",
          cause: "Folder changed · 1 file(s)",
          detail: driveUnavailable,
          hops: [{ hopId: "copy-ideas", kind: "files", outcome: "failed", workFolderName: "Japan trip", detail: driveUnavailable }],
        },
        {
          runId: "run-20261021150300-kitchen",
          outcome: "succeeded",
          startedAt: "2026-10-21T15:03:00.000Z",
          finishedAt: "2026-10-21T15:03:01.000Z",
          cause: "Run Now",
          hops: [{ hopId: "copy-ideas", kind: "files", outcome: "succeeded", workFolderName: "Japan trip", evidence: [{ label: "Files", value: "3" }, { label: "Bytes", value: "11904" }] }],
        },
      ],
    },
    [budgetCheckIn.automationId]: { runs: [], truncated: false, damagedLineCount: 0 },
  };
  const proposals: AutomationProposalsResponse = {
    truncated: false,
    proposals: [{
      valid: true,
      path: "/Users/you/Library/Application Support/work-fold/management/pack-for-japan.work-fold-automation.json",
      fileName: "pack-for-japan.work-fold-automation.json",
      automationId: "pack-for-japan",
      digest: "sha256:5d1c8a0e3b7f4296a1e0c4b8d2f6a9e3c7b1d5f8a2e6c0b4d8f2a6e0c4b8d2f6",
      title: "Remind me to pack for Japan",
      trigger: { kind: "at", at: "2026-11-20T17:00:00.000Z", ifMissed: "run" },
    }],
  };
  const missing = () => new Error("This automation no longer exists.");
  // The same objects every time, so the pane's polling never re-renders for nothing.
  return {
    list: async () => list,
    proposals: async () => proposals,
    show: async (automationId) => {
      const automation = details[automationId];
      if (!automation) throw missing();
      return { automation };
    },
    history: async (automationId) => {
      const history = histories[automationId];
      if (!history) throw missing();
      return history;
    },
  };
}
