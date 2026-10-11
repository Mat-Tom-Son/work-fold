# App platform runtime spike evidence

> **Status:** Recorded disposable evidence for Gate 4
>
> **Date:** 2026-07-15
>
> **Method:** Synthetic in-memory Node experiments run through standard input.
> They used no product or personal data, created no repository or temporary
> files, made no persistence/API promise, and left no code to merge or ship.

The experiments tested the failure modes that paper designs most often hide:
stale distributed workers, wall-clock and cadence ambiguity, and revocation of a
disconnected local runtime. All three support the accepted broker contract, with
the limitations below remaining explicit product constraints.

## Lease and fencing race

The model used one authoritative effect broker holding the current complete
`AuthorityStamp`, lease, durable fencing high-water mark, and idempotency/effect
ledger. Worker A acquired fence 1. The test then advanced the Feature
Installation and grant generations, expired A's lease, and let worker B acquire
fence 2 before resuming A.

Observed results:

- A was rejected as `LEASE_STALE` for storage, object, network, connection, and
  notification effects;
- B committed one effect in each class;
- B presenting A's prior `AuthorityStamp` was rejected as `AUTHORITY_STALE`;
- retrying the same effect identity returned the recorded result without a
  second commit;
- preserving the fence high-water mark across a simulated restart kept A stale;
- restoring product data without rolling back authority/fence metadata did not
  resurrect A; and
- receipts kept occurrence, run, and attempt lineage throughout reassignment.

This works without exactly-once delivery or a global clock only if every
privileged endpoint performs an atomic authoritative compare-and-commit, fence
high-water state is durable and is not restored from an older product-data
backup, and cooperating external providers receive stable idempotency keys.

An external effect accepted before revocation cannot be recalled. If a provider
does not support idempotency, a crash after provider acceptance but before the
local completion receipt can still produce a duplicate. Product copy and retry
policy must say so.

## Cadence, clocks, and catch-up

The model derived interval occurrence ids from `anchor + ordinal * interval`,
stored a durable last-handled ordinal, and kept scheduling wall time separate
from lease/authority time.

Observed results for a 30-minute cadence:

- at 03:20, catch-up `none` advanced past missed occurrences without dispatch,
  while `latest` emitted only ordinal 6 scheduled for 03:00;
- moving the wall clock backward to 02:00 and then forward to 03:00 emitted no
  duplicate;
- 03:30 emitted the first new ordinal, 7;
- a manual run left recurring cadence state unchanged; and
- scheduled, accepted, started, and finished receipt times stayed distinct.

For `America/New_York`, local 02:30 during the 2026 spring-forward gap had no
match and followed the declared skip policy. Local 01:30 during the 2026
fall-back overlap had two matches one hour apart and followed the declared
first-match policy.

The contract therefore requires an explicit timezone, daylight-saving gap and
overlap policy, and time-zone database version. A single scheduler authority or
fenced compare-and-swap high-water store is enough; synchronized client clocks
and exactly-once delivery are not. Distributed lease expiry still needs one
authoritative time/store domain.

## Offline authority expiry and replay

The model used a synthetic signed lease binding Tenant, Runtime Instance,
Feature Installation, Release and declaration digests, the complete
`AuthorityStamp`, allowed powers, issuance evidence, a five-second elapsed-time
limit, host boot identity, and the trusted monotonic receipt time. It never used
the local wall clock to extend authority.

Observed results:

- at four seconds elapsed, wall clocks set to 1999, 2026, or 2099 all produced
  the same allowed result;
- a remote revocation while disconnected remained usable only inside the stated
  bound, including at 4.5 seconds;
- at 5.1 seconds, new privileged work failed as `AUTHORITY_EXPIRED`;
- a new or recovered boot identity failed closed as
  `AUTHORITY_EXPIRED_RESTART` rather than reconstructing elapsed authority;
- reconnect reauthorized queued work and a stale connection refresh against
  current server policy, denying both as `LAUNCH_BLOCKED`; and
- the reconnect receipt captured the authority-generation transition.

Offline authority can be safe without a global clock when the host provides a
trusted monotonic clock and boot identity and the server keeps durable policy
generations. If those inputs are unavailable after restart, the runtime must
fail closed and reconnect. Instant remote revocation while disconnected remains
impossible: the maximum lease duration is the explicit revocation-latency bound,
and every queued effect must reauthorize and deduplicate before replay.

## Contract consequences

The evidence keeps the accepted Gate 4 rules intact and makes four
implementation requirements non-negotiable:

1. authoritative brokers, not workers, own compare-and-commit fencing;
2. authority/fence metadata cannot roll back with ordinary product-data restore;
3. schedule identity comes from a durable anchor and ordinal plus explicit
   timezone/DST policy, never “whatever the timer fires”; and
4. offline leases use trusted elapsed time, bind the full authority context, fail
   closed across uncertain restart, and make their revocation-latency bound
   visible.
