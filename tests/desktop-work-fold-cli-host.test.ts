import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WorkFoldDesktopCliHost,
  workFoldCliInstanceData,
  workFoldCliRequestIdFromArgv,
  workFoldCliRequestIdFromInstanceData,
  workFoldSecondInstanceIntent,
} from "../desktop/src/work-fold-cli-host.js";
import {
  createWorkFoldCliActRequest,
  createWorkFoldCliRequest,
  type WorkFoldActFacade,
  type WorkFoldCliKernel,
} from "../src/local/cli/index.js";

test("desktop CLI launch metadata accepts both Electron argument forms", () => {
  const id = randomUUID();
  assert.equal(workFoldCliRequestIdFromArgv(["work-fold.exe", "--work-fold-cli-request", id]), id);
  assert.equal(workFoldCliRequestIdFromArgv(["work-fold.exe", `--work-fold-cli-request=${id}`]), id);
  assert.equal(workFoldCliRequestIdFromArgv(["work-fold.exe"]), null);
  assert.deepEqual(workFoldCliInstanceData(id), { kind: "work-fold-cli", requestId: id });
  assert.deepEqual(workFoldCliInstanceData(null), { kind: "work-fold-gui" });
  assert.equal(workFoldCliRequestIdFromInstanceData({ kind: "work-fold-cli", requestId: id }), id);
  assert.equal(workFoldCliRequestIdFromInstanceData({ kind: "work-fold-gui" }), null);
  assert.throws(() => workFoldCliRequestIdFromArgv(["work-fold.exe", "--work-fold-cli-request", "../bad"]), /UUID/);
  assert.throws(() => workFoldCliRequestIdFromArgv([
    "work-fold.exe",
    "--work-fold-cli-request",
    id,
    "--work-fold-cli-request",
    randomUUID(),
  ]), /only once/);
});

test("second-instance launches route by cause and CLI shape never reads as interactive", () => {
  const id = randomUUID();
  // Healthy CLI signals resolve from instance data or argv.
  assert.deepEqual(
    workFoldSecondInstanceIntent(["work-fold.exe"], { kind: "work-fold-cli", requestId: id }),
    { kind: "cli", requestId: id },
  );
  assert.deepEqual(
    workFoldSecondInstanceIntent(["work-fold.exe", `--work-fold-cli-request=${id}`], null),
    { kind: "cli", requestId: id },
  );
  // Genuine interactive relaunches are the only "gui" outcomes.
  assert.deepEqual(workFoldSecondInstanceIntent(["work-fold.exe"], { kind: "work-fold-gui" }), { kind: "gui" });
  assert.deepEqual(workFoldSecondInstanceIntent(["work-fold.exe"], null), { kind: "gui" });
  // A CLI-stamped launch whose request id was dropped in transit must stay
  // headless (docs/ui-parity.md: headless CLI requests never open or steal
  // focus from the interactive window) — it must never classify as "gui".
  assert.equal(workFoldSecondInstanceIntent(["work-fold.exe"], { kind: "work-fold-cli" }).kind, "cli-invalid");
  assert.equal(workFoldSecondInstanceIntent(["work-fold.exe"], { kind: "work-fold-cli", requestId: 7 }).kind, "cli-invalid");
  // Mangled ids from either channel reject without becoming interactive.
  assert.equal(
    workFoldSecondInstanceIntent(["work-fold.exe"], { kind: "work-fold-cli", requestId: "../bad" }).kind,
    "cli-invalid",
  );
  assert.equal(workFoldSecondInstanceIntent(["work-fold.exe", "--work-fold-cli-request", "nope"], null).kind, "cli-invalid");
  assert.equal(workFoldSecondInstanceIntent(["work-fold.exe", "--work-fold-cli-request"], null).kind, "cli-invalid");
  assert.equal(workFoldSecondInstanceIntent(["work-fold.exe", "--work-fold-cli-request="], null).kind, "cli-invalid");
});

test("desktop CLI host processes an atomic request through the executor", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "work-fold-desktop-cli-"));
  try {
    const host = new WorkFoldDesktopCliHost({
      stateRoot,
      kernel: fixtureKernel(),
      version: "9.8.7",
    });
    await host.initialize();
    const request = createWorkFoldCliRequest({
      id: randomUUID(),
      argv: ["version", "--json"],
      cwd: resolve("."),
    });
    await host.broker.writeRequest(request);
    await host.processRequest(request.id);
    const response = await host.broker.readResponse(request.id);
    assert.equal(response.exitCode, 0);
    assert.equal(response.stderr, "");
    assert.match(response.stdout, /"version": "9\.8\.7"/);
    assert.deepEqual(response.result, {
      name: "work-fold",
      version: "9.8.7",
      protocolVersion: 1,
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("desktop CLI host serializes overlapping requests and exposes an idle drain", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "work-fold-desktop-cli-queue-"));
  let active = 0;
  let maxActive = 0;
  const kernel = fixtureKernel();
  kernel.listSpaces = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 15));
    active -= 1;
    return [];
  };
  try {
    const host = new WorkFoldDesktopCliHost({ stateRoot, kernel, version: "1.0.0" });
    await host.initialize();
    const requests = [randomUUID(), randomUUID()].map((id) => createWorkFoldCliRequest({
      id,
      argv: ["spaces", "list", "--json"],
      cwd: resolve("."),
    }));
    await Promise.all(requests.map((request) => host.broker.writeRequest(request)));
    const processing = requests.map((request) => host.processRequest(request.id));
    await host.whenIdle();
    await Promise.all(processing);
    assert.equal(maxActive, 1);
    assert.deepEqual(
      await Promise.all(requests.map(async (request) => (await host.broker.readResponse(request.id)).exitCode)),
      [0, 0],
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("desktop CLI host gates act requests on the per-launch authority and records receipts", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "work-fold-desktop-cli-act-"));
  const token = "d".repeat(64);
  try {
    let authority: { facade: WorkFoldActFacade; token: string } | null = null;
    const chatCreates: string[] = [];
    const facade = {
      async createConversation(input: { space: string }) {
        chatCreates.push(input.space);
        return {
          space: { id: "space-1", name: "Act Space", spaceRoot: join(stateRoot, "space") },
          conversation: {
            id: "chat-1",
            title: "New Chat",
            createdAt: "2026-07-31T00:00:00.000Z",
            updatedAt: "2026-07-31T00:00:00.000Z",
            archivedAt: null,
            snoozedUntil: null,
          },
        };
      },
    } as unknown as WorkFoldActFacade;
    const host = new WorkFoldDesktopCliHost({
      stateRoot,
      kernel: fixtureKernel(),
      version: "1.0.0",
      getActFacade: () => authority,
    });
    await host.initialize();

    // Without the interactive app, act commands answer unavailable while v1
    // reads in the same queue keep working.
    const offline = createWorkFoldCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--space", "space-1", "--json"],
      cwd: resolve("."),
      actToken: token,
    });
    const read = createWorkFoldCliRequest({ id: randomUUID(), argv: ["version", "--json"], cwd: resolve(".") });
    await host.broker.writeActRequest(offline);
    await host.broker.writeRequest(read);
    await host.processRequest(offline.id);
    await host.processRequest(read.id);
    const offlineResponse = await host.broker.readResponse(offline.id);
    assert.equal(offlineResponse.exitCode, 6);
    assert.match(offlineResponse.stderr, /Open work-fold/);
    assert.equal((await host.broker.readResponse(read.id)).exitCode, 0);
    assert.equal(chatCreates.length, 0);

    // A stale or wrong token is rejected identically.
    authority = { facade, token };
    const wrongToken = createWorkFoldCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--space", "space-1", "--json"],
      cwd: resolve("."),
      actToken: "e".repeat(64),
    });
    await host.broker.writeActRequest(wrongToken);
    await host.processRequest(wrongToken.id);
    assert.equal((await host.broker.readResponse(wrongToken.id)).exitCode, 6);
    assert.equal(chatCreates.length, 0);

    // With the matching per-launch token the facade is reached and the journal
    // records accepted-then-ok around the mutation.
    const accepted = createWorkFoldCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--space", "space-1", "--json"],
      cwd: resolve("."),
      actToken: token,
    });
    await host.broker.writeActRequest(accepted);
    await host.processRequest(accepted.id);
    const acceptedResponse = await host.broker.readResponse(accepted.id);
    assert.equal(acceptedResponse.exitCode, 0, acceptedResponse.stderr);
    assert.match(acceptedResponse.stdout, /"chat\.create"/);
    assert.deepEqual(chatCreates, ["space-1"]);

    // Replaying the same request id after the shim has cleaned up its request
    // and response files must be refused, not re-executed.
    const { readFile, rm: removeFile } = await import("node:fs/promises");
    await removeFile(host.broker.requestPaths(accepted.id).response, { force: true });
    await host.broker.writeActRequest(accepted);
    await host.processRequest(accepted.id);
    const replayResponse = await host.broker.readResponse(accepted.id);
    assert.equal(replayResponse.exitCode, 5, replayResponse.stderr);
    assert.match(replayResponse.stderr, /already executed/);
    assert.deepEqual(chatCreates, ["space-1"], "a replayed act request must not re-run its mutation");

    const receiptLines = (await readFile(host.receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      receiptLines.map((line) => line.outcome),
      ["rejected", "rejected", "accepted", "ok", "rejected"],
    );
    assert.equal(receiptLines[3]?.command, "chat.create");
    assert.equal(receiptLines[3]?.spaceId, "space-1");
    assert.equal(receiptLines[3]?.conversationId, "chat-1");
    assert.equal(receiptLines[4]?.errorCode, "conflict");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("desktop main wires one settle seam, one receipts ledger, and routing sleep/wake beside the app lifecycle", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");

  // One WorkFoldSettleSignal per desktop host: constructed once, published
  // into by the host's Check and restricted-app services, consumed by the
  // local API's routing executor. Anything else silently drops settles.
  const hostStart = main.indexOf("async function ensureDesktopHost");
  assert.ok(hostStart >= 0);
  const hostBody = main.slice(hostStart, main.indexOf("\nasync function processWorkFoldCliRequest", hostStart));
  assert.match(hostBody, /const settleSignal = new WorkFoldSettleSignal\(\);/);
  const restrictedCreate = hostBody.slice(hostBody.indexOf("RestrictedAppService.create({"), hostBody.indexOf("})", hostBody.indexOf("RestrictedAppService.create({")));
  assert.match(restrictedCreate, /settleSignal,/, "the restricted-app service publishes into the shared signal");
  assert.match(hostBody, /new WorkFoldCheckService\(\{ kernel, settleSignal \}\)/, "the Check service publishes into the shared signal");
  assert.match(hostBody, /settleSignal \};\s*$/m);

  const apiStart = main.indexOf("function ensureInteractiveLocalApi");
  const apiBody = main.slice(apiStart, main.indexOf("\nasync function ensureRemoteAccessClient", apiStart));
  assert.match(apiBody, /settleSignal: host\.settleSignal,/, "the local API consumes the host's exact signal instance");
  assert.match(apiBody, /actReceipts: host\.cli\.receipts,/, "decisions, publications, and CLI acts share the CLI host's one ledger");
  assert.match(apiBody, /publicationKeys: host\.settings\.publicationKeyStore\(\)/);
  assert.match(apiBody, /routingPowerLifecycle = api\.routings;/);

  // Sleep suspends both schedulers; wake resumes both. Routing runs abort on
  // suspension and settle `interrupted` (docs/fold-routings.md).
  const powerStart = main.indexOf("function configurePowerMonitor");
  const powerBody = main.slice(powerStart, main.indexOf("\nfunction configureAccentColorMonitor", powerStart));
  const suspendBody = powerBody.slice(powerBody.indexOf('powerMonitor.on("suspend"'), powerBody.indexOf('powerMonitor.on("resume"'));
  assert.match(suspendBody, /suspendAutomations\(\)/);
  assert.match(suspendBody, /routingPowerLifecycle\?\.suspend\(\);/);
  const resumeBody = powerBody.slice(powerBody.indexOf('powerMonitor.on("resume"'), powerBody.indexOf('powerMonitor.on("shutdown"'));
  assert.match(resumeBody, /resumeAutomations\(\)/);
  assert.match(resumeBody, /routingPowerLifecycle\?\.resume\(\)\.catch\(\(error\) =>/);
  assert.match(resumeBody, /could not resume Routings after wake/);

  // The remote client keeps the viewer-page provider wired to the
  // publication authority, and reconnects re-drive pending bridge syncs.
  const remoteStart = main.indexOf("async function ensureRemoteAccessClient");
  const remoteBody = main.slice(remoteStart, main.indexOf("\nasync function promptRemoteBrowserPairing", remoteStart));
  assert.match(remoteBody, /servePage: \(publicationId\) => api\.publications\.serveViewerPage\(publicationId\)/);
  assert.match(remoteBody, /onDeviceConnected: \(\) => api\.publications\.redriveBridgeSync\(\)/);
});

function fixtureKernel(): WorkFoldCliKernel {
  return {
    async getContext(actor) {
      return { cwd: actor.cwd, space: null };
    },
    async listSpaces() {
      return [];
    },
    async listTasks() {
      return [];
    },
    async listCapabilities() {
      return [];
    },
  };
}
