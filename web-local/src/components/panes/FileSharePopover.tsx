import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Copy, Loader2, Share2 } from "lucide-react";
import { api, ApiError, errorText } from "../../lib/api";
import { activeSharedPageFor, pageTitleFromFileName, sharedPageLink, sharedPagesSnapshot, type SharedPageView } from "../../lib/page-sharing";
import { reloadSharedPages, useSharedPages } from "../../hooks/useSharedPages";
import { fixtureShareLinkKey, fixtureViewerOrigin } from "../../fixtures/space-fixture";
import { showToast } from "../../ui/feedback";
import { fileSharing, foldPublicationsSettings } from "../../ui-contract";

/** The popover's preferred width and its gutter inside the file pane. */
const popoverWidth = 440;
const popoverGutter = 12;

/**
 * Places the popover under its button inside the file pane: right-aligned to
 * the button when there is room, shifted left-anchored when there is not,
 * and never wider than the pane, so it never scrolls the pane sideways.
 */
function popoverPlacement(anchor: HTMLElement): CSSProperties {
  const anchorRect = anchor.getBoundingClientRect();
  const bounds = (anchor.closest(".file-details-pane") ?? document.documentElement).getBoundingClientRect();
  const minimumLeft = bounds.left + popoverGutter;
  const maximumRight = bounds.right - popoverGutter;
  const width = Math.max(0, Math.min(popoverWidth, maximumRight - minimumLeft));
  const preferredLeft = anchorRect.right - width;
  const left = Math.min(Math.max(preferredLeft, minimumLeft), maximumRight - width);
  return { left: left - anchorRect.left, right: "auto", width };
}

/** Share requests from the Files context menu, each handled by the one file tab it names. */

/**
 * The file tab's Share button and its popover (docs/fold-publishing.md,
 * amended 2026-09-24). Sharing executes on the click through the same path
 * as `pages share` and leaves a receipt — no confirmation — and the popover
 * then holds the page link, composed transiently from the reveal route and
 * dropped when it closes. Stop sharing keeps its confirm.
 */
export function FileShareControl({ spaceId, path, fileName, fixtureMode = false, shareRequestId, onOpenSettings }: {
  spaceId: string;
  path: string;
  fileName: string;
  fixtureMode?: boolean;
  /** A context-menu Share for this file: share it, or open its popover when it is already shared. */
  shareRequestId?: number;
  onOpenSettings?: (page: "shared-pages" | "web-access") => void;
}) {
  const publications = useSharedPages(fixtureMode);
  const shared = activeSharedPageFor(publications, spaceId, path);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<SharedPageView | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkUnavailable, setLinkUnavailable] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties | undefined>(undefined);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function currentRequest(request: number) {
    return mountedRef.current && requestRef.current === request;
  }

  function close() {
    requestRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setOpen(null);
    setLink(null);
    setLinkUnavailable(false);
  }

  // Close when this control moves to a different file, not on mount: a
  // StrictMode remount must not wipe a popover a Files-menu Share just opened.
  const shownFileRef = useRef(`${spaceId}\0${path}`);
  useEffect(() => {
    const key = `${spaceId}\0${path}`;
    if (shownFileRef.current === key) return;
    shownFileRef.current = key;
    close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, path]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) { setPlacement(undefined); return; }
    const anchor = anchorRef.current;
    const place = () => setPlacement(popoverPlacement(anchor));
    place();
    // Pane resizing and responsive layout can settle after window.resize.
    // Observe the resulting geometry so the link stays inside its file pane.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(anchor);
    observer?.observe(anchor.closest(".file-details-pane") ?? document.documentElement);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && anchorRef.current?.contains(event.target)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function noAddress() {
    showToast({
      text: fileSharing.noAddress,
      tone: "info",
      ...(onOpenSettings ? { actionLabel: fileSharing.webAccess, onAction: () => onOpenSettings("web-access") } : {}),
    });
  }

  async function reveal(publication: SharedPageView, request: number) {
    if (fixtureMode) {
      setLink(sharedPageLink(fixtureViewerOrigin, publication.viewerPath, fixtureShareLinkKey));
      return;
    }
    const status = await window.workFoldDesktop?.remoteAccess?.getStatus().catch(() => null);
    if (!currentRequest(request)) return;
    const viewerOrigin = status?.viewerOrigin ?? null;
    if (!viewerOrigin) {
      setLinkUnavailable(true);
      return;
    }
    try {
      const response = await api<{ viewerPath: string; key: string }>(
        `/api/settings/publications/${publication.publicationId}/reveal-link`,
        { method: "POST", body: {} },
      );
      if (!currentRequest(request)) return;
      // Composed transiently, held only while the popover is open.
      setLink(sharedPageLink(viewerOrigin, response.viewerPath, response.key));
    } catch {
      if (currentRequest(request)) setLinkUnavailable(true);
    }
  }

  async function openFor(publication: SharedPageView, request: number, revealable = true) {
    if (!currentRequest(request)) return;
    setOpen(publication);
    setLink(null);
    setLinkUnavailable(!revealable);
    if (revealable) await reveal(publication, request);
  }

  async function share() {
    if (open) { close(); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    const request = ++requestRef.current;
    setBusy(true);
    try {
      let existing = activeSharedPageFor(fixtureMode ? publications : sharedPagesSnapshot(), spaceId, path);
      if (!fixtureMode && sharedPagesSnapshot() === null) {
        await reloadSharedPages();
        if (!currentRequest(request)) return;
        existing = activeSharedPageFor(sharedPagesSnapshot(), spaceId, path);
      }
      if (existing) {
        await openFor(existing, request);
        return;
      }
      if (fixtureMode) {
        showToast({ text: fileSharing.previewDisabled, tone: "info" });
        return;
      }
      const status = await window.workFoldDesktop?.remoteAccess?.getStatus().catch(() => null);
      if (!currentRequest(request)) return;
      if (status && !status.configured) {
        noAddress();
        return;
      }
      const result = await api<{ publication: SharedPageView; revealable: boolean }>("/api/settings/publications/share", {
        method: "POST",
        body: { spaceId, path, title: pageTitleFromFileName(fileName) },
      });
      void reloadSharedPages({ afterMutation: true });
      if (!currentRequest(request)) return;
      showToast({ text: fileSharing.sharedToast(result.publication.title), tone: "success" });
      await openFor(result.publication, request, result.revealable);
    } catch (caught) {
      if (!currentRequest(request)) return;
      if (caught instanceof ApiError && caught.code === "NO_ADDRESS") noAddress();
      else showToast({ text: errorText(caught), tone: "error" });
    } finally {
      if (currentRequest(request)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function stopSharing(publication: SharedPageView) {
    if (fixtureMode) {
      showToast({ text: fileSharing.previewDisabled, tone: "info" });
      return;
    }
    if (!window.confirm(foldPublicationsSettings.stopSharingConfirm)) return;
    close();
    try {
      await api(`/api/settings/publications/${publication.publicationId}/revoke`, { method: "POST", body: {} });
      showToast({ text: fileSharing.stoppedToast(publication.title), tone: "success" });
    } catch (caught) {
      showToast({ text: errorText(caught), tone: "error" });
    } finally {
      void reloadSharedPages({ afterMutation: true });
    }
  }

  async function copyLink(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast({ text: fileSharing.linkCopied, tone: "success" });
    } catch (caught) {
      showToast({ text: errorText(caught), tone: "error" });
    }
  }

  // A request is handled once by the tab mounted for it. The ref survives a
  // StrictMode remount, so the second effect run neither repeats nor drops it.
  const handledShareRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (shareRequestId === undefined || handledShareRequest.current === shareRequestId) return;
    handledShareRequest.current = shareRequestId;
    void share();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareRequestId]);

  const label = shared ? fileSharing.shared : fileSharing.share;
  return (
    <span className="file-share-anchor" ref={anchorRef}>
      <button
        ref={buttonRef}
        className={shared ? "secondary-button compact no-margin file-share-button shared" : "secondary-button compact no-margin file-share-button"}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={Boolean(open)}
        disabled={busy}
        onClick={() => void share()}
      >
        {busy ? <Loader2 className="spin" size={14} /> : <Share2 size={14} />}{label}
      </button>
      {open ? (
        <div className="file-share-popover" role="dialog" aria-label={open.title} style={placement}>
          {link ? <input className="file-share-link" type="text" readOnly value={link} aria-label="Page link" spellCheck={false} onFocus={(event) => event.currentTarget.select()} /> : null}
          {!link && !linkUnavailable ? <p className="file-share-loading"><Loader2 className="spin" size={12} /></p> : null}
          {linkUnavailable ? <p>{fileSharing.linkInSettings}</p> : null}
          <p className="file-share-meaning">{foldPublicationsSettings.linkMeaning}</p>
          <div className="file-share-actions">
            {link ? (
              <button className="secondary-button compact no-margin" type="button" onClick={() => void copyLink(link)}>
                <Copy size={14} />{foldPublicationsSettings.copyLink}
              </button>
            ) : null}
            {linkUnavailable && onOpenSettings ? (
              <button className="secondary-button compact no-margin" type="button" onClick={() => { close(); onOpenSettings("shared-pages"); }}>
                {fileSharing.openSharedPages}
              </button>
            ) : null}
            <button className="secondary-button compact no-margin danger" type="button" onClick={() => void stopSharing(open)}>
              {foldPublicationsSettings.stopSharing}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
