import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { startLocalApi } from "../src/local/server.js";
import type { WorkFoldRemotePrincipal } from "../src/local/remote-management.js";

// The remote wave of the fold surfaces (docs/fold-consecrations.md §The
// remote client; docs/fold-glance.md §The remote client home): decisions.list
// and decisions.decide serve the one host-composed card contract over the
// remote facade with surface `remote_web` and the re-verified grant identity
// on every receipt, and management.glance/management.glanceSeen serve the
// digest with per-grant seen hygiene. The bridge never sees any of this in
// the clear; these tests drive the desktop facade the envelope dispatch calls.

test("remote decisions serve the shared cards, enforce the surface rules, and attribute receipts to the grant", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-decisions-test-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principalA: WorkFoldRemotePrincipal = { browserId: "browser-a", grantId: "grant-a", requestId: "request-a-1" };
  const principalB: WorkFoldRemotePrincipal = { browserId: "browser-b", grantId: "grant-b", requestId: "request-b-1" };
  try {
    const doomed = await api.actFacade.createSpace({ name: "Remote Doomed" });
    const stagedDoomed = await api.actFacade.spacesDelete({ space: doomed.space.id });
    // Staged at a remote browser's behest: its provenance records the grant.
    const selfStaged = await api.stagedActs.stage({
      kind: "app.data.purge",
      parameters: { spaceId: doomed.space.id, appInstanceId: "app-1" },
      pins: { appInstanceId: "app-1", dataNamespaceIds: ["ns-1"] },
      provenance: { stagedVia: "act-cli", requestId: "req-remote-staged", browserId: "browser-b", grantId: "grant-b" },
    });
    // Personal-scope make-runnable: loads into the fold's own runtime, so its
    // decision belongs to a desktop surface.
    const personal = await api.stagedActs.stage({
      kind: "capability.skills.import",
      parameters: { source: "/tmp/bundle", scope: "personal" },
      pins: { source: "/tmp/bundle", contentDigest: `sha256:${"a".repeat(64)}`, skillNames: ["helper"] },
      provenance: { stagedVia: "act-cli", requestId: "req-personal" },
    });

    // Every approved browser sees the same pending cards — the same
    // host-composed projection the desktop surfaces render, soonest expiry
    // first, with both surface rules stated on the card up front.
    const listed = await api.remoteFacade.execute("decisions.list", {}, principalA) as {
      decisions: Array<Record<string, unknown>>;
    };
    assert.equal(listed.decisions.length, 3);
    const expiries = listed.decisions.map((card) => String(card.expiresAt));
    assert.deepEqual(expiries, [...expiries].sort(), "cards list soonest expiry first");
    const selfStagedCard = listed.decisions.find((card) => card.id === selfStaged.act.id)!;
    assert.equal(selfStagedCard.stagedByGrantId, "grant-b", "the staging grant is stated on the card");
    assert.equal(selfStagedCard.desktopOnly, false);
    const personalCard = listed.decisions.find((card) => card.id === personal.act.id)!;
    assert.equal(personalCard.desktopOnly, true, "Personal-scope make-runnable names the desktop as the deciding surface");
    const doomedCard = listed.decisions.find((card) => card.id === stagedDoomed.staged.decisionId)!;
    assert.equal(doomedCard.secondConfirmation, true);
    assert.equal(doomedCard.spaceName, "Remote Doomed");

    // No self-approval: the grant whose request staged an act never decides it.
    await assert.rejects(
      () => api.remoteFacade.execute("decisions.decide", { id: selfStaged.act.id, decision: "approved" }, principalB),
      /staged at this browser's request/i,
    );
    // The fold's own runtime is desktop-decided, from every remote grant.
    await assert.rejects(
      () => api.remoteFacade.execute("decisions.decide", { id: personal.act.id, decision: "approved" }, principalA),
      /desktop surface/i,
    );
    // Input validation mirrors the renderer route.
    await assert.rejects(
      () => api.remoteFacade.execute("decisions.decide", { id: selfStaged.act.id, decision: "maybe" }, principalA),
      /approved or denied/,
    );
    await assert.rejects(
      () => api.remoteFacade.execute("decisions.decide", { id: selfStaged.act.id, decision: "approved", note: "x" }, principalA),
      /only with a denial/,
    );
    await assert.rejects(
      () => api.remoteFacade.execute("decisions.decide", { id: selfStaged.act.id, decision: "denied", extra: true }, principalA),
      /does not accept extra/,
    );

    // A different approved browser can decide it; the surface and the exact
    // grant identity from the desktop's recheck land on the record.
    const denied = await api.remoteFacade.execute(
      "decisions.decide",
      { id: selfStaged.act.id, decision: "denied", note: "Not from a browser." },
      principalA,
    ) as { decision: Record<string, unknown>; receipted: boolean };
    assert.equal(denied.receipted, true);
    assert.equal(denied.decision.state, "denied");
    const record = denied.decision.decision as Record<string, unknown>;
    assert.equal(record.surface, "remote_web");
    assert.equal(record.browserId, "browser-a");
    assert.equal(record.grantId, "grant-a");
    assert.equal(record.note, "Not from a browser.");

    const receiptsProbe = new WorkFoldCliActReceipts({ stateRoot: stateBase });
    const journal = (await readFile(receiptsProbe.path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const denyReceipts = journal.filter((entry) => entry.command === "decision.deny");
    assert.deepEqual(denyReceipts.map((entry) => entry.outcome), ["accepted", "ok"]);
    for (const entry of denyReceipts) {
      assert.equal(entry.surface, "remote_web");
      assert.equal(entry.browserId, "browser-a");
      assert.equal(entry.grantId, "grant-a");
      assert.equal(entry.decisionId, selfStaged.act.id);
    }

    // Decided at most once: the loser learns the settled outcome.
    await assert.rejects(
      () => api.remoteFacade.execute("decisions.decide", { id: selfStaged.act.id, decision: "approved" }, principalA),
      /already denied/i,
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("remote glance serves the digest with per-grant seen hygiene and revocation cascades grant authority", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-glance-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principalA: WorkFoldRemotePrincipal = { browserId: "browser-a", grantId: "grant-a", requestId: "request-a-1" };
  const principalB: WorkFoldRemotePrincipal = { browserId: "browser-b", grantId: "grant-b", requestId: "request-b-1" };
  try {
    // A recorded change gives the digest a cursor: stage and deny one act.
    const staged = await api.stagedActs.stage({
      kind: "app.data.purge",
      parameters: { spaceId: "space-glance", appInstanceId: "app-glance" },
      pins: { appInstanceId: "app-glance", dataNamespaceIds: ["ns-1"] },
      provenance: { stagedVia: "act-cli", requestId: "req-glance" },
    });
    await api.foldDecisions.decide(staged.act.id, { decision: "denied", surface: "popover" });

    const first = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      glance: { cursor: string; seen: Record<string, string>; changes: Array<{ kind: string }> };
    };
    assert.ok(first.glance.cursor, "a recorded decision gives the digest a cursor");
    assert.ok(first.glance.changes.some((item) => item.kind === "decision-recorded"));
    assert.deepEqual(first.glance.seen, {}, "no marker has been acknowledged yet");

    // Marking seen advances only the requesting grant's own marker.
    const advanced = await api.remoteFacade.execute(
      "management.glanceSeen",
      { cursor: first.glance.cursor },
      principalB,
    ) as { advanced: boolean; seenThrough: string | null };
    assert.deepEqual(advanced, { advanced: true, seenThrough: first.glance.cursor });
    const replayed = await api.remoteFacade.execute(
      "management.glanceSeen",
      { cursor: first.glance.cursor },
      principalB,
    ) as { advanced: boolean };
    assert.equal(replayed.advanced, false, "a replayed advance is a no-op");
    await assert.rejects(
      () => api.remoteFacade.execute("management.glanceSeen", { cursor: "not-a-cursor" }, principalB),
      /rendered glance cursor/,
    );

    // Cross-grant hygiene: each projection carries only its own marker, and
    // one phone never reads another's acknowledgements.
    const glanceA = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      glance: { seen: Record<string, string> };
    };
    assert.deepEqual(glanceA.glance.seen, {}, "grant A never sees grant B's marker");
    const glanceB = await api.remoteFacade.execute("management.glance", {}, principalB) as {
      glance: { seen: Record<string, string> };
    };
    assert.deepEqual(Object.keys(glanceB.glance.seen), ["remote:grant-b"]);

    // Browser revocation's desktop-local cascade: pending acts staged at that
    // browser's behest are canceled and its glance marker is removed, while
    // other grants' state stands untouched.
    const bStaged = await api.stagedActs.stage({
      kind: "app.data.purge",
      parameters: { spaceId: "space-glance", appInstanceId: "app-b" },
      pins: { appInstanceId: "app-b", dataNamespaceIds: ["ns-b"] },
      provenance: { stagedVia: "act-cli", requestId: "req-b", browserId: "browser-b", grantId: "grant-b" },
    });
    await api.remoteFacade.revokeGrantAuthority?.("grant-b");
    const canceled = (await api.stagedActs.list({ state: "canceled" })).find((act) => act.id === bStaged.act.id);
    assert.ok(canceled, "the revoked grant's pending staged act is canceled");
    assert.match(canceled!.cancellationReason ?? "", /revoked/i);
    const afterRevoke = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal("remote:grant-b" in afterRevoke.seen, false, "the revoked grant's marker is deleted");

    // The all-grants cascade clears every remote marker and remote-staged act.
    const cStaged = await api.stagedActs.stage({
      kind: "app.data.purge",
      parameters: { spaceId: "space-glance", appInstanceId: "app-c" },
      pins: { appInstanceId: "app-c", dataNamespaceIds: ["ns-c"] },
      provenance: { stagedVia: "act-cli", requestId: "req-c", browserId: "browser-c", grantId: "grant-c" },
    });
    const desktopStaged = await api.stagedActs.stage({
      kind: "app.data.purge",
      parameters: { spaceId: "space-glance", appInstanceId: "app-desktop" },
      pins: { appInstanceId: "app-desktop", dataNamespaceIds: ["ns-d"] },
      provenance: { stagedVia: "act-cli", requestId: "req-desktop" },
    });
    await api.remoteFacade.execute("management.glanceSeen", { cursor: first.glance.cursor }, {
      browserId: "browser-c", grantId: "grant-c", requestId: "request-c-1",
    });
    await api.remoteFacade.revokeGrantAuthority?.();
    assert.equal((await api.stagedActs.list({ state: "canceled" })).some((act) => act.id === cStaged.act.id), true);
    const desktopActStillPending = await api.stagedActs.list({ state: "staged" });
    assert.deepEqual(desktopActStillPending.map((act) => act.id), [desktopStaged.act.id],
      "a desktop-staged act survives the remote cascade");
    const afterRevokeAll = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal(Object.keys(afterRevokeAll.seen).some((surface) => surface.startsWith("remote:")), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
