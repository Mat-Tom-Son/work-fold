import assert from "node:assert/strict";
import test from "node:test";

import { openWithAppName, openWithDialogOptions, openWithLaunchPlan } from "../desktop/src/open-with.js";

test("the app picker starts where each platform keeps its apps", () => {
  assert.deepEqual(openWithDialogOptions("darwin"), {
    title: "Choose an app",
    properties: ["openFile"],
    defaultPath: "/Applications",
    filters: [{ name: "Applications", extensions: ["app"] }],
  });
  assert.deepEqual(openWithDialogOptions("win32", { ProgramFiles: "D:\\Apps" }), {
    title: "Choose an app",
    properties: ["openFile"],
    defaultPath: "D:\\Apps",
    filters: [{ name: "Applications", extensions: ["exe"] }],
  });
  assert.equal(openWithDialogOptions("win32", {}).defaultPath, "C:\\Program Files");
  assert.deepEqual(openWithDialogOptions("linux"), { title: "Choose an app", properties: ["openFile"] });
});

test("the chosen app is named without its extension", () => {
  assert.equal(openWithAppName("/Applications/Preview.app", "darwin"), "Preview");
  assert.equal(openWithAppName("/Applications/Visual Studio Code.app/", "darwin"), "Visual Studio Code");
  assert.equal(openWithAppName("C:\\Program Files\\Notepad++\\notepad++.exe", "win32"), "notepad++");
  assert.equal(openWithAppName("/usr/bin/gedit", "linux"), "gedit");
});

test("launch plans are argument vectors with the file as its own argument", () => {
  assert.deepEqual(openWithLaunchPlan("darwin", "/Applications/Preview.app", "/Users/me/Space/a b.pdf"), {
    kind: "exec",
    command: "/usr/bin/open",
    args: ["-a", "/Applications/Preview.app", "/Users/me/Space/a b.pdf"],
  });
  assert.deepEqual(openWithLaunchPlan("win32", "C:\\Apps\\tool.exe", "C:\\Space\\x & y.txt"), {
    kind: "spawn",
    command: "C:\\Apps\\tool.exe",
    args: ["C:\\Space\\x & y.txt"],
  });
  assert.deepEqual(openWithLaunchPlan("linux", "/usr/bin/gedit", "/home/me/Space/$(rm).txt").args, ["/home/me/Space/$(rm).txt"]);
  assert.throws(() => openWithLaunchPlan("linux", "", "/tmp/x"), /required/);
  assert.throws(() => openWithLaunchPlan("linux", "/usr/bin/gedit", "/tmp/x\0y"), /required/);
});
