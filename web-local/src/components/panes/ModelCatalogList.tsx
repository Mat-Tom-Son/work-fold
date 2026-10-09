import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
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
export function modelCatalogGroups<T extends VendorModel>(models: T[], query: string, groupByProvider = false): Array<{ vendor: string; models: T[] }> {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, T[]>();
  const keyFor = (model: T) => {
    const slash = model.id.indexOf("/");
    const vendor = (slash > 0 ? model.id.slice(0, slash).replace(/^[^a-z0-9]+/i, "") : modelVendor(model)).toLowerCase();
    return groupByProvider ? JSON.stringify([model.provider, vendor]) : vendor;
  };
  // Alias ids and ordinary ids name the same vendor. Prefer the catalog's
  // explicit spelling to a humanized fallback, even when search hides it.
  const labels = new Map<string, string>();
  for (const model of models) {
    const key = keyFor(model), colon = model.name?.trim().indexOf(":") ?? -1;
    if (!labels.has(key) || (colon > 0 && colon <= 40)) labels.set(key, modelVendor(model));
  }
  for (const model of models) {
    const modelVendorName = labels.get(keyFor(model))!;
    const provider = model.providerName || model.provider;
    const vendor = groupByProvider ? (provider === modelVendorName ? provider : `${provider} · ${modelVendorName}`) : modelVendorName;
    if (needle && ![model.name ?? "", model.id, vendor, model.provider, provider].some((value) => value.toLowerCase().includes(needle))) continue;
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

/** Model ids are unique within a provider, not across connected providers. */
export function modelCatalogKey(model: Pick<AgentModel, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}

type FocusTarget = "search" | "selected" | "start" | "end";

/**
 * A provider's models as a dropdown: the closed control shows the chosen
 * model; open, it starts with a search box (past the threshold) and lists the
 * models under vendor headings; choosing one closes it again (2026-09-27).
 */
export function ModelCatalogList({ id, labelledBy, models, value, disabled = false, groupByProvider = false, onChange, controlRef }: {
  id: string;
  labelledBy: string;
  models: AgentModel[];
  value: string;
  disabled?: boolean;
  groupByProvider?: boolean;
  onChange: (id: string) => void;
  /** The element to focus when the settings open onto the model: the closed control. */
  controlRef?: MutableRefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const keyFor = (model: AgentModel) => groupByProvider ? modelCatalogKey(model) : model.id;
  const groups = useMemo(() => modelCatalogGroups(models, query, groupByProvider), [models, query, groupByProvider]);
  const vendorCount = useMemo(() => modelCatalogGroups(models, "", groupByProvider).length, [models, groupByProvider]);
  const selected = models.find((model) => keyFor(model) === value) ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  const showSearch = groupByProvider || models.length > modelCatalogSearchThreshold;
  const listId = `${id}-options`;

  useEffect(() => {
    if (controlRef) controlRef.current = triggerRef.current;
  });

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // The Settings window closes on Escape from a document listener, so the
  // open list claims the key first, on the window, and stops it there.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !pendingFocus.current) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "search" && searchRef.current) {
      searchRef.current.focus();
      listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    focusOption(target === "search" ? "selected" : target);
  }, [open]);

  function options(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
  }

  function focusOption(target: Exclude<FocusTarget, "search">) {
    const items = options();
    if (!items.length) return;
    const selectedIndex = items.findIndex((option) => option.getAttribute("aria-selected") === "true");
    const index = target === "start" ? 0 : target === "end" ? items.length - 1 : Math.max(0, selectedIndex);
    items[index]?.focus();
    items[index]?.scrollIntoView?.({ block: "nearest" });
  }

  function show(target: FocusTarget) {
    if (disabled) return;
    pendingFocus.current = target;
    setOpen(true);
  }

  function choose(modelId: string) {
    onChange(modelId);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function triggerKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) focusOption(event.key === "ArrowDown" ? "start" : "end");
      else show(event.key === "ArrowDown" ? "start" : "end");
    }
  }

  function searchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // The list sits inside the Save Model form; Enter here picks, never saves.
      event.preventDefault();
      const first = query.trim() ? groups[0]?.models[0] : undefined;
      if (first) choose(keyFor(first));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(event.key === "ArrowDown" ? "start" : "end");
    }
  }

  function listKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = options();
    const next = nextMenuItemIndex(items.findIndex((option) => option === document.activeElement), items.length, event.key as MenuNavigationKey);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
    items[next]?.scrollIntoView?.({ block: "nearest" });
  }

  const label = selected ? modelDisplayName(selected) : models.length ? "Choose a model" : "No models available";
  return (
    <div
      className="model-catalog"
      ref={rootRef}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (open && !(next instanceof Node && rootRef.current?.contains(next))) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={open ? "model-catalog-trigger open" : "model-catalog-trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelledBy} ${id}`}
        data-model-id={selected?.id}
        data-provider={selected?.provider}
        title={selected?.id}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show("search"))}
        onKeyDown={triggerKeys}
      >
        <span className="model-catalog-trigger-text">
          <span className="model-catalog-name">{label}</span>
          {groupByProvider && selected ? <span className="model-catalog-id">{selected.providerName || selected.provider}</span> : null}
        </span>
        <svg className="model-catalog-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open ? (
        <div className="model-catalog-popover">
          {showSearch ? (
            <label className="model-catalog-search">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" strokeLinecap="round" /></svg>
              <input ref={searchRef} type="search" value={query} placeholder="Search models" aria-label="Search models" autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKeys} />
            </label>
          ) : null}
          <div className="model-catalog-list" role="listbox" id={listId} aria-labelledby={labelledBy} ref={listRef} tabIndex={-1} onKeyDown={listKeys}>
            {groups.map((group) => (
              <div className="model-catalog-group" role="group" aria-label={group.vendor} key={group.vendor}>
                {groupByProvider || vendorCount > 1 ? <div className="model-catalog-vendor" aria-hidden="true">{group.vendor}</div> : null}
                {group.models.map((model) => {
                  const key = keyFor(model);
                  const isSelected = key === value;
                  return (
                    <button key={key} type="button" role="option" aria-selected={isSelected} data-model-id={model.id} data-provider={model.provider} className={isSelected ? "model-catalog-option selected" : "model-catalog-option"} onClick={() => choose(key)}>
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
      ) : null}
    </div>
  );
}
