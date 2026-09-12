# Fold integration — promotion record

**Status: historical promotion record (2026-08-11).** The fold shipped as
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

**Amended 2026-09-10.** The receipts-not-gates build
([record](receipts-not-gates.md)) superseded reconciliations 1, 2, 5, 6, 7
(the `decisions.*` part), 9, 11 (standing policies), 12 (cards), 13, 14, and
15 below; they stay listed as history so a future change cannot resurrect
them by accident. Held item V-2 is moot.

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
reconciliation 11 below had already resolved it to **Settings → General**
in the drafted text.

## Held items and their gates

Recorded here so the obligations cannot be lost. Nothing in this table is
claimed by the canonical documents.

| Held item | Gate |
|---|---|
| V-2 — the visual-design bullet admitting a menu-bar/tray attention dot while decisions pend | Moot since 2026-09-10: no decisions pend. If a dot ever returns it may only mean an Assistant question or a due snooze is waiting, and it still needs the visual-acceptance pass. |
| README walkthrough screenshots | Discharged 2026-08-23 and refreshed 2026-09-01. Current tracked walkthrough assets live under `services/bridge/public/screens/`; README names the exact files and the documentation contract test verifies them. |

Two originally held items were discharged at ship time with the 0.3.0
release commit: the fold's release notes landed as
[releases/0.3.0.md](releases/0.3.0.md), and the product-model roadmap's
"Foundation now" section absorbed the fold in shipped tense, replacing
PM-6's accepted-direction bullet.

## Cross-document reconciliations

Cross-thread decisions recorded so no thread ships a variant. All fifteen
were implemented in the 2026-08-11 build; the ones still unmarked bind future
changes across siblings, and the ones marked superseded stay here only so a
later change cannot revive them by accident.

1. *(superseded 2026-09-10)* **One decision-id spelling on receipts —
   `decisionId`.** The staged act and its decision shared one identity by
   construction. Receipts no longer carry `decisionId`; older lines that do
   stay readable.
2. *(superseded 2026-09-10)* **One surface vocabulary.** Surface vocabulary
   is now `cli`, `popover`, `main-window`, `remote_web`; `policy` and
   `unrestricted` are read-only history. Glance
   marker keys stay as designed — they key per-grant presentation state, not
   receipts.
3. **`publish.viewer.expose` pins both shapes.** Page slots pin Space id,
   exact relative path, title, budgets, and snapshot flag; hosted-app
   exposure pins App Instance id, exact Release digest, viewer entry, and
   the complete viewer-readable surface. Widenings pin old and new bindings.
4. **`apps release publish` is a direct verb.** The App Studio transition is
   a local state change with no outward exposure; the outward act is the
   separate `pages` share verb (*amended 2026-09-10:* that share is a
   prepared verb that executes and receipts on the call that asks).
5. *(superseded 2026-09-10)* **Decision TTL and caps are shared dials.**
   Nothing pends, so neither dial exists; routing enablement and page sharing
   execute on the call that asks.
6. *(superseded 2026-09-10)* **Needs-you rendering is one card contract.**
   Needs you now carries Assistant questions and due snoozes only (F24), and
   the popover renders none of it.
7. **The remote operation vocabulary grows in coordinated waves,
   allowlist-first at the bridge.** `decisions.list`/`decisions.decide`
   *(superseded 2026-09-10 — removed)*,
   `management.glance`/`management.glanceSeen`, and `viewer.fetch` plus the
   device publication routes each landed across
   `src/local/remote-management.ts`, `desktop/src/remote-access.ts`, and
   `services/bridge/server.mjs` together; viewer traffic never enters the
   management `allowedOperations` set.
8. **The settle-signal seam has one owner.** It exists at the Check service's
   terminal-persistence funnel and the restricted-app `onResult` funnel and
   is consumed only by the routing service; the glance reads stores on
   request. No other consumer may attach without a register decision.
9. *(superseded 2026-09-10)* **Act protocol stays at version 2.** The act
   protocol version advanced to 3 when gated verbs began returning their
   receipted result; the rule that ordinary threads extend argv, command
   tables, and the facade without touching
   `src/local/cli/act-protocol.ts` still holds.
10. **The glance's source inventory is closed.** Any further source must
    amend [the glance](fold-glance.md)'s inventory table first; nothing
    feeds the digest by side effect.
11. **The fold's Settings surface has one name: Settings → General**
    (owner decision, 2026-08-10, F15 in [the fold](fold.md)). *Amended
    2026-09-10:* it hosts Recently deleted, routing management, and
    publication controls, with "Your fold on the web" as its web-access
    subsection; the standing-policies section is gone.
12. *(superseded 2026-09-10)* **Popover copy and cards do not collide.** The
    two-state send button ("Fold it in" with reference chips attached, "Send"
    without) is still composer copy; there are no cards to collide with.
13. *(superseded 2026-09-10)* **Policy-ineligible kinds are one closed
    list.** Standing policies are gone, so the list has no subject.
14. *(superseded 2026-09-10)* **No-restore-path deletion has one
    semantics.** `files delete` always succeeds; paths the safety checkpoint
    cannot cover move into Recently deleted, and `files destroy` is
    removed (F20).
15. *(superseded 2026-09-10)* **Root authority is one inherited machine
    setting** (owner decision, 2026-08-31, F17 in [the fold](fold.md)).
    There is one authority mode and no setting to inherit; a
    remote-originated act still records the initiating browser and grant on
    its receipt.

## Governance

- This document never becomes a register. Durable decisions live in
  [the fold](fold.md) and the canonical documents; the sibling references
  hold thread-scoped contract detail.
- Verification is unchanged from `AGENTS.md`: `npm run check`, `npm test`
  (including `tests/documentation-contract.test.ts` across every doc
  change), the bridge package's own `npm test` for bridge items, and the
  desktop lanes for Electron-touching work. No fold-specific lane exists.
