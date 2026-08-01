/**
 * Portable Space metadata and executable Pi configuration never belong to
 * ordinary Files, History, attachment, Check, or restricted-app payloads.
 * Match case-insensitively on every platform so a package prepared on macOS
 * cannot expose a reserved Windows path after transfer.
 */
export function isReservedSpacePathSegment(segment: string): boolean {
  const normalized = segment.toLocaleLowerCase("en-US");
  return normalized === ".work-fold" || normalized === ".workspace" || normalized === ".pi";
}

export function containsReservedSpacePathSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some(isReservedSpacePathSegment);
}
