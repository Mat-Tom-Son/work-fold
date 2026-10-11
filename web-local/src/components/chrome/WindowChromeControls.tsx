import type { CSSProperties, ReactNode, Ref } from "react";
import { PanelLeft20Regular } from "@fluentui/react-icons";

// The same mark macOS shows in the menu bar for the work-fold agent.
import menuBarMarkUrl from "../../../../desktop/assets/iconTemplate@2x.png";
import { FluentGlyph } from "./common";

/**
 * The two controls in the window's top strip: the left-pane toggle beside the
 * window buttons, and the work-fold agent's controls at the far right. They
 * carry no labels; their names are in tooltips and for assistive tech.
 */
export function WindowChromeControls({
  sidebarCollapsed,
  onToggleSidebar,
  agentPanelOpen,
  onToggleAgentPanel,
  agentControlsRef,
  agentControls,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  agentPanelOpen: boolean;
  onToggleAgentPanel: () => void;
  /** The open panel renders its chat controls here. */
  agentControlsRef?: Ref<HTMLDivElement>;
  agentControls?: ReactNode;
}) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const sidebarLabel = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
  const agentLabel = agentPanelOpen ? "Close work-fold agent" : "Open work-fold agent";
  return (
    <>
      <div className="window-chrome window-chrome-leading">
        <button
          className="window-chrome-button"
          type="button"
          aria-label={sidebarLabel}
          title={`${sidebarLabel} (${mod}B)`}
          aria-pressed={!sidebarCollapsed}
          aria-controls="work-folder-file-panel"
          onClick={onToggleSidebar}
        >
          <FluentGlyph icon={PanelLeft20Regular} size={18} filled={false} />
        </button>
      </div>
      <div className="window-chrome window-chrome-trailing">
        <div className="window-chrome-agent-controls" ref={agentControlsRef} hidden={!agentPanelOpen}>{agentControls}</div>
        <button
          className="window-chrome-button"
          type="button"
          aria-label={agentLabel}
          title={`${agentLabel} (${mod}J)`}
          aria-pressed={agentPanelOpen}
          aria-controls="work-fold-agent-panel"
          onClick={onToggleAgentPanel}
        >
          <span className="window-chrome-agent-mark" aria-hidden="true" style={{ "--agent-mark": `url(${menuBarMarkUrl})` } as CSSProperties} />
        </button>
      </div>
    </>
  );
}
