import { productIdentity } from "./product-identity.js";

/** The names the skill speaks; the identity file supplies both, so a rename changes them here too. */
export interface OutsideAgentSkillIdentity {
  productName: string;
  cliCommand: string;
}

/** The skill's own name and the folder it lives in under another agent's skills folder. */
export function outsideAgentSkillName(identity: OutsideAgentSkillIdentity = productIdentity): string {
  return identity.cliCommand;
}

/**
 * The skill another AI agent (Claude Code, Codex, or any agent that reads
 * SKILL.md) uses to drive this app through its command (owner request,
 * 2026-11-07). It stays short on purpose: the rules, how to look around, and
 * the few recipes an outside agent needs, each a real command line. For
 * anything more it sends the agent to the command's own help, which is always
 * current, so the skill never becomes a second copy that drifts.
 * tests/outside-agent-skill.test.ts checks every command it cites against
 * that help.
 */
export function outsideAgentSkill(identity: OutsideAgentSkillIdentity = productIdentity): string {
  const product = identity.productName;
  const cli = identity.cliCommand;
  const agent = `${product} agent`;
  return `---
name: ${outsideAgentSkillName(identity)}
description: Drive ${product} on this Mac from the command line. List work-folders, hand work to a folder's Worker and wait for the result, ask the ${agent} to coordinate across folders, follow requests, undo changes, and run Automations. Use when the person asks you to do something in their ${product} work-folders or with their Workers.
---

# ${product}

${product} gives folders on this computer their own AI Worker. A **work-folder** is an ordinary folder with a Worker of its own, and work-folders can sit inside other work-folders. The **${agent}** sits above all of them: it sees every work-folder, hands work to their Workers, and follows it to the end. The \`${cli}\` command drives all of it, and the ${product} app must be open for any command that does work.

## Rules

- Add \`--json\` to every command and read the result. Exit code 0 means it worked.
- Name the work-folder on every command that acts inside one: \`--work-folder <id or exact name>\`.
- Every command that changes something runs at once and leaves a receipt. Prefer these commands to your own file tools inside a work-folder: they keep History restore points and Recently deleted, and raw edits do not. When one is refused, report the refusal instead of working around it.
- Never enter, read, or pass on API keys or passwords. The person sets those up in ${product}'s Settings.
- Don't loop, poll, or sleep. Wait once with the wait commands below.
- \`${cli} help <command>\` has exact usage, for example \`${cli} help chat\`, \`${cli} help collaborate\`, \`${cli} help automations\`.

## Look around

- \`${cli} context --json\`: the work-folder for the current directory, if there is one.
- \`${cli} work-folders list --json\`: every work-folder with its id, name, folder, and the work-folder it sits inside.
- \`${cli} chats list --work-folder <id> --json\`: that folder's Chats.
- \`${cli} requests list --json\`: work in flight across work-folders.
- \`${cli} agent overview --json\`: what is running, what needs the person, and what changed.

## Hand work to a Worker

1. \`${cli} chat send --work-folder <id> --new --message "<task>" --json\` starts a Chat and returns a task id. Use \`--message-file <path>\` for a long task, or \`--conversation <id>\` instead of \`--new\` to continue a Chat.
2. \`${cli} chat wait --work-folder <id> --task <task id> --json\` returns when the turn ends or when the Worker is waiting on an answer, and says which. Add \`--timeout <seconds>\` to bound it.
3. \`${cli} chat result --work-folder <id> --task <task id> --json\` reads the reply.

If the Worker asked a question, \`${cli} chat answer --work-folder <id> --question <question id> --answer "<text>" --json\` answers it, and the Worker continues once.

## Work across work-folders

- Ask the ${agent}: \`${cli} agent send --new --message "<what you need>" --json\`, then \`${cli} agent wait --task <task id> --json\` and \`${cli} agent result --task <task id> --json\`. It hands each part to the right Worker.
- \`${cli} requests show --request <id> --json\` follows one piece of work: the Workers it went to, their questions, and each result.
- A work-folder inside another belongs to its own Worker. Send each part of a task to the work-folder that owns it.

## Files, History, and undo

- \`${cli} files add --work-folder <id> --from "<absolute path>" --to "<folder>" --json\` copies material in with a restore point. \`files move\`, \`files rename\`, \`files delete\`, \`files mkdir\`, and \`files create\` organize inside one; see \`${cli} help files\`.
- \`${cli} search --work-folder <id> --query "<text>" --json\` searches a work-folder's files and Chats.
- \`${cli} history list --work-folder <id> --json\` lists restore points, and \`${cli} history restore --work-folder <id> --checkpoint <id> --json\` goes back to one.
- \`${cli} recently-deleted list --json\` and \`${cli} recently-deleted restore --entry <id> --json\` bring back what was deleted.

## Automations

- \`${cli} automations list --json\` lists them; \`${cli} automations show --automation <id> --json\`, \`${cli} automations run --automation <id> --json\`, and \`${cli} automations receipts --automation <id> --json\` inspect and run one.
- Turning one on, and writing a new one, are in \`${cli} help automations\`. Only do either when the person asks.

## Report

Say what you did in plain words, which work-folders and Workers it touched, and anything still running or waiting on the person. If you changed or deleted something, say how to undo it.
`;
}
