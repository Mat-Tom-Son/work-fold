import type { CSSProperties } from "react";
import {
  primaryAccentIdentity,
  normalizeWorkFolderAppearanceBannerFraming,
  resolveWorkFolderAppearance,
  secondaryAccentIdentity,
  type ResolvedWorkFolderAppearance,
  type WorkFolderAppearanceMode,
  type ResolverGround,
  type WorkFolderAppearanceBannerFraming,
  type WorkFolderAppearanceBannerPresetId,
} from "../../../src/shared/work-folder-appearance";
import { maxWorkFolderBannerImageDataUrlLength, maxWorkFolderBannerImageFileBytes } from "../constants";
import { workFolderIconOptionFor, type WorkFolderIconOption } from "../work-folder-icons";
import type { WorkFolderBannerImagePosition, WorkFolderColorOption, WorkFolderCustomizationMap, WorkFolderSummary } from "../types";
import { readableTextColorOn } from "./color-contrast";
import { normalizeWorkFolderBannerImage, normalizeWorkFolderBannerImagePosition, workFolderBannerOptionFor } from "./work-folder-customization";
import { workFolderBannerPresetFor } from "./work-folder-banner-presets";

const defaultWorkFolderColorOptions: WorkFolderColorOption[] = [
  workFolderColor("Slate", "#60646c"),
  workFolderColor("Red", "#ce2c31"),
  workFolderColor("Orange", "#cc4e00"),
  workFolderColor("Amber", "#ab6400"),
  workFolderColor("Moss", "#5c7c2e"),
  workFolderColor("Green", "#1a7f37"),
  workFolderColor("Cyan", "#0e7490"),
  workFolderColor("Blue", "#0d74ce"),
  workFolderColor("Violet", "#6550b9"),
  workFolderColor("Plum", "#953ea3"),
  workFolderColor("Pink", "#c2298a"),
  workFolderColor("Brown", "#815e46"),
];

// Picker colors can evolve without recoloring work-folders that use their original default.
export const workFolderColorOptions: WorkFolderColorOption[] = [
  workFolderColor("Slate", "#64748b"),
  workFolderColor("Stone", "#a8a29e"),
  workFolderColor("Sand", "#d6a46b"),
  workFolderColor("Cocoa", "#a47551"),
  workFolderColor("Rose", "#f43f5e"),
  workFolderColor("Coral", "#fb7185"),
  workFolderColor("Orange", "#f97316"),
  workFolderColor("Amber", "#f59e0b"),
  workFolderColor("Yellow", "#eab308"),
  workFolderColor("Lime", "#84cc16"),
  workFolderColor("Sage", "#84a98c"),
  workFolderColor("Green", "#22c55e"),
  workFolderColor("Forest", "#15803d"),
  workFolderColor("Mint", "#6ee7b7"),
  workFolderColor("Teal", "#14b8a6"),
  workFolderColor("Cyan", "#06b6d4"),
  workFolderColor("Sky", "#38bdf8"),
  workFolderColor("Blue", "#3b82f6"),
  workFolderColor("Indigo", "#6366f1"),
  workFolderColor("Violet", "#8b5cf6"),
  workFolderColor("Lavender", "#c4b5fd"),
  workFolderColor("Plum", "#a855f7"),
  workFolderColor("Pink", "#f472b6"),
  workFolderColor("Fuchsia", "#d946ef"),
];

export function defaultWorkFolderColor(workFolderId: string): WorkFolderColorOption {
  let hash = 0;
  for (const character of workFolderId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return defaultWorkFolderColorOptions[hash % defaultWorkFolderColorOptions.length] ?? defaultWorkFolderColorOptions[0];
}

export function workFolderColor(label: string, color: string): WorkFolderColorOption {
  const normalizedColor = normalizeWorkFolderColor(color);
  return {
    label,
    color: normalizedColor,
    soft: hexColorToRgba(normalizedColor, 0.13),
    border: hexColorToRgba(normalizedColor, 0.5),
  };
}

export function normalizeWorkFolderColor(color: string, fallback = "#60646c"): string {
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

interface WorkFolderIdentity {
  color: string;
  softColor: string;
  borderColor: string;
  accentRgb: string;
  secondaryColor: string;
  secondaryRgb: string;
  hasCustomSecondary: boolean;
  onAccentColor: string;
  onPrimaryAccentColor: string;
  resolved: ResolvedWorkFolderAppearance;
  bannerName: string;
  bannerImage: string | null;
  bannerImagePosition: WorkFolderBannerImagePosition;
  bannerPreset: WorkFolderAppearanceBannerPresetId | null;
  bannerFraming: WorkFolderAppearanceBannerFraming;
  iconName: string;
  iconLabel: string;
  Icon: WorkFolderIconOption["Icon"];
}

function workFolderIdentityFor(workFolder: WorkFolderSummary, customizations: WorkFolderCustomizationMap, grounds?: Record<WorkFolderAppearanceMode, ResolverGround>): WorkFolderIdentity {
  const defaultColor = defaultWorkFolderColor(workFolder.id);
  const custom = customizations[workFolder.id] ?? {};
  const primaryIdentity = primaryAccentIdentity(custom, defaultColor.color);
  const secondaryIdentity = secondaryAccentIdentity(custom, primaryIdentity);
  const colorOption = workFolderColor("Custom", primaryIdentity.referenceHex);
  const hasCustomSecondary = Boolean(custom.secondary || custom.color2);
  const secondaryColor = secondaryIdentity.referenceHex;
  const iconOption = workFolderIconOptionFor(custom.iconName ?? defaultWorkFolderIconName(workFolder));
  const customBannerImage = normalizeWorkFolderBannerImage(custom.bannerImage);
  const preset = !customBannerImage ? workFolderBannerPresetFor(custom.bannerPreset) : undefined;
  const bannerImage = customBannerImage ?? preset?.image ?? null;
  const bannerName = workFolderBannerOptionFor(custom.bannerName).name;
  const resolved = resolveWorkFolderAppearance({
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
    bannerImagePosition: normalizeWorkFolderBannerImagePosition(custom.bannerImagePosition),
    bannerPreset: preset?.id ?? null,
    bannerFraming: normalizeWorkFolderAppearanceBannerFraming(custom.bannerFraming) ?? {
      x: 50, y: custom.bannerImagePosition === "top" ? 0 : custom.bannerImagePosition === "bottom" ? 100 : 50, zoom: 1,
    },
    iconName: iconOption.name,
    iconLabel: iconOption.label,
    Icon: iconOption.Icon,
  };
}

function workFolderIdentityStyle(identity: WorkFolderIdentity, mode?: WorkFolderAppearanceMode): CSSProperties {
  const role = <K extends keyof ResolvedWorkFolderAppearance["light"]>(name: K): ResolvedWorkFolderAppearance["light"][K] => (
    mode ? identity.resolved[mode][name] : `light-dark(${identity.resolved.light[name]}, ${identity.resolved.dark[name]})`
  ) as ResolvedWorkFolderAppearance["light"][K];
  return {
    ...(identity.bannerPreset ? {
      "--work-folder-image-title": identity.bannerPreset === "dusk" ? "#ffffff" : mode === "light" ? "#152a2c" : mode === "dark" ? "#ffffff" : "light-dark(#152a2c, #ffffff)",
      "--work-folder-image-scrim": identity.bannerPreset === "dusk" ? "rgba(9, 14, 24, 0.24)" : mode === "light" ? "rgba(255, 255, 255, 0.18)" : mode === "dark" ? "rgba(9, 14, 24, 0.58)" : "light-dark(rgba(255, 255, 255, 0.18), rgba(9, 14, 24, 0.58))",
      "--work-folder-image-button": identity.bannerPreset === "dusk" ? "rgba(9, 14, 24, 0.56)" : mode === "light" ? "rgba(255, 255, 255, 0.84)" : mode === "dark" ? "rgba(9, 14, 24, 0.56)" : "light-dark(rgba(255, 255, 255, 0.84), rgba(9, 14, 24, 0.56))",
    } : {}),
    "--work-folder-accent-text-body": role("textBody"),
    "--work-folder-accent-text-ui": role("textUi"),
    "--work-folder-accent-glyph": role("glyph"),
    "--work-folder-accent-solid": role("solid"),
    "--work-folder-on-accent-solid": role("onSolid"),
    "--work-folder-on-accent-muted": role("onSolidMuted"),
    "--work-folder-accent-soft-fill": role("softFill"),
    "--work-folder-accent-border-state": role("borderState"),
    "--work-folder-accent-border-decor": role("borderDecor"),
    "--work-folder-accent-focus-ring": role("focusRing"),
    "--work-folder-accent-indicator": role("indicator"),
    "--work-folder-banner-secondary": identity.resolved.light.bannerSecondary,
    "--work-folder-banner-primary-rgb": identity.accentRgb,
    "--work-folder-banner-secondary-rgb": identity.secondaryRgb,
    "--surface-tab-accent": identity.color,
    "--surface-tab-accent-soft": identity.softColor,
    // Transitional aliases retain their v1 rendering semantics until every
    // remaining call site has been assigned a semantic role.
    "--work-folder-custom-color": identity.color,
    "--work-folder-custom-color-soft": identity.softColor,
    "--work-folder-selection-accent": identity.color,
    "--work-folder-selection-accent-rgb": identity.accentRgb,
    "--work-folder-selection-accent2": identity.secondaryColor,
    "--work-folder-selection-accent2-rgb": identity.secondaryRgb,
    "--work-folder-selection-border": identity.borderColor,
    "--work-folder-selection-surface": identity.softColor,
    "--work-folder-on-accent": identity.onAccentColor,
    "--work-folder-on-primary-accent": identity.onPrimaryAccentColor,
    "--work-folder-picker-color": identity.color,
  } as CSSProperties;
}

export function workFolderBannerImageStyle(framing: WorkFolderAppearanceBannerFraming): CSSProperties {
  return { objectPosition: `${framing.x}% ${framing.y}%`, transform: `scale(${framing.zoom})`, transformOrigin: `${framing.x}% ${framing.y}%` };
}

function defaultWorkFolderIconName(_workFolder: WorkFolderSummary): string {
  return "folder";
}

async function processWorkFolderBannerImageFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, GIF, or BMP image.");
  }
  if (file.size > maxWorkFolderBannerImageFileBytes) {
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
      if (dataUrl.startsWith("data:image/webp") && dataUrl.length <= maxWorkFolderBannerImageDataUrlLength) return dataUrl;
    }
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.72);
    if (jpegDataUrl.length <= maxWorkFolderBannerImageDataUrlLength) return jpegDataUrl;
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
export { defaultWorkFolderIconName, processWorkFolderBannerImageFile, workFolderIdentityFor, workFolderIdentityStyle };
export type { WorkFolderIdentity };
