# The fold decision register

**The fold** is the one user-facing name for work-fold's one management
surface in three coats: the **management conversation** above all Spaces, its
**menu-bar/tray popover** ("Your fold"), and the **Remote access web client**
("Your fold on the web"). It is the one door to all Spaces: things come in
through it (drops, attachments, uploads, `files add`) and go out through it
(the publishing ladder). Spaces are the rooms; the fold is the door.

> **The fold is the one door to all your Spaces: what you hand it gets put
> where it belongs, what you ask for gets done with a receipt, and its
> operating authority is one explicit machine-level choice.**

This document records the decisions the fold's implementation and product
surfaces must preserve, alongside the canonical registers that absorbed the
fold's rails, nouns, and contract text on 2026-08-11:
[Product model](product-model.md) (nouns, explicit-context rows, rails 9–11,
the roadmap direction), `AGENTS.md` (contributor rails, act-lane families),
[the management layer](management-layer.md) (receipts v2, staged decisions,
remote operations, the verification map), `README.md`, `SECURITY.md`,
`PRIVACY.md`, [Desktop parity](ui-parity.md), and
[the visual system](visual-design.md). The sibling documents are shipped
contract references retaining the detail canon does not carry:

- [The verb ledger](fold-act-ledger.md) — every product verb's classification, command shape, receipt additions, undo path, and conflict rules.
- [Consecrations](fold-consecrations.md) — staged acts, the Reviewed/Unrestricted decision path, standing policies, the setup-only boundary, and the threat model.
- [Routings](fold-routings.md) — declared deterministic cross-Space glue: triggers, declarations, the executor, and bounds.
- [The glance](fold-glance.md) — the deterministic digest: sources, sections, markers, surfaces, and non-goals.
- [The publishing ladder](fold-publishing.md) — the viewer audience class, rungs 1–3, origin isolation, and the bridge's viewer plane.
- [Integration](fold-integration.md) — the promotion record: applied amendment blocks, cross-thread reconciliations, and the items still held with their gates.

## The doctrine in one paragraph

The fold is god-mode with a ledger: every admitted product verb is pinned,
journaled before execution, and receipted after. Runnable-code,
standing-power, and irreversible-destruction verbs always enter the staged
decision path. In **Reviewed** mode they remain inert for a person or a
matching standing policy. In **Unrestricted** mode the host immediately
consumes every newly admitted act, including permanent deletion; approved
browsers inherit the mode, and receipts name surface `unrestricted` plus the
remote browser/grant when applicable. Only local Settings changes this root
authority. Setup that establishes principals or secrets stays outside the
act vocabulary. Above Spaces, only declared
deterministic routings run unattended. The glance is the app-composed digest
of recorded state; narration of it is interactive, never scheduled. Outward,
the publishing ladder serves "pages your fold serves" to link-scoped viewers
who never touch the management lane.

What the fold is **not**:

- Not a Space. Its transcript is machine-local application state and never
  travels with a folder.
- Not a second Assistant, persona, or brand voice. Replies stay labeled
  work-fold; the fold is where you meet it and what the conversation is
  called.
- Not a rename of anything else. **Space**, **Library**, **Assistant
  tools**, **Chats**, and **History** are untouched; there is no "foldr".
- Not a new technical contract. `work-fold manage …`, the
  `work-fold-management` scope id, the `/api/management/*` routes, the
  `management.*` remote-facade methods, the `management/` application-state
  root, and "management conversation" as a contract term all stay exactly as
  documented in [the management layer](management-layer.md).

## Decision register

Recorded from the product owner on **2026-08-10**; promoted into the
canonical documents on 2026-08-11 through the amendment blocks recorded in
[Integration](fold-integration.md). The siblings design within these
decisions, not around them. F3–F6 record the original Reviewed-only contract;
F17 deliberately supersedes their claims that a click is the only completing
authority while preserving their staged-act taxonomy and safety mechanics.

| # | Decision (2026-08-10) | What it does not change |
|---|---|---|
| F1 | One thing, one name: the management conversation, the menu-bar/tray popover, and the Remote access web client are one product surface named **the fold** — the one door to all Spaces, capture in and publish out. | No new runtime, transcript store, or Assistant; the three surfaces keep their existing machinery. |
| F2 | Scope: one complete effort, no phases. Four threads — verb ledger, routings + glance, naming and copy, publishing ladder — delivered as proposal documents; implementation follows owner review. | Nothing in this set is implemented before that review. |
| F3 | The fold becomes able to do anything a person can do in the app, with a receipt for everything — except the consecrations and the never-list. | The click remains the product's definition of authorization; receipts are added, trust prompts are not. |
| F4 | Tier model: exactly two tiers (direct receipted verbs; consecrations) plus a never-list. There is no general "co-sign everything big" tier. | Standing policies narrow consecrations; they do not create a third tier. |
| F5 | Remote consecration clicks: a consecration decision may be approved from the desktop **or** from any approved full-trust remote browser. Compensating controls: every decision receipt names the approving surface and exact browser identity/grant; revoking a browser cancels that browser's pending decisions; a staged act is never decidable from the same remote grant whose request staged it; make-runnable at Personal scope (code loading into the fold's own runtime) is decided on the desktop only; the never-list is untouched. | The never-list is not weakened to match; Remote access administration itself stays desktop-human-only. |
| F6 | The three consecrations are **make bytes runnable**, **widen a power**, and **destroy irreversibly**; the fold may stage all three, and only a human click completes them. Staged acts expire; expiry is not approval; denial is recorded, not retried. | Existing individual grants (destinations, file roots, notification categories, connections, named automations) stay separate acts; consecration is their shared ceremony, not a merge. |
| F7 | Standing policies are person-authored outside any assistant turn, host-evaluated at decision time, inspectable, revocable, and receipted when exercised. The fold may cite policies, never write them. | No model-authored policy, ever; policy evaluation never moves into the model. |
| F8 | Agency on a schedule always lives in Spaces. Above Spaces, only declared deterministic glue (routings) runs unattended; enabling a routing is a consecration. | The fold conversation itself is never scheduled; the glance's narration stays on-demand. |
| F9 | Management-scope and cross-Space work never runs inside a Space chat, because Space transcripts are portable (`.work-fold/conversations/` travels with the folder) and cross-Space context in a Space transcript is a leak. | Delegated in-Space work continues to run in Space chats with that Space's Assistant. |
| F10 | The glance is a deterministic digest composed by app code from kernel-recorded state only — no model call, no file scanning, no ambient watching. | Nothing new is recorded to feed it; it reads state the product already keeps. |
| F11 | Publishing introduces the **viewer**: per-artifact, read-only, link-scoped, revocable, receipted. Viewers are not approved browsers and never touch the management lane. Out of scope: public discovery, an App Store, uptime promises. | Approved-browser trust and the bridge's content-free default are not redefined by viewer traffic. |
| F12 | Naming depth: user-facing copy and docs only. The CLI keeps `work-fold manage …`; internal types, protocol identifiers, scope ids, routes, provenance values, and "management conversation" as a contract term stay. | Brand word and contract words do not have to match; no compatibility break is spent on a rename. |
| F13 | Copy specifics: **"Fold it in"** is the capture verb; Settings → Remote access becomes **"Your fold on the web"** without renaming technical contracts; the word Space stays; no "foldr"; Spaces are never renamed to folds. | Space, Library, Assistant tools, Chats, History vocabulary is untouched. |
| F14 | Routing chat-step provenance: the message a routing sends into a Space chat is an **ordinary user-role message** — the portable transcript carries no automation marker. Attribution is machine-local: routing run receipts, hop journals, run history, and the glance. | The interruption-marker semantics of Space chats and the F9 leak rule are untouched; the fixed message is still reviewed at enablement and names nothing cross-Space. |
| F15 | The fold's Settings surface is one section named **Settings → The fold**, hosting **Your fold on the web** (web access) as a subsection alongside standing policies, routing management, and publication controls. | Page ids and routes stay technical per F12; "Remote access" survives in contract and security prose. |
| F16 | At promotion, [fold.md](fold.md) shrinks into a compact fold decision register named by AGENTS.md's required reading (the Checks precedent); the siblings shrink into it as their sections ship. | product-model.md remains the constitution; the amendment blocks in [Integration](fold-integration.md) still apply exactly as written. |
| F17 | **Authority modes** (2026-08-31): Settings → The fold → Authority offers **Reviewed** and **Unrestricted**. Reviewed preserves host-composed cards and standing policies. Unrestricted executes every newly admitted staged act, including irreversible destruction, viewer exposure, routing enablement, and whole-Space file grants. Approved browsers inherit it structurally through the desktop host. Mode changes, pairing, and credential entry remain local setup surfaces with no Assistant/CLI/remote verb. Existing pending cards are not drained when the mode changes. | Pins, eligibility, effect-time rechecks, journal-first consumption, receipts, fences, at-most-once execution, and failure-without-auto-retry remain intact. The five setup-only families are boundaries of identity and secret handling, not recurring approvals. |

## One-sentence definitions

- **The verb ledger:** every product verb is a receipted act-lane verb —
  explicit selection, journal-first receipt, at-most-once execution, desktop
  conflict rules — except the consecrations and the setup-only boundary.
- **A staged authority act:** a prepared, inspectable, identity-pinned act in
  one of the three consequential families. Reviewed leaves it inert for a
  person or policy; Unrestricted executes it through the same decision path.
- **A standing policy:** one narrow, person-authored, Settings-only
  pre-approval of a consecration category, host-evaluated and receipted when
  exercised — never destruction, outward exposure, or routing enablement.
- **Setup-only authority:** the five families with no model/CLI/remote verb:
  Remote access administration, act-token and pairing machinery, provider
  credentials, standing-policy authoring, and root-authority selection.
- **A routing:** a machine-local, inert-until-enabled declaration of at most
  eight deterministic steps on one reviewed trigger, executed by app code
  with per-hop receipts; enabling it is a consecration.
- **The glance:** a deterministic digest — running work, needs-you items,
  what changed since the person last looked, Check status — composed by app
  code from recorded state only.
- **A viewer:** anyone holding a share link to one published page or hosted
  app; read-only, link-scoped, revocable, receipted, never an approved
  browser, never a Principal.

## Naming and copy rules

1. **the fold** is written lowercase like the work-fold wordmark, always
   with an article or possessive: "the fold", "your fold". It names the one
   door — the conversation and every surface that opens it. Never "Fold" as
   a capitalized proper noun, never "a fold", never plural.
2. **work-fold stays the actor.** The person tells work-fold what to do and
   replies stay labeled "work-fold". The fold is the place and the
   conversation's name, not a second persona — so imperative strings
   ("Tell work-fold what to do", "Message work-fold") keep the product as
   addressee.
3. **"Fold it in"** is the popover composer's capture verb, shown exactly
   when material is being handed over (staged reference chips present). A
   message without material is just "Send". The web client does not carry
   the two-state label: its send button is always "Send message".
4. **"Your fold on the web"** is the user-facing name of the web-access
   area inside **Settings → The fold** (decision F15). "Web access" is the
   short operational form inside that area (toggle, danger actions, errors).
   "Remote access" survives wherever a document speaks contract or security
   posture.
5. **Contract terms are frozen** (decision F12): `work-fold manage …`, the
   `work-fold-management` scope id, `/api/management/*`, `management.*`
   remote-facade methods, the `management/` application-state root, the
   `remote_web` provenance value, and the `remote` settings page id. A
   document's first user-facing use binds the vocabularies once — "the fold
   (technically: the management conversation)" — then each section speaks
   its own language.
6. **Publishing copy** says "pages your fold serves", never "host your
   website". Honest absence states stay honest: an offline desktop is
   "asleep", not an error page pretending otherwise.
7. Space, Library, Assistant tools, Chats, and History copy is untouched.

The shipped copy inventory is pinned by `tests/work-fold-brand.test.ts`
(popover title, tray entry, two-state send button),
`tests/onboarding-welcome.test.ts`, the bridge package's
`services/bridge/copy.test.mjs`, and
`tests/work-fold-management-conversation.test.ts` (the model-facing identity
line keeps the phrase "management conversation").

## Where the fold lives in code

The [management layer](management-layer.md)'s implementation and verification
map is the authority; in brief: staged acts and decisions in
`src/local/fold-staged-acts.ts` and `src/local/fold-decisions.ts`, host-composed
cards in `src/local/fold-decision-cards.ts`, standing policies in
`src/local/fold-policies.ts`, routings under `src/local/routings/`, the glance
in `src/local/glance.ts` and `src/local/glance-seen-store.ts`, publications in
`src/local/publications.ts` with the bridge's viewer plane in
`services/bridge/`, the verb families in `src/local/cli/act-commands.ts` and
`src/local/cli/act-facade.ts`, and the taught behavior in
`src/local/management-instructions.ts`.

## Deliberately not

- **No localization pass.** The product is English-only today; the copy
  rules above are English rules and would need their own decision before
  translation.
- **No marketing surface.** The bridge landing page keeps its factual
  register; no taglines beyond the shipped copy, no "host your website"
  framing anywhere (rule 6).
- **No enforced tool restriction of the fold.** It remains full-trust and
  taught, per [the management layer](management-layer.md) and the residual
  risks recorded in [Consecrations](fold-consecrations.md); changing that is
  a separate deliberate design.
