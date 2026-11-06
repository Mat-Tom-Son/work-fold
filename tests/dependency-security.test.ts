import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const piDir = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent");

test("npm accepts the installed graph with scoped security overrides", () => {
  const cli = process.env.npm_execpath;
  const listing = spawnSync(cli ? process.execPath : "npm", [...(cli ? [cli] : []), "ls", "--json", "--all"], {
    cwd: rootDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
  });
  assert.ifError(listing.error);
  const graph = JSON.parse(listing.stdout) as { problems?: string[] };
  assert.deepEqual(graph.problems ?? [], [], "the graph must remain usable for dependency inventories");
  assert.equal(listing.status, 0, listing.stderr);
});

test("Pi resolves the reviewed dependency graph", async () => {
  const piRequire = createRequire(join(piDir, "package.json"));
  const lock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  for (const [name, expectedVersion] of [
    ["brace-expansion", "5.0.12"],
    ["protobufjs", "7.6.5"],
    ["undici", "8.12.3"],
  ]) {
    const resolvedPackagePath = piRequire.resolve(`${name}/package.json`);
    const resolvedPackage = JSON.parse(await readFile(resolvedPackagePath, "utf8")) as { version?: string };

    assert.equal(resolvedPackage.version, expectedVersion);
    assert.equal(
      lock.packages?.[relative(rootDir, dirname(resolvedPackagePath))]?.version,
      expectedVersion,
      "the reproducible install graph must not advertise the vulnerable shrinkwrapped copy",
    );
  }
});
