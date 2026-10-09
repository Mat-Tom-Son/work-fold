# work-fold 0.4.48

October 9, 2026

The desktop frame now uses connected surfaces instead of extra gaps and detached active tabs.

- The Mac title-bar band is 32px instead of 50px: one native drag strip without another page gutter beneath it. Window controls retain their own area, and the banner and tab controls remain aligned.
- The active tab uses its work surface's background and extends through the bottom gap with curved shoulders and no bottom border. Inactive tabs, close controls, work-folder icons, and keyboard focus remain distinct.
- The work area and tab strip reach the right window edge. The left pane is square where it joins the navigation rail, and exposed pane corners share one radius.
- Saved application and work-folder appearance remains authoritative. Rendered Chromium checks cover connected-tab geometry, native clearance, edges, light/dark palettes, interaction feedback, and personalization.

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
