# Installed-client acceptance, Settings and appearance

This is the working test plan for the installed macOS 0.4.29 client and the
subsequent Settings improvement. Results are recorded against the version that
actually ran. Source checks, simulated integration tests, live model work and
human setup are separate evidence.

## Test conditions

- Use the installed `/Applications/work-fold.app`, not yesterday's temporary
  candidate/profile. Verify version, updater payload, and cold launch.
- Use OpenRouter's DeepSeek V4.1 Flash selected by the person. Record its exact
  model id and advertised input capabilities before testing image feedback.
- Create three visible, managed Spaces: **Neighborhood Workshop**, **Community
  Outreach**, and **Tool Lab**. Keep their prompts, ordinary source files and
  deliverables available in the app.
- The person explicitly authorized deleting the five previous demo Spaces.
  Delete through the product, verify Recently deleted receipts, and preserve
  recovery. Never erase the underlying folders directly.
- Use synthetic content and local test services. No messages, purchases,
  bookings or new account connections to outside people/services.
- Do not bypass protected Chrome extension-management controls. OS permission
  changes and provider credit remain explicit setup; name any blocked test.

## Journeys and observable outcomes

| ID | Space / surface | Scenario | Pass evidence | Status |
|---|---|---|---|---|
| A01 | Installed app | Verify 0.4.28 → 0.4.29 update and cold launch | Installed signature/feed/version; cached ZIP matches public digest; saved app opens | Passed: installed signature/feed and cached ZIP digest; cold launch |
| A02 | Space management | Delete old demo Spaces; create three fresh Spaces | Five reversible deletion receipts, empty registry, three visible new Spaces | Passed: all five old Spaces in Recently deleted; three new Spaces visible |
| A03 | Neighborhood Workshop | Plan a 16-person photo workshop using supplied brief and price list | Correct budget totals, assumptions labeled, editable workbook and one-page PDF linked in Chat | Passed after funding: correct workbook formulas/caches, three linked files, independently rendered one-page PDF |
| A04 | Community Outreach + fold | Delegate an invitation draft from a workshop handoff; ask for missing time; answer once | Selected file reaches target; question and one continuation; no unrelated transcript leakage; fold gets result | Graph/isolation passed on retry; UI answer was delayed by S12 and needs re-verification |
| A05 | Tool Lab / MCP | Query local supply inventory, calculate shortages, handle disconnect and recovery | Native discovery/invocation, correct 4/40/8 shortages, useful failure, successful fresh retry | Passed: native discovery/invocation, 4/40/8 shortages, one failed call during synthetic outage, fresh successful retry after recovery |
| A06 | Tool Lab / Chrome | Edit a synthetic registration form in a dedicated browser tab; verify final state; reconnect | Native Chrome observation/action, correct isolated tab, no duplicate submit on recovery | Setup needed: installed readiness check confirms companion is not connected |
| A07 | Tool Lab / computer | Edit a disposable workshop note in TextEdit, save and verify; stop queued input | Native helper observation/action, correct file, permission failure/recovery, no extra input after Stop | Setup needed: installed helper reports Accessibility and Screen Recording not verified |
| A08 | Tool Lab / documents | Detect and fix a deliberately clipped PDF heading and overlapping footer | Model receives images if supported; two renders; final source/image provenance matches; previews cleaned | Passed after manual recovery and evidence correction: two image paths, readable corrected PDF, matching hashes; initial allocation failure retained |
| A09 | Two Chats | Run independent document jobs, stop one, switch tabs and reopen app | Stopped worker has no late write; sibling completes; files and task states survive restart without replay | Failed in 0.4.29: UI admission/Stop delayed by S12; source fix and fresh retest in progress |
| A10 | Tool Lab / Space app | Build a small workshop notes app with a bounded inference action | App installs, saves a record, invokes app-owned inference, displays result and receipt | Persistence and one-call inference passed; trusted receipt UI exposed duplicate Running row (S15, source fixed) |
| A11 | Settings | Change scoped model, inspect connection, edit instructions, navigate every page | Scope correct after async loads/saves; credentials protected; no stale responses, clear errors | Passed in source DOM tests and native development app; see verification below |
| A12 | Settings | Keyboard, narrow window, light/dark, long model names and save/error states | No clipping or horizontal overflow; visible focus; correct tab navigation and focus return | Passed: CUA light/dark, 320/390/700/940 widths, keyboard focus and scrolling |

Run dependent journeys sequentially. Start at most two live Chats concurrently
for the specific isolation case. Record provider errors as failures or blocks,
not passes; completed tool work can survive a failed final model response.

The first request was rejected for insufficient credit with zero processed tokens.
The person funded OpenRouter and authorized resuming on September 12. Live tests
use `deepseek/deepseek-v4.1-flash`. A brief cost clarification paused work, then
the person explicitly authorized continuation. The workshop's $219 supplies
estimate is synthetic business data, not model usage. The latest recorded model
cost is in ignored `out/installed-acceptance/live-cost-20260912.json`; it reflects
native runtime usage, not an independently checked OpenRouter balance, and
aborted calls may lack usage. No purchases or external messages were sent.

A03 produced the plan, editable workbook and checklist under Workshop's
`Outputs/`. Independent ExcelJS reopening confirmed seven quantity × price
formulas, SUM total 219 and remaining 31 with the matching cached results.
Independent Poppler rendering confirmed a readable one-page checklist. Two
native document-tool image results and the model's intervening revision are in
the Pi journal. The final PDF SHA-256 is
`773708dad4905551adebc013f183ed098de7b01c5983dac5a8addbd511042f3f`, matching its
reported render source. One LOC page was read successfully; other attempted
sources returned visible 404s and were not cited as read.

A04's fresh handoff copied exactly the selected plan, with a matching SHA-256 and
pre-add restore point. Community Outreach asked for the missing time and stopped
its turn. Exactly one answer continuation wrote the 10:30 AM invitation; the
fold received the final file and digest. The fold-only canary is absent from both
Spaces' portable conversations and current native child sessions. However, the
UI answer submission stalled: a later CLI answer overtook it, and the delayed UI
submission correctly acknowledged the existing delivery. The graph/isolation
pass does not excuse this UI failure. A different second answer was refused.

A08 correctly detected right-edge title clipping and overlapping footer lines
from native page/crop images. Its unnecessary raw stream parser then allocated
without bound; Stop eventually settled and the app recovered. With explicit
steering, it produced a readable one-page corrected PDF, emitted its render and
used native Read on the saved PNG. Independent Poppler rendering verified the
output. Two overclaims in its review note (raw-title truncation and bottom-margin
arithmetic) were corrected after review. The PDF and PNG hashes stayed unchanged.
The initial interrupted fold attempt had no children and remains a failed attempt.

The installed client configured the synthetic stdio MCP service in Tool Lab only.
The model used native connect/discover/describe/invoke and saved the correct
4/40/8 shortages. Its first empty file was detected and replaced through History-
covered file operations. A synthetic service outage then returned its explicit
error after exactly one invocation. Removing the outage flag and requesting a
fresh call returned the correct inventory again. Native tool results are retained
in `out/installed-acceptance/mcp-recovery-verification.json`.

Computer and Chrome readiness checks still require manual setup; no OS permissions
or Chrome profile settings were changed. The installed Set up Chrome action
successfully prepared the companion folder after the live tasks settled. The
person has been asked to load that folder and grant the signed computer helper's
Accessibility and Screen Recording permissions before A06/A07 can continue.

A09 exposed S12: with multiple mounted Chats, the UI showed a second job as
thinking although it had not been accepted, and Stop reached the first job too
late. Its normal completion marker exists. Closing idle tabs released the
pending sibling, which produced a valid PDF. This is a failed cancellation/
concurrency journey, not a pass. A normal quit/reopen after accepted work settled
preserved completed files and transcripts without replaying accepted turns.

A second attempt in two Spaces reproduced the failure with only two Chat tabs:
Stop was clicked at 1789222930191, before the first worker's scheduled completion
at 1789222934911, but its completion marker was written at 1789222934913. The
sibling worker started afterward, at 1789222937273. There was no simultaneous
worker execution and cancellation failed. The sibling's delivered PDF matches
its reported digest. Retain this failed attempt separately in
`out/installed-acceptance/concurrency-second-verification.json`; do not replace
it with the source transport regression's passing result.

A10 built and immediately installed the Workshop Brief local preview. Editing
and saving notes made no model call. One Summarize click produced one accepted
and one terminal journal event, used the Space's DeepSeek model, and cost
$0.0002625 according to its runtime usage. A normal quit/reopen restored both
notes and summary with no additional inference. The trusted Apps detail view
showed the correct effective model and usage, but also showed the earlier
accepted event as a separate Running row (S15). The generated summary's word
"booked" describes no external booking; this pass proves the bridge and saved
state, not perfect factual phrasing. Evidence is in
`out/installed-acceptance/app-inference-verification.json`.

Detailed native image provenance, workbook verification and runtime cost evidence
are under ignored `out/installed-acceptance/`. Provider-payload-stage observation
was unavailable in installed 0.4.29 because it had no supported inspector entry;
that access gap is addressed for the next build, separately from this evidence.

## Adversarial acceptance details

- Chrome: use two distinguishable tabs/Chats; close the owned target and reject
  stale actions. Increment a local submit counter before simulating disconnect;
  recovery must leave it at one. Do not repeat an uncertain mutation.
- Computer: prove a real `observe_ui` image from the signed helper, reject stale
  state/element handles, and test physical takeover, queued Stop and sibling
  isolation. Catalog inspection stays cold; explicit readiness can launch the
  helper. A full app quit must stop it; reopening stays cold until first use.
- Documents: distinguish native image emission from images in the effective
  provider request. Include native output and built-in image reads, source
  digests, deliberate repair and cleanup ownership.
- Stop/restart: test tab switches and minimization separately from quit; assert
  no late writes after Stop settles and no accepted-turn replay after restart.
- Developer context recording: outside normal Settings, off by default, with
  dispatch-time provenance and image metadata; clear/restart leave no captures.

## Settings design

**Visual thesis:** a calm desktop preferences window with a quiet navigation
column, one content surface, readable rows and restrained separators.

**Content plan:** persistent Settings navigation; a clear page title and compact
scope label; compact related controls; one local save/status area per
operation. Appearance, Assistant, The fold, Desktop and About retain their
existing meanings. Fold subpages remain discoverable without nested card grids.

**Interaction thesis:** quick selection/focus feedback, a stable scrollable
content pane, and local pending/saved/error feedback that does not shift the
whole form. Honor reduced motion. Do not add ornamental transitions.

The Assistant page separates:

1. **Model** — clearly select This Space or The fold, then provider/model;
   label the defaults "For new Chats." Keep catalog refresh small.
2. **Connection** — provider name and credential status in a readable row;
   show a key field only when connecting, with credential removal secondary.
   Label the shared scope once.
3. **Space instructions** — only for the selected Space, with their own save
   action.

Retain native Pi/provider semantics and existing APIs. Audit async scope and
provider switches so an older response cannot overwrite the currently selected
scope, credential state, model choice or instructions. Prevent duplicate saves.

## Findings

The Settings findings below are addressed in this branch.

- **S01 — Settings hierarchy:** nested bordered cards, oversized scope pills,
  a disabled masked key field, duplicate saved indicators and crowded model
  controls obscure the person's current operation. Redesign above.
- **S02 — Documentation drift:** product-model text still describes an ordinary
  Chat/Settings context inspector, although 0.4.29 moved it to the developer
  diagnostic route. Correct the owning documentation with this change.

- **S03 — Removed Space races:** the last Space can disappear while Settings,
  tree and app-catalog reads are pending, producing stale missing-Space errors.
  Normalize scope before requesting and discard obsolete renderer responses.
- **S04 — Stale composer model:** a receipted CLI model change updates saved
  state but leaves an empty Chat's model label stale until app restart. Emit
  and consume the existing content-free control-hint mechanism.
- **S05 — Draft/focus loss:** navigating Settings or switching scopes discards
  unsaved model/instruction edits; delayed model loading can steal focus.
  Preserve dialog-lifetime drafts and consume opening focus only while relevant.

- **S06 — Developer-only settings:** Limits still listed internal context-capture
  bounds despite the inspector moving to a developer route. Remove that
  ordinary Settings subsection; keep the diagnostic and enforced bounds intact.
- **S07 — Small-window navigation:** About wrapped to a second row in the
  390px fixture. Use one horizontal row, compact spacing, and scrolling when
  narrower; focused items scroll into view.

## Settings verification

The Settings changes are on `codex/settings-and-live-acceptance`, based on the
published 0.4.29 commit. They are not yet in the installed production client.

- `npm run check`: passed (repository and both TypeScript checks).
- `npm test`: 1,434 passed, zero failed, one Windows-only skip. An obsolete
  source-pattern assertion initially failed after the form extraction; it was
  replaced by the real DOM credential/save tests before this final full run.
- Real DOM/SSE coverage includes delayed/superseded loads, concurrent writes,
  scope changes, provider refresh races, later instruction edits, credentials,
  external hints, closing/reopening during saves, disabled focus targets,
  model-selector opening focus, navigation and draft preservation.
- `desktop:prepare`: passed; native preloads and the restricted-app sandbox
  probe passed. The final visual refinement also passed the same lane.
- CUA browser preview: light/dark; 320, 390, 700 and 940px widths; long model names;
  no content overflow. Narrow navigation stays on one row. At 320px, End selects
  About and scrolls it fully into view. Viewport override reset after testing.
- CUA native app, separate temporary app/Pi profile: empty-profile Settings
  resolves to the fold, then a disposable Settings QA Space supports local
  instruction editing and saving without a provider connection. The draft
  survived Appearance→Assistant and This Space→The fold→This Space. Saved
  instructions remained after closing/reopening Settings. Web access, Limits,
  Desktop and About were inspected without granting connections or making calls.
- Three focused adversarial reviewers examined the test plan, renderer
  synchronization and Settings lifecycle; actionable findings S03–S05 were
  fixed and exercised by the tests above.

A11's credential and model-mutation race cases use controlled server responses;
no real provider credential was entered, removed or replaced in this pass. The
unpacked development app cannot verify production updater behavior; A01
separately records that for the user's installed 0.4.29.

Machine-specific receipts and detailed provider/tool evidence are kept under
ignored `out/installed-acceptance/`; do not commit credentials or private paths.

## Additional findings from resumed installed tests

- **S08 — Installed diagnostic access:** the packaged app had the recorder and
  authenticated routes but no developer launch entry. Add a separate trusted
  inspector window with explicit recording, without restoring a normal Settings
  or Chat inspector button.
- **S09 — Document allocation loops:** a generated script exhausted substantial
  host memory before Stop completed. Add a 512 MiB per-worker JavaScript heap
  bound with an actionable failure. Native/external allocations remain outside
  this limit; full-trust scripts remain full trust. A local allocation-loop
  regression verifies the sibling worker completes and the host remains usable.
- **S10 — False empty registry:** registry read/parse errors were swallowed as an
  empty registry. During A08 the UI reported “Space not found” despite the Space
  remaining on disk. The fallback is independently reproduced and removed: only
  an absent registry means an empty profile; other failures remain visible.
- **S11 — MCP setup copy:** after a successful no-auth connection probe, its row
  still said “Connection not checked” because that was a credential-state label.
  No-auth rows now say “No sign-in required”; unchecked authenticated rows say
  “Sign-in not checked.”

Document and Space regression suites passed together (47 tests), including the
allocation-loop/sibling case and the unreadable-registry failure that was first
observed to fail before the fix. Source-only fixes above are not installed in
the user's 0.4.29 client and are not claims that the remaining live journeys passed.

- **S12 — Renderer connection starvation:** independent long-lived local SSE
  streams exhausted Chromium's HTTP/1.1 connection pool. Read and mutation
  requests, including turn admission and Stop, queued while the CLI remained
  responsive. A shared renderer transport and answer/transcript race fixes pass
  88 focused tests, including real Chromium connection-pool saturation, reconnect,
  answer acceptance and sibling subscriptions. Retesting a built client remains
  required; the source tests do not turn installed 0.4.29's failure into a pass.
- **S13 — App authoring signatures:** the native proposal guide listed storage
  method names without call signatures. The model searched the installed archive
  for examples. Add exact positional storage signatures to the existing guide;
  no new tool or app-specific runtime is introduced. The live app build succeeded
  after steering, with zero declared grants and no inference during construction.
- **S14 — UI filler and overlapping tool details:** the person identified
  redundant setup explanations, technical inventories and broken detail layout.
  The copy/layout cleanup covers Settings, menus, tool details, app management,
  Space customization and bridge panels. Labels, actual errors, essential setup
  steps and consequential action facts remain.
- **S15 — Duplicate inference state:** the trusted receipt UI rendered each
  journal event as an invocation, so a completed call also remained Running.
  The reader now selects the latest owned event per call before applying its
  limit. Startup records unfinished calls as interrupted once, without replay or
  invented usage. The exact live journal pair was reproduced in disposable
  storage; 34 focused receipt/MCP tests passed without changing production data.
