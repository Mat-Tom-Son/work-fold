# App-requested Assistant work

A Space app can hand one of its named, declared requests to the Space's
Assistant. The request is journaled and dispatched in the same call: the host
creates a fresh ordinary Chat in the owning Space and starts the turn at once
(docs/receipts-not-gates.md, F22). The app reads that task's state and its
successful reply, or asks for it to stop. In **Apps → the app → Assistant
requests**, the person sees each request's status, its exact instructions and
input under **Details**, the reply once done, and **Open Chat** and **Stop**.
Nothing there waits for a click.

The Chat uses the Space's usual model, native Pi resources and full-trust
tools. Bounds on the request and the returned text keep envelopes sane; they
are not a filesystem or tool sandbox for the Assistant. No fold transcript,
other Space context, arbitrary Chat id, credential, model selection or
tool-policy override comes from the app request.

## Declaration and bridge

The optional top-level `assistantActions` array in `agent-app.json` declares up
to eight actions. Absent or empty declarations preserve existing normalized
manifest bytes. Each action has an id, a single-line title (80 characters),
static instructions (4,096 characters) and the same closed JSON Schema subset
used for app tools. An action may also declare `outputSchema` in that same
subset: declaring it is what lets the finished task come back with structured
`result.data`. A declaration names what the app may ask for; it starts nothing
by itself.

```json
{
  "assistantActions": [{
    "id": "compare",
    "title": "Compare quotes",
    "instructions": "Compare these quotes and save comparison.md in this Space.",
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

An active app view, a worker handling a tool action, and a named automation run
all reach the same bridge; nothing beyond installation is needed:

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
64 KiB; a larger input is refused with a message naming the limit and the
Settings → The fold → Limits section. New requests must carry a canonical UTC
timestamp within 15 minutes (at most one minute ahead for clock skew). A
replayed envelope returns the same record; changing its input conflicts. The
app cannot choose another Space or read arbitrary task or Chat ids. Shared
viewers and remote app views have no Assistant bridge. Private browser worker
actions use their separate action lane, which runs a request on acceptance
(see [browser app views](fold-browser-apps.md#actions)).

Task states are `dispatching`, `running`, `succeeded`, `failed`, `cancelled`
and `interrupted`; every task carries `startedAt`, its dispatch time. A
settled task also carries `model` (`provider`, `id`) and `usage`
(`inputTokens`, `outputTokens`, and `amountUsd` when the model carries pricing)
— the same two fields bounded inference returns, described under
[Model and usage](#model-and-usage) below. A
requested stop leaves a running task running, with `cancellationRequested:
true`, until the ordinary turn actually settles. Failed, cancelled and
interrupted tasks expose no result at all — no partial reply and no private
provider error. `list` contains at most 50 summaries, active requests first,
with no result. Only what the task reported, or its final reply, is shared;
other messages in its Chat are never app-readable.

## The result

A successful `get` returns one result shape
([Collaboration contract](collaboration-contract.md), F29), the same envelope a
report, a handoff outcome, and a routing chat hop produce:

| Field | What it is |
|---|---|
| `summary` | text, at most 32 KiB, never split mid-character |
| `outcome` | `succeeded`, `partial`, or `failed` — the Assistant's own account |
| `truncated` | the envelope did not fit its ceiling and what the app holds is trimmed |
| `data` | present only for an action that declared `outputSchema`, and only when the reported value matches it |
| `files` | Space-relative deliverables the Assistant named, each with `path`, `sha256`, and `sizeBytes` |

The Assistant files that envelope with `work-fold chat report` during its turn.
If it does not, the turn's final reply becomes the summary, the outcome is
`succeeded`, and there are no details or files. `files` are the deliverables the
Assistant chose to hand back; the turn's own `fileChanges` metadata stays
evidence and never becomes a deliverable list.

Details that do not match the declared `outputSchema` — or details reported for
an action that declared none — are left out, the outcome becomes `failed`, and
the summary says so in a sentence naming the declared shape. The validation
happens twice: once when the report is filed against the shape on the request
record, and again when the result is projected to the app.

The whole serialized envelope is bounded at 256 KiB. Over that, `data` is
dropped first, then `files` are trimmed, then the summary, and `truncated`
becomes true. **Apps → the app → Assistant requests** names that number and the
Settings section where a person can raise it, and offers **Open Chat** for the
full reply.

## Knowing a task moved

`bridge.tasks.onChanged(listener)` fires when this installation's own Assistant
tasks or inference receipts move: `{ revision, taskIds, receiptIds }`. Active
views get it, and so does a worker while it holds a tool action or an automation
run — the same mounts that may read `assistant.list()` at all. It carries ids
and an ordering revision, never content: re-read with `assistant.list()` or
`assistant.get()`. Nothing is replayed, and a hint never starts a model turn.
See [Invalidation hints](restricted-app-authoring.md#invalidation-hints).

## Bounds

Up to four requests may be starting or running per installation. A fifth is
refused with a message that names the limit and the Settings section. The
15-minute replay window and the 24-hour receipt retention are fixed; terminal
receipts older than a day prune on the next submission, and their original
timestamps can no longer submit fresh work. The journal caps at 1,000 receipts
and 64 MiB and refuses more work rather than dropping live receipts. A result
summary is bounded at 32 KiB, reported details at 256 KiB, deliverables at 32
entries, and the whole envelope at 256 KiB; `limits.get()` publishes all four
under `assistant`.

While any of an app's request Chats runs, capability changes for that Space
(grant, revoke, install, update) wait with "Wait for affected Assistant work to
finish". Stop the request first, or let it finish.

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
same Space is never charged to it.

`assistant.get` and `assistant.list` carry `model` and `usage` to the app, and
**Apps → the app → Assistant requests** shows them as one compact line under
each request:

```
anthropic · claude-sonnet-4-5 · 12048 in · 486 out · $0.0312
```

Short answers carry the same two fields under the same names, so both app AI
lanes read alike. Neither records prompt or reply content in that receipt.

## Bounded inference

`assistant.request` is the app's way to ask for full Assistant work. Its
sibling, `assistant.infer`, is the app's way to ask one question of the
Space's configured model and get an answer back. It runs with no tools, no
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
`usage` (`inputTokens`, `outputTokens`).

An active app view or a worker holding a tool action or an automation run may
call it. An inactive view, a worker between operations, a viewer page, and a
remote app view all get `INFER_UNAVAILABLE`. The installation, revision, and
authority are pinned before the call and rechecked before the result is
delivered.

Bounds: instructions 16 KiB, input 256 KiB, schema 32 KiB, output 64 KiB by
default and `maxOutputBytes` up to 256 KiB, four calls running and twelve
waiting per installation, eight running machine-wide, and a 120-second budget
covering time spent waiting for a slot. `limits.get().inference` publishes them
and Settings → The fold → Limits shows them. Check runs still serialize their
model requests machine-wide; inference deliberately does not share that queue.

Every refusal names what it hit: `INFER_INVALID`, `INFER_INPUT_TOO_LARGE`,
`INFER_MODEL_UNAVAILABLE`, `INFER_BUSY`, `INFER_OUTPUT_TOO_LARGE`,
`INFER_OUTPUT_INVALID`, `INFER_INTERRUPTED`, `INFER_FAILED`, and
`INFER_UNAVAILABLE`. Provider diagnostics never cross the bridge.

Each call appends an accepted line and then an `ok` or `error` line to the
machine-local `restricted-apps/inference-receipts.jsonl` journal, recording the
surface, byte sizes, the effective model, and its usage — never the app's
content. The Apps tab lists an installation's receipts across code changes. An
unreadable journal is moved aside and a fresh one starts: lost attribution
never stops an app from working.

## Authority, receipts and recovery

The host derives and pins the Space, Feature Installation, exact package digest
and authority generations. The request journal stores the instructions and
canonical input the Chat received. App and grant mutations and task admission
serialize through the same app service. A changed authority makes the old
revision's tasks invisible to the app bridge; the trusted Apps tab still lists
an installation's requests across code changes, so a task started before a
change can be opened and stopped. Once dispatched, the Chat is ordinary Space
work; closing the app view does not stop it.

The machine-local `restricted-apps/assistant-tasks.json` journal (schema v2; a
v1 journal loads with its never-dispatched requests marked stopped) is written
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
owning Space. App data backup and restore do not restore requests.

Each request is a receipt in the journal, not a grant: the app was installed,
so it may ask; the person sees what it asked for and what came back. The CLI
and remote management facade gain no generic Assistant endpoint from this. The
app bridge gets only request, list, get and cancel; the authenticated renderer
owns Details, Open Chat and Stop.

Traffic in the other direction has its own verbs: the fold sees an
installation's declared tools, actions, grants, connections and automations
with `work-fold apps list --space <id> --json` and calls one with
`work-fold apps invoke --space <id> --app <id> --tool <name> --input <json>`,
which runs through the app service with lineage and a receipt
([Receipts, not gates](receipts-not-gates.md), F22; the verb rows are in the
[act ledger](fold-act-ledger.md)). That is the fold reaching into an app, not
an app reaching out of its Space.
