# Extensions and computer work

Status: design and implementation plan, 2026-09-11. The interaction foundation
is implemented on `codex/extension-foundation`, pending release. The included integrations below are candidates, not
claims about the current installer. This document extends
[Assistant capabilities](assistant-capabilities.md); Pi remains the runtime,
package format, resource loader, and capability catalog.

## Product contract

People ask for an outcome in a Chat. The Assistant finds the relevant tools,
does the work, shows the result, and asks in that Chat when a decision is
missing. Installing an Extension makes it available in its chosen Pi scope.
Installation, successful loading, and readiness to perform a particular job
are distinct facts. Missing setup is named precisely; it does not produce an
approval queue or a turn suspended on a secret.

**Included with work-fold** is a maintenance promise: we select a version,
ship its dependencies, integrate setup, test supported surfaces, and maintain
updates. It is not another execution tier. User-added Extensions have the
same supported host integration path. Ordinary Pi packages require no new
manifest, wrapper, catalog, or tool policy to load. Optional richer host
facilities must remain usable by third-party Extensions.

The existing **Skills & Extensions** work tab owns discovery, installation,
source, scope, configuration, diagnostics, and removal. Keep **Everywhere**
and **This Space only**. Add included provenance within these groups, not a
new navigation destination. Account and OS setup stays on a trusted desktop
surface. Generated Space apps continue to request Assistant work through
`assistant.request`; they do not receive a desktop-control bridge.

## The layers and their responsibilities

| Layer | Owns |
|---|---|
| Pi | Native packages, Skills, Extensions, model tools and commands, session events, tool cancellation signals |
| work-fold host | Chat and request identity, supported UI, setup presentation, shared resource coordination, activity and lifecycle integration |
| Integration | Domain operations, observation validity, external connection, helper protocol, precise readiness checks and cleanup |
| Desktop and paired web | Presentation and user input for the exact owning Chat; desktop-only identity/secret/OS setup |

Prefer an integration's existing coordination and observation machinery to
another competing lock. Any host coordinator is opt-in for full-trust native
code; it cannot make arbitrary shell access safe or enforce a sandbox.

## Interaction foundation

Native Pi `select`, `confirm`, `input`, and `editor` calls are **live extension
interactions**, scoped by root and conversation. They appear inline in the
owning Chat, queue without replacing each other, and remain available after
switching away or reconnecting. One answer settles one callback; invalid,
duplicate, expired, or wrong-owner responses cannot advance it. Failure to
send an answer leaves the input available for retry.

They are not durable F27 questions. A native callback lives in one Pi session
and cannot be reconstructed after restart. Stop, session disposal, timeout,
and shutdown cancel it; reconnect never executes a tool or repeats an answer.
For a question that should end the turn and resume after an answer, Extensions
and Assistants use the existing collaboration verbs. Do not auto-answer a
third-party Extension's confirmation or pretend its private policy is the
product's authority model. Included integrations must not require recurring
action confirmations.

An interaction created within a turn carries that turn's host-supplied task
identity through async context. The router verifies it against the owning
Chat; it never attributes a late callback to whichever turn is running now.
Once its originating turn settles, delayed interactions from that context
are cancelled even if a newer turn has started in the same session.

The host bounds pending interactions and text. Live inputs and answers are
not added to the portable transcript or replay journal by the UI adapter;
an Extension can still deliberately record what it receives. Editor state
belongs to the same conversation, never to a process-global current editor.
The web may answer only non-secret interactions belonging to its exact
browser-owned management turn. Setup secrets and OAuth codes are not relayed
through this mechanism. Standard Pi text input has no secret classification:
extension authors must keep credential entry in their setup path.

Terminal component factories are not browser components. Diagnose unsupported
TUI features explicitly; do not render arbitrary extension HTML or silently
claim full TUI compatibility. Support ordinary serializable Pi UI first.

### Presentation

Visual thesis: calm, compact Chat content, using the existing typography and
one action accent. The question is the focus, with no full-screen interruption.
Content plan: short Extension label, question, optional explanation, choices or
one field, and a quiet Cancel action. The conversation and Stop stay accessible.
Interaction thesis: preserve typed answers across background refreshes; show
submission progress in place; remove only the settled question without moving
focus to another Chat. Respect reduced motion and avoid ornamental animation.

## Included capability targets

| Capability | Initial candidate / approach | Required before inclusion |
|---|---|---|
| Computer control | Audit `@injaneity/pi-computer-use`; retain its root/state/element observations and native input coordination | Reproducible licensed helper build, macOS signing/notarization and update ownership, Accessibility/Screen Recording setup, multiple embedded sessions, Stop and human takeover, capture handling |
| Chrome | Audit `pi-chrome`; reuse signed-in profile and independent background targets | Supported companion installation and version handshake; remove recurring authorization ceremony through an explicit maintained integration; user tabs survive cleanup; cancellation and two concurrent Chats tested |
| Web access | Audit `pi-web-access`, with search and readable fetch as the promised core | Explicit provider setup, source-bearing results, bounded downloads, cancellation, no implicit cookie/profile import, optional media features clearly separated |
| Documents | Maintained open-source runtimes plus portable Skills | Read/create/render-and-check PDF, documents, spreadsheets and presentations on packaged Apple silicon; licensing and runtime size; no dependency on a contributor's machine or proprietary Skills |
| Service connections | Audit `pi-mcp-adapter` as a normal Pi package | Stdio and HTTP lifecycle, OAuth setup, lazy tool discovery, schema validation, progress/cancel, supported elicitation, no terminal-only setup dependency |

Email, calendars, databases, and project services remain user-selected
integrations. Install only what was requested. Included does not mean all
servers start, every account connects, every tool enters context, or the
desktop is watched continuously.

## Computer and browser contract

The general [feedback contract](tool-feedback.md) applies to all tools and
domains, including text and data operations. Computer observations and document
renders use Pi's existing model/tool loop; the requirements below specialize
target ownership and physical input rather than introduce a separate loop.

1. **Explicit target.** Bind a desktop application/window or browser target to
   the owning task. No implicit adoption of whichever foreground surface a
   different Chat is using. Background browser targets can work concurrently;
   physical input is coordinated across the machine.
2. **Observe, act, verify.** Preserve observation and target identities through
   tool calls. Reject stale targets before input. Bound screenshots and
   accessibility output; offer progressive inspection rather than dumping
   the desktop into context.
3. **Activity and takeover.** Show which Chat controls the foreground. Human
   takeover and Stop withdraw queued actions, signal active helpers, and
   release owned resources. Stop must remain reachable while a question is
   displayed. Do not close a person's pre-existing windows or tabs.
4. **Honest effects.** A receipt records attempted action and observed outcome.
   External submission cannot generally be undone. If cancellation or a
   disconnect occurs after dispatch, record an unknown outcome and inspect
   before retrying; never auto-repeat a payment, send, upload, or submission.
5. **Capture lifetime.** Temporary captures belong to machine-local task
   storage with bounded retention. Only requested observations go to the
   selected model. Portable Space Chat/tool logs must not inherit unrelated
   desktop captures. Deliberately selected deliverables use normal result and
   file handoff paths. Audit upstream `appendEntry` and tool-result persistence
   before inclusion; the UI adapter alone cannot guarantee capture privacy.
6. **Lifecycle.** Startup and capability inspection do not launch a watcher or
   download executable helpers. Start on requested use; clean up idempotently
   at session shutdown, update, removal, Space revocation, and app quit.
   Restart observes current reality without replaying input.

## Readiness, lifecycle, and discovery

Use separate observed fields for installation/version, enabled scope,
Pi load diagnostics, and integration readiness. Readiness may be `ready`,
`setup_required`, `unavailable`, or `error`, with a concrete reason and a
desktop setup action when one exists. A successful module import is not a
successful permissions check. Unknown readiness stays unknown.

Persist enable/disable using Pi's own resource filters, preserving existing
package filters and scopes. Reuse the existing capability mutation fences:
changes do not interrupt an accepted turn. Disabling integrated computer work
withdraws new work and waits for/cancels explicitly owned resources through
its lifecycle; it is not a revocation boundary against arbitrary native code.

Before designing an optional integration API, exercise the first real backend
and pin which facilities it needs. Prefer native `ctx.ui`, `ctx.signal`, Pi
events, and existing work-fold verbs. Any extra readiness/setup/resource API
needs versioned messages, explicit session/task identity, validation, and a
working third-party example. Do not add an unused abstraction in anticipation
of every possible Extension.

Tool discovery should remain small and progressive: capability descriptions
first, schemas on demand where supported, then invocation. Use Pi's catalog
and native dynamic tools; never create a parallel model/tool registry.

## Implementation sequence and acceptance

1. **Interaction parity:** scoped editor state; bounded pending dialogs;
   typed answers; cancellation; reconnect snapshot; inline Space/fold UI;
   exact-owner web projection and answer operation. Test with real native Pi
   Extensions, without a paid model, including simultaneous sessions.
2. **Native lifecycle controls:** resource filtering with install/update
   preservation; capability inspection without setup side effects; optional
   readiness presentation driven by actual probes. Verify disabled resources
   do not load in new sessions and active work survives changes.
3. **Computer integration:** pin upstream source and license, audit and build
   helper, integrate setup and capture lifetime, prove foreground coordination,
   then run a packaged macOS acceptance journey. Never enable an unverified
   upstream main branch in the person's real Pi profile.
4. **Chrome integration:** companion distribution, stable identity, independent
   targets, setup and reconnect, shared activity/Stop. Prove two Chats can work
   without stealing focus or closing user tabs, including a bridge crash after
   an external action.
5. **Web, document and MCP baseline:** verify each promised job, dependency and
   account setup path, artifact rendering, and multiple session shutdown. Add
   supported versions and provenance to the same Assistant tools surface.
6. **Release:** isolated desktop and paired-browser journeys; full repository,
   bridge and desktop checks; signed candidate verification; normal release
   procedure. Shipping this foundation does not label candidates ready.

Cross-cutting acceptance: fold and Space use the same installed extension;
an app-requested task uses that same Space runtime; unrelated Chats keep
their own answers and editor contents; navigation never cancels work; Stop
does; browser revocation cannot be bypassed by a delayed answer; reconnect
cannot replay a tool; unknown external effects remain unknown. Record test
evidence and outstanding integration work separately.

## Primary references

- [Pi Extensions](https://pi.dev/docs/latest/extensions) and
  [Pi packages](https://pi.dev/docs/latest/packages)
- [pi-computer-use](https://github.com/injaneity/pi-computer-use) and its
  [architecture](https://github.com/injaneity/pi-computer-use/blob/main/docs/architecture.md)
- [pi-chrome](https://github.com/tianrendong/pi-chrome) and its
  [architecture](https://github.com/tianrendong/pi-chrome/blob/main/docs/ARCHITECTURE.md)
- [pi-web-access](https://github.com/nicobailon/pi-web-access)
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)

Candidate selection is provisional until the pinned source, distribution,
license, packaged runtime and acceptance journeys have been verified.

## Initial candidate source audit

The following is source inspection, not a claim that either package passed a
live computer-control journey in work-fold. No candidate was installed into
the person's Pi configuration.

- **pi-chrome 0.15.51**, source
  [`4811ee616d2bbd5ead669a7e2f33a0bb14bd43ef`](https://github.com/tianrendong/pi-chrome/blob/4811ee616d2bbd5ead669a7e2f33a0bb14bd43ef/extensions/chrome-profile-bridge/index.ts):
  the factory uses a `globalThis` singleton token and returns early for a
  later instance. Authorization also lives on `globalThis`. work-fold hosts
  multiple Pi sessions and performs separate catalog loads in one process;
  this needs an explicit embedded-host compatibility change and a regression
  test covering catalog inspection before two simultaneous sessions. Its
  session/tab design alone does not establish compatibility. Keep the shared
  transport, make registration and authorization ownership deliberate, and
  prove one session's shutdown cannot remove another's tools or targets.
- **pi-computer-use 0.5.1**, source
  [`4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62`](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/bridge.ts):
  runtime references, saved observations and the resource scheduler are
  module state; shutdown clears them and disconnects CDP. Reconstruction
  reads native tool results from the session branch. Verify actual Pi loader
  isolation before changing this design, and settle capture persistence and
  cross-session cleanup before inclusion. The package's postinstall helper
  setup and `session_start` readiness flow also need explicit packaged-host
  treatment; current native dialogs are only one part of that work.

The host currently embeds Pi 0.80.6. Its extension loader disables module
caching, which must not be mistaken for isolating process-global state.
Prefer a small upstream-compatible embedded-host adaptation to replacing
Pi's runtime. Do not move every extension into a new process architecture
merely to accommodate one package's singleton assumption.

## Interaction implementation evidence

`tests/extension-interactions.test.ts` loads a real native Pi Extension in
isolated app/Pi directories. It exercises concurrent fold and Space questions,
typed and duplicate answer rejection, reconnect after one answer, private
setup-code handling, exact browser-grant ownership, revocation, Stop and a late
prompt after cancellation. It uses deterministic extension commands without
a paid model. `tests/extension-questions-rendering.test.ts` exercises desktop
and browser renderers, focus/draft preservation, failed answer retry, double
submission and late completion after navigation. The existing stream-replay
test separately verifies that transient snapshots do not advance its cursor.

Inert visual fixtures: `/popover.html?fixture=fold&extensions=1` on the local
Vite server, and `/?fixture=chat&extensions=1&capture=1` on the bridge's static
preview. Their answer controls never call the real API. Resource enable/disable,
readiness probes, included backends, helpers and companion distribution remain
the next implementation stages; this branch does not mark those complete.

Verification on 2026-09-11: `npm run check` passed; `npm test` passed 1,330
tests with one optional model-driven test skipped; the bridge's 55 tests
passed; `npm run desktop:prepare` passed, including preload and actual Electron
sandbox probes. The fold and web fixtures were visually inspected, and their
inline answer controls dismissed the question while leaving the conversation
and composer available. This verifies the interaction foundation, not live
computer control, Chrome companion behavior, or a public release candidate.
