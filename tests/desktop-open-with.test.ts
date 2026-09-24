import assert from "node:assert/strict";
import test from "node:test";

import { openFileWithPickedApp, openWithAppName, openWithDialogOptions, openWithLaunchPlan, type OpenWithLaunchPlan } from "../desktop/src/open-with.js";

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

test("Open with rechecks the Folder file after the picker closes", async () => {
  const calls: string[] = [];
  const launches: OpenWithLaunchPlan[] = [];
  let file = "/Folder/before.txt";
  const result = await openFileWithPickedApp("darwin", {
    resolveFile: async () => { calls.push("resolve"); return file; },
    pickApp: async () => { calls.push("pick"); file = "/Folder/after.txt"; return "/Applications/Preview.app"; },
    launch: async (plan) => { calls.push("launch"); launches.push(plan); },
  });
  assert.deepEqual(calls, ["resolve", "pick", "resolve", "launch"]);
  assert.deepEqual(launches, [{ kind: "exec", command: "/usr/bin/open", args: ["-a", "/Applications/Preview.app", "/Folder/after.txt"] }]);
  assert.deepEqual(result, { opened: true, canceled: false, appName: "Preview" });
});

test("Open with never launches after its Folder or file disappears during selection", async () => {
  let available = true;
  let launched = false;
  await assert.rejects(openFileWithPickedApp("darwin", {
    resolveFile: async () => { if (!available) throw new Error("Folder is no longer registered."); return "/Folder/file.txt"; },
    pickApp: async () => { available = false; return "/Applications/Preview.app"; },
    launch: async () => { launched = true; },
  }), /no longer registered/);
  assert.equal(launched, false);
});

test("canceling Open with does not launch an app", async () => {
  let launched = false;
  assert.deepEqual(await openFileWithPickedApp("darwin", {
    resolveFile: async () => "/Folder/file.txt",
    pickApp: async () => null,
    launch: async () => { launched = true; },
  }), { opened: false, canceled: true, appName: null });
  assert.equal(launched, false);
});

test("Open with rejects unavailable files before asking for an app", async () => {
  let picked = false;
  await assert.rejects(openFileWithPickedApp("darwin", {
    resolveFile: async () => { throw new Error("File not found."); },
    pickApp: async () => { picked = true; return null; },
    launch: async () => { assert.fail("Unavailable files cannot launch."); },
  }), /File not found/);
  assert.equal(picked, false);
});

test("Open with reports the chosen app when its launch fails", async () => {
  await assert.rejects(openFileWithPickedApp("darwin", {
    resolveFile: async () => "/Folder/file.txt",
    pickApp: async () => "/Applications/Preview.app",
    launch: async () => { throw new Error("OS error including private paths."); },
  }), { message: "Couldn't open with Preview." });
});
