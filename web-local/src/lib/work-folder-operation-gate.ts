export interface WorkFolderOperationToken {
  workFolderId: string;
  generation: number;
}

export interface WorkFolderOperationGate {
  activate: (workFolderId: string) => void;
  capture: () => WorkFolderOperationToken;
  isCurrent: (token: WorkFolderOperationToken) => boolean;
}

/** Invalidates pending UI completions whenever the active work-folder changes. */
export function createWorkFolderOperationGate(initialWorkFolderId: string): WorkFolderOperationGate {
  let workFolderId = initialWorkFolderId;
  let generation = 0;
  return {
    activate(nextWorkFolderId) {
      if (workFolderId === nextWorkFolderId) return;
      workFolderId = nextWorkFolderId;
      generation += 1;
    },
    capture() {
      return { workFolderId, generation };
    },
    isCurrent(token) {
      return token.workFolderId === workFolderId && token.generation === generation;
    },
  };
}
