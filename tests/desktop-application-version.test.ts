import assert from "node:assert/strict";
import test from "node:test";

import { resolveDesktopApplicationVersion } from "../desktop/src/application-version.js";

test("unpackaged desktop builds show the product package version", () => {
  assert.equal(resolveDesktopApplicationVersion({
    isPackaged: false,
    electronVersion: "42.6.1",
    developmentPackageVersion: "0.1.1",
  }), "0.1.1");
});

test("packaged desktop builds keep Electron's application version", () => {
  assert.equal(resolveDesktopApplicationVersion({
    isPackaged: true,
    electronVersion: "0.1.1",
    developmentPackageVersion: "9.9.9",
  }), "0.1.1");
});

test("unpackaged desktop builds fall back safely when package metadata is unavailable", () => {
  assert.equal(resolveDesktopApplicationVersion({
    isPackaged: false,
    electronVersion: "42.6.1",
  }), "42.6.1");
});
