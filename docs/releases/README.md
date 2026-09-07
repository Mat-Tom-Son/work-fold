# Release notes and candidate history

The [public Mac feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest)
is the authority for the newest available desktop update. A source tag or
release-note file alone does not mean a version was published.

## September 7, 2026 release candidate

[0.4.23](work-fold-0.4.23.md) completes the Space-app and web-fold integration
work. Its source candidate is ready for exact-main/tag CI and signed publication;
the public feed above remains authoritative for release availability.

## September 6, 2026 release record

| Version | State | Notes |
|---|---|---|
| [0.4.22](work-fold-0.4.22.md) | Published | Text-review diagnostics and all fixes from the unpublished 0.4.20/21 candidates |
| [0.4.21](work-fold-0.4.21.md) | Unpublished, superseded by 0.4.22 | Assistant guidance and command-palette fixes; tagged source remains immutable |
| [0.4.20](work-fold-0.4.20.md) | Unpublished, superseded by 0.4.22 | Desktop model-Check wiring; tagged source remains immutable |
| [0.4.19](work-fold-0.4.19.md) | Published | Fold-led Checks, trials, and reviewed corrections |
| [0.4.18](work-fold-0.4.18.md) | Unpublished; never tagged | Failed CI desktop smoke; corrected in the higher candidate |
| [0.4.17](work-fold-0.4.17.md) | Published | Folder-change triggers, text Checks, and recovery improvements |

0.4.22 source: `a785a7dbc2f9c5a8abe2c148923d0eff2c4dff8e`.
[Main CI](https://github.com/Mat-Tom-Son/work-fold/actions/runs/34062964042)
and [tag CI](https://github.com/Mat-Tom-Son/work-fold/actions/runs/34063187924)
passed for that exact commit. The signed/notarized distribution and all eight
remote asset checks passed before
[publication](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/tag/v0.4.22).
At the release handoff, the installed 0.4.19 app displayed the 0.4.22 update
button; the user reserved installation for themselves. This is update-discovery
evidence, not a claim that 0.4.22 replacement and relaunch were verified.

## Older notes

This directory preserves both work-fold and its predecessor Workspace records.
Use each document's title, date, and product identity: a numerically higher
legacy Workspace note is not a newer work-fold release. The old repositories
and their tags remain frozen. Historical commands and paths in those records
are not today's contributor instructions.

Follow the [current Mac runbook](../macos-release.md) for publication and the
[build-lane guide](../macos-build.md) to distinguish Local Smoke, a signed
interactive candidate, an installed app, and a public updater release.
