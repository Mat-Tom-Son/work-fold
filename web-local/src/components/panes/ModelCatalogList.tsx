import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import type { AgentModel } from "../../types";

type VendorModel = Pick<AgentModel, "id" | "name" | "provider" | "providerName">;

/**
 * The vendor a model belongs to, read from what the catalog gives us:
 * "DeepSeek: DeepSeek V4.1 Flash" and "deepseek/deepseek-v4.1-flash" both
 * read as DeepSeek; a bare list falls back to the provider's own name.
 */
export function modelVendor(model: VendorModel): string {
  const name = model.name?.trim() ?? "";
  const colon = name.indexOf(":");
  if (colon > 0 && colon <= 40) return name.slice(0, colon).trim();
  const slash = model.id.indexOf("/");
  const prefix = slash > 0 ? model.id.slice(0, slash).replace(/^[^a-z0-9]+/i, "") : "";
  if (prefix && prefix.toLowerCase() !== model.provider.toLowerCase()) return humanizeVendor(prefix);
  return model.providerName || model.provider;
}

/** Under its vendor heading, "DeepSeek: DeepSeek V4.1 Flash" reads as "DeepSeek V4.1 Flash". */
export function modelDisplayName(model: VendorModel): string {
  const name = model.name?.trim() || model.id;
  const colon = name.indexOf(":");
  return colon > 0 && colon <= 40 ? name.slice(colon + 1).trim() || name : name;
}

function humanizeVendor(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The models that match the search, grouped by vendor in name order. */
export function modelCatalogGroups<T extends VendorModel>(models: T[], query: string): Array<{ vendor: string; models: T[] }> {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, T[]>();
  for (const model of models) {
    if (needle && ![model.name ?? "", model.id, modelVendor(model)].some((value) => value.toLowerCase().includes(needle))) continue;
    const vendor = modelVendor(model);
    const list = groups.get(vendor) ?? [];
    list.push(model);
    groups.set(vendor, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([vendor, list]) => ({ vendor, models: [...list].sort((left, right) => modelDisplayName(left).localeCompare(modelDisplayName(right), undefined, { numeric: true })) }));
}

/** Past this many models the list gets a search box. */
export const modelCatalogSearchThreshold = 8;

/**
 * A provider's models as a searchable list with vendor headings, in place of
 * one long native select (2026-09-25).
 */
export function ModelCatalogList({ id, labelledBy, models, value, disabled = false, onChange, controlRef }: {
  id: string;
  labelledBy: string;
  models: AgentModel[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  /** The element to focus when the settings open onto the model: the search box when there is one, else the list. */
  controlRef?: MutableRefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => modelCatalogGroups(models, query), [models, query]);
  const vendorCount = useMemo(() => new Set(models.map(modelVendor)).size, [models]);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const showSearch = models.length > modelCatalogSearchThreshold;

  useEffect(() => {
    if (controlRef) controlRef.current = showSearch ? searchRef.current : listRef.current;
  });

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [value, models]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    if (!options.length) return;
    const current = options.findIndex((option) => option === document.activeElement);
    const selected = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    const next = current < 0 ? (selected < 0 ? 0 : selected) : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    event.preventDefault();
    options[next]?.focus();
  }

  return (
    <div className="model-catalog">
      {showSearch ? (
        <label className="model-catalog-search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" strokeLinecap="round" /></svg>
          <input ref={searchRef} type="search" value={query} placeholder="Search models" aria-label="Search models" disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
        </label>
      ) : null}
      <div className="model-catalog-list" role="listbox" id={id} aria-labelledby={labelledBy} ref={listRef} tabIndex={-1} onKeyDown={moveFocus}>
        {groups.map((group) => (
          <div className="model-catalog-group" role="group" aria-label={group.vendor} key={group.vendor}>
            {vendorCount > 1 ? <div className="model-catalog-vendor" aria-hidden="true">{group.vendor}</div> : null}
            {group.models.map((model) => {
              const selected = model.id === value;
              return (
                <button key={model.id} type="button" role="option" aria-selected={selected} data-model-id={model.id} className={selected ? "model-catalog-option selected" : "model-catalog-option"} disabled={disabled} onClick={() => onChange(model.id)}>
                  <span className="model-catalog-name">{modelDisplayName(model)}</span>
                  {model.id !== (model.name?.trim() || model.id) ? <span className="model-catalog-id">{model.id}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length ? <div className="model-catalog-empty" role="status">{models.length ? "No matching models" : "No models available."}</div> : null}
      </div>
    </div>
  );
}
