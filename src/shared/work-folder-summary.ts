/** The work-folder summary returned by the local API and consumed by the desktop UI. */
export interface WorkFolderLocation {
  kind: "local";
  storage: "managed" | "linked";
  providerHint?: "google-drive";
}

export interface WorkFolderSummary {
  id: string;
  name: string;
  workFolderRoot: string;
  location: WorkFolderLocation;
  createdAt: string;
  updatedAt: string;
}
