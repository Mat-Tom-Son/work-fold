import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = resolve(import.meta.dirname, "..");
const binaryName = process.platform === "win32" ? "railway.exe" : "railway";
const binaryPath = resolve(rootDir, ".tools", "railway", binaryName);

try {
  await access(binaryPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
} catch {
  console.error("Railway CLI is not installed. Run `npm run railway:install` first.");
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
