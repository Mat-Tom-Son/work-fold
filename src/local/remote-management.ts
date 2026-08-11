import type { TreeEntry } from "./space.js";

export type WorkFoldRemoteOperation =
  | "management.summary"
  | "management.chats"
  | "management.transcript"
  | "management.rename"
  | "management.send"
  | "management.request"
  | "management.stop"
  | "management.glance"
  | "management.glanceSeen"
  | "decisions.list"
  | "decisions.decide"
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
  /**
   * Desktop-local revocation cascade for one grant (or every grant when
   * omitted): cancels pending staged acts whose staging provenance traces to
   * the revoked browser and deletes its `remote:<grantId>` glance marker
   * (docs/fold-consecrations.md, docs/fold-glance.md). The remote client runs
   * it inside its revocation cleanup, before any bridge mutation. Optional so
   * narrow facades — and older hosts — keep working; decided acts stand
   * either way, named by their receipts.
   */
  revokeGrantAuthority?(grantId?: string): Promise<void>;
}

export interface WorkFoldRemoteSpaceRef {
  id: string;
  name: string;
}

export interface WorkFoldRemoteTreeResult {
  tree: Array<Pick<TreeEntry, "name" | "path" | "kind" | "sizeBytes" | "updatedAt" | "hasChildren">>;
  truncated: boolean;
}
