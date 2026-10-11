import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RegisteredWorkFolderRuntimeProvider,
  RegisteredWorkFolderTrustAuthority,
} from "../src/local/agent/registered-work-folder-runtime.js";
import { loadAgentSkillCatalog } from "../src/local/agent/skill-catalog.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldAgentRoot, workFoldAgentScopeId } from "../src/local/state-paths.js";

test("the work-fold agent runs above all work-folders on the shared turn machinery", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-agent-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;

    // Starting the API materializes the work-fold agent scope's app-owned Pi
    // configuration, and Pi's own loader picks both resources up: the
    // AGENTS.md context file stays in the session context, and the
    // manage-work-folders Skill is a project-scope skill of the management
    // root — not of the person's everywhere scope.
    const workFoldAgentRootPath = workFoldAgentRoot();
    assert.equal(existsSync(join(workFoldAgentRootPath, "AGENTS.md")), true);
    assert.equal(existsSync(join(workFoldAgentRootPath, ".pi", "skills", "manage-work-folders", "SKILL.md")), true);
    // Discovery uses the same trust wrapper the running API applies: the
    // management root is app-granted, so its project resources load.
    const catalog = await loadAgentSkillCatalog(workFoldAgentRootPath, new RegisteredWorkFolderRuntimeProvider(
      {
        async resolveRuntime() {
          return { agentDir: join(sandbox, "agent") };
        },
      },
      new RegisteredWorkFolderTrustAuthority([workFoldAgentRootPath]),
    ));
    const workFoldAgentSkill = catalog.skills.find((skill) => skill.name === "manage-work-folders");
    assert.equal(workFoldAgentSkill?.source.scope, "project", "the management skill must load at project scope");
    assert.equal(
      catalog.contextFiles.some((file) => file.path.endsWith("AGENTS.md") && file.content.includes("work-fold agent")),
      true,
      "the management AGENTS.md must load as a Pi context file",
    );
    const workFoldAgentContext = catalog.contextFiles.find((file) => file.path.endsWith("AGENTS.md"))?.content ?? "";
    // The identity line names the work-fold agent while keeping "work-fold agent"
    // as the contract phrase in the same sentence.
    assert.match(workFoldAgentContext, /You are the work-fold agent — the agent above all work-folders in this computer's work-fold app\./);
    assert.match(workFoldAgentContext, /Checks are optional, manual expectations/);
    assert.match(workFoldAgentContext, /Never turn an ordinary request.*standing behavior/);
    assert.match(workFoldAgentContext, /not-configured.*unknown, not clear/);
    assert.match(workFoldAgentContext, /Only after an explicit enable instruction/);
    // The teaching pass (docs/act-ledger.md): the instructions name the
    // complete landed verb surface, family by family, with the ledger's
    // command shapes.
    assert.match(workFoldAgentContext, /chat rename --work-folder <id> --conversation <id> --title/);
    assert.match(workFoldAgentContext, /chat snooze --work-folder <id> --conversation <id> --until <ISO>/);
    assert.match(workFoldAgentContext, /`chat compact`/);
    assert.match(workFoldAgentContext, /history restore --work-folder <id> --checkpoint <id>/);
    assert.match(workFoldAgentContext, /history restore-file --work-folder <id> --path "<p>" --version <sha256>/);
    assert.match(workFoldAgentContext, /files move --work-folder <id> --from "<work-folder-path>" --to "<work-folder-folder>"/);
    assert.match(workFoldAgentContext, /files mkdir --work-folder <id> --path/);
    assert.match(workFoldAgentContext, /search --work-folder <id> --query "<text>" \[--scope files\|chats\|all\]/);
    assert.match(workFoldAgentContext, /work-folders rename --work-folder <id> --name/);
    assert.match(workFoldAgentContext, /work-folders unregister --work-folder <id>/);
    assert.match(workFoldAgentContext, /work-folders appearance apply --work-folder <id> --proposal/);
    assert.match(workFoldAgentContext, /tools import-skill --scope everywhere\|work-folder/);
    assert.match(workFoldAgentContext, /apps release publish --work-folder <id> --release <digest>/);
    assert.match(workFoldAgentContext, /a local state transition — nothing is uploaded, hosted, or granted/);
    assert.match(workFoldAgentContext, /apps uninstall --work-folder <id> --instance <id> --retain-data\|--purge-data/);
    assert.match(workFoldAgentContext, /The disposition flag is never defaulted/);
    assert.match(workFoldAgentContext, /pages share --work-folder <id> --path "<work-folder-path>" --title/);
    assert.match(workFoldAgentContext, /pages status --publication <id>/);
    assert.match(workFoldAgentContext, /pages narrow --publication <id> --serve-rate <per-minute>\|--byte-budget <bytes-per-day>/);
    assert.match(workFoldAgentContext, /pages snapshot-off --publication <id>/);
    // Widening in place (docs/shared-pages.md, amended 2026-09-24): budgets
    // and snapshot change under a receipt while the link stays; re-exposing
    // is still a fresh share, and a share with no address refuses.
    assert.match(workFoldAgentContext, /Widening in place keeps the slot, key, and link: `pages widen --publication <id> \[--serve-rate <per-minute>\] \[--byte-budget <bytes-per-day>\] \[--snapshot\]`/);
    assert.match(workFoldAgentContext, /Re-exposing a revoked page is a fresh `pages share` with a new link\./);
    assert.match(workFoldAgentContext, /Sharing needs web access set up/);
    // Hosted-app exposure (docs/shared-pages.md, rung 3) rides the same
    // pages family: `pages share-app` shares on the call, `--instance` accepts
    // either installed-instance id, the pins resolve host-side from the app's
    // declared manifest, one instance holds one exposure, and apps have no
    // snapshot lane — asleep is the only offline state.
    assert.match(workFoldAgentContext, /pages share-app --work-folder <id> --instance <id>/);
    assert.match(workFoldAgentContext, /accepts the App Instance id or, like `apps uninstall`, the Runtime Instance id/);
    assert.match(workFoldAgentContext, /resolve host-side from the app's declared manifest, never from your flags/);
    assert.match(workFoldAgentContext, /An instance holds at most one exposure/);
    assert.match(workFoldAgentContext, /re-exposing after a revoke is a fresh `pages share-app`/);
    assert.match(workFoldAgentContext, /Apps take no `--snapshot` — an offline desktop is an honestly asleep app/);
    // Publishing top-up (docs/shared-pages.md): publication problems reach
    // the person as overview change items with the precise reason, and
    // Settings → Automations and Recently deleted hold the person's own direct controls — the share
    // link never rides the work-fold agent's lane.
    assert.match(workFoldAgentContext, /Page problems show in Settings → Shared pages and the overview/);
    assert.match(workFoldAgentContext, /Share links are revealed only in Settings → Shared pages/);
    assert.match(workFoldAgentContext, /never enter this lane's output or receipts/);
    assert.match(workFoldAgentContext, /agent overview --json/);
    // Receipts, not gates (docs/receipts-not-gates.md, F19–F24): every verb
    // runs on the first call and returns a receipt, destruction is reversible
    // through History or Recently deleted, limits are named rather than
    // hidden, needs-you is a question, and the setup surfaces have no verb.
    assert.match(workFoldAgentContext, /## Receipts, not gates/);
    assert.match(workFoldAgentContext, /Every verb runs on the first call and returns a receipt\./);
    assert.match(workFoldAgentContext, /Every destruction is reversible\./);
    assert.match(workFoldAgentContext, /moves into Recently deleted/);
    assert.match(workFoldAgentContext, /recently-deleted list --json/);
    assert.match(workFoldAgentContext, /recently-deleted restore --entry <id>/);
    assert.match(workFoldAgentContext, /30 days by default/);
    assert.match(workFoldAgentContext, /no verb empties Recently deleted early/);
    assert.doesNotMatch(workFoldAgentContext, /Limits are defaults, not gates\./);
    assert.match(workFoldAgentContext, /Needs you means a question\./);
    assert.match(workFoldAgentContext, /Setup stays with the person\./);
    assert.match(workFoldAgentContext, /never gather, accept, or relay credentials/);
    // Reversible destruction reaches the file and work-folder verbs themselves.
    assert.match(workFoldAgentContext, /Deletion refuses until the affected work-folder's work has settled/);
    assert.match(workFoldAgentContext, /Never bypass that refusal with raw tools/);
    assert.match(workFoldAgentContext, /moves its folder into Recently deleted/);
    // Apps come up able to work (F21) and are usable as tools (F22 lineage).
    assert.match(workFoldAgentContext, /work-folder apps come up able to work\./);
    assert.match(workFoldAgentContext, /grant each declared folder permission over the whole work-folder/);
    // What the installer actually does not grant: the work-fold agent must relay it
    // rather than report a Check slot or a chosen file as already granted.
    assert.match(workFoldAgentContext, /a permission that names a single file/);
    assert.match(workFoldAgentContext, /a Check-result slot when the work-folder has more than one Check/);
    assert.match(workFoldAgentContext, /Relay that list; do not report those as granted\./);
    assert.match(workFoldAgentContext, /apps list --work-folder <id> --json/);
    assert.match(workFoldAgentContext, /apps invoke --work-folder <id> --app <id> --tool <name> --input/);
    assert.match(workFoldAgentContext, /leave a copy in Recently deleted before removing live data/);
    // Help topics exist now, and the instructions cite them.
    assert.match(workFoldAgentContext, /work-fold help <family>/);
    assert.match(workFoldAgentContext, /help recently-deleted/);
    // Automations: inert proposals, direct receipted enablement, the closed
    // placeholder set and the agent step, one-time v2 deferral, and no
    // cross-work-folder execution inside a portable work-folder Chat.
    assert.match(workFoldAgentContext, /Never run cross-work-folder work through a work-folder Chat\./);
    assert.match(workFoldAgentContext, /work-fold\.automation-proposal/);
    assert.match(workFoldAgentContext, /Use version 1 for manual, interval, and on-settled triggers/);
    assert.match(workFoldAgentContext, /Use version 3 for a folder-change trigger/);
    assert.match(workFoldAgentContext, /<name>\.work-fold-automation\.json` directly in your own working folder/);
    assert.match(workFoldAgentContext, /appears in Settings → Automations under \*\*Ready to turn on\*\*/);
    assert.match(workFoldAgentContext, /do not enable it yourself unless they ask you to/);
    assert.match(workFoldAgentContext, /Use version 2 for a one-time trigger shaped exactly/);
    assert.match(workFoldAgentContext, /`ifMissed` is required/);
    assert.match(workFoldAgentContext, /any future time up to ten years ahead/);
    assert.match(workFoldAgentContext, /automations enable --proposal/);
    assert.match(workFoldAgentContext, /enabling the same declaration again changes nothing/);
    assert.match(workFoldAgentContext, /Use version 4 for placeholders or an agent step/);
    assert.match(workFoldAgentContext, /[Oo]rdered steps use four kinds/);
    assert.match(workFoldAgentContext, /\{\{trigger\.summary\}\}/);
    assert.match(workFoldAgentContext, /a message into a new thread of your own/);
    assert.match(workFoldAgentContext, /Anything else inside `\{\{ \}\}` is refused when you enable/);
    assert.match(workFoldAgentContext, /automations show --automation <id>/);
    assert.match(workFoldAgentContext, /automations receipts \[--automation <id>\]/);
    assert.match(workFoldAgentContext, /automations sit above work-folders and take no `--work-folder`/);
    assert.match(workFoldAgentContext, /Up to 64 automation runs execute at once/);
    assert.match(workFoldAgentContext, /A pure reminder performs no future Worker work/);
    assert.match(workFoldAgentContext, /For deferred work, resolve an unambiguous absolute time/);
    assert.match(workFoldAgentContext, /finish the current turn/);
    assert.match(workFoldAgentContext, /Never busy-wait/);
    assert.match(workFoldAgentContext, /An agent step is the only way you are ever scheduled/);
    assert.match(workFoldAgentContext, /a thread an automation started must never enable or run automations itself/);
    assert.match(workFoldAgentContext, /Run-now creates a copy without consuming the declared slot/);
    // The overview (docs/work-fold-agent-overview.md): narration on demand from the digest,
    // truncation disclosed, seen markers untouched, never self-scheduled.
    assert.match(workFoldAgentContext, /never present a truncated section as complete/);
    assert.match(workFoldAgentContext, /narration never advances a marker/);
    // Seen markers are per-surface — popover, main window, and one marker per
    // paired remote browser grant — and narration advances none of them.
    assert.match(workFoldAgentContext, /remote:<grantId>/);
    assert.match(workFoldAgentContext, /not the popover's, not the main window's, not any remote grant's/);
    assert.match(workFoldAgentContext, /Narration is on demand only\./);
    // Needs-you is a question list, never work waiting to be let through (F24).
    assert.match(workFoldAgentContext, /needs-you items \(questions, due snoozes, and requests waiting on the person's answer\)/);
    // Delegation under the collaboration contract (F25–F29): the work-fold agent reads
    // the request graph, a wait that comes back waiting is not a failure, a
    // waiting or running child never holds this turn open, the follow-up turn
    // is bounded and ordinary, a child's question is answered with one
    // `chat answer` or handed to the person, handoffs are host-routed, and a
    // work-folder Chat only ever receives its own work (F9 as amended).
    assert.match(workFoldAgentContext, /requests list --json/);
    assert.match(workFoldAgentContext, /requests show --request <id> --json/);
    assert.match(workFoldAgentContext, /Both sit above work-folders and take no `--work-folder`/);
    assert.match(workFoldAgentContext, /when its task starts waiting on an answer, and says which/);
    assert.match(workFoldAgentContext, /Waiting is not a failure and not a timeout/);
    assert.match(workFoldAgentContext, /Never block on a waiting child\./);
    assert.match(workFoldAgentContext, /Never busy-wait, sleep, or poll in a loop for one\./);
    assert.match(workFoldAgentContext, /when its children settle it brings their reports back here once/);
    assert.doesNotMatch(workFoldAgentContext, /bounded at 4 per request/);
    assert.match(workFoldAgentContext, /turn them off in Settings → Automations → Limits/);
    assert.match(workFoldAgentContext, /chat answer --work-folder <id> --question <id> --answer "<text>" --parent-task <this-request-task-id> --json/);
    assert.match(workFoldAgentContext, /A second answer, an answer after Stop/);
    assert.match(workFoldAgentContext, /work-fold agent ask --task/);
    assert.match(workFoldAgentContext, /Handoffs are host-routed\./);
    assert.match(workFoldAgentContext, /A work-folder Chat receives only its own work\./);
    assert.match(workFoldAgentContext, /its assignment, answers to its own questions, report summaries someone deliberately released to it, and copied files/);
    assert.match(workFoldAgentContext, /Requests have no fixed lifetime, child-count, depth, concurrency, or continuation-count quota/);
    assert.match(workFoldAgentContext, /help collaborate/);
    // The trap this teaching exists to prevent: a sentence a model obeys
    // literally by sitting on a child instead of finishing its turn.
    assert.doesNotMatch(
      workFoldAgentContext,
      /\bpoll(ing)? (until|every)\b|\bsleep \d/i,
      "the fold is never taught to busy-wait",
    );
    // Report discipline reads receipts and restore paths without losing
    // attachment accounting or the question-on-final-line rule.
    assert.match(workFoldAgentContext, /Read each receipt before reporting/);
    assert.match(workFoldAgentContext, /never call a request done while any child is running, waiting, failed, lost, or stopped/);
    assert.match(workFoldAgentContext, /When a child asked a question, quote the question/);
    assert.match(workFoldAgentContext, /say whether History or Recently deleted holds it/);
    assert.match(workFoldAgentContext, /Account for every attached item by name/);
    assert.match(workFoldAgentContext, /record a question with `agent ask`/);
    // The work-fold agent is never taught a gate vocabulary (docs/receipts-not-gates.md
    // acceptance: no user-facing copy says staged, approve, policy, Reviewed,
    // or Unrestricted).
    assert.doesNotMatch(
      workFoldAgentContext,
      /\bstaged\b|\bstaging\b|standing polic|\bpolic(y|ies)\b|\bReviewed\b|\bUnrestricted\b|approv|\bdenial\b|\bdenied\b|decision id|autoApproval|needs-you card|\bcards?\b/i,
      "the work-fold agent is never taught a gate vocabulary",
    );

    // The manage-work-folders Skill teaches the same surface and etiquette.
    const skillContent = await readFile(join(workFoldAgentRootPath, ".pi", "skills", "manage-work-folders", "SKILL.md"), "utf8");
    assert.match(skillContent, /Every verb runs on the first call and returns a receipt/);
    assert.match(skillContent, /## Tools, apps, and pages/);
    assert.match(skillContent, /work-folder apps come up able to work/);
    assert.match(skillContent, /grant each declared folder permission over the whole work-folder/);
    assert.match(skillContent, /bind a Check-result slot when the work-folder has exactly one Check/);
    assert.match(skillContent, /still need the person in Settings → Apps/);
    assert.match(skillContent, /apps invoke --work-folder <id> --app <id> --tool <name> --input <json>/);
    assert.match(skillContent, /leave a copy in Recently deleted first/);
    assert.match(skillContent, /recently-deleted restore --entry <id>/);
    assert.match(skillContent, /Setup-only \(no act verb\)/);
    assert.match(skillContent, /Never delegate cross-work-folder work into a work-folder Chat/);
    assert.match(skillContent, /work-fold\.automation-proposal/);
    assert.match(skillContent, /one-time trigger requires version 2/);
    assert.match(skillContent, /`ifMissed` is required/);
    assert.match(skillContent, /any future time up to ten years ahead/);
    assert.match(skillContent, /automations enable --proposal/);
    assert.match(skillContent, /Version 4 adds the closed placeholder set and the `agent` step/);
    assert.match(skillContent, /`chat`, `files`, `check`, or `agent`/);
    assert.match(skillContent, /automations list\|show\|run\|stop\|disable\|delete\|receipts/);
    assert.match(skillContent, /A pure reminder does no future Worker work/);
    assert.match(skillContent, /Deferred work uses a version-2 `at` automation/);
    assert.match(skillContent, /finish the current turn/);
    assert.match(skillContent, /Never busy-wait/);
    assert.match(skillContent, /report the receipt/);
    assert.match(skillContent, /an automation's `agent` step is the only way you are ever scheduled/);
    assert.match(skillContent, /Run-now is a copy that does not consume the one-time slot/);
    assert.match(skillContent, /pages status\|revoke\|narrow\|snapshot-off --publication <id>/);
    // The pages line teaches `pages share-app` with its boundaries: either
    // instance id, one exposure per instance, and no snapshot lane for apps.
    assert.match(skillContent, /`pages share-app` \(an installed App Instance at the person's address — `--instance` accepts the App Instance id or the Runtime Instance id, one exposure per instance, and never `--snapshot`: apps have no sleep copy\)/);
    assert.match(skillContent, /agent overview --json/);
    assert.match(skillContent, /files move --work-folder <id>/);
    assert.match(skillContent, /Read each receipt: executed is done, failed or refused is not/);
    // The Skill carries the same collaboration teaching in its shorter form.
    assert.match(skillContent, /requests list --json/);
    assert.match(skillContent, /requests show --request <id> --json/);
    assert.match(skillContent, /when its task starts waiting on an answer, and says which/);
    assert.match(skillContent, /Waiting is not a failure/);
    assert.match(skillContent, /Never block on a waiting or running child\./);
    assert.match(skillContent, /Never busy-wait, sleep, or poll in a loop\./);
    assert.match(skillContent, /the one follow-up turn it starts/);
    assert.match(skillContent, /A second answer, an answer after Stop, or a work-folder that does not own the question is refused/);
    assert.match(skillContent, /work-fold agent ask --task/);
    assert.match(skillContent, /asks for a handoff with `chat handoff`/);
    assert.doesNotMatch(skillContent, /bounded at 4 per request/);
    assert.match(skillContent, /Requests have no fixed lifetime, child-count, depth, concurrency, or continuation-count quota/);
    assert.match(skillContent, /A work-folder Chat receives only its assignment, answers to its own questions, released report summaries, and copied files/);
    assert.match(skillContent, /A request is not done while a child is running, waiting, failed, lost, or stopped/);
    assert.match(skillContent, /help collaborate/);
    assert.doesNotMatch(
      skillContent,
      /\bpoll(ing)? (until|every)\b|\bsleep \d/i,
      "the manage-work-folders Skill is never taught to busy-wait",
    );
    // Needs-you, paired-browser seen markers, publication problems in the
    // overview, and the help topics reach the Skill too.
    assert.match(skillContent, /never work waiting to be let through/);
    assert.match(skillContent, /remote:<grantId>/);
    assert.match(skillContent, /overview change items with the precise reason/);
    assert.match(skillContent, /revealed only in Settings → Shared pages/);
    assert.match(skillContent, /work-fold help <family>/);
    assert.doesNotMatch(
      skillContent,
      /\bstaged\b|\bstaging\b|standing polic|\bpolic(y|ies)\b|\bReviewed\b|\bUnrestricted\b|approv|\bdenial\b|\bdenied\b|decision id|autoApproval|needs-you (card|flyout)|\bcards?\b/i,
      "the manage-work-folders Skill is never taught a gate vocabulary",
    );

    // Before any send there is no conversation to inspect.
    await assert.rejects(
      () => facade.agentConversationStatus({}),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // The first send creates the default work-fold agent and runs a
    // real turn through the personal-scope /hold extension — proving the
    // management client loads personal Pi capabilities without any work-folder.
    const send = await facade.agentSend({ content: "/hold" });
    assert.ok(send.conversationId);
    assert.ok(send.taskId);
    const running = await api.kernel.getTasks({ kind: "system" });
    const workFoldAgentTask = running.tasks.find((task) => task.id === send.taskId);
    assert.equal(workFoldAgentTask?.workFolderId, workFoldAgentScopeId, "work-fold agent turns must be tracked under the work-fold agent scope id");
    assert.equal(workFoldAgentTask?.actor.kind, "cli");

    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: send.taskId })).task.state !== "running");
    const settled = await facade.agentTurnStatus({ taskId: send.taskId });
    assert.equal(settled.task.state, "succeeded");
    assert.equal(settled.task.conversationId, send.conversationId);

    const result = await facade.agentTurnResult({ taskId: send.taskId });
    assert.equal(result.message.content, "Command completed.");
    assert.equal(result.conversationId, send.conversationId);

    // The transcript is machine-local application state, not work-folder content.
    assert.equal(workFoldAgentRootPath.startsWith(join(sandbox, "state")), true, "management records live under the app state root");
    const transcripts = await readdir(join(workFoldAgentRootPath, ".work-fold", "conversations"));
    assert.equal(transcripts.some((file) => file === `${send.conversationId}.jsonl`), true);
    assert.equal(existsSync(join(sandbox, "content", "management")), false, "no work-folder is created for the work-fold agent scope");

    // Selector-free commands keep targeting the same default conversation.
    const second = await facade.agentSend({ content: "/hold" });
    assert.equal(second.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: second.taskId })).task.state !== "running");

    const status = await facade.agentConversationStatus({});
    assert.equal(status.conversation.id, send.conversationId);
    assert.equal(status.state, "idle");
    const tail = await facade.agentConversationResult({ messages: 10 });
    assert.equal(tail.lastAssistant, "Command completed.");
    assert.equal(tail.conversationId, send.conversationId);
    assert.equal((await facade.agentList()).conversations.length, 1);
    assert.equal((await facade.agentAbort({})).aborted, false);

    // --new starts a separate work-fold agent on request.
    const fresh = await facade.agentSend({ content: "/hold", newConversation: true });
    assert.notEqual(fresh.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await facade.agentList()).conversations.length, 2);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the work-fold agent fails closed when its required instructions cannot be prepared", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-agent-fail-closed-test-"));
  const stateBase = join(sandbox, "state");
  await mkdir(stateBase, { recursive: true });
  // Occupy the management root with a regular file. The rest of work-fold
  // must still start, but this full-trust scope must not run uninstructed.
  await writeFile(join(stateBase, "management"), "not a directory", "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    await assert.rejects(
      () => api.actFacade.agentList(),
      (error: unknown) => error instanceof WorkFoldCliError
        && error.code === "unavailable"
        && /required instructions/.test(error.message),
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("remote recovery recognizes shipped browser-scoped requests that predate grant provenance", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-legacy-recovery-test-"));
  const stateBase = join(sandbox, "state");
  const conversationId = "chat-f6e5b83-legacy";
  const transcriptDir = join(stateBase, "management", ".work-fold", "conversations");
  const transcriptPath = join(transcriptDir, `${conversationId}.jsonl`);
  await mkdir(transcriptDir, { recursive: true });
  const legacyMessage = {
    id: "message-from-0.2.2",
    role: "user",
    content: "legacy remote request",
    createdAt: "2026-08-01T12:00:00.000Z",
    source: "remote_web",
    remotePrincipalId: "browser-legacy",
    remoteRequestId: "request-before-grant-provenance",
  };
  const originalTranscript = `${JSON.stringify({
    id: "legacy-title",
    role: "system",
    kind: "conversation_title",
    titleSource: "placeholder",
    content: "New Chat",
    createdAt: "2026-08-01T11:59:59.000Z",
  })}\n${JSON.stringify(legacyMessage)}\n`;
  await writeFile(transcriptPath, originalTranscript, "utf8");

  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    const recovered = await api.remoteFacade.execute(
      "management.send",
      { content: "must not run again", newConversation: true },
      {
        browserId: legacyMessage.remotePrincipalId,
        grantId: "grant-added-after-0.2.2",
        requestId: legacyMessage.remoteRequestId,
      },
    ) as { accepted: boolean; duplicate?: boolean; conversationId: string; taskId: string | null; message: { id: string } };

    assert.equal(recovered.accepted, true);
    assert.equal(recovered.duplicate, true, "the recovered signed request must not enqueue a second full-trust prompt");
    assert.equal(recovered.conversationId, conversationId);
    assert.equal(recovered.taskId, null);
    assert.equal(recovered.message.id, legacyMessage.id);
    assert.equal(await readFile(transcriptPath, "utf8"), originalTranscript, "compatibility lookup never rewrites the append-only log");
    assert.deepEqual(
      await readdir(transcriptDir),
      [`${conversationId}.jsonl`],
      "replaying a legacy New chat request does not leave another transcript",
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("remote access reuses the canonical management conversation through a bounded path-safe facade", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-agent-test-"));
  const expiredUpload = join(sandbox, "state", "management", "Incoming", "Remote", "expired-grant", "expired-request");
  await mkdir(expiredUpload, { recursive: true });
  await writeFile(join(expiredUpload, "old.txt"), "expired", "utf8");
  const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(expiredUpload, expiredAt, expiredAt);
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 180)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; },
    },
  });
  try {
    assert.equal(existsSync(expiredUpload), false, "startup prunes remote uploads after their 24-hour expiry without waiting for another upload");
    const principal = { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" };
    const initial = await api.remoteFacade.execute("management.summary", {}, principal) as { conversation: unknown };
    assert.equal(initial.conversation, null);

    const locallyStarted = await api.actFacade.agentSend({ content: "/hold local-owner" });
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.request",
        { taskId: locallyStarted.taskId },
        { ...principal, requestId: "request-local-task-status" },
      ),
      /not found for this browser grant/,
      "remote task status never adopts locally-started management work",
    );
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.stop",
        { taskId: locallyStarted.taskId },
        { ...principal, requestId: "request-local-task-stop" },
      ),
      /not found for this browser grant/,
      "remote stop never adopts locally-started management work",
    );
    assert.equal((await api.actFacade.agentStop({ taskId: locallyStarted.taskId })).workFoldAgentAborted, true);
    await waitForAsync(async () => (await api.actFacade.agentTurnStatus({ taskId: locallyStarted.taskId })).task.state !== "running");

    const workFolder = await api.actFacade.createWorkFolder({ name: "Remote Files" });
    await writeFile(join(workFolder.workFolder.workFolderRoot, "brief.txt"), "private content", "utf8");
    const workFolders = await api.remoteFacade.execute("work-folders.list", {}, principal) as { workFolders: Array<Record<string, unknown>> };
    assert.deepEqual(workFolders.workFolders, [{ id: workFolder.workFolder.id, name: "Remote Files" }], "absolute roots never cross the remote facade");
    const tree = await api.remoteFacade.execute("work-folders.tree", { workFolderId: workFolder.workFolder.id, path: "" }, principal) as {
      tree: Array<{ name: string; path: string }>;
    };
    assert.deepEqual(tree.tree.map((entry) => ({ name: entry.name, path: entry.path })), [{ name: "brief.txt", path: "brief.txt" }]);
    await assert.rejects(
      () => api.remoteFacade.execute("work-folders.tree", { workFolderId: workFolder.workFolder.id, path: "../outside" }, principal),
      /work-folder-relative/,
    );

    const sent = await api.remoteFacade.execute("management.send", { content: "/hold" }, principal) as {
      conversationId: string;
      taskId: string;
    };
    const running = await api.kernel.getTasks({ kind: "system" });
    assert.equal(running.tasks.find((task) => task.id === sent.taskId)?.actor.kind, "renderer", "the stable kernel actor vocabulary treats the approved web client as a renderer surface");
    const ownedSummary = await api.remoteFacade.execute(
      "management.summary",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-owned-summary" },
    ) as { latestRequest: { taskId: string; canStop: boolean } };
    assert.equal(ownedSummary.latestRequest.taskId, sent.taskId);
    assert.equal(ownedSummary.latestRequest.canStop, true);
    const crossGrantSummary = await api.remoteFacade.execute(
      "management.summary",
      { conversationId: sent.conversationId },
      { ...principal, grantId: "grant-other", requestId: "request-cross-grant-summary" },
    ) as { latestRequest: Record<string, unknown> };
    assert.equal(crossGrantSummary.latestRequest.canStop, false);
    assert.equal("taskId" in crossGrantSummary.latestRequest, false, "cross-grant summaries omit task authority");
    assert.equal("actions" in crossGrantSummary.latestRequest, false, "cross-grant summaries omit action details");
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.stop",
        { taskId: sent.taskId },
        { ...principal, grantId: "grant-other", requestId: "request-cross-grant-stop" },
      ),
      /not found for this browser grant/,
      "a different approved grant cannot stop a request whose task id it learns",
    );
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.request",
        { taskId: sent.taskId },
        { ...principal, browserId: "browser-other", requestId: "request-cross-browser-status" },
      ),
      /not found for this browser grant/,
      "task-scoped request status is owned by the accepting browser and grant",
    );
    const ownedRequest = await api.remoteFacade.execute(
      "management.request",
      { taskId: sent.taskId },
      { ...principal, requestId: "request-owned-status" },
    ) as { request: { taskId: string } };
    assert.equal(ownedRequest.request.taskId, sent.taskId);
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.rename",
        { conversationId: sent.conversationId, title: "Rename while working" },
        { ...principal, requestId: "request-running-rename" },
      ),
      /Wait for the current turn to finish/,
      "renaming never races a running turn",
    );
    const ownedStop = await api.remoteFacade.execute(
      "management.stop",
      { taskId: sent.taskId },
      { ...principal, requestId: "request-owned-stop" },
    ) as { stopped: { taskId: string; workFoldAgentAborted: boolean } };
    assert.equal(ownedStop.stopped.taskId, sent.taskId);
    assert.equal(ownedStop.stopped.workFoldAgentAborted, true, "the exact accepting browser grant can stop its request");

    const duplicate = await api.remoteFacade.execute("management.send", { content: "/hold" }, principal) as { duplicate?: boolean; taskId: string | null };
    assert.equal(duplicate.duplicate, true, "the signed request id is idempotent at the semantic adapter");
    assert.equal(duplicate.taskId, null);
    await waitForAsync(async () => (await api.actFacade.agentTurnStatus({ taskId: sent.taskId })).task.state !== "running");
    const sameIdOtherGrant = await api.remoteFacade.execute(
      "management.send",
      { content: "cross-grant request", conversationId: sent.conversationId },
      { ...principal, grantId: "grant-other" },
    ) as { duplicate?: boolean; taskId: string };
    assert.equal(sameIdOtherGrant.duplicate, undefined, "request ids are idempotent only within their exact browser grant");
    await waitForAsync(async () => (await api.actFacade.agentTurnStatus({ taskId: sameIdOtherGrant.taskId })).task.state !== "running");

    const renamePrincipal = { ...principal, requestId: "request-rename-chat" };
    const transcriptPath = join(workFoldAgentRoot(), ".work-fold", "conversations", `${sent.conversationId}.jsonl`);
    const renamed = await api.remoteFacade.execute(
      "management.rename",
      { conversationId: sent.conversationId, title: "  Remote planning notes  " },
      renamePrincipal,
    ) as { conversation: { id: string; title: string } };
    assert.equal(renamed.conversation.title, "Remote planning notes");
    const afterRename = await readFile(transcriptPath, "utf8");
    const renameReplay = await api.remoteFacade.execute(
      "management.rename",
      { conversationId: sent.conversationId, title: "A retry must preserve the accepted result" },
      renamePrincipal,
    ) as { conversation: { title: string } };
    assert.equal(renameReplay.conversation.title, "Remote planning notes");
    assert.equal(await readFile(transcriptPath, "utf8"), afterRename, "an exact signed retry never appends a second rename");
    assert.equal(
      (await api.actFacade.agentConversationStatus({ conversationId: sent.conversationId })).conversation.title,
      "Remote planning notes",
      "the desktop and CLI management surface see the remote title",
    );
    const renamedFromOtherGrant = await api.remoteFacade.execute(
      "management.rename",
      { conversationId: sent.conversationId, title: "Planning notes for approval" },
      { ...renamePrincipal, grantId: "grant-other" },
    ) as { conversation: { title: string } };
    assert.equal(renamedFromOtherGrant.conversation.title, "Planning notes for approval");
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.rename",
        { conversationId: sent.conversationId, title: "Nope", unexpected: true },
        { ...principal, requestId: "request-bad-rename-shape" },
      ),
      /does not accept unexpected/,
    );
    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.rename",
        { conversationId: sent.conversationId, title: "   " },
        { ...principal, requestId: "request-empty-rename" },
      ),
      /Enter a Chat title/,
    );

    const transcript = await api.remoteFacade.execute(
      "management.transcript",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-2" },
    ) as { messages: Array<{ role: string; content: string; source?: string }> };
    const remoteMessage = transcript.messages.find((message) => message.role === "user" && message.content === "/hold");
    assert.equal(remoteMessage?.source, "remote_web");
    assert.equal((await api.actFacade.agentConversationStatus({})).conversation.id, sent.conversationId, "web and menu-bar/CLI views resolve the same transcript");
    assert.equal(transcript.messages.filter((message) => message.role === "user" && message.content === "/hold").length, 1);

    const newChatPrincipal = { ...principal, requestId: "request-new-chat" };
    const fresh = await api.remoteFacade.execute(
      "management.send",
      { content: "/hold", newConversation: true },
      newChatPrincipal,
    ) as { conversationId: string; taskId: string };
    assert.notEqual(fresh.conversationId, sent.conversationId, "New chat starts a separate saved transcript");
    const freshDuplicate = await api.remoteFacade.execute(
      "management.send",
      { content: "/hold", newConversation: true },
      newChatPrincipal,
    ) as { conversationId: string; duplicate?: boolean; taskId: string | null };
    assert.equal(freshDuplicate.duplicate, true, "recovery does not create another transcript for the same signed request");
    assert.equal(freshDuplicate.conversationId, fresh.conversationId);
    assert.equal(freshDuplicate.taskId, null);
    await waitForAsync(async () => (await api.actFacade.agentTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await api.actFacade.agentConversationStatus({})).conversation.id, fresh.conversationId);

    const chats = await api.remoteFacade.execute(
      "management.chats",
      {},
      { ...principal, requestId: "request-list-chats" },
    ) as { conversations: Array<{ id: string }>; truncated: boolean };
    assert.deepEqual(new Set(chats.conversations.map((conversation) => conversation.id)), new Set([sent.conversationId, fresh.conversationId]));
    assert.equal(chats.truncated, false);

    const resumed = await api.remoteFacade.execute(
      "management.send",
      { content: "/hold", conversationId: sent.conversationId },
      { ...principal, requestId: "request-existing-chat" },
    ) as { conversationId: string; taskId: string };
    assert.equal(resumed.conversationId, sent.conversationId, "an explicit saved Chat wins over the most recently used Chat");
    await waitForAsync(async () => (await api.actFacade.agentTurnStatus({ taskId: resumed.taskId })).task.state !== "running");
    const selectedSummary = await api.remoteFacade.execute(
      "management.summary",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-selected-summary" },
    ) as { conversation: { id: string }; latestRequest: { conversationId: string } };
    assert.equal(selectedSummary.conversation.id, sent.conversationId);
    assert.equal(selectedSummary.latestRequest.conversationId, sent.conversationId);

    const workFoldAgentUploadRequestId = "request-agent-upload";
    const uploadedToWorkFoldAgent = await api.remoteFacade.execute(
      "management.send",
      {
        content: "/hold",
        conversationId: sent.conversationId,
        attachments: [{ name: "brief-upload.txt", data: Buffer.from("remote brief", "utf8").toString("base64url") }],
      },
      { ...principal, requestId: workFoldAgentUploadRequestId },
    ) as {
      conversationId: string;
      taskId: string;
      uploads: Array<{ name: string; sizeBytes: number }>;
    };
    assert.deepEqual(uploadedToWorkFoldAgent.uploads, [{ name: "brief-upload.txt", sizeBytes: 12 }]);
    assert.doesNotMatch(JSON.stringify(uploadedToWorkFoldAgent), new RegExp(sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const stagedWorkFoldAgentPath = join(
      workFoldAgentRoot(),
      "Incoming",
      "Remote",
      principal.grantId,
      workFoldAgentUploadRequestId,
      "brief-upload.txt",
    );
    assert.equal(existsSync(stagedWorkFoldAgentPath), true);
    await waitForAsync(async () => (await api.actFacade.agentTurnStatus({ taskId: uploadedToWorkFoldAgent.taskId })).task.state !== "running");
    const uploadTranscript = await api.remoteFacade.execute(
      "management.transcript",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-agent-upload-transcript" },
    ) as { messages: Array<{ role: string; attachments?: Array<{ kind: string; name: string; target?: string }> }> };
    const uploadMessage = uploadTranscript.messages.find((message) => message.attachments?.some((attachment) => attachment.name === "brief-upload.txt"));
    assert.deepEqual(uploadMessage?.attachments, [{ kind: "file", name: "brief-upload.txt" }], "remote transcripts expose attachment identity without local paths");

    await api.remoteFacade.purgeUploads(principal.grantId);
    assert.equal(existsSync(stagedWorkFoldAgentPath), false, "revoking a browser can purge its staged management uploads");

    await assert.rejects(
      () => api.remoteFacade.execute(
        "management.send",
        { content: "no", newConversation: "yes" },
        { ...principal, requestId: "request-bad-new-chat" },
      ),
      /newConversation must be a boolean/,
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
