import {
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  ArrowRight20Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Dismiss16Regular,
  Dismiss20Regular,
  Open20Regular,
  Options20Regular,
  Search16Regular,
  ShieldQuestion20Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  browserAddressFor,
  browserDisplayAddress,
  browserPermissionNames,
  browserPermissionPhrase,
  browserSearchUrl,
  type BrowserFindResult,
  type BrowserPageState,
  type BrowserViewRequest,
} from "../../../../src/shared/browser";
import type { BrowserSurfaceTab } from "../../types";
import { BrowserTabIcon, FluentGlyph } from "../chrome/common";
import { nativeViewBounds, nativeViewOccluded } from "../panes/RestrictedAppViewport";

type BrowserBridge = NonNullable<NonNullable<Window["workFoldDesktop"]>["browser"]>;
type HistoryEntry = Awaited<ReturnType<BrowserBridge["recent"]>>[number];

/** One row under the address bar: what Enter does with the typed text, then pages from history. */
interface AddressSuggestion {
  key: string;
  url: string;
  label: string;
  detail?: string;
}

/**
 * One built-in browser tab (docs/built-in-browser.md): the toolbar and
 * address bar here, and the page itself, which the desktop app shows over
 * this panel's placeholder. The page keeps running while the tab is in the
 * background, so a Worker can keep using it.
 */
export function BrowserTabPanel({
  tab,
  page,
  active,
  onError,
}: {
  tab: BrowserSurfaceTab;
  /** The page's latest state from the desktop; absent until the page exists. */
  page: BrowserPageState | undefined;
  active: boolean;
  onError: (message: string) => void;
}) {
  const desktop = window.workFoldDesktop?.browser;
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const sequenceRef = useRef(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false);
  const siteSettingsRef = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const suggestRequestRef = useRef(0);
  const [recent, setRecent] = useState<HistoryEntry[] | null>(null);
  const url = page?.url ?? tab.url;
  // A blank tab has no page yet; the first address typed creates it.
  const hasPage = Boolean(page) || Boolean(tab.url);
  const blocked = Boolean(page?.error || page?.crashed);
  const latestRef = useRef({ pageId: tab.pageId, url: tab.url, active, blocked });
  latestRef.current = { pageId: tab.pageId, url: tab.url, active, blocked };

  useLayoutEffect(() => {
    if (!desktop || !hasPage) return;
    const element = viewportRef.current;
    if (!element) return;
    let disposed = false;
    let mounted = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (disposed || !mounted) return;
      desktop.layout(browserViewRequest(element, sequenceRef.current++, latestRef.current));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(schedule);
    resizeObserver.observe(element);
    mutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    void desktop.mount(browserViewRequest(element, sequenceRef.current++, latestRef.current)).then(() => {
      if (disposed) return;
      mounted = true;
      schedule();
    }).catch((caught) => {
      if (!disposed) onError(caught instanceof Error ? caught.message : "The page could not open.");
    });
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void desktop.unmount(tab.pageId).catch(() => undefined);
    };
  }, [desktop, hasPage, tab.pageId]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!desktop || !element || !hasPage) return;
    desktop.layout(browserViewRequest(element, sequenceRef.current++, latestRef.current));
  }, [active, blocked, desktop, findOpen, hasPage, page?.permissionRequest?.requestId, page?.notice?.text]);

  // The site settings menu closes on a click elsewhere or Escape, like the app's other menus.
  useEffect(() => {
    if (!siteSettingsOpen) return;
    function pointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && siteSettingsRef.current?.contains(event.target)) return;
      setSiteSettingsOpen(false);
    }
    function keyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setSiteSettingsOpen(false);
    }
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [siteSettingsOpen]);
  useEffect(() => { if (!page?.sitePermissions.length) setSiteSettingsOpen(false); }, [page?.sitePermissions.length]);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onFindResult((result) => {
      if (result.pageId === tab.pageId) setFindResult(result);
    });
  }, [desktop, tab.pageId]);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onShortcut((shortcut) => {
      if (shortcut.pageId !== tab.pageId) return;
      const key = shortcut.key.toLowerCase();
      if (key === "l") focusAddress();
      else if (key === "f") openFind();
    });
  }, [desktop, tab.pageId]);

  // A new blank tab is ready to type into, and lists the pages visited lately.
  useEffect(() => {
    if (!active || hasPage) return;
    window.requestAnimationFrame(() => addressRef.current?.focus());
    void desktop?.recent().then(setRecent).catch(() => setRecent([]));
  }, [active, desktop, hasPage]);

  function focusAddress(): void {
    window.requestAnimationFrame(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    });
  }

  function openFind(): void {
    setFindOpen(true);
    window.requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }

  function closeFind(): void {
    setFindOpen(false);
    setFindResult(null);
    void desktop?.command(tab.pageId, { type: "stop-find" });
    void desktop?.command(tab.pageId, { type: "focus" });
  }

  function find(text: string, options: { forward: boolean; newSearch: boolean }): void {
    if (!text) {
      setFindResult(null);
      void desktop?.command(tab.pageId, { type: "stop-find" });
      return;
    }
    void desktop?.command(tab.pageId, { type: "find", text, ...options });
  }

  /** What someone typed: Enter's own row first (the address, or a search), then matching pages from history. */
  function typed(value: string): void {
    setDraft(value);
    setSelectedSuggestion(0);
    const text = value.trim();
    const requestId = ++suggestRequestRef.current;
    if (!text) {
      setSuggestions([]);
      return;
    }
    const target = browserAddressFor(text);
    const first: AddressSuggestion[] = target
      ? [target.startsWith(browserSearchUrl) ? { key: "search", url: target, label: `Search Google for “${text}”` } : { key: "go", url: target, label: target }]
      : [];
    setSuggestions(first);
    void desktop?.suggest(text).then((entries) => {
      if (requestId !== suggestRequestRef.current) return;
      const pages = entries
        .filter((entry) => entry.url !== first[0]?.url)
        .map((entry) => ({ key: entry.url, url: entry.url, label: entry.title || entry.url, ...(entry.title ? { detail: entry.url } : {}) }));
      setSuggestions([...first, ...pages]);
    }).catch(() => undefined);
  }

  function closeSuggestions(): void {
    suggestRequestRef.current += 1;
    setSuggestions([]);
    setSelectedSuggestion(0);
  }

  function go(address: string): void {
    if (!desktop || !address.trim()) return;
    closeSuggestions();
    setDraft(null);
    addressRef.current?.blur();
    void desktop.navigate(tab.pageId, address)
      .then(() => desktop.command(tab.pageId, { type: "focus" }))
      .catch((caught) => onError(caught instanceof Error ? caught.message : "The page could not open."));
  }

  function answer(decision: "allow" | "block"): void {
    const request = page?.permissionRequest;
    if (!desktop || !request) return;
    void desktop.respondPermission(tab.pageId, request.requestId, decision).catch((caught) => onError(caught instanceof Error ? caught.message : "The site's request could not be answered."));
  }

  function command(type: "back" | "forward" | "reload" | "stop"): void {
    void desktop?.command(tab.pageId, { type }).catch((caught) => onError(caught instanceof Error ? caught.message : "The browser could not do that."));
  }

  function addressKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelectedSuggestion((current) => Math.max(0, Math.min(suggestions.length - 1, current + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(suggestions[selectedSuggestion]?.url ?? event.currentTarget.value);
    } else if (event.key === "Escape" && suggestions.length) {
      event.preventDefault();
      closeSuggestions();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
      event.currentTarget.blur();
      if (hasPage) void desktop?.command(tab.pageId, { type: "focus" });
    }
  }

  function findKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      find(findText, { forward: !event.shiftKey, newSearch: false });
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  }

  if (!desktop) {
    return (
      <section className="browser-tab browser-tab-unavailable" aria-label="Browser">
        <FluentGlyph icon={BrowserTabIcon} size={28} filled={false} />
        <strong>The browser runs in the work-fold desktop app.</strong>
      </section>
    );
  }

  const loading = page?.loading ?? false;
  const address = draft ?? browserDisplayAddress(url);
  const external = /^https?:/i.test(url);
  const request = page?.permissionRequest ?? null;
  const siteHost = (origin: string) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  };
  return (
    <section className="browser-tab" aria-label={`Browser: ${tab.title}`}>
      <header className="browser-tab-toolbar">
        <button className="browser-tab-button" type="button" disabled={!page?.canGoBack} onClick={() => command("back")} aria-label="Back" title="Back">
          <ArrowLeft20Regular />
        </button>
        <button className="browser-tab-button" type="button" disabled={!page?.canGoForward} onClick={() => command("forward")} aria-label="Forward" title="Forward">
          <ArrowRight20Regular />
        </button>
        <button className="browser-tab-button" type="button" disabled={!hasPage} onClick={() => command(loading ? "stop" : "reload")} aria-label={loading ? "Stop loading" : "Reload"} title={loading ? "Stop loading" : "Reload"}>
          {loading ? <Dismiss20Regular /> : <ArrowClockwise20Regular />}
        </button>
        {page?.sitePermissions.length ? (
          <div className="browser-tab-site-settings" ref={siteSettingsRef}>
            <button
              className="browser-tab-button"
              type="button"
              onClick={() => setSiteSettingsOpen((open) => !open)}
              aria-label="Site settings"
              aria-haspopup="menu"
              aria-expanded={siteSettingsOpen}
              title="Site settings"
            >
              <Options20Regular />
            </button>
            {siteSettingsOpen ? (
              <div className="browser-tab-site-menu" role="menu" aria-label={`Settings for ${siteHost(url)}`} data-native-view-occluder="true">
                <span className="browser-tab-site-menu-heading">{siteHost(url)}</span>
                {page.sitePermissions.map((item) => (
                  <div className="browser-tab-site-menu-row" key={item.kind}>
                    <span>{browserPermissionNames[item.kind]}</span>
                    <span className="browser-tab-site-menu-decision">{item.decision === "allow" ? "Allowed" : "Blocked"}</span>
                    <button
                      className="ui-control compact no-margin"
                      type="button"
                      role="menuitem"
                      onClick={() => { void desktop.command(tab.pageId, { type: "forget-permission", kind: item.kind }); }}
                      title="The site asks again the next time it needs this"
                    >
                      Ask again
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="browser-tab-address-field">
          <label className={loading ? "browser-tab-address loading" : "browser-tab-address"}>
            <span className="sr-only">Address</span>
            <input
              ref={addressRef}
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              placeholder="Search or type a web address"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={suggestions.length > 0}
              aria-controls={`browser-suggestions-${tab.pageId}`}
              {...(suggestions[selectedSuggestion] ? { "aria-activedescendant": `browser-suggestion-${tab.pageId}-${selectedSuggestion}` } : {})}
              value={address}
              onChange={(event) => typed(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => {
                setDraft(null);
                closeSuggestions();
              }}
              onKeyDown={addressKeyDown}
            />
          </label>
          {suggestions.length ? (
            <ul className="browser-tab-suggestions" id={`browser-suggestions-${tab.pageId}`} role="listbox" aria-label="Suggestions" data-native-view-occluder="true">
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.key}
                  id={`browser-suggestion-${tab.pageId}-${index}`}
                  role="option"
                  aria-selected={index === selectedSuggestion}
                  className={index === selectedSuggestion ? "selected" : undefined}
                  // Keep the address field focused, so its text stays while a row is chosen.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelectedSuggestion(index)}
                  onClick={() => go(suggestion.url)}
                >
                  {suggestion.key === "search" ? <Search16Regular aria-hidden="true" /> : <FluentGlyph icon={BrowserTabIcon} size={16} filled={false} />}
                  <span className="browser-tab-suggestion-label">{suggestion.label}</span>
                  {suggestion.detail ? <span className="browser-tab-suggestion-detail">{suggestion.detail}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button className="browser-tab-button" type="button" disabled={!hasPage} onClick={openFind} aria-label="Find in page" title="Find in page">
          <Search16Regular />
        </button>
        <button className="browser-tab-button" type="button" disabled={!external} onClick={() => { void window.workFoldDesktop?.shell.openExternal(url).catch((caught) => onError(caught instanceof Error ? caught.message : "The page could not open.")); }} aria-label="Open in your web browser" title="Open in your web browser">
          <Open20Regular />
        </button>
      </header>
      {request ? (
        <div className="browser-tab-bar browser-tab-permission" role="alert">
          <ShieldQuestion20Regular aria-hidden="true" />
          <span className="browser-tab-bar-text"><strong>{siteHost(request.origin)}</strong> wants to {browserPermissionPhrase(request.kinds)}.</span>
          <button className="ui-control compact no-margin" type="button" onClick={() => answer("block")}>Block</button>
          <button className="ui-control ui-control--primary compact no-margin" type="button" onClick={() => answer("allow")}>Allow</button>
        </div>
      ) : null}
      {page?.notice ? (
        <div className="browser-tab-bar browser-tab-notice" role="status">
          <Warning16Regular aria-hidden="true" />
          <span className="browser-tab-bar-text">{page.notice.text}</span>
          {window.workFoldDesktop?.app.platform === "darwin" ? (
            <button className="ui-control compact no-margin" type="button" onClick={() => { void desktop.command(tab.pageId, { type: "open-privacy-settings", kind: page.notice!.kind }); }}>Open System Settings</button>
          ) : null}
          <button className="browser-tab-button" type="button" onClick={() => { void desktop.command(tab.pageId, { type: "dismiss-notice" }); }} aria-label="Dismiss" title="Dismiss">
            <Dismiss16Regular />
          </button>
        </div>
      ) : null}
      {findOpen ? (
        <div className="browser-tab-find" role="search">
          <input
            ref={findRef}
            type="search"
            aria-label="Find in page"
            placeholder="Find in page"
            value={findText}
            onChange={(event) => {
              setFindText(event.target.value);
              find(event.target.value, { forward: true, newSearch: true });
            }}
            onKeyDown={findKeyDown}
          />
          <span className="browser-tab-find-count" aria-live="polite">
            {findText && findResult ? (findResult.matches ? `${findResult.activeMatch} of ${findResult.matches}` : "No matches") : ""}
          </span>
          <button className="browser-tab-button" type="button" disabled={!findResult?.matches} onClick={() => find(findText, { forward: false, newSearch: false })} aria-label="Previous match" title="Previous match">
            <ChevronUp16Regular />
          </button>
          <button className="browser-tab-button" type="button" disabled={!findResult?.matches} onClick={() => find(findText, { forward: true, newSearch: false })} aria-label="Next match" title="Next match">
            <ChevronDown16Regular />
          </button>
          <button className="browser-tab-button" type="button" onClick={closeFind} aria-label="Close find" title="Close find">
            <Dismiss16Regular />
          </button>
        </div>
      ) : null}
      <div className="browser-tab-viewport" ref={viewportRef}>
        {!hasPage && recent?.length ? (
          <div className="browser-tab-state browser-tab-new">
            <div className="browser-tab-recent">
              <span className="browser-tab-recent-heading">Recent</span>
              {recent.map((entry) => (
                <button className="browser-tab-recent-item" type="button" key={entry.url} onClick={() => go(entry.url)} title={entry.url}>
                  <strong>{entry.title || hostOf(entry.url)}</strong>
                  <span>{hostOf(entry.url)}</span>
                </button>
              ))}
              <button
                className="ui-control ui-control--quiet compact no-margin browser-tab-clear-history"
                type="button"
                onClick={() => {
                  void desktop.clearHistory().then(() => setRecent([])).catch((caught) => onError(caught instanceof Error ? caught.message : "History could not be cleared."));
                }}
              >
                Clear browsing history
              </button>
            </div>
          </div>
        ) : !hasPage ? (
          <div className="browser-tab-state">
            <FluentGlyph icon={BrowserTabIcon} size={32} filled={false} />
            <strong>Search or type a web address</strong>
            <span>This browser is shared by every work-folder, and your Workers can use its tabs too.</span>
          </div>
        ) : page?.crashed ? (
          <div className="browser-tab-state">
            <strong>This page stopped</strong>
            <span>Reload it to try again.</span>
            <button className="ui-control" type="button" onClick={() => command("reload")}><ArrowClockwise20Regular />Reload</button>
          </div>
        ) : page?.error ? (
          <div className="browser-tab-state">
            <strong>This page couldn't load</strong>
            <span>{page.error.description || "The site didn't respond."}</span>
            <code>{page.error.url}</code>
            <button className="ui-control" type="button" onClick={() => command("reload")}><ArrowClockwise20Regular />Try Again</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function browserViewRequest(
  element: HTMLElement,
  sequence: number,
  latest: { pageId: string; url: string; active: boolean; blocked: boolean },
): BrowserViewRequest {
  const elementBounds = element.getBoundingClientRect();
  const bounds = nativeViewBounds(element, elementBounds, "tab");
  const active = latest.active && !element.closest("[hidden]") && document.visibilityState === "visible";
  return {
    pageId: latest.pageId,
    url: latest.url,
    sequence,
    bounds,
    active,
    // An error or a stopped page shows its message here instead of the page.
    occluded: !active || latest.blocked || bounds.width < 1 || bounds.height < 1 || nativeViewOccluded(element, elementBounds),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
