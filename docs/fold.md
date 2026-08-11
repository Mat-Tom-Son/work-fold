# The fold

**Status: proposal.** Nothing in this document is implemented or decided.
[Product model](product-model.md) remains the decision register; when this
ships, decisions are promoted there and this document shrinks.

This is the master concept document for one complete design effort. The
detailed designs live in sibling proposals, and every sibling carries this
same proposal status:

- [The verb ledger](fold-act-ledger.md) — every product verb as a receipted act-lane verb.
- [Consecrations, standing policies, and the never-list](fold-consecrations.md) — the decisions that keep an unforgeable human click.
- [Routings](fold-routings.md) — declared deterministic cross-Space glue.
- [The glance](fold-glance.md) — the deterministic digest of recorded state.
- [The publishing ladder](fold-publishing.md) — the viewer audience class and outward exposure.
- [Integration](fold-integration.md) — quoted before/after amendment blocks for the canonical documents, applied only after owner review.

## What the fold is

work-fold already ships one management surface in three coats: the
**management conversation** above all Spaces, its **menu-bar/tray popover**
(today labeled "Tell work-fold"), and the private-alpha **Remote access web
client**. They are one conversation, one authority, one transcript store —
but the product currently names them three different ways.

**The fold** is the one user-facing name for that one thing. It is the one
door to all your Spaces: things come in through it (drops, attachments,
uploads, `files add`) and go out through it (the publishing ladder). Spaces
are the rooms; the fold is the door. Whichever surface opens it — menu bar,
desktop, or an approved browser — the person is in the same place talking to
the same Assistant.

The reusable one-sentence definition:

> **The fold is the one door to all your Spaces: what you hand it gets put
> where it belongs, what you ask for gets done with a receipt, and the few
> decisions that must stay yours come back to you as a click.**

What the fold is **not**:

- Not a Space. Its transcript is machine-local application state and never
  travels with a folder.
- Not a second Assistant, persona, or brand voice. Replies are still labeled
  work-fold; the fold is where you meet it and what the conversation is
  called.
- Not a rename of anything else. **Space**, **Library**, **Assistant
  tools**, **Chats**, and **History** are untouched. Spaces never become
  folds, and there is no "foldr".
- Not a new technical contract. `work-fold manage …`, the
  `work-fold-management` scope id, the `/api/management/*` routes, the
  `management.*` remote-facade methods, the `management/` application-state
  root, and "management conversation" as a contract term all stay exactly as
  documented in [the management layer](management-layer.md).

Today the fold's act surface is the shipped act lane
(`src/local/cli/act-commands.ts`): Chat creation, sends, and follows
(lifecycle verbs such as rename, snooze, archive, and resume are proposed,
not shipped — the ledger's audit is authoritative), Checks,
`spaces create`/`register`, and restore-pointed `files add`. This design
effort grows it into the complete doctrine below — the working shorthand
during planning was "god-mode with a ledger": the fold can do anything a
person can do in the app, and everything it does leaves a receipt, except
where a decision must remain a human click.

## The doctrine on one page

Every mutation designed anywhere in this document set must answer five
questions before it ships: **who journals it before it runs, what its
durable receipt contains, how it is revoked or undone, what happens when it
fails mid-act, and how a replay is prevented.** The shipped act lane already
answers all five (journal-first receipts, at-most-once request ids, History
restore points); the sibling documents answer them for every verb they add.
This master document deliberately designs no mutation of its own — its only
implementation surface is naming and copy, which changes no stored state, no
protocol, and no receipt.

### The verb ledger

Every product verb a person can perform in the desktop UI becomes a
receipted act-lane verb available to the fold, **except** the three
consecrations and the never-list. Confirmed families: chat lifecycle
(rename, snooze, archive, resume), History (list checkpoints, save restore
point, restore), Library (list, copy into a Space), Space rename, Space
unregister (removal without deletion), in-Space file operations through
restore-pointed paths, in-app content search, and App Studio's
authority-neutral verbs (declare/edit presentation, prepare, publish,
install with all powers off, prepare update/rollback, uninstall with
retain-data). Every act names its Space explicitly where applicable, carries
`--parent-task` lineage, is journaled before execution, and leaves a durable
receipt after. See [The verb ledger](fold-act-ledger.md).

### The three consecrations

Three verbs keep an unforgeable human click: **make bytes runnable**,
**widen a power**, and **destroy irreversibly**. The fold can stage any of
them — fully prepared, inspectable, inert — and the person decides on a
needs-you card. The click is the product's definition of authorization; it
exists because the fold reads untrusted content, and the click is the one
signal content cannot synthesize. Staged acts expire, expiry is not
approval, and denial is recorded rather than retried. A consecration
decision may be approved from the desktop or from an approved full-trust
remote browser, with compensating controls recorded below as decision F5.
See [Consecrations](fold-consecrations.md).

### Standing policies

The friction dial: person-authored records, created outside any assistant
turn in settings-like UI, that pre-approve narrow consecration categories —
never destruction, outward viewer exposure, or routing enablement, which
are not policy-eligible. Policies are inspectable, revocable, receipted
when exercised, and never model-authored; evaluation happens host-side at
decision time, not in the model. See
[Consecrations](fold-consecrations.md).

### The never-list

Five things the fold can neither do nor stage; they are desktop-human-only:
Remote access administration (enrollment, address changes, browser
approval/revocation, disabling), act-token and pairing machinery, provider
credentials, standing-policy authoring, and anything that widens the set of
principals that control the fold itself. The never-list guards the fold's
own authority surface and is not weakened by any other decision in this set.
See [Consecrations](fold-consecrations.md).

### Routings

Declared cross-Space glue: a machine-local, inert-until-enabled declaration
— a trigger, then deterministic steps executed by app code, never by an
open-ended fold conversation. Per-hop receipts plus a routing-run receipt;
enabling a routing is a consecration. Agentic steps run inside Spaces with
that Space's Assistant, because Space transcripts are portable and
cross-Space context in a Space transcript is a leak — the hard rule this
design exists to prevent. Bounds reuse the existing machine-wide scheduler
discipline (`src/local/agent/work-fold-automation-service.ts`). See
[Routings](fold-routings.md).

### The glance

A deterministic digest composed by app code from kernel-recorded state:
running work, needs-you items, what changed since the person last looked,
per-surface last-seen markers. No model call, no file scanning, no ambient
watching — it reads only state the product already records. It surfaces at
the popover's top, the remote client's home, and the main window; the fold
narrates it on demand, and narration is interactive, never scheduled. See
[The glance](fold-glance.md).

### The publishing ladder

Out through the same door. A **viewer** is a new audience class: per-artifact,
read-only, link-scoped, revocable, receipted — never an approved browser,
never touching the management lane. Rung 1 is the glance on your phone via
existing approved-browser trust; rung 2 shares one file as a rendered page at
the person's address, served live from the desktop; rung 3 hosts a
restricted-app Release for viewers with desktop-enforced broker semantics.
Copy says "pages your fold serves", never "host your website". See
[The publishing ladder](fold-publishing.md).

## Decision register

Recorded from the product owner on **2026-08-10**. These decisions bound
this document set — the siblings design within them, not around them — and
they are promoted into [Product model](product-model.md) and the other
canonical documents only when this ships, through the amendment blocks in
[Integration](fold-integration.md).

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

## Naming and copy

### Copy rules

1. **the fold** is written lowercase like the work-fold wordmark, always
   with an article or possessive: "the fold", "your fold". It names the one
   door — the conversation and every surface that opens it. Never "Fold" as
   a capitalized proper noun, never "a fold", never plural.
2. **work-fold stays the actor.** The person tells work-fold what to do and
   replies stay labeled "work-fold". The fold is the place and the
   conversation's name, not a second persona — so imperative strings
   ("Tell work-fold what to do", "Message work-fold") keep the product as
   addressee.
3. **"Fold it in"** is the capture verb, shown exactly when material is
   being handed over (staged reference chips present). A message without
   material is just "Send".
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

### Before/after inventory

User-facing strings verified in source on 2026-08-10. "Unchanged" rows are
deliberate decisions, recorded so the sweep has an explicit edge. Exact
quoted amendment blocks for README and the canonical docs live in
[Integration](fold-integration.md); the rows here are the intent.

**Menu bar and tray — `desktop/src/main.ts`**

| Where | Today | Proposed |
|---|---|---|
| Popover entry (macOS right-click menu and Windows tray menu) | `Tell work-fold` | `Your fold` |
| Main-window entry | `Open work-fold` | unchanged |
| Quit entry | `Quit work-fold` | unchanged |

**Popover window — `web-local/popover.html`, `web-local/src/popover/PopoverApp.tsx`**

| Where | Today | Proposed |
|---|---|---|
| Window title (`popover.html`, pinned by `tests/work-fold-brand.test.ts`) | `Tell work-fold` | `Your fold` |
| Unavailable card | `The management conversation is unavailable.` | `Your fold is unavailable.` |
| Transcript `aria-label` | `Management conversation` | `Your fold` |
| Composer placeholder | `Tell work-fold what to do` | unchanged — work-fold stays the actor |
| Continuation placeholder | `Reply to work-fold` | unchanged |
| Send button | `Tell work-fold` | `Fold it in` when material is staged; `Send` otherwise |
| Working card | `You can close this popover — the work continues.` | `You can close your fold — the work continues.` |
| Assistant role label in the transcript | `work-fold` | unchanged |
| Drop hint | `Drop files, folders, or links here` | unchanged |
| New-chat banner | `New chat ready. Your previous chat is still saved on this desktop.` | unchanged |

**Onboarding — `web-local/src/components/onboarding/OnboardingFlow.tsx`**

| Where | Today | Proposed |
|---|---|---|
| Menu-bar scene `aria-label` | `The work-fold menu-bar icon opens a small place to drop files, folders, or links and tell work-fold what to do.` | `The work-fold menu-bar icon opens your fold — a small place to drop files, folders, or links and tell work-fold what to do.` |
| Popover-preview header | `Across your Spaces` | `One door to all your Spaces` |
| Popover-preview prompt | `Tell work-fold what to do` | unchanged |
| Headline | `work-fold lives in your menu bar.` | `Your fold lives in the menu bar.` |
| Subline (already names the fold; pinned by `tests/onboarding-welcome.test.ts`) | `Click the fold—or drop something on it—from anywhere on your Mac.` | unchanged |

**Settings — `web-local/src/components/modals/DesktopSettingsModal.tsx`**

| Where | Today | Proposed |
|---|---|---|
| Settings navigation item (page id `remote` stays) | `Remote access` | `The fold` — one section hosting **Your fold on the web** (web access) alongside standing policies, routings, and publications (F15) |
| Non-desktop fallback heading and body | `Remote access` / `Remote access can be configured from the installed desktop app.` | `Your fold on the web` / `Your fold on the web is set up from the installed desktop app.` |
| Overview heading | `Your private web address` | unchanged |
| Overview summary | `Private alpha. Use the same management Assistant and running log from a browser. Content is application-encrypted in transit, but the hosted work-fold client is part of the trusted authority boundary.` | `Private alpha. Your fold — the same conversation your menu bar opens — from any browser you approve. Content is application-encrypted in transit, but the hosted work-fold client is part of the trusted authority boundary.` |
| Enable/disable toggle | `Enable remote access` / `Disable remote access` | `Enable web access` / `Disable web access` |
| Setup heading | `Set up remote access` | `Set up your fold on the web` |
| Change heading, address field, create/save buttons | `Change address or password`, `Web address` + `.work-fold.com`, `Create private address` / `Save changes` | unchanged |
| Approved-browsers heading and full-trust sentence | `Approved browsers` … `Approval is full trust: that browser may ask work-fold to read or change accessible files and run local commands.` | unchanged — the trust sentence is load-bearing |
| Danger actions | `Revoke all browsers` / `Remove remote access`; confirm `Remove this private address and all remote access? This cannot be undone.` | `Revoke all browsers` unchanged / `Remove web access`; confirm `Remove this private address and all web access? This cannot be undone.` |

**Desktop main-process user-visible errors — `desktop/src/main.ts`, `desktop/src/remote-access.ts`, `desktop/src/settings.ts`**

| Where | Today | Proposed |
|---|---|---|
| Setup/enable/open errors surfaced to the person (for example `Set up Remote access before enabling it.`, `Remote access is not configured.`, `Set up Remote access before opening it.`) | "Remote access …" phrasing | Follow the Settings page: "web access" / "your fold on the web" phrasing, one sweep. Log-only strings may keep "Remote access". |

**Remote web client — `services/bridge/public/app.js`, `services/bridge/public/index.html`**

| Where | Today | Proposed |
|---|---|---|
| Sign-in eyebrow | `Remote access` | `Your fold` |
| Address-unavailable eyebrow and supporting | `Remote access` / `Check the address or enable Remote access from the work-fold desktop app.` | `Your fold` / `Check the address, or enable web access from the work-fold desktop app.` |
| Landing detail 03 | `Go remote when needed` / `Use a private web address to reach your chats and Spaces while your desktop is online.` | `Your fold on the web` / `One private address opens the same conversation your menu bar does, while your desktop is online.` |
| Composer placeholder | `Message work-fold` | unchanged — work-fold stays the actor |
| Desktop-offline gate | `Open work-fold to continue.` and supporting copy | unchanged — approval and presence language stays exact |
| Pairing copy | `Approve this browser once` / `Match the code in work-fold.` and the non-exportable-key sentence | unchanged — security copy is load-bearing |
| Chats rail heading | `Chats` | unchanged — they are the fold's saved chats; naming the door does not require renaming the list |
| Page title (`index.html`) | `work-fold` | unchanged |

**Model-facing identity — `src/local/management-instructions.ts`**

| Where | Today | Proposed |
|---|---|---|
| Materialized `AGENTS.md` first sentence | `You are the management conversation for this computer's work-fold app.` | `You are the fold — the management conversation for this computer's work-fold app.` The contract phrase stays in the sentence; `tests/work-fold-management-conversation.test.ts` asserts it loads. |

**README and canonical docs — `README.md`, `docs/product-model.md`, `docs/management-layer.md`, `docs/ui-parity.md`, `SECURITY.md`, `PRIVACY.md`**

| Where | Today | Proposed |
|---|---|---|
| README feature bullets | "A management conversation above all Spaces…", "A menu-bar popover for that management conversation (\"Tell work-fold\")…", "Private-alpha Remote access at a chosen `<name>.work-fold.com`…" | One "the fold" framing that binds the vocabularies on first use and keeps every contract term; exact quoted blocks in [Integration](fold-integration.md). |
| Product model §Management layer, management-layer.md intro, ui-parity.md popover/tray items | "management conversation", "Tell work-fold", "Remote access" as the user-facing names | User-facing sentences say the fold; contract sentences keep management terms; exact quoted blocks in [Integration](fold-integration.md). |

## Implementation plan

This plan covers what this master document owns: the naming-and-copy thread
and the promotion mechanics. The verb ledger, consecrations, routings,
glance, and publishing threads carry their own plans in their own documents.
Work items are dependency-ordered, not phased; nothing starts before the
owner reviews this set (decision F2). Because README and docs must describe
shipped behavior, the canonical-doc promotion lands with the final code
item, not before it.

1. **Popover surface strings.** Change `web-local/popover.html` (window
   title) and `web-local/src/popover/PopoverApp.tsx` (unavailable card,
   transcript `aria-label`, working-card close line, two-state send button —
   `Fold it in` with staged chips, `Send` without; pure render logic, no
   protocol change). Update the popover-title assertion in
   `tests/work-fold-brand.test.ts` and add assertions for the new strings.
   Verify with `npm run check` and `npm test`
   (`tests/management-popover-refresh.test.ts` and
   `tests/management-requests.test.ts` must keep passing unmodified — they
   cover behavior, not copy).
2. **Tray and menu-bar entry.** Change the tray menu template in
   `desktop/src/main.ts` (`Tell work-fold` → `Your fold`); pin the label
   beside the existing brand assertions in `tests/work-fold-brand.test.ts`.
   Run `npm run check`, `npm test`, and `npm run desktop:prepare` (Electron
   change) before handoff.
3. **Onboarding strings.** Change
   `web-local/src/components/onboarding/OnboardingFlow.tsx` (scene
   `aria-label`, preview header, headline) and update
   `tests/onboarding-welcome.test.ts` to pin the new strings while keeping
   its existing `Click the fold…` and `Tell work-fold what to do`
   assertions.
4. **Settings page and desktop error strings.** Change
   `web-local/src/components/modals/DesktopSettingsModal.tsx` (navigation
   label, headings, toggle, danger actions, summary line) and the
   user-visible error strings in `desktop/src/main.ts`,
   `desktop/src/remote-access.ts`, and `desktop/src/settings.ts`. Verify
   with `npm run check` and `npm test` — `tests/desktop-remote-access.test.ts`,
   `tests/frontend-interaction-contract.test.ts`,
   `tests/web-design-system.test.ts`, and
   `tests/macos-renderer-adaptation.test.ts` exercise these surfaces — then
   `npm run desktop:prepare`.
5. **Remote client strings.** Change `services/bridge/public/app.js`
   (eyebrows, address-unavailable supporting line, landing detail 03). No
   existing suite pins client copy; add a small static copy test beside
   `services/bridge/server.test.mjs` in the bridge package so the strings
   cannot silently drift from the desktop vocabulary. The bridge deploys
   separately from the desktop release lanes.
6. **Model-facing identity line.** Change the first sentence of the
   materialized `AGENTS.md` in `src/local/management-instructions.ts`,
   keeping the phrase "management conversation" in that sentence so
   `tests/work-fold-management-conversation.test.ts` continues to assert the
   contract term loads into the Pi context. This is the only copy change
   that can influence Assistant behavior; it adds identity, it does not
   change any instruction.
7. **Canonical-doc promotion.** Apply the quoted amendment blocks from
   [Integration](fold-integration.md) to `README.md`,
   `docs/product-model.md`, `docs/management-layer.md`,
   `docs/ui-parity.md`, `SECURITY.md`, and `PRIVACY.md`; then shrink this
   document to its decision register per the header. Verify with `npm test`
   (`tests/documentation-contract.test.ts` requires each canonical doc to
   keep linking the management guide).
8. **Release collateral.** Refresh the README's popover screenshot and any
   release notes only once a build actually shows the new strings — README
   claims track shipped behavior, per `AGENTS.md`.

## Deliberately not in this design

- **No mutation, verb, surface, or protocol change.** This document names
  and points; the sibling documents design. The copy sweep alters no stored
  state, receipt, journal, or identifier, so the five mutation questions are
  answered here by having nothing to answer; every sibling answers them per
  verb.
- **No CLI rename.** `work-fold manage …` stays; there is no `work-fold
  fold` alias and no deprecation dance.
- **No renamed identifiers.** Scope ids, routes, facade methods, provenance
  values, settings page ids, storage roots, and test names keep their
  management vocabulary permanently — brand word and contract word do not
  have to match (decision F12).
- **No second persona.** The fold gets no separate voice, avatar, or tone;
  transcript labels stay "work-fold".
- **No renaming of Spaces, Library, Assistant tools, Chats, or History**,
  and no "foldr" (decision F13).
- **No localization pass.** The product is English-only today; the copy
  rules above are English rules and would need their own decision before
  translation.
- **No marketing surface.** The bridge landing page keeps its factual
  register; this design adds no taglines beyond the copy table, no domain
  work, and no "host your website" framing anywhere (rule 6).
- **No phased naming rollout.** The sweep is one effort with one review;
  shipping half the vocabulary would leave the product naming one thing two
  ways, which is the exact problem being fixed.
