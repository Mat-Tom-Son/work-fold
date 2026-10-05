import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { desktopTitleBarMenus, productName } from "../../constants";

type DesktopTitleBarMenuId = typeof desktopTitleBarMenus[number]["id"];

function DesktopTitleBar() {
  const desktop = window.workFoldDesktop as (typeof window.workFoldDesktop & {
    menu?: { popup: (menuId: DesktopTitleBarMenuId, point: { x: number; y: number }) => Promise<void> };
  }) | undefined;
  const appInfo = desktop?.app;
  const linux = appInfo?.platform === "linux";
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!linux) return;
    let alive = true, changed = false;
    const unsubscribe = desktop?.window.onMaximized?.(value => { changed = true; if (alive) setMaximized(value); });
    void desktop?.window.control?.("state").then(state => { if (alive && !changed) setMaximized(state.maximized); });
    return () => { alive = false; unsubscribe?.(); };
  }, [linux]);

  useEffect(() => {
    function handleMenuAccelerator(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const menuItem = desktopTitleBarMenus.find((item) => item.label[0]?.toLowerCase() === key);
      if (!menuItem) return;
      const button = document.querySelector<HTMLButtonElement>(`[data-desktop-menu-id="${menuItem.id}"]`);
      if (!button) return;
      event.preventDefault();
      button.focus();
      openMenuFromElement(menuItem.id, button);
    }

    window.addEventListener("keydown", handleMenuAccelerator);
    return () => window.removeEventListener("keydown", handleMenuAccelerator);
  }, []);

  function openMenu(menuId: DesktopTitleBarMenuId, event: ReactMouseEvent<HTMLButtonElement>) {
    openMenuFromElement(menuId, event.currentTarget);
  }

  function openMenuFromElement(menuId: DesktopTitleBarMenuId, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    void desktop?.menu?.popup(menuId, {
      x: rect.left,
      y: rect.bottom,
    });
  }

  return (
    <header className={`desktop-titlebar${linux ? " desktop-titlebar-linux" : ""}`} aria-label="Application title bar">
      {!linux ? <div className="desktop-titlebar-brand">
        {appInfo?.iconUrl ? <img className="desktop-titlebar-icon" src={appInfo.iconUrl} alt="" draggable={false} /> : null}
        <span className="desktop-titlebar-name">{appInfo?.name ?? productName}</span>
      </div> : null}
      <nav className="desktop-titlebar-menu" aria-label="Application menu">
        {desktopTitleBarMenus.map((item) => (
          <button
            key={item.id}
            className="desktop-titlebar-menu-button"
            type="button"
            aria-haspopup="menu"
            data-desktop-menu-id={item.id}
            title={`Alt+${item.label[0]}`}
            onClick={(event) => openMenu(item.id, event)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="desktop-titlebar-drag-spacer" aria-hidden="true" />
      {linux ? <div className="desktop-window-controls">
        <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void desktop?.window.control?.("minimize")}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg></button>
        <button type="button" aria-label={maximized ? "Restore window" : "Maximize"} title={maximized ? "Restore window" : "Maximize"} onClick={() => void desktop?.window.control?.("toggle-maximize")}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{maximized ? <path d="M4 4V1h7v7H8M1 4h7v7H1z" /> : <rect x="1.5" y="1.5" width="9" height="9" />}</svg></button>
        <button type="button" className="desktop-window-quit" aria-label="Quit work-fold" title="Quit work-fold" onClick={() => void desktop?.window.control?.("quit")}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m1 1 10 10M11 1 1 11" /></svg></button>
      </div> : null}
    </header>
  );
}

export { DesktopTitleBar };
