# Fold consecrations

**Status: shipped contract reference.** The consecration machinery shipped
with the fold build — `src/local/fold-staged-acts.ts`,
`src/local/fold-decisions.ts`, `src/local/fold-decision-cards.ts`, and
`src/local/fold-policies.ts` with their suites are the implementation
authority — and its decisions were promoted on 2026-08-11 into
[the fold](fold.md) decision register (F5–F7), [Product model](product-model.md)
(rails 9–10, the staged/decide/policy context rows), `AGENTS.md`,
[the management layer](management-layer.md) (ML-2 receipt fields, the
staged-decisions bullet, the remote-operation paragraph), `README.md`,
`SECURITY.md`, `PRIVACY.md`, [Desktop parity](ui-parity.md), and
[the visual system](visual-design.md). This document retains what canon does
not carry: the closed kind vocabulary and pins, the decision path's exact
rules, the card contract, the policy matcher rules, the never-list's
reasoning, and the threat model. The promotion record is
[Fold integration](fold-integration.md).

The one-sentence architecture: **the fold stages; a person consecrates.**
The click is the product's definition of authorization for three verb
families — make bytes runnable, widen a standing power, destroy irreversibly.
It exists because the fold reads untrusted content — attachments, links,
Space files, delegated transcripts — and hidden instructions can steer a
full-trust Assistant. The click is the one signal content cannot synthesize.

"Consecration" and "staged act" are contract terms, like `sensor` and
`admission` in [Checks](checks.md). Person-facing copy says **Needs you**
and describes the act in plain words; it never says "consecration." Copy is
owned by [The fold](fold.md).

## The three consecrations

| Category | Acts in it | Why a click |
|---|---|---|
| **Make bytes runnable** | Approving a restricted-app review (initial or update); installing or updating a Pi package or Extension; importing an executable skill bundle | Runnable bytes outlive the conversation and act with the person's full local authority |
| **Widen a power** | Any restricted-app grant (network destination, file root, notification category); saving an app connection; enabling a named automation; enabling a [routing](fold-routings.md); creating outward viewer exposure ([Publishing](fold-publishing.md): every new exposure is this consecration) | Standing powers execute later, while nobody is watching |
| **Destroy irreversibly** | Deleting a managed Space's folder; purging retained app data; clearing an installed app's live storage; deleting content where no restore path exists | There is no undo to fall back on |

Working card copy for the categories — final wording in [The fold](fold.md):
"Installs code that can run as you," "Grants a standing power," "Deletes
something for good."

Scope boundaries that are decisions, not gaps:

- Direct verbs stay direct — the [act ledger](fold-act-ledger.md) classifies
  every verb, and enabling a Check stays direct because manual-run
  capability is not standing behavior.
- There are exactly two tiers plus the never-list. A general "co-sign
  everything big" middle tier was considered and rejected; blast radius is
  expressed by category membership, not by a sliding scale.
- A desktop human using the existing ceremonies — the Assistant tools
  review, grant, connection, and automation controls, or the
  managed-deletion warning — is already the click. Those ceremonies are not
  rerouted through staged acts and deliberately gain no act-journal
  receipts: they keep their existing durable domain records, and the fold's
  receipts journal records the fold's acts and decisions, not every desktop
  click. Staged acts exist for acts initiated where no human hand is
  present: fold conversations and shell-capable agents on the act lane.

## Staged acts

### The record

A staged act generalizes the shipped restricted-app proposal pattern: the
model supplies minimal typed input, and work-fold inspects, owns every
review field, and pins the exact identities that execution will verify. The
record shape lives in `src/local/fold-staged-acts.ts` (schema-versioned;
single-use id; category, closed kind, typed parameters and pins; provenance
carrying the staging surface, conversation, `parentTaskId`, request id, and
— for remotely staged acts — browser and grant ids; state and decision
record). Rules the record keeps:

- **The card is host-composed.** Every line a person reads before clicking
  is rendered by app code from the typed parameters and pins. The fold's
  reasoning lives in its transcript, reachable through the card's
  provenance link. Model prose never becomes card copy; a persuasive
  paragraph cannot dress up a destructive act.
- **No secrets, ever.** A staged act may not contain credentials, tokens, or
  connection secrets. `app.connection.save` stages only the connection's
  shape; approval opens the existing host connection flow scoped to the
  pinned declaration, and the secret is entered only there.
- **Nothing in content can create one.** Staged acts enter the store only
  through the journaled staging path. Nothing read from a Space folder, an
  attachment, a link, or a transcript can create, modify, or decide a
  staged act. Staged acts are not portable files; a file claiming to be one
  is inert bytes.
- **Bounded and deduplicated.** An identical pending act (same kind, same
  pins) returns the existing record instead of a second card. At most 32
  acts may be pending machine-wide; staging past the cap fails with an
  honest error naming the pending cards.

Storage: `fold/staged-acts.json` under the work-fold state root — never
portable, never inside a Space folder — with the proposal-registry
disciplines (schema-versioned, fail-closed normalization, atomic writes,
serialized mutations, bounded terminal retention). Decision receipts ride
the same act-receipts journal as every fold act. Staged acts survive app
restarts; nothing about one executes while the app is closed.

### States and lifetime

`staged` → decided (`approved` with execution outcome
`executed`/`failed`/`interrupted`, or `denied`), or `expired`, `canceled`
(stager withdrawal, or cascade: Space removal, app uninstall or review
supersession, browser revocation of the staging grant), or `invalidated`
(a pinned identity no longer matches). Lifetime rules:

- The TTL is **24 hours** from staging (shared dial, reconciliation 5 in
  [Fold integration](fold-integration.md)). Expiry is lazy — computed at
  read and decision time; no watcher or timer exists. An expired act can
  never be approved, even from a stale card.
- **Expiry is not approval, and it is not denial.** It is its own recorded
  outcome; the fold may restage on a fresh request.
- **Denial is terminal for the record.** Restaging with matching kind and
  pins is allowed, but the new card states the prior denial and when it
  happened, so quiet nagging is visible for what it is.
- `approved` is the point of no return: approval is consumed in the same
  journaled step that authorizes execution, and a staged act is decided at
  most once.

### Pins by kind

The kind vocabulary is closed; the store rejects unknown kinds, so adding
one is a deliberate contract change reviewed against the never-list.

| Kind | Category | Staging prepares | Pinned identities | Executes through |
|---|---|---|---|---|
| `app.review.approve` | Make runnable | One pending restricted-app review, initial or update | Proposal id and review digest | The digest-checked install path desktop approval uses; a changed source is `invalidated` |
| `capability.package.install`, `capability.package.update` | Make runnable | One Pi package or Extension at Personal or This Space scope | Package id, exact version, registry source, scope, and the inspected resource summary the card shows | The existing capability mutation path, under capability-mutation locks |
| `capability.skills.import` | Make runnable | One executable skill bundle import | Bundle source, content digest, enumerated skill names | The existing import path (`src/local/agent/skill-import.ts`) |
| `app.grant.network`, `app.grant.files`, `app.grant.notifications` | Widen a power | One exact reviewed declaration for one installed app | App Instance id, declaration identity, installed release digest | The same grant path Assistant tools uses |
| `app.connection.save` | Widen a power | The connection's shape only — never a secret | Instance, declaration, target, adapter kind | Approval opens the host connection flow scoped to the pinned declaration |
| `app.automation.enable` | Widen a power | One reviewed named job | Instance, job name, reviewed digest, schedule summary | The existing enablement path inside the machine-wide scheduler bounds |
| `routing.enable` | Widen a power | One declared routing | Routing id and declaration digest | The enablement grant defined in [Routings](fold-routings.md) |
| `publish.viewer.expose` | Widen a power | One outward viewer exposure | Page slot: Space id, exact relative path, title, budgets, snapshot flag. Hosted app: App Instance id, exact Release digest, viewer entry, complete viewer-readable surface. Widenings (rebind, raised budgets, snapshot on, widened viewer surface) pin old and new bindings | The activation and hosted-exposure paths in [Publishing](fold-publishing.md) |
| `space.delete-folder` | Destroy | Managed deletion of one Space's folder | Space id and canonical root | The managed removal path in `src/local/space.ts`; the `.workspace/` fail-closed rule is re-checked at execution |
| `app.data.purge` | Destroy | Purge of retained app data | Instance and Data Namespace ids | The existing purge path with its durable cleanup outbox |
| `app.storage.clear` | Destroy | Clearing one installed app's live storage | App Instance id, Data Namespace ids, observed byte count | The same storage-clear path App details uses; the byte count is re-observed at decision time and shown on the card |
| `files.destroy` | Destroy | A deletion the restore-point machinery cannot cover | Exact Space-relative paths and observed content identities | A host deletion path that re-verifies identity first; it exists only because the ledger's `files delete` refuses when no restore path can be recorded |

### Journal, decision, and execution

Staging is an act-lane mutation and inherits every existing property:
explicit `--space` where applicable, `--parent-task` lineage, the per-launch
act token, broker freshness, journal-first at-most-once receipts, and
membership in the management request's recorded action trail.

Deciding is **not** an act-lane verb. There is no CLI approval, no local-API
route reachable with the act token, and no remote operation a desktop-side
model call can invoke. The decision path exists in exactly two places: the
desktop renderer surfaces (popover and main window, over the renderer
session) and the approved remote browser (over its signed envelope). The act
facade never exposes decision or policy-mutation internals — that exclusion
is the enforcement of "the click is not a command."

The decision path runs host-side, in order:

1. **Eligibility precheck** — the same checks the equivalent desktop
   ceremony performs (capability-mutation locks, Space registration state,
   app lifecycle state) plus the two surface rules under
   [The remote client](#the-remote-client): no self-approval from the
   staging grant, and Personal-scope make-runnable is desktop-only. An
   ineligible act refuses the decision *without consuming it*.
2. **Pin recheck** — every pinned identity is re-verified against current
   state. A mismatch transitions the act to `invalidated`, the card
   explains, and nothing executes.
3. **Atomic journal-first consumption** — the staged→approved transition is
   an atomic check-and-set inside the store's serialized critical section,
   with the `accepted` receipt appended under a deterministic decision
   request id derived from the staged-act id. This is the primary
   at-most-once gate: of two concurrent decides, exactly one consumes the
   act and the other is refused with the settled outcome.
4. **Execution** — the underlying mutation runs through the same domain
   service as the equivalent desktop action, as a fenced internal kernel
   task, followed by the terminal `ok`/`error` receipt.

Failure answers, inherited by every kind: a failed execution leaves the act
`approved` with outcome `failed`, never auto-retried — another attempt means
restaging and a fresh click. A crash leaves the honest `accepted`-without-
terminal signal; startup marks the execution `interrupted` and never replays
it. Replay is prevented by the single-use act id, the atomic check-and-set,
the journal's deterministic decision request id as durable backstop, and —
for remote decisions — the remote lane's grant-scoped signed request ids.
Decision records are append-only and are not undone; *effects* revoke
through the same product paths as the equivalent desktop act, and destroys
do not undo — which is why they are consecrated.

## The needs-you surface

### The card

One card per pending staged act, rendered from typed fields by app code on
every surface (`src/local/fold-decision-cards.ts` — one card contract,
reconciliation 6):

- The plain-words category line and the act title, host-composed. For
  make-runnable kinds the scope is part of the category line, and Personal
  scope is named for what it is: code that loads into the fold's own
  runtime.
- The exact facts the pins hold: Space names, app and declaration
  identities, package id and version and source, digest short ids, paths.
- Provenance: which conversation staged it and when, with a link to that
  transcript; the prior outcome for identical pins when one exists ("denied
  yesterday at 14:10").
- Expiry time.
- **Approve** and **Deny**. Destroy-category cards require a second explicit
  confirmation inside the card. Deny takes one click and no reason; an
  optional note field is offered, never required.

There is no approve-all control anywhere. Each card is decided alone.

### Desktop surfaces

The popover renders a compact **Needs you** stack between the header and the
transcript, present only while at least one decision pends; decisions ride
the renderer-session `/api/management/*` route family, never the act lane.
The conversational `needs_you` request phase (a reply ending in a question)
stays a separate thing. The main window carries a conditional **Needs you**
indicator in the bottom-rail cluster opening an anchored flyout of the same
cards — not a tab (tabs are Space-bound; decisions belong to the fold above
all Spaces), not a permanent rail destination, absent entirely when nothing
pends, per [Desktop parity](ui-parity.md) and
[the visual system](visual-design.md). The optional menu-bar/tray attention
dot remains held on the visual-acceptance gate recorded in
[Fold integration](fold-integration.md).

### The remote client

Per the recorded remote-clicks decision (F5), a consecration may be approved
from the desktop or from any approved, full-trust remote browser:

- `decisions.list` and `decisions.decide` are closed remote operations over
  the existing signed envelopes; the bridge relays and persists no card
  content, and staged acts never leave the desktop — remote cards are live
  projections, served only while the desktop is online.
- Every approved browser sees the same pending cards; hiding cards from one
  of the person's own browsers would be theater.
- Two surface rules bound what a remote click can complete, enforced in the
  eligibility precheck and stated on the card. **No self-approval**: a
  staged act whose provenance records a remote browser's grant is never
  decidable from that same grant, so one compromised browser cannot both
  cause a staging and click it through. **The fold's own runtime is
  desktop-decided**: make-runnable acts at Personal scope load into the
  fold's own runtime, so their cards render read-only on the remote client
  and name the desktop as the deciding surface.

Origin-attributed decisions — the compensating controls: every decision
receipt records `surface` (the closed five-value vocabulary) and, for
remote, the exact browser, grant, and generation. Revoking a browser refuses
its in-flight `decisions.decide` before consumption, voids accepted-but-
unexecuted decision operations, and cancels pending staged acts whose
staging provenance traces to that grant — a compromised browser cannot leave
a card behind as a time bomb. A decision that already executed stands — it
was authorized when clicked — and its receipt names the browser, which is
what makes later review possible. Pin recheck, eligibility, journaling, and
execution all run desktop-side. The never-list is untouched: never-list acts
cannot be staged by anyone, so no card for them can exist on any surface.

## Standing policies

Standing policies are the friction dial: person-authored records that
pre-approve one narrow consecration category so a click is not demanded for
acts the person has deliberately decided to trust in advance. The record
shape lives in `src/local/fold-policies.ts` (one kind per policy, closed
typed per-kind matcher, `auto-approve` as the only effect). Rules:

- The matcher vocabulary is closed, typed, and per-kind; no policy can match
  on model-authored text, and no policy can be broader than its kind.
- **Make-runnable matchers pin identity, not open registries.** A
  make-runnable policy must match per-item identity (publisher and/or
  content digest) or a registry from a short host-curated first-party
  allowlist (the canonical example: skill-only imports from the Anthropic
  marketplace). A bare "any item from registry R" matcher over an arbitrary
  registry is rejected by the store — it would let an open or compromised
  registry convert content-driven staging into un-clicked installs.
- **The policy-eligible kind set is closed and smaller than the staged-act
  kind set** (reconciliation 13). The destroy category has no policy
  vocabulary; `publish.viewer.expose` has none (outward exposure's blast
  radius includes people who are not the person); `routing.enable` has none
  (whole-declaration review is the point). The store rejects ineligible
  kinds; admitting one later is its own register decision, not a schema
  tweak.
- Policies live beside the staged-act store (`fold/policies.json`) with the
  same atomic, fail-closed persistence.

Authoring is a desktop-human act: policies are created, edited, enabled,
disabled, and deleted **only** in **Settings → The fold** over
renderer-session-only routes. There is no act-lane verb, no remote
operation, and no popover control that writes a policy; the fold may
**cite** policies — list them, report when one was exercised — but never
write them, and standing-policy authoring is on the never-list so this can
never be relaxed as a convenience. The store carries a content-attestation
digest recorded on each Settings write; evaluation re-hashes the store
first, and a mismatch disables **all** policies until a person re-saves them
in Settings, with the change reported in the glance. Policies fail closed
to clicks — tamper-evidence against a quiet file edit, not tamper-proofing
against the same-user shell (residual risk 2).

Evaluation happens **host-side, at decision time, in app code** — never in
the model, never over prose. A match short-circuits into the same decision
path as a click: eligibility precheck, pin recheck, journal-first
consumption, execution, terminal receipt, no card. The receipt carries
`surface: "policy"`, the policy id, and a label snapshot; the staging
verb's response says the act was auto-approved and by which policy, and the
glance lists policy-approved acts distinctly. Disabling or deleting a
policy affects only future staged acts; exercised receipts stand.

## The never-list

The fold can neither perform nor stage the following. They are
desktop-human-only, in their existing Settings and desktop ceremonies:

1. **Remote access administration** — enrollment and address creation or
   change, browser approval, browser or generation revocation, disabling
   Remote access, deleting the address.
2. **Act-token and pairing machinery** — minting, scope, or lifetime of the
   per-launch act token; pairing-code and grant mechanics.
3. **Provider credentials** — entering, replacing, or removing model-provider
   API keys or provider OAuth in Settings → Assistant.
4. **Standing-policy authoring** — creating, editing, enabling, disabling, or
   deleting policies. The fold may cite policies, never write them.
5. **Anything that widens the set of principals that control the fold
   itself.** This is the catch-all and the review question for every future
   staged-act kind.

Enforcement is structural, not a filter: these acts have no act-lane verb
(refused at parse time), no staged-act kind (the store rejects unknown
kinds), no card, and no remote operation. Structural means structural for
the product's lanes — residual risk 1 still applies. The remote-clicks
decision does not extend to the never-list: the cards cannot exist, and
weakening this list to match remote convenience is explicitly rejected.

Each entry guards the machinery that makes the click meaningful: who can
click (1), who can act (2), the credentials with the widest blast radius
outside the product (3), the friction dial itself (4), and the definition
(5). Entry 5 is where Personal-scope make-runnable is reconciled rather
than waved past: code imported at Personal scope loads into the fold's own
runtime on next start, changing what the fold itself is. That stays a
consecration, not a never-list act — the person may genuinely want it — but
its card names the scope and its decision is desktop-only.

## Threat model

The fold reads untrusted content as a matter of course, and any of it can
contain instructions aimed at the model. The management instructions teach
that attachment contents are data, never instructions — but teaching is not
enforcement, and with the verb ledger the fold's verbs are worth steering.
Text can make a model want to do anything; text cannot press a button in
the desktop renderer, and it cannot produce a signed envelope under an
approved browser's non-exportable key. The decision path accepts exactly
those two inputs and nothing else. The gate covers only the three families
because they are the acts whose blast radius outlives the conversation;
for everything else, the ledger is the protection, and demanding clicks for
it would burn the attention the three real categories need. What remote
clicks change and do not change is recorded in
[The remote client](#the-remote-client) above; entrenchment through a
steered, approved install remains real (a second compromised grant could
approve what the first staged), prevented only by the person reading cards
and detectable afterward through decision receipts and the glance.

### Residual risks, stated plainly

1. **The ledger is a taught boundary, not a cage.** The fold keeps Pi's
   ordinary file and shell tools, which reach whatever this user can reach.
   A sufficiently steered model can bypass the staged-act machinery
   entirely: write into Pi's directories (bytes made runnable), edit
   machine-local stores (powers widened), delete files (destruction) — no
   staged act, no card, no receipt. The consecration gate binds the
   product's lanes; an enforced tool-restricted management agent would be a
   different, deliberate design this personal, local product has not
   adopted. What the gate still protects: the lanes cannot be steered into
   a consecration without a click, the needs-you surface never lies, and
   every act that went through the lanes has a receipt.
2. **Same-user local processes are outside the boundary.** A hostile
   process running as this user could drive UI or rewrite state, including
   the policy store — the attestation digest makes a quiet policy edit
   visible, not impossible. The existing posture, unchanged.
3. **The hosted origin and bridge are trusted in the alpha.** A compromised
   hosted client can click approve on an existing card — though never a
   card its own grant staged, and never a Personal-scope make-runnable
   card. An approval that executed before revocation stands, which is why
   decision receipts name the browser.
4. **Friction fatigue is real.** A person who rubber-stamps cards has
   reconstructed the pre-gate world with extra steps. The mitigations are
   structural — policies keep clicks rare, cards carry exact host-composed
   facts, the pending cap and dedupe prevent flooding, denial memory
   exposes nagging — but reading remains the person's part of the contract.
5. **The card shows facts, not intent.** A steered fold can stage an act
   whose facts are accurate and whose purpose is bad. The provenance link
   to the staging conversation exists so the person can read the why, not
   only the what. No mechanism here detects motive.
6. **A make-runnable policy trusts a registry's future.** Even restricted
   to the first-party allowlist, a registry-scoped policy auto-approves
   items that did not exist when the person authored it. The mitigations
   are the allowlist's curation, exercised-policy receipts, and the
   glance's distinct listing; the sharper mitigation — per-item digest
   pinning — is available in the same matcher vocabulary and recommended
   for anything beyond the curated marketplace.

## Mutation obligations

| Mutation | Who journals it | Receipt contains | Revocation / undo | Mid-act failure | Replay prevention |
|---|---|---|---|---|---|
| Stage a consecrated act (act lane) | Act executor: `accepted` before store admission, terminal after | Command, kind, category, Space id where applicable, staged-act id, `parentTaskId` lineage | Stager cancel, person deny, expiry; Space removal, app uninstall, and browser revocation cancel dependent acts | `accepted` without a terminal line is the honest interrupted signal; an act absent from the store was never admitted | Broker freshness plus the journal's `accepted` gate on request ids |
| Cancel a staged act (act lane) | Same journal-first path | Staged-act id and resulting state | Nothing to revoke; cancellation is terminal for the record | Same accepted/terminal pair | Same request-id gate; canceling a non-pending act is a typed refusal, not a second transition |
| Decide and execute (click) | Decision path: `accepted` after eligibility and pin recheck, before the mutation | Decision, `decisionId` (the staged-act id), kind, category, surface, browser id/grant/generation for remote, execution outcome and effect ids | Record is append-only; effects revoke through the same product paths as the equivalent desktop act; destroys do not undo | Approval consumed inside the atomic transition; failed execution is `approved`+`failed`, never auto-retried; a crash marks `interrupted` at startup and never replays | One atomic staged→approved check-and-set per act id — the primary at-most-once gate; the journal's deterministic decision request id is a durable backstop; remote decisions also ride grant-scoped signed request ids and delivery claims |
| Policy exercise (auto-approval) | Same decision path, same journal | Everything a click receipt has, with `surface: "policy"`, policy id, label snapshot | Disable or delete the policy in Settings; exercised receipts stand | Identical to a clicked decision | Identical to a clicked decision; evaluation is deterministic at admission, so one staged act exercises at most one decision |
| Policy create/edit/disable/delete (Settings, renderer lane) | The policy store, with a new attestation digest per write; the change appears in the glance's change list | Policy id, label, category, kind, matcher, enabled state, timestamps | Edit or delete in Settings; changes bind only future staged acts | Atomic single-file replace; a torn or tampered store fails closed to no auto-approvals | The only writer is the desktop Settings session; no act-lane or remote verb exists to replay |

## Implementation record

The plan items shipped as follows (suites in
[the management layer](management-layer.md)'s verification map):

1. Staged-act store and lifecycle — `src/local/fold-staged-acts.ts`; `tests/fold-staged-acts.test.ts`.
2. Decision path, receipts, and per-kind execution — `src/local/fold-decisions.ts`; `tests/fold-decisions.test.ts`, `tests/work-fold-cli-act-receipts.test.ts`.
3. Staging and inspection verbs (`staged list|show|cancel`) — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/work-fold-cli-staged-verbs.test.ts`.
4. Local-API decision routes and the popover card stack — `src/local/server.ts`, `web-local/src/popover/PopoverApp.tsx`; `tests/work-fold-management-api.test.ts`, `tests/management-popover-refresh.test.ts`.
5. Main-window Needs you flyout — `web-local/src/App.tsx`, `web-local/src/components/NeedsYouDecisions.tsx`; `tests/frontend-interaction-contract.test.ts`, `tests/web-ui-contract.test.ts`.
6. Remote decision operations — `src/local/remote-management.ts`, `desktop/src/remote-access.ts`, `services/bridge/server.mjs`; `tests/desktop-remote-access.test.ts`, `tests/work-fold-remote-management.test.ts`, the bridge suite.
7. Standing policies — `src/local/fold-policies.ts`, Settings routes; `tests/fold-policies.test.ts`, `tests/fold-policy-settings.test.ts`.
8. Cascade coverage — Space removal, app uninstall, browser revocation; `tests/local-space.test.ts`, `tests/restricted-app-service.test.ts`, `tests/desktop-remote-access.test.ts`.
9. Glance integration — pending decisions, settled outcomes, exercised policies in the digest; `tests/work-fold-glance.test.ts`.
10. Registers and verification — recorded in [Fold integration](fold-integration.md).

## Deliberately not in this design

- **No third tier.** Two tiers plus the never-list is the recorded decision;
  no "co-sign everything big" middle tier, and no per-act risk scoring.
- **No CLI or act-lane approval path — permanently.** This is a property,
  not a gap. Any future "headless approval" idea is a never-list question.
- **No destroy-category policies and no auto-deny effect.** Both would be
  new register decisions with their own analysis, not schema growth.
- **No notifications or push for needs-you items.** The surfaces are quiet
  and conditional; the glance reports on demand.
- **No batch approval.** One card, one decision, always.
- **No portable staged acts or policy sync.** Both stores are machine-local
  authority state; portability would turn files into authority.
- **No enforced tool restriction of the management conversation.** The fold
  stays full-trust and taught, per the
  [management layer](management-layer.md); changing that is a separate
  deliberate design.
- **No new caller-authentication boundary.** The act lane keeps its
  per-launch same-user posture; decisions harden what the *product* will
  execute, not who the operating-system user is.
- **No rerouting of desktop ceremonies**, per the scope note above.
- **No expansion or contraction of the never-list** beyond the five entries
  recorded here; every future staged-act kind is reviewed against entry
  five.
