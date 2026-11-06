import { useEffect, useId, useRef, useState } from "react";

import { Check, CloudOff, CloudUpload, Copy, ExternalLink, Loader2, MoreHorizontal, X } from "../chrome/icons";
import { errorText } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { formatBytes, formatDateTime } from "../../lib/format";
import { openPageLink } from "../../lib/page-frame-host";
import {
  PagePublishRefusal,
  pageProblemsBySeverity,
  webAccessRequiredCode,
  type PageInspection,
  type PageProblem,
  type PagePublishResult,
  type PagesClient,
} from "../../lib/pages";
import type { PagePublicationHandle } from "../../hooks/usePagePublication";
import { showToast } from "../../ui/feedback";
import { pagePublishing } from "../../ui-contract";

type PublishPanel =
  | { phase: "publishing"; changes: boolean }
  | { phase: "published"; changes: boolean; result: PagePublishResult }
  | { phase: "refused"; message: string; webAccess: boolean; problems: PageProblem[] }
  | { phase: "failed"; changes: boolean; message: string };

/** "1 file", "3 files". */
export function fileCountText(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString()} files`;
}

/** A gigabyte-free size: a page is at most 25 MiB. */
function sizeText(bytes: number | null | undefined): string | null {
  return typeof bytes === "number" && Number.isFinite(bytes) ? formatBytes(bytes) : null;
}

/** Copies a page's link, saying so the way the app's other copies do. */
export async function copyPageLink(url: string): Promise<boolean> {
  try {
    await copyToClipboard({ text: url });
    showToast({ text: pagePublishing.linkCopied, tone: "success" });
    return true;
  } catch (error) {
    showToast({ text: `Couldn't copy the link. ${errorText(error)}`, tone: "error" });
    return false;
  }
}

/**
 * The page tab's publishing controls (docs/pages.md, "Publishing (stage 2)").
 * Before a page is online: **Publish**, which needs Web Access and a page
 * without errors. Online: the **Online** status, **Copy Link**, **Open**,
 * **Publish Changes** once the files changed, and **Unpublish** in a small
 * menu. Publishing opens a panel that shows the progress, then the link and
 * the files that went up.
 */
export function PagePublishControls({
  workFolderId,
  path,
  title,
  client,
  publication,
  inspection,
  onOpenWebAccessSettings,
  onPublished,
}: {
  workFolderId: string;
  path: string;
  title: string;
  client: PagesClient;
  publication: PagePublicationHandle;
  inspection: PageInspection | null;
  onOpenWebAccessSettings?: () => void;
  /** After a publish or unpublish: online entries may have changed. */
  onPublished?: () => void;
}) {
  const [panel, setPanel] = useState<PublishPanel | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState<"publish" | "unpublish" | null>(null);
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const reasonId = `${ids}-reason`;

  const state = publication.state;
  const current = state?.publication ?? null;
  const online = current?.status === "online";
  const errors = pageProblemsBySeverity(inspection?.problems ?? []).errors;
  const blockedReason = !state ? null
    : !state.available ? state.unavailableReason ?? pagePublishing.webAccessRequired
      : errors.length ? pagePublishing.hasErrors
        : null;

  function closePanel(focusTrigger = false) {
    setPanelOpen(false);
    // Publish Changes goes away once the changes are online; focus lands on the controls instead.
    if (focusTrigger) window.requestAnimationFrame(() => (triggerRef.current ?? anchorRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus());
  }

  async function publish() {
    if (busy) return;
    const changes = online;
    setBusy("publish");
    setPanel({ phase: "publishing", changes });
    setPanelOpen(true);
    try {
      const result = await client.publish(workFolderId, path);
      publication.apply(result.publication);
      onPublished?.();
      setPanel({ phase: "published", changes, result });
      if (!panelOpenRef.current) {
        const url = result.publication?.url;
        showToast({
          text: changes ? `${title}: changes published` : `${title} is online`,
          tone: "success",
          ...(url ? { actionLabel: pagePublishing.copyLink, onAction: () => void copyPageLink(url) } : {}),
        });
      }
    } catch (error) {
      if (error instanceof PagePublishRefusal && (error.code === webAccessRequiredCode || error.problems.length)) {
        setPanel({ phase: "refused", message: error.message, webAccess: error.code === webAccessRequiredCode, problems: error.problems });
      } else {
        setPanel({ phase: "failed", changes, message: errorText(error) });
      }
      setPanelOpen(true);
      publication.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function unpublish() {
    if (busy) return;
    setBusy("unpublish");
    setPanelOpen(false);
    try {
      publication.apply(await client.unpublish(workFolderId, path));
      onPublished?.();
      showToast({ text: pagePublishing.unpublished(title), tone: "success" });
    } catch (error) {
      showToast({ text: errorText(error), tone: "error" });
      publication.refresh();
    } finally {
      setBusy(null);
    }
  }

  // The panel closes on Escape or a click outside the controls; publishing goes on.
  useEffect(() => {
    if (!panelOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && anchorRef.current?.contains(event.target)) return;
      setPanelOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [panelOpen]);

  if (!state) return null;

  const summary = inspection?.summary;
  const shownPanel = panelOpen && panel ? (
    <PublishPanelView
      panel={panel}
      title={title}
      uploading={summary ? `${fileCountText(summary.files)}${sizeText(summary.bytes) ? ` (${sizeText(summary.bytes)})` : ""}` : null}
      onClose={(focusTrigger) => closePanel(focusTrigger)}
      onRetry={() => void publish()}
      onOpenWebAccessSettings={onOpenWebAccessSettings}
    />
  ) : null;

  if (online && current) {
    return (
      <div className="page-publish" ref={anchorRef}>
        <span className="page-publish-status online" title={current.publishedAt ? `Published ${formatDateTime(current.publishedAt)}` : undefined}>
          <span className="page-publish-dot" aria-hidden="true" />{pagePublishing.online}
        </span>
        {current.url ? <PageLinkButtons url={current.url} /> : null}
        {current.changesAvailable || busy === "publish" ? (
          <button ref={triggerRef} className="ui-control ui-control--primary page-publish-button" type="button" disabled={Boolean(busy) || Boolean(blockedReason)} aria-describedby={blockedReason ? reasonId : undefined} title={blockedReason ?? undefined} onClick={() => void publish()}>
            {busy === "publish" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <CloudUpload size={14} aria-hidden="true" />}
            {busy === "publish" ? pagePublishing.publishing : pagePublishing.publishChanges}
          </button>
        ) : null}
        {blockedReason && current.changesAvailable ? <span id={reasonId} className="sr-only">{blockedReason}</span> : null}
        <PublishMoreMenu busy={Boolean(busy)} onUnpublish={() => void unpublish()} />
        {shownPanel}
      </div>
    );
  }

  return (
    <div className="page-publish" ref={anchorRef}>
      {current?.status === "unpublished" ? <span className="page-publish-status" title={pagePublishing.republishHint}>{pagePublishing.offline}</span> : null}
      {blockedReason ? <span id={reasonId} className="page-publish-reason" title={blockedReason}>{blockedReason}</span> : null}
      {!state.available && onOpenWebAccessSettings ? (
        <button className="ui-control ui-control--quiet page-publish-settings" type="button" onClick={onOpenWebAccessSettings}>{pagePublishing.openSettings}</button>
      ) : null}
      <button
        ref={triggerRef}
        className="ui-control ui-control--primary page-publish-button"
        type="button"
        disabled={Boolean(busy) || Boolean(blockedReason)}
        aria-describedby={blockedReason ? reasonId : undefined}
        title={blockedReason ?? (current?.status === "unpublished" ? pagePublishing.republishHint : undefined)}
        onClick={() => void publish()}
      >
        {busy === "publish" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <CloudUpload size={14} aria-hidden="true" />}
        {busy === "publish" ? pagePublishing.publishing : pagePublishing.publish}
      </button>
      {shownPanel}
    </div>
  );
}

function PageLinkButtons({ url }: { url: string }) {
  return (
    <>
      <button className="ui-control page-publish-action" type="button" aria-label={pagePublishing.copyLink} title={url} onClick={() => void copyPageLink(url)}>
        <Copy size={14} aria-hidden="true" /><span className="page-publish-label">{pagePublishing.copyLink}</span>
      </button>
      <button className="ui-control page-publish-action" type="button" aria-label={pagePublishing.open} title={pagePublishing.openTitle} onClick={() => openPageLink(url)}>
        <ExternalLink size={14} aria-hidden="true" /><span className="page-publish-label">{pagePublishing.open}</span>
      </button>
    </>
  );
}

function PublishPanelView({
  panel,
  title,
  uploading,
  onClose,
  onRetry,
  onOpenWebAccessSettings,
}: {
  panel: PublishPanel;
  title: string;
  /** "3 files (4.7 KB)", from the page's last check, while it goes up. */
  uploading: string | null;
  onClose: (focusTrigger: boolean) => void;
  onRetry: () => void;
  onOpenWebAccessSettings?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [panel.phase]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const heading = panel.phase === "publishing" ? pagePublishing.publishing
    : panel.phase === "published" ? (panel.changes ? pagePublishing.changesPublishedHeading : pagePublishing.publishedHeading)
      : panel.phase === "refused" ? (panel.webAccess ? pagePublishing.webAccessHeading : pagePublishing.problemsHeading)
        : pagePublishing.failedHeading;
  const url = panel.phase === "published" ? panel.result.publication?.url ?? null : null;
  const uploaded = panel.phase === "published" ? panel.result.uploaded : null;

  return (
    <div
      ref={ref}
      className="page-publish-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-busy={panel.phase === "publishing"}
      tabIndex={-1}
      data-phase={panel.phase}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); } }}
    >
      <header>
        <h3 id={headingId}>{heading}</h3>
        <button className="ui-control ui-control--icon" type="button" aria-label={pagePublishing.close} title={pagePublishing.close} onClick={() => onClose(true)}><X size={14} /></button>
      </header>
      {panel.phase === "publishing" ? (
        <p className="page-publish-progress" role="status">
          <Loader2 className="spin" size={14} aria-hidden="true" />
          {uploading ? pagePublishing.sendingFiles(uploading) : pagePublishing.sending}
        </p>
      ) : null}
      {panel.phase === "published" ? (
        <>
          {url ? (
            <>
              <p className="page-publish-hint">{pagePublishing.shareHint}</p>
              <code className="page-publish-link" title={url}>{url}</code>
              <div className="page-publish-panel-actions">
                <button className="ui-control ui-control--primary" type="button" onClick={() => void copyPageLink(url).then((done) => setCopied(done))}>
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? pagePublishing.copied : pagePublishing.copyLink}
                </button>
                <button className="ui-control" type="button" title={pagePublishing.openTitle} onClick={() => openPageLink(url)}><ExternalLink size={14} aria-hidden="true" />{pagePublishing.open}</button>
              </div>
            </>
          ) : <p className="page-publish-hint">{pagePublishing.linkPending}</p>}
          {uploaded ? (
            <div className="page-publish-uploaded">
              <p>{pagePublishing.uploaded(fileCountText(uploaded.count), sizeText(uploaded.bytes))}</p>
              {uploaded.files.length ? (
                <ul aria-label={`Files uploaded for ${title}`}>
                  {uploaded.files.map((file) => (
                    <li key={file.path}><span title={file.path}>{file.path}</span>{sizeText(file.bytes) ? <small>{sizeText(file.bytes)}</small> : null}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="page-publish-panel-footer">
            <button className="ui-control" type="button" onClick={() => onClose(true)}>{pagePublishing.done}</button>
          </div>
        </>
      ) : null}
      {panel.phase === "refused" ? (
        <>
          <p className="page-publish-hint" role="alert">{panel.webAccess ? panel.message : pagePublishing.problemsHint}</p>
          {panel.problems.length ? (
            <ul className="page-problem-list page-publish-problems">
              {panel.problems.slice(0, 12).map((problem, index) => (
                <li key={`${problem.file ?? ""}:${index}`}>{problem.file ? <code>{problem.file}</code> : null}<span>{problem.message}</span></li>
              ))}
              {panel.problems.length > 12 ? <li className="page-problem-more">{panel.problems.length - 12} more</li> : null}
            </ul>
          ) : null}
          {panel.webAccess && onOpenWebAccessSettings ? (
            <div className="page-publish-panel-footer">
              <button className="ui-control ui-control--primary" type="button" onClick={() => { onClose(false); onOpenWebAccessSettings(); }}>{pagePublishing.openSettings}</button>
            </div>
          ) : null}
        </>
      ) : null}
      {panel.phase === "failed" ? (
        <>
          <p className="page-publish-hint" role="alert">{panel.message}</p>
          <div className="page-publish-panel-footer">
            <button className="ui-control" type="button" onClick={onRetry}>{pagePublishing.tryAgain}</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The ⋯ menu beside an online page's controls; Unpublish lives here, with what it keeps. */
function PublishMoreMenu({ busy, onUnpublish }: { busy: boolean; onUnpublish: () => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && anchorRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }
  }
  return (
    <span className="page-publish-more" ref={anchorRef}>
      <button ref={buttonRef} className="ui-control ui-control--icon" type="button" title={pagePublishing.moreActions} aria-label={pagePublishing.moreActions} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div ref={menuRef} className="context-menu page-publish-menu" role="menu" aria-label={pagePublishing.moreActions} onKeyDown={handleKeyDown}>
          <button type="button" role="menuitem" tabIndex={-1} aria-describedby={hintId} onClick={() => { setOpen(false); onUnpublish(); }}>
            <CloudOff size={15} aria-hidden="true" />{pagePublishing.unpublish}
          </button>
          <p id={hintId} className="page-publish-menu-hint" role="none">{pagePublishing.unpublishHint} {pagePublishing.republishHint}</p>
        </div>
      ) : null}
    </span>
  );
}
