import type { ReactNode } from "react";
import { ChevronDown20Regular } from "@fluentui/react-icons";
import type { WorkFolderIdentity } from "../../lib/work-folder-identity";

/**
 * The icon, name, and arrow on a work-folder banner. The header and Customize's
 * previews both render this, so a preview is exactly what the header shows.
 */
export function WorkFolderBannerTitle({ identity, name, caret = true, children }: {
  identity: WorkFolderIdentity;
  name: string;
  caret?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={`work-folder-banner-title fill-${identity.bannerTitleFill} icon-${identity.bannerIconStyle}`}>
      {identity.bannerIconStyle !== "none" ? <span className="work-folder-banner-title-icon" aria-hidden="true"><identity.Icon /></span> : null}
      <strong>{name}</strong>
      {caret ? <ChevronDown20Regular className="work-folder-pane-switch-caret" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
