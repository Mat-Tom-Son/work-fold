import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { applicationPalettes, builtInAppearancePresets, type ApplicationAppearance, type AppearancePreset } from "../../../../src/shared/application-appearance.js";
import type { ApplicationAppearanceController } from "../../hooks/useApplicationAppearance";
import { maximumAppearanceImportBytes } from "../../lib/application-appearance-store";
import { typographyFontOptionsForPlatform } from "../../constants";
import type { SpaceSummary } from "../../types";

export function AppearanceSettingsPane({ appearance, space, onCustomizeSpace }: {
  appearance: ApplicationAppearanceController;
  space: SpaceSummary | null;
  onCustomizeSpace?: (spaceId: string) => void;
}) {
  const { preferences: p, store } = appearance;
  const [presetName, setPresetName] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [accentDraft, setAccentDraft] = useState<string | null>(null);
  const [accentError, setAccentError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRevision = useRef(0);
  useEffect(() => () => { importRevision.current += 1; }, []);
  useEffect(() => { setAccentDraft(null); setAccentError(null); }, [p.accent]);
  const fontOptions = typographyFontOptionsForPlatform(window.workFoldDesktop?.app.platform);
  const update = (patch: Partial<ApplicationAppearance>) => store.update(patch);
  function runPreset(action: () => void) {
    setPresetError(null);
    try { action(); } catch (caught) { setPresetError(caught instanceof Error ? caught.message : "The preset could not be saved."); }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    const revision = ++importRevision.current;
    setPresetError(null); setPresetBusy(true);
    try {
      if (file.size > maximumAppearanceImportBytes) throw new Error("Choose an appearance preset smaller than 16 KB.");
      const text = await file.text();
      if (revision !== importRevision.current) return;
      const preset = store.importPreset(text);
      setPresetName(preset.name);
    } catch (caught) {
      if (revision === importRevision.current) setPresetError(caught instanceof Error ? caught.message : "The preset could not be imported.");
    } finally { if (revision === importRevision.current) setPresetBusy(false); }
  }
  function exportPreset(preset: AppearancePreset) {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(preset, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${preset.name.replace(/[^\p{L}\p{N}_-]+/gu, "-") || "appearance"}.work-fold-appearance.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return <div className="appearance-settings">
    <div className="appearance-settings-status-row">
      <p role="status">{appearance.error ?? appearance.notice ?? "Changes save on this device"}</p>
      <div className="appearance-settings-actions"><button type="button" disabled={!appearance.canUndo} onClick={store.undo}>Undo</button><button type="button" onClick={store.reset}>Reset</button></div>
    </div>
    <section className="appearance-settings-section" aria-labelledby="appearance-presets-title">
      <div className="appearance-settings-heading"><h3 id="appearance-presets-title">Start with a look</h3><p>Choose a starting point, then make it yours.</p></div>
      <div className="appearance-settings-presets">
        {builtInAppearancePresets.map(({ name, ...patch }) => {
          const grounds = applicationPalettes[patch.palette][appearance.theme];
          return <button type="button" key={name} className={p.palette === patch.palette ? "appearance-preset active" : "appearance-preset"} aria-label={`${name} preset`} onClick={() => store.applyPreset({ ...p, ...patch })}>
            <span aria-hidden="true" className="appearance-preset-swatch" style={{ "--preset-canvas": grounds.canvas, "--preset-surface": grounds.surface, "--preset-text": grounds.text, "--preset-accent": applicationPalettes[patch.palette].accent } as CSSProperties}><span /><i /><b /></span><span>{name}</span>
          </button>;
        })}
      </div>
      <div className="appearance-settings-preview" aria-label="Appearance preview">
        <div className="appearance-preview-files"><span>Workshop</span><div>Notes.md</div><div>Next steps.pdf</div></div>
        <div className="appearance-preview-chat"><p className="appearance-preview-user">Plan a workshop for 12 people.</p><div className="appearance-preview-answer"><p>Your plan is ready. The workshop starts at 10 AM, with a break at noon.</p><code>workshop-plan.md</code></div></div>
      </div>
    </section>
    <section className="appearance-settings-section" aria-labelledby="appearance-color-title">
      <h3 id="appearance-color-title">Color</h3>
      <Choice label="Color mode" value={p.mode} onChange={(mode) => update({ mode })} options={[["system", "Device setting"], ["light", "Light"], ["dark", "Dark"]]} />
      <Choice label="Palette" value={p.palette} onChange={(palette) => update({ palette })} options={Object.entries(applicationPalettes).map(([value, palette]) => [value as ApplicationAppearance["palette"], palette.name])} />
      <div className="appearance-settings-row"><div><span className="appearance-settings-label">Accent</span><small>Adjusted for readable text and controls.</small></div><div className="appearance-settings-accent">
        <select aria-label="Accent source" value={p.accent === "system" ? "system" : "custom"} onChange={(event) => { update({ accent: event.target.value === "system" ? "system" : applicationPalettes[p.palette].accent }); setAccentError(null); setAccentDraft(null); }}><option value="system">Device accent</option><option value="custom">Custom color</option></select>
        {p.accent !== "system" ? <><input type="color" aria-label="Choose accent color" value={p.accent} onChange={(event) => { update({ accent: event.target.value }); setAccentDraft(null); setAccentError(null); }} /><input className="appearance-accent-hex" aria-label="Accent hex color" maxLength={7} value={accentDraft ?? p.accent} onChange={(event) => setAccentDraft(event.target.value)} onBlur={() => { if (accentDraft === null) return; if (/^#[0-9a-f]{6}$/i.test(accentDraft)) { update({ accent: accentDraft }); setAccentDraft(null); setAccentError(null); } else setAccentError("Use a color such as #397451."); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></> : null}
      </div></div>
      {accentError ? <p className="appearance-settings-error" role="alert">{accentError}</p> : null}
    </section>
    <section className="appearance-settings-section" aria-labelledby="appearance-interface-title">
      <h3 id="appearance-interface-title">Interface</h3>
      <Choice label="App font" value={p.font === "stable" && !fontOptions.some((option) => option.value === "stable") ? "default" : p.font} onChange={(font) => update({ font })} options={fontOptions.map((option) => [option.value, option.label])} />
      <Choice label="Text size" value={p.textSize} onChange={(textSize) => update({ textSize })} options={[["compact", "Compact · 14 px"], ["standard", "Standard · 15 px"], ["comfortable", "Comfortable · 16 px"], ["large", "Large · 18 px"]]} />
      <Choice label="List density" detail="Space files and chat lists." value={p.density} onChange={(density) => update({ density })} options={[["compact", "Compact"], ["standard", "Standard"], ["spacious", "Spacious"]]} />
    </section>
    <section className="appearance-settings-section" aria-labelledby="appearance-reading-title">
      <h3 id="appearance-reading-title">Conversations</h3>
      <Choice label="Reading font" value={p.readingFont} onChange={(readingFont) => update({ readingFont })} options={[["app", "App font"], ["serif", "Serif"], ["system", "System font"]]} />
      <Choice label="Reading size" value={String(p.readingSize)} onChange={(size) => update({ readingSize: Number(size) })} options={Array.from({ length: 9 }, (_, i) => [String(i + 14), `${i + 14} px`])} />
      <Choice label="Reading width" value={p.measure} onChange={(measure) => update({ measure })} options={[["focused", "Focused"], ["standard", "Standard"], ["wide", "Wide"]]} />
      <Choice label="Line spacing" value={p.spacing} onChange={(spacing) => update({ spacing })} options={[["tight", "Tight"], ["standard", "Standard"], ["relaxed", "Relaxed"]]} />
      <Choice label="Your messages" value={p.messages} onChange={(messages) => update({ messages })} options={[["tinted", "Tinted"], ["quiet", "Quiet"]]} />
      <Choice label="Code font" value={p.codeFont} onChange={(codeFont) => update({ codeFont })} options={[["system", "System monospace"], ["menlo", "Menlo"], ["consolas", "Consolas"]]} />
    </section>
    <section className="appearance-settings-section" aria-labelledby="appearance-accessibility-title">
      <div className="appearance-settings-heading"><h3 id="appearance-accessibility-title">Comfort & accessibility</h3><p>Your device’s accessibility settings always apply.</p></div>
      <Choice label="Contrast" detail={appearance.device.contrast ? "Higher contrast is enabled on your device." : undefined} value={p.contrast} onChange={(contrast) => update({ contrast })} options={[["system", "Device setting"], ["more", "Higher contrast"]]} />
      <Choice label="Motion" detail={appearance.device.motion ? "Reduced motion is enabled on your device." : undefined} value={p.motion} onChange={(motion) => update({ motion })} options={[["system", "Device setting"], ["reduce", "Reduce motion"]]} />
      <Choice label="Transparency" detail={appearance.device.transparency ? "Reduced transparency is enabled on your device." : undefined} value={p.transparency} onChange={(transparency) => update({ transparency })} options={[["system", "Device setting"], ["opaque", "Opaque surfaces"]]} />
    </section>
    <section className="appearance-settings-section" aria-labelledby="appearance-saved-title">
      <div className="appearance-settings-heading"><h3 id="appearance-saved-title">Your presets</h3><p>Save a look here, or share it as an appearance file.</p></div>
      <form className="appearance-settings-save" onSubmit={(event) => { event.preventDefault(); runPreset(() => { store.savePreset(presetName); setPresetName(""); }); }}>
        <input aria-label="Preset name" placeholder="Name this look" maxLength={60} value={presetName} onChange={(event) => setPresetName(event.target.value)} /><button type="submit" disabled={!presetName.trim() || presetBusy}>Save preset</button><button type="button" disabled={presetBusy} onClick={() => fileRef.current?.click()}>{presetBusy ? "Importing…" : "Import"}</button>
        <input ref={fileRef} hidden type="file" accept=".json,application/json" aria-label="Import appearance preset" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      </form>
      {appearance.presets.map((preset) => <div className="appearance-settings-saved" key={preset.name}><span>{preset.name}</span><div className="appearance-settings-actions"><button type="button" aria-label={`Apply ${preset.name}`} onClick={() => store.applyPreset(preset.preferences)}>Apply</button><button type="button" aria-label={`Export ${preset.name}`} onClick={() => runPreset(() => exportPreset(preset))}>Export</button><button type="button" aria-label={`Remove ${preset.name}`} onClick={() => runPreset(() => store.removePreset(preset.name))}>Remove</button></div></div>)}
      {presetError || appearance.presetsError ? <p className="appearance-settings-error" role="alert">{presetError ?? appearance.presetsError}</p> : null}
    </section>
    {space && onCustomizeSpace ? <section className="appearance-settings-space"><div><h3>{space.name}</h3><p>Give this Space its own color, icon, and banner.</p></div><button type="button" onClick={() => onCustomizeSpace(space.id)}>Customize this Space</button></section> : null}
    <p className="appearance-settings-scope">Applies to this desktop and its menu-bar chat. The web fold keeps its browser appearance. Space colors and banners stay yours.</p>
  </div>;
}

function Choice<T extends string>({ label, value, options, onChange, detail }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; detail?: ReactNode }) {
  return <label className="appearance-settings-row"><span><span className="appearance-settings-label">{label}</span>{detail ? <small>{detail}</small> : null}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>;
}
