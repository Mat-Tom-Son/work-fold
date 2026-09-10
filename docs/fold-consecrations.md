# Fold consecrations (superseded)

**Status: superseded 2026-09-10.** The Reviewed/Unrestricted selector, standing
policies, decision cards, the pending-decision store, remote `decisions.*`
operations, the `staged` CLI family, and `files destroy` were removed by
[Receipts, not gates](receipts-not-gates.md) (F19, F20). The formerly gated
verbs now run immediately through the same prepare, pin, journal-first,
fenced execution path and return a receipt; destruction is reversible
through History or Recently deleted.

The register rows this page once served (F5–F7, F17) stay in
[the fold](fold.md) marked as history. The full earlier text is recoverable
in git at `6830942`. This page keeps only what the record does not restate:
what the build removed, what survived and where it now lives, and the
threat-model residuals that still apply. "Consecration" survives only as a
history word; no shipped contract, copy, or test should introduce it.

## What the build removed

- The Reviewed/Unrestricted selector and its store (`src/local/fold-authority.ts`).
- Standing policies, their store, matcher vocabulary, and attestation digest
  (`src/local/fold-policies.ts`), with the Settings routes and suites.
- Decision cards and the needs-you card contract (`src/local/fold-decision-cards.ts`).
- The pending-decision store's 24-hour TTL, 32-pending cap, expiry, denial
  memory, dedupe, and cascade cancellation (`src/local/fold-decisions.ts`).
- Remote `decisions.list` and `decisions.decide`, the no-self-approval rule,
  and the Personal-scope-desktop-only rule.
- The `staged list|show|cancel` family and `help staged`.
- `files destroy` — F20 makes `files delete` always succeed; paths the safety
  checkpoint cannot cover move into Recently deleted.
- The `decisionId` and `policyId` receipt fields and the `policy` and
  `unrestricted` receipt surfaces; the act protocol version advanced and
  older receipts stay readable.

## What survived, and where it lives now

- **Prepare → pin → journal-first → fenced execute → receipt, run
  immediately.** The [act ledger](fold-act-ledger.md) calls these *prepared
  verbs*; the management layer's verification map names the module and suite.
- **Effect-time rechecks, at-most-once execution, failure without
  auto-retry, capability-mutation fences, and turn-conflict rejection.** All
  unchanged (F19's right-hand column).
- **The former kind vocabulary, mapped to the verbs that now run directly:**

  | Former kind | Verb now |
  |---|---|
  | `app.review.approve` | `apps install-proposal`, `apps install-preview` (F21: every declared power on) |
  | `capability.package.install`, `capability.package.update`, `capability.skills.import` | `tools install`, `tools update`, `tools import-skill` |
  | `app.grant.network`, `app.grant.files`, `app.grant.notifications` | `apps grant` (re-allow after a revoke; declared grants are on from install) |
  | `app.connection.save` | The ledger's connection row: the secret is entered by the person in the Apps tab, once per destination |
  | `app.automation.enable` | `apps automation enable` (re-enable after a disable; declared automations run from install) |
  | `routing.enable` | `routings enable --proposal <path>` |
  | `publish.viewer.expose` | The `pages` share verbs in [Publishing](fold-publishing.md) |
  | `space.delete-folder` | `spaces delete` — the folder moves into Recently deleted |
  | `app.data.purge`, `app.storage.clear` | `apps retained purge`, `apps storage clear` — a recovery export lands in Recently deleted first |
  | `files.destroy` | Removed; `files delete` covers every path |

- **The setup-only boundary**, now three families plus the catch-all: Remote
  access administration, act-token and pairing machinery, provider
  credentials, and anything that widens the set of principals controlling
  the fold. They establish identity or secrets; no task ever waits on them.
- **Desktop ceremonies keep their own durable domain records.** The act
  journal records acts, not every desktop click.

## Threat model, restated

The fold reads untrusted content as a matter of course and keeps Pi's
ordinary file and shell tools. Text can make a model want to do anything,
and no click stands between content and effect. The defenses are typed
admission, exact identity pins, host-side rechecks at effect time,
at-most-once execution, receipts, reversible destruction (History and
Recently deleted), revocable exposure and grants, and after-the-fact
disclosure in the glance, the receipts, and the Apps tab.

### Residual risks, stated plainly

1. **The ledger is a taught boundary, not a cage.** The fold keeps Pi's
   ordinary tools, which reach whatever this user can reach; a sufficiently
   steered model can write into Pi's directories, edit machine-local stores,
   or delete files without touching the lanes. What the lanes still give
   you: every act that went through them was typed, pinned, rechecked,
   executed at most once, receipted, and reversible.
2. **Same-user local processes are outside the boundary.** A hostile process
   running as this user could drive UI or rewrite state. The existing
   posture, unchanged.
3. **The hosted origin and bridge are trusted in the alpha.** A compromised
   hosted client can cause acts to execute through the host without a
   click. Receipts preserve the browser and grant; revocation stops future
   admission; executed effects stand, but destruction is restorable.
4. **Receipts show facts, not intent.** A steered fold can perform an act
   whose facts are accurate and whose purpose is bad. The provenance link
   to the conversation exists so the person can read the why, not only the
   what. No mechanism here detects motive.
5. **Retention is the only permanence.** A Recently-deleted entry past its
   retention window, or purged early with Delete now in Settings, is gone;
   History keeps its own capture limits.

## Deliberately not

- **No enforced tool restriction of the fold.** It stays full-trust and
  taught, per [the management layer](management-layer.md); changing that is
  a separate deliberate design.
- **No new caller-authentication boundary.** The act lane keeps its
  per-launch same-user posture.
- **No rerouting of desktop ceremonies through the act journal.**
- **No gate machinery reintroduced by convenience.** Confirmations, holds,
  approval states, or per-act risk scores are register decisions in
  [the fold](fold.md), never schema growth or a UI tweak.
