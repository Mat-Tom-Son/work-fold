import {
  normalizeWorkFolderAppearanceBannerImage,
  normalizeWorkFolderAppearanceCustomizations,
} from "../../../src/shared/work-folder-appearance";
import { defaultWorkFolderBannerName, workFolderBannerOptions } from "../constants";
import type { WorkFolderBannerImagePosition, WorkFolderBannerOption, WorkFolderCustomizationMap } from "../types";

export function workFolderBannerOptionFor(bannerName: string | null | undefined): WorkFolderBannerOption {
  const normalized = bannerName?.trim().toLowerCase();
  return workFolderBannerOptions.find((option) => option.name === normalized)
    ?? workFolderBannerOptions.find((option) => option.name === defaultWorkFolderBannerName)
    ?? workFolderBannerOptions[0];
}

export function normalizeWorkFolderBannerImage(value: string | null | undefined): string | null {
  return normalizeWorkFolderAppearanceBannerImage(value);
}

export function normalizeWorkFolderBannerImagePosition(value: unknown): WorkFolderBannerImagePosition {
  return value === "top" || value === "bottom" ? value : "center";
}

export function normalizeWorkFolderCustomizations(
  value: unknown,
  allowedWorkFolderIds?: ReadonlySet<string>,
  allowedIconNames?: ReadonlySet<string>,
): WorkFolderCustomizationMap {
  return normalizeWorkFolderAppearanceCustomizations(value, {
    allowedWorkFolderIds,
    allowedIconNames,
    allowedBannerNames: new Set(workFolderBannerOptions.map((option) => option.name)),
  });
}
