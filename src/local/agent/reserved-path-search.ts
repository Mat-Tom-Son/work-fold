import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * A work-folder's `.work-fold/` holds its identity and its Chat transcripts,
 * and a legacy `.workspace/` holds an old app's records. Neither is the
 * person's content, but Pi's grep and find search hidden folders, so a broad
 * search kept surfacing transcripts: a child Worker could quote the very Chat
 * that handed it work. This hook leaves both out of grep and find results,
 * at any depth, including nested work-folders' own `.work-fold/`.
 *
 * It narrows search only. A deliberate `read` or `ls` of those folders still
 * works, and `.pi/` stays searchable because the person may ask a Worker to
 * work on this work-folder's own Skills & Extensions.
 */
export const reservedSearchSegments = [".work-fold", ".workspace"] as const;

/** ripgrep's exclusion for a search that names no glob of its own. */
export const reservedSearchExclusionGlob = `!**/{${reservedSearchSegments.join(",")}}/**`;

const reservedPathLine = new RegExp(`^(?:[^\\n:]*[\\\\/])?(?:${reservedSearchSegments.map(escapeRegExp).join("|")})(?:[\\\\/]|$)`);
const reservedFindLine = new RegExp(`(?:^|[\\\\/])(?:${reservedSearchSegments.map(escapeRegExp).join("|")})(?:[\\\\/]|$)`);

export const reservedPathSearchExtension: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "grep") return;
    const input = event.input as { glob?: unknown };
    // ripgrep takes one glob from Pi. A search with its own glob keeps it, and
    // the result filter below still removes reserved paths.
    if (input.glob === undefined || input.glob === null || input.glob === "") input.glob = reservedSearchExclusionGlob;
  });
  pi.on("tool_result", (event) => {
    if (event.isError || (event.toolName !== "grep" && event.toolName !== "find")) return;
    const matcher = event.toolName === "grep" ? reservedPathLine : reservedFindLine;
    let removed = 0;
    const content = event.content.map((item) => {
      if (item.type !== "text") return item;
      const kept = item.text.split("\n").filter((line) => {
        if (!matcher.test(line)) return true;
        removed += 1;
        return false;
      });
      return { ...item, text: kept.join("\n") };
    });
    if (!removed) return;
    const empty = content.every((item) => item.type !== "text" || !item.text.trim());
    return {
      content: empty
        ? [{ type: "text" as const, text: event.toolName === "grep" ? "No matches found" : "No files found matching pattern" }]
        : content,
    };
  });
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
