import type { CSSProperties } from "react";

import { WorkFolderIconGlyph } from "../chrome/common";
import type { WorkFolderIconOption } from "../../work-folder-icons";

/**
 * A work-folder's folder in its own color, with the icon chosen in Customize
 * work-folder stamped on its front, the way macOS lets a folder carry a
 * symbol. A work-folder nobody gave an icon shows a plain tinted folder.
 */
export function TintedFolder({ color, symbol }: { color: string; symbol?: WorkFolderIconOption["Icon"] | null }) {
  return <span className="fm-ic fm-ic-folder is-tinted" style={{ "--fold-base": color } as CSSProperties} aria-hidden="true">
    {symbol ? <span className="fm-folder-symbol"><WorkFolderIconGlyph icon={symbol} size={16} /></span> : null}
  </span>;
}
