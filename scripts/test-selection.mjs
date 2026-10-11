import { resolve } from "node:path";

const testUsage = "Usage: npm test [-- --shard=<index>/<count> | -- tests/<name>.test.ts ...] (for example, --shard=1/4).";

/** Either named test files for a focused run, or the optional shard of the whole suite. */
export function parseTestArguments(args) {
  if (args.length > 0 && args.every((arg) => !arg.startsWith("-") && arg.endsWith(".test.ts"))) {
    return { shard: null, files: [...args] };
  }
  return { shard: parseTestShard(args), files: null };
}

export function parseTestShard(args) {
  if (args.length === 0) return null;
  const match = args.length === 1 && /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(args[0]);
  if (!match || match[0] !== args[0]) throw new Error(`Invalid test arguments. ${testUsage}`);

  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
    throw new Error(`Invalid test shard: index must be between 1 and count. ${testUsage}`);
  }
  return { index, count };
}

export function selectTestFiles(files, shard) {
  // Filename sorting avoids locale-dependent ordering. Whole files
  // keep their before/after hooks and fixtures together; each belongs to exactly
  // one shard. With no shard, this remains the complete local application suite.
  const sorted = [...files].sort();
  if (!shard) return sorted;
  const selected = sorted.filter((_, index) => index % shard.count === shard.index - 1);
  if (selected.length === 0) {
    throw new Error(`Test shard ${shard.index}/${shard.count} is empty (${files.length} test files found).`);
  }
  return selected;
}

/**
 * A focused run names discovered suite files only, so a typo fails loudly
 * instead of running nothing, and every file still runs through this runner.
 */
export function selectRequestedTestFiles(files, requested, cwd = process.cwd()) {
  const known = new Set(files);
  const selected = [];
  for (const arg of requested) {
    const file = resolve(cwd, arg);
    if (!known.has(file)) {
      throw new Error(`Unknown test file: ${arg}. Name a .test.ts file directly under tests/. ${testUsage}`);
    }
    if (!selected.includes(file)) selected.push(file);
  }
  return selected;
}
