/**
 * Every prompt token the provider processed for a request, cached or not.
 * Pi reports cache reads and cache writes apart from `input`, and providers
 * bill all three, so counting `input` alone made a turn whose prompt was
 * mostly cached look almost free.
 */
export function promptTokensOf(usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): number {
  return count(usage?.input) + count(usage?.cacheRead) + count(usage?.cacheWrite);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
