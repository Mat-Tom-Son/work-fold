# Feedback during Assistant work

Status: design reviewed; shared foundation implemented, 2026-09-11. This extends
[Extensions and computer work](extension-foundation.md). It applies to every
kind of Assistant work, including text, calculations, service operations,
files, generated artifacts, browsers, and desktop applications. It does not
claim that the planned document or computer integrations are installed.

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

Temporary renders and captures use machine-local task storage with declared
size, pixel/page, duration and retention bounds when those integrations are
built. Do not invent new generic numeric limits before exercising the backend;
reuse existing Pi and work-fold limits where they already apply. A selected
deliverable remains an ordinary file in the requested destination. Filesystem
cleanup must never delete a delivered artifact or another Chat's evidence.

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

The local desktop provides **Inspect context** from Chats and an all-request
view in Settings → Assistant. Changing models remains a separate action.
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

Recording is bounded per request and across the app, lives only in memory,
and has an age limit. The UI shows omissions, evictions and absent capture
stages without claiming complete context. Image bytes are represented by
bounded metadata, not copied into another screenshot archive. Authentication
options, request headers, environment variables and provider keys are not
collected. Known credential fields in observed payloads are redacted, but
conversation text can itself contain secrets; the UI explains that recording
contains private content and redaction is not comprehensive.

All-request inspection is a trusted local Settings operation. A Chat entry
filters by exact scope and Chat identity; detail reads enforce that filter.
No raw context enters portable Chat files, activity events, SSE replay, CLI
read snapshots, paired-browser operations or ordinary logs. Reconnect reads
existing captures. No new remote or restricted-app observation authority is
introduced.

## First implementation slice

1. Prove the native path through the actual embedded work-fold client using an
   isolated deterministic provider: a third-party tool returns text and an
   image; the next model request receives both. Also exercise a generated image
   consumed by built-in `read`, non-image evidence, errors, and cancellation.
   Assert that compact UI events do not become a second model context. Use a
   native provider serializer with a local HTTP fixture to verify actual
   non-vision and `blockImages` handling separately from assembled context.
2. Add concise shared Assistant guidance for choosing observations, verifying
   the requested outcome, stating coverage and uncertainty, and stopping when
   further progress needs input. Apply it to fold and Space sessions through
   the existing Pi prompt assembly, preserving native instructions and Skills.
3. Add the read-only local context inspector and prove capture-stage fidelity,
   native hook preservation, auxiliary-call attribution, bounded retention,
   recording revocation, no capture side effects and exact-owner filtering.
   Fix the reviewed cancellation seam: native work may drain after Stop, but
   its late events cannot revive UI or overlap reuse of that session.
4. Use those fixtures as compatibility acceptance for each included integration.
   Implement the first real rendering and computer backends through native
   tools, adding only host facilities their actual behavior requires.

The first slice establishes a tested extension path and common behavior. It
does not bundle document runtimes, add an all-purpose observation tool, promise
autonomous correction by every model, or change the request-result envelope.

The shared foundation now includes the native-provider feedback fixtures,
the shared prompt appendix, cancellation draining, and the local inspector in
Space Chats, the fold and Settings → Assistant. The inspector uses the same
native transport for Assistant, title, Check, app inference and compaction
requests. Diagnostic attribution leaves the source-pinned Check implementation
and its enablement digest unchanged. Backend integration remains step 4;
its acceptance criteria below still apply before claiming a renderer or
computer integration is ready.

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

## Sources

- [Pi Extensions](https://pi.dev/docs/latest/extensions): native tool results,
  result hooks, guidance, Skills integration and terminal rendering.
- [Pi SDK](https://pi.dev/docs/latest/sdk): embedded sessions and native tools.
- The installed Pi 0.80.6 `createReadTool`, `convertToLlm` and `ToolDefinition`
  exports; work-fold's [Pi client](../src/local/agent/pi-client.ts) constructs
  native sessions and projects their events into bounded UI activity.
