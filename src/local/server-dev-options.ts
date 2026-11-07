import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const developmentStateDirectoryName = "work-fold Development";
const productionStateDirectoryName = "work-fold";

type Environment = Readonly<Record<string, string | undefined>>;
type MutableEnvironment = Record<string, string | undefined>;

export interface LocalDevelopmentEnvironment {
  environment?: Environment;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  currentDirectory?: string;
}

export interface LocalDevelopmentApiOptions {
  appMode: "dev";
  port: number;
  stateBase: string;
}

/**
 * Builds the development entrypoint options without starting the API. Keeping
 * this pure makes the state boundary testable without opening a listening port.
 */
export function createLocalDevelopmentApiOptions(
  input: LocalDevelopmentEnvironment = {},
): LocalDevelopmentApiOptions {
  const environment = input.environment ?? process.env;
  const configuredPort = Number(environment.WORKFOLD_LOCAL_API_PORT);
  return {
    appMode: "dev",
    port: Number.isFinite(configuredPort) && configuredPort >= 0 ? configuredPort : 4327,
    stateBase: localDevelopmentStateRoot(input),
  };
}

export function loadLocalEnvironmentFile(
  path: string,
  environment: MutableEnvironment = process.env,
): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || match[1] in environment) continue;
    environment[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

/**
 * Development must not silently open the installed product's state. An
 * explicit WORKFOLD_STATE_DIR remains available for intentional fixtures and
 * migration testing.
 */
export function localDevelopmentStateRoot(input: LocalDevelopmentEnvironment = {}): string {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const currentDirectory = input.currentDirectory ?? process.cwd();
  const override = environment.WORKFOLD_STATE_DIR?.trim();
  if (override) return paths.resolve(currentDirectory, override);

  const homeDirectory = input.homeDirectory ?? homedir();
  const appDataBase = platformApplicationDataBase({ environment, platform, homeDirectory });
  const developmentRoot = paths.resolve(appDataBase, developmentStateDirectoryName);
  const productionRoot = paths.resolve(appDataBase, productionStateDirectoryName);
  const comparableDevelopmentRoot = comparablePath(developmentRoot, platform);
  const comparableProductionRoot = comparablePath(productionRoot, platform);
  if (comparableDevelopmentRoot === comparableProductionRoot) {
    throw new Error("The default development state directory must be separate from work-fold application state.");
  }
  return developmentRoot;
}

function platformApplicationDataBase(input: {
  environment: Environment;
  platform: NodeJS.Platform;
  homeDirectory: string;
}): string {
  const paths = input.platform === "win32" ? win32 : posix;
  if (input.platform === "win32") {
    const appData = input.environment.APPDATA?.trim();
    if (appData) return paths.resolve(appData);
  }
  if (input.platform === "darwin") {
    return paths.resolve(input.homeDirectory, "Library", "Application Support");
  }
  const xdgConfigHome = input.environment.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome
    ? paths.resolve(xdgConfigHome)
    : paths.resolve(input.homeDirectory, ".config");
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}
