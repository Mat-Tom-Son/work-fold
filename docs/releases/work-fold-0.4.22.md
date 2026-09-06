# work-fold 0.4.22

September 6, 2026

Includes the desktop Check wiring, command-palette crash fix, and Assistant
correction and Routing guidance tested in the unpublished 0.4.20 and 0.4.21
candidates. Model-backed Checks now use the fold's configured model throughout
trials, enabled runs, Routing reviews, and correction rechecks. Space search
matches names and paths, and Check help gives the Space Assistant the complete
correction contract while keeping the Checks panel compact.

Text Checks give the model clearer field descriptions and an explicit response
format. Invalid responses identify the affected finding and field without
logging or displaying raw model text. Output-limit and interruption failures
have distinct messages. Invalid or partial reviews remain errors, never clear
results, and Checks still cannot edit files or retry a provider automatically.

Existing text Checks require explicit re-enablement because the reviewed
sensor implementation changed. Their declarations and designated files are
preserved. Deterministic Checks and the web bridge are unchanged.

Regression coverage includes optional suggestions, malformed field types,
missing and extra fields, bounded single-paragraph text, partial findings,
truncated submissions, and private diagnostic suppression.

Live acceptance verified two real findings, separate reviewed corrections with
History, a clear recheck, and a fold-managed copy and delegation to Delivery's
Assistant followed by its required-files Check. The earlier folder-change
Routing test also completed successfully; its watcher was disabled afterward.
