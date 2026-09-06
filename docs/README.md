# Documentation map

Start with [the product model](product-model.md) for product scope and
[AGENTS.md](../AGENTS.md) for contributor rules. This map separates current
contracts from design rationale and unshipped ideas; a proposal is not an
instruction to implement its contents.

## Current contracts

| Area | Read |
|---|---|
| Product and contributor workflow | [Product model](product-model.md), [Contributing](../CONTRIBUTING.md), [Architecture](architecture.md) |
| The fold and authority | [Decision register](fold.md), [Management and CLI](management-layer.md), [Act ledger](fold-act-ledger.md), [Staged decisions and policies](fold-consecrations.md) |
| Checks and automation | [Checks](checks.md), [Routings](fold-routings.md), [The glance](fold-glance.md) |
| Native Assistant capabilities | [Skills, Extensions, packages, and scopes](assistant-capabilities.md), [Pi resources](pi-resources.md), [Declarative Extension surfaces](extension-surfaces.md) |
| Restricted Space apps | [Authoring](restricted-app-authoring.md), [Runtime](restricted-app-runtime.md), [App platform foundation](app-platform-foundation.md) |
| Web access and sharing | [Bridge operations](../services/bridge/README.md), [Publishing and viewers](fold-publishing.md), [Privacy](../PRIVACY.md), [Security](../SECURITY.md) |
| Desktop interaction and appearance | [Desktop parity](ui-parity.md), [Visual system](visual-design.md), [Space customization](space-customization.md) |
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
- work-fold's runtime fold instructions and `manage-spaces` Skill are generated
  from `src/local/management-instructions.ts`. They are app resources, not
  copies of the repository's contributor contract.
- The [filing Skill](reference-skills/organize-dropped-material/SKILL.md) is a
  reference example, not an automatically installed project Skill. Its
  cross-Space workflow belongs in the fold.
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
| [Checks expansion](checks-expansion.md) | Shipped decisions reconciled with remaining proposals; the Checks register wins |
| [Next product directions](next-product-directions.md) | Proposed priorities for discussion, not accepted scope |
| [App platform exploration](app-platform-exploration.md) | Completed exploration; the accepted foundation wins |
| [Runtime spike evidence](app-platform-runtime-spike-evidence.md) | Disposable experiment evidence, not production-service proof |
| [Fold integration](fold-integration.md) | Promotion history and explicitly held decisions |
| [Appearance role inventory](customization-role-inventory.md) | Historical CSS census; re-audit current consumers before continuing migration |
| [T3 Code audit](t3code-reference-audit.md) | Dated reference snapshot, not current product gaps |
| [Rebrand launch plan](work-fold-rebrand-plan.md) | Historical clean-break launch evidence and original checklist |
| [Windows build](windows-build.md), [Windows releases](windows-release.md) | Inactive platform references; no Windows gate on Mac releases |

## Keep the map accurate

Update the owning contract when behavior changes, and reconcile proposals that
would otherwise contradict it. Preserve dated release and exploration records
as history rather than globally replacing old names or version numbers. Check
relative links, referenced npm scripts, shared Skill symlinks, and
`tests/documentation-contract.test.ts` after documentation maintenance. Use the
usual behavior and release gates only when those surfaces actually change.
