import { useEffect, useRef, type RefObject } from "react";
import { celebrateFinish } from "../lib/motion";
import type { ChatActivityStatus } from "../types";

/** Plays the reply-landed moment on a dot when its Worker goes from running to a waiting reply. */
export function useFinishCelebration(dotRef: RefObject<HTMLElement | null>, status: ChatActivityStatus | null | undefined): void {
  const previousRef = useRef(status);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = status;
    if (previous === "running" && status === "attention") celebrateFinish(dotRef.current);
  }, [dotRef, status]);
}
