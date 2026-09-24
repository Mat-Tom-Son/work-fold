export interface ComposerModelOption {
  provider: string;
  providerName?: string;
  id: string;
  name: string;
}

export interface ComposerModelGroup<T extends ComposerModelOption> {
  provider: string;
  name: string;
  models: T[];
}

export interface ComposerModelListView<T extends ComposerModelOption> {
  /** The saved model, pinned first whatever the filter says; null when it is not in the list. */
  current: T | null;
  /** Every other model that matches the filter, grouped by provider in name order. */
  groups: ComposerModelGroup<T>[];
  /** How many providers the unfiltered list spans, so group headings stay stable while typing. */
  providerCount: number;
}

/** The model list shows a filter field only past this many models. */
export const composerModelFilterThreshold = 8;

export function composerModelListView<T extends ComposerModelOption>(
  models: T[],
  query: string,
  saved: { provider: string; id: string } | null,
): ComposerModelListView<T> {
  const needle = query.trim().toLowerCase();
  const isSaved = (model: T) => Boolean(saved) && model.provider === saved!.provider && model.id === saved!.id;
  const current = models.find(isSaved) ?? null;
  const groups = new Map<string, ComposerModelGroup<T>>();
  const providers = new Set<string>();
  for (const model of models) {
    providers.add(model.provider);
    if (model === current || !composerModelMatches(model, needle)) continue;
    const group = groups.get(model.provider)
      ?? { provider: model.provider, name: model.providerName || model.provider, models: [] };
    group.models.push(model);
    groups.set(model.provider, group);
  }
  return {
    current,
    groups: [...groups.values()].sort((left, right) => left.name.localeCompare(right.name)),
    providerCount: providers.size,
  };
}

function composerModelMatches(model: ComposerModelOption, needle: string): boolean {
  if (!needle) return true;
  return [model.name, model.id, model.provider, model.providerName ?? ""]
    .some((value) => value.toLowerCase().includes(needle));
}
