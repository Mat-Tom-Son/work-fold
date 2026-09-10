import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startLocalApi } from "../src/local/server.js";
import type { WorkFoldRemotePrincipal } from "../src/local/remote-management.js";

// The remote wave of the fold surfaces (docs/fold-glance.md §The remote
// client home): management.glance and management.glanceSeen serve the digest
// with per-grant seen hygiene over the remote facade. The bridge never sees
// any of this in the clear; these tests drive the desktop facade the envelope
// dispatch calls. Needs you means questions (docs/receipts-not-gates.md,
// F24): there is no remote decision operation any more.

test("remote glance serves the digest with per-grant seen hygiene and revocation clears the grant's marker", async () => {
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
    // A recorded change gives the digest a cursor: a restore point in a Space.
    const space = await api.actFacade.createSpace({ name: "Glance Space" });
    await writeFile(join(space.space.spaceRoot, "note.md"), "# Note\n", "utf8");
    await api.actFacade.historySave({ space: space.space.id, label: "Milestone" });

    const first = await api.remoteFacade.execute("management.glance", {}, principalA) as {
      glance: { cursor: string; seen: Record<string, string>; changes: Array<{ kind: string }> };
    };
    assert.ok(first.glance.cursor, "a recorded restore point gives the digest a cursor");
    assert.ok(first.glance.changes.some((item) => item.kind === "checkpoint-saved"));
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

    // Browser revocation's desktop-local cascade: the grant's glance marker
    // is removed, while other grants' state stands untouched.
    await api.remoteFacade.revokeGrantAuthority?.("grant-b");
    const afterRevoke = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal("remote:grant-b" in afterRevoke.seen, false, "the revoked grant's marker is deleted");

    // The all-grants cascade clears every remote marker.
    await api.remoteFacade.execute("management.glanceSeen", { cursor: first.glance.cursor }, {
      browserId: "browser-c", grantId: "grant-c", requestId: "request-c-1",
    });
    await api.remoteFacade.revokeGrantAuthority?.();
    const afterRevokeAll = await api.kernel.getGlance({ kind: "renderer" });
    assert.equal(Object.keys(afterRevokeAll.seen).some((surface) => surface.startsWith("remote:")), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the summary advertises the live-watch capability and watch validates its conversation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-remote-watch-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
  });
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-w", grantId: "grant-w", requestId: "request-w-1" };
  try {
    // The browser starts a watch only after seeing this advertisement, so an
    // older desktop — which never sends it — is never asked to watch.
    const summary = await api.remoteFacade.execute("management.summary", {}, principal) as {
      capabilities?: { watch?: boolean };
    };
    assert.equal(summary.capabilities?.watch, true);
    // A watch names an existing management conversation or is refused.
    assert.ok(api.remoteFacade.watch, "the facade exposes the watch port");
    await assert.rejects(
      () => api.remoteFacade.watch!({ conversationId: "missing-conversation" }, principal, () => {}),
      /Conversation not found/,
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
