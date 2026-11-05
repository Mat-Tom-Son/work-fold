/**
 * What a menu calls several rows selected together in Files (2026-11-05):
 * "3 Files", "2 Folders", or "5 Items" when both kinds are in it. The native
 * Mac menu and the renderer's menu use the same words.
 */
export function fileSelectionLabel(files: number, folders: number): string {
  const count = files + folders;
  if (folders === 0) return `${count} ${count === 1 ? "File" : "Files"}`;
  if (files === 0) return `${count} ${count === 1 ? "Folder" : "Folders"}`;
  return `${count} Items`;
}
