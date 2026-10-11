import { useEffect, useState } from "react";

import { api, errorText } from "../../lib/api";
import type { AgentModel } from "../../types";
import { ModelCatalogList, modelCatalogKey, modelDisplayName } from "./ModelCatalogList";

interface ImageModelSummary { provider: string; providerName: string; id: string; name: string }
export interface ImageModelSettings {
  selected: { provider: string; id: string } | null;
  /** False when the saved model's provider is disconnected; Automatic is used until it returns. */
  selectedAvailable: boolean;
  automatic: ImageModelSummary | null;
  models: ImageModelSummary[];
}

/** The list's own entry for Automatic, kept apart from any real provider id. */
const automaticEntry = { provider: "work-fold", id: "automatic" };

/**
 * Settings → AI Models → Image model (2026-10-11): one machine-wide choice for
 * every Worker and the work-fold agent, saved as soon as it is picked.
 * Automatic follows work-fold's own preference among connected image models.
 */
export function ImageModelSection({ fixtureMode = false }: { fixtureMode?: boolean }) {
  const [settings, setSettings] = useState<ImageModelSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (fixtureMode) return;
    let current = true;
    api<ImageModelSettings>("/api/agent/image-models")
      .then((result) => { if (current) setSettings(result); })
      .catch((caught) => { if (current) setError(errorText(caught)); });
    return () => { current = false; };
  }, [fixtureMode]);

  if (fixtureMode) return null;

  async function choose(key: string) {
    if (!settings || saving) return;
    const picked = key === modelCatalogKey(automaticEntry)
      ? null
      : settings.models.find((item) => modelCatalogKey(item) === key);
    if (picked === undefined) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await api<ImageModelSettings>("/api/agent/image-model", {
        method: "POST",
        body: { model: picked ? { provider: picked.provider, id: picked.id } : null },
      }));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  // Shown as the model Automatic would pick right now, tagged Automatic.
  const automaticName = settings?.automatic ? modelDisplayName(settings.automatic) : "Automatic";
  const entries = settings ? [
    { ...automaticEntry, name: automaticName, providerName: "Automatic" },
    ...settings.models,
  ] as AgentModel[] : [];
  const value = settings?.selected && settings.selectedAvailable ? modelCatalogKey(settings.selected) : modelCatalogKey(automaticEntry);

  return (
    <section className="ai-models-settings-section" aria-labelledby="image-model-heading">
      <div className="ai-models-section-heading"><h3 id="image-model-heading">Image model</h3></div>
      <div className="professional-field">
        <span className="professional-field-label" id="image-model-label">Used by every Worker and the work-fold agent to make pictures</span>
        {settings ? (
          <ModelCatalogList id="image-model" labelledBy="image-model-label" models={entries} value={value} groupByProvider disabled={saving} onChange={(key) => { void choose(key); }} />
        ) : error ? null : <span className="professional-field-hint">Loading image models…</span>}
        {settings && !settings.models.length ? <span className="professional-field-hint">Connect a provider with image models above, such as OpenRouter, to make pictures.</span> : null}
        {settings?.selected && !settings.selectedAvailable ? <span className="professional-field-hint">The chosen model's provider is not connected, so Automatic is used until it is.</span> : null}
        {error ? <span className="professional-field-hint" role="alert">{error}</span> : null}
      </div>
    </section>
  );
}
