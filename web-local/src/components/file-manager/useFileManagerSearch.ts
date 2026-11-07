import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import type { TreeEntry, WorkFolderSummary } from "../../types";

export type FileManagerSearchScope = "here" | "all";

/** One search result row: a name match first, then a line of text that matched. */
export interface FileManagerSearchResult {
  key: string;
  workFolderId: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  match: { kind: "name" } | { kind: "content"; pre: string; hit: string; post: string };
}

const debounceMs = 250;
const maxContentMatchesPerWorkFolder = 60;

/**
 * Search names and contents, as the design does: in the folder shown, or in
 * every work-folder. Names come from each folder's tree and contents from the
 * same search Files uses; both stay inside the work-folders' own rules
 * (ignored, hidden, and nested work-folder content is never searched).
 */
export function useFileManagerSearch(input: {
  query: string;
  scope: FileManagerSearchScope;
  here: { workFolder: WorkFolderSummary; path: string } | null;
  workFolders: readonly WorkFolderSummary[];
  enabled: boolean;
  /** The browser preview's sample trees and file text, searched in place of the host. */
  fixture?: { trees: Record<string, TreeEntry[]>; fileContents: Record<string, Record<string, string>> } | null;
}) {
  const { query, scope, here, workFolders, enabled, fixture } = input;
  const [results, setResults] = useState<FileManagerSearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const treeCache = useRef(new Map<string, TreeEntry[]>());
  const needle = query.trim();
  const targets = scope === "here" && here ? [here] : workFolders.map((workFolder) => ({ workFolder, path: "" }));
  const targetKey = targets.map((target) => `${target.workFolder.id}\0${target.path}`).join("|");

  // A finished search session forgets the trees it read.
  useEffect(() => { if (!needle) treeCache.current.clear(); }, [needle]);

  useEffect(() => {
    if (!enabled || !needle) { setResults([]); setStatus("idle"); return; }
    const controller = new AbortController();
    setStatus("searching");
    const timer = window.setTimeout(() => {
      void Promise.all(targets.map(async ({ workFolder, path }) => {
        const base = `/api/work-folders/${encodeURIComponent(workFolder.id)}`;
        const treeKey = `${workFolder.id}\0${path}`;
        let tree = treeCache.current.get(treeKey);
        if (!tree && fixture) {
          const all = fixture.trees[workFolder.id] ?? [];
          tree = path ? flattenTree(all).find((entry) => entry.path === path)?.children ?? [] : all;
          treeCache.current.set(treeKey, tree);
        }
        if (!tree) {
          const query = new URLSearchParams({ maxDepth: "20", includeIgnored: "0" });
          if (path) query.set("path", path);
          tree = await api<{ tree: TreeEntry[] }>(`${base}/tree?${query}`, { signal: controller.signal }).then((body) => body.tree).catch(() => []);
          treeCache.current.set(treeKey, tree);
        }
        const lower = needle.toLocaleLowerCase();
        const byPath = new Map<string, TreeEntry>();
        const names: FileManagerSearchResult[] = [];
        for (const entry of flattenTree(tree)) {
          byPath.set(entry.path, entry);
          if (entry.nestedFolder || !entry.name.toLocaleLowerCase().includes(lower)) continue;
          names.push(resultFor(workFolder.id, entry, { kind: "name" }));
        }
        const contentQuery = new URLSearchParams({ q: needle, scope: "files", limit: String(maxContentMatchesPerWorkFolder) });
        if (path) contentQuery.set("path", path);
        const content = fixture
          ? Object.entries(fixture.fileContents[workFolder.id] ?? {})
            .filter(([filePath]) => !path || filePath.startsWith(`${path}/`))
            .flatMap(([filePath, text]) => {
              const line = text.split("\n").find((item) => item.toLocaleLowerCase().includes(lower));
              return line ? [{ path: filePath, line: 1, preview: line }] : [];
            })
          : await api<{ files: Array<{ path: string; line: number; preview: string }> }>(`${base}/search?${contentQuery}`, { signal: controller.signal })
            .then((body) => body.files).catch(() => []);
        const named = new Set(names.map((result) => result.path));
        const seen = new Set<string>();
        const texts: FileManagerSearchResult[] = [];
        for (const match of content) {
          if (named.has(match.path) || seen.has(match.path)) continue;
          seen.add(match.path);
          const entry = byPath.get(match.path) ?? { name: match.path.split("/").pop() ?? match.path, path: match.path, kind: "file" as const };
          texts.push(resultFor(workFolder.id, entry, { kind: "content", ...snippet(match.preview, needle) }));
        }
        return { names, texts };
      })).then((perWorkFolder) => {
        if (controller.signal.aborted) return;
        // Every name match first, then every text match, as the design lists them.
        setResults([...perWorkFolder.flatMap((item) => item.names), ...perWorkFolder.flatMap((item) => item.texts)]);
        setStatus("done");
      });
    }, debounceMs);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [enabled, needle, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { results, status };
}

function resultFor(workFolderId: string, entry: TreeEntry, match: FileManagerSearchResult["match"]): FileManagerSearchResult {
  return {
    key: `${workFolderId}\0${entry.path}`,
    workFolderId,
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    match,
  };
}

function flattenTree(entries: readonly TreeEntry[]): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (items: readonly TreeEntry[]) => {
    for (const item of items) {
      out.push(item);
      if (item.children && !item.nestedFolder) walk(item.children);
    }
  };
  walk(entries);
  return out;
}

/**
 * A matched line as a person reads it: Markdown's list marks, heading marks,
 * emphasis, code ticks, and link targets left out ("- **Fixed-price quote:**"
 * reads "Fixed-price quote:").
 */
export function readableLine(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]\s+\[[ xX]\]\s+|[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words around a match, trimmed to whole words, as the design shows them. */
export function snippet(text: string, needle: string): { pre: string; hit: string; post: string } {
  const line = readableLine(text);
  const index = line.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return { pre: line.slice(0, 80), hit: "", post: line.length > 80 ? "…" : "" };
  let start = Math.max(0, index - 34);
  if (start > 0) {
    const space = line.indexOf(" ", start);
    if (space > 0 && space < index) start = space + 1;
  }
  const end = Math.min(line.length, index + needle.length + 46);
  return {
    pre: `${start > 0 ? "…" : ""}${line.slice(start, index)}`,
    hit: line.slice(index, index + needle.length),
    post: `${line.slice(index + needle.length, end)}${end < line.length ? "…" : ""}`,
  };
}
