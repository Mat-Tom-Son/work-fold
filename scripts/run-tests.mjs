import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsDir = join(rootDir, "tests");
const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");

if (!isSupportedTestNode(process.versions.node)) {
  console.error(
    `Test host Node ${process.versions.node} is below the supported floor. Use Node 22.19.0+ (matching the package engines field): ` +
      "the Pi SDK's vendored undici requires it, and older Node fails every SDK-importing suite at module load with " +
      "\"webidl.util.markAsUncloneable is not a function\".",
  );
  process.exit(1);
}

function isSupportedTestNode(version) {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  return major > 22 || (major === 22 && minor >= 19);
}

const entries = await readdir(testsDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => join(testsDir, entry.name))
  .sort((left, right) => left.localeCompare(right));

if (!files.length) {
  throw new Error(`No test files found in ${testsDir}`);
}

// Electron downloads its binary on first require. Resolve it once before the
// parallel macOS ASAR suites start, so a clean npm ci cannot make their first
// launches race a concurrent extraction of the same binary.
if (process.platform === "darwin") {
  createRequire(import.meta.url)("electron");
}

const child = spawn(process.execPath, [tsxCli, "--test", ...files], {
  cwd: rootDir,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
