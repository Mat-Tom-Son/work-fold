import type { AppTypographyFont } from "../types";

type DesktopPlatform = NodeJS.Platform | undefined;

function desktopPlatform(): DesktopPlatform {
  return typeof window === "undefined" ? undefined : window.workFoldDesktop?.app.platform;
}

function isMacOS(platform: DesktopPlatform = desktopPlatform()): boolean {
  return platform === "darwin";
}

function typographyFontForPlatform(font: AppTypographyFont, platform: DesktopPlatform = desktopPlatform()): AppTypographyFont {
  return isMacOS(platform) && font === "stable" ? "default" : font;
}

function desktopFileDragHint(path: string, platform: DesktopPlatform = desktopPlatform()): string {
  if (platform === "darwin") return `${path} — drag to move, Option-drag to Finder`;
  if (platform === "win32") return `${path} — drag to move, Alt+drag to File Explorer`;
  return `${path} — drag to move`;
}

function spaceEntryNativePath(rootPath: string, relativePath: string, platform: DesktopPlatform = desktopPlatform()): string {
  if (!relativePath) return rootPath;
  const separator = platform === "win32" ? "\\" : "/";
  const root = rootPath.replace(/[\\/]+$/, "");
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return [root, ...segments].join(separator);
}

export { desktopFileDragHint, desktopPlatform, isMacOS, typographyFontForPlatform, spaceEntryNativePath };
export type { DesktopPlatform };
