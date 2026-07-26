import {
  hasSpaceAppearanceCustomization,
  normalizeSpaceAppearanceBannerImage,
  normalizeSpaceAppearanceCustomizations,
} from "../../../src/shared/space-appearance";
import { defaultWorkspaceBannerName, workspaceBannerOptions } from "../constants";
import type { WorkspaceBannerImagePosition, WorkspaceBannerOption, WorkspaceCustomization, WorkspaceCustomizationMap } from "../types";

export function workspaceBannerOptionFor(bannerName: string | null | undefined): WorkspaceBannerOption {
  const normalized = bannerName?.trim().toLowerCase();
  return workspaceBannerOptions.find((option) => option.name === normalized)
    ?? workspaceBannerOptions.find((option) => option.name === defaultWorkspaceBannerName)
    ?? workspaceBannerOptions[0];
}

export function normalizeWorkspaceBannerImage(value: string | null | undefined): string | null {
  return normalizeSpaceAppearanceBannerImage(value);
}

export function normalizeWorkspaceBannerImagePosition(value: unknown): WorkspaceBannerImagePosition {
  return value === "top" || value === "bottom" ? value : "center";
}

export function normalizeWorkspaceCustomizations(
  value: unknown,
  allowedWorkspaceIds?: ReadonlySet<string>,
  allowedIconNames?: ReadonlySet<string>,
): WorkspaceCustomizationMap {
  return normalizeSpaceAppearanceCustomizations(value, {
    allowedWorkspaceIds,
    allowedIconNames,
    allowedBannerNames: new Set(workspaceBannerOptions.map((option) => option.name)),
  });
}

export function hasWorkspaceCustomization(customization: WorkspaceCustomization | null | undefined): boolean {
  return hasSpaceAppearanceCustomization(customization);
}
