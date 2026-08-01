import { useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { desktopTitleBarMenus, productName } from "../../constants";

type DesktopTitleBarMenuId = typeof desktopTitleBarMenus[number]["id"];

function DesktopTitleBar() {
  const desktop = window.workFoldDesktop as (typeof window.workFoldDesktop & {
    menu?: { popup: (menuId: DesktopTitleBarMenuId, point: { x: number; y: number }) => Promise<void> };
  }) | undefined;
  const appInfo = desktop?.app;

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
    <header className="desktop-titlebar" aria-label="Application title bar">
      <div className="desktop-titlebar-brand">
        {appInfo?.iconUrl ? <img className="desktop-titlebar-icon" src={appInfo.iconUrl} alt="" draggable={false} /> : null}
        <span className="desktop-titlebar-name">{appInfo?.name ?? productName}</span>
      </div>
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
    </header>
  );
}

export { DesktopTitleBar };
