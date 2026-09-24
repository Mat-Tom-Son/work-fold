/**
 * A short, readable form of a folder's location for list rows. When the home
 * directory is known and contains the path, it becomes `~/…`; otherwise the
 * last two path segments stand in, joined by "/". The full path belongs in a
 * tooltip beside it.
 */
function shortFolderLocation(path: string, homeDirectory: string | undefined = guessHomeDirectory(path)): string {
  const segments = pathSegments(path);
  const homeSegments = homeDirectory ? pathSegments(homeDirectory) : [];
  if (homeSegments.length && homeSegments.length <= segments.length) {
    const windowsLike = /^[A-Za-z]:/.test(path) || path.includes("\\");
    const same = (left: string, right: string) => windowsLike ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (homeSegments.every((segment, index) => same(segment, segments[index]!))) {
      return ["~", ...segments.slice(homeSegments.length)].join("/");
    }
  }
  return segments.slice(-2).join("/");
}

/** The renderer has no home directory; the usual per-user roots are recognisable from the path itself. */
function guessHomeDirectory(path: string): string | undefined {
  const match = /^(\/Users\/[^\/]+|\/home\/[^\/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/.exec(path);
  return match?.[1];
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export { shortFolderLocation };
