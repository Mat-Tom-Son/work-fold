/**
 * @-mentions of work-folder Workers in a composer (2026-10-01). The draft text is
 * the only state: a Worker is addressed when its `@Name` appears in the
 * message, whether it was picked from the menu or typed by hand, so deleting
 * the text un-addresses it and nothing hidden rides along with a send.
 */

export interface MentionableFolder {
  id: string;
  name: string;
}

export interface ActiveMention {
  /** Text typed after the `@`, up to the caret. */
  query: string;
  /** Index of the `@` in the draft. */
  start: number;
  /** The caret position the query ends at. */
  end: number;
}

/** The `@query` the caret is in, when it starts a word; null otherwise. */
export function activeFolderMention(draft: string, caret: number): ActiveMention | null {
  const before = draft.slice(0, Math.max(0, Math.min(caret, draft.length)));
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (!match) return null;
  const start = before.length - match[2]!.length - 1;
  return { query: match[2]!, start, end: before.length };
}

/** work-folders whose name matches the query: prefix matches first, then contains, keeping caller order. */
export function matchingMentionFolders<T extends MentionableFolder>(folders: readonly T[], query: string, limit = 6): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return folders.slice(0, limit);
  const scored = folders.flatMap((folder, index) => {
    const name = folder.name.toLocaleLowerCase();
    const words = name.split(/[\s._/-]+/);
    const rank = name.startsWith(normalized) ? 0 : words.some((word) => word.startsWith(normalized)) ? 1 : name.includes(normalized) ? 2 : -1;
    return rank < 0 ? [] : [{ folder, rank, index }];
  });
  return scored
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.folder);
}

/**
 * The draft with the `@word` around the caret replaced by `@Name ` and the
 * caret after it. The rest of a word the caret sits inside is replaced too, so
 * choosing from `@ap|i` never leaves a stray `i` behind.
 */
export function insertFolderMention(draft: string, mention: ActiveMention, folder: MentionableFolder): { value: string; caret: number } {
  const token = `@${folder.name} `;
  const wordEnd = mention.end + (/^[^\s@]*/.exec(draft.slice(mention.end))?.[0].length ?? 0);
  const after = draft.slice(wordEnd).replace(/^ /, "");
  const value = `${draft.slice(0, mention.start)}${token}${after}`;
  return { value, caret: mention.start + token.length };
}

/**
 * The name each work-folder is addressed by. A name shared by several work-folders is
 * qualified with the folders above it on disk (`projA/docs`, `projB/docs`)
 * until it is unique, so `@Name` always means exactly one Worker.
 */
export function mentionNames(folders: ReadonlyArray<MentionableFolder & { workFolderRoot: string }>): Map<string, string> {
  const segments = new Map(folders.map((folder) => [folder.id, folder.workFolderRoot.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean)]));
  const result = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const folder of folders) counts.set(folder.name.toLocaleLowerCase(), (counts.get(folder.name.toLocaleLowerCase()) ?? 0) + 1);
  for (const folder of folders) {
    if ((counts.get(folder.name.toLocaleLowerCase()) ?? 0) < 2) { result.set(folder.id, folder.name); continue; }
    const parts = segments.get(folder.id) ?? [];
    const rivals = folders.filter((other) => other.id !== folder.id && other.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase());
    let label = folder.name;
    for (let depth = 2; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(-depth, -1).join("/");
      label = prefix ? `${prefix}/${folder.name}` : folder.name;
      const clash = rivals.some((other) => {
        const otherParts = segments.get(other.id) ?? [];
        return `${otherParts.slice(-depth, -1).join("/")}/${other.name}`.toLocaleLowerCase() === label.toLocaleLowerCase();
      });
      if (!clash) break;
    }
    result.set(folder.id, label);
  }
  return result;
}

/**
 * The work-folders a message addresses: each whose `@Name` appears at a word start
 * and ends at a boundary. Longer names claim their text first, so `@api docs`
 * never also addresses `@api`.
 */
export function addressedFolderIds(content: string, folders: readonly MentionableFolder[]): string[] {
  const claimed: Array<[number, number]> = [];
  const found = new Set<string>();
  const lower = content.toLocaleLowerCase();
  for (const folder of [...folders].sort((left, right) => right.name.length - left.name.length)) {
    const token = `@${folder.name.toLocaleLowerCase()}`;
    let from = 0;
    while (from <= lower.length) {
      const index = lower.indexOf(token, from);
      if (index < 0) break;
      from = index + 1;
      const end = index + token.length;
      const startsWord = index === 0 || /\s|[(\[{"']/.test(lower[index - 1]!);
      const endsWord = end === lower.length || /[\s.,;:!?)\]}"']/.test(lower[end]!);
      if (!startsWord || !endsWord || claimed.some(([a, b]) => index < b && end > a)) continue;
      claimed.push([index, end]);
      found.add(folder.id);
    }
  }
  return folders.filter((folder) => found.has(folder.id)).map((folder) => folder.id);
}
