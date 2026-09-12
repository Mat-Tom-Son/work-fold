import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { applicationAppearanceVariables } from "../../../src/shared/application-appearance.js";
import { ApplicationAppearanceStore } from "../lib/application-appearance-store";
import { typographyFontForPlatform } from "../lib/platform";

let normalStore: ApplicationAppearanceStore | null = null;
function browserStore(): ApplicationAppearanceStore {
  if (!normalStore) {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch {}
    normalStore = new ApplicationAppearanceStore(storage);
  }
  return normalStore;
}

function devicePreferences() {
  const matches = (query: string) => window.matchMedia?.(query).matches ?? false;
  return { dark: matches("(prefers-color-scheme: dark)"), contrast: matches("(prefers-contrast: more)"),
    motion: matches("(prefers-reduced-motion: reduce)"), transparency: matches("(prefers-reduced-transparency: reduce)") };
}

export function useApplicationAppearance({ fixtureMode = false, store: suppliedStore }: { fixtureMode?: boolean; store?: ApplicationAppearanceStore } = {}) {
  const store = useMemo(() => suppliedStore ?? (fixtureMode ? new ApplicationAppearanceStore(null, true) : browserStore()), [fixtureMode, suppliedStore]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [device, setDevice] = useState(devicePreferences);
  const [systemAccent, setSystemAccent] = useState<string | null>(null);
  const preferences = snapshot.preferences;
  const theme = preferences.mode === "system" ? device.dark ? "dark" : "light" : preferences.mode;
  const effective = { contrast: preferences.contrast === "more" || device.contrast,
    motion: preferences.motion === "reduce" || device.motion, transparency: preferences.transparency === "opaque" || device.transparency };

  useEffect(() => {
    const media = ["(prefers-color-scheme: dark)", "(prefers-contrast: more)", "(prefers-reduced-motion: reduce)", "(prefers-reduced-transparency: reduce)"].map((query) => window.matchMedia?.(query)).filter(Boolean);
    const change = () => setDevice(devicePreferences());
    for (const item of media) item.addEventListener("change", change);
    const storage = (event: StorageEvent) => store.refresh(event.key);
    if (!fixtureMode) window.addEventListener("storage", storage);
    return () => { for (const item of media) item.removeEventListener("change", change); window.removeEventListener("storage", storage); };
  }, [fixtureMode, store]);

  useEffect(() => {
    if (fixtureMode) return;
    const desktop = window.workFoldDesktop?.window;
    if (!desktop?.getAccentColor) return;
    let live = true;
    let revision = 0;
    const apply = (color: string | null) => { if (live) setSystemAccent(color && /^#[0-9a-f]{6}$/i.test(color) ? color : null); };
    const load = () => { const request = ++revision; void desktop.getAccentColor().then((color) => { if (request === revision) apply(color); }).catch(() => {}); };
    const unsubscribe = desktop.onAccentColorChanged?.((color) => { revision += 1; apply(color); });
    load();
    window.addEventListener("focus", load);
    return () => { live = false; unsubscribe?.(); window.removeEventListener("focus", load); };
  }, [fixtureMode]);

  useEffect(() => {
    const root = document.documentElement;
    const resolved = { ...preferences, font: typographyFontForPlatform(preferences.font) };
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.dataset.workFoldFont = resolved.font;
    root.dataset.workFoldTextSize = preferences.textSize;
    root.dataset.appearancePalette = preferences.palette;
    root.dataset.appearanceDensity = preferences.density;
    root.dataset.appearanceMessages = preferences.messages;
    root.dataset.appearanceContrast = effective.contrast ? "more" : "system";
    root.dataset.appearanceMotion = effective.motion ? "reduce" : "system";
    root.dataset.appearanceTransparency = effective.transparency ? "opaque" : "system";
    for (const [key, value] of Object.entries(applicationAppearanceVariables(resolved, theme, fixtureMode ? null : systemAccent, effective.contrast))) root.style.setProperty(key, value);
    if (!fixtureMode) window.workFoldDesktop?.window?.setTheme?.(theme, preferences.mode);
  }, [preferences, theme, systemAccent, fixtureMode, effective.contrast, effective.motion, effective.transparency]);

  return { ...snapshot, store, theme, device, effective };
}
export type ApplicationAppearanceController = ReturnType<typeof useApplicationAppearance>;
