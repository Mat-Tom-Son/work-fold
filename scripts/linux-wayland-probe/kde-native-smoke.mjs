/** Real shipped transport and helper, on the owned KDE seat only. No provider. */
import assert from "node:assert/strict";
import childProcess, { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { NativeWaylandTransport } from "../../src/local/agent/wayland-transport.ts";

assert.equal(process.env.WORKFOLD_ISOLATED_KDE_TEST, "1");
const run = promisify(execFile);
const ui = command => run("python3", ["/work/scripts/linux-wayland-probe/kde-portal-test-ui.py", command], { timeout: 20_000 });
await ui("desktop-ready"); // Includes the private-session and OpenGL guards.
const root = "/tmp/workfold-input-fixture";
assert.equal(existsSync(root), false, "Use a fresh private KDE fixture");
// Retain only this fixture's native diagnostics. The production transport still
// drains stderr without copying desktop data into the application's logs.
const binary = "/work/out/included-tools/wayland-helper/work-fold-wayland";
const originalSpawn = childProcess.spawn;
let helperSequence = 0;
childProcess.spawn = function (file, args, options) {
  const child = originalSpawn(file, args, options);
  if (file === binary) {
    const log = `${root}/helper-${++helperSequence}.log`;
    let bytes = 0;
    child.stderr.on("data", chunk => { if (bytes < 64 * 1024) appendFileSync(log, chunk.subarray(0, 64 * 1024 - bytes)); bytes += chunk.length; });
    child.once("exit", (code, signal) => appendFileSync(log, `\nExit ${code}, signal ${signal}\n`));
  }
  return child;
};
syncBuiltinESMExports();
const scale = Number(process.env.WORKFOLD_KDE_TEST_SCALE || "1");
assert.ok([1, 1.25, 1.5, 2].includes(scale));
const helpers = [];
const launch = async () => {
  const helper = await NativeWaylandTransport.launch(binary);
  helpers.push(helper); return helper;
};
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < end, "Private KDE condition did not settle"); await delay(25); }
}
const fixture = spawn("python3", ["/work/scripts/linux-wayland-probe/input-fixture.py"], { stdio: "inherit" });
const events = async () => JSON.parse(await readFile(`${root}/events.json`, "utf8"));
try {
  await until(async () => existsSync(`${root}/events.json`) && (await events()).mapped);
  // Stop while the real chooser is pending, then start a distinct helper.
  let helper = await launch();
  let result = assert.rejects(helper.call("start"), /Desktop sharing ended/);
  await ui("wait"); await helper.close(); await result; await ui("closed");
  console.log("PASS KDE pending chooser Stop closes the native grant");
  helper = await launch();
  result = assert.rejects(helper.call("start"));
  await ui("cancel"); await result; await helper.close(); await ui("closed");
  console.log("PASS KDE native Deny refuses sharing");
  helper = await launch();
  const starting = helper.call("start");
  if (process.env.WORKFOLD_KDE_TEST_OUTPUTS === "2") {
    const refused = assert.rejects(starting, /KDE screen sharing currently requires one connected monitor/);
    await ui("choose-input"); await refused; await helper.close(); await ui("closed");
    assert.equal((await events()).clicks, 0);
    assert.equal(existsSync(`${root}/saved.txt`), false);
    console.log("PASS KDE two-monitor grant rejected before any frame or input is published");
  } else {
    const [status] = await Promise.all([starting, ui("choose-input")]);
    assert.equal(status.devicesGranted, 3); await ui("closed");
    const { lease } = await helper.call("begin", { turn: randomUUID() });
    const observation = await helper.call("observe", { lease });
    const png = Buffer.from(observation.image.data, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280 * scale, 800 * scale]);
    assert.equal(observation.inputAvailable, true);
    await writeFile(`${root}/kde-capture.png`, png);
    const expected = "KDE portal input verified.";
    const actions = [
      // Coordinates are pixels in the observed image. This GTK fixture stays
      // at these pixel bounds on KWin's virtual outputs, even when the output
      // has a fractional scale; the production mapper owns conversion to EIS.
      { action: "click", x: 500, y: 160 },
      { action: "typeText", text: expected },
      { action: "scroll", x: 500, y: 160, scrollX: 0, scrollY: 120 },
      { action: "keypress", keys: ["Ctrl", "s"] },
    ];
    const completed = await helper.call("act", { lease, observation: observation.observationId, actions });
    assert.equal(completed.inputSent, true);
    await until(async () => existsSync(`${root}/saved.txt`) && await readFile(`${root}/saved.txt`, "utf8") === expected);
    await assert.rejects(helper.call("act", { lease, observation: observation.observationId, actions: [actions[0]] }), /stale/);
    const state = await events();
    assert.equal(state.clicks, 1); assert.equal(state.buttonReleases, 1); assert.ok(state.scrolls >= 1);
    assert.deepEqual(state.presses.toSorted(), state.releases.toSorted());
    console.log(`PASS KDE ${scale * 100}% capture, mapped input, exact saved bytes, paired keys and stale-input refusal`);
    await helper.close();
    await assert.rejects(helper.call("status"), /Desktop sharing ended/);
    // A closed owner cannot reuse its grant. A new helper needs native approval.
    helper = await launch();
    console.log("Checking KDE fresh approval after owner teardown");
    await Promise.all([helper.call("start"), ui("choose-input")]);
    const fresh = await helper.call("begin", { turn: randomUUID() });
    assert.notEqual(fresh.lease, lease);
    assert.equal((await helper.call("observe", { lease: fresh.lease })).inputAvailable, true);
    let closed = false;
    helper.onClose(() => { closed = true; });
    console.log("Checking KDE native lock revocation");
    await run("gdbus", ["call", "--session", "--dest", "org.freedesktop.ScreenSaver", "--object-path", "/ScreenSaver", "--method", "org.freedesktop.ScreenSaver.Lock"], { timeout: 15_000 });
    await until(async () => closed);
    await assert.rejects(helper.call("observe", { lease: fresh.lease }), /Desktop sharing ended/);
    assert.equal(await readFile(`${root}/saved.txt`, "utf8"), expected);
    helper = await launch();
    console.log("Checking refusal to share the locked KDE desktop");
    await assert.rejects(helper.call("start"), /Desktop screen-lock monitoring is unavailable/);
    console.log("PASS KDE owner teardown, fresh grant, real screen-lock revocation and refusal while locked");
  }
} finally {
  await Promise.all(helpers.map(helper => helper.close()));
  fixture.kill("SIGTERM");
  await new Promise(resolve => { if (fixture.exitCode !== null || fixture.signalCode !== null) resolve(); else fixture.once("exit", resolve); });
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
}
