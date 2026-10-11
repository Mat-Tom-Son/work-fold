import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function sourceFiles(directory: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && pattern.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// A rename that changes `dataset.someId` but not the `data-some-id` attribute
// leaves the reader with undefined and the control silently dead. Each tree is
// its own page, so an attribute in one never satisfies a reader in the other.
for (const [tree, pattern] of [["services/bridge/public", /\.(?:js|html)$/], ["web-local/src", /\.(?:tsx?|html)$/]] as const) {
  test(`every dataset value read in ${tree} is written as a data attribute there`, async () => {
    const files = await sourceFiles(tree, pattern);
    const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const));
    const corpus = sources.map(([, source]) => source).join("\n");
    const missing = new Set<string>();
    for (const [file, source] of sources) {
      for (const [, name] of source.matchAll(/\.dataset\.([a-zA-Z]+)\b(?!\s*=[^=])/g)) {
        const written = corpus.includes(`data-${kebab(name!)}`) || new RegExp(`\\.dataset\\.${name}\\s*=[^=]`).test(corpus);
        if (!written) missing.add(`${file.slice(root.length + 1)}: dataset.${name} has no data-${kebab(name!)}`);
      }
    }
    assert.deepEqual([...missing], []);
  });
}
