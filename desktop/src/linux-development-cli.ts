import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Reuse the production transport while launching Electron with its project metadata. */
export function prepareLinuxDevelopmentCli(options: {
  repoRoot: string;
  stateDirectory: string;
  electronPath: string;
}): { binDirectory: string; appPath: string } {
  const nativeCli = join(options.repoRoot, "out", "included-tools", "linux-cli", "work-fold-cli");
  if (!existsSync(nativeCli)) {
    throw new Error("The Linux development CLI is missing. Run npm run desktop:linux-native-hosts before npm start.");
  }
  const binDirectory = join(options.stateDirectory, "development-cli");
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  const appPath = join(binDirectory, "app");
  const launchers = [
    [appPath, [options.electronPath, options.repoRoot]],
    [join(binDirectory, "work-fold"), [nativeCli]],
  ] as const;
  for (const [path, command] of launchers) {
    writeFileSync(path, `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")} "$@"\n`, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return { binDirectory, appPath };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
