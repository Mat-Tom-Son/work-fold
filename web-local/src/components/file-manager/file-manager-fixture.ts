import type { TreeEntry } from "../../types";
import type { StandardFolderSummary } from "./file-manager-places";

/**
 * The browser preview's Standard Folders (`?fixture=work-folder&layout=file-manager`).
 * Nothing here touches a real folder.
 */
export function buildFixtureStandardFolders(): { folders: StandardFolderSummary[]; trees: Record<string, TreeEntry[]> } {
  const ago = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
  const file = (name: string, sizeBytes: number, hours: number): TreeEntry => ({ name, path: name, kind: "file", sizeBytes, updatedAt: ago(hours) });
  const folder = (name: string, hours: number, extra: Partial<TreeEntry> = {}): TreeEntry => ({ name, path: name, kind: "folder", updatedAt: ago(hours), ...extra });
  return {
    folders: [
      { id: "desktop", name: "Desktop", root: "/Users/you/Desktop", workFolderId: null },
      { id: "documents", name: "Documents", root: "/Users/you/Documents", workFolderId: null },
      { id: "downloads", name: "Downloads", root: "/Users/you/Downloads", workFolderId: null },
      { id: "pictures", name: "Pictures", root: "/Users/you/Pictures", workFolderId: null },
      { id: "home", name: "you", root: "/Users/you", workFolderId: null },
      { id: "icloud", name: "iCloud Drive", root: "/Users/you/Library/Mobile Documents/com~apple~CloudDocs", workFolderId: null },
    ],
    trees: {
      desktop: [
        file("Screenshot 2026-11-05 at 3.40.10 PM.png", 880_000, 19),
        file("Screenshot 2026-11-06 at 8.02.51 AM.png", 1_400_000, 3),
        file("to-do.txt", 1_200, 50),
      ],
      documents: [
        folder("Home projects", 2, { nestedFolder: true }),
        folder("Letters", 400),
        file("Resume 2026.docx", 52_000, 900),
        file("budget.xlsx", 31_000, 70),
      ],
      pictures: [
        folder("Garden 2026", 30),
        file("beach-sunset.heic", 2_900_000, 200),
        file("kitchen-before.jpg", 3_100_000, 90),
      ],
      home: [
        folder("Desktop", 3),
        folder("Documents", 2),
        folder("Downloads", 18),
        folder("Movies", 900),
        folder("Music", 900),
        folder("Pictures", 30),
      ],
      icloud: [
        folder("Shared Recipes", 120),
        file("Packing list.pages", 220_000, 400),
      ],
      downloads: [
        file("order-113-4492.pdf", 64_000, 87),
        file("invoice-2026-10-internet.pdf", 92_000, 148),
        file("receipt-0931.pdf", 41_000, 70),
        file("lease-renewal-412-maple.pdf", 2_100_000, 122),
        file("printer-driver-5.2.pkg", 212_000_000, 210),
        file("PhotoTool-Installer.dmg", 486_000_000, 170),
        file("kickoff-notes.docx", 48_000, 48),
        file("garden-plan.jpg", 3_600_000, 260),
        file("slides-final-v3.pptx", 8_400_000, 18),
      ],
    },
  };
}
