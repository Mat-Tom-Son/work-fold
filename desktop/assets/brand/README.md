# work-fold brand sources

The committed source-of-truth artwork for the folder-cube brand. Every icon,
favicon, tray template, DMG background, and web-client icon derives from these
files; nothing else in the repo should carry its own copy of the mark.

## Layout

- `pack/` — the designer icon pack (see `pack/README.md`). Its shared brand
  ladder is built from one vector master with an optically simplified
  small-size variant. The macOS application icon instead uses the supplied
  Apple Icon Composer Default export, and the menu-bar pair is rendered from
  its own optically compensated monochrome source. The pack ships:
  `macOS/` (icns + iconset, tiled),
  `Windows/` (ico + png ladder, tiled), `web/` (favicons, PWA icons, apple
  touch), `monochrome/` (black/white ladders and the macOS menu-bar template),
  `png/transparent/` (the bare cube at every size), `master/` (the SVGs), and
  an `iOS-iPadOS/` asset catalog that is currently unused because there is no
  iOS target.
- `lockup-horizontal-black.png` / `lockup-horizontal-white.png` — the provided
  horizontal lockups (cube + wordmark as one image). Black carries light
  themes and print; white carries dark themes. These are the only lockup
  sources; in-app lockups must never be stitched together from separate cube
  and wordmark pieces.

Awaited from design, non-blocking: color horizontal/stacked lockups in the
pack's rendering style for marketing surfaces.

## Regeneration

Application outputs are copy-and-verify pack exports. The menu-bar 1x/2x pair
is deterministically rendered from its committed source; the same bytes are
written to the pack and installed asset locations (`tests/work-fold-brand.test.ts`
enforces both contracts):

```
npm run desktop:icons                        # desktop icons + DMG background
node scripts/generate-bridge-web-icons.mjs   # bridge web icons, lockups, og-image
node scripts/sync-bridge-fonts.mjs           # bridge webfonts from @fontsource
```

The Electron `web-local/index.html` and `popover.html` favicons are base64
data URIs of `pack/web/favicon-32x32.png`; re-render them the same way if the
pack changes.
