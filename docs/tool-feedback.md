# Feedback during Assistant work

Status: shared foundation and included integrations implemented in the development tree, 2026-09-11. This extends
[Extensions and computer work](extension-foundation.md). It applies to every
kind of Assistant work, including text, calculations, service operations,
files, generated artifacts, browsers, and desktop applications. Exact-build
release acceptance is separate from implementation and fixture evidence.

## Decision

The primitive is an operation returning useful observations to the same Pi
conversation. Pi already runs the model/tool loop and accepts text and images
in native tool results. work-fold preserves that path. A tool may perform an
action and return its observed result, or the Assistant may explicitly follow
the action with an existing read, query, render, or inspection tool. Both are
first-class compositions; ordinary tools need no additional manifest.

The Assistant decides what to do next using the user's objective and the
evidence it has. A successful tool execution establishes that operation's
reported outcome; it does not establish that the whole request is correct.
The design adds no model scheduler, universal retry loop, second tool registry,
or new durable task state. Existing request ownership, cancellation, provider
handling, and continuation remain authoritative.

## Reuse before adding

The installed Pi 0.80.6 provides these mechanisms:

| Need | Existing mechanism | work-fold responsibility |
|---|---|---|
| Receive an operation's outcome | Native tool result `content` with text and images | Preserve it in the Pi session; do not replace it with the UI's summary |
| Inspect a generated image | Built-in `read`, including Pi's image processing | Package the actual renderer separately when the source is a PDF, document, or other non-image format |
| Explain a tool's evidence and next steps | Native tool description, `promptSnippet`, `promptGuidelines`, and Skills | Teach a small common verification discipline without duplicating domain workflows |
| Keep extension state or presentation metadata | Native result `details` | Do not assume those fields are visible to the model or form a generic result schema |
| Adapt a particular tool result | Native `tool_result` hook | Use only a deliberately integrated adapter; preserve other tools and other hooks |
| Cancel ongoing work | Native tool signal and session lifecycle | Pass cancellation into owned subprocesses and network requests; keep Stop reachable |
| Let a person inspect the result | Existing files, Chat, and supported preview surfaces | Present the same selected version and say when a preview is unavailable |

`renderResult` is Pi's terminal presentation hook. It neither renders a PDF
into pixels nor sends those pixels to a model. A desktop preview is likewise
not evidence that the model saw an image. Model-visible observations belong
in `content`, or in a subsequent explicitly requested native read.

## Evidence for any domain

Evidence uses the representation suited to the operation. A calculation may
return values and a consistency check. A service mutation may return an object
id followed by a read of the resulting state. A document may return extracted
text, layout diagnostics and selected page renders. A UI action may return
controls, changed text and a screenshot. No image is needed when a precise
textual or structured observation answers the question.

Each included integration must make the following facts understandable in its
normal result. These are semantic requirements, not a universal wire schema:

- What was acted on or observed, and which version or moment it represents.
- What was actually observed, distinct from inferred success or an attempted
  action. Unknown, incomplete and failed verification stay explicit.
- What scope was covered: pages, ranges, rows, targets or checks, including
  omitted content, truncation, scaling and relevant rendering limitations.
- How to inspect more or act again using the integration's existing handles.

Machine-readable details may supplement a concise model-visible explanation.
Do not put essential observations exclusively in `details`. Tool output,
documents, website text and OCR remain task data, not new instructions or
authorization to broaden the work.

Artifact freshness uses the existing integration's revision handles where
available. File renderers must bind the render to exact input bytes and relevant
rendering dependencies; a path alone is not a version. For an initial file
renderer, render an immutable input snapshot or reject an input that changes
during capture. Include source identity, page/range selection, renderer identity
and rendering parameters and resolved dependency identities in any cache key.
Disable reuse when relevant dependencies cannot be pinned. Never present a render of an earlier
revision as verification of the delivered file.

## Composition and stopping

The Assistant can repeat action, observation, and correction in its normal Pi
turn. It can compose unrelated tools without work-fold inferring a workflow
from their names. It observes again where the result can change the next
decision. Independent reads may run concurrently; dependent mutations use the
domain's concurrency and stale-state rules.

Browser scripting and DOM access have technical limits. The Assistant may
choose another available tool, such as native Computer control, when it fits
the person's authorized task and constraints. Actual permission and policy
denials still apply. Tool selection stays with the model; work-fold does not
infer a fallback from a domain or error string.

Verification must be useful and proportionate. Re-read a requested setting;
reconcile a total; inspect relevant document pages and content. Visual quality,
semantic correctness, and successful execution are distinct. After a relevant
change, inspect the affected properties again; earlier evidence supports only
its actual version and scope. Reviewing three
pages does not establish that a whole report was reviewed, and a model's visual
judgment does not become a deterministic Check result.

Finish when the requested outcome has supporting evidence. If useful progress
stops, report what remains or ask for missing information through the existing
question mechanism. Do not create an arbitrary hidden iteration count, spawn
a second model to grade every tool, or continue after Stop. Existing provider
retry behavior does not authorize repeating an external mutation with an
uncertain outcome. A failed observation does not mean the preceding mutation
failed. Absence in an eventually consistent read does not prove nonexecution.
Repeat an uncertain mutation only with authoritative evidence of nonexecution
or the integration's established idempotency mechanism; otherwise report the
uncertainty rather than silently submitting it again.

## Context, storage, and presentation

Return selected evidence during requested work. Do not watch all files,
capture the desktop after unrelated tools, scrape path-shaped strings out of
shell output, or automatically open every artifact a tool mentions. An
integration that can return an image directly should do so when useful; a
standard tool that returns a path remains usable through Pi's built-in read.

Each integration owns its capture and artifact lifetime. Included document
helpers bound source size, pixels/pages, image bytes, logs and runtime; rendered
PNGs are temporary by default: the document worker removes its private preview
directory after assembling the bounded native image result, including failure
cleanup. An explicitly supplied `outputDir` keeps requested PNG artifacts in
that ordinary directory until deliberately removed. Selected native tool results can also persist in Pi's machine-local
session history. Neither is an ambient screenshot archive. Do not invent a
universal retention mechanism or claim a file is temporary without a cleanup
owner. Cleanup must never delete a delivered artifact or another Chat's evidence.

Native Pi session evidence and work-fold's portable Chat are distinct. The
existing compact tool trail is a presentation projection, not the source of
the model's tool results. Future inline artifact previews require explicit
owning Chat/task/version references and content-serving policy, rather than
copying all raw tool results into the transcript or paired-web relay. The same
selected evidence can have different presentation detail for person and model.

Consult Pi's model capability metadata and native `blockImages` preference
before promising visual inspection. Preserve Pi's conversion behavior.
If the chosen model cannot receive images, retain useful text and diagnostics
and explain the limitation. Included image-producing integrations provide their
own useful text or limitation note; arbitrary native tools do not inherit the
built-in reader's warning. Do not silently switch providers or introduce a
paid secondary vision model. Third-party native code remains full trust; these
integration conventions are not a sandbox against arbitrary extensions.

## Inspect model context

The local `?dev-context` route provides an all-request **Inspect context**
view for developers. On an installed Mac build, open its separate developer
window from Terminal:

```sh
open -n -a /Applications/work-fold.app --args --work-fold-inspect-context
```

This works whether work-fold is closed or already running. `-n` forwards the
explicit launch request through the existing single-instance host; it does not
start a second app runtime. Repeating it focuses the existing inspector. The
window has a sandboxed, diagnostics-only preload: the local API credential
stays in the host, and ordinary desktop/settings IPC is unavailable. Opening
the inspector does not enable recording. **Close** or Escape closes only that
window; it does not turn recording off. Disable recording before closing when
capture is no longer needed. Normal Chats, the fold and Settings have no
inspector entry. Changing models remains a separate action.
Recording is explicitly enabled for the current app run and starts with the
next model call; inspection itself only reads retained records. It never
initializes a Pi session, loads an Extension, invokes a model or regenerates
evidence. Disabling or clearing recording invalidates in-flight recorder
callbacks as well as deleting retained records. Restart begins with recording
off and no captured records.

Use one diagnostic observer at the bound Pi session's `agent.streamFn`, shared
by normal turns and the host's title, Check, app inference and compaction calls.
Capture a detached bounded **Assembled model context** with the effective
model, system prompt, messages and active tool definitions. Chain the existing
native `onPayload` callback and capture its final effective result as
**Provider payload observed**. Preserve native hook order, replacements, errors
and return values exactly; observer failures cannot affect the request. Never
claim an observed payload is exact transmitted bytes or proof of delivery.
Custom providers that omit the callback show assembled context only. Calls
made by arbitrary Extensions through independent transports remain outside
this observer; the inspector must state this coverage limit.

Each stream call gets immutable identity: Chat, session, optional explicit task,
purpose, selected model and its own record id. Auxiliary calls have their own
purpose and never borrow the currently running task. Payload callbacks may run
more than once; bounded samples remain attached to that call without pretending
to count all HTTP retries. Automatic compaction is labeled separately using
Pi's lifecycle context where available; unknown purpose stays unknown.

Provenance separates the actual dispatch's system-prompt digest and tool names
from loaded session resources: Pi version, runtime paths, context-file paths
and loaded-content digests, appended instruction digests, Skill/Extension
origins and session-active tool sources. Loaded resources are not proof that
an auxiliary request used them; bounded app inference, titles and Checks
assemble separate contexts. It never reconstructs past context from files that
may since have changed. Image metadata records
available identity and bounded digests of encoded content without retaining
image bytes. Missing or truncated provenance remains explicit. Ordinary
undefined JSON object fields are absent, undefined array entries become null,
and shared references are copied within the same bounds. Actual cycles and
unsupported values remain explicit omissions.

Recording is bounded per request and across the app, lives only in memory,
and has an age limit. The UI shows omissions, evictions and absent capture
stages without claiming complete context. Image bytes are represented by
bounded metadata, not copied into another screenshot archive. Authentication
options, request headers, environment variables and provider keys are not
collected. Known credential fields in observed payloads are redacted, but
conversation text can itself contain secrets; the UI explains that recording
contains private content and redaction is not comprehensive.

Text uses the remaining snapshot byte budget, with no separate 32 KiB string
cap that would cut off ordinary system prompts. Oversized text retains an
exact prefix and an explicit omission marker; accounting includes JSON escapes
and UTF-8 bytes. The per-request, total-memory, nesting, node and retention
bounds remain in force and never constrain what Pi sends to the model.

Inspection is a trusted local diagnostic operation. Optional request filters
use exact scope and Chat identity; detail reads enforce the same filter.
No raw context enters portable Chat files, activity events, SSE replay, CLI
read snapshots, paired-browser operations or ordinary logs. Reconnect reads
existing captures. No new remote or restricted-app observation authority is
introduced.

## Implemented path and verification

The shared foundation preserves native text/image results into the next Pi
request, built-in image reads, provider conversion and `blockImages` behavior.
A concise shared prompt appendix teaches useful verification across fold and
Space sessions. A stopped tool may drain, but late UI events cannot revive its
turn or permit overlapping reuse. The local inspector observes Assistant,
title, Check, app inference and compaction calls without changing their hooks
or source-pinned Check authority.

Included Computer, Chrome and Web tools use native observations and source
identities. Documents adds ordinary bundled libraries and a cancellable
JavaScript worker, with PDF text/render helpers and deliberately selected PNG
emission. Its render evidence pins captured source bytes, page, scale,
renderer, dimensions and digests. Office files can be structurally inspected
with those libraries; visual inspection uses existing compatible applications,
and spreadsheet formulas are not recalculated. MCP keeps upstream transport,
discovery, schemas and cancellation; configured servers follow their native lifecycle, with lazy connections
starting on use. See [the integration contract](extension-foundation.md) and
[document-work Skill](../resources/included-tools/documents/skills/documents/SKILL.md)
for supported paths and exact limits.

Native provider fixtures, integration fixtures and actual Electron dependency
fixtures cover these mechanisms. Live model judgment, real OS/companion setup
and signed candidate behavior require their own release acceptance evidence.

## Adversarial review and acceptance

Review separately for Pi compatibility; evidence freshness and misleading
success; and ownership, cancellation, context and UX. Findings must name a
concrete failure scenario, severity, and the smallest corrective change.

Acceptance must cover native extensions with no work-fold metadata; direct
image results and built-in image reads; text-only models; ordinary text/data
results; partial and stale observations; output limits; simultaneous Chats;
Stop during a render or tool; and reconnect without replay. Real renderer
acceptance must include a known layout defect, content checks, an input changed
mid-render, and evidence matching the final delivered artifact. Computer/service
acceptance must include an uncertain mutation outcome without automatic replay.
Source inspection or scripted providers prove plumbing, not model judgment or
packaged backend readiness.

Three independent adversarial reviews completed on 2026-09-11: native Pi
compatibility, evidence semantics, and ownership/lifecycle. Their accepted
findings are incorporated above: uncertain effects versus failed observations;
dependency-sensitive rendering and invalidation after edits; native image
preferences and provider-stage tests; cancelled-tool draining; auxiliary-call
attribution; bounded private recording; and honest capture-stage labels.

Foundation verification on 2026-09-11: `npm run check`, `npm test` (1,354
passed, one optional model-driven test skipped), the bridge's 55 tests, and
`npm run desktop:prepare` passed. Browser checks covered the desktop inspector
and the compact fold layout, keyboard navigation, closing and focus recovery.
Provider fixtures use local synthetic responses; these checks establish native
transport and lifecycle compatibility, not a model's judgment on real work.

A subsequent Claude desktop review led to session-lifetime callback fixes
and removal of the small per-string inspection cap. Native provider fixtures
now compare an instruction block larger than 32 KiB across assembled context,
observed payload and the local provider's received request. Escaped Unicode
and oversized text remain bounded. The reported permanently blocked Chat
scenario did not reproduce through the server: cancelled sessions are already
disposed before admission reopens. Direct client reuse after disposal did
reproduce it and now releases the disposed session's guard, while reuse of a
still-draining live session remains refused. Compaction comparisons found no
regression and did not justify replacing Pi's native compaction behavior.

## Sources

- [Pi Extensions](https://pi.dev/docs/latest/extensions): native tool results,
  result hooks, guidance, Skills integration and terminal rendering.
- [Pi SDK](https://pi.dev/docs/latest/sdk): embedded sessions and native tools.
- The installed Pi 0.80.6 `createReadTool`, `convertToLlm` and `ToolDefinition`
  exports; work-fold's [Pi client](../src/local/agent/pi-client.ts) constructs
  native sessions and projects their events into bounded UI activity.
