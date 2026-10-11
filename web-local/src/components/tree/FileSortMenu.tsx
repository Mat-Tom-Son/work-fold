import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { fileSortOptions, nextFileSort, type FileSort } from "../../lib/file-sort";

/** The Files toolbar's sort control: one icon that opens the choices. */
export function FileSortMenu({ sort, onChange }: { sort: FileSort; onChange: (sort: FileSort) => void }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = position !== null;
  const currentLabel = fileSortOptions.find((option) => option.key === sort.key)?.label ?? "Name";
  const title = `Sort by ${currentLabel.toLocaleLowerCase()}, ${sort.direction === "asc" ? "ascending" : "descending"}`;

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setPosition(null);
    }
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function toggle() {
    if (open) { setPosition(null); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 190;
    setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
  }

  function close() {
    setPosition(null);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = Math.max(0, items.findIndex((item) => item === document.activeElement));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        className={`file-sort-button${open ? " active" : ""}`}
        type="button"
        aria-label={title}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <ArrowUpDown size={15} aria-hidden="true" />
      </button>
      {position ? (
        <div ref={menuRef} className="context-menu file-sort-menu" role="menu" aria-label="Sort files" style={{ top: position.top, left: position.left }} onKeyDown={handleKeyDown}>
          {fileSortOptions.map((option) => {
            const checked = option.key === sort.key;
            return (
              <button
                key={option.key}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                tabIndex={-1}
                onClick={() => { onChange(nextFileSort(sort, option.key)); close(); }}
              >
                <span className="file-sort-label">{option.label}</span>
                {checked ? (sort.direction === "asc" ? <ArrowUp size={14} aria-label="Ascending" /> : <ArrowDown size={14} aria-label="Descending" />) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
