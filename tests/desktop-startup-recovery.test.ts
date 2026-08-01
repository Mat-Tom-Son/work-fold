import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RestrictedAppRegistryVersionUnsupportedError,
} from "../src/local/agent/restricted-app-registry-error.js";
import {
  latestWorkFoldReleaseUrl,
  runWorkFoldStartupRecovery,
  workFoldStartupRecoveryDialog,
  workFoldStartupRecoveryPlan,
  type WorkFoldStartupRecoveryDialog,
  type WorkFoldStartupRecoveryHost,
} from "../desktop/src/startup-recovery.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("newer local state produces update recovery without treating corruption as an update", () => {
  const plan = workFoldStartupRecoveryPlan(new RestrictedAppRegistryVersionUnsupportedError(6, 5));
  assert.deepEqual(plan, {
    reason: "newer-local-state",
    actualVersion: 6,
    supportedVersion: 5,
    title: "work-fold update required",
    message: "This version of work-fold cannot safely open newer local data.",
  });
  assert.equal(workFoldStartupRecoveryPlan(new RestrictedAppRegistryVersionUnsupportedError(5, 5)), null);
  assert.equal(workFoldStartupRecoveryPlan(new RestrictedAppRegistryVersionUnsupportedError("future", 5)), null);
  assert.equal(workFoldStartupRecoveryPlan(new Error("Registry is corrupt.")), null);
});

test("startup recovery prompts before network work and hands successful installation off without quitting", async () => {
  const plan = requiredPlan();
  const events: string[] = [];
  const dialogs: WorkFoldStartupRecoveryDialog[] = [];
  const responses = [0, 0];
  const outcome = await runWorkFoldStartupRecovery(plan, recoveryHost({
    events,
    dialogs,
    responses,
    checkForUpdate: async () => {
      events.push("check");
      return "0.5.0";
    },
    downloadAndInstall: async () => {
      events.push("install");
      return true;
    },
  }));

  assert.equal(outcome, "installing");
  assert.deepEqual(events, ["dialog:initial", "check", "dialog:available", "install"]);
  assert.deepEqual(dialogs[0]?.buttons, ["Check for Updates", "Open Releases", "Quit"]);
  assert.deepEqual(dialogs[1]?.buttons, ["Download and Install", "Open Releases", "Quit"]);
});

test("startup recovery keeps release fallback and quit behavior for check and install failures", async () => {
  for (const scenario of ["check", "install"] as const) {
    const events: string[] = [];
    const dialogs: WorkFoldStartupRecoveryDialog[] = [];
    const responses = scenario === "check" ? [0, 0] : [0, 0, 0];
    const outcome = await runWorkFoldStartupRecovery(requiredPlan(), recoveryHost({
      events,
      dialogs,
      responses,
      checkForUpdate: async () => {
        events.push("check");
        if (scenario === "check") throw new Error("offline");
        return "0.5.0";
      },
      downloadAndInstall: async () => {
        events.push("install");
        return false;
      },
    }));
    assert.equal(outcome, "quit");
    assert.equal(dialogs.at(-1)?.stage, scenario === "check" ? "check-failed" : "install-failed");
    assert.deepEqual(events.slice(-2), ["open", "quit"]);
  }
});

test("opening Releases from the initial prompt performs no update effect", async () => {
  const events: string[] = [];
  const outcome = await runWorkFoldStartupRecovery(requiredPlan(), recoveryHost({
    events,
    dialogs: [],
    responses: [1],
    checkForUpdate: async () => {
      events.push("unexpected-check");
      return null;
    },
    downloadAndInstall: async () => {
      events.push("unexpected-install");
      return false;
    },
  }));
  assert.equal(outcome, "quit");
  assert.deepEqual(events, ["dialog:initial", "open", "quit"]);
});

test("desktop startup wires the tested recovery controller to updater and release adapters", () => {
  const source = readFileSync(join(rootDir, "desktop", "src", "main.ts"), "utf8");
  assert.match(source, /workFoldStartupRecoveryPlan\(error\)/);
  assert.match(source, /runWorkFoldStartupRecovery\(plan/);
  assert.match(source, /desktopUpdater\.updateNow\(\)/);
  assert.match(source, /openExternal\(latestWorkFoldReleaseUrl\)/);
  assert.match(source, /could not complete update recovery/);
  assert.equal(latestWorkFoldReleaseUrl, "https://github.com/Mat-Tom-Son/work-fold/releases/latest");
});

function requiredPlan() {
  return workFoldStartupRecoveryPlan(new RestrictedAppRegistryVersionUnsupportedError(6, 5))!;
}

function recoveryHost(input: {
  events: string[];
  dialogs: WorkFoldStartupRecoveryDialog[];
  responses: number[];
  checkForUpdate: WorkFoldStartupRecoveryHost["checkForUpdate"];
  downloadAndInstall: WorkFoldStartupRecoveryHost["downloadAndInstall"];
}): WorkFoldStartupRecoveryHost {
  return {
    showDialog: async (dialog) => {
      input.dialogs.push(dialog);
      input.events.push(`dialog:${dialog.stage}`);
      const response = input.responses.shift();
      assert.notEqual(response, undefined, `Missing response for ${dialog.stage}.`);
      return response!;
    },
    checkForUpdate: input.checkForUpdate,
    downloadAndInstall: input.downloadAndInstall,
    openReleases: async () => { input.events.push("open"); },
    quit: () => { input.events.push("quit"); },
  };
}

test("dialog copy keeps data safety explicit in every recovery stage", () => {
  const plan = requiredPlan();
  for (const stage of [
    { kind: "initial" },
    { kind: "available", version: "0.5.0" },
    { kind: "unavailable" },
    { kind: "check-failed" },
    { kind: "install-failed" },
  ] as const) {
    assert.match(workFoldStartupRecoveryDialog(plan, stage).detail, /Spaces and app data are safe/);
  }
});
