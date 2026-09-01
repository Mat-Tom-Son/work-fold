import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RegisteredSpaceRuntimeProvider,
  RegisteredSpaceTrustAuthority,
} from "../src/local/agent/registered-space-runtime.js";
import { loadAgentSkillCatalog } from "../src/local/agent/skill-catalog.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldManagementRoot, workFoldManagementScopeId } from "../src/local/state-paths.js";

test("the management conversation runs above all Spaces on the shared turn machinery", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-management-test-"));
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
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;

    // Starting the API materializes the management scope's app-owned Pi
    // configuration, and Pi's own loader picks both resources up: the
    // AGENTS.md context file stays in the session context, and the
    // manage-spaces Skill is a project-scope skill of the management
    // root — not of the person's personal scope.
    const managementRoot = workFoldManagementRoot();
    assert.equal(existsSync(join(managementRoot, "AGENTS.md")), true);
    assert.equal(existsSync(join(managementRoot, ".pi", "skills", "manage-spaces", "SKILL.md")), true);
    // Discovery uses the same trust wrapper the running API applies: the
    // management root is app-granted, so its project resources load.
    const catalog = await loadAgentSkillCatalog(managementRoot, new RegisteredSpaceRuntimeProvider(
      {
        async resolveRuntime() {
          return { agentDir: join(sandbox, "agent") };
        },
      },
      new RegisteredSpaceTrustAuthority([managementRoot]),
    ));
    const managementSkill = catalog.skills.find((skill) => skill.name === "manage-spaces");
    assert.equal(managementSkill?.source.scope, "project", "the management skill must load at project scope");
    assert.equal(
      catalog.contextFiles.some((file) => file.path.endsWith("AGENTS.md") && file.content.includes("management conversation")),
      true,
      "the management AGENTS.md must load as a Pi context file",
    );
    const managementContext = catalog.contextFiles.find((file) => file.path.endsWith("AGENTS.md"))?.content ?? "";
    // The identity line names the fold while keeping "management conversation"
    // as the contract phrase in the same sentence.
    assert.match(managementContext, /You are the fold — the management conversation for this computer's work-fold app\./);
    assert.match(managementContext, /Checks are optional, manual expectations/);
    assert.match(managementContext, /Never turn an ordinary request.*standing behavior/);
    assert.match(managementContext, /not-configured.*unknown, not clear/);
    assert.match(managementContext, /Only after an explicit enable instruction/);
    // The teaching pass (docs/fold-act-ledger.md): the instructions name the
    // complete landed verb surface, family by family, with the ledger's
    // command shapes.
    assert.match(managementContext, /chat rename --space <id> --conversation <id> --title/);
    assert.match(managementContext, /chat snooze --space <id> --conversation <id> --until <ISO>/);
    assert.match(managementContext, /`chat compact`/);
    assert.match(managementContext, /history restore --space <id> --checkpoint <id>/);
    assert.match(managementContext, /history restore-file --space <id> --path "<p>" --version <sha256>/);
    assert.match(managementContext, /files move --space <id> --from "<space-path>" --to "<space-folder>"/);
    assert.match(managementContext, /files mkdir --space <id> --path/);
    assert.match(managementContext, /search --space <id> --query "<text>" \[--scope files\|chats\|all\]/);
    assert.match(managementContext, /library copy --item "<library-path>" --space <id>/);
    assert.match(managementContext, /spaces rename --space <id> --name/);
    assert.match(managementContext, /spaces unregister --space <id>/);
    assert.match(managementContext, /spaces appearance apply --space <id> --proposal/);
    assert.match(managementContext, /tools import-skill --scope personal\|space/);
    assert.match(managementContext, /apps release publish --space <id> --release <digest>/);
    assert.match(managementContext, /a local state transition — nothing is uploaded, hosted, or granted/);
    assert.match(managementContext, /apps uninstall .* --purge-data.* stages a decision/);
    assert.match(managementContext, /pages stage --space <id> --path "<space-path>" --title/);
    assert.match(managementContext, /pages status --publication <id>/);
    assert.match(managementContext, /pages narrow --publication <id> --serve-rate <per-minute>\|--byte-budget <bytes-per-day>/);
    assert.match(managementContext, /pages snapshot-off --publication <id>/);
    assert.match(managementContext, /Widening back — re-exposing, raising a budget, turning snapshot on — is a fresh staged `pages stage`\./);
    // Hosted-app exposure (docs/fold-publishing.md, rung 3) rides the same
    // pages family: `pages stage-app` stages the decision, `--instance`
    // accepts either installed-instance id, the pins resolve host-side from
    // the reviewed manifest, one instance holds one exposure, and apps have
    // no snapshot lane — asleep is the only offline state.
    assert.match(managementContext, /pages stage-app --space <id> --instance <id>/);
    assert.match(managementContext, /accepts the App Instance id or, like `apps uninstall`, the Runtime Instance id/);
    assert.match(managementContext, /resolve host-side from the reviewed manifest, never from your flags/);
    assert.match(managementContext, /An instance holds at most one exposure/);
    assert.match(managementContext, /re-exposing after a revoke is a fresh staged `pages stage-app`/);
    assert.match(managementContext, /Apps take no `--snapshot` — an offline desktop is an honestly asleep app/);
    // Staging `pages stage-app` joins the widen-power family list verbatim.
    assert.match(managementContext, /`routings stage`, `pages stage`, `pages stage-app`\)/);
    // Publishing top-up (docs/fold-publishing.md): outward exposure is never
    // policy-eligible, publication problems reach the person as glance change
    // items with the precise reason, and Settings → The fold holds the
    // person's own direct controls — the share link never rides the fold's
    // lane.
    assert.match(managementContext, /Standing policies never match outward exposure/);
    assert.match(managementContext, /Page problems surface through the glance/);
    assert.match(managementContext, /Share links are revealed only in Settings → The fold/);
    assert.match(managementContext, /never enter this lane's output or receipts/);
    assert.match(managementContext, /manage glance --json/);
    // Staging etiquette (docs/fold-consecrations.md): every consequential
    // act stages, then the response distinguishes Reviewed waiting, policy,
    // and Unrestricted host execution. Setup-only authority stays local.
    assert.match(managementContext, /Invoking one always returns a decision id/);
    assert.match(managementContext, /staged\.autoApproval\.basis/);
    assert.match(managementContext, /Expiry \(24 hours\) applies only to work that remains staged/);
    assert.match(managementContext, /Denial is recorded, not retried\./);
    assert.match(managementContext, /staged list --json/);
    assert.match(managementContext, /staged show --id <id>/);
    assert.match(managementContext, /staged cancel --id <id>/);
    assert.match(managementContext, /Setup and root-authority controls have no act verb/);
    assert.match(managementContext, /Reviewed\/Unrestricted selector/);
    assert.match(managementContext, /cite policies/);
    assert.match(managementContext, /never gather, accept, or relay credentials/);
    // Standing-policy top-up (docs/fold-consecrations.md §Standing policies):
    // an exercised policy is reported from `staged.autoApproval`, and policy
    // authoring exists only in Settings → The fold — the fold cites policies
    // and must never claim it can write one.
    assert.match(managementContext, /staged\.autoApproval/);
    assert.match(managementContext, /person authored in Settings → The fold/);
    assert.match(managementContext, /You may cite policies, never write them/);
    // Approved remote browsers inherit the machine mode but cannot select it;
    // automatic receipts preserve the initiating browser/grant identity.
    assert.match(managementContext, /approved browsers inherit the desktop's setting/);
    assert.match(managementContext, /surface `unrestricted` plus that browser and grant identity/);
    assert.match(managementContext, /The browser cannot change the mode/);
    // File grants keep reviewed folder choice and make the whole-Space scope
    // explicit under Unrestricted.
    assert.match(managementContext, /Reviewed-mode card/);
    assert.match(managementContext, /Unrestricted mode deliberately grants the whole Space/);
    // Help topics exist now, and the instructions cite them.
    assert.match(managementContext, /work-fold help <family>/);
    // Routings: inert proposals, mode-governed enablement, one-time v2
    // deferral, and no cross-Space execution inside a portable Space Chat.
    assert.match(managementContext, /Never run cross-Space work through a Space Chat\./);
    assert.match(managementContext, /work-fold\.routing-proposal/);
    assert.match(managementContext, /Use version 1 for manual, interval, and on-settled triggers/);
    assert.match(managementContext, /Use version 2 for a one-time trigger shaped exactly/);
    assert.match(managementContext, /`ifMissed` is required/);
    assert.match(managementContext, /1 minute through 366 days ahead/);
    assert.match(managementContext, /routings stage --proposal/);
    assert.match(managementContext, /Reviewed waits for a person; Unrestricted lets the host consume/);
    assert.match(managementContext, /routings show --routing <id>/);
    assert.match(managementContext, /routings receipts \[--routing <id>\]/);
    assert.match(managementContext, /routings sit above Spaces and take no `--space`/);
    assert.match(managementContext, /A pure reminder performs no future Assistant work/);
    assert.match(managementContext, /For deferred work, resolve an unambiguous absolute time/);
    assert.match(managementContext, /finish the current turn/);
    assert.match(managementContext, /Never busy-wait/);
    assert.match(managementContext, /The fold is never a routing target/);
    assert.match(managementContext, /Run-now creates a copy without consuming the declared slot/);
    // The glance (docs/fold-glance.md): narration on demand from the digest,
    // truncation disclosed, seen markers untouched, never self-scheduled.
    assert.match(managementContext, /never present a truncated section as complete/);
    assert.match(managementContext, /narration never advances a marker/);
    // Seen markers are per-surface — popover, main window, and one marker per
    // approved remote browser grant — and narration advances none of them.
    assert.match(managementContext, /remote:<grantId>/);
    assert.match(managementContext, /not the popover's, not the main window's, not any remote grant's/);
    assert.match(managementContext, /Narration is on demand only\./);
    // Report discipline covers every staged outcome without losing attachment
    // accounting or the question-on-final-line rule.
    assert.match(managementContext, /Read each staging result/);
    assert.match(managementContext, /Account for every attached item by name/);
    assert.match(managementContext, /own final line ending with a question mark/);

    // The manage-spaces Skill teaches the same surface and etiquette.
    const skillContent = await readFile(join(managementRoot, ".pi", "skills", "manage-spaces", "SKILL.md"), "utf8");
    assert.match(skillContent, /Staged decision path:/);
    assert.match(skillContent, /inspect `staged\.state` and `staged\.autoApproval`/);
    assert.match(skillContent, /Setup-only \(no act verb\)/);
    assert.match(skillContent, /Never delegate cross-Space work into a Space Chat/);
    assert.match(skillContent, /work-fold\.routing-proposal/);
    assert.match(skillContent, /one-time trigger requires version 2/);
    assert.match(skillContent, /`ifMissed` is required/);
    assert.match(skillContent, /1 minute through 366 days ahead/);
    assert.match(skillContent, /routings list\|show\|run\|stop\|disable\|delete\|receipts/);
    assert.match(skillContent, /A pure reminder does no future Assistant work/);
    assert.match(skillContent, /Deferred work uses a version-2 `at` routing/);
    assert.match(skillContent, /finish the current turn/);
    assert.match(skillContent, /Never busy-wait/);
    assert.match(skillContent, /the fold is never the routing target/);
    assert.match(skillContent, /Run-now is a copy that does not consume the one-time slot/);
    assert.match(skillContent, /pages status\|revoke\|narrow\|snapshot-off --publication <id>/);
    // The staged list teaches `pages stage-app` with its boundaries: either
    // instance id, one exposure per instance, and no snapshot lane for apps.
    assert.match(skillContent, /`pages stage-app` \(an installed App Instance at the person's address — `--instance` accepts the App Instance id or the Runtime Instance id, one exposure per instance, and never `--snapshot`: apps have no sleep copy\)/);
    assert.match(skillContent, /manage glance --json/);
    assert.match(skillContent, /files move --space <id>/);
    assert.match(skillContent, /waiting is not done, while a returned policy or Unrestricted execution outcome is/);
    // The wave-4 teaching top-ups reach the Skill too: exercised-policy
    // reporting and authoring boundary, decision surfaces with card-stated
    // limits and per-grant markers, the file-grant folder choice, publication
    // problems in the glance, and the help topics.
    assert.match(skillContent, /staged\.autoApproval/);
    assert.match(skillContent, /standing-policy authoring, and the root authority mode/);
    assert.match(skillContent, /every approved browser inherits automatic execution/);
    assert.match(skillContent, /becomes whole-Space access/);
    assert.match(skillContent, /remote:<grantId>/);
    assert.match(skillContent, /main window's Needs-you flyout at decision time/);
    assert.match(skillContent, /glance change items with the precise reason/);
    assert.match(skillContent, /revealed only in Settings → The fold/);
    assert.match(skillContent, /work-fold help <family>/);

    // Before any send there is no conversation to inspect.
    await assert.rejects(
      () => facade.manageConversationStatus({}),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );

    // The first send creates the default management conversation and runs a
    // real turn through the personal-scope /hold extension — proving the
    // management client loads personal Pi capabilities without any Space.
    const send = await facade.manageSend({ content: "/hold" });
    assert.ok(send.conversationId);
    assert.ok(send.taskId);
    const running = await api.kernel.getTasks({ kind: "system" });
    const managementTask = running.tasks.find((task) => task.id === send.taskId);
    assert.equal(managementTask?.spaceId, workFoldManagementScopeId, "management turns must be tracked under the management scope id");
    assert.equal(managementTask?.actor.kind, "cli");

    await waitForAsync(async () => (await facade.manageTurnStatus({ taskId: send.taskId })).task.state !== "running");
    const settled = await facade.manageTurnStatus({ taskId: send.taskId });
    assert.equal(settled.task.state, "succeeded");
    assert.equal(settled.task.conversationId, send.conversationId);

    const result = await facade.manageTurnResult({ taskId: send.taskId });
    assert.equal(result.message.content, "Command completed.");
    assert.equal(result.conversationId, send.conversationId);

    // The transcript is machine-local application state, not Space content.
    assert.equal(managementRoot.startsWith(join(sandbox, "state")), true, "management records live under the app state root");
    const transcripts = await readdir(join(managementRoot, ".work-fold", "conversations"));
    assert.equal(transcripts.some((file) => file === `${send.conversationId}.jsonl`), true);
    assert.equal(existsSync(join(sandbox, "content", "management")), false, "no Space folder is created for the management scope");

    // Selector-free commands keep targeting the same default conversation.
    const second = await facade.manageSend({ content: "/hold" });
    assert.equal(second.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.manageTurnStatus({ taskId: second.taskId })).task.state !== "running");

    const status = await facade.manageConversationStatus({});
    assert.equal(status.conversation.id, send.conversationId);
    assert.equal(status.state, "idle");
    const tail = await facade.manageConversationResult({ messages: 10 });
    assert.equal(tail.lastAssistant, "Command completed.");
    assert.equal(tail.conversationId, send.conversationId);
    assert.equal((await facade.manageList()).conversations.length, 1);
    assert.equal((await facade.manageAbort({})).aborted, false);

    // --new starts a separate management conversation on request.
    const fresh = await facade.manageSend({ content: "/hold", newConversation: true });
    assert.notEqual(fresh.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.manageTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await facade.manageList()).conversations.length, 2);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the management conversation fails closed when its required instructions cannot be prepared", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-management-fail-closed-test-"));
  const stateBase = join(sandbox, "state");
  await mkdir(stateBase, { recursive: true });
  // Occupy the management root with a regular file. The rest of work-fold
  // must still start, but this full-trust scope must not run uninstructed.
  await writeFile(join(stateBase, "management"), "not a directory", "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    await assert.rejects(
      () => api.actFacade.manageList(),
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
    spaceBase: join(sandbox, "content"),
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
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-management-test-"));
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
    spaceBase: join(sandbox, "content"),
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

    const locallyStarted = await api.actFacade.manageSend({ content: "/hold local-owner" });
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
    assert.equal((await api.actFacade.manageStop({ taskId: locallyStarted.taskId })).managementAborted, true);
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: locallyStarted.taskId })).task.state !== "running");

    const space = await api.actFacade.createSpace({ name: "Remote Files" });
    await writeFile(join(space.space.spaceRoot, "brief.txt"), "private content", "utf8");
    const spaces = await api.remoteFacade.execute("spaces.list", {}, principal) as { spaces: Array<Record<string, unknown>> };
    assert.deepEqual(spaces.spaces, [{ id: space.space.id, name: "Remote Files" }], "absolute roots never cross the remote facade");
    const tree = await api.remoteFacade.execute("spaces.tree", { spaceId: space.space.id, path: "" }, principal) as {
      tree: Array<{ name: string; path: string }>;
    };
    assert.deepEqual(tree.tree.map((entry) => ({ name: entry.name, path: entry.path })), [{ name: "brief.txt", path: "brief.txt" }]);
    await assert.rejects(
      () => api.remoteFacade.execute("spaces.tree", { spaceId: space.space.id, path: "../outside" }, principal),
      /Space-relative/,
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
      /Wait for the current Assistant turn to finish/,
      "renaming never races a running Assistant turn",
    );
    const ownedStop = await api.remoteFacade.execute(
      "management.stop",
      { taskId: sent.taskId },
      { ...principal, requestId: "request-owned-stop" },
    ) as { stopped: { taskId: string; managementAborted: boolean } };
    assert.equal(ownedStop.stopped.taskId, sent.taskId);
    assert.equal(ownedStop.stopped.managementAborted, true, "the exact accepting browser grant can stop its request");

    const duplicate = await api.remoteFacade.execute("management.send", { content: "/hold" }, principal) as { duplicate?: boolean; taskId: string | null };
    assert.equal(duplicate.duplicate, true, "the signed request id is idempotent at the semantic adapter");
    assert.equal(duplicate.taskId, null);
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: sent.taskId })).task.state !== "running");
    const sameIdOtherGrant = await api.remoteFacade.execute(
      "management.send",
      { content: "cross-grant request", conversationId: sent.conversationId },
      { ...principal, grantId: "grant-other" },
    ) as { duplicate?: boolean; taskId: string };
    assert.equal(sameIdOtherGrant.duplicate, undefined, "request ids are idempotent only within their exact browser grant");
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: sameIdOtherGrant.taskId })).task.state !== "running");

    const renamePrincipal = { ...principal, requestId: "request-rename-chat" };
    const transcriptPath = join(workFoldManagementRoot(), ".work-fold", "conversations", `${sent.conversationId}.jsonl`);
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
      (await api.actFacade.manageConversationStatus({ conversationId: sent.conversationId })).conversation.title,
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
    assert.equal((await api.actFacade.manageConversationStatus({})).conversation.id, sent.conversationId, "web and menu-bar/CLI views resolve the same transcript");
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
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await api.actFacade.manageConversationStatus({})).conversation.id, fresh.conversationId);

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
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: resumed.taskId })).task.state !== "running");
    const selectedSummary = await api.remoteFacade.execute(
      "management.summary",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-selected-summary" },
    ) as { conversation: { id: string }; latestRequest: { conversationId: string } };
    assert.equal(selectedSummary.conversation.id, sent.conversationId);
    assert.equal(selectedSummary.latestRequest.conversationId, sent.conversationId);

    const managementUploadRequestId = "request-management-upload";
    const uploadedToManagement = await api.remoteFacade.execute(
      "management.send",
      {
        content: "/hold",
        conversationId: sent.conversationId,
        attachments: [{ name: "brief-upload.txt", data: Buffer.from("remote brief", "utf8").toString("base64url") }],
      },
      { ...principal, requestId: managementUploadRequestId },
    ) as {
      conversationId: string;
      taskId: string;
      uploads: Array<{ name: string; sizeBytes: number }>;
    };
    assert.deepEqual(uploadedToManagement.uploads, [{ name: "brief-upload.txt", sizeBytes: 12 }]);
    assert.doesNotMatch(JSON.stringify(uploadedToManagement), new RegExp(sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const stagedManagementPath = join(
      workFoldManagementRoot(),
      "Incoming",
      "Remote",
      principal.grantId,
      managementUploadRequestId,
      "brief-upload.txt",
    );
    assert.equal(existsSync(stagedManagementPath), true);
    await waitForAsync(async () => (await api.actFacade.manageTurnStatus({ taskId: uploadedToManagement.taskId })).task.state !== "running");
    const uploadTranscript = await api.remoteFacade.execute(
      "management.transcript",
      { conversationId: sent.conversationId },
      { ...principal, requestId: "request-management-upload-transcript" },
    ) as { messages: Array<{ role: string; attachments?: Array<{ kind: string; name: string; target?: string }> }> };
    const uploadMessage = uploadTranscript.messages.find((message) => message.attachments?.some((attachment) => attachment.name === "brief-upload.txt"));
    assert.deepEqual(uploadMessage?.attachments, [{ kind: "file", name: "brief-upload.txt" }], "remote transcripts expose attachment identity without local paths");

    await api.remoteFacade.purgeUploads(principal.grantId);
    assert.equal(existsSync(stagedManagementPath), false, "revoking a browser can purge its staged management uploads");

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
