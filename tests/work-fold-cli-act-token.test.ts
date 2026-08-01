import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readWorkFoldCliActTokenFile,
  removeWorkFoldCliActTokenFile,
  workFoldCliActTokenPath,
  writeWorkFoldCliActTokenFile,
} from "../src/local/cli/index.js";

const token = "b".repeat(64);
const rotated = "c".repeat(64);

test("act token file writes atomically, rotates in place, and round-trips", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-token-test-"));
  try {
    await writeWorkFoldCliActTokenFile(sandbox, token, "work-fold Test");
    const path = workFoldCliActTokenPath(sandbox);
    const first = await readWorkFoldCliActTokenFile(sandbox);
    assert.equal(first?.actToken, token);
    assert.equal(first?.product, "work-fold Test");
    assert.ok(Number.isFinite(Date.parse(first?.createdAt ?? "")));
    if (process.platform !== "win32") {
      assert.equal(((await stat(path)).mode & 0o777), 0o600, "the token file must be private to this user");
    }

    // Rotation replaces a stale file from a previous app run.
    await writeWorkFoldCliActTokenFile(sandbox, rotated, "work-fold Test");
    assert.equal((await readWorkFoldCliActTokenFile(sandbox))?.actToken, rotated);
    assert.equal((await readFile(path, "utf8")).includes(token), false);

    await removeWorkFoldCliActTokenFile(sandbox);
    assert.equal(await readWorkFoldCliActTokenFile(sandbox), null);
    await removeWorkFoldCliActTokenFile(sandbox);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("malformed or oversized token files read as absent", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-token-test-"));
  try {
    assert.equal(await readWorkFoldCliActTokenFile(sandbox), null);
    await writeWorkFoldCliActTokenFile(sandbox, token, "work-fold Test");
    const path = workFoldCliActTokenPath(sandbox);
    for (const bad of [
      "{nope",
      JSON.stringify({ version: 2, actToken: token, createdAt: new Date().toISOString(), product: "x" }),
      JSON.stringify({ version: 1, actToken: "short", createdAt: new Date().toISOString(), product: "x" }),
      JSON.stringify({ version: 1, actToken: token, createdAt: "yesterday", product: "x" }),
      JSON.stringify({ version: 1, actToken: token, createdAt: new Date().toISOString(), product: " " }),
      `{"version":1,"actToken":"${token}","createdAt":"${new Date().toISOString()}","product":"${"x".repeat(8 * 1024)}"}`,
    ]) {
      await writeFile(path, bad, "utf8");
      assert.equal(await readWorkFoldCliActTokenFile(sandbox), null, `must reject: ${bad.slice(0, 40)}`);
    }
    await assert.rejects(() => writeWorkFoldCliActTokenFile(sandbox, "short", "work-fold Test"), /malformed/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
