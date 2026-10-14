import { access } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

const officeDocumentExtensions = new Set([
  ".doc", ".docm", ".docx", ".dot", ".dotm", ".dotx",
  ".xls", ".xlsb", ".xlsm", ".xlsx", ".xlt", ".xltm", ".xltx",
  ".pot", ".potm", ".potx", ".ppt", ".pptm", ".pptx",
]);

export function isOfficeDocumentPath(path: string): boolean {
  return officeDocumentExtensions.has(extname(path).toLowerCase());
}

export function isOfficeLockFileName(name: string): boolean {
  return name.startsWith("~$") || /^\.~lock\..+#$/.test(name);
}
export async function officeDocumentLockPresent(absolutePath: string): Promise<boolean> {
  if (!isOfficeDocumentPath(absolutePath)) return false;
  const directory = dirname(absolutePath);
  const name = basename(absolutePath);
  const candidates = new Set([`~$${name}`, `.~lock.${name}#`]);
  if (name.length > 2) candidates.add(`~$${name.slice(2)}`);
  for (const candidate of candidates) {
    try {
      await access(join(directory, candidate));
      return true;
    } catch {
      // Try the next Office naming convention.
    }
  }
  return false;
}

export const OFFICE_OPEN_DOCUMENT_READ_NOTE =
  "This document appears to be open in an Office application. Attached content reflects the latest saved version; unsaved edits are not visible yet.";
