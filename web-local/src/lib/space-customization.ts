import {
  hasSpaceAppearanceCustomization,
  normalizeSpaceAppearanceBannerImage,
  normalizeSpaceAppearanceCustomizations,
} from "../../../src/shared/space-appearance";
import { defaultSpaceBannerName, spaceBannerOptions } from "../constants";
import type { SpaceBannerImagePosition, SpaceBannerOption, SpaceCustomization, SpaceCustomizationMap } from "../types";

export function spaceBannerOptionFor(bannerName: string | null | undefined): SpaceBannerOption {
  const normalized = bannerName?.trim().toLowerCase();
  return spaceBannerOptions.find((option) => option.name === normalized)
    ?? spaceBannerOptions.find((option) => option.name === defaultSpaceBannerName)
    ?? spaceBannerOptions[0];
}

export function normalizeSpaceBannerImage(value: string | null | undefined): string | null {
  return normalizeSpaceAppearanceBannerImage(value);
}

export function normalizeSpaceBannerImagePosition(value: unknown): SpaceBannerImagePosition {
  return value === "top" || value === "bottom" ? value : "center";
}

export function normalizeSpaceCustomizations(
  value: unknown,
  allowedSpaceIds?: ReadonlySet<string>,
  allowedIconNames?: ReadonlySet<string>,
): SpaceCustomizationMap {
  return normalizeSpaceAppearanceCustomizations(value, {
    allowedSpaceIds,
    allowedIconNames,
    allowedBannerNames: new Set(spaceBannerOptions.map((option) => option.name)),
  });
}

export function hasSpaceCustomization(customization: SpaceCustomization | null | undefined): boolean {
  return hasSpaceAppearanceCustomization(customization);
}
