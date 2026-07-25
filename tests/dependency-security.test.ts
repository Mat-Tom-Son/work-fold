import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const piDir = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent");

test("Pi resolves reviewed fixes for its shrinkwrapped dependencies", async () => {
  const piRequire = createRequire(join(piDir, "package.json"));
  const lock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  for (const [name, expectedVersion] of [
    ["brace-expansion", "5.0.8"],
    ["protobufjs", "7.6.5"],
  ]) {
    const resolvedPackagePath = piRequire.resolve(`${name}/package.json`);
    const resolvedPackage = JSON.parse(await readFile(resolvedPackagePath, "utf8")) as { version?: string };

    assert.equal(resolvedPackage.version, expectedVersion);
    assert.equal(resolvedPackagePath, join(piDir, "node_modules", name, "package.json"));
    assert.equal(
      lock.packages?.[`node_modules/@earendil-works/pi-coding-agent/node_modules/${name}`]?.version,
      expectedVersion,
      "the reproducible install graph must not advertise the vulnerable shrinkwrapped copy",
    );
  }
});
