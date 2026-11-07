import { useEffect, useRef, useState } from "react";

import {
  accentIdentityFromHex,
  normalizeWorkFolderAppearanceCustomization,
  upgradeWorkFolderAppearanceCustomization,
  type WorkFolderAppearanceState,
} from "../../../src/shared/work-folder-appearance";
import { workFolderCustomizationStorageKey } from "../constants";
import { api, errorText } from "../lib/api";
import { readStoredJsonValue } from "../lib/storage";
import { normalizeWorkFolderCustomizations } from "../lib/work-folder-customization";
import type { WorkFolderCustomization, WorkFolderCustomizationMap, WorkFolderCustomizationPatch } from "../types";
import { showToast } from "../ui/feedback";
import { workFolderIconOptions } from "../work-folder-icons";

export const supportedWorkFolderIconNames = new Set(workFolderIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])]));

/**
 * Each work-folder's name, colors, icon, and banner as this window shows and
 * saves them: Customize work-folder edits them in either layout, with an undo
 * history per work-folder, and every change is saved on this computer through
 * the local API (a failed save keeps the change for this session and says so).
 */
export function useWorkFolderCustomizations({ fixtureCustomizations, appearance, workFolderIds }: {
  /** The browser preview's sample appearance, which is never saved. */
  fixtureCustomizations: WorkFolderCustomizationMap | null;
  appearance?: WorkFolderAppearanceState;
  /** Every registered work-folder id, joined; a change renormalizes. */
  workFolderIds: string;
}) {
  const fixture = fixtureCustomizations !== null;
  const legacyCustomizationsRef = useRef<WorkFolderCustomizationMap>(fixture ? {} : readStoredJsonValue(
    workFolderCustomizationStorageKey,
    (value) => normalizeWorkFolderCustomizations(value, undefined, supportedWorkFolderIconNames),
    {},
  ));
  const [customizations, setCustomizations] = useState<WorkFolderCustomizationMap>(() => fixtureCustomizations
    ?? normalizeWorkFolderCustomizations(
      { ...legacyCustomizationsRef.current, ...(appearance?.customizations ?? {}) },
      undefined,
      supportedWorkFolderIconNames,
    ));
  const customizationsRef = useRef(customizations);
  const storageWarningShownRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const historyRef = useRef(new Map<string, WorkFolderCustomization[]>());
  const [, setHistoryVersion] = useState(0);
  customizationsRef.current = customizations;

  function setAll(next: WorkFolderCustomizationMap) {
    customizationsRef.current = next;
    setCustomizations(next);
  }

  // Appearance once kept in this browser's storage moves to the local API, once.
  useEffect(() => {
    if (fixture || !Object.keys(legacyCustomizationsRef.current).length) return;
    let cancelled = false;
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = await api<{ appearance: WorkFolderAppearanceState }>("/api/appearance/migrate", {
          method: "POST",
          body: { customizations: legacyCustomizationsRef.current },
        });
        legacyCustomizationsRef.current = {};
        localStorage.removeItem(workFolderCustomizationStorageKey);
        if (!cancelled) setAll(result.appearance.customizations);
      })
      .catch((caught) => {
        if (!cancelled && !storageWarningShownRef.current) {
          storageWarningShownRef.current = true;
          showToast({ text: `work-fold could not migrate the saved work-folder appearance. ${errorText(caught)}`, tone: "info" });
        }
      });
    return () => { cancelled = true; };
  }, [fixture]);

  useEffect(() => {
    // A temporarily missing or moved folder is not the same thing as an
    // explicit work-folder removal. Keep appearance keyed by the portable work-folder id
    // so relinking that folder restores its identity on this computer.
    const next = normalizeWorkFolderCustomizations(customizationsRef.current, undefined, supportedWorkFolderIconNames);
    if (JSON.stringify(next) !== JSON.stringify(customizationsRef.current)) setAll(next);
  }, [workFolderIds]);

  useEffect(() => {
    // A work-folder created after this window loaded may arrive with a saved
    // starting color. Only work-folders this window has no appearance for
    // take the saved one, so nothing here is overwritten.
    const saved = appearance?.customizations ?? {};
    const arriving = Object.entries(saved).filter(([id]) => !customizationsRef.current[id]);
    if (!arriving.length) return;
    setAll(normalizeWorkFolderCustomizations({ ...customizationsRef.current, ...Object.fromEntries(arriving) }, undefined, supportedWorkFolderIconNames));
  }, [appearance?.revision]);

  function remember(workFolderId: string) {
    const history = historyRef.current.get(workFolderId) ?? [];
    history.push(structuredClone(customizationsRef.current[workFolderId] ?? {}));
    if (history.length > 20) history.shift();
    historyRef.current.set(workFolderId, history);
    setHistoryVersion((current) => current + 1);
  }

  function persist(workFolderId: string, customization: WorkFolderCustomization | undefined, options: { remember?: boolean } = {}) {
    if (options.remember !== false) remember(workFolderId);
    const next = { ...customizationsRef.current };
    if (customization && Object.keys(customization).length) next[workFolderId] = customization;
    else delete next[workFolderId];
    setAll(next);
    if (fixture) return;
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (customization && Object.keys(customization).length) {
          await api<{ appearance: WorkFolderAppearanceState }>(`/api/work-folders/${workFolderId}/appearance`, { method: "PUT", body: { customization } });
        } else {
          await api<{ appearance: WorkFolderAppearanceState }>(`/api/work-folders/${workFolderId}/appearance`, { method: "DELETE" });
        }
      })
      .catch((caught) => {
        if (storageWarningShownRef.current) return;
        storageWarningShownRef.current = true;
        showToast({ text: `This appearance works for this session, but work-fold could not save it on this computer. ${errorText(caught)}`, tone: "info" });
      });
  }

  function customize(workFolderId: string, patch: WorkFolderCustomizationPatch) {
    const current = upgradeWorkFolderAppearanceCustomization(customizationsRef.current[workFolderId] ?? {});
    const merged: WorkFolderCustomization = { ...current, ...patch, schema: 2 };
    if (Object.prototype.hasOwnProperty.call(patch, "color")) {
      delete merged.color;
      if (patch.color) merged.primary = accentIdentityFromHex(patch.color);
      else delete merged.primary;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "color2")) {
      delete merged.color2;
      if (patch.color2) merged.secondary = accentIdentityFromHex(patch.color2);
      else delete merged.secondary;
    }
    const normalized = normalizeWorkFolderCustomizations(
      { [workFolderId]: normalizeWorkFolderAppearanceCustomization(merged) },
      new Set([workFolderId]),
      supportedWorkFolderIconNames,
    )[workFolderId];
    persist(workFolderId, normalized);
  }

  function replace(workFolderId: string, customization: WorkFolderCustomization) {
    const normalized = normalizeWorkFolderCustomizations(
      { [workFolderId]: upgradeWorkFolderAppearanceCustomization(customization) },
      new Set([workFolderId]),
      supportedWorkFolderIconNames,
    )[workFolderId];
    persist(workFolderId, normalized);
    showToast({ text: "Appearance proposal applied to this work-folder.", tone: "success" });
  }

  function undo(workFolderId: string) {
    const history = historyRef.current.get(workFolderId) ?? [];
    const previous = history.pop();
    historyRef.current.set(workFolderId, history);
    setHistoryVersion((current) => current + 1);
    if (!previous) return;
    persist(workFolderId, Object.keys(previous).length ? previous : undefined, { remember: false });
    showToast({ text: "Undid the last appearance change.", tone: "success" });
  }

  function reset(workFolderId: string) {
    persist(workFolderId, undefined);
    showToast({ text: "work-folder appearance reset to defaults.", tone: "success" });
  }

  /** A removed work-folder's appearance leaves this window (the host deletes its saved copy). */
  function forget(workFolderId: string) {
    const next = { ...customizationsRef.current };
    delete next[workFolderId];
    setAll(next);
  }

  return {
    customizations,
    customize,
    replace,
    undo,
    reset,
    forget,
    canUndo: (workFolderId: string) => (historyRef.current.get(workFolderId)?.length ?? 0) > 0,
  };
}
