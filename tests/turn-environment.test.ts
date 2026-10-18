import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { buildWorkFolderTurnContext } from "../src/local/agent/work-folder-turn-context.js";
import { currentTurnEnvironment, describeTurnEnvironment } from "../src/local/agent/turn-environment.js";

/**
 * Every turn context names the host's local time with its UTC offset, its
 * IANA time zone, and its platform, so a Worker or the work-fold agent can
 * resolve "tomorrow at 9" into the absolute time `chat snooze --until` and
 * `at` Automations take.
 */
const now = new Date("2026-10-18T19:41:05Z");

test("the environment line gives weekday, ISO local time with offset, time zone, and platform", () => {
  assert.equal(
    describeTurnEnvironment({ now, timeZone: "America/Los_Angeles", platform: "darwin" }),
    "Host environment at the start of this turn (host-owned): local time Sunday 2026-10-18T12:41:05-07:00, time zone America/Los_Angeles, platform macOS (darwin). Resolve relative dates and times from this.",
  );
  // Midnight rolls the date and weekday forward; half-hour offsets keep their minutes.
  assert.match(describeTurnEnvironment({ now, timeZone: "Asia/Kolkata", platform: "win32" }),
    /local time Monday 2026-10-19T01:11:05\+05:30, time zone Asia\/Kolkata, platform Windows \(win32\)\./);
  assert.match(describeTurnEnvironment({ now, timeZone: "UTC", platform: "linux" }),
    /local time Sunday 2026-10-18T19:41:05\+00:00, time zone UTC, platform Linux \(linux\)\./);
  assert.match(describeTurnEnvironment({ now, timeZone: "Europe/Berlin", platform: "freebsd" }),
    /2026-10-18T21:41:05\+02:00, time zone Europe\/Berlin, platform freebsd\./);

  // The printed time is one the CLI's ISO checks accept and points at the same instant.
  const printed = /local time \S+ (\S+),/.exec(describeTurnEnvironment({ now, timeZone: "Asia/Kolkata", platform: "darwin" }))![1]!;
  assert.equal(Date.parse(printed), now.getTime());
});

test("the host reads its own clock, zone, and platform", () => {
  const before = Date.now();
  const environment = currentTurnEnvironment();
  assert.ok(environment.now.getTime() >= before && environment.now.getTime() <= Date.now());
  assert.equal(environment.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(environment.platform, process.platform);
});

test("Worker and work-fold agent turn contexts lead with the environment line", () => {
  const environment = { now, timeZone: "America/Los_Angeles", platform: "darwin" as const };
  const line = describeTurnEnvironment(environment);
  const worker = buildTurnContextMessage({
    environment,
    workFolderTurn: buildWorkFolderTurnContext({ workFolderId: "work-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }),
  });
  assert.ok(worker.startsWith(`${line}\nThis turn's work-fold identity`));
  const agent = buildTurnContextMessage({ environment, workFoldAgentTaskId: "agent-task-1", workFoldAgentWorkFolders: [] });
  assert.ok(agent.startsWith(`${line}\nCurrent work-fold profile snapshot`));
  assert.equal(buildTurnContextMessage({ environment }), line, "even a turn with nothing else to say carries it");
  assert.doesNotMatch(buildTurnContextMessage({ workFoldAgentTaskId: "agent-task-1" }), /Host environment/,
    "only the turn being started supplies it; per-attachment measurements stay unchanged");
});
