/** The Space summary returned by the local API and consumed by the desktop UI. */
export interface SpaceLocation {
  kind: "local";
  storage: "managed" | "linked";
  providerHint?: "google-drive";
}

export interface SpaceSummary {
  id: string;
  name: string;
  spaceRoot: string;
  location: SpaceLocation;
  createdAt: string;
  updatedAt: string;
}
