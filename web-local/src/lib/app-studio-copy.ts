export interface AppStudioResultToast {
  text: string;
  tone: "info" | "success";
}

export function uninstallResultToast(input: {
  removed: boolean;
  disposition: "retain" | "purge";
  cleanupPending: boolean;
}): AppStudioResultToast {
  if (!input.removed) {
    return {
      text: input.cleanupPending
        ? "App was already uninstalled · remaining cleanup will retry"
        : "App was already uninstalled",
      tone: "info",
    };
  }
  if (input.cleanupPending) {
    return {
      text: input.disposition === "retain"
        ? "App uninstalled · data retained · remaining cleanup will retry"
        : "App authority removed · local data cleanup will retry",
      tone: "info",
    };
  }
  return {
    text: input.disposition === "retain" ? "App uninstalled · data retained" : "App and local data removed",
    tone: "success",
  };
}

export function retainedDataPurgeResultToast(input: {
  purged: boolean;
  cleanupPending: boolean;
}): AppStudioResultToast {
  if (!input.purged) {
    return {
      text: input.cleanupPending
        ? "Retained data was already detached · device cleanup will retry"
        : "Retained data was already removed",
      tone: "info",
    };
  }
  return input.cleanupPending
    ? { text: "Retained data detached · device cleanup will retry", tone: "info" }
    : { text: "Retained App data purged", tone: "success" };
}

export function releaseDeletionResultToast(input: {
  displayVersion: string;
  deleted: boolean;
  cleanupPending: boolean;
  /** True when a copy of the Release is waiting in Recently deleted. */
  recentlyDeleted?: boolean;
}): AppStudioResultToast {
  if (!input.deleted) {
    return {
      text: input.cleanupPending
        ? `Release ${input.displayVersion} was already removed · stored-byte cleanup will retry`
        : `Release ${input.displayVersion} was already removed`,
      tone: "info",
    };
  }
  if (input.recentlyDeleted) {
    const moved = `Release ${input.displayVersion} moved to Recently Deleted`;
    return input.cleanupPending
      ? { text: `${moved} · stored-byte cleanup will retry`, tone: "info" }
      : { text: moved, tone: "success" };
  }
  return input.cleanupPending
    ? { text: `Release ${input.displayVersion} removed · stored-byte cleanup will retry`, tone: "info" }
    : { text: `Release ${input.displayVersion} deleted`, tone: "success" };
}
