# Fold integration — promotion record

**Status: promotion applied (working tree, 2026-08-11).** The fold shipped as
one complete build (verb ledger, consecrations, standing policies, routings,
glance, publishing ladder through rung 3, and the naming sweep), and this
document's amendment blocks were applied to the canonical registers. The
blocks themselves are no longer quoted here — the canonical documents carry
the promoted text, [the fold](fold.md) is the compact decision register
(decision F16), and the sibling documents are shipped contract references.
This document retains what canon does not carry: the cross-thread
reconciliations, the promotion record, and the items still held with their
gates. Per its own governance it is not a register and shrinks to nothing
once the held items land or are rejected.

## What was applied where (2026-08-11)

| Canonical document | Applied |
|---|---|
| [Product model](product-model.md) | PM-1 (fold, Routing, Viewer nouns), PM-2 (eight explicit-context rows), PM-3 (rails 9–11), PM-4 (fold naming in §Management layer), PM-5 (act-lane sentence), PM-6 (roadmap direction bullet in "Next product layer") |
| `AGENTS.md` | AG-1 (required reading names [the fold](fold.md)), AG-2 (act-lane family list), AG-3 (management-layer mutation bullet), AG-4 (two rails), plus the appearance-bullet sentence acknowledging the receipted `spaces appearance` act-lane path |
| [Management layer](management-layer.md) | ML-1 (naming binds), ML-2 (receipts v2 fields), ML-3 (staged-decisions bullet), ML-4 (remote operation growth), ML-5 (verification-map rows) |
| `README.md` | R-1 (fold feature bullets), R-2 (act-lane bullet and CLI section, full family list including `routings`, `pages`, `staged`), R-3 (needs-you and glance bullets), R-4 (routings bullet), R-5 (publishing bullet), R-6 (documentation-map row) |
| `SECURITY.md` | S-1 (act-content sentence, including the glance word), S-2 (staged decisions), S-3 (routings), S-4 (Published viewer pages subsection) |
| `PRIVACY.md` | P-1 (what-stays bullet), P-2 (Published pages subsection), P-3 (CLI act-content sentences, including the glance word), P-4 (user choices) |
| [Desktop parity](ui-parity.md) | U-1 (tray actions), U-2 (popover item), U-3 (decision and glance surfaces) |
| [Visual system](visual-design.md) | V-1 (conditional fold surfaces). V-2 is held — see below |
| [Space customization](space-customization.md) | The ledger-promotion obligation: the apply paragraph now names the receipted act-lane `spaces appearance apply\|reset\|undo` path while keeping the npm-script primitive inert and import-only |
| [Restricted app authoring](restricted-app-authoring.md), [Restricted app runtime](restricted-app-runtime.md) | The rung-3 obligation: the reviewed `viewer` manifest declaration (entry plus instance-owned readable prefixes) is documented with its grants-nothing-by-itself and fresh-consecration-on-widening rules |
| [Architecture](architecture.md) | One sentence in the popover paragraph covering the renderer-only decision routes and the glance digest |

The amendment blocks were verified against their anchors at application; the
phrase "the fold's Settings section" no longer appeared in any block —
reconciliation 11 below had already resolved it to **Settings → The fold**
in the drafted text.

## Held items and their gates

Recorded here so the obligations cannot be lost. Nothing in this table is
claimed by the canonical documents.

| Held item | Gate |
|---|---|
| V-2 — the visual-design bullet admitting a menu-bar/tray attention dot while decisions pend | The visual-acceptance pass must accept the dot; it is not implemented and no acceptance is recorded. Until then the dot exists only as the pass-gated possibility U-3 names. |
| README walkthrough screenshots (`output/playwright/work-fold-0.1.4-*.png`) | "Refresh README collateral only once builds show the new strings" — a packaged build showing "Your fold" and "Fold it in" must exist first. The surrounding walkthrough sentences already said "the fold" and were deliberately unchanged. |

Two originally held items were discharged at ship time with the 0.3.0
release commit: the fold's release notes landed as
[releases/0.3.0.md](releases/0.3.0.md), and the product-model roadmap's
"Foundation now" section absorbed the fold in shipped tense, replacing
PM-6's accepted-direction bullet.

## Cross-document reconciliations

Cross-thread decisions recorded so no thread ships a variant. All fourteen
are implemented in the build; they remain recorded here because they bind
future changes across siblings.

1. **One decision-id spelling on receipts — `decisionId`.** The staged act
   and its decision share one identity by construction (the decision request
   id is derived from the staged-act id).
2. **One surface vocabulary.** Wherever a surface is recorded, the closed set
   is `cli`, `popover`, `main-window`, `remote_web`, and `policy`. Glance
   marker keys stay as designed — they key per-grant presentation state, not
   receipts.
3. **`publish.viewer.expose` pins both shapes.** Page slots pin Space id,
   exact relative path, title, budgets, and snapshot flag; hosted-app
   exposure pins App Instance id, exact Release digest, viewer entry, and
   the complete viewer-readable surface. Widenings pin old and new bindings.
4. **`apps release publish` is a direct verb.** The App Studio transition is
   a local state change with no outward exposure; the outward act is the
   separate `pages` consecration.
5. **Decision TTL and caps are shared dials.** The 24-hour staged-act TTL and
   the 32-pending cap are consecrations' dials; staged routing enablements
   and staged publications inherit them.
6. **Needs-you rendering is one card contract.** The popover stack, the
   main-window flyout, and the remote client home render the same
   host-composed card component contract; glance needs-you items reference
   the same pending records and never a second store.
7. **The remote operation vocabulary grows in coordinated waves,
   allowlist-first at the bridge.** `decisions.list`/`decisions.decide`,
   `management.glance`/`management.glanceSeen`, and `viewer.fetch` plus the
   device publication routes each landed across
   `src/local/remote-management.ts`, `desktop/src/remote-access.ts`, and
   `services/bridge/server.mjs` together; viewer traffic never enters the
   management `allowedOperations` set.
8. **The settle-signal seam has one owner.** It exists at the Check service's
   terminal-persistence funnel and the restricted-app `onResult` funnel and
   is consumed only by the routing service; the glance reads stores on
   request. No other consumer may attach without a register decision.
9. **Act protocol stays at version 2.** Threads extend argv, command tables,
   and the facade; none changes the envelope in
   `src/local/cli/act-protocol.ts`.
10. **The glance's source inventory is closed.** Any further source must
    amend [the glance](fold-glance.md)'s inventory table first; nothing
    feeds the digest by side effect.
11. **The fold's Settings surface has one name: Settings → The fold**
    (owner decision, 2026-08-10, F15 in [the fold](fold.md)), hosting
    standing policies, routing management, and publication controls, with
    "Your fold on the web" as its web-access subsection.
12. **Popover copy and cards do not collide.** The two-state send button
    ("Fold it in" with staged material, "Send" without) is composer copy;
    needs-you cards carry their own Approve and Deny controls.
13. **Policy-ineligible kinds are one closed list, owned by consecrations.**
    Standing policies can never name a destroy-category kind,
    `publish.viewer.expose`, or `routing.enable`; the policy store rejects
    ineligible kinds and `tests/fold-policies.test.ts` covers the refusal.
14. **No-restore-path deletion has one semantics.** `files delete` refuses
    whenever any matched content lacks restore coverage, and the staged
    `files destroy` consecration is the only path to such a deletion; no
    lane may delete content the restore point cannot bring back without a
    click.

## Governance

- This document never becomes a register. Durable decisions live in
  [the fold](fold.md) and the canonical documents; the sibling references
  hold thread-scoped contract detail.
- Verification is unchanged from `AGENTS.md`: `npm run check`, `npm test`
  (including `tests/documentation-contract.test.ts` across every doc
  change), the bridge package's own `npm test` for bridge items, and the
  desktop lanes for Electron-touching work. No fold-specific lane exists.
