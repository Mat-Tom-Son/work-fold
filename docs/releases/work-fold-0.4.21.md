# work-fold 0.4.21

September 6, 2026

Fixes model-backed Checks in the installed desktop app. The shared desktop
Check service now uses the fold's configured model for trials, enabled runs,
Routing-triggered reviews, and correction rechecks. Previously it could report
that model-backed Checks were unavailable even while ordinary chats worked.

Typing in the command palette no longer crashes the window. The renderer and
API now share the Space summary contract, also fixing Copy Path and folder
labels for duplicate Space names. Space search matches both names and paths.

Check help drafts now direct the Space Assistant to the exact commands for
preparing a correction. CLI help supplies its complete JSON contract and a
validated folder-change Routing example, so agents need not infer internal
formats or inspect app bundles. The Checks panel stays compact.

Live acceptance work exercised real model findings, reviewed corrections with
History and a clear recheck, and a folder-change chain that copies an approved
brief, delegates adoption to Editorial's Assistant, and runs its Check.
The integration suite now uses the actual injected desktop Check service.
A Routing migration test also keeps its receipts inside its temporary sandbox.

This includes the model wiring fix tested in the unpublished 0.4.20 candidate.
Existing Check declarations, enablement digests, and the bridge remain compatible.
No bridge deployment is required.
