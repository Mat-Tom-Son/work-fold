import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dismiss12Regular } from "@fluentui/react-icons";

import { errorText } from "../../lib/api";
import { fileManagerIcon } from "./file-manager-model";
import type { FileManagerPlace } from "./file-manager-places";

/** What the host (or the preview's sample folders) found for a typed path. */
export interface GoToFolderLookup {
  target: { place: FileManagerPlace; path: string; select: string | null } | null;
  suggestions: Array<{ name: string; kind: "folder" | "file"; path: string }>;
  message: string | null;
}

/**
 * Go to Folder, as Finder's ⇧⌘G (owner request, 2026-11-07): type or paste a
 * path ("~/Documents/Taxes", "/Users/you/Downloads", or a name inside the
 * folder shown) and go straight there. Names that complete the path are listed
 * as you type: Tab completes the chosen one, the arrow keys choose, Return
 * goes, Escape closes. A file's path opens its folder with the file selected.
 */
export function GoToFolderSheet({ initialPath, currentFolder, lookup, onGo, onClose }: {
  /** The folder shown, as its path on this computer; the field starts with it. */
  initialPath: string;
  /** Where a name without a leading "/" or "~" is looked for. */
  currentFolder: string;
  lookup: (path: string) => Promise<GoToFolderLookup>;
  onGo: (target: NonNullable<GoToFolderLookup["target"]>) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialPath);
  const [result, setResult] = useState<GoToFolderLookup | null>(null);
  const [active, setActive] = useState(-1);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Completions follow the typing, a moment after it pauses.
  useEffect(() => {
    const request = ++requestRef.current;
    setMessage(null);
    if (!value.trim()) { setResult(null); setActive(-1); return; }
    const timer = window.setTimeout(() => {
      void lookup(absolute(value, currentFolder)).then((found) => {
        if (request !== requestRef.current) return;
        setResult(found);
        setActive(-1);
      }).catch(() => undefined);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = result?.suggestions ?? [];

  async function go(path: string) {
    try {
      const found = await lookup(absolute(path, currentFolder));
      if (found.target) { onGo(found.target); return; }
      setResult(found);
      setMessage(found.message ?? "There’s no folder or file at that path.");
    } catch (caught) {
      setMessage(errorText(caught));
    }
  }

  function complete(index: number) {
    const chosen = suggestions[index];
    if (!chosen) return;
    setValue(`${chosen.path}${chosen.kind === "folder" ? "/" : ""}`);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!suggestions.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Tab" && suggestions.length) {
      event.preventDefault();
      complete(active >= 0 ? active : 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = active >= 0 ? suggestions[active] : null;
      void go(chosen ? chosen.path : value);
    }
  }

  return <>
    <div className="fm-goto-back" onMouseDown={onClose} />
    <section className="fm-goto" role="dialog" aria-modal="true" aria-label="Go to Folder">
      <div className="fm-goto-field">
        <input
          ref={inputRef}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label="Folder or file path"
          aria-autocomplete="list"
          aria-controls="fm-goto-list"
          aria-activedescendant={active >= 0 ? `fm-goto-item-${active}` : undefined}
          placeholder="Type a path, like ~/Documents"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={keyDown}
        />
        {value ? <button type="button" className="fm-goto-clear" aria-label="Clear" onMouseDown={(event) => event.preventDefault()} onClick={() => { setValue(""); inputRef.current?.focus(); }}><Dismiss12Regular /></button> : null}
      </div>
      <div className="fm-goto-list" id="fm-goto-list" role="listbox" aria-label="Completions">
        {suggestions.map((item, index) => {
          const icon = item.kind === "folder" ? { className: "fm-ic fm-ic-folder", label: "" } : fileManagerIcon({ name: item.name, kind: "file" });
          return <button
            type="button"
            key={item.path}
            id={`fm-goto-item-${index}`}
            role="option"
            aria-selected={index === active}
            className={`fm-goto-row${index === active ? " is-active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => void go(item.path)}
          >
            <span className={icon.className} data-label={icon.label} aria-hidden="true" />
            <span className="fm-goto-name">{item.name}</span>
            {/* Left-to-right marks keep the slashes where they belong while the path is trimmed from its start. */}
            <span className="fm-goto-path" title={item.path}>{`\u200E${item.path}\u200E`}</span>
          </button>;
        })}
        {message ? <p className="fm-goto-message" role="status">{message}</p> : null}
        {!suggestions.length && !message ? <p className="fm-goto-message">Tab completes a name · Return goes there</p> : null}
      </div>
    </section>
  </>;
}

/** A name without "/" or "~" in front is inside the folder shown, as in Finder. */
export function absolute(typed: string, currentFolder: string): string {
  const value = typed.trim();
  if (!value || value.startsWith("/") || value === "~" || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value)) return value;
  return `${currentFolder.replace(/[\\/]+$/, "")}/${value}`;
}
