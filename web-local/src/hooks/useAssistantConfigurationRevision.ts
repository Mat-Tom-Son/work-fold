import { useCallback, useEffect, useState } from "react";
import { subscribeControlEvents } from "../lib/control-events";

/** Defaults are re-read after external changes; a Chat's session remains authoritative. */
export function useAssistantConfigurationRevision(enabled = true) {
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    if (!enabled) return;
    return subscribeControlEvents((hint) => {
      if (hint === "assistant" || hint === "reset") changed();
    });
  }, [changed, enabled]);
  return [revision, changed] as const;
}
