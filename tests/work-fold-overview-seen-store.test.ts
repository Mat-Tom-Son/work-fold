import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkFoldOverviewSeenStore,
  isWorkFoldOverviewSurfaceId,
  workFoldOverviewRemoteSurfaceId,
} from "../src/local/overview-seen-store.js";

const cursorAt = (at: string, id = "act-receipts:req-1"): string => `${at}/${id}`;

test("seen markers advance monotonically and persist atomically", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-seen-"));
  try {
    const path = join(sandbox, "overview-seen.json");
    const store = new WorkFoldOverviewSeenStore({ path, now: () => new Date("2026-08-10T12:00:00.000Z") });
    assert.deepEqual(await store.seenCursors(), {}, "a missing store has no markers");

    const first = await store.advance("popover", cursorAt("2026-08-10T10:00:00.000Z"));
    assert.deepEqual(first, { advanced: true, seenThrough: cursorAt("2026-08-10T10:00:00.000Z") });

    // Backward, equal, and replayed advances are no-ops: markers only move forward.
    assert.deepEqual(
      await store.advance("popover", cursorAt("2026-08-10T09:00:00.000Z")),
      { advanced: false, seenThrough: cursorAt("2026-08-10T10:00:00.000Z") },
    );
    assert.deepEqual(
      await store.advance("popover", cursorAt("2026-08-10T10:00:00.000Z")),
      { advanced: false, seenThrough: cursorAt("2026-08-10T10:00:00.000Z") },
    );

    // Same timestamp, later item id advances; the pair (timestamp, id) orders cursors.
    const tie = await store.advance("popover", cursorAt("2026-08-10T10:00:00.000Z", "act-receipts:req-2"));
    assert.equal(tie.advanced, true);

    // Surfaces are independent: two phones must not clear each other.
    const remote = workFoldOverviewRemoteSurfaceId("grant-1");
    await store.advance(remote, cursorAt("2026-08-10T08:00:00.000Z"));
    assert.deepEqual(await store.seenCursors(), {
      popover: cursorAt("2026-08-10T10:00:00.000Z", "act-receipts:req-2"),
      "remote:grant-1": cursorAt("2026-08-10T08:00:00.000Z"),
    });

    // A second instance reads the same persisted state.
    const reopened = new WorkFoldOverviewSeenStore({ path });
    const state = await reopened.read();
    assert.equal(state.version, 1);
    assert.equal(state.surfaces.popover.seenThrough, cursorAt("2026-08-10T10:00:00.000Z", "act-receipts:req-2"));
    assert.equal(state.surfaces.popover.updatedAt, "2026-08-10T12:00:00.000Z");
    const persisted = JSON.parse(await readFile(path, "utf8")) as { version?: number };
    assert.equal(persisted.version, 1, "the store writes one valid JSON document");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("invalid surfaces and cursors are refused without effect", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-seen-"));
  try {
    const store = new WorkFoldOverviewSeenStore({ path: join(sandbox, "overview-seen.json") });
    for (const surface of ["phone", "remote:", "remote:bad grant", "", "POPOVER"]) {
      assert.deepEqual(
        await store.advance(surface, cursorAt("2026-08-10T10:00:00.000Z")),
        { advanced: false, seenThrough: null },
        `surface ${JSON.stringify(surface)} is outside the closed set`,
      );
    }
    for (const cursor of ["", "no-separator", "/starts-with-separator", "ends-with/", "x".repeat(721)]) {
      assert.deepEqual(
        await store.advance("popover", cursor),
        { advanced: false, seenThrough: null },
        `cursor ${JSON.stringify(cursor.slice(0, 24))} is not a "<at>/<id>" pair`,
      );
    }
    assert.deepEqual(await store.seenCursors(), {}, "refused advances leave no markers behind");

    assert.equal(isWorkFoldOverviewSurfaceId("popover"), true);
    assert.equal(isWorkFoldOverviewSurfaceId("main-window"), true);
    assert.equal(isWorkFoldOverviewSurfaceId("remote:grant-1"), true);
    assert.equal(isWorkFoldOverviewSurfaceId("remote:"), false);
    assert.equal(isWorkFoldOverviewSurfaceId("tray"), false);
    assert.throws(() => workFoldOverviewRemoteSurfaceId("bad grant"), /valid remote grant id/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a damaged or future-versioned store resets markers, which only over-reports", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-seen-"));
  try {
    const path = join(sandbox, "overview-seen.json");
    await writeFile(path, "{not json", "utf8");
    const store = new WorkFoldOverviewSeenStore({ path, now: () => new Date("2026-08-10T12:00:00.000Z") });
    assert.deepEqual(await store.seenCursors(), {}, "a malformed store resets to no markers");

    const recovered = await store.advance("popover", cursorAt("2026-08-10T10:00:00.000Z"));
    assert.equal(recovered.advanced, true, "the store recovers by rewriting a valid document");

    await writeFile(path, JSON.stringify({
      version: 2,
      surfaces: { popover: { seenThrough: cursorAt("2026-08-10T11:00:00.000Z"), updatedAt: "2026-08-10T11:00:00.000Z" } },
    }), "utf8");
    assert.deepEqual(await store.seenCursors(), {}, "an unknown version resets rather than guessing");

    await writeFile(path, JSON.stringify({
      version: 1,
      surfaces: {
        popover: { seenThrough: cursorAt("2026-08-10T11:00:00.000Z"), updatedAt: "2026-08-10T11:00:00.000Z" },
        "remote:grant-1": { seenThrough: "not-a-cursor" },
        tray: { seenThrough: cursorAt("2026-08-10T11:00:00.000Z"), updatedAt: "2026-08-10T11:00:00.000Z" },
      },
    }), "utf8");
    assert.deepEqual(
      await store.seenCursors(),
      { popover: cursorAt("2026-08-10T11:00:00.000Z") },
      "invalid entries are dropped; valid markers survive",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("revoking a grant purges exactly that surface's marker", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-seen-"));
  try {
    const store = new WorkFoldOverviewSeenStore({ path: join(sandbox, "overview-seen.json") });
    await store.advance("popover", cursorAt("2026-08-10T10:00:00.000Z"));
    await store.advance(workFoldOverviewRemoteSurfaceId("grant-1"), cursorAt("2026-08-10T10:05:00.000Z"));
    await store.advance(workFoldOverviewRemoteSurfaceId("grant-2"), cursorAt("2026-08-10T10:06:00.000Z"));

    assert.equal(await store.removeSurface("remote:grant-1"), true);
    assert.deepEqual(await store.seenCursors(), {
      popover: cursorAt("2026-08-10T10:00:00.000Z"),
      "remote:grant-2": cursorAt("2026-08-10T10:06:00.000Z"),
    });
    assert.equal(await store.removeSurface("remote:grant-1"), false, "a purged marker stays purged");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the surface cap refuses new markers but never blocks existing ones", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-seen-"));
  try {
    const store = new WorkFoldOverviewSeenStore({ path: join(sandbox, "overview-seen.json"), maxSurfaces: 2 });
    await store.advance("popover", cursorAt("2026-08-10T10:00:00.000Z"));
    await store.advance("main-window", cursorAt("2026-08-10T10:01:00.000Z"));
    assert.deepEqual(
      await store.advance("remote:grant-1", cursorAt("2026-08-10T10:02:00.000Z")),
      { advanced: false, seenThrough: null },
      "refusing a new surface at the cap only over-reports newness there",
    );
    const kept = await store.advance("popover", cursorAt("2026-08-10T10:03:00.000Z"));
    assert.equal(kept.advanced, true, "existing surfaces keep advancing at the cap");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
