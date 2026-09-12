import {
  applicationAppearanceKey, applicationPresetsKey, defaultApplicationAppearance, migrateApplicationAppearance,
  parseApplicationAppearance, parseAppearancePreset, appearancePresetKind,
  type ApplicationAppearance, type AppearancePreset,
} from "../../../src/shared/application-appearance.js";

export const maximumAppearancePresets = 24;
export const maximumAppearanceImportBytes = 16_384;
const maximumStoredAppearanceBytes = 524_288;
const maximumUndo = 20;
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export interface AppearanceSnapshot {
  preferences: ApplicationAppearance;
  presets: readonly AppearancePreset[];
  canUndo: boolean;
  notice: string | null;
  error: string | null;
  presetsError: string | null;
}

/** One preference authority per renderer; storage events refresh its sibling window. */
export class ApplicationAppearanceStore {
  private state: AppearanceSnapshot;
  private undoValues: ApplicationAppearance[] = [];
  private listeners = new Set<() => void>();
  private futureAppearance = false;
  private futurePresets = false;
  constructor(private storage: StoragePort | null, private fixture = false) {
    this.state = { preferences: { ...defaultApplicationAppearance, ...(fixture ? { mode: "light" as const } : {}) }, presets: [], canUndo: false, notice: null, error: null, presetsError: null };
    if (!fixture) this.read(true);
  }
  getSnapshot = (): AppearanceSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Partial<AppearanceSnapshot>) { this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener(); }
  private raw(key: string): string | null { return this.storage?.getItem(key) ?? null; }
  private decode(raw: string): unknown {
    if (raw.length > maximumStoredAppearanceBytes) throw new Error("Saved appearance settings are too large for this build.");
    return JSON.parse(raw);
  }
  private read(initial: boolean) {
    let preferences = this.state.preferences;
    let error: string | null = null;
    let presetsError: string | null = null;
    let presets: AppearancePreset[] = [...this.state.presets];
    this.futureAppearance = false;
    this.futurePresets = false;
    try {
      const raw = this.raw(applicationAppearanceKey);
      if (raw !== null) {
        const value = this.decode(raw) as { version?: unknown } | null;
        this.futureAppearance = Boolean(value && typeof value.version === "number" && value.version > 1);
        preferences = parseApplicationAppearance(value);
      } else {
        let typography: unknown = null;
        try { typography = JSON.parse(this.raw("work-fold.typography.v1") ?? "null"); } catch {}
        preferences = migrateApplicationAppearance(this.raw("work-fold.theme"), typography);
      }
    } catch {
      error = this.futureAppearance
        ? "These appearance settings were saved by a newer build. Changes apply only to this window."
        : "Saved appearance settings could not be read. Your next change will try to save them again.";
    }
    try {
      const raw = this.raw(applicationPresetsKey);
      if (raw === null) presets = [];
      else {
        const value = this.decode(raw) as { version?: unknown; presets?: unknown } | null;
        this.futurePresets = Boolean(value && typeof value.version === "number" && value.version > 1);
        if (!value || value.version !== 1 || Object.keys(value).some((key) => key !== "version" && key !== "presets") || !Array.isArray(value.presets) || value.presets.length > maximumAppearancePresets) throw new Error("Invalid presets");
        presets = value.presets.map(parseAppearancePreset);
        if (new Set(presets.map((preset) => preset.name.toLocaleLowerCase())).size !== presets.length) throw new Error("Duplicate names");
      }
    } catch {
      presetsError = this.futurePresets ? "These saved presets need a newer build; this build will leave them untouched." : "Saved presets could not be read. Export any presets you want to keep before saving again.";
    }
    if (!initial) this.undoValues = [];
    this.publish({ preferences, presets, error, presetsError, notice: null, canUndo: this.undoValues.length > 0 });
  }
  refresh = (key: string | null) => {
    if (this.fixture || (key !== null && key !== applicationAppearanceKey && key !== applicationPresetsKey)) return;
    this.read(false);
  };
  update = (patch: Partial<ApplicationAppearance>) => this.replace({ ...this.state.preferences, ...patch });
  replace = (preferences: ApplicationAppearance, message = "Appearance saved") => {
    const value = parseApplicationAppearance(preferences);
    if (JSON.stringify(value) === JSON.stringify(this.state.preferences)) return;
    this.undoValues.push(this.state.preferences);
    if (this.undoValues.length > maximumUndo) this.undoValues.shift();
    this.persist(value, message);
  };
  applyPreset = (preferences: ApplicationAppearance) => {
    const p = this.state.preferences;
    // Presets can strengthen personal accessibility choices, never weaken them.
    this.replace({ ...preferences, contrast: p.contrast === "more" ? "more" : preferences.contrast,
      motion: p.motion === "reduce" ? "reduce" : preferences.motion,
      transparency: p.transparency === "opaque" ? "opaque" : preferences.transparency }, "Preset applied");
  };
  private savedByNewerBuild(key: string): boolean {
    // A storage event may still be queued in this renderer. Recheck immediately
    // before writing so an older open window cannot erase a newer contract.
    const raw = this.raw(key);
    if (raw === null) return false;
    if (raw.length > maximumStoredAppearanceBytes) throw new Error("Saved settings are too large to replace safely.");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return false; }
    return Boolean(value && typeof value === "object" && "version" in value && typeof value.version === "number" && value.version > 1);
  }
  private persist(preferences: ApplicationAppearance, notice: string) {
    let error: string | null = null;
    if (!this.fixture) {
      try {
        if (!this.storage) throw new Error("Storage unavailable");
        this.futureAppearance ||= this.savedByNewerBuild(applicationAppearanceKey);
        if (this.futureAppearance) error = "These appearance settings were saved by a newer build. Changes apply only to this window.";
        else this.storage.setItem(applicationAppearanceKey, JSON.stringify(preferences));
      } catch { error = "Appearance applied for this window, but it could not be saved. Your previous saved settings remain unchanged."; }
    }
    this.publish({ preferences, canUndo: this.undoValues.length > 0, error, notice: error ? null : this.fixture ? "Preview updated" : notice });
  }
  undo = () => { const previous = this.undoValues.pop(); if (previous) this.persist(previous, "Previous appearance restored"); };
  reset = () => this.replace({ ...defaultApplicationAppearance }, "Appearance reset");
  savePreset = (name: string, preferences = this.state.preferences) => {
    const preset = parseAppearancePreset({ kind: appearancePresetKind, version: 1, name, preferences });
    const existing = this.state.presets.findIndex((item) => item.name.toLocaleLowerCase() === preset.name.toLocaleLowerCase());
    if (existing < 0 && this.state.presets.length >= maximumAppearancePresets) throw new Error(`Keep up to ${maximumAppearancePresets} presets. Remove one before adding another.`);
    const next = [...this.state.presets];
    if (existing >= 0) next[existing] = preset; else next.push(preset);
    this.persistPresets(next, "Preset saved");
    return preset;
  };
  removePreset = (name: string) => this.persistPresets(this.state.presets.filter((preset) => preset.name !== name), "Preset removed");
  importPreset = (text: string) => {
    if (new TextEncoder().encode(text).byteLength > maximumAppearanceImportBytes) throw new Error("Choose an appearance preset smaller than 16 KB.");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("This file is not valid appearance preset JSON."); }
    const preset = parseAppearancePreset(value);
    this.savePreset(preset.name, preset.preferences);
    return preset;
  };
  private persistPresets(presets: readonly AppearancePreset[], notice: string) {
    if (!this.fixture) {
      try { this.futurePresets ||= this.savedByNewerBuild(applicationPresetsKey); }
      catch { throw new Error("The saved presets could not be read safely. Your saved collection is unchanged."); }
    }
    if (this.futurePresets) throw new Error("These saved presets need a newer build; this build will leave them untouched.");
    if (!this.fixture) {
      try {
        if (!this.storage) throw new Error("Storage unavailable");
        this.storage.setItem(applicationPresetsKey, JSON.stringify({ version: 1, presets }));
      } catch { throw new Error("The presets could not be saved. Your saved collection is unchanged."); }
    }
    this.publish({ presets, presetsError: null, notice: this.fixture ? "Preview preset updated" : notice });
  }
}
