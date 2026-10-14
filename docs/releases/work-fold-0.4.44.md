# work-fold 0.4.44

October 8, 2026

This update improves tool input contracts and gives Workers an ordinary place
for working files.

- Failed tool calls carry shared correction guidance across built-ins,
  Extensions, Service Connections and codemode. Original errors and evidence
  remain available, including native validation failures. Calls are never
  automatically repaired or retried by this guidance.
- Documents declares the source/output requirements for each operation.
  Chrome declares complete element, pointer and drag targets. Their reviewed
  alternatives use a required `input` object compatible with OpenAI function
  schemas; native defaults and cancellation remain intact.
- Workers are taught to keep intermediate files in `.worker/<task-id>/` and
  deliver requested files outside it. The top-level `.worker` folder is subtly
  muted in Files and remains available under normal Files, Search, History,
  attachment and Check rules. Existing project edits stay in place.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
