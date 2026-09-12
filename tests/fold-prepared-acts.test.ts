import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLD_PREPARED_ACT_KINDS,
  FoldPreparedActError,
  FoldPreparedActExecutor,
  prepareFoldAct,
  type FoldActFenceScope,
  type FoldActKernelSeam,
} from "../src/local/fold-prepared-acts.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";

const deletion = () => prepareFoldAct({
  kind: "space.delete-folder",
  parameters: { spaceId: "space-1" },
  pins: { spaceId: "space-1", spaceRoot: "/spaces/one" },
});

test("prepareFoldAct refuses unknown kinds, unknown or malformed fields, and mismatched identities", () => {
  // The closed vocabulary: the fifteen kinds behind every verb that installs
  // code, widens a power, or destroys data; permanent file deletion is gone.
  assert.equal(FOLD_PREPARED_ACT_KINDS.length, 15);
  assert.equal((FOLD_PREPARED_ACT_KINDS as readonly string[]).includes("files.destroy"), false);
  assert.equal((FOLD_PREPARED_ACT_KINDS as readonly string[]).includes("app.review.install"), true);

  const refused = (input: Parameters<typeof prepareFoldAct>[0], code: string, message: RegExp) =>
    assert.throws(
      () => prepareFoldAct(input),
      (error: unknown) => error instanceof FoldPreparedActError && error.code === code && message.test(error.message),
      `expected ${code} for ${JSON.stringify(input)}`,
    );
  refused({ kind: "files.destroy" as never, parameters: {}, pins: {} }, "KIND_UNKNOWN", /fail closed/);
  refused(
    { kind: "space.delete-folder", parameters: { spaceId: "space-1", extra: "x" }, pins: { spaceId: "space-1", spaceRoot: "/r" } },
    "INPUT_INVALID",
    /parameters\.extra is not a typed field/,
  );
  refused(
    { kind: "space.delete-folder", parameters: { spaceId: "space-1" }, pins: { spaceId: "space-1" } },
    "INPUT_INVALID",
    /pins\.spaceRoot is required/,
  );
  refused(
    { kind: "space.delete-folder", parameters: { spaceId: "space-1" }, pins: { spaceId: "space-2", spaceRoot: "/r" } },
    "INPUT_INVALID",
    /must name the same identity/,
  );
  refused(
    {
      kind: "app.storage.clear",
      parameters: { spaceId: "space-1", appInstanceId: "app-1" },
      pins: { appInstanceId: "app-1", dataNamespaceIds: ["ns-1"], observedBytes: -1 },
    },
    "INPUT_INVALID",
    /non-negative integer/,
  );
  refused(
    { kind: "capability.package.install", parameters: { scope: "space" }, pins: { packageId: "p", version: "1", source: "npm:p", scope: "space", resourceSummary: "r" } },
    "INPUT_INVALID",
    /exactly one of source or catalogId/,
  );
  refused(
    { kind: "publish.viewer.expose", parameters: { exposure: "page", spaceId: "space-1" }, pins: { exposure: "page", spaceId: "space-1", relativePath: "a.md" } },
    "INPUT_INVALID",
    /pins\.title is required for page exposure/,
  );

  const act = deletion();
  assert.ok(Object.isFrozen(act) && Object.isFrozen(act.parameters) && Object.isFrozen(act.pins), "a prepared act is inert data");
  assert.deepEqual(act.pins, { spaceId: "space-1", spaceRoot: "/spaces/one" });
});

test("the executor fences, rechecks pins, wraps execution in one fold_act task, and refuses unbound kinds", async () => {
  const started: Array<{ requestId: string; kind: string; spaceId?: string }> = [];
  const finished: string[] = [];
  const kernel: FoldActKernelSeam = {
    startExperimentalFoldActTask(input) {
      started.push({ requestId: input.requestId, kind: input.kind, ...(input.spaceId ? { spaceId: input.spaceId } : {}) });
      const id = `task-${started.length}`;
      return {
        id, kind: "fold_act", status: "running", spaceId: input.spaceId ?? null,
        requestId: input.requestId, actKind: input.kind, actor: input.actor, startedAt: "2026-09-10T00:00:00.000Z",
      };
    },
    finishTask(taskId) {
      finished.push(taskId);
      return true;
    },
  };
  const scopes: FoldActFenceScope[] = [];
  const executor = new FoldPreparedActExecutor({
    kernel,
    fence: {
      async run(scope, operation) {
        scopes.push(scope);
        return await operation();
      },
    },
    adapters: {
      "space.delete-folder": {
        fenceScope: () => null,
        recheckPins: () => null,
        execute: async () => ({ detail: "deleted" }),
      },
      "app.storage.clear": {
        recheckPins: (_act, context) => (context as { mismatch?: string } | undefined)?.mismatch ?? null,
        execute: async (_act, context) => {
          (context as { ran?: boolean }).ran = true;
          return { detail: "cleared" };
        },
      },
      "capability.package.install": {
        recheckPins: () => null,
        execute: async () => {
          throw new Error("boom");
        },
      },
    },
  });

  // A Space-scoped act reserves the Space fence by default, rechecks its
  // pins inside it, and runs inside one fold_act task that is finished on
  // the way out; the effect names the task.
  const clear = prepareFoldAct({
    kind: "app.storage.clear",
    parameters: { spaceId: "space-1", appInstanceId: "app-1" },
    pins: { appInstanceId: "app-1", dataNamespaceIds: ["ns-1"], observedBytes: 10 },
  });
  const context: { ran?: boolean } = {};
  const effect = await executor.run({ act: clear, requestId: "req-1", context });
  assert.equal(effect.detail, "cleared");
  assert.equal(effect.taskId, "task-1");
  assert.equal(context.ran, true);
  assert.deepEqual(scopes, [{ scope: "space", spaceId: "space-1" }]);
  assert.deepEqual(started, [{ requestId: "req-1", kind: "app.storage.clear", spaceId: "space-1" }]);
  assert.deepEqual(finished, ["task-1"]);

  // A pin mismatch refuses before execute and starts no task.
  const mismatch: { mismatch: string; ran?: boolean } = { mismatch: "the live storage changed" };
  await assert.rejects(
    () => executor.run({ act: clear, requestId: "req-2", context: mismatch }),
    (error: unknown) => error instanceof FoldPreparedActError && error.code === "PIN_MISMATCH" && /live storage changed/.test(error.message),
  );
  assert.equal(mismatch.ran, undefined);
  assert.equal(started.length, 1);
  assert.equal(scopes.length, 2, "the recheck happens inside the reserved fence");

  // A null fence scope means the execution reserves its own fence.
  await executor.run({ act: deletion(), requestId: "req-3" });
  assert.equal(scopes.length, 2);
  assert.deepEqual(started.at(-1), { requestId: "req-3", kind: "space.delete-folder", spaceId: "space-1" });

  // A Space-less act reserves the global fence, and a throwing execution
  // still finishes its task.
  const install = prepareFoldAct({
    kind: "capability.package.install",
    parameters: { source: "npm:x", scope: "personal" },
    pins: { packageId: "x", version: "1.0.0", source: "npm:x", scope: "personal", resourceSummary: "1 skill(s)" },
  });
  await assert.rejects(() => executor.run({ act: install, requestId: "req-4" }), /boom/);
  assert.deepEqual(scopes.at(-1), { scope: "global" });
  assert.equal(finished.length, started.length, "every started task is finished, including after a throw");

  // An unbound kind refuses before anything runs.
  const grant = prepareFoldAct({
    kind: "app.grant.network",
    parameters: { spaceId: "space-1", appInstanceId: "app-1", declarationId: "api" },
    pins: { appInstanceId: "app-1", declarationId: "api", releaseDigest: "d".repeat(64) },
  });
  await assert.rejects(
    () => executor.run({ act: grant, requestId: "req-5" }),
    (error: unknown) => error instanceof FoldPreparedActError && error.code === "EXECUTION_UNAVAILABLE",
  );
  assert.equal(started.length, 3);
  await assert.rejects(
    () => executor.run({ act: deletion(), requestId: "  " }),
    (error: unknown) => error instanceof FoldPreparedActError && error.code === "INPUT_INVALID",
  );

  // The real kernel validates the task input and keeps the lifecycle
  // internal: a fold_act task never enters the stable space.tasks projection.
  const real = new WorkFoldKernel();
  assert.throws(() => real.startExperimentalFoldActTask({ requestId: " ", kind: "space.delete-folder", actor: { kind: "system" } }), /request id/);
  assert.throws(() => real.startExperimentalFoldActTask({ requestId: "req", kind: " ", actor: { kind: "system" } }), /kind/);
  const task = real.startExperimentalFoldActTask({ requestId: "req-real", kind: "space.delete-folder", actor: { kind: "system" } });
  assert.equal(task.kind, "fold_act");
  assert.equal(task.requestId, "req-real");
  assert.equal(task.actKind, "space.delete-folder");
  assert.deepEqual((await real.getTasks({ kind: "system" })).tasks, []);
  assert.equal(real.finishTask(task.id), true);
});
