# App-requested Assistant work

Status: implemented on the development branch. Automated Pi tool-loop and native
Electron tests pass; live review, failure, navigation and restart checks pass.
Successful live-model acceptance is pending a provider connection in the
isolated test profile and remains required before release.

A Space app can ask for one of its reviewed, named Assistant tasks. The request
starts inert. In **Apps → the app → Assistant requests**, the person opens
**Review**, reads the instructions and input, and clicks **Run in this Space**.
The host creates a fresh ordinary Chat in the owning Space. The app can read
that task's state and successful reply, or request its cancellation. **Open
Chat** exposes the ordinary transcript and deliverables to the person.

This uses the Space's usual model, native Pi resources and full-trust tools.
The review states that the reply is shared with the app. Bounds on the request
and returned text are not a filesystem or tool sandbox for the Assistant.
No fold transcript, other Space context, arbitrary Chat id, credentials, model
selection or tool-policy override comes from the app request.

## Declaration and bridge

The optional top-level `assistantActions` array in `agent-app.json` declares up
to eight actions. Absent or empty declarations preserve existing normalized
manifest bytes. Each action has an id, a single-line title (80 characters),
static instructions (4,096 characters) and the same closed JSON Schema subset
used for app tools. Declarations never start work or enable standing power.

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
    }
  }]
}
```

Only an active native app view can use the bridge:

```js
const bridge = globalThis.workFoldRestrictedApp;
// Save this envelope in app storage before sending. Retry the same envelope
// after an uncertain response; do not regenerate its identity or timestamp.
const request = {
  requestId: crypto.randomUUID(),
  requestedAt: new Date().toISOString(),
  actionId: "compare",
  input: { quotes: "North: $42; South: $48" }
};
const task = await bridge.assistant.request(request);
const recent = await bridge.assistant.list();
const current = await bridge.assistant.get(request.requestId);
await bridge.assistant.cancel(request.requestId);
```

The request envelope has exactly those four fields. JSON input is at most
8 KiB. New requests must have a canonical UTC timestamp within 15 minutes
(at most one minute ahead for clock skew). Retries of retained requests return
the same record; changing their input conflicts. The app cannot call review or
approval, choose another Space, or read arbitrary task/Chat ids. Workers,
automations, shared viewers and remote app views have no delegation bridge in
this slice. Approved-browser support is a separate remaining goal slice.

Task states are `pending`, `dispatching`, `running`, `succeeded`, `failed`,
`cancelled`, `interrupted` and `expired`. A requested stop leaves a running task
running, with `cancellationRequested: true`, until the ordinary turn actually
settles. Failed/interrupted tasks expose no partial reply or private provider
error. Successful `get` returns `result: { text, truncated }`, bounded to 32 KiB
without splitting a UTF-8 character. The list contains at most 50 summaries,
active requests first, with no reply text. Only the task's successful reply is
shared; other messages in its Chat are never made app-readable by this grant.

## Authority and recovery

The host derives and pins the Space, Feature Installation, exact package digest
and authority generations. The request journal stores the reviewed instructions
and canonical input; the clicked review digest covers those immutable values.
App/grant mutations and task admission serialize through the same app service.
Changed authority blocks both approval and delivery to the old revision.
Ordinary Space capability-mutation fences refuse app changes while the accepted
Assistant turn is active. Stop that task first. Once authorized, the Chat is
ordinary Space work; closing its app view does not stop it.

The machine-local `restricted-apps/assistant-tasks.json` journal is written and
synced before Chat dispatch. It pins one allocated Chat and turn request id.
The existing turn journal owns actual acceptance, progress, results and restart
recovery. A thrown/uncertain admission is reconciled with that journal; it is
never automatically retried. A crash before acceptance becomes interrupted;
after acceptance the original turn outcome remains authoritative. A person
may submit and review a new request after a failure, but a repeated approval
of the old request never sends another turn.

At most four pending/running requests and one running task belong to an
installation. Pending reviews expire after 24 hours. Terminal receipts older
than 24 hours are pruned on new submissions; their original timestamps can no
longer submit fresh work. The journal caps at 1,000 receipts and 64 MiB and
refuses more work rather than dropping live decisions. Damage disables only
this task lane without overwriting its evidence or preventing work-fold startup.
Task input/results remain machine-local; the explicitly accepted prompt and
normal reply also belong to the portable Chat in the owning Space. App data
backup/restore does not restore requests, task approval or authority.

This is a one-off Chat send after a trusted human review, not a standing grant
or a new kind of staged consecration. Root authority and standing-policy rules
stay with their existing verbs. The CLI and remote management facade gain no
new generic Assistant or approval endpoint. Native apps get only the narrow
request/list/get/cancel adapter; the authenticated renderer owns review and Run.
