import { AppsListDetail24Regular, ChevronRight20Regular } from "@fluentui/react-icons";

import type { AgentExtensionSurfaceView, AgentSurfaceBlock, CapabilitySurface } from "../../types";

export function ExtensionSurfacePane({
  surface,
  activeViewId,
  onOpenView,
}: {
  surface: CapabilitySurface;
  activeViewId?: string | null;
  onOpenView: (view: AgentExtensionSurfaceView) => void;
}) {
  return (
    <div className="extension-surface-pane">
      <div className="extension-surface-pane-intro">
        <span className="extension-surface-pane-icon" aria-hidden="true"><AppsListDetail24Regular /></span>
        <div>
          <h2>{surface.title}</h2>
          {surface.description ? <p>{surface.description}</p> : null}
        </div>
      </div>
      <div className="extension-surface-pane-meta">
        <span>{surfaceScopeLabel(surface)}</span>
        <span>Full-trust Pi Extension</span>
      </div>
      <nav className="extension-surface-view-list" aria-label={`${surface.title} views`}>
        {surface.views.map((view) => (
          <button
            className={view.id === activeViewId ? "active" : ""}
            type="button"
            key={view.id}
            onClick={() => onOpenView(view)}
            aria-current={view.id === activeViewId ? "page" : undefined}
          >
            <span><strong>{view.title}</strong>{view.description ? <small>{view.description}</small> : null}</span>
            <ChevronRight20Regular aria-hidden="true" />
          </button>
        ))}
      </nav>
    </div>
  );
}

export function ExtensionSurfaceView({
  surface,
  view,
}: {
  surface: CapabilitySurface;
  view: AgentExtensionSurfaceView;
}) {
  return (
    <article className="extension-surface-canvas">
      <header className="extension-surface-canvas-header">
        <div>
          <span className="extension-surface-eyebrow">{surface.title}</span>
          <h1>{view.title}</h1>
          {view.description ? <p>{view.description}</p> : null}
        </div>
        <span className="extension-surface-trust-label">{surfaceScopeLabel(surface)}</span>
      </header>
      <div className="extension-surface-blocks">
        {view.blocks.length
          ? view.blocks.map((block, index) => <SurfaceBlock block={block} key={`${block.type}:${index}`} />)
          : <div className="extension-surface-empty"><h2>No content</h2></div>}
      </div>
    </article>
  );
}

export function ExtensionSurfaceUnavailable({ surfaceId, viewId }: { surfaceId?: string; viewId?: string; execution?: "full-trust-pi" }) {
  return (
    <div className="extension-surface-unavailable">
      <AppsListDetail24Regular aria-hidden="true" />
      <h2>Extension view unavailable</h2>
      <p>The Extension may have been removed, disabled, or no longer available to this Space.</p>
      {surfaceId && viewId ? <code>{surfaceId}/{viewId}</code> : null}
    </div>
  );
}

function SurfaceBlock({ block }: { block: AgentSurfaceBlock }) {
  if (block.type === "heading") {
    if (block.level === 1) return <h1 className="extension-surface-heading">{block.text}</h1>;
    if (block.level === 3) return <h3 className="extension-surface-heading">{block.text}</h3>;
    return <h2 className="extension-surface-heading">{block.text}</h2>;
  }
  if (block.type === "text") return <p className="extension-surface-text">{block.text}</p>;
  if (block.type === "callout") {
    return <aside className={`extension-surface-callout tone-${block.tone}`}>{block.title ? <strong>{block.title}</strong> : null}<p>{block.text}</p></aside>;
  }
  if (block.type === "metrics") {
    return <div className="extension-surface-metrics">{block.items.map((item, index) => <section key={`${item.label}:${index}`}><span>{item.label}</span><strong>{item.value}</strong>{item.detail ? <small>{item.detail}</small> : null}</section>)}</div>;
  }
  if (block.type === "table") {
    return <div className="extension-surface-table-wrap"><table><thead><tr>{block.columns.map((column, index) => <th key={`${column}:${index}`}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
  }
  return <ul className="extension-surface-list">{block.items.map((item, index) => <li key={`${item.title}:${index}`}><div><strong>{item.title}</strong>{item.detail ? <p>{item.detail}</p> : null}</div>{item.badge ? <span>{item.badge}</span> : null}</li>)}</ul>;
}

function surfaceScopeLabel(surface: CapabilitySurface): string {
  return surface.scope === "project" ? "This Space" : surface.scope === "temporary" ? "Temporary" : "Personal";
}
