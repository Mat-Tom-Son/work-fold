# Extension surfaces

work-fold can render a controlled application surface contributed by a normal, full-trust Pi Extension. A surface can add one destination below the stable primary rail, a navigator in the left pane, and one or more Space-bound tabs in the work area.

This is a declarative UI contract, not renderer code injection. work-fold parses and bounds the manifest, renders its text and data through host-owned React components, and rejects unsupported block types. The Extension remains an ordinary executable Pi capability with its normal Personal or This Space scope and trust implications.

Do not choose between `surface.json` and a restricted Space app based only on visual complexity:

| Need | Use | Why |
|---|---|---|
| A trusted Pi Extension needs a small read-only status surface beside its tools or connection logic. | `surface.json` | Preserves native Pi packaging and keeps visible rendering data-only, but the owning Extension is still full trust. |
| The Assistant should generate interactive forms, dashboards, inboxes, extractors, or project-service controls for one Space. | Restricted Space app | Runs arbitrary reviewed web UI in a sandbox and requires host-mediated grants for every external power. |
| The capability needs unrestricted Node, shell, provider, event, or operating-system integration. | Native Pi Extension, optionally with `surface.json` | Those powers are intentionally outside the restricted bridge and require full-current-user trust. |

The checked-in [Connected inbox Pi Extension](../examples/packages/connected-inbox/README.md) demonstrates this compatibility lane. Its code can use the network and runs with the current user's permissions. The separate [restricted Connected inbox app](../examples/packages/restricted-connected-inbox/README.md) demonstrates the agent-created package lane; see [Restricted app authoring](restricted-app-authoring.md) and [Restricted app runtime](restricted-app-runtime.md).

## Package layout

Place `surface.json` beside a loaded Extension entry point inside a normal Pi package:

```text
project-pulse-package/
├── package.json
├── index.ts
└── surface.json
```

The package and Extension entry point continue to use Pi's standard formats. work-fold does not discover a surface by scanning arbitrary Space files: it considers `surface.json` only when Pi loaded the adjacent Extension. Consequently, a This Space package surface is available only while its folder is registered as a Space.

Minimal `package.json`:

```json
{
  "name": "project-pulse",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] }
}
```

Minimal `index.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function projectPulse(_pi: ExtensionAPI) {
  // Register normal Pi tools, commands, or event handlers here when needed.
}
```

## Manifest version 1

```json
{
  "version": 1,
  "id": "project-pulse",
  "title": "Project pulse",
  "description": "The decisions and activity that need attention.",
  "icon": "dashboard",
  "views": [
    {
      "id": "overview",
      "title": "Overview",
      "description": "A compact status view.",
      "blocks": [
        { "type": "heading", "text": "At a glance", "level": 2 },
        {
          "type": "metrics",
          "items": [
            { "label": "Open decisions", "value": "3", "detail": "One due this week" }
          ]
        },
        {
          "type": "callout",
          "tone": "warning",
          "title": "Needs attention",
          "text": "Confirm the quote before Friday."
        },
        {
          "type": "table",
          "columns": ["Item", "Status"],
          "rows": [["Cabinetry", "Waiting for reply"]]
        }
      ]
    }
  ]
}
```

Surface and view ids use lowercase letters, numbers, and hyphens and may contain at most 64 characters. Titles, descriptions, collection sizes, table dimensions, and the complete manifest file are bounded. The current manifest limit is 256 KB.

Supported blocks are:

- `heading` with text and level 1, 2, or 3;
- `text` rendered as plain text with preserved line breaks;
- `callout` with `info`, `success`, or `warning` tone;
- `metrics` containing label, value, and optional detail;
- `table` containing columns and equally sized rows; and
- `list` containing a title plus optional detail and badge.

HTML, scripts, styles, event handlers, arbitrary URLs, and custom React components are not accepted. A manifest error appears in capability diagnostics and prevents that surface from loading without taking down other Extensions.

## Lifecycle and current boundary

Opening a rail destination opens its first view in a normal Space-bound tab. Additional navigator views open or reactivate deterministic tabs, and installed view tabs are restored with the rest of the local shell state. Removing the Extension or removing its Space leaves an already-restored tab in an explicit unavailable state rather than running stale code.

Version 1 is intentionally read-only and manifest-backed. The package's Extension tools can still call connected systems when invoked by the Assistant because the owning Pi Extension is full trust. Do not encode credentials or remote account data in `surface.json`.

Agent-generated executable UI belongs in the restricted package lane, not in this Pi Extension format. Restricted apps use reviewed HTML/CSS/JavaScript in a sandboxed visible renderer, can render arbitrary buttons and forms, call granted targets through the host broker, and open persistent Space-owned tabs. `surface.json` remains intentionally static and Pi-only.
