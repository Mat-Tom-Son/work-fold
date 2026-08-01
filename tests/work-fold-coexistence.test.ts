import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import {
  defaultAgentSdkDir,
  spaceSessionDir,
  spaceStorageKey,
} from "../src/local/agent/agent-data-dir.js";
import {
  RestrictedAppFileBroker,
  RestrictedAppFileError,
  type RestrictedAppFileContext,
} from "../src/local/agent/restricted-app-files.js";
import { listConversations } from "../src/local/agent/chat-store.js";
import { createLocalDevelopmentApiOptions } from "../src/local/server-dev-options.js";
import {
  configureWorkFoldStateRoot,
  spaceManifestFile,
} from "../src/local/state-paths.js";
import {
  listSpaces,
  registerLinkedSpace,
  scanSpaceTree,
} from "../src/local/space.js";
import { workFoldDesktopStateOverride } from "../desktop/src/user-data-path.js";

let sandbox = "";
let newStateRoot = "";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "work-fold-coexistence-"));
  newStateRoot = join(sandbox, "new-product-state");
  configureWorkFoldStateRoot(newStateRoot);
});

after(async () => {
  configureWorkFoldStateRoot(undefined);
  await rm(sandbox, { recursive: true, force: true });
});

test("legacy app state and linked-folder metadata remain undiscovered and byte-preserved", async () => {
  const linkedRoot = join(sandbox, "linked-space");
  const legacyStateRoot = join(sandbox, "Space");
  const legacyMetadataRoot = join(linkedRoot, ".workspace");
  const legacyConversationRoot = join(legacyMetadataRoot, "conversations");
  await mkdir(legacyStateRoot, { recursive: true });
  await mkdir(legacyConversationRoot, { recursive: true });
  await writeFile(join(linkedRoot, "ordinary.txt"), "ordinary content\n", "utf8");

  const legacyId = legacyUnsaltedSpaceId(linkedRoot);
  const legacyRegistryPath = join(legacyStateRoot, "space-registry.json");
  const legacyManifestPath = join(legacyMetadataRoot, "space.json");
  const legacyConversationPath = join(legacyConversationRoot, "chat-legacy.jsonl");
  const legacyRegistryBytes = Buffer.from(`{\n  "version": 1,\n  "spaces": [{"id":"${legacyId}","name":"Legacy","rootPath":${JSON.stringify(linkedRoot)}}],\n  "pendingRemovals": []\n}\n`);
  const legacyManifestBytes = Buffer.from(`${JSON.stringify({
    version: 1,
    id: legacyId,
    name: "Legacy portable identity",
    createdAt: "2025-01-02T03:04:05.000Z",
    updatedAt: "2025-01-02T03:04:05.000Z",
  })}\n`);
  const legacyConversationBytes = Buffer.from("{\"id\":\"legacy-message\",\"role\":\"user\",\"content\":\"legacy bytes\",\"createdAt\":\"2025-01-02T03:04:05.000Z\"}\n");
  await writeFile(legacyRegistryPath, legacyRegistryBytes);
  await writeFile(legacyManifestPath, legacyManifestBytes);
  await writeFile(legacyConversationPath, legacyConversationBytes);

  const before = await snapshots([
    legacyRegistryPath,
    legacyManifestPath,
    legacyConversationPath,
  ]);

  assert.deepEqual(await listSpaces(), [], "the new profile must not discover the old registry");
  assert.deepEqual(await listConversations(linkedRoot), [], "the new Chat store must not discover .workspace transcripts");

  const registered = await registerLinkedSpace(linkedRoot);
  const newManifest = JSON.parse(await readFile(spaceManifestFile(linkedRoot), "utf8")) as { id: string };
  assert.equal(registered.id, newManifest.id);
  assert.notEqual(registered.id, legacyId, "the clean product identity must not reuse the exact legacy path-derived id");
  assert.deepEqual((await listSpaces()).map((space) => space.id), [registered.id]);
  assert.deepEqual((await scanSpaceTree(linkedRoot)).entries.map((entry) => entry.path), ["ordinary.txt"]);
  assert.equal(existsSync(join(linkedRoot, ".work-fold", "space.json")), true);

  assert.deepEqual(await snapshots([
    legacyRegistryPath,
    legacyManifestPath,
    legacyConversationPath,
  ]), before, "registration must leave all old product and portable bytes and timestamps untouched");
});

test("legacy Pi sessions remain intact beside the work-fold session namespace", async () => {
  const spaceRoot = join(sandbox, "session-space");
  const agentRoot = join(sandbox, "pi-agent");
  const spaceKey = spaceStorageKey(spaceRoot);
  const legacySessionRoot = join(agentRoot, "sessions", spaceKey);
  const legacySessionPath = join(legacySessionRoot, "session.jsonl");
  await mkdir(legacySessionRoot, { recursive: true });
  const legacyBytes = Buffer.from([0, 255, 17, 34, 51, 68, 85]);
  await writeFile(legacySessionPath, legacyBytes);
  const before = await snapshots([legacySessionPath]);

  const newSessionRoot = spaceSessionDir(spaceRoot, agentRoot);
  assert.equal(newSessionRoot, join(agentRoot, "sessions", "work-fold", spaceKey));
  assert.notEqual(newSessionRoot, legacySessionRoot);
  await mkdir(newSessionRoot, { recursive: true });
  await writeFile(join(newSessionRoot, "session.jsonl"), "new work-fold session\n", "utf8");

  assert.deepEqual(await snapshots([legacySessionPath]), before);
  assert.deepEqual(await readFile(legacySessionPath), legacyBytes);
});

test("legacy product environment variables cannot select work-fold state", () => {
  const legacyAgentRoot = join(sandbox, "legacy-agent");
  const piAgentRoot = join(sandbox, "pi-agent-from-native-env");
  assert.equal(defaultAgentSdkDir({
    WORKSPACE_AGENT_DIR: legacyAgentRoot,
    PI_CODING_AGENT_DIR: piAgentRoot,
  }), piAgentRoot);

  const options = createLocalDevelopmentApiOptions({
    environment: {
      WORKSPACE_LOCAL_API_PORT: "7999",
      WORKSPACE_STATE_DIR: join(sandbox, "legacy-state-override"),
    },
    platform: "linux",
    homeDirectory: join(sandbox, "home"),
    currentDirectory: sandbox,
  });
  assert.equal(options.port, 4327);
  assert.equal(options.stateBase, join(sandbox, "home", ".config", "work-fold Development"));
  assert.equal(workFoldDesktopStateOverride({
    WORKSPACE_DESKTOP_STATE_DIR: join(sandbox, "legacy-desktop-state"),
  }), undefined);
});

test("restricted app public file APIs deny Windows-case variants of reserved metadata", async () => {
  const root = join(sandbox, "restricted-app-space");
  await mkdir(root, { recursive: true });
  const broker = new RestrictedAppFileBroker();
  const authority = restrictedAppContext(root);

  for (const reserved of [".WORK-FOLD", ".WoRkSpAcE", ".PI"]) {
    const reservedRoot = join(root, reserved);
    await mkdir(reservedRoot, { recursive: true });
    await writeFile(join(reservedRoot, "secret.txt"), "must stay private", "utf8");
    await assert.rejects(
      broker.read(authority, { grantId: "selected-files", path: `${reserved}/secret.txt` }),
      isFileDenied,
    );
    await assert.rejects(
      broker.write(authority, {
        grantId: "selected-files",
        path: `${reserved}/secret.txt`,
        data: "overwrite attempt",
        mode: "replace",
      }),
      isFileDenied,
    );
    await assert.rejects(
      broker.validateGrant(restrictedAppContext(root, reserved), "selected-files"),
      isFileDenied,
    );
    assert.equal(await readFile(join(reservedRoot, "secret.txt"), "utf8"), "must stay private");
  }
});

function legacyUnsaltedSpaceId(rootPath: string): string {
  const resolved = resolve(rootPath);
  const normalized = process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  return `ws-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

async function snapshots(paths: string[]): Promise<Array<{ path: string; bytes: Buffer; mtimeMs: number }>> {
  return Promise.all(paths.map(async (path) => ({
    path,
    bytes: await readFile(path),
    mtimeMs: (await stat(path)).mtimeMs,
  })));
}

function restrictedAppContext(spaceRoot: string, root = "."): RestrictedAppFileContext {
  return {
    spaceRoot,
    declarations: [{ id: "files", target: "directory", access: "read-write" }],
    grants: [{ id: "selected-files", declarationId: "files", root, access: "read-write" }],
  };
}

function isFileDenied(error: unknown): boolean {
  return error instanceof RestrictedAppFileError && error.code === "FILE_DENIED";
}
