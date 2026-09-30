import type { CSSProperties } from "react";
import {
  primaryAccentIdentity,
  normalizeSpaceAppearanceBannerFraming,
  resolveSpaceAppearance,
  secondaryAccentIdentity,
  type ResolvedSpaceAppearance,
  type SpaceAppearanceMode,
  type ResolverGround,
  type SpaceAppearanceBannerFraming,
  type SpaceAppearanceBannerPresetId,
} from "../../../src/shared/space-appearance";
import { maxSpaceBannerImageDataUrlLength, maxSpaceBannerImageFileBytes } from "../constants";
import { spaceIconOptionFor, type SpaceIconOption } from "../space-icons";
import type { SpaceBannerImagePosition, SpaceColorOption, SpaceCustomizationMap, SpaceSummary } from "../types";
import { readableTextColorOn } from "./color-contrast";
import { normalizeSpaceBannerImage, normalizeSpaceBannerImagePosition, spaceBannerOptionFor } from "./space-customization";
import { spaceBannerPresetFor } from "./space-banner-presets";

const defaultSpaceColorOptions: SpaceColorOption[] = [
  spaceColor("Slate", "#60646c"),
  spaceColor("Red", "#ce2c31"),
  spaceColor("Orange", "#cc4e00"),
  spaceColor("Amber", "#ab6400"),
  spaceColor("Moss", "#5c7c2e"),
  spaceColor("Green", "#1a7f37"),
  spaceColor("Cyan", "#0e7490"),
  spaceColor("Blue", "#0d74ce"),
  spaceColor("Violet", "#6550b9"),
  spaceColor("Plum", "#953ea3"),
  spaceColor("Pink", "#c2298a"),
  spaceColor("Brown", "#815e46"),
];

// Picker colors can evolve without recoloring Folders that use their original default.
export const spaceColorOptions: SpaceColorOption[] = [
  spaceColor("Slate", "#64748b"),
  spaceColor("Stone", "#a8a29e"),
  spaceColor("Sand", "#d6a46b"),
  spaceColor("Cocoa", "#a47551"),
  spaceColor("Rose", "#f43f5e"),
  spaceColor("Coral", "#fb7185"),
  spaceColor("Orange", "#f97316"),
  spaceColor("Amber", "#f59e0b"),
  spaceColor("Yellow", "#eab308"),
  spaceColor("Lime", "#84cc16"),
  spaceColor("Sage", "#84a98c"),
  spaceColor("Green", "#22c55e"),
  spaceColor("Forest", "#15803d"),
  spaceColor("Mint", "#6ee7b7"),
  spaceColor("Teal", "#14b8a6"),
  spaceColor("Cyan", "#06b6d4"),
  spaceColor("Sky", "#38bdf8"),
  spaceColor("Blue", "#3b82f6"),
  spaceColor("Indigo", "#6366f1"),
  spaceColor("Violet", "#8b5cf6"),
  spaceColor("Lavender", "#c4b5fd"),
  spaceColor("Plum", "#a855f7"),
  spaceColor("Pink", "#f472b6"),
  spaceColor("Fuchsia", "#d946ef"),
];

export function defaultSpaceColor(spaceId: string): SpaceColorOption {
  let hash = 0;
  for (const character of spaceId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return defaultSpaceColorOptions[hash % defaultSpaceColorOptions.length] ?? defaultSpaceColorOptions[0];
}

export function spaceColor(label: string, color: string): SpaceColorOption {
  const normalizedColor = normalizeSpaceColor(color);
  return {
    label,
    color: normalizedColor,
    soft: hexColorToRgba(normalizedColor, 0.13),
    border: hexColorToRgba(normalizedColor, 0.5),
  };
}

export function normalizeSpaceColor(color: string, fallback = "#60646c"): string {
  const normalized = color.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : fallback;
}

export function hexColorToRgba(color: string, alpha: number): string {
  return `rgba(${hexColorToRgbTriple(color)}, ${alpha})`;
}

export function hexColorToRgbTriple(color: string): string {
  const normalized = color.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `${red}, ${green}, ${blue}`;
}

export function blendHexColors(first: string, second: string): string {
  if (first === second) return first;
  const channel = (color: string, offset: number) => Number.parseInt(color.replace("#", "").slice(offset, offset + 2), 16);
  const mixed = [0, 2, 4].map((offset) => Math.round((channel(first, offset) + channel(second, offset)) / 2));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

interface SpaceIdentity {
  color: string;
  softColor: string;
  borderColor: string;
  accentRgb: string;
  secondaryColor: string;
  secondaryRgb: string;
  hasCustomSecondary: boolean;
  onAccentColor: string;
  onPrimaryAccentColor: string;
  resolved: ResolvedSpaceAppearance;
  bannerName: string;
  bannerImage: string | null;
  bannerImagePosition: SpaceBannerImagePosition;
  bannerPreset: SpaceAppearanceBannerPresetId | null;
  bannerFraming: SpaceAppearanceBannerFraming;
  iconName: string;
  iconLabel: string;
  Icon: SpaceIconOption["Icon"];
}

function spaceIdentityFor(space: SpaceSummary, customizations: SpaceCustomizationMap, grounds?: Record<SpaceAppearanceMode, ResolverGround>): SpaceIdentity {
  const defaultColor = defaultSpaceColor(space.id);
  const custom = customizations[space.id] ?? {};
  const primaryIdentity = primaryAccentIdentity(custom, defaultColor.color);
  const secondaryIdentity = secondaryAccentIdentity(custom, primaryIdentity);
  const colorOption = spaceColor("Custom", primaryIdentity.referenceHex);
  const hasCustomSecondary = Boolean(custom.secondary || custom.color2);
  const secondaryColor = secondaryIdentity.referenceHex;
  const iconOption = spaceIconOptionFor(custom.iconName ?? defaultSpaceIconName(space));
  const customBannerImage = normalizeSpaceBannerImage(custom.bannerImage);
  const preset = !customBannerImage ? spaceBannerPresetFor(custom.bannerPreset) : undefined;
  const bannerImage = customBannerImage ?? preset?.image ?? null;
  const bannerName = spaceBannerOptionFor(custom.bannerName).name;
  const resolved = resolveSpaceAppearance({
    primary: primaryIdentity,
    secondary: secondaryIdentity,
    bannerName,
    hasBannerImage: Boolean(bannerImage),
    grounds,
  });
  return {
    color: colorOption.color,
    softColor: colorOption.soft,
    borderColor: colorOption.border,
    accentRgb: hexColorToRgbTriple(colorOption.color),
    secondaryColor,
    secondaryRgb: hexColorToRgbTriple(secondaryColor),
    hasCustomSecondary,
    onAccentColor: readableTextColorOn(blendHexColors(colorOption.color, secondaryColor)),
    onPrimaryAccentColor: readableTextColorOn(colorOption.color),
    resolved,
    bannerName,
    bannerImage,
    bannerImagePosition: normalizeSpaceBannerImagePosition(custom.bannerImagePosition),
    bannerPreset: preset?.id ?? null,
    bannerFraming: normalizeSpaceAppearanceBannerFraming(custom.bannerFraming) ?? {
      x: 50, y: custom.bannerImagePosition === "top" ? 0 : custom.bannerImagePosition === "bottom" ? 100 : 50, zoom: 1,
    },
    iconName: iconOption.name,
    iconLabel: iconOption.label,
    Icon: iconOption.Icon,
  };
}

function spaceIdentityStyle(identity: SpaceIdentity, mode?: SpaceAppearanceMode): CSSProperties {
  const role = <K extends keyof ResolvedSpaceAppearance["light"]>(name: K): ResolvedSpaceAppearance["light"][K] => (
    mode ? identity.resolved[mode][name] : `light-dark(${identity.resolved.light[name]}, ${identity.resolved.dark[name]})`
  ) as ResolvedSpaceAppearance["light"][K];
  return {
    ...(identity.bannerPreset ? {
      "--space-image-title": identity.bannerPreset === "dusk" ? "#ffffff" : mode === "light" ? "#152a2c" : mode === "dark" ? "#ffffff" : "light-dark(#152a2c, #ffffff)",
      "--space-image-scrim": identity.bannerPreset === "dusk" ? "rgba(9, 14, 24, 0.24)" : mode === "light" ? "rgba(255, 255, 255, 0.18)" : mode === "dark" ? "rgba(9, 14, 24, 0.58)" : "light-dark(rgba(255, 255, 255, 0.18), rgba(9, 14, 24, 0.58))",
      "--space-image-button": identity.bannerPreset === "dusk" ? "rgba(9, 14, 24, 0.56)" : mode === "light" ? "rgba(255, 255, 255, 0.84)" : mode === "dark" ? "rgba(9, 14, 24, 0.56)" : "light-dark(rgba(255, 255, 255, 0.84), rgba(9, 14, 24, 0.56))",
    } : {}),
    "--space-accent-text-body": role("textBody"),
    "--space-accent-text-ui": role("textUi"),
    "--space-accent-glyph": role("glyph"),
    "--space-accent-solid": role("solid"),
    "--space-on-accent-solid": role("onSolid"),
    "--space-on-accent-muted": role("onSolidMuted"),
    "--space-accent-soft-fill": role("softFill"),
    "--space-accent-border-state": role("borderState"),
    "--space-accent-border-decor": role("borderDecor"),
    "--space-accent-focus-ring": role("focusRing"),
    "--space-accent-indicator": role("indicator"),
    "--space-banner-secondary": identity.resolved.light.bannerSecondary,
    "--space-banner-primary-rgb": identity.accentRgb,
    "--space-banner-secondary-rgb": identity.secondaryRgb,
    "--surface-tab-accent": identity.color,
    "--surface-tab-accent-soft": identity.softColor,
    // Transitional aliases retain their v1 rendering semantics until every
    // remaining call site has been assigned a semantic role.
    "--space-custom-color": identity.color,
    "--space-custom-color-soft": identity.softColor,
    "--space-selection-accent": identity.color,
    "--space-selection-accent-rgb": identity.accentRgb,
    "--space-selection-accent2": identity.secondaryColor,
    "--space-selection-accent2-rgb": identity.secondaryRgb,
    "--space-selection-border": identity.borderColor,
    "--space-selection-surface": identity.softColor,
    "--space-on-accent": identity.onAccentColor,
    "--space-on-primary-accent": identity.onPrimaryAccentColor,
    "--space-picker-color": identity.color,
  } as CSSProperties;
}

export function spaceBannerImageStyle(framing: SpaceAppearanceBannerFraming): CSSProperties {
  return { objectPosition: `${framing.x}% ${framing.y}%`, transform: `scale(${framing.zoom})`, transformOrigin: `${framing.x}% ${framing.y}%` };
}

function defaultSpaceIconName(_space: SpaceSummary): string {
  return "folder";
}

async function processSpaceBannerImageFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, GIF, or BMP image.");
  }
  if (file.size > maxSpaceBannerImageFileBytes) {
    throw new Error("Image is larger than 12 MB. Choose a smaller image.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const maxWidth = 1600;
    const maxHeight = 640;
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process the image.");
    context.drawImage(image, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      if (dataUrl.startsWith("data:image/webp") && dataUrl.length <= maxSpaceBannerImageDataUrlLength) return dataUrl;
    }
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.72);
    if (jpegDataUrl.length <= maxSpaceBannerImageDataUrlLength) return jpegDataUrl;
    throw new Error("Image is too detailed to store locally. Try a simpler or smaller image.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageElement(sourceUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that file as an image."));
    image.src = sourceUrl;
  });
}

export { readableTextColorOn } from "./color-contrast";
export { defaultSpaceIconName, processSpaceBannerImageFile, spaceIdentityFor, spaceIdentityStyle };
export type { SpaceIdentity };
