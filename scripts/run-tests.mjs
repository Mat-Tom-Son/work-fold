import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseTestArguments, selectRequestedTestFiles, selectTestFiles } from "./test-selection.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsDir = join(rootDir, "tests");
const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const realPiGuard = pathToFileURL(join(rootDir, "scripts", "test-real-pi-guard.mjs")).href;

let selection;
try {
  selection = parseTestArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { shard } = selection;

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
const allFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => join(testsDir, entry.name));

if (!allFiles.length) {
  throw new Error(`No test files found in ${testsDir}`);
}
let files;
try {
  files = selection.files ? selectRequestedTestFiles(allFiles, selection.files) : selectTestFiles(allFiles, shard);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (shard) {
  console.log(`Application test shard ${shard.index}/${shard.count}: ${files.length} of ${allFiles.length} files.`);
}

// Electron downloads its binary on first require. Resolve it once before the
// parallel macOS ASAR suites start, so a clean npm ci cannot make their first
// launches race a concurrent extraction of the same binary.
if (process.platform === "darwin") {
  createRequire(import.meta.url)("electron");
}

// Tests never touch the developer's real Pi folder, where their own sessions,
// settings, and provider credentials live. Every test process and its
// children resolve Pi's agent directory to a fresh temporary folder instead,
// and the guard records anything that still reaches the real one.
const realPiDirs = [...new Set([
  join(homedir(), ".pi"),
  process.env.PI_CODING_AGENT_DIR?.trim(),
  process.env.WORKFOLD_AGENT_DIR?.trim(),
].filter(Boolean).map((path) => resolve(path.replace(/^~(?=$|[\\/])/, homedir()))))];
const testPiRoot = await mkdtemp(join(tmpdir(), "work-fold-test-pi-"));
const realPiWriteLog = join(testPiRoot, "real-pi-writes.jsonl");
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: join(testPiRoot, "agent"),
  WORKFOLD_TEST_REAL_PI_DIRS: realPiDirs.join(delimiter),
  WORKFOLD_TEST_REAL_PI_WRITE_LOG: realPiWriteLog,
};
delete env.WORKFOLD_AGENT_DIR;
delete env.PI_CODING_AGENT_SESSION_DIR;

const child = spawn(process.execPath, [tsxCli, "--import", realPiGuard, "--test", ...files], {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

child.on("exit", async (code, signal) => {
  const realPiWrites = await readRealPiWrites();
  await rm(testPiRoot, { recursive: true, force: true }).catch(() => undefined);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (realPiWrites.length) {
    console.error(`\nThe tests changed the real Pi folder (${realPiDirs.join(", ")}).`);
    console.error("Tests must use the temporary Pi folder this runner provides in PI_CODING_AGENT_DIR:");
    for (const write of realPiWrites) {
      console.error(`  ${relative(rootDir, write.testFile)}: ${write.operation} ${write.path}`);
    }
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

async function readRealPiWrites() {
  const text = await readFile(realPiWriteLog, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
