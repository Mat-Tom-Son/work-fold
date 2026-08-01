# Checks decision register

Checks let a person teach Workspace a small, durable expectation about files
they deliberately designate. Workspace may then verify that expectation on
request and explain current, evidence-backed problems. Checks are optional
Space behavior, not a new container, ambient scanner, generic agent loop, or
permanent navigation destination.

This document records the decisions that implementation and product surfaces
must preserve. The initial contracts are experimental until real dogfooding
justifies promotion into the stable kernel and installed-CLI snapshots.

## Product boundary

- **Checks** is the person-facing noun. **Needs attention** describes an
  evidence-backed outcome. `sensor`, `candidate`, `admission`, and `finding`
  remain implementation terms.
- A Space with no configured Checks is **not configured**, never implicitly
  clear. Workspace does not enumerate, inspect, or send its files to a model.
- Every Check names bounded targets. There is no declaration meaning “the
  whole Space” and no implicit inheritance from the selected file, current
  Chat, or working directory.
- A target is either an exact Space-relative file or an explicitly selected
  directory tree with bounded recursion and declared file-type filters. Hidden
  `.workspace/` and executable `.pi/` material cannot be targets.
- Checks run only when a person or authenticated agent action requests a run.
  Opening the Checks work tab refreshes recorded status and re-verifies saved
  evidence, but does not run a sensor. Continuous watching and schedules are
  not part of the first releases; future schedules use the existing
  named-automation model.
- Checks do not occupy the primary rail or the Add menu. The management
  conversation and installed CLI remain agent-facing surfaces. In the desktop,
  a conditional summary at the Files edge opens one reusable Space-owned Checks
  work tab. An unconfigured Space adds no control, badge, marker, or empty
  destination.

## Expectations and authority

- Conversation is the primary authoring experience. When a person expresses a
  durable expectation, an agent may create an inert typed proposal. It may not
  enable the Check itself unless the person explicitly requested the
  authenticated enable action.
- An ordinary request such as “check these files” is one-off work over the
  files named or attached in that request. It does not create standing
  behavior. Durable proposal language requires explicit intent such as “keep
  checking,” “watch this,” or a person's acceptance of a proposed Check.
- A proposal has no apply operation in the unauthenticated read lane. Importing
  or enabling it is an explicit, receipted act-lane mutation naming one Space.
- Portable declarations live below `.workspace/checks/`. They are code-free
  data and may contain only a sensor id and revision, typed parameters, bounded
  target selectors, presentation metadata, and gate policy.
- Declarations may never embed prompts, instructions, source code, shell
  commands, model names, provider credentials, connection data, or arbitrary
  executable expressions. Prompt-bearing or executable sensors are trusted
  Assistant capabilities distributed through the existing Pi lane.
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

## Storage split

| Record | Initial location | Reason |
|---|---|---|
| Inert Check proposal | Any ordinary file chosen by the person or agent | Reviewable and transferable without authority |
| Enabled declaration | `.workspace/checks/<check-id>.json` | Portable expectation data, never executable configuration |
| Exact-digest enablement | Workspace application state | Authority is local to the machine and installed sensor revision |
| Run records and admitted findings | Workspace application state | May contain paths, excerpts, and other private derived content |
| Decisions and invalidation history | Workspace application state | Avoids silently exporting personal triage; portability is a later explicit decision |
| Raw model requests/responses and cost detail | Workspace application state | Never portable Space content |

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
- Deterministic built-in sensors ship first. A later model sensor is one
  bounded model task with no general tools and one schema-validated terminating
  submission operation. It is not a persistent Chat turn.
- The declaration determines the sensor and targets. A sensor may not use a
  model, connection, network destination, or executable capability that was
  absent from the exact revision the person enabled.

## Evidence admission

The protocol invariant is: **no independently re-verifiable evidence, no
active finding**.

- Sensors propose; the runner admits. Before persistence, the runner
  independently verifies the evidence against current files.
- Experimental contract 0 admits only typed file/path-state evidence. Exact
  text spans, structured values, comparisons, and deterministic receipts are
  candidate shapes for later protocol revisions; they are not advertised or
  silently accepted by the current runner.
- Evidence records the relevant input identity: canonical Space-relative path,
  content digest or missing-file state, sensor revision, and typed locator.
- A finding is re-verified before it appears in `problems`. Failed
  re-verification removes it from the active list and records it as stale,
  invalidated, or superseded in audit history.
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
- Experimental `check_run` tasks remain out of the stable `workspace.tasks`
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
  same internal task as `workspace checks run`; stop and decisions use the same
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
  Future content sensors must receive immutable runner-opened snapshots or
  opaque handles with no-follow identity checks before they can ship.
- Status compares runner-owned current identities with the recorded run. It
  never invokes a sensor, provider, model, connection, or network adapter.
- Target isolation is re-applied when old findings are surfaced. If a folder
  inside a Check's target later becomes another registered Space, the parent
  Check becomes blocked and its previous evidence is neither opened nor shown.
- Any skipped designated input or candidate that fails admission makes the run
  incomplete/failed. It can never reduce the finding count into a false
  `current-clear` result.
- A terminal-state persistence failure retains the in-process task and
  capability-mutation fence while task polling retries the exact write. If the
  process stops first, startup records `interrupted`; it never replays the run.

## Shipped proof and deferred work

- The first vertical slice covers proposal, explicit enablement, one
  deterministic sensor, bounded target resolution, evidence admission, run
  task/receipt, finding display, a fingerprint-scoped decision, management
  conversation guidance, and the quiet desktop read model above.
- Manuscript and travel fixtures prove that the protocol is domain-neutral;
  repeated decisions in real Spaces prove that the product is useful.
- A conditional Files-toolbar summary, exact file decorations, and the
  Space-owned work tab remain a deliberately quiet layer over the engine. A
  permanent header badge, primary navigation item, background watcher, or
  proactive notification would require new precision evidence and an explicit
  product decision.
- Model-backed sensors, domain packs, schedules, gates that block other work,
  cache replay, hosted execution, and a Manuscript Lab migration are later
  layers. They must reuse this authority and admission model rather than widen
  it.
