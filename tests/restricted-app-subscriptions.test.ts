import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RestrictedAppInferenceService } from "../src/local/agent/restricted-app-inference.js";
import {
  RestrictedAppTaskService,
  restrictedAppTaskAuthorityDigest,
  restrictedAppTaskTurnRequestId,
  type RestrictedAppAssistantActivity,
  type RestrictedAppTaskPorts,
  type RestrictedAppTaskScope,
} from "../src/local/agent/restricted-app-tasks.js";
import type { RestrictedAppAssistantAction } from "../src/local/agent/restricted-app-manifest.js";
import type { WorkFoldDurableTurnRecord } from "../src/local/agent/turn-store.js";
import { WorkFoldCheckService } from "../src/local/checks/check-service.js";
import { WorkFoldCheckStore } from "../src/local/checks/check-store.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";
import { restrictedAppSubscriptionLimits } from "../src/shared/restricted-app-tasks.js";

const root = process.cwd();
const [host, preload, main] = await Promise.all([
  readFile(join(root, "desktop/src/restricted-app-host.ts"), "utf8"),
  readFile(join(root, "desktop/src/restricted-app-preload.cts"), "utf8"),
  readFile(join(root, "desktop/src/main.ts"), "utf8"),
]);

const action: RestrictedAppAssistantAction = {
  id: "compare",
  title: "Compare quotes",
  instructions: "Compare the submitted quotes.",
  inputSchema: { type: "object", properties: { quote: { type: "string", maxLength: 200 } }, required: ["quote"], additionalProperties: false },
};

function scopeFor(featureInstallationId: string): RestrictedAppTaskScope {
  return {
    spaceId: "space-one",
    appId: "quotes",
    featureInstallationId,
    digest: "a".repeat(64),
    authorityDigest: restrictedAppTaskAuthorityDigest({ generation: 1 }),
  };
}

test("a task journal change names the installations whose ids moved, and nothing else", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-subscriptions-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const now = new Date("2026-09-07T12:00:00.000Z");
  const turns = new Map<string, WorkFoldDurableTurnRecord>();
  const ports: RestrictedAppTaskPorts = {
    async withApp(_pin, operation) { return operation([action], { title: "Quote board" }); },
    async dispatch(record) {
      turns.set(record.id, {
        schema: "work-fold.turn.v1", turnId: `turn-${record.id}`, requestId: restrictedAppTaskTurnRequestId(record),
        requestDigest: "d".repeat(64), userMessageId: `message-${record.id}`, userMessageCreatedAt: now.toISOString(),
        spaceId: record.scope.spaceId, conversationId: record.conversationId, actorKind: "system", status: "running",
        userMessagePersisted: true, acceptedAt: now.toISOString(), updatedAt: now.toISOString(), assistantText: "",
      });
    },
    findTurn(record) { return turns.get(record.id) ?? null; },
    async cancelTurn() { /* unused */ },
  };
  const service = await RestrictedAppTaskService.create({ path: join(sandbox, "tasks.json"), ports, now: () => now });
  const changes: RestrictedAppAssistantActivity[][] = [];
  // A listener that takes no argument is the existing contract and must keep
  // working, so the payload rides alongside rather than replacing it.
  let plainCalls = 0;
  service.on("changed", () => { plainCalls += 1; });
  service.on("changed", (change: { tasks?: RestrictedAppAssistantActivity[] }) => changes.push(change?.tasks ?? []));

  const first = scopeFor("feature-one");
  const second = scopeFor("feature-two");
  const one = await service.request(first, { requestId: randomUUID(), requestedAt: now.toISOString(), actionId: action.id, input: { quote: "North" } });
  const other = await service.request(second, { requestId: randomUUID(), requestedAt: now.toISOString(), actionId: action.id, input: { quote: "South" } });

  assert.equal(plainCalls, changes.length, "existing zero-argument listeners keep firing");
  assert.deepEqual(changes.at(-1), [{ spaceId: "space-one", appId: "quotes", featureInstallationId: "feature-two", taskIds: [other.id], receiptIds: [] }]);
  assert.ok(!changes.flat().some((item) => item.featureInstallationId === "feature-two" && item.taskIds.includes(one.id)),
    "one installation's activity never names another's task");

  changes.length = 0;
  turns.get(one.id)!.status = "succeeded";
  turns.get(one.id)!.assistantText = "Done.";
  await service.get(first, one.requestId);
  assert.deepEqual(changes.at(-1)?.map((item) => [item.featureInstallationId, item.taskIds]), [["feature-one", [one.id]]]);

  changes.length = 0;
  await service.list(first);
  assert.deepEqual(changes, [], "a read that moves nothing emits nothing");
  assert.ok(!JSON.stringify(changes).includes("Done."), "a change carries ids, never content");
});

test("an inference receipt marks only its terminal line as something an app can act on", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-app-infer-hint-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const service = await RestrictedAppInferenceService.create({
    path: join(sandbox, "inference-receipts.jsonl"),
    ports: {
      async pin() { /* current */ },
      async infer() {
        return { kind: "text" as const, text: "echo", truncated: false, model: { provider: "local", id: "m" }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  const seen: Array<{ terminal: boolean; id: string; featureInstallationId: string }> = [];
  service.on("changed", (change: { receipt: { id: string; featureInstallationId: string }; terminal: boolean }) => {
    seen.push({ terminal: change.terminal, id: change.receipt.id, featureInstallationId: change.receipt.featureInstallationId });
  });
  const scope = { spaceId: "space-one", appId: "quotes", featureInstallationId: "feature-one", digest: "a".repeat(64) };
  const result = await service.infer(scope, "view", { instructions: "Echo", input: "north" });

  assert.deepEqual(seen.map((item) => item.terminal), [false, true], "the accepted line is a half-fact; only the settled line is news");
  assert.equal(seen[1]!.id, (result as { receiptId: string }).receiptId, "the id an app can match against its own call");
  assert.ok(seen.every((item) => item.featureInstallationId === "feature-one"));
});

test("a Check settle and a disable each tell the host once, and a failing listener never fails the operation", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-hint-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const spaceRoot = join(sandbox, "Space");
  const machine = join(sandbox, "machine");
  await mkdir(join(spaceRoot, "Delivery"), { recursive: true });
  await mkdir(machine, { recursive: true });
  const proposalPath = join(sandbox, "handoff.work-fold-check.json");
  await writeFile(proposalPath, JSON.stringify({
    kind: "work-fold.check-proposal",
    version: 1,
    name: "Required handoff",
    createdBy: "human",
    createdAt: "2026-08-01T00:00:00.000Z",
    check: {
      title: "The signed handoff exists",
      severity: "error",
      trigger: "manual",
      sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
      targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
    },
  }));

  const changed: Array<{ spaceId: string; checkIds: string[] }> = [];
  let listenerThrows = false;
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (spaceId) => WorkFoldCheckStore.create(spaceId, { path: join(machine, `${spaceId}.json`) }),
    listSpaces: async () => [{
      id: "space-delivery", name: "space-delivery", spaceRoot,
      location: { kind: "local" as const, storage: "linked" as const },
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    onResultChanged: (event) => {
      changed.push({ spaceId: event.spaceId, checkIds: [...event.checkIds] });
      if (listenerThrows) throw new Error("a view listener exploded");
    },
  });
  t.after(() => service.close());
  const space = { id: "space-delivery", spaceRoot };

  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  assert.deepEqual(changed, [], "enabling a Check is not a result change");
  await service.status(space);
  assert.deepEqual(changed, [], "a read never produces a hint");

  listenerThrows = true;
  const accepted = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli", spaceId: space.id } });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await service.taskStatus(space.id, accepted.taskId);
    if (status.state !== "accepted" && status.state !== "running") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await service.taskStatus(space.id, accepted.taskId)).state, "succeeded",
    "a listener that throws never fails the Check run");
  assert.deepEqual(changed, [{ spaceId: "space-delivery", checkIds: [enabled.declaration.id] }],
    "one settled run is exactly one hint");

  listenerThrows = false;
  changed.length = 0;
  assert.equal(await service.disable(space, enabled.declaration.id), true);
  assert.deepEqual(changed, [{ spaceId: "space-delivery", checkIds: [enabled.declaration.id] }]);
  changed.length = 0;
  assert.equal(await service.disable(space, enabled.declaration.id), false);
  assert.deepEqual(changed, [], "disabling what is already gone changes nothing");
});

test("the host pushes the three hints on their own channels, to the mounts each read lane admits", () => {
  for (const channel of ["tasks-changed", "checks-changed", "files-changed"]) {
    assert.ok(host.includes(`"work-fold:restricted-app:${channel}"`), `${channel} is a host channel`);
    assert.ok(preload.includes(`"work-fold:restricted-app:${channel}"`), `${channel} is a preload channel`);
  }
  // Registration returns an unsubscribe function, so it must cross the bridge
  // unwrapped exactly as `storage.onChanged` does.
  assert.match(preload, /"tasks\.onChanged", "checks\.onChanged", "files\.onChanged",/);
  assert.match(preload, /tasks: Object\.freeze\(\{\s*\n\s*onChanged:/);
  for (const [name, message] of [["tasks", "Assistant task"], ["checks", "Check"], ["files", "File"]] as const) {
    assert.ok(preload.includes(`throw new TypeError("${message} listener must be a function.")`), `${name} type-checks its listener`);
    // A preload-side TypeError crosses the bridge as a plain Error, so the
    // app world re-checks and throws its own TypeError before delegating.
    assert.ok(preload.includes(`"${name}.onChanged": "${message} listener must be a function.",`), `${name} type-checks its listener in the app world`);
  }
  assert.match(preload, /if \(typeof listener !== "function"\) throw new TypeErrorConstructor\(registrationMessage\);\s*\n\s*return value\(listener\);/);

  // Eligibility follows each read lane: Check results are view-only, tasks and
  // granted files also reach a worker holding an operation.
  assert.match(host, /if \(kind === "checks"\) return false;\s*\n\s*return Boolean\(instance\.pendingOperation\)/);
  assert.match(host, /if \(!this\.#uiIsActive\(instance\)\) return false;/);

  // Nothing is queued when no mount could act on it, and a hint whose mounts
  // all closed while it waited is dropped without moving the revision.
  assert.match(host, /if \(!this\.#hintTargets\(kind, scope\)\.length\) return;/);
  assert.match(host, /if \(!targets\.length\) return;/);
  assert.match(host, /const revision = \(this\.#hintRevisions\.get\(key\) \?\? 0\) \+ 1;/);

  // Lifetime: every place a mount's pending storage event is dropped drops the
  // hints too, and closing the host clears every timer.
  const clears = [...host.matchAll(/this\.#clearPendingHints\(/g)];
  assert.ok(clears.length >= 3, "authority change, stop, and the stop sweep all clear hints");
  assert.match(host, /for \(const hint of this\.#pendingHints\.values\(\)\) clearTimeout\(hint\.timer\);/);
  assert.match(host, /this\.#stopFilePoll\(\);\s*\n\s*this\.#fileWatches\.clear\(\);/);

  // Sleep and wake rebaseline rather than replaying.
  assert.match(host, /for \(const entry of this\.#fileWatches\.values\(\)\) entry\.watch\.reset\(\);/);

  // The wires that make the hints reachable at all.
  assert.match(host, /publishAssistantActivity\(event: RestrictedAppAssistantActivity\): void/);
  assert.match(host, /publishCheckResultsChanged\(event: \{ spaceId: string; checkIds: readonly string\[\] \}\): void/);
  assert.match(main, /onAppAssistantActivity: \(activity\) => host\.restrictedAppHost\.publishAssistantActivity\(activity\)/);
  assert.match(main, /onResultChanged: \(event\) => restrictedRuntime\.publishCheckResultsChanged\(event\)/);

  // The internal settle signal keeps exactly one consumer (F30).
  assert.ok(!host.includes("settleSignal"), "the app host never subscribes to the settle signal");
});

test("the published hint bounds are the ones the preload and the host enforce", () => {
  assert.equal(restrictedAppSubscriptionLimits.minHintIntervalMs, 100, "the same ten-per-second cadence storage hints use");
  assert.equal(restrictedAppSubscriptionLimits.taskIds, 64);
  assert.equal(restrictedAppSubscriptionLimits.receiptIds, 64);
  assert.ok(preload.includes("boundedIdList(candidate.taskIds, 64)"));
  assert.ok(preload.includes("boundedIdList(candidate.receiptIds, 64)"));
  assert.ok(preload.includes("boundedIdList(candidate.permissionIds, 8)"), "Check permissions are capped at 8 by the manifest");
  assert.ok(preload.includes("boundedIdList(candidate.permissionIds, 16)"), "file permissions are capped at 16 by the manifest");
  assert.match(host, /restrictedAppSubscriptionLimits\.fileMinHintIntervalMs\s*\n?\s*:\s*restrictedAppSubscriptionLimits\.minHintIntervalMs/);
});
