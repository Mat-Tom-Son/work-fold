# work-fold 0.12.1

October 20, 2026

This release improves Worker continuity when long conversations are summarized or work resumes after an answer.

- **Keep recovery navigable.** Compact recovery pages retain their cursors and source information within Pi's result limits. Short evidence rows stay together; oversized lines remain recoverable without losing text.
- **Remember the assignment.** Workers retain the original task separately from the latest answer, so summarization does not replace their goal with a brief continuation message.
- **Recover through Code Mode.** Progress tools return typed structured results, fixing a missing-cursor loop when Code Mode reads earlier evidence.
- **Use evidence and numbers carefully.** Shared guidance encourages reuse of applicable evidence, exact decimal calculations from original text, and literal output contracts.

Regression tests cover paging, assignment recovery, structured output, and evaluation checks. Repeated frozen real-model evaluations exercised research, reconciliation, and code repair under normal and stressed context settings. The final cohort passed 35 of 36 first attempts; one provider stream stalled after producing correct files. These small trials do not establish a production success rate or guarantee that model-written evidence is correct.

See the [evaluation report](../frozen-autonomy-evaluation.md) for the full comparison and limitations, and [Worker tools](../worker-tools.md) for recovery behavior.

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
