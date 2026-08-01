import { isNewerRestrictedAppRegistryVersionError } from "../../src/local/agent/restricted-app-registry-error.js";
import { productIdentity } from "../../src/shared/product-identity.js";

export const latestWorkFoldReleaseUrl = `https://github.com/${productIdentity.sourceRepositoryOwner}/${productIdentity.sourceRepositoryName}/releases/latest`;

export interface WorkFoldStartupRecoveryPlan {
  reason: "newer-local-state";
  actualVersion: number;
  supportedVersion: number;
  title: string;
  message: string;
}

export type WorkFoldStartupRecoveryStage =
  | { kind: "initial" }
  | { kind: "available"; version: string }
  | { kind: "unavailable" }
  | { kind: "check-failed" }
  | { kind: "install-failed" };

export interface WorkFoldStartupRecoveryDialog {
  stage: WorkFoldStartupRecoveryStage["kind"];
  type: "warning" | "error";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkId: number | null;
  downloadId: number | null;
  releasesId: number;
}

export interface WorkFoldStartupRecoveryHost {
  showDialog(dialog: WorkFoldStartupRecoveryDialog): Promise<number>;
  checkForUpdate(): Promise<string | null>;
  downloadAndInstall(): Promise<boolean>;
  openReleases(): Promise<void>;
  quit(): void;
}

export function workFoldStartupRecoveryPlan(error: unknown): WorkFoldStartupRecoveryPlan | null {
  if (!isNewerRestrictedAppRegistryVersionError(error)) return null;
  return {
    reason: "newer-local-state",
    actualVersion: error.actualVersion,
    supportedVersion: error.supportedVersion,
    title: "work-fold update required",
    message: "This version of work-fold cannot safely open newer local data.",
  };
}

export function workFoldStartupRecoveryDialog(
  plan: WorkFoldStartupRecoveryPlan,
  stage: WorkFoldStartupRecoveryStage,
): WorkFoldStartupRecoveryDialog {
  const common = { title: plan.title, checkId: null, downloadId: null } as const;
  if (stage.kind === "initial") {
    return {
      ...common,
      stage: stage.kind,
      type: "warning",
      message: plan.message,
      detail: "Local work-fold data was created by a newer build. Check for a compatible update before opening it. Your Spaces and app data are safe.",
      buttons: ["Check for Updates", "Open Releases", "Quit"],
      defaultId: 0,
      cancelId: 2,
      checkId: 0,
      releasesId: 1,
    };
  }
  if (stage.kind === "available") {
    const version = stage.version.trim().slice(0, 100);
    return {
      ...common,
      stage: stage.kind,
      type: "warning",
      message: `work-fold ${version || "update"} is available.`,
      detail: "Download and install it before opening the newer local data. Your Spaces and app data are safe.",
      buttons: ["Download and Install", "Open Releases", "Quit"],
      defaultId: 0,
      cancelId: 2,
      downloadId: 0,
      releasesId: 1,
    };
  }
  const checkFailed = stage.kind === "check-failed";
  const installFailed = stage.kind === "install-failed";
  return {
    ...common,
    stage: stage.kind,
    type: checkFailed || installFailed ? "error" : "warning",
    message: installFailed
      ? "work-fold could not download and install the required update."
      : checkFailed
        ? "work-fold could not check for updates."
        : "No compatible work-fold update was found.",
    detail: "Open the public Releases page or return to the newer development build that created this data. Your Spaces and app data are safe.",
    buttons: ["Open Releases", "Quit"],
    defaultId: 0,
    cancelId: 1,
    releasesId: 0,
  };
}

export async function runWorkFoldStartupRecovery(
  plan: WorkFoldStartupRecoveryPlan,
  host: WorkFoldStartupRecoveryHost,
): Promise<"installing" | "quit"> {
  const initial = workFoldStartupRecoveryDialog(plan, { kind: "initial" });
  const initialChoice = await host.showDialog(initial);
  if (initialChoice !== initial.checkId) return await finishRecoveryChoice(initialChoice, initial, host);

  let availableVersion: string | null;
  try {
    availableVersion = await host.checkForUpdate();
  } catch {
    const failed = workFoldStartupRecoveryDialog(plan, { kind: "check-failed" });
    return await finishRecoveryChoice(await host.showDialog(failed), failed, host);
  }
  if (!availableVersion?.trim()) {
    const unavailable = workFoldStartupRecoveryDialog(plan, { kind: "unavailable" });
    return await finishRecoveryChoice(await host.showDialog(unavailable), unavailable, host);
  }

  const available = workFoldStartupRecoveryDialog(plan, { kind: "available", version: availableVersion });
  const availableChoice = await host.showDialog(available);
  if (availableChoice !== available.downloadId) return await finishRecoveryChoice(availableChoice, available, host);

  let installing = false;
  try {
    installing = await host.downloadAndInstall();
  } catch {
    installing = false;
  }
  if (installing) return "installing";
  const failed = workFoldStartupRecoveryDialog(plan, { kind: "install-failed" });
  return await finishRecoveryChoice(await host.showDialog(failed), failed, host);
}

async function finishRecoveryChoice(
  choice: number,
  dialog: WorkFoldStartupRecoveryDialog,
  host: WorkFoldStartupRecoveryHost,
): Promise<"quit"> {
  try {
    if (choice === dialog.releasesId) await host.openReleases();
  } finally {
    host.quit();
  }
  return "quit";
}
