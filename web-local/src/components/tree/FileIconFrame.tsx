import { useId, useMemo } from "react";
import { fileIconArtworkMarkup, fileTreeIconGlyph, type FileTreeIconSpec } from "../../file-tree-icons";
import type { FileIconArtwork } from "../../file-icons-data";

/**
 * One file or folder icon, drawn in vscode-icons' own colors. Icons with a
 * light-theme variant render both, and CSS shows the one for the theme.
 */
export function FileIconFrame({ iconSpec }: { iconSpec: FileTreeIconSpec }) {
  const glyph = fileTreeIconGlyph(iconSpec);
  const instanceId = `wf${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span className="file-icon glyph-file-icon" title={iconSpec.label} aria-hidden="true">
      {glyph.light ? <ArtworkSvg artwork={glyph.light} instanceId={instanceId} className="file-icon-glyph file-icon-glyph-light" /> : null}
      <ArtworkSvg artwork={glyph} instanceId={instanceId} className={glyph.light ? "file-icon-glyph file-icon-glyph-dark" : "file-icon-glyph"} />
    </span>
  );
}

function ArtworkSvg({ artwork, instanceId, className }: { artwork: FileIconArtwork; instanceId: string; className: string }) {
  // The markup is vendored, sanitized SVG from scripts/generate-file-icons.mjs.
  const markup = useMemo(() => ({ __html: fileIconArtworkMarkup(artwork, instanceId) }), [artwork, instanceId]);
  // `contrast` marks artwork that vanishes on one theme; CSS lifts or deepens
  // it there without changing its colors' hues.
  const classes = artwork.contrast ? `${className} file-icon-contrast-${artwork.contrast}` : className;
  return <svg className={classes} viewBox={artwork.viewBox} focusable="false" dangerouslySetInnerHTML={markup} />;
}
