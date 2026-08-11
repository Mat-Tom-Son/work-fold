import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { WORKFOLD_CLI_ACT_SURFACES } from "../src/local/cli/act-receipts.js";
import {
  FOLD_DECISION_SURFACES,
  FOLD_STAGED_ACT_PENDING_CAP,
  FOLD_STAGED_ACT_SETTLED_RETENTION,
  FOLD_STAGED_ACT_TTL_MS,
  FoldStagedActError,
  FoldStagedActStore,
  foldStagedActsFile,
  type FoldDecisionRecord,
  type FoldDecisionSurface,
  type FoldStagedAct,
  type FoldStagedActDecisionInput,
  type FoldStagedActErrorCode,
  type FoldStagedActInput,
  type FoldStagedActKind,
  type FoldStagedActProvenance,
} from "../src/local/fold-staged-acts.js";

function fixedClock(iso = "2026-08-10T10:00:00.000Z"): { at: number; now: () => Date } {
  const clock = { at: Date.parse(iso), now: () => new Date(clock.at) };
  return clock;
}

function provenance(requestId: string, remote?: { browserId: string; grantId: string }): FoldStagedActProvenance {
  return {
    stagedVia: "management-conversation",
    conversationId: "manage-chat-1",
    parentTaskId: "task-1",
    requestId,
    ...(remote ?? {}),
  };
}

function grantInput(overrides: {
  spaceId?: string;
  appInstanceId?: string;
  declarationId?: string;
  requestId?: string;
  remote?: { browserId: string; grantId: string };
} = {}): FoldStagedActInput {
  const appInstanceId = overrides.appInstanceId ?? "app-mail";
  const declarationId = overrides.declarationId ?? "net-api.example.com";
  return {
    kind: "app.grant.network",
    parameters: { spaceId: overrides.spaceId ?? "space-alpha", appInstanceId, declarationId },
    pins: { appInstanceId, declarationId, releaseDigest: "d".repeat(64) },
    provenance: provenance(overrides.requestId ?? `req-${appInstanceId}-${declarationId}`, overrides.remote),
  };
}

function isRefusal(code: FoldStagedActErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof FoldStagedActError && error.code === code;
}

test("staging admits a typed act, derives its category, persists across reopen, and dedupes identical pins", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-"));
  const path = join(sandbox, "fold", "staged-acts.json");
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path, now: clock.now });
    const stagedEvents: string[] = [];
    store.on("staged", (act: FoldStagedAct) => stagedEvents.push(act.id));

    const admission = await store.stage(grantInput());
    assert.equal(admission.deduplicated, false);
    const act = admission.act;
    assert.equal(act.schemaVersion, 1);
    assert.equal(act.state, "staged");
    assert.equal(act.category, "widen-power", "the store, not the caller, derives the consecration category");
    assert.equal(act.kind, "app.grant.network");
    assert.equal(Date.parse(act.expiresAt) - Date.parse(act.createdAt), FOLD_STAGED_ACT_TTL_MS);
    assert.equal(act.provenance.conversationId, "manage-chat-1");
    assert.equal(act.decision, undefined);
    assert.deepEqual(stagedEvents, [act.id]);
    assert.deepEqual(store.status(), { damaged: false, pendingCount: 1 });

    const dedupe = await store.stage(grantInput({ spaceId: "space-beta", requestId: "req-second" }));
    assert.equal(dedupe.deduplicated, true, "identical kind and pins return the existing card");
    assert.equal(dedupe.act.id, act.id);
    assert.equal((await store.list()).length, 1);

    const other = await store.stage(grantInput({ declarationId: "net-other.example.com", requestId: "req-third" }));
    assert.equal(other.deduplicated, false);
    assert.notEqual(other.act.id, act.id);

    const reopened = await FoldStagedActStore.create({ path, now: clock.now });
    assert.equal((await reopened.get(act.id))?.state, "staged", "a card waits for the person, not for the process");
    assert.equal(reopened.status().pendingCount, 2);
    assert.equal((await reopened.list({ spaceId: "space-alpha" })).length, 2);
    assert.equal(foldStagedActsFile(sandbox), path);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("staging fails closed: unknown kinds, unknown or malformed fields, and broken provenance are refused", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-invalid-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    const grant = grantInput();
    const refusals: Array<[string, FoldStagedActInput, FoldStagedActErrorCode]> = [
      ["unknown kind", { ...grant, kind: "fold.hack" as FoldStagedActKind }, "KIND_UNKNOWN"],
      ["unknown parameter field", { ...grant, parameters: { ...grant.parameters, note: "please approve" } }, "INPUT_INVALID"],
      ["missing required pin", { ...grant, pins: { appInstanceId: "app-mail", declarationId: "net-api.example.com" } }, "INPUT_INVALID"],
      ["non-object parameters", { ...grant, parameters: null as unknown as FoldStagedActInput["parameters"] }, "INPUT_INVALID"],
      [
        "wrong pin type",
        {
          kind: "app.storage.clear",
          parameters: { spaceId: "space-alpha", appInstanceId: "app-mail" },
          pins: { appInstanceId: "app-mail", dataNamespaceIds: ["ns-1"], observedBytes: "12" as unknown as number },
          provenance: provenance("req-bytes"),
        },
        "INPUT_INVALID",
      ],
      [
        "control characters in an identity",
        { ...grant, parameters: { ...grant.parameters, declarationId: "net\u0000evil" } },
        "INPUT_INVALID",
      ],
      [
        "remote provenance without its grant",
        { ...grant, provenance: { stagedVia: "act-cli", requestId: "req-remote", browserId: "browser-1" } },
        "INPUT_INVALID",
      ],
      [
        "unknown provenance field",
        { ...grant, provenance: { ...provenance("req-extra"), reason: "trust me" } as unknown as FoldStagedActProvenance },
        "INPUT_INVALID",
      ],
      [
        "Space scope without a Space id",
        {
          kind: "capability.package.install",
          parameters: { source: "npm:example-tool", scope: "space" },
          pins: { packageId: "example-tool", version: "1.0.0", source: "npm:example-tool", scope: "space", resourceSummary: "1 extension, 0 skills" },
          provenance: provenance("req-pkg"),
        },
        "INPUT_INVALID",
      ],
      [
        "both source and catalog id",
        {
          kind: "capability.package.install",
          parameters: { source: "npm:example-tool", catalogId: "example", scope: "personal" },
          pins: { packageId: "example-tool", version: "1.0.0", source: "npm:example-tool", scope: "personal", resourceSummary: "1 extension, 0 skills" },
          provenance: provenance("req-pkg-2"),
        },
        "INPUT_INVALID",
      ],
      [
        "Personal scope with a Space id",
        {
          kind: "capability.skills.import",
          parameters: { source: "anthropic-marketplace:writing", scope: "personal", spaceId: "space-alpha" },
          pins: { source: "anthropic-marketplace:writing", contentDigest: "a".repeat(64), skillNames: ["writing"] },
          provenance: provenance("req-skill"),
        },
        "INPUT_INVALID",
      ],
      [
        "one observed identity per destroyed path",
        {
          kind: "files.destroy",
          parameters: { spaceId: "space-alpha", paths: ["notes/a.txt", "notes/b.txt"] },
          pins: { spaceId: "space-alpha", paths: ["notes/a.txt", "notes/b.txt"], contentIdentities: ["sha256:aa"] },
          provenance: provenance("req-destroy"),
        },
        "INPUT_INVALID",
      ],
      [
        "page exposure missing its path",
        {
          kind: "publish.viewer.expose",
          parameters: { exposure: "page", spaceId: "space-alpha" },
          pins: { exposure: "page", spaceId: "space-alpha", title: "Report", snapshotEnabled: false, byteBudget: 1_000_000, serveBudget: 200 },
          provenance: provenance("req-page"),
        },
        "INPUT_INVALID",
      ],
      [
        "hosted exposure carrying a page-only field",
        {
          kind: "publish.viewer.expose",
          parameters: { exposure: "hosted-app", appInstanceId: "app-mail" },
          pins: {
            exposure: "hosted-app",
            appInstanceId: "app-mail",
            releaseDigest: "e".repeat(64),
            viewerEntry: "index.html",
            viewerSurface: ["storage.read"],
            title: "sneaky",
          },
          provenance: provenance("req-hosted"),
        },
        "INPUT_INVALID",
      ],
      [
        "parameters and pins disagreeing on an identity",
        {
          ...grant,
          parameters: { spaceId: "space-alpha", appInstanceId: "app-mail", declarationId: "net-api.example.com" },
          pins: { appInstanceId: "app-other", declarationId: "net-api.example.com", releaseDigest: "d".repeat(64) },
        },
        "INPUT_INVALID",
      ],
      [
        "empty identity list",
        {
          kind: "app.data.purge",
          parameters: { spaceId: "space-alpha", appInstanceId: "app-mail" },
          pins: { appInstanceId: "app-mail", dataNamespaceIds: [] },
          provenance: provenance("req-purge"),
        },
        "INPUT_INVALID",
      ],
      [
        "oversized identity",
        { ...grant, parameters: { ...grant.parameters, declarationId: "x".repeat(2049) } },
        "INPUT_INVALID",
      ],
    ];
    for (const [label, input, code] of refusals) {
      await assert.rejects(store.stage(input), isRefusal(code), `expected ${code} for ${label}`);
    }
    assert.deepEqual(await store.list(), [], "no refused act may enter the store");
    assert.equal(store.status().pendingCount, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the pending cap refuses the next staging with an honest error naming the pending cards", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-cap-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    for (let index = 0; index < FOLD_STAGED_ACT_PENDING_CAP; index += 1) {
      await store.stage(grantInput({ declarationId: `net-${index}.example.com`, requestId: `req-${index}` }));
    }
    const caught = await store.stage(grantInput({ declarationId: "net-overflow.example.com", requestId: "req-overflow" }))
      .then(() => null, (error: unknown) => error);
    assert.ok(caught instanceof FoldStagedActError);
    assert.equal(caught.code, "PENDING_CAP");
    assert.equal(caught.pending?.length, FOLD_STAGED_ACT_PENDING_CAP);
    assert.match(caught.message, /32 staged acts are already pending/);
    assert.match(caught.message, /app\.grant\.network/);

    const pending = await store.list({ state: "staged" });
    assert.equal(pending.length, FOLD_STAGED_ACT_PENDING_CAP);
    await store.cancel(pending[0].id);
    const admitted = await store.stage(grantInput({ declarationId: "net-overflow.example.com", requestId: "req-overflow" }));
    assert.equal(admitted.deduplicated, false, "settling a card frees its slot");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("expiry is evaluated lazily at read time, rechecked at decide time, and is never approval", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-expiry-"));
  const path = join(sandbox, "staged-acts.json");
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path, now: clock.now });
    const first = (await store.stage(grantInput({ declarationId: "net-a.example.com", requestId: "req-a" }))).act;
    const second = (await store.stage(grantInput({ declarationId: "net-b.example.com", requestId: "req-b" }))).act;

    clock.at += FOLD_STAGED_ACT_TTL_MS - 1;
    assert.equal((await store.get(first.id))?.state, "staged");
    clock.at += 1;

    await assert.rejects(
      store.decide(second.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldStagedActError && error.code === "EXPIRED" && error.state === "expired",
      "a decision arriving after the TTL is refused, even from a stale card",
    );

    const read = await store.get(first.id);
    assert.equal(read?.state, "expired");
    assert.ok(read?.settledAt, "expiry is its own recorded outcome");
    assert.equal(read?.decision, undefined, "expiry is not approval and not denial");
    assert.equal(store.status().pendingCount, 0);

    const reopened = await FoldStagedActStore.create({ path, now: clock.now });
    assert.equal((await reopened.get(second.id))?.state, "expired", "lazy expiry persists");

    const restaged = await reopened.stage(grantInput({ declarationId: "net-a.example.com", requestId: "req-a2" }));
    assert.equal(restaged.deduplicated, false, "the fold may restage on a fresh request after expiry");
    assert.notEqual(restaged.act.id, first.id, "staged-act ids are single-use");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("deciding consumes the act exactly once, journal-first: a failed journal leaves it staged", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-decide-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    const act = (await store.stage(grantInput())).act;

    await assert.rejects(
      store.decide(act.id, { decision: "approved", surface: "popover" }, {
        journal: () => {
          throw new Error("journal disk full");
        },
      }),
      isRefusal("JOURNAL_UNAVAILABLE"),
    );
    assert.equal((await store.get(act.id))?.state, "staged", "an unwritable journal refuses without consuming");

    const journaled: Array<{ state: string; decision: string }> = [];
    const journal = (snapshot: FoldStagedAct, decision: FoldDecisionRecord) => {
      journaled.push({ state: snapshot.state, decision: decision.decision });
    };
    const outcomes = await Promise.allSettled([
      store.decide(act.id, { decision: "approved", surface: "popover" }, { journal }),
      store.decide(
        act.id,
        { decision: "approved", surface: "remote_web", browserId: "browser-1", grantId: "grant-1" },
        { journal },
      ),
    ]);
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<FoldStagedAct> => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1, "of two concurrent decides, exactly one consumes the act");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof FoldStagedActError);
    assert.equal(rejected[0].reason.code, "ALREADY_SETTLED");
    assert.equal(rejected[0].reason.state, "approved", "the loser is refused with the settled outcome");
    assert.deepEqual(journaled, [{ state: "staged", decision: "approved" }], "the journal append sees the act before the transition commits");

    const decided = fulfilled[0].value;
    assert.equal(decided.state, "approved");
    assert.equal(decided.decision?.surface, "popover");
    assert.equal(decided.decidedAt, decided.settledAt);

    const executed = await store.recordExecution(act.id, "executed");
    assert.equal(executed.execution?.outcome, "executed");
    await assert.rejects(store.recordExecution(act.id, "executed"), isRefusal("EXECUTION_INVALID"));
    await assert.rejects(
      store.decide("no-such-act", { decision: "approved", surface: "popover" }),
      isRefusal("NOT_FOUND"),
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("decision surfaces keep the receipts vocabulary: the act lane never decides, policy and browser identities are named", async () => {
  assert.deepEqual(
    [...FOLD_DECISION_SURFACES],
    WORKFOLD_CLI_ACT_SURFACES.filter((surface) => surface !== "cli"),
    "the decision surfaces are the act-receipt vocabulary minus cli",
  );
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-surface-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    const first = (await store.stage(grantInput({ declarationId: "net-1.example.com", requestId: "req-1" }))).act;

    const invalidInputs: Array<[string, FoldStagedActDecisionInput]> = [
      ["cli surface", { decision: "approved", surface: "cli" as unknown as FoldDecisionSurface }],
      ["policy without its id", { decision: "approved", surface: "policy" }],
      ["policy id on a click", { decision: "approved", surface: "popover", policyId: "policy-1" }],
      ["remote without its browser", { decision: "approved", surface: "remote_web" }],
      ["browser identity on a desktop click", { decision: "approved", surface: "popover", browserId: "browser-1", grantId: "grant-1" }],
      ["note on an approval", { decision: "approved", surface: "popover", note: "why not" }],
      ["unknown decision", { decision: "maybe" as unknown as "approved", surface: "popover" }],
    ];
    for (const [label, input] of invalidInputs) {
      await assert.rejects(store.decide(first.id, input), isRefusal("INPUT_INVALID"), `expected refusal for ${label}`);
    }
    assert.equal((await store.get(first.id))?.state, "staged", "refused inputs consume nothing");

    const byPolicy = await store.decide(first.id, {
      decision: "approved",
      surface: "policy",
      policyId: "policy-marketplace-skills",
    });
    assert.equal(byPolicy.decision?.surface, "policy");
    assert.equal(byPolicy.decision?.policyId, "policy-marketplace-skills");

    const second = (await store.stage(grantInput({ declarationId: "net-2.example.com", requestId: "req-2" }))).act;
    const denied = await store.decide(second.id, {
      decision: "denied",
      surface: "remote_web",
      browserId: "browser-1",
      grantId: "grant-1",
      note: "not\u0000now",
    });
    assert.equal(denied.state, "denied");
    assert.equal(denied.decision?.browserId, "browser-1");
    assert.equal(denied.decision?.grantId, "grant-1");
    assert.equal(denied.decision?.note, "not\uFFFDnow", "person-authored notes are scrubbed, never trusted raw");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("denial is terminal for the record; restaging identical pins carries denial memory", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-denial-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    const first = (await store.stage(grantInput())).act;
    const denied = await store.decide(first.id, { decision: "denied", surface: "main-window" });
    assert.equal(denied.state, "denied");

    clock.at += 60_000;
    const restaged = await store.stage(grantInput({ requestId: "req-again" }));
    assert.equal(restaged.deduplicated, false, "restaging after denial is allowed; circumstances change");
    assert.notEqual(restaged.act.id, first.id);
    assert.equal(restaged.act.priorDenialAt, denied.decidedAt, "the new card states the prior denial and when it happened");

    await assert.rejects(
      store.decide(first.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldStagedActError && error.code === "ALREADY_SETTLED" && error.state === "denied",
      "denial is recorded, never retried",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("invalidation and cancellation are typed transitions; settling twice is a refusal, not a second transition", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-settle-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    const first = (await store.stage(grantInput({ declarationId: "net-1.example.com", requestId: "req-1" }))).act;
    const second = (await store.stage(grantInput({ declarationId: "net-2.example.com", requestId: "req-2" }))).act;

    const invalidated = await store.invalidate(first.id, "The pinned release digest no longer matches the installed app.");
    assert.equal(invalidated.state, "invalidated");
    assert.match(invalidated.invalidationReason ?? "", /no longer matches/);
    await assert.rejects(
      store.decide(first.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldStagedActError && error.code === "ALREADY_SETTLED" && error.state === "invalidated",
    );
    await assert.rejects(store.invalidate(first.id, "again"), isRefusal("ALREADY_SETTLED"));

    const canceled = await store.cancel(second.id);
    assert.equal(canceled.state, "canceled");
    assert.ok(canceled.cancellationReason);
    await assert.rejects(store.cancel(second.id), isRefusal("ALREADY_SETTLED"));
    await assert.rejects(store.cancel("no-such-act"), isRefusal("NOT_FOUND"));
    await assert.rejects(store.invalidate(second.id, "   "), isRefusal("INPUT_INVALID"));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("cascades cancel pending dependents of a removed Space, app, superseded review, or revoked browser; decided acts stand", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-cascade-"));
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json"), now: clock.now });
    const spaceAct = (await store.stage(grantInput({ spaceId: "space-doomed", declarationId: "net-1.example.com", requestId: "req-1" }))).act;
    const keptAct = (await store.stage(grantInput({ spaceId: "space-kept", declarationId: "net-2.example.com", requestId: "req-2" }))).act;
    const reviewAct = (await store.stage({
      kind: "app.review.approve",
      parameters: { spaceId: "space-kept", proposalId: "proposal-9" },
      pins: { proposalId: "proposal-9", reviewDigest: "a".repeat(64) },
      provenance: provenance("req-3"),
    })).act;
    const purgeAct = (await store.stage({
      kind: "app.data.purge",
      parameters: { spaceId: "space-kept", appInstanceId: "app-doomed" },
      pins: { appInstanceId: "app-doomed", dataNamespaceIds: ["ns-1", "ns-2"] },
      provenance: provenance("req-4"),
    })).act;
    const remoteStaged = (await store.stage(grantInput({
      spaceId: "space-kept",
      declarationId: "net-3.example.com",
      requestId: "req-5",
      remote: { browserId: "browser-9", grantId: "grant-9" },
    }))).act;
    const remoteDecided = (await store.stage(grantInput({
      spaceId: "space-kept",
      declarationId: "net-4.example.com",
      requestId: "req-6",
      remote: { browserId: "browser-9", grantId: "grant-9" },
    }))).act;
    await store.decide(remoteDecided.id, { decision: "approved", surface: "popover" });

    const bySpace = await store.cancelForSpace("space-doomed");
    assert.deepEqual(bySpace.map((act) => act.id), [spaceAct.id]);
    assert.match(bySpace[0].cancellationReason ?? "", /Space this act was staged for was removed/);

    const byProposal = await store.cancelForReviewProposal("proposal-9");
    assert.deepEqual(byProposal.map((act) => act.id), [reviewAct.id]);

    const byApp = await store.cancelForAppInstance("app-doomed");
    assert.deepEqual(byApp.map((act) => act.id), [purgeAct.id]);

    const byBrowser = await store.cancelForBrowserGrant({ grantId: "grant-9" });
    assert.deepEqual(byBrowser.map((act) => act.id), [remoteStaged.id], "revocation cancels pending acts staged at that browser's behest");
    assert.match(byBrowser[0].cancellationReason ?? "", /remote browser whose request staged this act was revoked/);

    assert.equal((await store.get(keptAct.id))?.state, "staged", "cascades touch only their own dependents");
    assert.equal((await store.get(remoteDecided.id))?.state, "approved", "a decision that already happened stands; its receipt names the browser");
    assert.deepEqual(await store.cancelForBrowserGrant({ browserId: "browser-9" }), [], "cascades are idempotent over settled acts");
    await assert.rejects(store.cancelForBrowserGrant({}), isRefusal("INPUT_INVALID"));
    await assert.rejects(store.cancelForSpace(""), isRefusal("INPUT_INVALID"));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("damaged or future-versioned state disables staging and deciding rather than guessing, and is never overwritten", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-damage-"));
  const path = join(sandbox, "fold", "staged-acts.json");
  const clock = fixedClock();
  try {
    await mkdir(dirname(path), { recursive: true });

    const donorPath = join(sandbox, "donor", "staged-acts.json");
    const donor = await FoldStagedActStore.create({ path: donorPath, now: clock.now });
    await donor.stage(grantInput());
    const donorText = await readFile(donorPath, "utf8");

    const futureText = `${JSON.stringify({ schemaVersion: 2, acts: [] }, null, 2)}\n`;
    await writeFile(path, futureText, "utf8");
    const futureStore = await FoldStagedActStore.create({ path, now: clock.now });
    assert.equal(futureStore.status().damaged, true);
    assert.match(futureStore.status().damageReason ?? "", /newer work-fold/);
    assert.equal(futureStore.status().pendingCount, 0);
    await assert.rejects(futureStore.stage(grantInput()), isRefusal("STORE_DAMAGED"));
    await assert.rejects(futureStore.decide("any", { decision: "approved", surface: "popover" }), isRefusal("STORE_DAMAGED"));
    await assert.rejects(futureStore.list(), isRefusal("STORE_DAMAGED"));
    await assert.rejects(futureStore.cancel("any"), isRefusal("STORE_DAMAGED"));
    await assert.rejects(futureStore.cancelForSpace("space-alpha"), isRefusal("STORE_DAMAGED"));
    await assert.rejects(futureStore.recordExecution("any", "executed"), isRefusal("STORE_DAMAGED"));
    assert.equal(await readFile(path, "utf8"), futureText, "future-versioned state is preserved, not rewritten");

    await writeFile(path, "not json", "utf8");
    assert.equal((await FoldStagedActStore.create({ path, now: clock.now })).status().damaged, true);

    const unknownKind = JSON.parse(donorText) as { acts: Array<Record<string, unknown>> };
    unknownKind.acts[0].kind = "fold.exfiltrate";
    await writeFile(path, JSON.stringify(unknownKind), "utf8");
    const unknownKindStore = await FoldStagedActStore.create({ path, now: clock.now });
    assert.equal(unknownKindStore.status().damaged, true);
    assert.match(unknownKindStore.status().damageReason ?? "", /invalid act/);

    const tampered = JSON.parse(donorText) as { acts: Array<Record<string, unknown>> };
    tampered.acts[0].decision = { decision: "approved", surface: "popover" };
    await writeFile(path, JSON.stringify(tampered), "utf8");
    const tamperedStore = await FoldStagedActStore.create({ path, now: clock.now });
    assert.equal(tamperedStore.status().damaged, true, "a staged act carrying a decision is damage, not a decided act");

    await rm(path, { force: true });
    const fresh = await FoldStagedActStore.create({ path, now: clock.now });
    assert.deepEqual(fresh.status(), { damaged: false, pendingCount: 0 }, "a missing file is a fresh store, not damage");
    assert.deepEqual(await fresh.list(), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an approved act whose execution never reported is marked interrupted at the next open and never replays", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-interrupt-"));
  const path = join(sandbox, "staged-acts.json");
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path, now: clock.now });
    const act = (await store.stage(grantInput())).act;
    await store.decide(act.id, { decision: "approved", surface: "popover" });

    const reopened = await FoldStagedActStore.create({ path, now: clock.now });
    const recovered = await reopened.get(act.id);
    assert.equal(recovered?.state, "approved");
    assert.equal(recovered?.execution?.outcome, "interrupted", "an accepted decision without a terminal outcome is the honest interrupted signal");
    await assert.rejects(reopened.recordExecution(act.id, "executed"), isRefusal("EXECUTION_INVALID"));

    const second = (await reopened.stage(grantInput({ declarationId: "net-x.example.com", requestId: "req-x" }))).act;
    await assert.rejects(
      reopened.recordExecution(second.id, "failed", "boom"),
      isRefusal("EXECUTION_INVALID"),
      "a staged act has no execution to record",
    );
    await reopened.decide(second.id, { decision: "approved", surface: "main-window" });
    const failed = await reopened.recordExecution(second.id, "failed", "install\u0000failed");
    assert.equal(failed.execution?.outcome, "failed");
    assert.equal(failed.execution?.errorDetail, "install\uFFFDfailed", "host-observed error text is scrubbed and bounded");
    await assert.rejects(reopened.recordExecution(second.id, "failed", "again"), isRefusal("EXECUTION_INVALID"));

    const third = (await reopened.stage(grantInput({ declarationId: "net-y.example.com", requestId: "req-y" }))).act;
    await reopened.decide(third.id, { decision: "approved", surface: "popover" });
    await assert.rejects(
      reopened.recordExecution(third.id, "executed", "detail"),
      isRefusal("INPUT_INVALID"),
      "error detail accompanies only a failed execution",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("settled history stays bounded while pending cards and unfinished approvals survive", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-staged-acts-retention-"));
  const path = join(sandbox, "staged-acts.json");
  const clock = fixedClock();
  try {
    const store = await FoldStagedActStore.create({ path, now: clock.now });
    const approved = (await store.stage(grantInput({ declarationId: "net-keep.example.com", requestId: "req-keep" }))).act;
    await store.decide(approved.id, { decision: "approved", surface: "popover" });

    const canceledIds: string[] = [];
    const overflow = 10;
    for (let index = 0; index < FOLD_STAGED_ACT_SETTLED_RETENTION + overflow; index += 1) {
      clock.at += 1000;
      const { act } = await store.stage(grantInput({ declarationId: `net-${index}.example.com`, requestId: `req-${index}` }));
      canceledIds.push(act.id);
      await store.cancel(act.id);
    }

    const all = await store.list();
    const canceled = all.filter((act) => act.state === "canceled");
    assert.equal(canceled.length, FOLD_STAGED_ACT_SETTLED_RETENTION, "terminal history is bounded");
    const remaining = new Set(all.map((act) => act.id));
    for (const id of canceledIds.slice(0, overflow)) {
      assert.equal(remaining.has(id), false, "the oldest settled records are the ones trimmed");
    }
    assert.equal(remaining.has(approved.id), true, "an approval awaiting its execution outcome is never trimmed");

    const reopened = await FoldStagedActStore.create({ path, now: clock.now });
    const after = await reopened.list();
    assert.equal(after.length, FOLD_STAGED_ACT_SETTLED_RETENTION, "once its execution settles, the approval joins bounded history");
    assert.equal(
      (await reopened.get(approved.id))?.execution?.outcome,
      "interrupted",
      "the freshly interrupted approval outlives older settled noise",
    );
    assert.equal(
      after.some((act) => act.id === canceledIds[overflow]),
      false,
      "the oldest fully settled record is the one that makes room",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
