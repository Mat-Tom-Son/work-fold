import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "linux");
const [executable, ...args] = process.argv.slice(2);
assert.ok(executable, "Provide the GUI executable and optional entrypoint");
const launcherFallback = args.includes("--launcher-fallback");
assert.ok(!launcherFallback || (executable.endsWith(".AppImage") && args.length === 1), "Fallback test requires only an AppImage");
const root = await mkdtemp(join(tmpdir(), "workfold-sandbox-refusal-"));
let shim;
try {
  const env = { ...process.env, WORKFOLD_STATE_DIR: join(root, "state"), WORKFOLD_DESKTOP_STATE_DIR: join(root, "state"),
    WORKFOLD_AGENT_DIR: join(root, "pi"), WORKFOLD_DISABLE_LOGIN_SHELL_ENV: "1" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  if (launcherFallback) {
    shim = await mkdtemp(join(tmpdir(), "workfold-appimage-unshare-"));
    // Exercise the pinned builder launcher's automatic fallback when its user
    // namespace probe fails. This changes only this disposable child's PATH.
    await writeFile(join(shim, "unshare"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    env.PATH = `${shim}:${env.PATH}`;
  }
  const child = spawn(resolve(executable), launcherFallback ? [] : [...args, "--no-sandbox"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-8192); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 1, `Unsafe launch must fail immediately: ${output}`);
  assert.match(output, /work-fold requires the Chromium sandbox/);
  assert.deepEqual(await readdir(root), [], "Unsafe launch must not initialize a profile or Pi resources");
  console.log(`PASS Linux sandbox refusal (${launcherFallback ? "automatic AppImage fallback" : "explicit switch"}): exits before initializing user state`);
} finally {
  await rm(root, { recursive: true, force: true });
  if (shim) await rm(shim, { recursive: true, force: true });
}
