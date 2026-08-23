# work-fold icon pack

This pack carries the shared vector brand masters plus platform-specific designer exports. The macOS application icon is the flattened Default appearance exported from Apple Icon Composer on August 23, 2026; its iconset and ICNS are derived from that 1024 px export. Small shared-brand exports continue to use the optically simplified vector master.

## What to use

- **macOS app:** `macOS/WorkFold.icns`, or the complete `macOS/WorkFold.iconset/` folder in Xcode.
- **iPhone / iPad:** drag `iOS-iPadOS/Assets.xcassets` into the Xcode project. The 1024 px source is also available separately.
- **Windows:** `Windows/WorkFold.ico`.
- **Website / PWA:** copy the contents of `web/`; the included manifest already references the exported icons.
- **Menu bar / tray:** use `monochrome/macOS-template/WorkFoldTemplate.png` and `WorkFoldTemplate@2x.png`. macOS will tint template icons automatically.
- **Design / print / future exports:** use the SVG files in `master/`.
- **General transparent PNG:** use `png/transparent/work-fold-icon-1024.png` or the size closest to the final display size.

## Important platform behavior

- The macOS icon includes its own rounded-square tile and transparent outer area.
- The Electron macOS lane uses the Icon Composer Default appearance. The Dark, Clear, and Tinted iOS exports are not installed because the current ICNS packaging contract has one static application icon.
- The iOS/iPadOS icon is fully opaque and has square corners; the operating system applies the final corner mask.
- The monochrome icon preserves the panel gaps as transparent negative space instead of adding white strokes.
- `monochrome/macOS-template/WorkFoldTemplate-source.png` is the cleaned, optically compensated high-resolution source for the 18 px and 36 px menu-bar pair. `npm run desktop:icons` renders both without stretching it.
- `npm run desktop:icons` also rebuilds the macOS PNG ladder and modern PNG-backed ICNS directly from the committed Icon Composer Default export, without depending on a host `iconutil` version.
- Do not enlarge the 16–64 px PNGs. Use a larger export or the SVG master instead.
