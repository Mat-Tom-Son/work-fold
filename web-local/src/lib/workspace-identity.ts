import type { CSSProperties } from "react";
import {
  primaryAccentIdentity,
  resolveSpaceAppearance,
  secondaryAccentIdentity,
  type ResolvedSpaceAppearance,
  type SpaceAppearanceMode,
} from "../../../src/shared/space-appearance";
import { maxWorkspaceBannerImageDataUrlLength, maxWorkspaceBannerImageFileBytes } from "../constants";
import { workspaceIconOptionFor, type WorkspaceIconOption } from "../workspace-icons";
import type { WorkspaceBannerImagePosition, WorkspaceColorOption, WorkspaceCustomizationMap, WorkspaceSummary } from "../types";
import { readableTextColorOn } from "./color-contrast";
import { normalizeWorkspaceBannerImage, normalizeWorkspaceBannerImagePosition, workspaceBannerOptionFor } from "./workspace-customization";

export const workspaceColorOptions: WorkspaceColorOption[] = [
  workspaceColor("Slate", "#60646c"),
  workspaceColor("Red", "#ce2c31"),
  workspaceColor("Orange", "#cc4e00"),
  workspaceColor("Amber", "#ab6400"),
  workspaceColor("Moss", "#5c7c2e"),
  workspaceColor("Green", "#1a7f37"),
  workspaceColor("Cyan", "#0e7490"),
  workspaceColor("Blue", "#0d74ce"),
  workspaceColor("Violet", "#6550b9"),
  workspaceColor("Plum", "#953ea3"),
  workspaceColor("Pink", "#c2298a"),
  workspaceColor("Brown", "#815e46"),
];

export function defaultWorkspaceColor(workspaceId: string): WorkspaceColorOption {
  let hash = 0;
  for (const character of workspaceId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return workspaceColorOptions[hash % workspaceColorOptions.length] ?? workspaceColorOptions[0];
}

export function workspaceColor(label: string, color: string): WorkspaceColorOption {
  const normalizedColor = normalizeWorkspaceColor(color);
  return {
    label,
    color: normalizedColor,
    soft: hexColorToRgba(normalizedColor, 0.13),
    border: hexColorToRgba(normalizedColor, 0.5),
  };
}

export function normalizeWorkspaceColor(color: string, fallback = "#60646c"): string {
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

interface WorkspaceIdentity {
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
  bannerImagePosition: WorkspaceBannerImagePosition;
  iconName: string;
  iconLabel: string;
  Icon: WorkspaceIconOption["Icon"];
}

function workspaceIdentityFor(workspace: WorkspaceSummary, customizations: WorkspaceCustomizationMap): WorkspaceIdentity {
  const defaultColor = defaultWorkspaceColor(workspace.id);
  const custom = customizations[workspace.id] ?? {};
  const primaryIdentity = primaryAccentIdentity(custom, defaultColor.color);
  const secondaryIdentity = secondaryAccentIdentity(custom, primaryIdentity);
  const colorOption = workspaceColor("Custom", primaryIdentity.referenceHex);
  const hasCustomSecondary = Boolean(custom.secondary || custom.color2);
  const secondaryColor = secondaryIdentity.referenceHex;
  const iconOption = workspaceIconOptionFor(custom.iconName ?? defaultWorkspaceIconName(workspace));
  const bannerImage = normalizeWorkspaceBannerImage(custom.bannerImage);
  const bannerName = workspaceBannerOptionFor(custom.bannerName).name;
  const resolved = resolveSpaceAppearance({
    primary: primaryIdentity,
    secondary: secondaryIdentity,
    bannerName,
    hasBannerImage: Boolean(bannerImage),
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
    bannerImagePosition: normalizeWorkspaceBannerImagePosition(custom.bannerImagePosition),
    iconName: iconOption.name,
    iconLabel: iconOption.label,
    Icon: iconOption.Icon,
  };
}

function workspaceIdentityStyle(identity: WorkspaceIdentity, mode?: SpaceAppearanceMode): CSSProperties {
  const role = <K extends keyof ResolvedSpaceAppearance["light"]>(name: K): ResolvedSpaceAppearance["light"][K] => (
    mode ? identity.resolved[mode][name] : `light-dark(${identity.resolved.light[name]}, ${identity.resolved.dark[name]})`
  ) as ResolvedSpaceAppearance["light"][K];
  return {
    "--workspace-accent-text-body": role("textBody"),
    "--workspace-accent-text-ui": role("textUi"),
    "--workspace-accent-glyph": role("glyph"),
    "--workspace-accent-solid": role("solid"),
    "--workspace-on-accent-solid": role("onSolid"),
    "--workspace-on-accent-muted": role("onSolidMuted"),
    "--workspace-accent-soft-fill": role("softFill"),
    "--workspace-accent-border-state": role("borderState"),
    "--workspace-accent-border-decor": role("borderDecor"),
    "--workspace-accent-focus-ring": role("focusRing"),
    "--workspace-accent-indicator": role("indicator"),
    "--workspace-banner-secondary": identity.resolved.light.bannerSecondary,
    "--workspace-banner-primary-rgb": identity.accentRgb,
    "--workspace-banner-secondary-rgb": identity.secondaryRgb,
    "--surface-tab-accent": identity.color,
    "--surface-tab-accent-soft": identity.softColor,
    // Transitional aliases retain their v1 rendering semantics until every
    // remaining call site has been assigned a semantic role.
    "--workspace-custom-color": identity.color,
    "--workspace-custom-color-soft": identity.softColor,
    "--workspace-selection-accent": identity.color,
    "--workspace-selection-accent-rgb": identity.accentRgb,
    "--workspace-selection-accent2": identity.secondaryColor,
    "--workspace-selection-accent2-rgb": identity.secondaryRgb,
    "--workspace-selection-border": identity.borderColor,
    "--workspace-selection-surface": identity.softColor,
    "--workspace-on-accent": identity.onAccentColor,
    "--workspace-on-primary-accent": identity.onPrimaryAccentColor,
    "--workspace-picker-color": identity.color,
  } as CSSProperties;
}

function defaultWorkspaceIconName(_workspace: WorkspaceSummary): string {
  return "folder";
}

async function processWorkspaceBannerImageFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, GIF, or BMP image.");
  }
  if (file.size > maxWorkspaceBannerImageFileBytes) {
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
      if (dataUrl.startsWith("data:image/webp") && dataUrl.length <= maxWorkspaceBannerImageDataUrlLength) return dataUrl;
    }
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.72);
    if (jpegDataUrl.length <= maxWorkspaceBannerImageDataUrlLength) return jpegDataUrl;
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
export { defaultWorkspaceIconName, processWorkspaceBannerImageFile, workspaceIdentityFor, workspaceIdentityStyle };
export type { WorkspaceIdentity };
