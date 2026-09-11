# Release notes and candidate history

The [public Mac feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest)
is the authority for the newest available desktop update. A source tag or
release-note file alone does not mean a version was published.

## September 11, 2026

[0.4.24](work-fold-0.4.24.md) brings durable Assistant collaboration, inline
questions and results, reversible actions, and direct App AI primitives.
The public Mac feed remains the authority for publication and availability;
release notes do not replace the exact source-tag and artifact checks.

## September 7, 2026 release record

[0.4.23](work-fold-0.4.23.md) is [published](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/tag/v0.4.23).
Release source: `da0bb6cd5b3eceeb6957f75cdd46b2c7103b73f8`.
[Main CI](https://github.com/Mat-Tom-Son/work-fold/actions/runs/34099439746)
and [tag CI](https://github.com/Mat-Tom-Son/work-fold/actions/runs/34099870878)
passed for that exact SHA. The signed/notarized arm64 distribution passed strict
verification and all eight GitHub asset digests matched before publication.
The updater ZIP SHA-256 is
`874d138953cbaac94a1a52602147555fd1fd8c142a5d83d4c0d0652b94ca7bbd`.

The production Railway bridge deployment
`73e8aa12-5467-404e-ad8c-6170a2323a85` succeeded. Its health endpoint reported ready,
and the deployed browser entrypoint, app view, API-path helper and file preview
matched committed bytes. The installed Applications copy remains 0.4.22;
its newer-data recovery screen successfully offered 0.4.23 with **Download and
Install**. The user reserved that click: replacement and relaunch are not claimed.

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
