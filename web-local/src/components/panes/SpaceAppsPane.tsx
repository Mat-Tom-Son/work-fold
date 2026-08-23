import { Add16Regular } from "@fluentui/react-icons";

import { RestrictedAppsSection } from "./RestrictedAppsSection";
import type { RestrictedAppInstalled, SpaceSummary } from "../../types";

/**
 * The Space-owned Apps tab: apps built for one Space. Apps are
 * deliberately not part of Skills & Extensions — they are a different lane
 * with their own authority model and their own visual surface.
 */
export function SpaceAppsPane({
  space,
  apps,
  loading,
  fixtureMode = false,
  onBuildApp,
  onOpenAppStudio,
  onUpsertApp,
  onRemoveApp,
  onError,
}: {
  space: SpaceSummary;
  apps: RestrictedAppInstalled[];
  loading: boolean;
  fixtureMode?: boolean;
  onBuildApp: () => void;
  onOpenAppStudio: (spaceId?: string) => void;
  onUpsertApp: (app: RestrictedAppInstalled) => void;
  onRemoveApp: (appId: string) => void;
  onError: (message: string | null) => void;
}) {
  return (
    <div className="space-pane-content capabilities-pane space-apps-pane professional-surface professional-assistant">
      <header className="assistant-tools-header">
        <div>
          <span className="professional-kicker">Apps</span>
          <h1>Apps in {space.name}</h1>
          <p>
            Apps extend a Space the way Skills and Extensions do, with one difference: an app has its own screen.
            It opens from the rail, and it can reach the network, your files, or notifications only where you allow it.
          </p>
        </div>
        <div className="space-apps-actions">
          <button className="professional-button professional-button-primary" type="button" onClick={onBuildApp}><Add16Regular />Build with Assistant</button>
        </div>
      </header>
      <section className="capabilities-panel">
        {!loading && !apps.length ? (
          <p className="space-apps-empty">No apps yet. Describe what you want and the Assistant builds it here for review.</p>
        ) : null}
        <RestrictedAppsSection
          space={space}
          apps={apps}
          totalApps={apps.length}
          filtered={false}
          loading={loading}
          fixtureMode={fixtureMode}
          presentation="page"
          onBuildApp={onBuildApp}
          onOpenAppStudio={onOpenAppStudio}
          onUpsertApp={onUpsertApp}
          onRemoveApp={onRemoveApp}
          onError={onError}
        />
      </section>
    </div>
  );
}
