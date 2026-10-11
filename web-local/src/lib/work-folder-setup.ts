/**
 * Set up for me (2026-10-11): one click asks the work-folder's Worker to look
 * the folder over and set it up, through the included set-up-work-folder
 * Skill. "Set up for me" organizes it, writes Worker instructions, and gives
 * it a look; "Just the look" sets the banner, icon, and color and never
 * touches a file.
 */
import { readStoredJsonValue, writeStoredJsonValue } from "./storage";

export type WorkFolderSetUpMode = "full" | "look";

/** The first message each choice sends; the Skill does the rest. */
export function workFolderSetUpMessage(mode: WorkFolderSetUpMode): string {
  return mode === "full"
    ? "Set up this work-folder for me."
    : "Just the look: give this work-folder a banner, icon, and color that fit it, without changing any of its files.";
}

/** work-folders just added whose setup card is still showing; × or either choice removes one for good. */
export const workFolderSetUpOffersKey = "work-fold.work-folder.setup-offers.v1";

export function readWorkFolderSetUpOffers(): string[] {
  return readStoredJsonValue(
    workFolderSetUpOffersKey,
    (parsed) => (Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []),
    [],
  );
}

export function writeWorkFolderSetUpOffers(ids: readonly string[]): void {
  writeStoredJsonValue(workFolderSetUpOffersKey, [...new Set(ids)]);
}
