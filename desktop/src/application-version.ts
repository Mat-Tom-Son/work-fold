export interface DesktopApplicationVersionOptions {
  isPackaged: boolean;
  electronVersion: string;
  developmentPackageVersion?: string;
}

/**
 * Electron reports its own version when the app is launched directly in
 * development. Packaged applications already report the product version, so
 * only unpackaged builds need the repository package version override.
 */
export function resolveDesktopApplicationVersion(options: DesktopApplicationVersionOptions): string {
  const electronVersion = options.electronVersion.trim();
  if (options.isPackaged) return electronVersion;
  return options.developmentPackageVersion?.trim() || electronVersion;
}
