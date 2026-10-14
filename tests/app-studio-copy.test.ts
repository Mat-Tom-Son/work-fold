import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseDeletionResultToast,
  retainedDataPurgeResultToast,
  uninstallResultToast,
} from "../web-local/src/lib/app-studio-copy.js";

test("App Studio reports deferred uninstall cleanup without claiming data is already gone", () => {
  assert.deepEqual(uninstallResultToast({ removed: true, disposition: "purge", cleanupPending: true }), {
    text: "App authority removed · local data cleanup will retry",
    tone: "info",
  });
  assert.deepEqual(uninstallResultToast({ removed: true, disposition: "retain", cleanupPending: true }), {
    text: "App uninstalled · data retained · remaining cleanup will retry",
    tone: "info",
  });
  assert.deepEqual(uninstallResultToast({ removed: true, disposition: "purge", cleanupPending: false }), {
    text: "App and local data removed",
    tone: "success",
  });
});

test("App Studio distinguishes detached retained data from completed device cleanup", () => {
  assert.deepEqual(retainedDataPurgeResultToast({ purged: true, cleanupPending: true }), {
    text: "Retained data detached · device cleanup will retry",
    tone: "info",
  });
  assert.deepEqual(retainedDataPurgeResultToast({ purged: true, cleanupPending: false }), {
    text: "Retained App data purged",
    tone: "success",
  });
});

test("App Studio distinguishes Release registry deletion from deferred byte cleanup", () => {
  assert.deepEqual(releaseDeletionResultToast({
    displayVersion: "1.2.0",
    deleted: true,
    cleanupPending: true,
  }), {
    text: "Release 1.2.0 removed · stored-byte cleanup will retry",
    tone: "info",
  });
  assert.deepEqual(releaseDeletionResultToast({
    displayVersion: "1.2.0",
    deleted: true,
    cleanupPending: false,
  }), {
    text: "Release 1.2.0 deleted",
    tone: "success",
  });
  // A deleted Release waits in Recently Deleted (docs/receipts-not-gates.md, F20).
  assert.deepEqual(releaseDeletionResultToast({
    displayVersion: "1.2.0",
    deleted: true,
    cleanupPending: false,
    recentlyDeleted: true,
  }), {
    text: "Release 1.2.0 moved to Recently Deleted",
    tone: "success",
  });
  assert.deepEqual(releaseDeletionResultToast({
    displayVersion: "1.2.0",
    deleted: true,
    cleanupPending: true,
    recentlyDeleted: true,
  }), {
    text: "Release 1.2.0 moved to Recently Deleted · stored-byte cleanup will retry",
    tone: "info",
  });
});
