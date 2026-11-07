import { useEffect, useState } from "react";

import { readStoredValue, writeStoredValue } from "./storage";

/**
 * Which window layout this Mac shows (2026-11-06): the classic rail and tabs,
 * or the file manager being built beside it (docs/product-model.md, "File
 * manager layout"). It is a per-machine view choice, like window size, so it
 * lives in local storage rather than in a work-folder or the app's appearance
 * presets. `?layout=file-manager` previews it without changing the choice.
 */
export type AppLayout = "classic" | "file-manager";

export const appLayoutStorageKey = "work-fold.layout.v1";
const appLayoutChangeEvent = "work-fold:layout-change";

export function normalizeAppLayout(value: unknown): AppLayout {
  return value === "file-manager" ? "file-manager" : "classic";
}

export function readAppLayout(): AppLayout {
  const requested = new URLSearchParams(window.location.search).get("layout");
  if (requested) return normalizeAppLayout(requested);
  return normalizeAppLayout(readStoredValue(appLayoutStorageKey));
}

export function writeAppLayout(layout: AppLayout): void {
  writeStoredValue(appLayoutStorageKey, layout === "classic" ? null : layout);
  window.dispatchEvent(new CustomEvent(appLayoutChangeEvent, { detail: layout }));
}

/** The current layout, following changes made from Settings or another window. */
export function useAppLayout(): AppLayout {
  const [layout, setLayout] = useState<AppLayout>(readAppLayout);
  useEffect(() => {
    const update = () => setLayout(readAppLayout());
    const fromStorage = (event: StorageEvent) => { if (event.key === appLayoutStorageKey) update(); };
    window.addEventListener(appLayoutChangeEvent, update);
    window.addEventListener("storage", fromStorage);
    return () => {
      window.removeEventListener(appLayoutChangeEvent, update);
      window.removeEventListener("storage", fromStorage);
    };
  }, []);
  return layout;
}
