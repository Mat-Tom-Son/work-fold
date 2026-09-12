import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPackage } from "@electron/asar";
const repository = fileURLToPath(new URL("..", import.meta.url));
async function run(command: string, args: string[], timeout: number) {
  const child = spawn(command, args, { cwd: repository, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_TEST_CONTEXT: undefined }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => { output += data.toString(); }); child.stderr.on("data", data => { output += data.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer); assert.equal(code, 0, output); return output;
}
test("five included resources remain inert through actual Pi catalogs in two Spaces", { timeout: 45_000 }, async () => {
  const output = await run(process.execPath, ["--import", "tsx", join(repository, "tests/fixtures/included-tools/catalog-inertness.mts")], 40_000);
  assert.match(output, /PASS included catalog/);
});
test("packaged native shims load and Chrome setup copies from a real Electron ASAR", { skip: process.platform !== "darwin", timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "workfold-asar-acceptance-"));
  try {
    const source = join(root, "source"), archive = join(root, "app.asar");
    await mkdir(join(source, "node_modules"), { recursive: true });
    await cp(join(repository, "resources/included-tools"), join(source, "resources/included-tools"), { recursive: true });
    await cp(join(repository, "node_modules/pi-chrome"), join(source, "node_modules/pi-chrome"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "work-fold-desktop", type: "module" }));
    await createPackage(source, archive);
    // Other native dependencies resolve from the installed tree; the five
    // shipped wrappers and the companion package are deliberately inside ASAR.
    await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    const electron = join(repository, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    const output = await run(electron, [join(repository, "tests/fixtures/included-tools/electron-asar.cjs"), archive, join(root, "output"), repository], 40_000);
    assert.match(output, /PASS Electron ASAR/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
