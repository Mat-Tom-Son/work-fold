# work-fold 0.3.1

August 11, 2026

work-fold 0.3.1 redesigns the fold popover around one idea — the door first —
and fixes the window behavior that made the app front itself or swallow the
popover.

## A calmer fold

- Opening the fold now shows just the door: the drop zone, the composer, and
  one honest status line. Decisions, the conversation, and What's new fold
  into quiet rows that open one at a time.
- Decisions appear one card at a time behind a "N decisions need you" row,
  so each approval gets your full attention.
- What's new marks itself read only when you actually open it — a collapsed
  row never pretends you saw something.
- Working, handed-off, and finished states now tell one story inside the
  conversation instead of stacking separate cards. New chat lives in the
  ⋯ menu.

## Window behavior fixes

- The app no longer brings itself to the front on its own. Background
  requests from the command line or the fold's own work never raise or
  focus the window; only your clicks do.
- Clicking the menu-bar fold now reliably toggles the popover: open when
  closed, closed when open — no more flashing or vanishing.
- Opening the popover no longer deactivates the app or hides its Dock icon,
  and it no longer drags the main window forward behind it. When the
  popover closes, focus returns to whatever you were doing.
