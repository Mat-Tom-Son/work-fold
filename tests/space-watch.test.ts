import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { canonicalSpaceWatchRoot } from "../src/local/space-watch.js";

const execFileAsync = promisify(execFile);

test("space watcher roots are canonicalized and missing roots remain diagnosable", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space watch root "));
  const root = join(sandbox, "Space with a long name");
  await mkdir(root);
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  assert.equal(await canonicalSpaceWatchRoot(root), await realpath(root));
  const missing = join(sandbox, "missing");
  assert.equal(await canonicalSpaceWatchRoot(missing), missing);
});

test("Windows 8.3 Space roots expand before reaching the native watcher", { skip: process.platform !== "win32" }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space watch short path "));
  const root = join(sandbox, "Space folder with a long name");
  await mkdir(root);
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const command = `for %I in ("${root.replaceAll('"', '""')}") do @echo %~sI`;
  const { stdout } = await execFileAsync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/c", command],
    { windowsVerbatimArguments: true },
  );
  const shortRoot = stdout.trim();
  if (!shortRoot || shortRoot.toLocaleLowerCase() === root.toLocaleLowerCase()) {
    t.skip("8.3 short names are unavailable on this volume.");
    return;
  }

  assert.equal(await canonicalSpaceWatchRoot(shortRoot), await realpath(root));
});
