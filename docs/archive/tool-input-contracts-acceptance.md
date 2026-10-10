# Tool input contracts and Worker working files acceptance

October 8, 2026 — work-fold 0.4.44 development acceptance. Public distribution
is gated separately by the final-commit local release check and signed artifact
verification.

## Scope and trace

The reported GLM OCR loop contained twelve direct calls without `source`, even
though the reasoning named the path. Codemode later supplied it and succeeded.
The native session records establish the arguments received by Pi, not the raw
provider response. The former Documents schema required only `operation`;
operation-dependent requirements were absent before the Pi upgrade as well.

The cold native catalog audit covered 38 tools: built-ins, codemode/search,
Computer Control, Chrome, Web and Documents. Required inputs were already
declared by the built-ins, Computer Control, Web and codemode/search. Seven
included declarations needed reviewed alternatives: document_engine and Chrome
inspect, click, hover, tap, drag and upload. MCP declarations remain owned by
their servers; the shared error feedback covers those tools too.

The shared native hooks append correction guidance to failed tool results and
to finalized validation errors, preserving existing observations, structured
data, error state and accounting. They do not infer arguments, re-execute tools,
or change permission/cancellation behavior. Native serializer tests verify the
guidance reaches the next provider request for direct and nested failures.

## Adversarial runtime pass

The initial root-level alternatives passed local validation and GLM, but live
GPT-4.1 Mini requests were rejected by OpenAI/Azure with
`invalid_function_parameters`. That design was replaced before publication.
[OpenAI's supported schemas](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)
allow nested alternatives and require an object at the root. The seven reviewed
tools now take a required `input` object containing their native parameters;
the adapter forwards that exact object and native lifecycle arguments.

Coverage checks missing/empty targets, partial pointer coordinates, zero
coordinates, all nine drag endpoint combinations, per-operation source/output
requirements, and preservation of blank tabs, viewport observations/scrolling
and empty focused-field input. A real native Chrome bridge fixture verifies
execution and observations. The packaged-archive smoke uses the new public
shape and requires the shared helper in the archive.

## Real provider acceptance

The supplied OpenRouter key was injected into memory in a separate app/Pi
profile, with disposable work-folder fixtures.

- **GLM-5.2:** the final schema was discovered through codemode; status and OCR
  direct calls used the declared `input` object. OCR correctly returned invoice
  1042 and USD 125.00. The original image hash was preserved, scratch went under
  `.worker/<task-id>/`, and the deliverable was written outside it. No tool
  failed in this final regression turn.
- **GPT-4.1 Mini:** the final catalog was accepted. An intentional missing-file
  read and a nested missing-argument read each failed once, retained their
  original errors and received the guidance once. Correct direct and nested
  reads then succeeded. An incidental Computer Control read used an invalid
  observation handle, received the same guidance and was not repeated. The
  delivered report and input bytes were checked independently.
- **GPT-4.1 Mini OCR:** direct status/OCR and native read succeeded with the
  nested declaration. The source remained unchanged and the deliverable was
  outside scratch. This model used `.worker/` without a task subfolder, so the
  convention is taught behavior, not an enforced filesystem boundary.

An earlier, longer GLM run correctly OCR'd both the original and preprocessed
image and corrected its own verification regex. It also attempted the CLI before
the dev-only launcher was on PATH and honestly reported that limitation. The
final tests used the matching development CLI launcher. No installed production
profile or application was changed.

## Frontend and cross-system pass

Computer use verified the muted folder in light and dark modes, expansion,
keyboard selection and opening, context menus, ordinary file preview, actual
saved Version History and attachment to Chat. A running Chat remained active
while Files was selected. Renderer interaction tests cover keyboard rename and
menus; filesystem tests cover visibility, search and restoration of independent
scratch subfolders. `.worker/` is not added to hidden/reserved paths or ignore
rules. Selected/drop-target styles retain their existing cascade; the new rules
affect only the top-level ordinary folder's resting name and icon.

The shared Worker appendix is scoped to work-folder sessions, respects existing
project edits and contents, and asks about file/link/registered-folder collisions.
Registration creates nothing. History, Search, attachments, Checks and grants
continue to use their normal boundaries and explicit ignore settings.
