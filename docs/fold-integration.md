# Fold integration

**Status: proposal.** Nothing in this document is implemented or decided.
[Product model](product-model.md), [the management layer](management-layer.md),
and the other canonical documents quoted below remain the decision registers;
when the fold ships, its decisions are promoted there through this document's
amendment blocks, and every fold document — this one included — shrinks.

This is the cross-cutting document of the fold design set:
[The fold](fold.md) (the one door, naming, decision register),
[the act ledger](fold-act-ledger.md) (direct receipted verbs),
[consecrations](fold-consecrations.md) (staged acts, needs-you decisions,
standing policies, the never-list), [routings](fold-routings.md) (declared
cross-Space glue), [the glance](fold-glance.md) (the deterministic digest),
and [publishing](fold-publishing.md) (the viewer ladder).

## What this document is

The six sibling documents each design one thread and each carry their own
implementation plan. This document owns what none of them can own alone:

1. **Amendment blocks** — the exact quoted before/after changes each canonical
   document needs when a thread ships. The siblings state intent; this
   document states the words. Nothing here is applied until the owner reviews
   the set; the canonical files are untouched today.
2. **Test and verification impact** — what every existing suite gains, which
   suites deliberately do not change, and which suites are new.
3. **The cross-workstream build order** — one topological ordering across all
   six implementation plans, with the shared contracts that must have exactly
   one owner.
4. **A risk register** for the effort as a whole.
5. **A promotion checklist** mapping each proposal section to the canonical
   document it amends.

What this document is **not**: it designs no mutation, verb, store, surface,
or protocol of its own. Every mutation in the fold set answers the five
standard questions — who journals it, what the receipt contains, how it is
revoked or undone, what happens on failure mid-act, how replay is prevented —
in its owning sibling, indexed below. Applying an amendment block is an
ordinary reviewed repository edit verified by `npm test`
(`tests/documentation-contract.test.ts`), not a product mutation, so the five
questions do not arise here.

## Mutation obligations across the set

The index, so no mutation's answers can fall between documents:

| Mutation family | The five answers live in |
|---|---|
| Every direct verb — Space lifecycle and appearance, Chats, History, Files, Library, search, Checks, capability removal, app-authority narrowing, App Studio | [The act ledger](fold-act-ledger.md), "Rules every verb inherits" plus each family table's receipt, undo, and conflict columns |
| Stage a consecrated act; cancel one; decide one; exercise a standing policy; author a policy in Settings | [Consecrations](fold-consecrations.md), "Mutation obligations" |
| Routing stage, enable, run, run-now, stop, disable, delete | [Routings](fold-routings.md), the five-questions table under "Lifecycle and authority" |
| Glance last-seen marker advance — the glance's only mutation | [The glance](fold-glance.md), "Last-seen markers" |
| Publication stage, decide, activate, rebind/widen, narrow, revoke, snapshot refresh | [Publishing](fold-publishing.md), "The mutation ledger" |
| Naming and copy | [The fold](fold.md) designs no mutation; the sweep changes no stored state, protocol, or receipt |

## Cross-document reconciliations

Points where two siblings, written in parallel, must converge on one spelling
or one owner before implementation. Each is recorded here so no thread ships a
third variant.

1. **One decision-id spelling on receipts — decided: `decisionId`.** The id
   names the pending decision the person sees, and the staged act and its
   decision share one identity by construction (the decision request id is
   derived from the staged-act id). Both siblings now write `decisionId`;
   recorded here so no third spelling appears at implementation.
2. **One surface vocabulary — decided.** Wherever a surface is *recorded*,
   the closed set is `cli`, `popover`, `main-window`, `remote_web` (the
   provenance spelling already shipped in `src/local/agent/chat-store.ts`),
   and `policy`; both siblings now use it. Glance marker keys stay as
   designed — they key per-grant presentation state, not receipts.
3. **`publish.viewer.expose` pins are no longer placeholders.**
   Consecrations reserved the kind pending publishing's outward-exposure
   analysis; [publishing](fold-publishing.md) landed it (consecration 2), and
   the consecrations pin-table row now carries both shapes from publishing's
   mutation ledger: page slots pin Space id, exact relative path, title,
   budgets, and snapshot flag; hosted-app exposure (rung 3) pins App Instance
   id, exact Release digest, viewer entry, and the complete viewer-readable
   surface. Rebind, budget-raise, snapshot-on, and viewer-surface-widening
   updates reuse the kind with old and new bindings pinned.
4. **`apps release publish` is resolved as a direct verb.** The ledger's row
   held conditionally; publishing confirmed the App Studio transition is a
   local state change with no outward exposure, and the outward act is the
   separate `pages` consecration. The conditional caveat is dropped at
   promotion.
5. **Decision TTL and caps are shared dials.** The 24-hour staged-act TTL and
   the 32-pending cap are consecrations' dials; staged routing enablements and
   staged publications inherit them rather than defining their own. The owner
   reviews the dials once.
6. **Needs-you rendering is one card contract.** The popover stack, the
   main-window flyout, and the remote client home render the same
   host-composed card component contract from consecrations; routing
   enablement and publication cards are kinds within it. Glance needs-you
   items reference the same pending records and never a second store.
7. **The remote operation vocabulary grows in coordinated waves.**
   `decisions.list`/`decisions.decide` (consecrations),
   `management.glance`/`management.glanceSeen` (the glance), and
   `viewer.fetch` plus the device publication routes (publishing) each touch
   `src/local/remote-management.ts`, `desktop/src/remote-access.ts`, and
   `services/bridge/server.mjs` together. The bridge deploys separately from
   the desktop, and its `allowedOperations` set rejects unknown operation
   names, so each wave lands allowlist-first at the bridge. Viewer traffic
   never enters the management `allowedOperations` set at all.
8. **The settle-signal seam has one owner.** Routings introduces it at the
   Check service's terminal-persistence funnel and the restricted-app
   `onResult` funnel. The glance deliberately does not consume it — the
   glance reads stores on request. No other thread may attach to those
   funnels without a register decision.
9. **Act protocol stays at version 2.** Every thread extends argv, command
   tables, and the facade; none changes the envelope in
   `src/local/cli/act-protocol.ts`. A guard belongs in
   `tests/work-fold-cli-act-protocol.test.ts`.
10. **The glance's source inventory is closed.** The records the other
    threads add — staged acts, routing runs, viewer grants — are already rows
    in [the glance](fold-glance.md)'s inventory table. Any further source
    must amend that table first; nothing feeds the digest by side effect.
11. **The fold's Settings surface has one name: Settings → The fold**
    (owner decision, 2026-08-10, F15 in [the fold](fold.md)). It hosts
    standing policies, routing management, and publication controls, with
    "Your fold on the web" as its web-access subsection. Where an amendment
    block below says "the fold's Settings section," that phrase now resolves
    to **Settings → The fold**.
12. **Popover copy and cards do not collide.** The fold's two-state send
    button ("Fold it in" with staged material, "Send" without) is composer
    copy; needs-you cards carry their own Approve and Deny controls and do
    not change the composer.
13. **Policy-ineligible kinds are one closed list, owned by consecrations.**
    Standing policies can never name a destroy-category kind,
    `publish.viewer.expose` ([publishing](fold-publishing.md): every new
    exposure takes a click), or `routing.enable` (a routing enablement's
    whole-declaration review is the point); the policy store rejects
    ineligible kinds, and `tests/fold-policies.test.ts` covers the refusal.
    Recorded here so the exclusions cannot drift when any owning sibling
    changes.
14. **No-restore-path deletion has one semantics.** The
    [act ledger](fold-act-ledger.md)'s `files delete` refuses whenever any
    matched content lacks restore coverage (the safety checkpoint would skip
    it as oversized, unreadable, or a symlink), and the staged
    `files destroy` verb — executing [consecrations](fold-consecrations.md)'
    `files.destroy` kind — is the only path to such a deletion. Both
    documents state the same refusal rule; no lane may delete content the
    restore point cannot bring back without a click.

## Amendment blocks

### How to apply these blocks

- Every **Before** quotation was verified byte-for-byte against the working
  tree on 2026-08-10. Files move; re-verify each anchor before applying, and
  treat a failed match as a stop, not an approximation.
- Blocks are labeled with the thread whose shipping makes them true:
  *naming*, *ledger*, *consecrations*, *routings*, *glance*, *publishing*.
  A block naming more than one thread applies only when every named thread
  has shipped, unless its label says each part applies with its own thread.
  `README.md` and the product-model roadmap describe **shipped** behavior
  (per `AGENTS.md`), so their blocks apply only when the owning thread's code
  lands. Register blocks (nouns, rails, contract sections) may be applied at
  owner acceptance if the roadmap wording marks the direction as accepted
  rather than shipped — the product model's own rule.
- After any application, `npm test` must stay green —
  `tests/documentation-contract.test.ts` pins cross-document claims, and the
  blocks below were written to preserve every regex it asserts today.
- Blocks quote only the sentences that change. Where a long passage changes
  in one clause, the block quotes that clause and says the remainder is
  unchanged.

### docs/product-model.md

**PM-1 — Nouns table rows** (*naming* for the fold; *routings*; *publishing*).
Insert after the final row of "The nouns" table:

Anchor (unchanged):

```md
| **App Instance** | One published Release installed into a chosen Space with its own runtime, data, grants, connections, jobs, and receipts. | It is distinct from the source-bound Development preview and does not live in or own the Space folder. |
```

Insert after the anchor:

```md
| **The fold** | The one door to all Spaces: the management conversation, its menu-bar/tray popover, and the Remote access web client under one user-facing name. | It is not a Space, a second Assistant, or a renamed contract; "management conversation" stays the technical term. |
| **Routing** | A declared, inert-until-enabled set of deterministic steps that move work between Spaces on a reviewed trigger. | It is executed by app code, never by an Assistant conversation, and nothing routing-shaped is written into any Space folder. |
| **Viewer** | Someone reading one published page or app through a share link while the desktop is online. | A viewer is not an approved browser, never touches the management lane, and is never a Principal. |
```

**PM-2 — Explicit-context table rows** (*consecrations*; *routings*;
*publishing* — apply each row with its thread). Insert after the final row of
the "Context is explicit" table:

Anchor (unchanged):

```md
| Run an app automation now | work-fold runs that named job once and records a durable receipt, even if its schedule is off. | It does not enable or shift the schedule; a disabled job has no notification authority. |
```

Insert after the anchor:

```md
| Stage a consecrated act | The fold prepares one fully inspectable, inert staged act, and a pending decision appears on the needs-you surfaces. | Nothing executes, installs, grants, or deletes; expiry is not approval, and denial is recorded, not retried. |
| Decide a staged act | A person approves or denies the exact pinned act from the desktop or an approved remote browser; the decision receipt names the approving surface. | Approval never widens beyond the pinned identities; a changed pin invalidates the act instead of executing something else; a remote grant never decides an act its own request staged, and Personal-scope make-runnable is decided on the desktop only. |
| Create a standing policy | A person authors one narrow pre-approval in Settings, outside any assistant turn. | The fold cannot write policies, no policy covers destruction, outward viewer exposure, or routing enablement, and exercised policies are receipted. |
| Enable a routing | work-fold records an exact-digest machine grant over one reviewed declaration after a needs-you decision. | Proposal authoring, registration, and run-now never enable standing behavior; an edited declaration returns to proposed. |
| Run a routing | App code executes the reviewed steps in order with per-hop receipts inside the shared scheduler bounds. | No model composes glue, a routing never moves or deletes source files, and no Space folder learns another Space exists. |
| Share a page | After a needs-you decision, one explicitly designated file is served as a rendered page at the person's address while the desktop is online. | Nothing else in the Space is exposed, the bridge stores no page content by default, and App Studio's local "publish a Release" grants no audience. |
| Revoke a publication | work-fold refuses new viewer fetches desktop-first, then deletes the bridge slot and any snapshot. | Old links die; sharing again mints a new slot, key, and link rather than reviving the old one. |
```

**PM-3 — Product rails additions** (*consecrations* for 9 and 10; *routings*
for 11). Append after the final rail:

Anchor (unchanged):

```md
8. **Provider neutrality:** cloud and model integrations should use replaceable adapters rather than shape the core model.
```

Insert after the anchor:

```md
9. **The click is authorization:** making bytes runnable, widening a standing power, and destroying irreversibly require a human decision on a work-fold decision surface. The fold may stage those acts completely, but only a person decides; staged acts expire, expiry is not approval, and denial is recorded, not retried.
10. **The fold's own authority is never self-serve:** Remote access administration, act-token and pairing machinery, provider credentials, standing-policy authoring, and anything that widens the set of principals controlling the fold are desktop-human-only. The fold can neither perform nor stage them.
11. **Agency on a cadence lives in Spaces:** above Spaces, only declared deterministic routings run unattended, their enablement is a clicked decision, and cross-Space work never runs inside a Space chat, because Space transcripts travel with their folders.
```

**PM-4 — §Management layer naming** (*naming*). Two sentence-level changes in
the "Management layer" section.

Before:

```md
The **management conversation** is the first in-product consumer of that layer: one conversation scope that sits above all Spaces.
```

After:

```md
**The fold** (technically: the management conversation) is the first in-product consumer of that layer: one conversation scope that sits above all Spaces, and the one door through which material enters them from outside.
```

Before:

```md
and through its one visible desktop surface: the **menu-bar popover** (a macOS menu-bar item; the Windows tray offers the same "Tell work-fold" entry)
```

After:

```md
and through its one visible desktop surface: the **menu-bar popover** (a macOS menu-bar item; the Windows tray offers the same "Your fold" entry)
```

Before:

```md
**Remote access** is a private-alpha connected surface over the canonical management conversation, not a second Assistant, a Space-chat selector, or a cloud-synchronized Space.
```

After:

```md
**Remote access** — presented in the product as **Your fold on the web** — is a private-alpha connected surface over the canonical management conversation, not a second Assistant, a Space-chat selector, or a cloud-synchronized Space.
```

**PM-5 — §Management layer act-lane sentence** (*ledger*).

Before:

```md
A separately versioned act lane — authenticated per app launch and recorded with durable receipts — additionally lets a shell-capable agent create or register Spaces, copy outside material into a Space with a History restore point, and start, continue, await, or abort Space Chats while the app is running. Act commands reuse the same trust, conflict, History, and task rules as the desktop surfaces; they do not touch capabilities, tabs, panes, or application settings.
```

After:

```md
A separately versioned act lane — authenticated per app launch and recorded with durable receipts — additionally gives a shell-capable agent the product's receipted verbs while the app is running: Space lifecycle and appearance, Chats and their lifecycle, History restore points and restores, restore-pointed file operations, Library copies, content search, Checks, App Studio's authority-neutral lifecycle, and the management conversation itself. Act commands reuse the same trust, conflict, History, and task rules as the desktop surfaces. Acts that make bytes runnable, widen a standing power, or destroy irreversibly stage a pending decision instead of executing, and the act lane cannot decide them; tabs, panes, application settings, and the never-list stay outside it entirely.
```

**PM-6 — Roadmap direction bullet** (*acceptance*; refreshed into "Foundation
now" per thread as behavior ships, following the roadmap's own rule). Insert
into "Next product layer":

```md
- Grow the fold per the accepted fold design set: the complete receipted verb ledger, staged needs-you decisions with person-authored standing policies, declared deterministic routings, the glance, and the publishing ladder ("pages your fold serves"). See [the fold](fold.md).
```

At each thread's ship, the corresponding "Foundation now" bullets are updated
to describe the shipped behavior and this direction bullet shrinks; exact
roadmap wording is deliberately left to ship time because it must describe
what actually shipped.

### AGENTS.md

**AG-1 — Required reading** (*acceptance*, once fold.md shrinks into a
register).

Before:

```md
read [the management layer](docs/management-layer.md) before changing the kernel, CLI, task registry, or an agent-facing adapter, and read [Checks](docs/checks.md) before changing Check declarations, sensors, targets, evidence admission, decisions, or run authority.
```

After:

```md
read [the management layer](docs/management-layer.md) before changing the kernel, CLI, task registry, or an agent-facing adapter, read [Checks](docs/checks.md) before changing Check declarations, sensors, targets, evidence admission, decisions, or run authority, and read [the fold](docs/fold.md) before changing the fold's verb ledger, staged decisions, standing policies, routings, the glance, or published viewer pages.
```

**AG-2 — Harness-parity act-lane families** (*ledger*, then extended as
*routings* and *publishing* ship; apply with the family names that have
actually shipped).

Before:

```md
a content-free read lane plus a per-launch-authenticated act lane (`chat`, `chats list`, `manage`, `checks`, `spaces create/register`, `files add`) that needs the running app.
```

After:

```md
a content-free read lane plus a per-launch-authenticated act lane (`chat`, `chats`, `history`, `files`, `search`, `library`, `spaces`, `tools`, `apps`, `checks`, `routings`, `pages`, `staged`, `manage`) that needs the running app.
```

**AG-3 — Management-layer mutation bullet** (*consecrations*).

Before:

```md
- Protocol v1 under `%APPDATA%\work-fold\cli` is same-user coordination, not an authenticated caller boundary. It must remain read-only and content-free. Mutations belong exclusively to the separately versioned act lane, which requires the per-launch act token minted by the running interactive app, explicit `--space` selection on every write, replayed-request protection, and a durable receipt per accepted action; keep those properties intact when extending it.
```

After:

```md
- Protocol v1 under `%APPDATA%\work-fold\cli` is same-user coordination, not an authenticated caller boundary. It must remain read-only and content-free. Mutations belong exclusively to the separately versioned act lane, which requires the per-launch act token minted by the running interactive app, explicit `--space` selection on every Space-scoped write (the management-scope, Library, routing, and `staged` families are deliberately Space-free; a staged act pins its Space at staging time), replayed-request protection, and a durable receipt per accepted action; keep those properties intact when extending it. Consecrated acts — making bytes runnable, widening a standing power, destroying irreversibly — stage pending decisions instead of executing; deciding them is never an act-lane capability, the act facade must not expose decision or policy internals, and the never-list (Remote access administration, act-token and pairing machinery, provider credentials, standing-policy authoring, anything widening the principals that control the fold) has no act verb at all.
```

**AG-4 — Product rails additions** (*consecrations*; *routings*). Insert after
the final rail:

Anchor (unchanged):

```md
- **Layered app authority:** proposing, reviewing, installing, granting one destination/file/notification category, saving a connection, and enabling each named automation are distinct actions. Revocation must stop stale launches before authority changes take effect.
```

Insert after the anchor:

```md
- **Click-gated consecrations:** making bytes runnable, widening a standing power, and destroying irreversibly require a human decision on a work-fold decision surface. The fold may stage those acts fully; only a person decides, staged acts expire, expiry is not approval, and denial is recorded, not retried.
- **Above-Space cadence:** agency on a schedule lives in Spaces. Above them, only declared deterministic routings run unattended, their enablement is a clicked decision, and cross-Space work never runs inside a Space chat because Space transcripts travel.
```

### docs/management-layer.md

**ML-1 — Naming binds** (*naming*).

Before:

```md
`work-fold manage …` talks to the **management conversation** — the one conversation above all Spaces.
```

After:

```md
`work-fold manage …` talks to the **management conversation** — user-facing name: **the fold** — the one conversation above all Spaces.
```

Before:

```md
The same request model backs the desktop's **menu-bar popover** (macOS menu-bar item; the Windows tray gains the same "Tell work-fold" entry), which talks to `/api/management/*` local-API routes
```

After:

```md
The same request model backs the desktop's **menu-bar popover** (macOS menu-bar item; the Windows tray gains the same "Your fold" entry), which talks to `/api/management/*` local-API routes
```

**ML-2 — Journal-first receipts bullet** (*ledger* and *consecrations*). In
the "Security boundary" list, extend the receipts bullet.

Before:

```md
- **Journal-first receipts.** Every authorized act command appends an `accepted` line to `cli/receipts/act.jsonl` **before** its mutation runs — an unwritable journal refuses the command — and a terminal `ok`/`error` line after (timestamp, command, Space/conversation ids, outcome, error code, History checkpoint id, kernel task id). A crash can separate the pair, but an applied action can never be missing its `accepted` trace; a missing terminal record is itself the honest signal that the outcome was interrupted. Terminal-record failures surface as a warning on the command's stderr.
```

After:

```md
- **Journal-first receipts.** Every authorized act command appends an `accepted` line to `cli/receipts/act.jsonl` **before** its mutation runs — an unwritable journal refuses the command — and a terminal `ok`/`error` line after (timestamp, command, Space/conversation ids, outcome, error code, History checkpoint id, kernel task id). Receipts additionally record the initiating surface (`cli`, `popover`, or `remote_web` with browser and grant ids), the decision id and deciding surface for consecrated acts, the standing-policy id when a policy rather than a click satisfied a decision, and a typed prior-state reference for undo — identifiers and digests only, never content. A crash can separate the pair, but an applied action can never be missing its `accepted` trace; a missing terminal record is itself the honest signal that the outcome was interrupted. Terminal-record failures surface as a warning on the command's stderr.
```

**ML-3 — Staged-decisions bullet** (*consecrations*). Insert a new bullet
after the "Existing policy checks." bullet in the same list:

```md
- **Staged decisions.** Acts in the three consecrated families — make bytes runnable, widen a standing power, destroy irreversibly — stage a fully prepared, inert pending decision instead of executing. The decision path exists only on the desktop renderer surfaces and an approved remote browser's signed envelope; the act facade never exposes decision or policy-mutation internals, so no act-lane request can approve anything. Approval rechecks every pinned identity, is consumed journal-first under a deterministic decision request id, executes as a fenced kernel task, and is never auto-retried on failure; startup marks an interrupted execution and never replays it.
```

**ML-4 — Remote operation growth** (*consecrations*; *glance*; *publishing*).
Insert a new paragraph at the end of the "Remote browser surface" section,
after the paragraph beginning "This is a powerful full-trust Assistant
surface.":

```md
The closed remote operation vocabulary grows with the fold's decision and glance surfaces: `decisions.list` and `decisions.decide` present pending staged acts as live projections and carry a person's approval or denial, and `management.glance`/`management.glanceSeen` return the deterministic digest and advance that grant's own last-seen marker — same signed envelopes, same effect-time grant recheck, no new persisted content classes at the bridge. Decision receipts record the approving browser and exact grant; a staged act is never decidable from the remote grant whose request staged it, and Personal-scope make-runnable decisions are desktop-only; revoking a browser refuses its in-flight decision operations before consumption, cancels the pending staged acts its grant staged, and deletes its glance marker. Published viewer pages are a different plane entirely: viewer traffic terminates on separate `pages-` origins, never appears in the management operation allowlist, and never reaches these operations.
```

**ML-5 — Implementation and verification map rows** (per thread). Insert
after the automation-scheduling row of the table:

Anchor (unchanged):

```md
| Machine-wide restricted-app automation scheduling | `src/local/agent/work-fold-automation-service.ts` | `tests/work-fold-automation-service.test.ts` plus restricted-app service/API tests |
```

Insert after the anchor:

```md
| Staged acts and the decision path | `src/local/fold-staged-acts.ts`, `src/local/fold-decisions.ts` | `tests/fold-staged-acts.test.ts`, `tests/fold-decisions.test.ts` |
| Standing policies | `src/local/fold-policies.ts` | `tests/fold-policies.test.ts` |
| Routing declarations, store, settle signals, and executor | `src/local/routings/` | `tests/work-fold-routing-declarations.test.ts`, `tests/work-fold-routing-store.test.ts`, `tests/work-fold-routing-settle-signal.test.ts`, `tests/work-fold-routing-service.test.ts` |
| Glance composition and seen markers | `src/local/glance.ts`, `src/local/glance-seen-store.ts` | `tests/work-fold-glance.test.ts`, `tests/work-fold-glance-seen-store.test.ts` |
| Publications and viewer serving | `src/local/publications.ts`, `desktop/src/remote-access.ts` | `tests/work-fold-publications.test.ts`, `tests/desktop-remote-access.test.ts` |
```

### README.md

README claims track shipped behavior; every block below applies only when its
thread's code lands. The walkthrough already says "the fold also lives in the
menu bar" and "Click the fold" — those sentences are deliberately unchanged.

**R-1 — Feature bullets: the fold binding** (*naming*).

Before:

```md
- A management conversation above all Spaces (`work-fold manage …`): the same full-trust Assistant runtime with a machine-local transcript, taught by app-materialized instructions to work across Spaces through the work-fold CLI's read and act commands. Requests carry reference attachments (`--attach` paths and links), track every delegated Space turn, and support request-level status and stop.
```

After:

```md
- The fold — a management conversation above all Spaces (`work-fold manage …`): the same full-trust Assistant runtime with a machine-local transcript, taught by app-materialized instructions to work across Spaces through the work-fold CLI's read and act commands. Requests carry reference attachments (`--attach` paths and links), track every delegated Space turn, and support request-level status and stop.
```

Before:

```md
- A menu-bar popover for that management conversation ("Tell work-fold"): drop files, folders, or links on the macOS menu-bar icon or the popover, add an instruction, and follow the request through working, needs-you, handed-off, and done — with an explicitly attributed action trail backed by act receipts and a Stop that names everything it aborts. New chat starts a clean saved transcript without deleting the previous one. The Windows tray offers the same popover from its menu.
```

After:

```md
- A menu-bar popover that opens your fold ("Your fold" in the menu bar and tray): drop files, folders, or links on the macOS menu-bar icon or the popover, add an instruction — with material staged, the send button reads "Fold it in" — and follow the request through working, needs-you, handed-off, and done, with an explicitly attributed action trail backed by act receipts and a Stop that names everything it aborts. New chat starts a clean saved transcript without deleting the previous one. The Windows tray offers the same popover from its menu.
```

Before (opening clause only; the remainder of the bullet is unchanged):

```md
- Private-alpha Remote access at a chosen `<name>.work-fold.com`: set the address and password in Settings, approve each new browser with a matching code on the desktop,
```

After:

```md
- Private-alpha web access to your fold ("Your fold on the web") at a chosen `<name>.work-fold.com`: set the address and password in Settings, approve each new browser with a matching code on the desktop,
```

**R-2 — Act-lane bullet and CLI section** (*ledger*).

Before:

```md
- A versioned management layer and installed `work-fold` command: a content-free read lane for inspecting Space context, running work, and Pi capabilities, plus a per-launch-authenticated act lane that lets a shell-capable agent create or register Spaces, copy material into a Space with a History restore point, and start, continue, await, or abort Space Chats while the app is running — every action journaled before it runs.
```

After:

```md
- A versioned management layer and installed `work-fold` command: a content-free read lane for inspecting Space context, running work, and Pi capabilities, plus a per-launch-authenticated act lane that gives a shell-capable agent the product's receipted verbs while the app is running — Space lifecycle and appearance, Chats and their lifecycle, History saves and restores, restore-pointed file operations, Library copies, content search, Checks, and App Studio's authority-neutral lifecycle — every action journaled before it runs, replays refused by request id, and acts that install code, widen a power, or destroy something staged for a human decision instead of executed.
```

Before (in the "work-fold CLI" section):

```md
Mutations ride a separately versioned act lane instead: while the work-fold app is running it mints a per-launch token that authorizes `chat`, `chats list`, `spaces create/register`, `files add`, and Check enable/run/result/decision commands, reuses the same trust, conflict, task, and History rules as the desktop surfaces, journals every authorized action before it runs, and refuses a replayed request id instead of executing it twice.
```

After:

```md
Mutations ride a separately versioned act lane instead: while the work-fold app is running it mints a per-launch token that authorizes the receipted verb families (`chat`, `chats`, `history`, `files`, `search`, `library`, `spaces`, `tools`, `apps`, `checks`, and `manage`), reuses the same trust, conflict, task, and History rules as the desktop surfaces, journals every authorized action before it runs, and refuses a replayed request id instead of executing it twice. Acts that install code, widen a standing power, or destroy irreversibly stage a needs-you decision instead of executing; deciding one is never a CLI operation.
```

(`staged` joins the family list in this sentence when the consecrations
thread ships; `routings` and `pages` join when those threads ship.)

**R-3 — Needs-you and glance bullets** (*consecrations*; *glance*). Insert
after the popover bullet:

```md
- Needs-you decisions: the fold can fully stage installing code, widening a standing power, or destroying something — and only a click on the desktop, the popover, or an approved browser completes it. Cards are host-composed from pinned facts, staged acts expire, denial is recorded rather than retried, and every decision leaves a receipt naming the surface that approved it. Narrow person-authored standing policies, created in Settings and never by the fold, can pre-approve exactly named categories — never destruction or outward exposure.
- The glance: a deterministic digest of running work, needs-you items, what changed since you last looked, and Check status — composed by app code from recorded state only, with no model call, no file scanning, and no background watching, shown at the popover's top, the remote client's home, and a compact main-window panel.
```

**R-4 — Routings bullet** (*routings*). Insert after the glance bullet:

```md
- Routings: declared cross-Space glue — a reviewed trigger and up to eight deterministic steps (start a Space chat with a fixed message, copy files with a restore point, run a Check), executed by app code on the shared scheduler discipline with per-hop receipts. Enabling one is a needs-you decision; cross-Space work never runs inside a Space chat, because Space transcripts travel with their folders.
```

**R-5 — Publishing bullet** (*publishing*). Insert after the Remote access
bullet:

```md
- Share a page ("pages your fold serves"): after a needs-you decision, one explicitly designated file is served as a rendered page at your `<name>.work-fold.com` address — live from your desktop through the relay, encrypted with a key carried in the link fragment, with an honest "asleep" state when the desktop is offline. Revoking kills every copy of the link; nothing else in the Space is exposed; there is no uptime promise, discovery, or App Store.
```

**R-6 — Documentation map row** (*promotion*). Insert into the
"Documentation map" list:

```md
- [The fold](docs/fold.md) — the fold's decision register: the verb ledger, needs-you decisions and standing policies, routings, the glance, and the publishing ladder.
```

### SECURITY.md

**S-1 — Act-lane content sentence** (*ledger*). In "Local management
surfaces":

Before:

```md
Because act commands include starting Assistant turns and reading their results, act request and response files can briefly contain prompt and conversation text; they remain bounded, local, and are deleted after completion.
```

After:

```md
Because act commands include starting Assistant turns, reading their results, searching content, and listing History, Library, and app records, act request and response files can briefly contain prompt, conversation, query, and listing text; they remain bounded, local, and are deleted after completion, and the receipts journal itself stays metadata-only.
```

(When the *glance* thread ships, the word "glance" joins this block's listing
sentence — a one-word insertion gated in the glance promotion row.)

**S-2 — Staged decisions paragraph** (*consecrations*). Insert a new
paragraph in "Local management surfaces", after the paragraph that begins
"Mutations ride a separately versioned act lane over the same broker files.":

```md
Consecrated acts do not execute from the act lane. Making bytes runnable, widening a standing power, and destroying irreversibly stage a machine-local, digest-pinned, inert staged act; the only decision paths are the desktop renderer surfaces and an approved remote browser's signed envelope, and the act facade exposes no decision or policy internals. Cards are host-composed from typed pins — model prose never becomes card copy — and a decision rechecks every pinned identity before journal-first consumption, so a changed digest invalidates the act instead of executing something else. Decision receipts name the approving surface and, for remote decisions, the exact browser and grant; a staged act is never decidable from the same remote grant whose request staged it, a make-runnable act at Personal scope — code that loads into the fold's own runtime — is decided only on the desktop, and revoking a browser refuses its in-flight decisions and cancels the pending acts staged at its behest. Standing policies are person-authored in Settings only, evaluated host-side at decision time over typed fields, receipted when exercised, and covered by a content-attestation digest that disables every policy when the store was edited out of band; no policy can cover the destroy category, outward viewer exposure, or routing enablement, and make-runnable policies match per-item identity or a first-party curated registry, never an open one. The never-list — Remote access administration, act-token and pairing machinery, provider credentials, standing-policy authoring, and anything that widens the set of principals controlling the fold — has no act verb, no staged-act kind, no card, and no remote operation. This gate binds the product's lanes: the management Assistant remains full-trust and taught rather than tool-restricted, and same-user processes remain inside the local trust boundary, exactly as documented above.
```

**S-3 — Routings paragraph** (*routings*). Insert after S-2's paragraph:

```md
Routings are the one thing above Spaces that runs unattended. A routing is a machine-local, closed, typed declaration — no prompts beyond the literal reviewed chat message, no code, no credentials, no expressions — enabled only by an exact-digest machine grant recorded through a needs-you decision. The executor is app code on the shared scheduler discipline with its own bounded budget; every run and hop is journal-first receipted; a failed hop fails the run rather than being smoothed over; disable and Space removal stop the active run before the authority change reads as complete, and a suspended routing never retargets or resumes without a fresh decision. Nothing routing-shaped is written into any Space folder, routing-caused settles never trigger other routings, and no routing step can create or widen viewer exposure.
```

**S-4 — Published viewer pages** (*publishing*). Insert a new subsection at
the end of "Local management surfaces", after the paragraph that ends
`See [Checks](docs/checks.md).`:

```md
### Published viewer pages

Optional publishing serves one explicitly designated Space file (or, later, a reviewed hosted App Instance surface) to anyone holding a share link, while the desktop is online. Viewer traffic lives on separate `pages-<slug>.work-fold.com` origins that never set cookies, never serve the management client, and never appear in the management operation allowlist; the `pages` slug and `pages-` prefix are reserved at enrollment. Page content crosses the bridge as ciphertext under a per-publication key carried in the link fragment; the key lives in operating-system-encrypted secure settings, and the full share link is shown to the person transiently, appearing in no receipt, journal, or log; the bridge stores slot identifiers, budgets, and counters — no titles, paths, or content — and an explicitly labeled, default-off snapshot opt-in stores only ciphertext. The desktop rechecks the local publication grant immediately before every serve; revocation is desktop-first, bridge cleanup is retried until confirmed, and disabling Remote access or deleting the address revokes every publication. Hosted-app viewer serving enforces a fixed viewer-safe broker subset desktop-side: exact staged Release assets and manifest-flagged instance-owned reads only — never storage writes, Assistant actions, network egress, connections, Space files, notifications, automations, or OAuth — and viewers are never resolved to Principals. Unauthenticated viewer traffic is rate- and byte-bounded at the bridge before anything reaches the desktop. Residual risk is the same class already documented for the hosted client: an actively compromised bridge or hosted origin can serve viewer-shell code that captures link-fragment keys for pages fetched from then on, with a blast radius of those published pages, never management authority. A link is the whole credential — anyone holding it is a legitimate viewer until revocation. The fold cannot create an address to publish to; enrollment and Remote access administration stay desktop-human-only.
```

### PRIVACY.md

**P-1 — What stays on this computer** (*consecrations*; *routings*; *glance*;
*publishing*). Insert after the final bullet of "What stays on this computer"
(the Remote access credentials bullet):

```md
- Staged needs-you decisions and their bounded terminal history, standing policies with their content-attestation digest, routing declarations with exact-digest grants, cadence anchors, and run receipts, publication records, and per-surface glance last-seen markers — all under the work-fold application-data directory. Publication encryption keys live in the same operating-system-encrypted secure settings as other credentials. None of these records is written into any Space folder, captured by History, or synchronized by anything that synchronizes a Space.
```

**P-2 — Published pages subsection** (*publishing*). Insert a new subsection
in "When data leaves this computer", after the "Optional Remote access
bridge" subsection:

```md
### Published pages (share links)

Sharing a page serves the current content of one explicitly designated Space file, rendered on this desktop, to anyone holding its link while the desktop is online. The page crosses the bridge as ciphertext encrypted with a key carried in the link fragment; the key is kept in operating-system-encrypted secure settings, the full link is shown transiently and written to no receipt or log, and the bridge durably stores publication identifiers, budgets, and aggregate counters — not titles, file names, paths, or page content. Opting one publication into snapshot caching stores the latest served ciphertext at the bridge so the page stays readable while the desktop sleeps; the opt-in is labeled at the decision, defaults off, and its stored row is deleted on revocation. Anyone who obtains the full link can read that page until the publication is revoked; revoking kills every copy of the link, and sharing again creates a new link. Viewer requests are counted in aggregate; work-fold keeps no per-viewer identity, accounts, or analytics.
```

**P-3 — CLI act-content paragraph** (*ledger*). In "Local CLI and development
harness":

Before:

```md
Act commands carry more. A `chat send` or `manage send` request includes the message text (a `--message-file` is embedded into the bounded request payload by the shim), and `manage send --attach` additionally places the typed path or link strings in argv. Those short-lived request files do not contain the referenced local file contents.
```

After:

```md
Act commands carry more. A `chat send` or `manage send` request includes the message text (a `--message-file` is embedded into the bounded request payload by the shim), `manage send --attach` places the typed path or link strings in argv, and `search` places its query in argv. Content-bearing act responses — chat results, search matches, History, Library, and app listings — travel through the same bounded, short-lived request/response files and are deleted after the command. Those files do not contain referenced local file contents beyond what the command itself returns.
```

Before:

```md
every act command appends metadata-only records to the local `cli/receipts/act.jsonl` journal — timestamps, command names, Space/Chat/task ids (including an explicit management parent task id when present), outcomes, error codes, and restore-point ids, never message content, file contents, or credentials.
```

After:

```md
every act command appends metadata-only records to the local `cli/receipts/act.jsonl` journal — timestamps, command names, Space/Chat/task ids (including an explicit management parent task id when present), outcomes, error codes, restore-point ids, the initiating surface, and decision, policy, and typed prior-state identifiers, never message content, file contents, search queries, or credentials.
```

(When the *glance* thread ships, "glance" joins the listing sentence in this
block's first After text — a one-word insertion gated in the glance
promotion row.)

**P-4 — User choices** (*consecrations*; *routings*; *publishing*). In "User
choices":

Before:

```md
Restricted-app preview installation, Release preparation, local publication, target-Space installation, update/rollback activation, each network destination, file or notification grant, named automation, stored connection, App uninstall, and retain/purge decision are also separate choices. Revoking one authority does not imply revoking the others or invalidating a credential at its remote provider.
```

After:

```md
Restricted-app preview installation, Release preparation, local publication, target-Space installation, update/rollback activation, each network destination, file or notification grant, named automation, stored connection, App uninstall, and retain/purge decision are also separate choices. Approving or denying each staged needs-you decision, authoring each standing policy in Settings, enabling each routing, sharing each page, opting one publication into snapshot caching, and revoking any of them are separate choices as well. Revoking one authority does not imply revoking the others or invalidating a credential at its remote provider.
```

### docs/ui-parity.md

**U-1 — Tray actions** (*naming*).

Before:

```md
- The tray exposes clear **Tell work-fold**, **Show**, and **Quit** actions and does not strand an invisible process.
```

After:

```md
- The tray exposes clear **Your fold**, **Show**, and **Quit** actions and does not strand an invisible process.
```

**U-2 — Popover item** (*naming*).

Before (opening clause only; the remainder of the bullet is unchanged):

```md
- Both platforms carry the management popover (**Tell work-fold**): a macOS menu-bar item where left click opens the popover,
```

After:

```md
- Both platforms carry the management popover (**Your fold**): a macOS menu-bar item where left click opens the popover,
```

**U-3 — Decision and glance surfaces** (*consecrations*; *glance*). Insert at
the end of the "Management layer and CLI" section, after the installer-PATH
bullet:

```md
- Pending needs-you decisions render as host-composed cards in the popover, an anchored main-window flyout, and the approved remote client; deciding one is never available from the CLI, and a card exists only for a real staged act. The glance renders at the popover's top, the remote home, and a compact main-window panel. None of these adds a rail destination, tab, in-window badge, or notification — the one exception is the optional menu-bar/tray attention dot for pending decisions, which ships only if the visual-acceptance pass admits it (see visual-design); with nothing pending, no control appears.
```

### docs/visual-design.md

**V-1 — Conditional fold surfaces** (*consecrations*; *glance*). Insert at
the end of "Information hierarchy":

Anchor (unchanged):

```md
- The persistent header above the left pane identifies the selected root folder. Its compact menu switches, creates, registers, or manages Spaces; the selected rail item identifies the current surface.
```

Insert after the anchor:

```md
- A conditional **Needs you** indicator may join the bottom-rail cluster only while staged decisions pend, opening an anchored flyout of host-composed cards; the glance opens as a compact panel from the Space-identity header region. Neither is a rail destination, tab, permanent badge, or notification stream, and both disappear entirely when they have nothing to show.
```

**V-2 — Tray attention dot** (*consecrations*; ships only after visual
acceptance). Insert after V-1's bullet:

```md
- The menu-bar/tray icon may carry one small attention dot while decisions pend — machine-local acknowledgement state in the same family as the background-turn marker. It is subject to the visual-acceptance pass like any other quiet indicator and ships only if that pass accepts it.
```

## Test and verification impact

### Existing suites

Grouped by the lanes `AGENTS.md` names for management-layer changes. "Guard"
means the suite grows a negative assertion that a boundary did not move.

| Lane | Suite | Grows because |
|---|---|---|
| Kernel | `tests/work-fold-kernel.test.ts` | `getGlance` query and actor normalization; experimental `routing_run` task kind excluded from stable v1 projections; restore-fencing queries; decision executions registering fenced kernel tasks |
| Adapter | `tests/work-fold-cli-adapter.test.ts` | Guard: no staged-act, glance, routing, or publication data enters the content-free read projection |
| Protocol (read) | `tests/work-fold-cli-protocol.test.ts` | Help topics for the new families; read lane otherwise unchanged |
| Act protocol | `tests/work-fold-cli-act-protocol.test.ts` | Argv parsing for every new family; parse-time never-list refusal; consecrated verbs returning `staged`; `manage glance`; guard: envelope stays protocol version 2 |
| Act receipts | `tests/work-fold-cli-act-receipts.test.ts` | Receipt v2 fields (`surface`, `decisionId`, `policyId`, `undoRef`); version-tolerant readers; rotation properties unchanged |
| Act token | `tests/work-fold-cli-act-token.test.ts` | Unchanged — no thread alters token semantics; the suite is the regression floor |
| Act facade | `tests/work-fold-act-facade.test.ts` | Every new facade family; guard: decision and policy internals absent from the facade surface |
| Broker | `tests/work-fold-cli-broker.test.ts` | Unchanged — the broker is deliberately untouched by the whole set |
| Desktop host | `tests/desktop-work-fold-cli-host.test.ts` | Dispatch for every new family; app-not-running exit 6 unchanged |
| Packaging | `tests/desktop-cli-packaging.test.ts` | Shim usage text learns the new families; no new shim-side wait verbs |
| Domain services | `tests/local-server.test.ts`, `tests/local-space.test.ts`, `tests/local-chat-store.test.ts`, `tests/chat-lifecycle.test.ts`, `tests/local-history-content-addressed.test.ts`, `tests/local-search.test.ts`, `tests/work-fold-appearance.test.ts`, `tests/restricted-app-service.test.ts`, `tests/local-app-release-store.test.ts`, `tests/app-instance-update.test.ts`, `tests/work-fold-checks-service.test.ts` | Facade families reuse exact route internals; staged-act cascades on Space removal and app uninstall; settle-signal publication ordering and failure isolation; App Studio verb coverage |
| Automation scheduler | `tests/work-fold-automation-service.test.ts` | Only if the shared class needs a new seam for the routing executor's separate instance; none is currently expected |
| Management | `tests/management-requests.test.ts`, `tests/management-turn-context.test.ts`, `tests/work-fold-management-api.test.ts`, `tests/work-fold-management-conversation.test.ts`, `tests/management-popover-refresh.test.ts` | Staging actions joining the request trail; surface attribution; glance and decision routes (decision routes renderer-only, glance served without management readiness); marker monotonicity; instruction teaching for new verbs, staging etiquette, narration, and the identity line that keeps the phrase "management conversation" |
| Remote | `tests/desktop-remote-access.test.ts` | `decisions.*` and `management.glance*` dispatch; revocation canceling in-flight decisions, purging markers, and canceling staged acts by provenance; `viewer.fetch` recheck-before-serve; revocation ordering with `bridgeCleanup: pending`; the 64 KB glance bound; offline behavior |
| Renderer contracts | `tests/web-ui-contract.test.ts`, `tests/frontend-interaction-contract.test.ts`, `tests/web-design-system.test.ts`, `tests/macos-renderer-adaptation.test.ts`, `tests/onboarding-welcome.test.ts`, `tests/work-fold-brand.test.ts` | Needs-you flyout and glance panel with no new rail destination; Settings sections; naming-sweep string pins moving (`Tell work-fold` popover title and tray label become `Your fold`; the two-state send button) |
| Documentation | `tests/documentation-contract.test.ts` | Stays green across every amendment application; may grow fold-claim assertions at promotion (for example, that canonical docs keep routing agency-on-cadence and never-list wording) |
| Bridge | `services/bridge/server.test.mjs`, `services/bridge/database-security.test.mjs`, `services/bridge/metrics.test.mjs` (run with the bridge package's own `npm test`) | Operation-allowlist additions; reserved `pages`/`pages-` slugs; `bridge_publications`/`bridge_publication_snapshots` idempotence, cascade deletion, and snapshot bounds; viewer-plane states and rate limits; guard in `database-security`: no new persisted content classes; metrics counters stay identifier-free |
| Real-Electron probe | `npm run desktop:restricted-app:smoke` (inside `npm run desktop:prepare`) | Grows rung-3 viewer-scope denial cases — actions, egress, connections, Space files, storage writes — and stays release-gating |

### New suites

| Suite | Covers |
|---|---|
| `tests/fold-staged-acts.test.ts` | Store admission, dedupe, pending cap, lazy expiry, invalidation, cascades, fail-closed normalization |
| `tests/fold-decisions.test.ts` | Eligibility precheck without consumption, surface rules (no self-approval from the staging grant; Personal-scope make-runnable desktop-only), pin recheck, atomic journal-first consumption, concurrent-decide refusal (desktop plus remote, two remote), interrupted-at-startup recovery, decision-replay refusal |
| `tests/fold-policies.test.ts` | Matcher evaluation, ineligible-kind refusal (destroy, `publish.viewer.expose`, `routing.enable`), open-registry matcher refusal, attestation digest fail-closed, exercised receipts, Settings-only authoring |
| `tests/work-fold-glance.test.ts` | Byte-identical determinism, ordering, caps, truncation flags, restart honesty, unavailable sources |
| `tests/work-fold-glance-seen-store.test.ts` | Monotonic advance, replay no-ops, damaged-store over-reporting, grant purge |
| `tests/work-fold-routing-settle-signal.test.ts` | Typed settle records, lineage, publication after durable persistence, failure isolation |
| `tests/work-fold-routing-declarations.test.ts` | Closed typed parse, digest, bounds, forbidden content, tree-selector reuse |
| `tests/work-fold-routing-store.test.ts` | Grants, cadence anchors, health states, journal-first run receipts |
| `tests/work-fold-routing-service.test.ts` | Trigger admission, hop execution, stop/disable/suspension, interrupted recovery, approval/denial/expiry wiring |
| `tests/work-fold-publications.test.ts` | Grant records, source binding and identity checks, bounded rendering, effect-time recheck, Space-removal block |
| A static copy test beside `services/bridge/server.test.mjs` | Pins the remote client's fold vocabulary so bridge copy cannot drift from the desktop sweep |

### Verification lanes

Per `AGENTS.md`, unchanged by this design: `npm run check` after TypeScript
changes and `npm test` before handing off behavior changes, on every build
item; `npm run desktop:prepare` for anything touching Electron (tray, popover
host, remote-access dispatch, settings); the bridge package's own `npm test`
for bridge items, which deploy separately from desktop release lanes;
`npm run desktop:package:smoke` when shim usage text or packaged assets
change; the Mac lanes only for release candidates. No new lane is invented.

## Implementation plan

One topological ordering across all six sibling plans. Items are work items,
not phases; anything without an unmet "needs" may proceed in parallel, and
the six entry items (1–8 below) can all start at once. Sibling plan items are
cited as, for example, "(ledger 3)" so the detailed file lists stay in one
place. Every item lands green on `npm run check` and `npm test` plus its
lane-specific verification above.

1. **Receipts v2 and the shared vocabularies** (ledger 1; consecrations
   receipt fields). `src/local/cli/act-receipts.ts` gains `surface`,
   `decisionId`, `policyId`, `undoRef` with version-tolerant reading. This
   item implements reconciliations 1 and 2, already decided in this set
   (`decisionId`; the five-value surface vocabulary). Needs:
   nothing. Suite: `tests/work-fold-cli-act-receipts.test.ts`.
2. **Direct-verb argv and command table** (ledger 2). New families in
   `src/local/cli/act-commands.ts`, including parse-time never-list refusal;
   envelope untouched. Needs: 1.
3. **Staged-act store** (consecrations 1). `src/local/fold-staged-acts.ts`.
   Needs: nothing; parallel with 2.
4. **Settle-signal seam** (routings 1). Owner of reconciliation 8. Needs:
   nothing.
5. **Routing declarations** (routings 2). Needs: nothing.
6. **Glance composer and seen store** (glance 1–2). Typed readers for
   staged acts, routings, and publications land now; they render absent until
   items 3, 15, and 21 exist. Needs: nothing.
7. **Bridge viewer namespace and publication schema** (publishing 1).
   Reserved slugs and tables; deploys bridge-side ahead of any desktop use,
   per reconciliation 7. Needs: nothing.
8. **Naming-sweep code items** (fold plan 1–6): popover strings and
   two-state send button, tray entry, onboarding, Settings and desktop error
   strings, bridge client strings with the new copy test, the
   management-instructions identity line. Needs: nothing; promotion of R-1,
   U-1, U-2, ML-1, PM-4 waits for these to ship together — half a vocabulary
   is worse than none.
9. **Facade growth for direct verbs** (ledger 3), one domain family at a
   time, parallelizable per family. Needs: 2.
10. **History-restore fencing and `chat compact`** (ledger 4). Needs: 9's
    History and Chat families.
11. **Decision path and per-kind execution** (consecrations 2). Needs: 1, 3.
12. **Staging verbs and `staged list|show|cancel`** (consecrations 3;
    ledger 5). Consecrated rows begin returning `staged` results. Needs: 2,
    11.
13. **Desktop decision surfaces** (consecrations 4–5): local-API decision
    routes excluded from the act facade, popover card stack, main-window
    flyout. Needs: 11.
14. **Remote operations, wave one** (consecrations 6): `decisions.list`/
    `decisions.decide` across the three files of reconciliation 7,
    bridge-first. Needs: 11, 13 (the card contract).
15. **Routing store and executor** (routings 3–4), then **Space-removal
    revocation** (routings 5). Needs: 4, 5.
16. **Standing policies** (consecrations 7). Needs: 11.
17. **Cascade coverage** (consecrations 8): Space removal, app uninstall, and
    browser revocation canceling dependent staged acts and voiding unexecuted
    decisions. Needs: 3, 14.
18. **Routing act verbs and consecration wiring** (routings 6–7). Routing
    enablement stages into the shared decision machinery. Needs: 2, 12, 15.
19. **Glance kernel query, API routes, and CLI command** (glance 3–5).
    Needs: 6; the CLI command also needs 2's conventions.
20. **Glance surfaces** (glance 7, 9) and **remote operations, wave two**
    (glance 8): popover section, main-window panel,
    `management.glance`/`management.glanceSeen` bridge-first. Needs: 19; the
    remote wave may ride with 14 when timing allows.
21. **Desktop publication service and serving** (publishing 3), then
    **viewer plane at the bridge** (publishing 2). Needs: 7; the two proceed
    in parallel once the frame contract from 7 is fixed.
22. **Publishing act verbs and the exposure consecration** (publishing 4).
    Fills the `publish.viewer.expose` pins per reconciliation 3. Needs: 12,
    21.
23. **Publishing desktop surfaces and the snapshot lane** (publishing 5–6).
    Needs: 13, 21, 22.
24. **Surface attribution, shims, and help** (ledger 6–8). Shim usage and
    help text land after every family that ships is parseable. Needs: 9;
    final pass after 12, 18, 22.
25. **Management-instructions teaching** (ledger 9; routings 8; glance 6;
    consecrations staging etiquette). May land incrementally with each verb
    wave; the consolidated pass follows 12, 18, 19, and 22. Suite:
    `tests/work-fold-management-conversation.test.ts`.
26. **Rung 3: an app at your address** (publishing 7). Deliberately last
    among code items — every rung-3 problem contains a rung-2 problem, and
    the probe gains its viewer-scope denial cases here. Needs: 22, 23 burned
    in.
27. **Canonical promotion, per thread** — apply this document's blocks for
    each thread as it ships (gates in the checklist below), refresh README
    collateral only once builds show the new strings, shrink the sibling
    documents per their headers, and keep
    `tests/documentation-contract.test.ts` green. Needs: the owning thread's
    items.

## Risk register

| # | Risk | Why it matters | Mitigation |
|---|---|---|---|
| 1 | A steered fold bypasses the product's lanes entirely (writes into Pi directories, edits machine-local stores) — no staged act, no card, no receipt | The consecration gate binds the lanes, and the management Assistant is full-trust and taught, not caged | Stated honestly and repeatedly ([consecrations](fold-consecrations.md) threat model, SECURITY S-2); the gate still guarantees the lanes cannot be steered into a consecration, cards never lie, and lane acts always have receipts; an enforced tool-restricted agent remains a separate deliberate design, never a silent patch |
| 2 | Receipt and vocabulary drift across four threads landing in parallel | Two spellings of one field would make the ledger unreadable and the compensating controls unreliable | Build item 1 owns the schema and implements the two already-decided vocabularies (reconciliations 1–2) before any dependent lands; version-tolerant readers; the sibling docs record the decision |
| 3 | Remote allowlist skew between desktop and separately deployed bridge | A desktop dispatching an operation the bridge rejects fails a shipped surface | Reconciliation 7: bridge-first landings per wave; unknown typed frames stay ignored for forward compatibility; `tests/desktop-remote-access.test.ts` and the bridge suite cover both sides of each wave |
| 4 | Consecration fatigue — a person rubber-stamps cards and reconstructs the pre-gate world | The click's meaning is the product's definition of authorization | Dedupe plus the 32-act pending cap, denial memory on restaged acts, no batch approval anywhere, standing policies to keep clicks rare, and a dogfooding pass on card volume before promotion |
| 5 | A cross-Space leak regression — routing or glance content reaching a portable Space transcript | `.work-fold/conversations/` travels; a leak is permanent | Structural rules (fixed reviewed messages only, machine-local stores, glance never enters Space chats); suites assert nothing routing-shaped lands under `.work-fold/`; the provenance-marker open question in [routings](fold-routings.md) is decided before ship |
| 6 | Viewer origin or key isolation failure | The management origin's cookie and browser keys must be unreachable from published content | `pages`/`pages-` reservation with a fail-closed collision path, a viewer origin that sets no cookies and writes no storage, opaque-origin iframes for rung 3, and the residual first-load-web risk documented rather than waved away |
| 7 | Unauthenticated viewer traffic abuses the single-replica bridge | Publishing must not degrade the management plane it shares a process with | The bounds table in [publishing](fold-publishing.md) (per-IP, per-publication, per-account, and global ciphertext budgets), typed `resting` states, aggregate identifier-free metrics, and every number flagged as an owner-tunable constant |
| 8 | Concurrency regressions from new verbs racing turns, compactions, Check runs, or capability mutations | The desktop's conflict rules are the product's correctness story | Facade families reuse the exact route internals and their 409s; restore-while-active is refused rather than confirmed; decision executions are fenced kernel tasks; per-family suites grow with each item |
| 9 | A half-shipped naming sweep leaves the product naming one thing two ways | That is the exact defect the naming thread exists to fix | The sweep's six code items ship as one reviewed unit (build item 8); string pins in the brand, onboarding, and new bridge copy tests; README and canonical promotion land last |
| 10 | Claim drift during a long effort — docs describing behavior that has not shipped, or shipped behavior undocumented | `AGENTS.md` requires README and docs to track shipped behavior | Per-thread amendment gates in the checklist below; the roadmap's accepted-direction wording for pre-ship promotion; `tests/documentation-contract.test.ts` on every application; sibling documents shrink at promotion so stale design prose cannot masquerade as the register |

## Promotion checklist

Each row names the proposal material, the canonical documents it amends, the
amendment blocks above, and the gate that must be green before applying. "The
owning items" refers to the implementation-plan numbering above.

| Proposal section | Canonical target(s) | Blocks | Gate |
|---|---|---|---|
| [fold.md](fold.md) §Decision register (F1–F13) | product-model rails and nouns; AGENTS rails | PM-1 (fold row), PM-3, PM-6, AG-4 | Owner acceptance; roadmap wording marks direction until the owning threads ship |
| [fold.md](fold.md) §Naming and copy | README, ui-parity, product-model, management-layer | R-1, U-1, U-2, PM-4, ML-1 | Items 8 complete together; brand/onboarding/bridge copy tests green |
| [fold-act-ledger.md](fold-act-ledger.md) — verb tables, receipt schema, conflict rules | management-layer, product-model, AGENTS, README, SECURITY, PRIVACY, space-customization (obligation under promotion mechanics) | ML-2, PM-5, AG-2, R-2, S-1, P-3, plus the space-customization/AGENTS appearance sentences recorded under promotion mechanics | Items 1, 2, 9, 10, 24 green |
| [fold-consecrations.md](fold-consecrations.md) — staged acts, decisions, policies, never-list | product-model, AGENTS, management-layer, README, SECURITY, PRIVACY, ui-parity, visual-design | PM-2 (first three rows), PM-3 (rails 9–10), AG-3, ML-2, ML-3, ML-4, R-3, S-2, P-1, P-4, U-3, V-1, V-2 | Items 3, 11–14, 16, 17 green; V-2 additionally passes visual acceptance |
| [fold-routings.md](fold-routings.md) — declarations, executor, lifecycle | product-model, AGENTS, management-layer, README, SECURITY, PRIVACY | PM-1 (Routing row), PM-2 (routing rows), PM-3 (rail 11), AG-4, ML-5, R-4, S-3, P-1, P-4 | Items 4, 5, 15, 18 green; transcript provenance decided 2026-08-10 (ordinary user-role message, F14) |
| [fold-glance.md](fold-glance.md) — digest, markers, surfaces | management-layer, README, SECURITY, PRIVACY, ui-parity | ML-4, ML-5, R-3, P-1, U-3, plus the one-word "glance" insertions into S-1's and P-3's amended sentences | Items 6, 19, 20 green |
| [fold-publishing.md](fold-publishing.md) — viewer, rungs, bridge changes | product-model, management-layer, README, SECURITY, PRIVACY | PM-1 (Viewer row), PM-2 (page rows), ML-4, ML-5, R-5, S-4, P-2, P-4 | Items 7, 21–23 green; rung-3 claims wait for item 26 |
| Whole set at completion | README documentation map; AGENTS required reading; every sibling shrinks per its header | R-6, AG-1 | All owning threads shipped; `npm test` green including `tests/documentation-contract.test.ts` |

One promotion mechanic was decided at review; one remains scoped here:

- **Where the fold's register lives — decided** (owner decision, 2026-08-10,
  F16 in [the fold](fold.md)): the Checks precedent. [fold.md](fold.md)
  shrinks into a compact fold decision register (as `checks.md` is for
  Checks) and AGENTS.md's required reading names it (AG-1), while
  product-model and management-layer absorb the rails, nouns, and contract
  text.
- **Documents outside the requested eight.** Rung 3's viewer-readable
  declaration field changes the reviewed manifest, which obligates
  [Restricted app authoring](restricted-app-authoring.md) and
  [Restricted app runtime](restricted-app-runtime.md) amendments, and the
  glance/decision route additions may warrant one sentence in
  [Architecture](architecture.md)'s surface inventory. Exact blocks are
  deliberately not drafted here because the manifest field's final shape is
  fixed at implementation (item 26); this checklist carries the obligation so
  it cannot be lost. The ledger thread carries one more:
  `spaces appearance apply` adds a second, journaled, undo-carrying
  application path beside the inert import that
  [Space customization](space-customization.md) and the `AGENTS.md`
  appearance bullet describe as the only one ("It never applies a mutation;
  the person imports the typed file in Customize Space"). At the ledger's
  promotion, both texts gain a sentence keeping the npm-script primitive
  inert and import-only while acknowledging the separate receipted act-lane
  apply path — otherwise the boundary text goes stale exactly as risk 10
  warns.

## Deliberately not in this design

- **No mutation, verb, store, surface, or protocol of its own.** Every
  mechanism is designed in exactly one sibling; this document indexes,
  reconciles, quotes, orders, and gates. If a future change needs a new
  mechanism, it belongs in the owning sibling (or the register it shrinks
  into), not here.
- **No automated application of amendment blocks.** The blocks are proposals
  a person applies after owner review, anchor by anchor, with `npm test`
  after each file. A script that rewrites canonical registers would be
  exactly the kind of quiet authority this product refuses.
- **No roadmap rewrite beyond the quoted blocks.** Roadmap bullets are
  refreshed at each ship per the product model's own rule ("update this
  section when a capability moves between layers"); pre-writing shipped-tense
  roadmap text for unshipped work would violate the same rule this document
  exists to respect.
- **No renamed identifiers, tests, or contract terms.** Decision F12 holds
  everywhere: `work-fold manage …`, scope ids, routes, provenance values,
  page ids, storage roots, and "management conversation" as contract text
  survive every block above; the amendments change user-facing sentences and
  add contract text, never respell it.
- **No governance change.** Product model, AGENTS, management-layer, README,
  SECURITY, PRIVACY, ui-parity, and visual-design remain the registers this
  document amends; fold-integration.md never becomes a register itself and
  shrinks to nothing once its blocks are applied or rejected.
- **No amendment blocks for checks.md, assistant-capabilities.md, or the
  restricted-app documents.** The fold consumes their contracts without
  changing them — the Check target resolver is reused tighten-only, Check
  epistemics carry into the glance unchanged, and the restricted-app lane's
  authority model is untouched until rung 3's manifest field, whose
  documentation obligation is recorded in the checklist above rather than
  drafted prematurely.
- **No new verification lanes.** The existing ladder — `npm run check`,
  `npm test`, `desktop:prepare`, the bridge package's `npm test`, the
  packaged smokes, and the release-gating real-Electron probe — already
  covers every surface this set touches; inventing a fold-specific lane would
  fragment the discipline `AGENTS.md` standardizes.
