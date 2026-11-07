/** A file dropped from Finder or File Explorer, with its path inside any dropped folder. */
export interface DroppedUploadFile { file: File; relativePath: string }

/**
 * Every file in a drop, folders read through to their files. Call it before
 * the first await: a dropped folder's entries are readable only while the
 * drop event's DataTransfer is alive.
 */
export async function collectDroppedUploadFiles(dataTransfer: DataTransfer): Promise<DroppedUploadFile[]> {
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length) {
    const files: DroppedUploadFile[] = [];
    for (const entry of entries) await collectDroppedEntryFiles(entry, "", files);
    return files;
  }
  return Array.from(dataTransfer.files).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

async function collectDroppedEntryFiles(entry: FileSystemEntry, parentPath: string, output: DroppedUploadFile[]): Promise<void> {
  if (isDroppedFileEntry(entry)) {
    const file = await droppedFileFromEntry(entry);
    output.push({ file, relativePath: joinDropPath(parentPath, entry.name || file.name) });
    return;
  }
  if (!isDroppedDirectoryEntry(entry)) return;
  const directoryPath = joinDropPath(parentPath, entry.name);
  for (const child of await readDroppedDirectoryEntries(entry)) await collectDroppedEntryFiles(child, directoryPath, output);
}

function isDroppedFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile && typeof (entry as Partial<FileSystemFileEntry>).file === "function";
}

function isDroppedDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory && typeof (entry as Partial<FileSystemDirectoryEntry>).createReader === "function";
}

function droppedFileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolvePromise, reject) => { entry.file(resolvePromise, reject); });
}

async function readDroppedDirectoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolvePromise, reject) => { reader.readEntries(resolvePromise, reject); });
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

function joinDropPath(...segments: string[]) {
  return segments.map((segment) => segment.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
