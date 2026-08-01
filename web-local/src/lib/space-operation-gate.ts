export interface SpaceOperationToken {
  spaceId: string;
  generation: number;
}

export interface SpaceOperationGate {
  activate: (spaceId: string) => void;
  capture: () => SpaceOperationToken;
  isCurrent: (token: SpaceOperationToken) => boolean;
}

/** Invalidates pending UI completions whenever the active Space changes. */
export function createSpaceOperationGate(initialSpaceId: string): SpaceOperationGate {
  let spaceId = initialSpaceId;
  let generation = 0;
  return {
    activate(nextSpaceId) {
      if (spaceId === nextSpaceId) return;
      spaceId = nextSpaceId;
      generation += 1;
    },
    capture() {
      return { spaceId, generation };
    },
    isCurrent(token) {
      return token.spaceId === spaceId && token.generation === generation;
    },
  };
}
