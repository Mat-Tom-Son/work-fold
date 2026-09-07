// Browser refresh policy. Clock and effects are injected so tests exercise the
// actual timer loop without real waits, a relay, or assertions over source text.
export function deferAfterRateLimit(state, now = Date.now()) {
  state.rateLimitedUntil = now + 15_000;
}

export function canResume(state, now = Date.now()) {
  return now - state.lastResumeAt >= 10_000 && now >= state.rateLimitedUntil;
}

export function canRecover(state, pending, now = Date.now()) {
  return Boolean(state.session?.desktopOnline)
    && now >= pending.nextRecoveryAt && now >= state.rateLimitedUntil;
}

export function pollDelay(attempt, streamHealthy) {
  return attempt < 5 ? 1_000 : streamHealthy ? 3_000 : 2_000;
}

export function scheduleBrowserRefresh(state, effects, clock = globalThis) {
  if (state.refreshTimer !== null) clock.clearTimeout(state.refreshTimer);
  if (!state.session || state.sessionRebooting) return;
  const phase = state.summary?.latestRequest?.phase;
  const active = state.summary?.state === "running" || phase === "working" || phase === "handed_off";
  const session = state.session;
  const schedule = () => scheduleBrowserRefresh(state, effects, clock);
  state.refreshTimer = clock.setTimeout(async () => {
    state.refreshTimer = null;
    if (state.session !== session || state.sessionRebooting) return;
    if (clock.Date.now() < state.rateLimitedUntil || !session.desktopOnline) return schedule();
    state.refreshTick += 1;
    // Chats every tick; the two-operation home digest less often. Never start
    // another chat refresh while the previous one is still settling.
    if (state.refreshTick % (active ? 3 : 2) === 0) {
      void Promise.resolve().then(effects.refreshHome).catch(effects.onError);
    }
    try { await effects.refreshChats(); }
    catch (error) { effects.onError(error); }
    finally {
      // A revoked session may finish a request after its timer was cleared.
      if (state.session === session && !state.sessionRebooting) schedule();
    }
  }, active ? 5_000 : 10_000);
}
