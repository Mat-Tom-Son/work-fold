import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  WORKSPACE_CLI_PROTOCOL_VERSION,
  WorkspaceCliFileBroker,
  WorkspaceCliExitCode,
  createWorkspaceCliActRequest,
  createWorkspaceCliRequest,
  createWorkspaceCliResponse,
  isWorkspaceCliActRequest,
  workspaceCliBrokerPaths,
  type WorkspaceCliBrokeredRequest,
} from "../src/local/cli/index.js";

const fixedNow = new Date("2026-07-11T12:00:00.000Z");

test("CLI file broker atomically claims, executes, responds, and deduplicates in-flight work", async () => {
  await withBroker(async ({ broker, root }) => {
    const id = randomUUID();
    const request = createWorkspaceCliRequest({ id, argv: ["spaces", "list"], cwd: root, createdAt: fixedNow.toISOString() });
    await broker.writeRequest(request);
    const paths = broker.requestPaths(id);
    assert.equal(existsSync(paths.request), true);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const executor = async () => {
      calls += 1;
      await gate;
      return createWorkspaceCliResponse({ id, exitCode: 0, stdout: "done\n", stderr: "", result: { ok: true } });
    };
    const first = broker.processRequest(id, executor);
    const second = broker.processRequest(id, executor);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.deepEqual(firstResponse, secondResponse);
    assert.equal(firstResponse.stdout, "done\n");
    assert.equal(calls, 1);
    assert.equal(existsSync(paths.request), false);
    assert.equal(existsSync(paths.claim), false);
    assert.equal(existsSync(paths.claimLock), false);
    assert.equal(existsSync(paths.response), true);
    assert.deepEqual(await broker.readResponse(id), firstResponse);

    let replayCalls = 0;
    const replay = await broker.processRequest(id, async () => {
      replayCalls += 1;
      throw new Error("must not run");
    });
    assert.deepEqual(replay, firstResponse);
    assert.equal(replayCalls, 0);
  });
});

test("CLI broker paths are UUID-derived and cannot escape the injected state root", async () => {
  await withBroker(async ({ broker, root }) => {
    const id = randomUUID();
    const expected = workspaceCliBrokerPaths(root);
    assert.deepEqual(broker.paths, expected);
    const requestPaths = broker.requestPaths(id);
    assert.equal(requestPaths.request, join(expected.requests, `${id}.json`));
    assert.equal(requestPaths.claim, join(expected.claims, `${id}.json`));
    assert.equal(requestPaths.response, join(expected.responses, `${id}.json`));
    for (const unsafe of ["../escape", "..\\escape", "not-a-uuid", `${id}.json`]) {
      assert.throws(() => broker.requestPaths(unsafe), /UUID/);
    }
  });
});

test("CLI broker turns stale, future, mismatched, malformed, and oversized requests into stable protocol responses", async () => {
  await withBroker(async ({ broker, root }) => {
    const cases: Array<{ id: string; value: unknown; expectedExit: number; expected: RegExp }> = [
      {
        id: randomUUID(),
        value: { protocolVersion: 1, id: "placeholder", argv: [], cwd: root, createdAt: "2026-07-11T11:00:00.000Z" },
        expectedExit: WorkspaceCliExitCode.timeout,
        expected: /expired/,
      },
      {
        id: randomUUID(),
        value: { protocolVersion: 1, id: "placeholder", argv: [], cwd: root, createdAt: "2026-07-11T12:05:00.000Z" },
        expectedExit: WorkspaceCliExitCode.protocolError,
        expected: /future/,
      },
      {
        id: randomUUID(),
        value: { protocolVersion: 3, id: "placeholder", argv: [], cwd: root, createdAt: fixedNow.toISOString() },
        expectedExit: WorkspaceCliExitCode.protocolError,
        expected: /protocol version/,
      },
      {
        id: randomUUID(),
        value: { protocolVersion: 2, lane: "act", id: "placeholder", argv: [], cwd: root, createdAt: fixedNow.toISOString() },
        expectedExit: WorkspaceCliExitCode.protocolError,
        expected: /actToken/,
      },
      {
        id: randomUUID(),
        value: { protocolVersion: 1, id: randomUUID(), argv: [], cwd: root, createdAt: fixedNow.toISOString() },
        expectedExit: WorkspaceCliExitCode.protocolError,
        expected: /file name/,
      },
    ];
    for (const item of cases) {
      const record = item.value as Record<string, unknown>;
      if (record.id === "placeholder") record.id = item.id;
      const path = broker.requestPaths(item.id).request;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
      const response = await broker.processRequest(item.id, async () => {
        throw new Error("invalid request must not execute");
      });
      assert.equal(response.exitCode, item.expectedExit);
      assert.match(response.stderr, item.expected);
      assert.equal(existsSync(broker.requestPaths(item.id).claim), false);
    }

    const malformedId = randomUUID();
    await writeFile(broker.requestPaths(malformedId).request, "{nope", "utf8");
    const malformed = await broker.processRequest(malformedId, async () => createWorkspaceCliResponse({ id: malformedId, exitCode: 0, stdout: "", stderr: "" }));
    assert.equal(malformed.exitCode, WorkspaceCliExitCode.protocolError);
    assert.match(malformed.stderr, /valid JSON/);
  }, { maxRequestBytes: 256 });

  await withBroker(async ({ broker }) => {
    const id = randomUUID();
    await writeFile(broker.requestPaths(id).request, "x".repeat(257), "utf8");
    const response = await broker.processRequest(id, async () => createWorkspaceCliResponse({ id, exitCode: 0, stdout: "", stderr: "" }));
    assert.equal(response.exitCode, WorkspaceCliExitCode.protocolError);
    assert.match(response.stderr, /size limit/);
  }, { maxRequestBytes: 256, maxActRequestBytes: 256 });
});

test("CLI broker claims, executes, and replays act-lane requests without re-executing mutations", async () => {
  await withBroker(async ({ broker, root }) => {
    const id = randomUUID();
    await broker.writeActRequest(createWorkspaceCliActRequest({
      id,
      argv: ["chat", "status", "--space", "space-1"],
      cwd: root,
      actToken: "0".repeat(64),
      createdAt: fixedNow.toISOString(),
      payload: { messageFile: "hello from a file" },
    }));
    let executions = 0;
    const executor = async (request: WorkspaceCliBrokeredRequest) => {
      executions += 1;
      assert.ok(isWorkspaceCliActRequest(request), "the executor must receive the act-lane request");
      assert.equal(request.actToken, "0".repeat(64));
      assert.equal(request.payload?.messageFile, "hello from a file");
      return createWorkspaceCliResponse({ id: request.id, exitCode: 0, stdout: "done\n", stderr: "", completedAt: fixedNow.toISOString() });
    };
    const first = await broker.processRequest(id, executor);
    assert.equal(first.exitCode, 0);
    assert.equal(executions, 1);

    // A duplicated request id returns the recorded response: replayed act
    // requests must never re-apply their mutation.
    const replay = await broker.processRequest(id, executor);
    assert.equal(replay.stdout, "done\n");
    assert.equal(executions, 1);
  });

  await withBroker(async ({ broker, root }) => {
    const oversized = createWorkspaceCliActRequest({
      id: randomUUID(),
      argv: ["chat", "send", "--space", "space-1", "--message-from-payload"],
      cwd: root,
      actToken: "0".repeat(64),
      createdAt: fixedNow.toISOString(),
      payload: { messageFile: "y".repeat(600) },
    });
    await assert.rejects(() => broker.writeActRequest(oversized), /size limit/);
  }, { maxRequestBytes: 256, maxActRequestBytes: 512 });
});

test("CLI broker rejects symlinked request files", async (t) => {
  await withBroker(async ({ broker, sandbox, root }) => {
    const id = randomUUID();
    const external = join(sandbox, "external-request.json");
    await writeFile(external, JSON.stringify(createWorkspaceCliRequest({ id, argv: [], cwd: root, createdAt: fixedNow.toISOString() })), "utf8");
    try {
      await symlink(external, broker.requestPaths(id).request, "file");
    } catch (error) {
      if (isPermissionFailure(error)) {
        t.skip("This Windows host does not allow creating file symlinks.");
        return;
      }
      throw error;
    }
    const response = await broker.processRequest(id, async () => createWorkspaceCliResponse({ id, exitCode: 0, stdout: "", stderr: "" }));
    assert.equal(response.exitCode, WorkspaceCliExitCode.permissionDenied);
    assert.match(response.stderr, /safe regular file/);
    assert.equal(existsSync(external), true, "the broker must never follow or delete the symlink target");
  });
});

test("CLI broker rejects reparse-point directories", async (t) => {
  await withSandbox(async ({ sandbox, root }) => {
    const paths = workspaceCliBrokerPaths(root);
    await mkdir(paths.root, { recursive: true });
    const outside = join(sandbox, "outside-requests");
    await mkdir(outside);
    try {
      await symlink(outside, paths.requests, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isPermissionFailure(error)) {
        t.skip("This host does not allow creating directory links.");
        return;
      }
      throw error;
    }
    const broker = new WorkspaceCliFileBroker({ stateRoot: root, now: () => fixedNow });
    await assert.rejects(() => broker.initialize(), /safe directory/);
  });
});

test("CLI broker cleanup removes only stale recognized regular files and reports unsafe entries", async (t) => {
  await withBroker(async ({ broker, sandbox }) => {
    const old = new Date("2026-07-10T12:00:00.000Z");
    const recognized = [
      broker.requestPaths(randomUUID()).request,
      broker.requestPaths(randomUUID()).claim,
      broker.requestPaths(randomUUID()).response,
    ];
    for (const path of recognized) {
      await writeFile(path, "{}", "utf8");
      await utimes(path, old, old);
    }
    const unrecognized = join(broker.paths.requests, "keep.txt");
    await writeFile(unrecognized, "keep", "utf8");
    await utimes(unrecognized, old, old);

    const unsafeId = randomUUID();
    const unsafe = broker.requestPaths(unsafeId).request;
    const external = join(sandbox, "cleanup-target.json");
    await writeFile(external, "target", "utf8");
    let linkCreated = true;
    try {
      await symlink(external, unsafe, "file");
    } catch (error) {
      if (isPermissionFailure(error)) linkCreated = false;
      else throw error;
    }

    const result = await broker.cleanup({ olderThanMs: 60_000 });
    assert.deepEqual(new Set(result.removed), new Set(recognized));
    assert.equal(existsSync(unrecognized), true);
    if (linkCreated) {
      assert.equal(result.skippedUnsafe.includes(unsafe), true);
      assert.equal(existsSync(external), true);
    } else {
      t.diagnostic("File symlink cleanup assertion skipped because this host disallows symlinks.");
    }
  });
});

test("CLI response writer validates schema, bounds output, and refuses overwrite", async () => {
  await withBroker(async ({ broker }) => {
    const id = randomUUID();
    const response = createWorkspaceCliResponse({
      id,
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      result: { protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION },
      completedAt: fixedNow.toISOString(),
    });
    await broker.writeResponse(response);
    assert.deepEqual(JSON.parse(await readFile(broker.requestPaths(id).response, "utf8")), response);
    await assert.rejects(() => broker.writeResponse(response), /already exists/);
  });

  await withBroker(async ({ broker }) => {
    const id = randomUUID();
    const response = createWorkspaceCliResponse({ id, exitCode: 0, stdout: "x".repeat(300), stderr: "" });
    await assert.rejects(() => broker.writeResponse(response), /size limit/);
  }, { maxResponseBytes: 256 });
});

async function withBroker(
  action: (context: { broker: WorkspaceCliFileBroker; sandbox: string; root: string }) => Promise<void>,
  limits: { maxRequestBytes?: number; maxActRequestBytes?: number; maxResponseBytes?: number } = {},
): Promise<void> {
  await withSandbox(async ({ sandbox, root }) => {
    const broker = new WorkspaceCliFileBroker({ stateRoot: root, now: () => fixedNow, ...limits });
    await broker.initialize();
    await action({ broker, sandbox, root });
  });
}

async function withSandbox(action: (context: { sandbox: string; root: string }) => Promise<void>): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-cli-test-"));
  const root = resolve(sandbox, "state");
  await mkdir(root, { recursive: true });
  try {
    await action({ sandbox, root });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function isPermissionFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["EPERM", "EACCES", "UNKNOWN"].includes(String((error as NodeJS.ErrnoException).code));
}
