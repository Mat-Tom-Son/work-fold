import { posix, win32 } from "node:path";

/**
 * Pure pieces of "Open with": the app-picker dialog options and the launch
 * plan for the app the person chose. The main process owns validation of the
 * Space file, shows the dialog, and executes the plan without a shell.
 */

export interface OpenWithDialogOptions {
  title: string;
  properties: ["openFile"];
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export type OpenWithLaunchPlan =
  | { kind: "exec"; command: "/usr/bin/open"; args: [string, string, string] }
  | { kind: "spawn"; command: string; args: [string] };

export async function openFileWithPickedApp(platform: NodeJS.Platform, dependencies: {
  resolveFile: () => Promise<string>;
  pickApp: () => Promise<string | null>;
  launch: (plan: OpenWithLaunchPlan) => Promise<void>;
}): Promise<{ opened: boolean; canceled: boolean; appName: string | null }> {
  // Fail before showing a picker for an unavailable file. Recheck after the
  // dialog: the Folder or its files may have changed while it was open.
  await dependencies.resolveFile();
  const appPath = await dependencies.pickApp();
  if (!appPath) return { opened: false, canceled: true, appName: null };
  const filePath = await dependencies.resolveFile();
  const appName = openWithAppName(appPath, platform);
  try {
    await dependencies.launch(openWithLaunchPlan(platform, appPath, filePath));
  } catch {
    throw new Error(`Couldn't open with ${appName}.`);
  }
  return { opened: true, canceled: false, appName };
}

export function openWithDialogOptions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): OpenWithDialogOptions {
  const base = { title: "Choose an app", properties: ["openFile"] as ["openFile"] };
  if (platform === "darwin") {
    return { ...base, defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] };
  }
  if (platform === "win32") {
    return { ...base, defaultPath: env.ProgramFiles ?? "C:\\Program Files", filters: [{ name: "Applications", extensions: ["exe"] }] };
  }
  return base;
}

/** The chosen app's display name: its basename without the extension. */
export function openWithAppName(appPath: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  const trimmed = appPath.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  const name = path.basename(trimmed, path.extname(trimmed));
  return name || path.basename(trimmed) || appPath;
}

/**
 * macOS hands the file to the chosen bundle through `open -a`; elsewhere the
 * chosen executable receives the file path as its only argument. Both are
 * argument vectors, never a shell string.
 */
export function openWithLaunchPlan(platform: NodeJS.Platform, appPath: string, filePath: string): OpenWithLaunchPlan {
  if (!appPath || !filePath || appPath.includes("\0") || filePath.includes("\0")) {
    throw new Error("An app and a file are required.");
  }
  if (platform === "darwin") return { kind: "exec", command: "/usr/bin/open", args: ["-a", appPath, filePath] };
  return { kind: "spawn", command: appPath, args: [filePath] };
}
