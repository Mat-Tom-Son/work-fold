import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "node:test";

import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
  localDevelopmentStateRoot,
} from "../src/local/server-dev-options.js";

test("local development defaults to dedicated state on every supported platform family", () => {
  const windowsAppData = "C:\\Users\\developer\\AppData\\Roaming";
  const windowsRoot = localDevelopmentStateRoot({
    environment: { APPDATA: windowsAppData },
    platform: "win32",
    homeDirectory: "C:\\Users\\developer",
    currentDirectory: "C:\\source\\workspace",
  });
  assert.equal(windowsRoot, win32.join(windowsAppData, "work-fold Development"));
  assert.notEqual(
    windowsRoot.toLowerCase(),
    win32.join(windowsAppData, "work-fold").toLowerCase(),
  );

  const macRoot = localDevelopmentStateRoot({
    environment: {},
    platform: "darwin",
    homeDirectory: "/Users/developer",
    currentDirectory: "/source/workspace",
  });
  assert.equal(macRoot, "/Users/developer/Library/Application Support/work-fold Development");
  assert.notEqual(macRoot, "/Users/developer/Library/Application Support/work-fold");

  const linuxRoot = localDevelopmentStateRoot({
    environment: { XDG_CONFIG_HOME: "/var/tmp/developer-config" },
    platform: "linux",
    homeDirectory: "/home/developer",
    currentDirectory: "/source/workspace",
  });
  assert.equal(linuxRoot, "/var/tmp/developer-config/work-fold Development");
  assert.notEqual(linuxRoot, "/var/tmp/developer-config/work-fold");
});

test("local development keeps WORKFOLD_STATE_DIR as an explicit override", () => {
  const options = createLocalDevelopmentApiOptions({
    environment: {
      WORKFOLD_LOCAL_API_PORT: "5432",
      WORKFOLD_STATE_DIR: "  fixtures/dev-state  ",
    },
    platform: "linux",
    homeDirectory: "/home/developer",
    currentDirectory: "/source/workspace",
  });

  assert.deepEqual(options, {
    appMode: "dev",
    port: 5432,
    stateBase: posix.resolve("/source/workspace", "fixtures/dev-state"),
  });
});

test("local development loads .env before resolving its state and port", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-dev-env-"));
  const envPath = join(sandbox, ".env");
  const environment: Record<string, string | undefined> = {};
  try {
    await writeFile(envPath, [
      "WORKFOLD_LOCAL_API_PORT=5433",
      "WORKFOLD_STATE_DIR='fixtures/from-dot-env'",
      "WORKFOLD_LOCAL_API_PORT=6000",
      "",
    ].join("\n"), "utf8");
    loadLocalEnvironmentFile(envPath, environment);
    assert.deepEqual(createLocalDevelopmentApiOptions({
      environment,
      platform: "linux",
      homeDirectory: "/home/developer",
      currentDirectory: "/source/workspace",
    }), {
      appMode: "dev",
      port: 5433,
      stateBase: "/source/workspace/fixtures/from-dot-env",
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("local development rejects malformed inherited ports before listen", () => {
  for (const value of ["not-a-port", "-1", "Infinity"]) {
    assert.equal(createLocalDevelopmentApiOptions({
      environment: { WORKFOLD_LOCAL_API_PORT: value },
      platform: "linux",
      homeDirectory: "/home/developer",
      currentDirectory: "/source/workspace",
    }).port, 4327);
  }
  assert.equal(createLocalDevelopmentApiOptions({
    environment: { WORKFOLD_LOCAL_API_PORT: "0" },
    platform: "linux",
    homeDirectory: "/home/developer",
    currentDirectory: "/source/workspace",
  }).port, 0);
});

test("the Local API resolves development defaults only after loading .env", async () => {
  const source = await readFile(new URL("../src/local/server.ts", import.meta.url), "utf8");
  const startBody = source.slice(source.indexOf("export async function startLocalApi"));
  const loadIndex = startBody.indexOf("loadLocalEnvironmentFile(");
  const defaultsIndex = startBody.indexOf("createLocalDevelopmentApiOptions()");
  assert.ok(loadIndex >= 0 && defaultsIndex > loadIndex);

  const entrypoint = await readFile(new URL("../src/local/server-dev.ts", import.meta.url), "utf8");
  assert.match(entrypoint, /startLocalApi\(\{\s*appMode:\s*"dev"\s*\}\)/);
  assert.doesNotMatch(entrypoint, /createLocalDevelopmentApiOptions/);
});
