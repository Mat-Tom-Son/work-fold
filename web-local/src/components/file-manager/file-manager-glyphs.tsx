/** Line glyphs drawn the way the design draws them, in Finder's sidebar style. */

/** Finder's sidebar glyphs for the Standard Folders; a folder added with + gets the plain folder outline. */
export function StandardFolderGlyph({ id }: { id: string }) {
  const common = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (id === "desktop") return <svg {...common}><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" /><path d="M6 13.75h4M8 11.25v2.5" /></svg>;
  if (id === "documents") return <svg {...common}><path d="M4 1.75h5l3.25 3.25v9.25H4z" /><path d="M9 1.75V5h3.25" /></svg>;
  if (id === "downloads") return <svg {...common}><circle cx="8" cy="8" r="6.25" /><path d="M8 4.75v6M5.5 8.5 8 11l2.5-2.5" /></svg>;
  if (id === "pictures") return <svg {...common}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><circle cx="5.5" cy="6.25" r="1.25" /><path d="m2 11.5 3.5-3 2.5 2 2.5-2.5 3.75 3.5" /></svg>;
  if (id === "home") return <svg {...common}><path d="M2.25 7.25 8 2.25l5.75 5" /><path d="M3.75 6.25v7.5h8.5v-7.5" /><path d="M6.75 13.75v-3.5h2.5v3.5" /></svg>;
  if (id === "icloud") return <svg {...common}><path d="M4.75 12.75h7a3 3 0 0 0 .25-6A4.25 4.25 0 0 0 4 6.25a3.25 3.25 0 0 0 .75 6.5z" /></svg>;
  return <svg {...common}><path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.75l1.5 1.75h5.25a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>;
}
