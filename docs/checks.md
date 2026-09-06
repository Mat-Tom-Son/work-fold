# Checks decision register

Checks let a person teach work-fold a small, durable expectation about files
they deliberately designate. work-fold may then verify that expectation on
request and explain current, evidence-backed problems. Checks are optional
Space behavior, not a new container, ambient scanner, generic agent loop, or
primary navigation destination.

This document records the decisions that implementation and product surfaces
must preserve. The initial contracts are experimental until real dogfooding
justifies promotion into the stable kernel and installed-CLI snapshots.

## Product boundary

- **Checks** is the person-facing noun. **Needs attention** describes an
  evidence-backed outcome. `sensor`, `candidate`, `admission`, and `finding`
  remain implementation terms.
- A Space with no configured Checks is **not configured**, never implicitly
  clear. work-fold does not enumerate, inspect, or send its files to a model.
- Every Check names bounded targets. There is no declaration meaning “the
  whole Space” and no implicit inheritance from the selected file, current
  Chat, or working directory.
- A target is either an exact Space-relative file or an explicitly selected
  directory tree with bounded recursion and declared file-type filters. Hidden
  `.work-fold/`, preserved legacy `.workspace/`, and executable `.pi/` material
  cannot be targets.
- Checks run only when a person or authenticated agent action requests a run.
  Opening the Checks work tab refreshes recorded status and re-verifies saved
  evidence, but does not run a sensor. Automatic runs require a separately enabled routing (schedule, folder-change, or settled-event trigger). Opening a tab never enables one.
- Checks do not occupy the primary rail or the Add menu. The management
  conversation and installed CLI remain agent-facing surfaces. In the desktop,
  a conditional summary at the Files edge opens one reusable Space-owned Checks
  work tab. The command palette also opens Checks before configuration, and Tell the fold what to check starts authoring; a manual proposal form is secondary. Unconfigured Spaces have no Files badge or marker.

## Expectations and authority

- Conversation and the desktop New Check form are authoring experiences. When a person expresses a
  durable expectation, an agent may create an inert typed proposal. It may not
  enable the Check itself unless the person explicitly requested the
  authenticated enable action.
- An ordinary request such as “check these files” is one-off work over the
  files named or attached in that request. It does not create standing
  behavior. Durable proposal language requires explicit intent such as “keep
  checking,” “watch this,” or a person's acceptance of a proposed Check.
- A proposal has no apply operation in the unauthenticated read lane. Importing
  or enabling it is an explicit, receipted act-lane mutation naming one Space.
- Portable declarations live below `.work-fold/checks/`. They are code-free
  data and may contain only a sensor id and revision, typed parameters, bounded
  target selectors, presentation metadata, and gate policy.
- Declarations cannot embed executable code, shell commands, model names, provider credentials, connection data, or arbitrary expressions. The built-in text-review sensor admits one explicit review rubric as its bounded `criteria` parameter. This is a reviewed content criterion, not authority to run instructions or widen targets. The host owns the system prompt, submission schema, and transport. Other executable capabilities remain Pi-owned.
- Registration discovers portable declarations but never enables them. The
  machine-local authorization store enables the exact digest of one declaration
  against the exact installed sensor revision and implementation/source digest.
  A changed declaration, sensor revision, or implementation digest returns to
  proposed/blocked state until explicitly enabled again.
- Disabling a Check stops future runs but does not destroy its audit records.
  Removing a Space revokes all machine-local Check authority for that Space.
  The durable Space-removal intent remains pending until the primary and backup
  Check state files have been deleted without parsing them; damaged or
  unsupported future state therefore cannot preserve authority or block safe
  cleanup. Backup recovery itself always strips enablement grants.
- Legacy Workspace Check kinds, sensor ids, proposal files, declarations, and
  enablement state are never imported. They are inert bytes and cannot confer
  work-fold Check identity or authority.

## Storage split

| Record | Initial location | Reason |
|---|---|---|
| Inert Check proposal | Any ordinary file chosen by the person or agent | Reviewable and transferable without authority |
| Enabled declaration | `.work-fold/checks/<check-id>.json` | Portable expectation data, never executable configuration |
| Exact-digest enablement | work-fold application state | Authority is local to the machine and installed sensor revision |
| Run records and admitted findings | work-fold application state | May contain paths, excerpts, and other private derived content |
| Decisions and invalidation history | work-fold application state | Avoids silently exporting personal triage; portability is a later explicit decision |
| Model token/cost detail and selected model id | work-fold application state | Recorded when returned by the provider; raw requests and responses are not persisted by the Check runner |

The proposal kind is `work-fold.check-proposal`, the declaration kind is
`work-fold.check`, the initial built-in sensor is `work-fold.file-presence`,
and the checked-in proposal helper uses the `.work-fold-check.json` suffix.

Portable writes and machine-local authority updates must be atomic as one
logical enable operation: a failure may leave an inert declaration, but must
never leave undeclared or digest-mismatched authority. Unsupported future
versions and damaged state fail closed.

## Sensor and target contract

- The runner owns target resolution, filesystem bounds, resource limits,
  freshness, admission, persistence, and decisions. A sensor receives only the
  files resolved for its declaration; it cannot expand scope.
- Exact file targets may name an expected file that is currently missing.
  Directory targets reject symbolic links and junctions, stay beneath the
  canonical Space root, and use explicit recursion and extension filters.
- Review and proposal surfaces show the exact primary targets, every comparison
  or reference file the sensor may read, whether membership is a fixed list or
  may include future files matching a bounded tree selector, and the trigger.
  The initial trigger is always `manual`.
- Runs have hard limits for target count, file count, individual bytes, total
  bytes, duration, and findings. Exceeding a limit is `error` or `skipped`, not
  a content problem.
- A sensor returns candidate findings through one validated shape. Native,
  packaged, model-backed, and external-agent providers all enter through the
  same admission path.
- Built-ins include deterministic file presence and bounded text review. Text review has no general tools and one schema-validated terminating submission operation; it is not a persistent Chat turn.
- The declaration determines the sensor and targets. A sensor may not use a
  model, connection, network destination, or executable capability that was
  absent from the exact revision the person enabled.

## Evidence admission

The protocol invariant is: **no independently re-verifiable evidence, no
active finding**.

- Sensors propose; the runner admits. Before persistence, the runner
  independently verifies the evidence against current files.
- Experimental snapshot version 1 admits path-state evidence and text spans with exact unique quotations, offsets, primary-file digest, and all designated input digests. Machine state version 3 reads version 1 and 2 records and preserves valid grants; future versions fail closed. Quotations are mechanically verified; model assessments remain suggestions for the person to judge.
- Evidence records the relevant input identity: canonical Space-relative path,
  content digest or missing-file state, sensor revision, and typed locator.
- A finding is re-verified before it appears in `problems`. Failed
  re-verification removes it from the active list and records it as stale,
  invalidated, or superseded in audit history.
- A decision rebinds the finding to the exact current declaration, local
  authority, sensor digest, and designated evidence immediately before the
  decision is stored. A changed target returns a typed conflict instead of
  accepting a stale resolve, reject, accept, or defer.
- Infrastructure failures, missing capabilities, unavailable providers,
  malformed submissions, exceeded limits, and admission failures are Check
  health states. They must never be presented as failures in the person's
  content.

## Findings, decisions, and freshness

- One normalized finding shape exists from the first release. It identifies
  the Check and sensor revision, severity, bounded target, typed evidence,
  input/evidence fingerprint, observation time, and optional safe remediation
  text.
- A decision is scoped to the declaration digest, sensor revision, target
  identity, and evidence/input fingerprint. Changing any of them creates a new
  observation rather than resurrecting a muted finding.
- `reject` and `resolve` suppress the exact fingerprint until its underlying
  input or sensor changes. `accept` acknowledges a real open problem and
  deduplicates it without hiding it. `defer` hides it until its explicit local
  time, even if the content has not changed.
- Freshness compares current target identities with the run inputs. It is one
  of `current`, `stale`, `never-run`, `blocked`, or `error`; an old result is
  never silently presented as current. Aggregate status reports `neverRun`
  separately from `stale`, so an enabled Check awaiting its first manual run
  is explicit even though the Space-level state remains `stale` until work is
  requested.
- Aggregate states distinguish `not-configured`, `current-clear`,
  `needs-attention`, `stale`, `blocked`, and `check-error`. Unknown is never
  rendered as healthy.

## Tasks, CLI lanes, and receipts

- Every run participates in the shared internal task lifecycle and capability
  mutation coordination, including error and abort cleanup. Check work must not
  become an invisible second background-work system.
- Experimental `check_run` tasks remain out of the stable `work-fold.tasks`
  version-1 projection. The Checks commands expose their own task status during
  dogfooding. Promotion requires an intentional kernel snapshot/version
  decision.
- `checks status --space` is a content-free read command: aggregate states,
  counts, freshness, and timestamps only. Finding titles, paths, excerpts, and
  decisions are content and do not belong in protocol v1.
- `checks run`, `checks problems`, `checks decide`, `checks enable`, and
  `checks disable` are act commands. Each names an explicit `--space`, uses the
  per-launch act token, receives at-most-once handling, and records a durable
  accepted and terminal receipt.
- The management conversation uses these same commands. It receives no ambient
  cross-Space Check store or file access beyond its existing full-trust runtime,
  and its instructions teach it to prefer the receipted CLI.
- Runs record sensor identity, input fingerprints, timings, outcome, skipped
  inputs, error state, finding/admission counts, and model token/cost data when
  applicable. Infrastructure errors remain inspectable without leaking their
  details into the content-free status lane.

## Desktop read model and interaction

- The renderer consumes the same Check service as the CLI; it does not have a
  second runner, decision store, or definition format. Renderer requests carry
  the per-launch desktop session token and pass the local API's allowed-origin
  check. This trusted-renderer API is not an extension of installed CLI
  protocol v1.
- Files first requests the content-free aggregate status. Only when that status
  contains current admitted findings does it request a bounded decoration
  projection containing exact designated Space-relative paths and counts. It
  does not request finding titles, details, or evidence for the Files tree.
- An exact file with a current finding receives one quiet attention marker. A
  containing folder may receive a smaller propagated marker so the designated
  file can be found while collapsed. Filename colour, error squiggles, green
  success badges, notifications, automatic panel opening, and layout movement
  are deliberately absent.
- Selecting the conditional summary opens one canonical `Checks` tab owned by
  that Space. The work tab may show current re-verified findings, Check health,
  bounded targets, and authority state. Its **Run Checks** action starts the
  same internal task as `work-fold checks run`; stop and decisions use the same
  abort and fingerprint-scoped decision paths.
- `never-run`, stale, blocked, infrastructure-error, current-clear, and
  needs-attention states remain visually and semantically distinct. Opening the
  tab never turns unknown into healthy and never labels a file because the
  Check machinery itself failed.
- A Space that contains proposals but no enabled Check is presented as
  proposals-only, with no result. If a later aggregate refresh fails, Files
  preserves only the last known configured summary, clears content markers,
  and labels Check status unavailable; it must not silently turn that Space
  into either unconfigured or clear.
- A failed content-bearing work-tab refresh suppresses cached health claims,
  findings, decisions, and target details until evidence can be re-verified.
  Returning focus or visibility to work-fold refreshes the relevant aggregate
  or open work tab so authenticated CLI and management actions become visible
  without a sensor run or background file watcher.

## Hardened runner invariants

- Check state is keyed by stable Space id, while every public operation also
  rebinds that id to the currently registered canonical folder. An adapter
  cannot pair one Space's authority with another folder.
- Synchronous service and server reservations cover every Check operation that
  can write, repair, or terminalize state before its first await. Space removal
  and capability mutation observe the same reservation through completion, so
  an enable, disable, run, poll, result, abort, problem re-verification, or
  decision cannot race the authority transition. Run limits are one global
  budget across all selected Checks, not a per-Check multiplier, and the abort
  signal crosses target resolution, sensor work, and evidence admission.
- Space removal acquires an exclusive Check-cleanup lease before committing its
  durable intent; any later cleanup failure returns the committed
  cleanup-pending result. Space creation and registration acquire the inverse
  registry-mutation lease and cannot overlap target validation, execution, or
  evidence re-verification. This makes nested-Space ownership changes atomic
  with respect to Check evidence access instead of relying on a timing check.
- Target enumeration is entry-, depth-, file-, per-file-byte-, and
  total-byte-bounded. Resolution rejects links, junctions, special files,
  nested registered Spaces, Windows alternate-data-stream syntax, device
  names, trailing-dot/space aliases, metadata, and Pi configuration.
- The runner owns input identities and passes sensors a closed projection with
  Space-relative paths and bounded metadata—not reopenable absolute paths.
  Text review receives immutable runner-opened snapshots with no-follow
  identity checks; additional content sensors must preserve that boundary.
- Status compares runner-owned current identities with the recorded run. It
  never invokes a sensor, provider, model, connection, or network adapter.
- Target isolation is re-applied when old findings are surfaced. If a folder
  inside a Check's target later becomes another registered Space, the parent
  Check becomes blocked and its previous evidence is neither opened nor shown.
- Any skipped designated input or candidate that fails admission makes the run
  incomplete/failed. It can never reduce the finding count into a false
  `current-clear` result.
- A terminal-state persistence failure retains the in-process task and
  capability-mutation fence while task polling from that exact Space retries
  the exact write. Polling the task id through another Space is read-only and
  cannot terminalize or release the originating task. If the process stops
  first, startup records `interrupted`; it never replays the run.

## Shipped proof and deferred work

- The shipped path covers file-presence and model-backed text review,
  fold-led proposals, isolated trials, explicit enablement, bounded target
  resolution, evidence admission, task/receipts, fingerprint-scoped decisions,
  and reviewed corrections with History and rechecks. The quiet desktop read
  model is shared with the CLI and Routing service.
- Manuscript and travel fixtures prove that the protocol is domain-neutral;
  repeated decisions in real Spaces prove that the product is useful.
- A conditional Files-toolbar summary, exact file decorations, and the
  Space-owned work tab remain a deliberately quiet layer over the engine. A
  permanent header badge, primary navigation item, background watcher, or
  proactive notification would require new precision evidence and an explicit
  product decision.
- Domain packs, gates that block other work,
  cache replay, hosted execution, and a Manuscript Lab migration are later
  layers. They must reuse this authority and admission model rather than widen
  it.


## Bounded text review (September 2026)

`work-fold.text-review` revision 1 accepts exactly `{"criteria":"..."}` (1–4096 characters). It reviews 1–16 explicitly designated UTF-8 files, at most 128 KiB each and 256 KiB total, with primary and optional reference roles. Binary files, missing designated files, unsafe paths, nested registered Spaces, and partial reads fail closed; no implicit PDF or Word extraction occurs. The fold's selected model and native provider transport are used, without the fold transcript, personal instructions in the prompt, general tools, or a tool-execution loop. This does transmit designated text to that configured provider and may incur charges. Runs serialize their model requests machine-wide, have a 120-second total budget (including queue time), at most 6,144 output tokens, no automatic provider retries, and at most 32 findings.

The model submits an exact unique quote for each primary-file finding; the host derives offsets and hashes itself. Every primary and reference input is hashed again after review, including an empty findings result. Changed files, invalid quotes, malformed or truncated submissions, timeouts, and provider failures are Check errors, never a clean result. Freshness and decision admission recheck all input digests without contacting a model. Opening or refreshing Checks performs only local re-verification. Model findings are visibly labeled suggestions: quote verification does not prove factual accuracy. Checks never edit files automatically.

The submission schema names every required field and describes the optional
plain-text suggestion. Missing suggestions must be omitted, never encoded as
null or structured edits. Invalid finding diagnostics identify the entry number,
the host-defined field, and the violated type or text bound; they never echo
returned text or unknown field names. A malformed entry rejects the entire
review, including otherwise valid entries. Output-limit and interruption errors
are distinguished from provider failures. No automatic retry, coercion, partial
admission, or raw-response logging is added. Changes to this prompt, schema, or
validation change the sensor digest and require explicit re-enablement.

Proposal review displays selected files and rubric before Try it or Turn on; enablement alone does not run the model. Existing declarations can be disabled or reviewed and re-enabled against their current digest. A routing can run an enabled Check after a folder changes; its folder trigger is a separate standing grant. A successful Check run may contain findings and is not an automatic publication gate.

## Fold-led setup and reviewed corrections

The main Checks page stays compact: names, state, findings, and actions. **Tell
the fold what to check** stages an unsent authoring draft; it never starts a
turn by itself. Manual setup is secondary. Enabled Check details are collapsed;
proposals show their rubric, exact primary/reference files, model use, and manual
cadence when reviewed. **Change with fold** prepares a separate proposal while
preserving the current declaration; turning off the old Check is explicit.

`checks propose --space <id> --proposal <path>` materializes the same inert
portable declaration without granting authority. **Try it** grants one bounded
run against the exact reviewed declaration digest. It reviews all listed targets
and references. Trial records are explicitly marked and excluded from live
findings, decisions, current/clear status, supersession, and routing settle
signals. They never create or replace an enablement grant. **Turn on** grants
manual run authority; it does not run the Check. Model trials disclose provider
use and possible charges at the action boundary.

The fold's compact Checks disclosure is a passive aggregate view with **Review**
links to the owning Space's existing Checks tab. It does not start an agent,
notify another agent, or acknowledge the glance cursor. The main-window glance
uses the same navigation. Details and evidence remain in the Space work tab.
Automatic runs still require a separately enabled Routing.

**Ask Space Assistant to help** re-verifies the selected finding and prepares an
unsent draft in a fresh Chat in that exact Space. It includes explicit finding
identifiers and source details, with instructions to treat source content as
data and to prepare a correction. This is a full-trust Space Assistant, not a new
restricted agent; its authoring instructions do not constitute a filesystem
sandbox. The reviewed correction host enforces the application boundary.
The draft points the Space Assistant to `work-fold help checks` and the exact
Space-scoped `problems` and `propose-fix` commands. CLI help includes the complete
correction JSON contract, evidence hash requirements, and the instruction to
leave the original unchanged. The Assistant need not inspect app bundles or
infer internal record formats to prepare a review.

A `work-fold.check-correction` version-1 proposal has exactly `findingId`,
`fingerprint`, `path`, `beforeHash`, and `replacement` alongside kind/version.
It covers one existing primary UTF-8 text file, at most 128 KiB, with a current
text-span finding. `checks propose-fix --space <id> --proposal <path>` validates
and stores it inertly. Reference-only edits, stale evidence, extra fields,
metadata targets, and unbounded content are rejected. Pending corrections live
in machine-local Check state and disappear with its Space-removal purge.

The person reviews Before/After and clicks **Apply and recheck**. The host holds
Check, capability, restricted-app, and History/ownership reservations, saves an
exact-byte History checkpoint, journals application before writing, re-verifies
all finding inputs, and writes only through a no-follow handle whose exact bytes
match `beforeHash`. Hard-linked files are refused. The checkpoint remains after
any failure. Repeated application is refused; interrupted application becomes a
failed record with its checkpoint reference and is never automatically retried.
External writers can still mutate ordinary files outside app reservations, as
with History generally. The relevant Check starts as a separate task after the
applied outcome is durable. Failure to launch or complete that run does not undo
the correction or imply a clear result.

Machine state version 3 accepts versions 1 and 2, adds trial markers and bounded
correction records, and continues to fail closed on future versions. At most 24
pending corrections and 32 total correction records are retained; pending
reviews are never evicted to retain terminal history. The experimental
content-free status contract remains version 1.

The desktop creates its shared Check service before the interactive API starts.
`createDesktopCheckService` supplies a lazy in-process callback to that API's
serialized fold-model reviewer. The renderer, CLI, and Routings use the same
service and transport. Status reads do not start the API or a model, and the
callback is not exposed as an HTTP or remote command. Integration coverage
uses this actual desktop composition for trials, live runs, and correction
rechecks; injecting a synthetic reviewer into the service alone is insufficient
to prove packaged desktop wiring.
