import type { ChatActivityStatus } from "../types";

export * from "../../../src/shared/folder-nesting";

/** One dot for a group of work-folders: running wins over a finished reply waiting to be seen. */
export function combineActivityStatuses(statuses: ReadonlyArray<ChatActivityStatus | null | undefined>): ChatActivityStatus | null {
  if (statuses.includes("running")) return "running";
  if (statuses.includes("attention")) return "attention";
  return null;
}
