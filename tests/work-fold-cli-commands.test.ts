import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
  WorkFoldCliError,
  WorkFoldCliExitCode,
  createWorkFoldCliRequest,
  executeWorkFoldCliRequest,
  parseWorkFoldCliArgv,
  type WorkFoldCliCommandName,
  type WorkFoldCliKernel,
} from "../src/local/cli/index.js";

/**
 * Read-lane guard for the glance CLI decision (docs/fold-glance.md,
 * "Narration on demand" and non-goal 6): the digest is content-bearing, so
 * `work-fold manage glance` belongs to the per-launch-authenticated act lane —
 * the same split `chat status` and `chats list` already follow. Content-free
 * protocol v1 must neither parse a glance verb nor grow a glance snapshot
 * surface; promotion into the stable installed-CLI read contract would be a
 * later deliberate version decision, and this suite makes that decision
 * impossible to take by accident.
 */

test("read-lane argv parser refuses glance commands with stable usage errors", () => {
  for (const argv of [
    ["glance"],
    ["glance", "--json"],
    ["glance", "--space", "space-aaaaaaaaaaaaaaaa"],
    ["manage", "glance"],
    ["manage", "glance", "--json"],
  ]) {
    assert.throws(
      () => parseWorkFoldCliArgv(argv),
      (error: unknown) =>
        error instanceof WorkFoldCliError
        && error.code === "usage"
        && error.exitCode === WorkFoldCliExitCode.usage
        && /Unknown command/.test(error.message)
        && /work-fold help/.test(error.message),
      argv.join(" "),
    );
  }
});

test("a mis-routed glance request answers usage and never touches the kernel", async () => {
  // An outdated shim that predates the manage act group would carry
  // `manage glance` argv over protocol v1. The read executor must refuse it
  // as unknown before consulting the kernel, so the digest can never leak
  // through the unauthenticated, content-free read lane.
  const calls: string[] = [];
  const kernel: WorkFoldCliKernel = {
    async getContext(actor) {
      calls.push("context");
      return { cwd: actor.cwd, space: null };
    },
    async listSpaces() {
      calls.push("spaces");
      return [];
    },
    async listTasks() {
      calls.push("tasks");
      return [];
    },
    async listCapabilities() {
      calls.push("capabilities");
      return [];
    },
    async getChecksStatus() {
      calls.push("checks");
      throw new WorkFoldCliError("unavailable", "Checks status is unavailable in this work-fold host.");
    },
  };
  const cwd = resolve(".");

  const json = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["manage", "glance", "--json"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(json.exitCode, WorkFoldCliExitCode.usage);
  assert.equal(json.stdout, "");
  const envelope = JSON.parse(json.stderr) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "usage");
  assert.match(envelope.error.message, /Unknown command: manage glance/);
  assert.deepEqual(json.result, envelope);

  const human = await executeWorkFoldCliRequest(
    createWorkFoldCliRequest({ id: randomUUID(), argv: ["manage", "glance"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(human.exitCode, WorkFoldCliExitCode.usage);
  assert.equal(human.stderr, "Unknown command: manage glance\nRun 'work-fold help' for usage.\n");

  assert.deepEqual(calls, []);
});

test("protocol v1's stable command surface stays glance-free", () => {
  // The closed v1 grammar, one canonical argv per stable command. The
  // `satisfies` clause pins the WorkFoldCliCommandName union at the type
  // level (editor tooling via the root tsconfig; tsx erases types when the
  // suite runs), and the round-trip below enforces the same table against
  // the live parser — so a glance verb cannot join the content-free read
  // lane without editing this guard alongside the deliberate version
  // decision docs/fold-glance.md non-goal 6 requires.
  const stableReadCommands = {
    help: ["help"],
    version: ["version"],
    context: ["context"],
    "spaces.list": ["spaces", "list"],
    "tasks.list": ["tasks", "list"],
    "capabilities.list": ["capabilities", "list"],
    "checks.status": ["checks", "status"],
  } as const satisfies Record<WorkFoldCliCommandName, readonly string[]>;
  const names = Object.keys(stableReadCommands) as WorkFoldCliCommandName[];
  assert.equal(names.length, 7);
  for (const name of names) {
    assert.doesNotMatch(name, /glance/i, name);
    assert.equal(parseWorkFoldCliArgv(stableReadCommands[name]).name, name);
  }

  // Type level, same editor-time enforcement: the narrow read-lane kernel
  // adapter must not grow a glance query. The kernel's getGlance snapshot
  // reaches the CLI only through the authenticated act lane's facade, never
  // through the v1 read projection.
  const kernelAdapterStaysGlanceFree: "getGlance" extends keyof WorkFoldCliKernel ? false : true = true;
  assert.equal(kernelAdapterStaysGlanceFree, true);
});
