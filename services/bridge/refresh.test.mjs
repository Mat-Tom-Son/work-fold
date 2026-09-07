import assert from "node:assert/strict";
import test from "node:test";
import { scheduleBrowserRefresh, deferAfterRateLimit, canResume, canRecover, pollDelay } from "./public/refresh.js";

function fixture(active = false) {
  let time = 100_000, id = 0;
  const timers = new Map();
  const clock = {
    Date: { now: () => time },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
  };
  const state = { session: { desktopOnline: true }, summary: { state: active ? "running" : "idle" }, refreshTimer: null, refreshTick: 0, rateLimitedUntil: 0, lastResumeAt: 0 };
  const calls = { chats: 0, home: 0, errors: [] };
  const effects = { refreshChats: async () => { calls.chats++; }, refreshHome: async () => { calls.home++; }, onError: (e) => calls.errors.push(e) };
  async function advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at;
      timers.delete(next[0]);
      await next[1].fn();
    }
    time = end;
  }
  return { state, calls, effects, clock, timers, advance, start: () => scheduleBrowserRefresh(state, effects, clock) };
}

for (const active of [false, true]) {
  test(`refresh loop stays within the operation budget while ${active ? "working" : "idle"}`, async () => {
    const f = fixture(active);
    f.start();
    await f.advance(60_000);
    assert.equal(f.calls.chats, active ? 12 : 6);
    assert.equal(f.calls.home, active ? 4 : 3);
    // A chat tick can list conversations and read a transcript; home uses two
    // operations. Leave room under the relay's 60/minute budget for the person.
    assert.ok(2 * (f.calls.chats + f.calls.home) < 40);
    assert.equal(f.timers.size, 1);
  });
}

test("offline and 429 cooldown send nothing, then recover without a burst", async () => {
  const f = fixture(true);
  f.state.session.desktopOnline = false;
  f.start();
  await f.advance(60_000);
  assert.equal(f.calls.chats + f.calls.home, 0);
  f.state.session.desktopOnline = true;
  deferAfterRateLimit(f.state, f.clock.Date.now());
  await f.advance(14_999);
  assert.equal(f.calls.chats + f.calls.home, 0);
  await f.advance(1);
  assert.equal(f.calls.chats, 1);
  assert.equal(f.calls.home, 0);
});

test("rescheduling owns one timer, errors recover, and logout cannot resurrect polling", async () => {
  const f = fixture();
  f.start(); f.start(); f.start();
  assert.equal(f.timers.size, 1);
  f.effects.refreshChats = async () => { throw new Error("temporary"); };
  await f.advance(10_000);
  assert.equal(f.calls.errors.length, 1);
  assert.equal(f.timers.size, 1);
  f.effects.refreshChats = async () => { f.state.session = null; f.state.sessionRebooting = true; };
  await f.advance(10_000);
  assert.equal(f.timers.size, 0);
});

test("slow requests do not overlap and revocation during a request stops the loop", async () => {
  const f = fixture(true);
  let finish;
  f.effects.refreshChats = () => new Promise((resolve) => { finish = resolve; });
  f.start();
  const tick = f.advance(5_000);
  assert.equal(f.timers.size, 0);
  f.state.session = null;
  finish();
  await tick;
  assert.equal(f.timers.size, 0);
});

test("resume, recovery and status fallback respect cooldown and connection state", () => {
  const f = fixture();
  const now = f.clock.Date.now();
  assert.equal(canResume(f.state, now), true);
  f.state.lastResumeAt = now;
  assert.equal(canResume(f.state, now + 9_999), false);
  assert.equal(canResume(f.state, now + 10_000), true);
  const pending = { nextRecoveryAt: now + 5_000 };
  assert.equal(canRecover(f.state, pending, now), false);
  deferAfterRateLimit(f.state, now);
  assert.equal(canRecover(f.state, pending, now + 14_999), false);
  assert.equal(canResume(f.state, now + 14_999), false);
  assert.equal(canRecover(f.state, pending, now + 15_000), true);
  f.state.session.desktopOnline = false;
  assert.equal(canRecover(f.state, pending, now + 20_000), false);
  assert.equal(pollDelay(0, true), 1_000);
  assert.equal(pollDelay(4, false), 1_000);
  assert.equal(pollDelay(5, false), 2_000);
  assert.equal(pollDelay(5, true), 3_000);
});
