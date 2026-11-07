import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createComputerUseRuntime } from "@injaneity/pi-computer-use/src/bridge.ts";
import { currentPlatformBackend as backend } from "@injaneity/pi-computer-use/src/platform/index.ts";
import { ResourceScheduler } from "@injaneity/pi-computer-use/src/runtime.ts";
import { parseLookResponse } from "@injaneity/pi-computer-use/src/outline.ts";

const root = await mkdtemp(join(tmpdir(), "workfold-computer-semantics-"));
const original = { ...backend }, scheduler = new ResourceScheduler();
const runtime = createComputerUseRuntime({ scheduler, requireExplicitRoot: true, enableCdp: false, interactiveSetup: false });
const context = { cwd: root, hasUI: false, sessionManager: { getBranch: () => [] } } as any;
const window = { windowId: 1, pid: 101, title: "Test", kind: "window" as const, framePoints: { x: 0, y: 0, w: 400, h: 300 }, scaleFactor: 1, isOnscreen: true, isMain: true, isFocused: true };
let mode = "ignored", waits = 0, dispatches = 0, fieldValue = "unchanged";
Object.assign(backend, {
  ensureReady: async (_ctx: unknown, state: object) => ({ ...state, lastPermissionCheckAt: Date.now() }),
  listApps: async () => [{ pid: 101, appName: "Fixture", isFrontmost: true }],
  listRoots: async () => [window],
  observe: async () => parseLookResponse({ lookId: crypto.randomUUID(), capturedAt: Date.now() / 1000, window,
    outline: { ref: "window", role: "window", children: [{ ref: "text", role: "text", title: "Editor", value: fieldValue, valueReadable: true, canSetValue: true }] } }),
  actBatch: async () => mode === "ignored"
    ? { outcome: "worked", performed: { actionCount: 1 }, steps: [{ outcome: "worked", evidence: { value: "requested" } }] }
    : { outcome: "unknown", stoppedAt: 0, performed: { actionCount: 1 }, steps: [{ outcome: "unknown", error: { code: "interrupted_unknown", message: "Effect uncertain" } }] },
  waitFor: async () => {
    waits++;
    return mode === "incomplete" ? { found: false, complete: false } : mode === "failed" ? { found: false, timedOut: true, complete: true } : { found: true };
  },
  act: async () => {
    dispatches++;
    if (mode === "reformatted") fieldValue = "555-1234";
    if (mode === "incomplete" || mode === "failed" || mode === "reformatted") return { outcome: "worked", performed: { delivery: "ax" } };
    throw Object.assign(new Error("Save may already have happened"), { code: "interrupted_unknown" });
  },
});
try {
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi/computer-use.json"), JSON.stringify({ headless: true }));
  const found = await runtime.executeFind("find", { app: "Fixture" }, undefined, undefined, context);
  const target = found.details.windows[0].windowRef;
  const observe = () => runtime.executeObserve("observe", { root: target, mode: "semantic" }, undefined, undefined, context);
  let observed = await observe();
  const ref = observed.details.outline.root.children[0].ref;
  const acted = await runtime.executeAct("ignored", { stateId: observed.details.capture.stateId,
    actions: [{ action: "setText", ref, text: "requested" }] }, undefined, undefined, context);
  assert.equal(acted.details.execution.outcome, "didnt", "a contradictory successor value overrides a claimed native success");
  mode = "uncertain";
  observed = await observe();
  const uncertain = await runtime.executeAct("uncertain", { stateId: observed.details.capture.stateId,
    actions: [{ action: "setText", ref: observed.details.outline.root.children[0].ref, text: "unchanged" }],
    expect: { ref: observed.details.outline.root.children[0].ref, value: "unchanged" } }, undefined, undefined, context);
  assert.equal(uncertain.details.execution.outcome, "unknown", "a preexisting value cannot erase uncertain delivery");
  assert.equal(uncertain.details.execution.stoppedAt, 0);
  assert.equal(waits, 0, "uncertain delivery observes the successor without converting it into another action check");
  await writeFile(join(root, ".pi/computer-use.json"), JSON.stringify({ headless: false }));
  observed = await observe();
  const singleRef = observed.details.outline.root.children[0].ref;
  const single = await runtime.executeAct("uncertain-single", { stateId: observed.details.capture.stateId,
    actions: [{ action: "setText", ref: singleRef, text: "unchanged" }, { action: "setText", ref: singleRef, text: "must not run" }],
    expect: { ref: singleRef, value: "unchanged" } }, undefined, undefined, context);
  assert.equal(single.details.execution.outcome, "unknown");
  assert.equal(single.details.execution.stoppedAt, 0);
  assert.equal(single.details.execution.actionCount, 1);
  assert.equal(dispatches, 1, "an uncertain Mac dispatch cannot retry or execute the next action");
  assert.equal(waits, 0, "a preexisting postcondition cannot clear a single-dispatch error");
  mode = "incomplete";
  observed = await observe();
  const incompleteRef = observed.details.outline.root.children[0].ref;
  const incomplete = await runtime.executeAct("incomplete-check", { stateId: observed.details.capture.stateId,
    actions: [{ action: "setText", ref: incompleteRef, text: "unchanged" }],
    expect: { text: "Saved", gone: true } }, undefined, undefined, context);
  assert.equal(incomplete.details.execution.outcome, "unknown", "even a matching text write cannot certify a different incomplete postcondition");
  assert.equal(incomplete.details.execution.verification.status, "unverified");
  assert.equal(incomplete.details.execution.error.code, "postcondition_unverified");
  const unconfirmed = await runtime.executeWaitFor("unconfirmed-wait", { stateId: incomplete.details.capture.stateId, text: "Saved", gone: true, timeoutMs: 100 }, undefined, undefined, context);
  assert.equal(unconfirmed.details.complete, false);
  assert.match(unconfirmed.content[0].text, /^Could not confirm the condition/, "an incomplete scan is not reported as a timeout");
  mode = "failed";
  observed = await observe();
  const failedRef = observed.details.outline.root.children[0].ref;
  const failed = await runtime.executeAct("failed-check", { stateId: observed.details.capture.stateId,
    actions: [{ action: "setText", ref: failedRef, text: "unchanged" }],
    expect: { text: "Saved" } }, undefined, undefined, context);
  assert.equal(failed.details.execution.outcome, "didnt", "a matching text write cannot certify a different failed postcondition");
  assert.equal(failed.details.execution.error.code, "postcondition_failed");
  mode = "reformatted";
  observed = await observe();
  const phoneRef = observed.details.outline.root.children[0].ref;
  const reformatted = await runtime.executeAct("reformatted", { stateId: observed.details.capture.stateId,
    actions: [{ action: "setText", ref: phoneRef, text: "5551234" }] }, undefined, undefined, context);
  assert.equal(reformatted.details.execution.outcome, "worked", "an app reformatting accepted text is not a lost write");
  console.log("PASS computer successor values and uncertain delivery");
} finally {
  await runtime.shutdownComputerUseSession();
  Object.assign(backend, original);
  await scheduler.close();
  await rm(root, { recursive: true, force: true });
}
