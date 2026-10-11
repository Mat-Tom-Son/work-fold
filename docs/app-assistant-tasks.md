# App-requested Worker work

A work-folder app can hand one of its named, declared requests to the work-folder's
Worker. The request is journaled and dispatched in the same call: the host
creates a fresh ordinary Chat in the owning work-folder and starts the turn at once
(docs/receipts-not-gates.md, F22). The app reads that task's state and its
successful reply, or asks for it to stop. In **Settings → Apps → the app →
Worker requests**, the person sees each request's status, its exact instructions and
input under **Details**, the reply once done, and **Open Chat** and **Stop**.
Nothing there waits for a click.

The Chat uses the work-folder's usual model, native Pi resources and full-trust
tools. Bounds on the request and the returned text only keep one request's
memory and journal footprint finite; they are not a filesystem or tool sandbox
for the Worker and not a quota on how much an app may ask. No work-fold agent transcript,
other work-folder context, arbitrary Chat id, credential, model selection or
tool-policy override comes from the app request.

## Declaration and bridge

The optional top-level `assistantActions` array in `agent-app.json` declares
any number of actions. Absent or empty declarations preserve existing normalized
manifest bytes. Each action has an id, a single-line title (80 characters),
static instructions of any length, and the same closed JSON Schema subset
used for app tools. An action may also declare `outputSchema` in that same
subset: declaring it is what lets the finished task come back with structured
`result.data`. A declaration names what the app may ask for; it starts nothing
by itself.

```json
{
  "assistantActions": [{
    "id": "compare",
    "title": "Compare quotes",
    "instructions": "Compare these quotes and save comparison.md in this work-folder.",
    "inputSchema": {
      "type": "object",
      "properties": { "quotes": { "type": "string", "maxLength": 4000 } },
      "required": ["quotes"],
      "additionalProperties": false
    },
    "outputSchema": {
      "type": "object",
      "properties": { "cheapest": { "type": "string", "maxLength": 80 } },
      "required": ["cheapest"],
      "additionalProperties": false
    }
  }]
}
```

An active app view, the app's worker handling a tool action, and a named
automation run all reach the same bridge; nothing beyond installation is needed:

```js
const bridge = globalThis.workFoldRestrictedApp;
// Save this envelope in app storage before sending. Replay the same envelope
// after an uncertain response; do not regenerate its identity or timestamp.
const request = {
  requestId: crypto.randomUUID(),
  requestedAt: new Date().toISOString(),
  actionId: "compare",
  input: { quotes: "North: $42; South: $48" }
};
const task = await bridge.assistant.request(request); // status: "running"
const recent = await bridge.assistant.list();
const current = await bridge.assistant.get(request.requestId);
await bridge.assistant.cancel(request.requestId);
```

The request envelope has exactly those four fields. JSON input is at most
4 MiB; a larger input is refused with a message naming the bound. New
requests carry a canonical UTC timestamp as part of their idempotency record.
A replayed envelope returns the same record; changing its input conflicts. The
app cannot choose another work-folder or read arbitrary task or Chat ids. Shared
viewers and remote app views have no `assistant` bridge. Private browser worker
actions use their separate action lane, which runs a request on acceptance
(see [work-folder apps in paired browsers](browser-apps.md#actions)).

Task states are `dispatching`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`
and `interrupted`; every task carries `startedAt`, its dispatch time. A
settled task also carries `model` (`provider`, `id`) and `usage`
(`inputTokens`, `outputTokens`, and `amountUsd` when the model carries pricing)
— the same two fields bounded inference returns, described under
[Model and usage](#model-and-usage) below. A
requested stop fences the request and its descendants immediately, with
`cancellationRequested: true`; running tools then finish their abort cleanup. Failed, cancelled and
interrupted tasks expose no result at all — no partial reply and no private
provider error. `list` contains at most 1,000 summaries, active requests first,
with no result. Only what the task reported, or its final reply, is shared;
other messages in its Chat are never app-readable.

The receipt follows the durable request across questions, answers and delegated
work. `waiting` has no final result and remains stoppable; it counts toward the
installation's active-request bound. Stop cancels outstanding descendants too.
Output-schema pins apply to every continuation in the owned Chat. Reported usage
is the total of settled request and descendant turns; `model` identifies the
latest reported model of the owned Chat, which may differ from child models.

## The trusted Apps experience

Settings → Apps displays each completed request's summary and selected file
buttons directly. Its authenticated installation list includes bounded summaries
and file references, without structured data; the sandboxed `assistant.list`
continues to omit results. Instructions, input, model usage, and structured result
details stay behind Details. A partial outcome reads **Partly finished**.

Waiting requests show the exact person question and its origin using the shared
[work presentation](collaboration-experience.md). The trusted detail response
includes the original accepted `taskId` so questions and recovery stay attached
to that request, even if another request later uses the same Chat. This adds no
question access to sandboxed or remote App views. **Open Chat** and request-wide
**Stop** remain available in the trusted screen.

## The result

Once the owned request completes, `get` returns one result shape
([Collaboration contract](collaboration-contract.md), F29), the same envelope a
report, a handoff outcome, and an automation chat hop produce:

| Field | What it is |
|---|---|
| `summary` | text, at most 4 MiB, never split mid-character |
| `outcome` | `succeeded`, `partial`, or `failed` — the Worker's own account |
| `truncated` | something was cut to fit a bound — the summary at 4 MiB, or the envelope at its 32 MiB ceiling — and what the app holds is the trimmed version |
| `data` | present only for an action that declared `outputSchema`, and only when the reported value matches it (at most 16 MiB) |
| `files` | work-folder-relative deliverables the Worker named, each with `path`, `sha256`, and `sizeBytes` |

The Worker files that envelope with `work-fold chat report` during its turn.
The latest own turn's latest report is selected. If that turn files none, its
final reply becomes the summary and the request determines the outcome, with
no details or files. `files` are the deliverables the
Worker chose to hand back; the turn's own `fileChanges` metadata stays
evidence and never becomes a deliverable list.

Details that do not match the declared `outputSchema` — or details reported for
an action that declared none — are left out, the outcome becomes `failed`, and
the summary says so in a sentence naming the declared shape. The validation
happens twice: once when `chat report` is filed, against the shape pinned on
the request receipt when the app asked — so the refusal names the property
while the Worker's turn can still correct it — and again when the result is
projected to the app.

The summary is bounded at 4 MiB on its own, before anything else is
considered, and that is the bound an ordinary long reply reaches. The whole
serialized envelope is then bounded at 32 MiB, room for a full-size summary and
full-size details together: over that, `data` is dropped first, then `files`
are trimmed from the end, then the summary. Either sets `truncated`, and an
envelope trim is never silent: the summary then opens with a bracketed sentence
naming the 32 MiB bound and exactly what was left out (its details, how many of
its files, or that the summary was shortened).
**Settings → Apps → the app → Worker requests** names both numbers and the Settings
section showing these fixed bounds (Settings → Automations → Limits), and offers
**Open Chat** for the full reply.

## Knowing a task moved

`bridge.tasks.onChanged(listener)` fires when this installation's own Worker
tasks or inference receipts move: `{ revision, taskIds, receiptIds }`. Active
views get it, and so does the app's worker while it holds a tool action or an
automation run — the same mounts that may read `assistant.list()` at all. It
carries ids and an ordering revision, never content: re-read with
`assistant.list()` or `assistant.get()` for tasks. Inference receipt ids support
the trusted receipt view in Settings → Apps; there is no app-bridge receipt
lookup. Nothing is replayed, and a hint never starts a model turn.
See [Invalidation hints](restricted-app-authoring.md#invalidation-hints).

## Bounds

Up to 32 requests may be starting, running or waiting per installation. The
33rd is refused with a message that names the limit and the Settings section.
There is no request quota: the 15-minute replay window and the 24-hour receipt
retention are fixed; terminal receipts older than a day prune on the next
submission, and their original timestamps can no longer submit fresh work. The
journal is one file kept under 256 MiB; reaching that prunes the oldest settled
receipts already outside the replay window, and work is refused only when live
and replayable receipts alone fill it. A result summary is bounded at 4 MiB,
reported details at 16 MiB, and the whole envelope at 32 MiB; `limits.get()`
publishes these bounds under `assistant`.

While any of an app's request Chats runs, capability changes for that work-folder
(grant, revoke, install, update) are refused with a message asking you to wait
for the affected Worker work to finish. Stop the request first, or let it finish.

## Model and usage

When the dispatched Chat turn settles, the durable turn journal records the
provider and model id that actually ran it and the usage Pi reported for that
turn, and the request receipt copies both. The same settlement writes the
outcome and the spend, so a turn that failed or was stopped still reports what
it used, and a turn that spent nothing — a built-in command, or a provider that
never reported a settled request — reports no usage at all.

`usage` carries `inputTokens` and `outputTokens`, plus `amountUsd` only when the
effective model carries pricing work-fold can apply. A model with no published
rates leaves the cost out: it is unknown, not zero. Token counts are measured
around that one turn, so a Chat title request or a bounded inference call on the
same work-folder is never charged to it.

`assistant.get` and `assistant.list` carry `model` and `usage` to the app, and
**Settings → Apps → the app → Worker requests** shows them as one compact line under
each request:

```
anthropic · claude-sonnet-4-5 · 12048 in · 486 out · $0.0312
```

Short answers carry the same two fields under the same names, so both app AI
lanes read alike. Neither records prompt or reply content in that receipt.

## Bounded inference

`assistant.request` is the app's way to ask for full Worker work. Its
sibling, `assistant.infer`, is the app's way to ask one question of the
work-folder's configured model and get an answer back. It runs with no tools, no
files, no conversation history, and nothing persisted to any transcript
(docs/receipts-not-gates.md, F22). Like requests, it needs no grant beyond
installation.

```js
const { text, truncated, model, usage } = await globalThis.workFoldRestrictedApp
  .assistant.infer({ instructions: "Name the cheapest quote.", input: "North $42, South $58" });

const { json } = await globalThis.workFoldRestrictedApp.assistant.infer({
  instructions: "Total the quotes.",
  input: quotesText,
  outputSchema: { type: "object", properties: { total: { type: "integer", minimum: 0 } },
    required: ["total"], additionalProperties: false },
});
```

`instructions` becomes the system prompt; `input` is delivered as the single
user message and framed as untrusted data, so an app's own content cannot
redirect the task. Non-text input is serialized host-side with two-space
indentation. Without `outputSchema` the result is `{ text, truncated }`; with
one — the same closed JSON Schema subset tool declarations use — the result is
`{ json }`, already validated against that schema, carried by one
`submit_result` tool call. Both shapes carry `model` (`provider`, `id`) and
`usage` (`inputTokens`, `outputTokens`). work-fold never cuts a reply:
`truncated` is true only when the model itself stopped at its output-token
limit, and the text is everything it produced; a reply larger than
`maxOutputBytes`, or a structured result the model could not finish, is
refused with `INFER_OUTPUT_TOO_LARGE`.

The call runs the way a Chat turn in the same work-folder would: on the work-folder's
configured model at the work-folder's configured thinking level (no reasoning option
when that level is off), with the model's own output-token limit, and with the
provider SDK's usual two retries for transient failures. The one adjustment is
the context window: once the request is in it, the output budget shrinks only
as far as the window requires, using the same estimate Pi uses to fit a reply
(3.5 characters per token and a 4,096-token safety margin). A request is
refused with `INFER_INPUT_TOO_LARGE` only when that estimate leaves no room for
at least a 1,024-token answer.

An active app view or the app's worker holding a tool action or an automation
run may call it. An inactive view, a worker between operations, a viewer page,
and a remote app view all get `INFER_UNAVAILABLE`. The installation, revision, and
authority are pinned before the call and rechecked before the result is
delivered.

Bounds: instructions 1 MiB, input 16 MiB, schema 1 MiB, and output 16 MiB
(`maxOutputBytes` may lower it); these only keep one call's memory finite, and
the model's context window is the real bound on input. Sixteen calls run per
installation with 256 more waiting, and 32 run machine-wide; later calls wait
for a slot. There is no fixed host timeout: provider transport, cancellation,
and authority revocation govern a dispatched call. `limits.get().inference`
publishes the effective values. Check runs still serialize their model requests
machine-wide; inference deliberately does not share that queue.

Every refusal names what it hit: `INFER_INVALID`, `INFER_INPUT_TOO_LARGE`,
`INFER_MODEL_UNAVAILABLE`, `INFER_BUSY`, `INFER_OUTPUT_TOO_LARGE`,
`INFER_OUTPUT_INVALID`, `INFER_INTERRUPTED`, `INFER_FAILED`, and
`INFER_UNAVAILABLE`. Provider diagnostics never cross the bridge.

Each call appends an accepted line and then an `ok` or `error` line to the
machine-local `restricted-apps/inference-receipts.jsonl` journal, recording the
surface, byte sizes, the effective model, and its usage — never the app's
content. Settings → Apps lists the latest event for each call across code changes,
with its limit applied to calls rather than journal lines. On startup, acceptance-only records receive an
`INFER_INTERRUPTED` event without replay or a claim about provider completion.
Only successfully written events enter the live receipt list. If a completion
cannot be recorded, its acceptance displays as Interrupted once the host no
longer owns the call; unknown model usage is not filled in. An
unreadable journal is moved aside and a fresh one starts: lost attribution
never stops an app from working.

## Authority, receipts and recovery

The host derives and pins the work-folder, Feature Installation, exact package digest
and authority generations. The request journal stores the instructions and
canonical input the Chat received. App and grant mutations and task admission
serialize through the same app service. A changed authority makes the old
revision's tasks invisible to the app bridge; the trusted Settings → Apps page still lists
an installation's requests across code changes, so a task started before a
change can be opened and stopped. Once dispatched, the Chat is ordinary work-folder
work; closing the app view does not stop it.

The machine-local `restricted-apps/assistant-tasks.json` journal (schema v3; a
v2 journal loads with each reply as its summary, and a v1 journal loads with its
never-dispatched requests marked stopped) is written
and synced before Chat dispatch. It pins one allocated Chat and turn request
id. The existing turn journal owns actual acceptance, progress, results and
restart recovery. A thrown or uncertain admission is reconciled with that
journal and never automatically retried: a crash before acceptance becomes
`interrupted`, and after acceptance the original turn outcome stays
authoritative. Replaying an envelope after a failure returns the failed record;
a new request is a new envelope.

Damage disables only this task lane without overwriting its evidence or
preventing work-fold startup. Task input and results stay machine-local; the
dispatched prompt and the normal reply also belong to the portable Chat in the
owning work-folder. App data backup and restore do not restore requests.

Each request is a receipt in the journal, not a grant: the app was installed,
so it may ask; the person sees what it asked for and what came back. The CLI
and the remote `management.*` facade gain no generic Worker endpoint from this. The
app bridge gets only request, list, get and cancel; the authenticated renderer
owns Details, Open Chat and Stop.

Traffic in the other direction has its own verbs: the work-fold agent sees an
installation's declared tools, actions, grants, connections and automations
with `work-fold apps list --work-folder <id> --json` and calls one with
`work-fold apps invoke --work-folder <id> --app <id> --tool <name> --input <json>`,
which runs through the app service with lineage and a receipt
([Receipts, not gates](receipts-not-gates.md), F22; the verb rows are in the
[act ledger](act-ledger.md)). That is the work-fold agent reaching into an app, not
an app reaching out of its work-folder.
