import type { TreeEntry } from "./space.js";

export type WorkFoldRemoteOperation =
  | "management.summary"
  | "management.chats"
  | "management.transcript"
  | "management.rename"
  | "management.send"
  | "management.request"
  | "management.stop"
  | "management.watch"
  | "management.glance"
  | "management.glanceSeen"
  | "decisions.list"
  | "decisions.decide"
  | "spaces.list"
  | "spaces.tree";

/**
 * One bounded live-progress tick from a `management.watch` operation: the
 * same activity line the popover's local stream shows, carried to the
 * approved browser inside the operation's signed encrypted event envelopes.
 * Content never rides plaintext; the bridge relays ciphertext only.
 */
export interface WorkFoldRemoteWatchProgress {
  activity: string;
}

export interface WorkFoldRemotePrincipal {
  browserId: string;
  grantId: string;
  requestId: string;
}

export interface WorkFoldRemoteFacade {
  execute(operation: WorkFoldRemoteOperation, input: unknown, principal: WorkFoldRemotePrincipal): Promise<unknown>;
  /**
   * Bounded live watch over one management conversation's running turn:
   * emits throttled progress ticks through `emit` and resolves when the turn
   * settles or the watch window closes, whichever comes first. The browser
   * starts a watch only when `management.summary` advertises the capability,
   * so older hosts without this method are never asked. Every emitted tick is
   * separately authority-checked by the caller before it leaves the desktop.
   */
  watch?(input: unknown, principal: WorkFoldRemotePrincipal, emit: (progress: WorkFoldRemoteWatchProgress) => void): Promise<unknown>;
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
