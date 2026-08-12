# work-fold icon pack

This pack is built from one clean vector master rather than repeatedly scaling a bitmap. Small exports use an optically simplified version so the fold and three-panel structure remain legible at favicon and menu-bar sizes.

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
- The iOS/iPadOS icon is fully opaque and has square corners; the operating system applies the final corner mask.
- The monochrome icon preserves the panel gaps as transparent negative space instead of adding white strokes.
- Do not enlarge the 16–64 px PNGs. Use a larger export or the SVG master instead.
