const shardUsage = "Usage: npm test [-- --shard=<index>/<count>] (for example, --shard=1/4).";

export function parseTestShard(args) {
  if (args.length === 0) return null;
  const match = args.length === 1 && /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(args[0]);
  if (!match || match[0] !== args[0]) throw new Error(`Invalid test arguments. ${shardUsage}`);

  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
    throw new Error(`Invalid test shard: index must be between 1 and count. ${shardUsage}`);
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
