import type { TreeEntry } from "./space.js";

export type WorkFoldRemoteOperation =
  | "management.summary"
  | "management.chats"
  | "management.transcript"
  | "management.rename"
  | "management.send"
  | "management.request"
  | "management.stop"
  | "spaces.list"
  | "spaces.tree";

export interface WorkFoldRemotePrincipal {
  browserId: string;
  grantId: string;
  requestId: string;
}

export interface WorkFoldRemoteFacade {
  execute(operation: WorkFoldRemoteOperation, input: unknown, principal: WorkFoldRemotePrincipal): Promise<unknown>;
  purgeUploads(grantId?: string): Promise<void>;
}

export interface WorkFoldRemoteSpaceRef {
  id: string;
  name: string;
}

export interface WorkFoldRemoteTreeResult {
  tree: Array<Pick<TreeEntry, "name" | "path" | "kind" | "sizeBytes" | "updatedAt" | "hasChildren">>;
  truncated: boolean;
}
