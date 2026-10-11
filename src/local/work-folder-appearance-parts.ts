/**
 * `work-fold work-folders appearance apply` without a proposal: the banner
 * image, icon, or color named on the command line, merged into the
 * work-folder's current appearance. The image is read and encoded here, the
 * same bounded data URL the Customize dialog stores for an upload
 * (docs/work-folder-customization.md).
 */
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import { resizeImage } from "@earendil-works/pi-coding-agent";

import {
  accentIdentityFromHex,
  maxWorkFolderAppearanceBannerImageDataUrlLength,
  normalizeWorkFolderAppearanceBannerImage,
  type WorkFolderAppearanceCustomization,
} from "../shared/work-folder-appearance.js";

export interface WorkFolderAppearanceParts {
  bannerImagePath?: string;
  icon?: string;
  color?: string;
}

export interface ResolvedWorkFolderAppearanceParts {
  bannerImage?: string;
  iconName?: string;
  color?: string;
}

export class WorkFolderAppearancePartsError extends Error {
  constructor(readonly code: "usage" | "notFound", message: string) {
    super(message);
    this.name = "WorkFolderAppearancePartsError";
  }
}

const bannerImageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
/** Largest source image read; it is resized to the banner's bounds before it is stored. */
export const maxBannerSourceBytes = 25 * 1024 * 1024;
/** Encoded bytes that keep the stored data URL under the appearance store's bound. */
const maxBannerEncodedBytes = Math.floor((maxWorkFolderAppearanceBannerImageDataUrlLength - 64) * 3 / 4);

export async function resolveWorkFolderAppearanceParts(
  parts: WorkFolderAppearanceParts,
  cwd: string,
): Promise<ResolvedWorkFolderAppearanceParts> {
  const resolved: ResolvedWorkFolderAppearanceParts = {};
  if (parts.color !== undefined) {
    const color = parts.color.trim();
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new WorkFolderAppearancePartsError("usage", "--color must be a hex color like #2f7d6d.");
    resolved.color = color.toLowerCase();
  }
  if (parts.icon !== undefined) {
    const icon = parts.icon.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(icon)) {
      throw new WorkFolderAppearancePartsError("usage", "--icon must be an icon name from work-fold's catalog, such as receipt, notebook, or briefcase.");
    }
    resolved.iconName = icon;
  }
  if (parts.bannerImagePath !== undefined) resolved.bannerImage = await encodeBannerImage(parts.bannerImagePath, cwd);
  return resolved;
}

async function encodeBannerImage(rawPath: string, cwd: string): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new WorkFolderAppearancePartsError("usage", "--banner-image needs a file path.");
  const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  const mimeType = bannerImageTypes[extname(path).toLowerCase()];
  if (!mimeType) throw new WorkFolderAppearancePartsError("usage", "--banner-image must be a PNG, JPEG, WebP, or GIF file.");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new WorkFolderAppearancePartsError("notFound", `The banner image was not found: ${trimmed}.`);
  if (info.size > maxBannerSourceBytes) {
    throw new WorkFolderAppearancePartsError("usage", `The banner image is larger than ${maxBannerSourceBytes / (1024 * 1024)} MB.`);
  }
  const resized = await resizeImage(await readFile(path), mimeType, {
    maxWidth: 1600,
    maxHeight: 640,
    maxBytes: maxBannerEncodedBytes,
    jpegQuality: 85,
  }).catch(() => null);
  const dataUrl = resized ? normalizeWorkFolderAppearanceBannerImage(`data:${resized.mimeType};base64,${resized.data}`) : null;
  if (!dataUrl) throw new WorkFolderAppearancePartsError("usage", "work-fold could not turn that file into a banner image. Try a PNG or JPEG.");
  return dataUrl;
}

/** The current appearance with just the named parts changed. A new banner image shows whole, unframed. */
export function applyWorkFolderAppearanceParts(
  current: WorkFolderAppearanceCustomization | null,
  parts: ResolvedWorkFolderAppearanceParts,
): WorkFolderAppearanceCustomization {
  const next: WorkFolderAppearanceCustomization = { ...(current ?? {}), schema: 2 };
  if (parts.color) {
    next.primary = accentIdentityFromHex(parts.color);
    delete next.color;
  }
  if (parts.iconName) next.iconName = parts.iconName;
  if (parts.bannerImage) {
    next.bannerImage = parts.bannerImage;
    delete next.bannerPreset;
    delete next.bannerFraming;
    delete next.bannerImagePosition;
  }
  return next;
}

/** Plain words for the receipt: "banner image, icon, and color". */
export function workFolderAppearancePartsLabel(parts: ResolvedWorkFolderAppearanceParts): string {
  const names = [
    ...(parts.bannerImage ? ["banner image"] : []),
    ...(parts.iconName ? ["icon"] : []),
    ...(parts.color ? ["color"] : []),
  ];
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
