# work-fold 0.4.20

September 6, 2026

Fixes model-backed Checks in the installed desktop app. The desktop's shared
Check service now reaches the fold's configured model for trials, enabled runs,
Routing-triggered reviews, and correction rechecks. Previously it could report
that model-backed Checks were unavailable even when ordinary chats worked.

The fix preserves one service for desktop, CLI and Routing state. The transport
is lazy, in-process, and serialized; status reads do not start a model. An
integration test now uses the actual desktop service composition through the
proposal, trial, live finding, correction review, apply, and recheck workflow.

This corrective release retains the fold-led workflow and compact Checks UI
from 0.4.19. Check declarations and enablement digests remain compatible. No
bridge deployment is required.
