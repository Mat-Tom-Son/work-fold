# Claude Code project instructions

@AGENTS.md

`AGENTS.md` is the canonical contributor contract for this repository. This file intentionally imports it instead of copying it so Claude Code and Codex receive the same product rails, Pi Skill/Extension/tool boundaries, architecture rules, verification commands, and release policy.

Project Skills are exposed to Claude Code through tracked symlinks under
`.claude/skills/`; their canonical contents remain under `.agents/skills/`.
Follow the linked Skill when it applies, and never replace a symlink with a
Claude-only copy. Other `.claude/` files are machine-local state, not shared
repository instructions.
