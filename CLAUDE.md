# Claude Code project instructions

@AGENTS.md

`AGENTS.md` is the canonical contributor contract for every harness. Start with
its First visit section. Keep this entrypoint thin; edit shared policy there.

Project Skills in `.claude/skills/` are tracked symlinks to `.agents/skills/`.
Edit the canonical source, never a Claude-only copy. Other `.claude/` files
are machine-local state. See [Development](docs/development.md#agent-setup-and-shared-skills)
for discovery and Skill maintenance.
