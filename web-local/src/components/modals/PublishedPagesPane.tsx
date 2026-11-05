import { useEffect, useMemo, useRef, useState } from "react";

import { errorText } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { openPageLink } from "../../lib/page-frame-host";
import { announcePagePublicationChange, pagesClient, type PagesClient, type PublishedPage } from "../../lib/pages";
import { copyPageLink } from "../pages/PagePublishing";
import { showToast } from "../../ui/feedback";
import { pagePublishing, publishedPagesSettings } from "../../ui-contract";

interface PublishedGroup {
  workFolderId: string;
  name: string;
  /** False once the work-folder is no longer registered here: its pages have no tab to open. */
  registered: boolean;
  pages: PublishedPage[];
}

/** Pages by work-folder, in the order the list names them; titles in order within each. */
export function groupPublishedPages(pages: readonly PublishedPage[]): PublishedGroup[] {
  const groups = new Map<string, PublishedGroup>();
  for (const page of pages) {
    const group = groups.get(page.workFolderId) ?? { workFolderId: page.workFolderId, name: page.workFolderName ?? publishedPagesSettings.removedWorkFolder, registered: page.workFolderName !== null, pages: [] };
    group.pages.push(page);
    groups.set(page.workFolderId, group);
  }
  return [...groups.values()].map((group) => ({ ...group, pages: [...group.pages].sort((a, b) => a.title.localeCompare(b.title)) }));
}

/**
 * Settings → Published (docs/pages.md, "Publishing (stage 2)"): every page
 * put online from this computer, by work-folder, with its link, the page's
 * tab, and Unpublish, which keeps its entries. The browser preview
 * (`?fixture=work-folder`) lists its published page from the same in-memory
 * page the page tab uses.
 */
export function PublishedPagesPane({
  fixtureMode = false,
  client: givenClient,
  onOpenPage,
}: {
  fixtureMode?: boolean;
  /** Tests pass their own; the app reads the local API (or the browser preview's fixture). */
  client?: PagesClient;
  onOpenPage?: (workFolderId: string, path: string, title: string) => void;
}) {
  const client = givenClient ?? pagesClient(fixtureMode);
  const [pages, setPages] = useState<PublishedPage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const generationRef = useRef(0);

  function load() {
    const generation = ++generationRef.current;
    void client.published().then((next) => {
      if (generation !== generationRef.current) return;
      setPages(next);
      setLoadError(null);
    }, (error: unknown) => {
      if (generation === generationRef.current) setLoadError(errorText(error));
    });
  }
  useEffect(() => { load(); return () => { generationRef.current++; }; }, [client]);

  async function unpublish(page: PublishedPage) {
    const key = `${page.workFolderId}\n${page.path}`;
    if (busy) return;
    setBusy(key);
    try {
      await client.unpublish(page.workFolderId, page.path);
      announcePagePublicationChange({ workFolderId: page.workFolderId, page: page.path });
      showToast({ text: pagePublishing.unpublished(page.title), tone: "success" });
    } catch (error) {
      showToast({ text: errorText(error), tone: "error" });
    } finally {
      setBusy(null);
      load();
    }
  }

  const groups = useMemo(() => groupPublishedPages(pages ?? []), [pages]);
  const anyOffline = (pages ?? []).some((page) => page.status !== "online");

  return (
    <section className="settings-section published-pages-pane" aria-label={publishedPagesSettings.heading}>
      {loadError ? (
        <div className="published-pages-error" role="alert">
          <span className="settings-inline-error">{loadError}</span>
          <button className="ui-control" type="button" onClick={load}>{pagePublishing.tryAgain}</button>
        </div>
      ) : null}
      {pages && !pages.length ? (
        <div className="published-pages-empty">
          <h3>{publishedPagesSettings.emptyHeading}</h3>
          <p>{publishedPagesSettings.empty}</p>
        </div>
      ) : null}
      {groups.map((group) => (
        <section className="published-pages-group" key={group.workFolderId} aria-label={group.name}>
          <h3 className="published-pages-work-folder" title={group.name}>{group.name}</h3>
          <div className="remote-browser-list">
            {group.pages.map((page) => {
              const online = page.status === "online";
              const key = `${page.workFolderId}\n${page.path}`;
              const details = [
                online && page.changesAvailable ? publishedPagesSettings.changesWaiting : null,
                page.publishedAt ? publishedPagesSettings.published(formatDateTime(page.publishedAt)) : null,
              ].filter(Boolean).join(" · ");
              return (
                <div className="remote-browser-row published-page-row" key={page.path} data-status={page.status}>
                  <div>
                    <strong title={page.title}>{page.title}</strong>
                    <small className="published-page-facts">
                      <span className={online ? "published-page-status online" : "published-page-status"}>{online ? publishedPagesSettings.online : publishedPagesSettings.offline}</span>
                      {details ? <span>{details}</span> : null}
                    </small>
                    {page.path !== page.title ? <small className="published-page-path" title={page.path}>{page.path}</small> : null}
                  </div>
                  <div className="settings-actions published-page-actions">
                    {online && page.url ? (
                      <>
                        <button className="ui-control" type="button" title={page.url} onClick={() => void copyPageLink(page.url!)}>{publishedPagesSettings.copyLink}</button>
                        <button className="ui-control" type="button" title={pagePublishing.openTitle} onClick={() => openPageLink(page.url!)}>{publishedPagesSettings.openLink}</button>
                      </>
                    ) : null}
                    {onOpenPage && group.registered ? <button className="ui-control" type="button" onClick={() => onOpenPage(page.workFolderId, page.path, page.title)}>{publishedPagesSettings.openPage}</button> : null}
                    {online ? (
                      <button className="ui-control" type="button" disabled={Boolean(busy)} aria-busy={busy === key} title={pagePublishing.unpublishHint} onClick={() => void unpublish(page)}>{publishedPagesSettings.unpublish}</button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {anyOffline ? <p className="published-pages-note">{publishedPagesSettings.unpublishedNote}</p> : null}
    </section>
  );
}
