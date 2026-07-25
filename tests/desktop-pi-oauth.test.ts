import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopPiOAuthHooks,
  type DesktopOAuthMessageBoxOptions,
} from "../desktop/src/pi-oauth.js";

test("desktop Pi OAuth opens provider URLs and copies device codes", async () => {
  const opened: string[] = [];
  const copied: string[] = [];
  const messages: DesktopOAuthMessageBoxOptions[] = [];
  const hooks = createDesktopPiOAuthHooks({
    openExternal(url) {
      opened.push(url);
    },
    readClipboard() {
      return "";
    },
    writeClipboard(value) {
      copied.push(value);
    },
    async showMessageBox(options) {
      messages.push(options);
      return { response: 0 };
    },
  });

  await hooks.openUrl({ url: "https://example.com/authorize" });
  await hooks.showDeviceCode({
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
  });
  await Promise.resolve();

  assert.deepEqual(opened, ["https://example.com/authorize"]);
  assert.deepEqual(copied, ["ABCD-1234"]);
  assert.match(messages[0]?.message ?? "", /ABCD-1234/);
});

test("desktop Pi OAuth only reads clipboard after an explicit paste choice", async () => {
  let reads = 0;
  const hooks = createDesktopPiOAuthHooks({
    openExternal() {},
    readClipboard() {
      reads += 1;
      return " authorization-code ";
    },
    writeClipboard() {},
    async showMessageBox() {
      assert.equal(reads, 0);
      return { response: 0 };
    },
  });

  assert.equal(await hooks.prompt({ message: "Paste the code" }), "authorization-code");
  assert.equal(reads, 1);
});

test("desktop Pi OAuth supports provider defaults and cancellable selections", async () => {
  const responses = [1, 2];
  let reads = 0;
  const hooks = createDesktopPiOAuthHooks({
    openExternal() {},
    readClipboard() {
      reads += 1;
      return "unused";
    },
    writeClipboard() {},
    async showMessageBox() {
      return { response: responses.shift() ?? 0 };
    },
  });

  assert.equal(await hooks.prompt({ message: "GitHub host", allowEmpty: true }), "");
  assert.equal(reads, 0);
  assert.equal(await hooks.select({
    message: "Choose a method",
    options: [
      { id: "browser", label: "Browser" },
      { id: "device", label: "Device code" },
    ],
  }), undefined);
});

test("desktop Pi OAuth rejects a cancelled required prompt", async () => {
  const hooks = createDesktopPiOAuthHooks({
    openExternal() {},
    readClipboard() {
      return "";
    },
    writeClipboard() {},
    async showMessageBox() {
      return { response: 1 };
    },
  });

  await assert.rejects(
    hooks.prompt({ message: "Paste the code" }),
    /sign-in cancelled/i,
  );
});
