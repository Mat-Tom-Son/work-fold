# Documentation map

## Current product language

Current user-facing documentation uses **work-folder** for the ordinary registered
working folder, **Worker** for its AI assistant, **work-fold agent** for the
management Worker above all work-folders, and **Automation** for the deterministic
cross-work-folder feature formerly presented as Automations. Technical contracts keep
their established identifiers (`work-folder`, `fold`, `automation`, `work-fold
automations`, and related paths, schemas, and API fields) until a separately
designed domain migration. Historical release notes, dated evidence, quoted
copy, and code examples retain the names they recorded.

For a first checkout, start with [Contributing](../CONTRIBUTING.md) and
[Development](development.md). Read [the product model](product-model.md) for product scope and
[AGENTS.md](../AGENTS.md) for contributor rules. This map separates current
contracts from design rationale and unshipped ideas; a proposal is not an
instruction to implement its contents.

## Current contracts

| Area | Read |
|---|---|
| Product and contributor workflow | [Product model](product-model.md), [Contributing](../CONTRIBUTING.md), [Development](development.md), [Architecture](architecture.md) |
| The work-fold agent and receipts | [Decision register](work-fold-agent-decisions.md), [Receipts, not gates](receipts-not-gates.md), [Collaboration contract](collaboration-contract.md), [Management and CLI](work-fold-agent-and-cli.md), [Act ledger](act-ledger.md) |
| Checks and Automations | [Checks](checks.md), [Automations (technical automation contract)](automations.md), [The overview](work-fold-agent-overview.md) |
| Native agent capabilities | [Skills, Extensions, packages, and scopes](skills-and-extensions.md), [Pi resources](pi-resources.md), [Declarative Extension surfaces](extension-surfaces.md) |
| Restricted work-folder apps | [Authoring](restricted-app-authoring.md), [Runtime](restricted-app-runtime.md), [App platform foundation](app-platform-foundation.md) |
| Web access and sharing | [Bridge operations](../services/bridge/README.md), [Publishing and viewers](shared-pages.md), [Privacy](../PRIVACY.md), [Security](../SECURITY.md) |
| Desktop interaction and appearance | [Desktop parity](ui-parity.md), [Collaboration experience](collaboration-experience.md), [Visual system](visual-design.md), [Application appearance](application-appearance.md), [work-folder customization](work-folder-customization.md) |
| Mac distribution | [Build lanes](macos-build.md), [Release procedure](macos-release.md), [Release notes and candidate history](releases/README.md) |

The App platform's [ontology](app-platform-ontology.md),
[publication/data contracts](app-platform-publication-data.md), and
[portable runtime contract](app-platform-runtime-contract.md) are accepted
supporting design contracts. The foundation's **Current local boundary** and
**Implemented local product boundary** identify what is implemented. Accepted
hosted-runtime semantics do not imply a deployed cloud runtime. Desktop-served
viewer pages and app views are a separate shipped capability.

## Harness and example boundaries

- `AGENTS.md` is canonical. [CLAUDE.md](../CLAUDE.md) imports it.
- The shared [release Skill](../.agents/skills/ship-macos-release/SKILL.md)
  lives under `.agents/skills/`; `.claude/skills/ship-macos-release` is a
  tracked symlink to that exact directory. Other `.claude/` and `.codex/`
  content is ignored machine-local state. There is no separate `.agent/`
  contract.
- The work-fold agent's runtime instructions and `manage-work-folders` Skill are generated
  from `src/local/work-fold-agent-instructions.ts`, and the compact operations guide
  every work-folder turn receives is generated from
  `src/local/agent/work-folder-operations-guide.ts`. They are app resources, not
  copies of the repository's contributor contract.
- The [filing Skill](reference-skills/organize-dropped-material/SKILL.md) is a
  reference example, not an automatically installed project Skill. Its
  cross-work-folder workflow belongs in the work-fold agent.
- [Connected inbox](../examples/packages/connected-inbox/README.md) is a
  full-trust Pi Extension. [Restricted Connected inbox](../examples/packages/restricted-connected-inbox/README.md)
  is the separate sandboxed-app example. Neither is an installed account
  integration merely because its source is checked in.
- [Brand assets](../desktop/assets/brand/README.md) and the
  [designer pack](../desktop/assets/brand/pack/README.md) describe asset
  provenance and generation, not another product policy.

## Rationale, proposals, and historical records

| Document | How to use it |
|---|---|
| [Extensions and computer work](extension-foundation.md) | Shared Extension design, first interaction implementation, inclusion candidates and outstanding compatibility/release work |
| [Feedback during agent work](tool-feedback.md) | General native-tool feedback contract, adversarial review decisions, local model-context inspection and implementation evidence |
| [Collaboration contract](collaboration-contract.md) | The built wave B specification (accepted 2026-09-11): durable requests, work-folder turn context, report/ask/answer/handoff, one result shape, app change hints — also listed under current contracts |
| [Receipts, not gates](receipts-not-gates.md) | Accepted 2026-09-10 direction and the specification the canonical documents now follow: one authority mode, reversible destruction, apps that come up able to work; supersedes F3–F7 and F17, narrows F8, F9, F18 |
| [Windows build](windows-build.md), [Windows releases](windows-release.md) | Inactive platform references; no Windows gate on Mac releases |

Finished plans, superseded designs, and dated evidence live in the
[archive](archive/README.md).

## Keep the map accurate

Update the owning contract when behavior changes, and reconcile proposals that
would otherwise contradict it. Preserve dated release and exploration records
as history rather than globally replacing old names or version numbers. Run `npm run repo:check` after documentation maintenance to check relative
links, current npm commands, ignore rules, and all shared Skill symlinks. Use the
usual behavior and release gates only when those surfaces actually change.
