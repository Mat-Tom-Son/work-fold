# Installed-client acceptance and Settings redesign

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
| A03 | Neighborhood Workshop | Plan a 16-person photo workshop using supplied brief and price list | Correct budget totals, assumptions labeled, editable workbook and one-page PDF linked in Chat | Blocked: DeepSeek request returned HTTP402 before tools (zero processed tokens) |
| A04 | Community Outreach + fold | Delegate an invitation draft from a workshop handoff; ask for missing time; answer once | Selected file reaches target; question and one continuation; no unrelated transcript leakage; fold gets result | Paused by user: provider credit |
| A05 | Tool Lab / MCP | Query local supply inventory, calculate shortages, handle disconnect and recovery | Native discovery/invocation, correct 4/40/8 shortages, useful failure, successful fresh retry | Paused by user: provider credit |
| A06 | Tool Lab / Chrome | Edit a synthetic registration form in a dedicated browser tab; verify final state; reconnect | Native Chrome observation/action, correct isolated tab, no duplicate submit on recovery | Paused: provider credit and manual setup |
| A07 | Tool Lab / computer | Edit a disposable workshop note in TextEdit, save and verify; stop queued input | Native helper observation/action, correct file, permission failure/recovery, no extra input after Stop | Paused: provider credit and manual setup |
| A08 | Tool Lab / documents | Detect and fix a deliberately clipped PDF heading and overlapping footer | Model receives images if supported; two renders; final source/image provenance matches; previews cleaned | Paused: model catalog advertises image input; effective payload not yet exercised |
| A09 | Two Chats | Run independent document jobs, stop one, switch tabs and reopen app | Stopped worker has no late write; sibling completes; files and task states survive restart without replay | Paused by user: provider credit |
| A10 | Tool Lab / Space app | Build a small workshop checklist with a bounded inference action | App installs, saves a record, invokes app-owned inference, displays result and receipt | Paused by user: provider credit |
| A11 | Settings | Change scoped model, inspect connection, edit instructions, navigate every page | Scope correct after async loads/saves; credentials protected; no stale responses, clear errors | Passed in source DOM tests and native development app; see verification below |
| A12 | Settings | Keyboard, narrow window, light/dark, long model names and save/error states | No clipping or horizontal overflow; visible focus; correct tab navigation and focus return | Passed: CUA light/dark, 320/390/700/940 widths, keyboard focus and scrolling |

Run dependent journeys sequentially. Start at most two live Chats concurrently
for the specific isolation case. Record provider errors as failures or blocks,
not passes; completed tool work can survive a failed final model response.

The person confirmed OpenRouter is out of credit and asked to focus on Settings
for now. A03–A10 are paused; do not make additional paid requests. The exact
selected model is `deepseek/deepseek-v4.1-flash` (catalog advertises text/image
input). The prepared Workshop inputs total $219 with $31 remaining from $250.
No assistant-generated deliverable is claimed from the rejected request.

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

**Content plan:** persistent Settings navigation; a clear page title and short
scope explanation; compact related controls; one local save/status area per
operation. Appearance, Assistant, The fold, Desktop and About retain their
existing meanings. Fold subpages remain discoverable without nested card grids.

**Interaction thesis:** quick selection/focus feedback, a stable scrollable
content pane, and local pending/saved/error feedback that does not shift the
whole form. Honor reduced motion. Do not add ornamental transitions.

The Assistant page separates:

1. **Model** — clearly select This Space or The fold, then provider/model;
   explain that model defaults apply to new Chats. Keep catalog refresh small.
2. **Connection** — provider name and credential status in a readable row;
   show a key field only when connecting, with credential removal secondary.
   Explain that connections are shared across this computer.
3. **Space instructions** — only for the selected Space, with their own save
   action and a concise explanation of when they apply.

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
