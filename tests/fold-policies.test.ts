import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { WorkFoldCliActReceiptV2 } from "../src/local/cli/act-receipts.js";
import {
  FoldDecisionService,
  type FoldDecisionExecutionEffect,
  type FoldDecisionFenceScope,
  type FoldStagedActKindAdapter,
} from "../src/local/fold-decisions.js";
import {
  attestationDigest,
  FOLD_POLICY_CAP,
  FOLD_POLICY_ELIGIBLE_KINDS,
  FOLD_POLICY_FIRST_PARTY_REGISTRIES,
  FOLD_POLICY_INELIGIBLE_KINDS,
  FoldPolicyError,
  FoldStandingPolicyStore,
  mintFoldPolicySettingsWriter,
  type FoldPolicyChangeRecordV1,
  type FoldPolicyCreateInput,
  type FoldPolicyEligibleKind,
  type FoldPolicyErrorCode,
  type FoldPolicyMatch,
  type FoldPolicySettingsWriter,
  type FoldStandingPolicy,
} from "../src/local/fold-policies.js";
import {
  FOLD_STAGED_ACT_KINDS,
  foldStagedActCategory,
  FoldStagedActStore,
  type FoldStagedAct,
  type FoldStagedActInput,
  type FoldStagedActProvenance,
} from "../src/local/fold-staged-acts.js";
import type {
  WorkFoldExperimentalFoldDecisionTask,
  WorkFoldExperimentalFoldDecisionTaskInput,
} from "../src/local/work-fold-kernel.js";

function tickingClock(startIso = "2026-08-10T10:00:00.000Z", stepMs = 1000): { now: () => Date } {
  let at = Date.parse(startIso);
  return { now: () => new Date((at += stepMs)) };
}

function isRefusal(code: FoldPolicyErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof FoldPolicyError && error.code === code;
}

interface PolicyHarness {
  sandbox: string;
  path: string;
  journalPath: string;
  store: FoldStandingPolicyStore;
  writer: FoldPolicySettingsWriter;
  reopen(): Promise<FoldStandingPolicyStore>;
}

async function policyHarness(prefix: string, options: { now?: () => Date } = {}): Promise<PolicyHarness> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-policies-${prefix}-`));
  const path = join(sandbox, "fold", "policies.json");
  const journalPath = join(sandbox, "fold", "policy-changes.jsonl");
  const storeOptions = { path, journalPath, ...(options.now ? { now: options.now } : {}) };
  const reopen = () => FoldStandingPolicyStore.create(storeOptions);
  return { sandbox, path, journalPath, store: await reopen(), writer: mintFoldPolicySettingsWriter(), reopen };
}

async function readJournal(journalPath: string): Promise<FoldPolicyChangeRecordV1[]> {
  const text = await readFile(journalPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FoldPolicyChangeRecordV1);
}

function grantPolicyInput(overrides: Partial<FoldPolicyCreateInput> = {}): FoldPolicyCreateInput {
  return {
    label: "Mail app network grants",
    kind: "app.grant.network",
    match: { appInstanceId: "app-mail" },
    ...overrides,
  };
}

function provenance(requestId: string): FoldStagedActProvenance {
  return {
    stagedVia: "management-conversation",
    conversationId: "manage-chat-1",
    parentTaskId: "task-1",
    requestId,
  };
}

function grantActInput(overrides: { declarationId?: string; requestId?: string } = {}): FoldStagedActInput {
  const declarationId = overrides.declarationId ?? "net-api.example.com";
  return {
    kind: "app.grant.network",
    parameters: { spaceId: "space-alpha", appInstanceId: "app-mail", declarationId },
    pins: { appInstanceId: "app-mail", declarationId, releaseDigest: "d".repeat(64) },
    provenance: provenance(overrides.requestId ?? `req-grant-${declarationId}`),
  };
}

function skillImportActInput(overrides: { source?: string; contentDigest?: string } = {}): FoldStagedActInput {
  const source = overrides.source ?? "official:anthropics/skills";
  const contentDigest = overrides.contentDigest ?? "a".repeat(64);
  return {
    kind: "capability.skills.import",
    parameters: { source, scope: "personal" },
    pins: { source, contentDigest, skillNames: ["pdf"] },
    provenance: provenance(`req-skill-${contentDigest.slice(0, 8)}-${source}`),
  };
}

function filesDestroyActInput(): FoldStagedActInput {
  return {
    kind: "files.destroy",
    parameters: { spaceId: "space-alpha", paths: ["notes/old.md"] },
    pins: { spaceId: "space-alpha", paths: ["notes/old.md"], contentIdentities: ["b".repeat(64)] },
    provenance: provenance("req-destroy-1"),
  };
}

function craftedPolicy(overrides: Partial<FoldStandingPolicy> & { id: string }): FoldStandingPolicy {
  return {
    schemaVersion: 1,
    label: "Crafted policy",
    category: "widen-power",
    kind: "app.grant.network",
    match: { appInstanceId: "app-mail" },
    effect: "auto-approve",
    enabled: true,
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

async function writeSealed(path: string, policies: FoldStandingPolicy[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, attestation: attestationDigest(policies), policies }, null, 2)}\n`,
    "utf8",
  );
}

test("settings-only authoring: every mutation demands the minted writer, and a forged marker is refused", async () => {
  const harness = await policyHarness("writer");
  try {
    const forged = { lane: "desktop-settings" } as FoldPolicySettingsWriter;
    const attempts: Array<[string, (writer: FoldPolicySettingsWriter) => Promise<unknown>]> = [
      ["createPolicy", (writer) => harness.store.createPolicy(writer, grantPolicyInput())],
      ["updatePolicy", (writer) => harness.store.updatePolicy(writer, "any", { label: "x" })],
      ["setPolicyEnabled", (writer) => harness.store.setPolicyEnabled(writer, "any", false)],
      ["removePolicy", (writer) => harness.store.removePolicy(writer, "any")],
      ["reattest", (writer) => harness.store.reattest(writer)],
    ];
    for (const [name, attempt] of attempts) {
      await assert.rejects(attempt(forged), isRefusal("SETTINGS_ONLY"), `${name} must refuse a forged writer`);
      await assert.rejects(
        attempt(undefined as unknown as FoldPolicySettingsWriter),
        isRefusal("SETTINGS_ONLY"),
        `${name} must refuse a missing writer`,
      );
    }
    assert.equal((await harness.store.list()).length, 0, "no forged mutation may land");

    const created = await harness.store.createPolicy(harness.writer, grantPolicyInput());
    assert.equal(created.label, "Mail app network grants");

    // Reading and evaluating are not writing: the fold may cite policies.
    assert.equal((await harness.store.list()).length, 1);
    const staged = await FoldStagedActStore.create({ path: join(harness.sandbox, "staged-acts.json") });
    const { act } = await staged.stage(grantActInput());
    const evaluation = await harness.store.evaluate(act);
    assert.equal(evaluation.matched, true);
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("policy records validate closed input, journal every change, and persist attested across reopen", async () => {
  const harness = await policyHarness("records", { now: tickingClock().now });
  try {
    const grant = await harness.store.createPolicy(harness.writer, grantPolicyInput());
    assert.equal(grant.schemaVersion, 1);
    assert.equal(grant.category, "widen-power", "the store, not the caller, derives the category");
    assert.equal(grant.effect, "auto-approve");
    assert.equal(grant.enabled, true, "a created policy defaults to enabled");
    assert.equal(grant.createdAt, grant.updatedAt);

    const skills = await harness.store.createPolicy(harness.writer, {
      label: "Reviewed helper bundle",
      kind: "capability.skills.import",
      match: { contentDigest: "a".repeat(64) },
      enabled: false,
    });
    assert.equal(skills.category, "make-runnable");
    assert.equal(skills.enabled, false);

    const invalidInputs: Array<[string, FoldPolicyCreateInput, FoldPolicyErrorCode]> = [
      ["empty label", grantPolicyInput({ label: "  " }), "INPUT_INVALID"],
      ["oversized label", grantPolicyInput({ label: "x".repeat(121) }), "INPUT_INVALID"],
      ["control characters in label", grantPolicyInput({ label: "evil\u0000name" }), "INPUT_INVALID"],
      [
        "unknown input field",
        { ...grantPolicyInput(), note: "please" } as unknown as FoldPolicyCreateInput,
        "INPUT_INVALID",
      ],
      ["unknown matcher field", grantPolicyInput({ match: { appInstanceId: "app-mail", pattern: "*" } }), "INPUT_INVALID"],
      ["missing required anchor", grantPolicyInput({ match: {} }), "INPUT_INVALID"],
      ["non-string matcher value", grantPolicyInput({ match: { appInstanceId: 7 as unknown as string } }), "INPUT_INVALID"],
      ["non-boolean enabled", grantPolicyInput({ enabled: "yes" as unknown as boolean }), "INPUT_INVALID"],
      [
        "matcher enum violation",
        {
          label: "Bad scope",
          kind: "capability.skills.import",
          match: { contentDigest: "a".repeat(64), scope: "everywhere" },
        },
        "INPUT_INVALID",
      ],
    ];
    for (const [name, input, code] of invalidInputs) {
      await assert.rejects(harness.store.createPolicy(harness.writer, input), isRefusal(code), name);
    }

    await assert.rejects(
      harness.store.updatePolicy(harness.writer, grant.id, {} as { label: string }),
      isRefusal("INPUT_INVALID"),
      "an empty patch names nothing to change",
    );
    await assert.rejects(
      harness.store.updatePolicy(harness.writer, grant.id, { kind: "app.grant.files" } as unknown as { label: string }),
      isRefusal("INPUT_INVALID"),
      "a policy's kind never changes",
    );
    await assert.rejects(
      harness.store.updatePolicy(harness.writer, "missing", { label: "x" }),
      isRefusal("NOT_FOUND"),
    );
    await assert.rejects(
      harness.store.setPolicyEnabled(harness.writer, grant.id, "on" as unknown as boolean),
      isRefusal("INPUT_INVALID"),
    );

    const disabled = await harness.store.setPolicyEnabled(harness.writer, grant.id, false);
    assert.equal(disabled.enabled, false);
    const journalAfterDisable = await readJournal(harness.journalPath);
    const repeat = await harness.store.setPolicyEnabled(harness.writer, grant.id, false);
    assert.equal(repeat.enabled, false);
    assert.equal(
      (await readJournal(harness.journalPath)).length,
      journalAfterDisable.length,
      "a no-op toggle journals nothing",
    );
    await harness.store.setPolicyEnabled(harness.writer, grant.id, true);

    const updated = await harness.store.updatePolicy(harness.writer, grant.id, {
      label: "Mail app grants, narrowed",
      match: { appInstanceId: "app-mail", declarationId: "net-api.example.com" },
    });
    assert.equal(updated.label, "Mail app grants, narrowed");
    assert.ok(updated.updatedAt > updated.createdAt, "editing bumps updatedAt only");

    const removed = await harness.store.removePolicy(harness.writer, skills.id);
    assert.equal(removed.id, skills.id);
    await assert.rejects(harness.store.removePolicy(harness.writer, skills.id), isRefusal("NOT_FOUND"));

    const journal = await readJournal(harness.journalPath);
    assert.deepEqual(
      journal.map((record) => record.event),
      ["created", "created", "disabled", "enabled", "updated", "deleted"],
    );
    for (const record of journal) {
      assert.equal(record.v, 1);
      assert.ok(record.policyId, "every authoring line names its policy");
      assert.ok(record.label && record.kind && record.category && record.match, "lines carry the typed record");
      assert.equal(typeof record.enabled, "boolean");
      assert.match(record.attestation, /^[0-9a-f]{64}$/, "every write records a fresh attestation digest");
    }
    const fileShape = JSON.parse(await readFile(harness.path, "utf8")) as { attestation: string };
    assert.equal(fileShape.attestation, journal.at(-1)?.attestation, "the store file carries the last journaled digest");

    const reopened = await harness.reopen();
    const listed = await reopened.list();
    assert.deepEqual(listed.map((policy) => policy.id), [grant.id]);
    assert.deepEqual(reopened.status(), { damaged: false, attested: true, policyCount: 1, enabledCount: 1 });
    assert.equal(await reopened.get(grant.id).then((policy) => policy?.label), "Mail app grants, narrowed");
    assert.equal(await reopened.get("missing"), undefined);
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("ineligible kinds are refused at write, and the classification is total over the staged-act vocabulary", async () => {
  const harness = await policyHarness("ineligible");
  try {
    for (const kind of FOLD_POLICY_INELIGIBLE_KINDS) {
      await assert.rejects(
        harness.store.createPolicy(harness.writer, {
          label: "Never",
          kind: kind as unknown as FoldPolicyEligibleKind,
          match: {},
        }),
        isRefusal("KIND_INELIGIBLE"),
        `${kind} must never carry a standing policy`,
      );
    }
    await assert.rejects(
      harness.store.createPolicy(harness.writer, {
        label: "Never",
        kind: "fold.hack" as FoldPolicyEligibleKind,
        match: {},
      }),
      isRefusal("KIND_INELIGIBLE"),
      "unknown kinds fail closed",
    );
    assert.equal((await harness.store.list()).length, 0);

    // The classification is a partition of the closed staged-act kind set.
    const classified = new Set<string>([...FOLD_POLICY_ELIGIBLE_KINDS, ...FOLD_POLICY_INELIGIBLE_KINDS]);
    assert.equal(classified.size, FOLD_STAGED_ACT_KINDS.length, "every staged-act kind is classified exactly once");
    for (const kind of FOLD_STAGED_ACT_KINDS) assert.ok(classified.has(kind));
    for (const kind of FOLD_POLICY_ELIGIBLE_KINDS) {
      assert.ok(!(FOLD_POLICY_INELIGIBLE_KINDS as readonly string[]).includes(kind));
      assert.notEqual(foldStagedActCategory(kind), "destroy", "no destroy kind is ever eligible");
    }
    for (const kind of FOLD_STAGED_ACT_KINDS) {
      if (foldStagedActCategory(kind) === "destroy") {
        assert.ok((FOLD_POLICY_INELIGIBLE_KINDS as readonly string[]).includes(kind));
      }
    }
    assert.ok((FOLD_POLICY_INELIGIBLE_KINDS as readonly string[]).includes("publish.viewer.expose"));
    assert.ok((FOLD_POLICY_INELIGIBLE_KINDS as readonly string[]).includes("routing.enable"));
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("make-runnable matchers pin identity: open-registry matchers are refused at write", async () => {
  const harness = await policyHarness("registry");
  try {
    const cases: Array<[string, FoldPolicyEligibleKind, FoldPolicyMatch, FoldPolicyErrorCode | null]> = [
      ["open registry, package install", "capability.package.install", { source: "git:github.com/evil/registry" }, "OPEN_REGISTRY"],
      ["open registry, package update", "capability.package.update", { source: "git:github.com/evil/registry" }, "OPEN_REGISTRY"],
      ["per-item package identity", "capability.package.install", { source: "git:github.com/evil/registry", packageId: "pkg-x" }, null],
      ["curated registry, packages", "capability.package.install", { source: FOLD_POLICY_FIRST_PARTY_REGISTRIES[1] }, null],
      ["open registry, skills", "capability.skills.import", { source: "git:github.com/rando/skills" }, "OPEN_REGISTRY"],
      ["curated registry, skills", "capability.skills.import", { source: "official:anthropics/skills" }, null],
      ["per-item skill digest", "capability.skills.import", { contentDigest: "c".repeat(64) }, null],
      ["no anchor at all", "capability.skills.import", {}, "INPUT_INVALID"],
      ["scope-only matcher", "capability.skills.import", { scope: "personal" }, "INPUT_INVALID"],
      [
        "personal scope contradiction",
        "capability.skills.import",
        { contentDigest: "c".repeat(64), scope: "personal", spaceId: "space-alpha" },
        "INPUT_INVALID",
      ],
      ["review approvals are per-item by construction", "app.review.approve", { reviewDigest: "e".repeat(64) }, null],
      ["review approvals require the digest", "app.review.approve", { spaceId: "space-alpha" }, "INPUT_INVALID"],
    ];
    for (const [name, kind, match, expected] of cases) {
      const attempt = harness.store.createPolicy(harness.writer, { label: name.slice(0, 60), kind, match });
      if (expected === null) {
        const created = await attempt;
        await harness.store.removePolicy(harness.writer, created.id);
      } else {
        await assert.rejects(attempt, isRefusal(expected), name);
      }
    }

    // Editing cannot widen either: an update to an open-registry matcher is refused.
    const curated = await harness.store.createPolicy(harness.writer, {
      label: "Anthropic marketplace skills",
      kind: "capability.skills.import",
      match: { source: "official:anthropics/skills" },
    });
    await assert.rejects(
      harness.store.updatePolicy(harness.writer, curated.id, { match: { source: "git:github.com/evil/skills" } }),
      isRefusal("OPEN_REGISTRY"),
    );
    assert.deepEqual((await harness.store.get(curated.id))?.match, { source: "official:anthropics/skills" });
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("matcher evaluation is host-side, typed, exact, and deterministic", async () => {
  const harness = await policyHarness("evaluate", { now: tickingClock().now });
  const staged = await FoldStagedActStore.create({ path: join(harness.sandbox, "staged-acts.json") });
  try {
    const { act: grantAct } = await staged.stage(grantActInput());

    const wrongApp = await harness.store.createPolicy(harness.writer, {
      label: "Other app",
      kind: "app.grant.network",
      match: { appInstanceId: "app-other" },
    });
    const wrongDeclaration = await harness.store.createPolicy(harness.writer, {
      label: "Other destination",
      kind: "app.grant.network",
      match: { appInstanceId: "app-mail", declarationId: "net-other.example.com" },
    });
    const disabledPolicy = await harness.store.createPolicy(harness.writer, {
      label: "Disabled match",
      kind: "app.grant.network",
      match: { appInstanceId: "app-mail" },
      enabled: false,
    });
    assert.equal((await harness.store.evaluate(grantAct)).matched, false, "narrower or disabled policies never match");

    const first = await harness.store.createPolicy(harness.writer, grantPolicyInput({ label: "First match" }));
    const second = await harness.store.createPolicy(harness.writer, grantPolicyInput({ label: "Second match" }));
    const evaluation = await harness.store.evaluate(grantAct);
    assert.equal(evaluation.matched, true);
    assert.ok(evaluation.matched);
    assert.equal(evaluation.policy.id, first.id, "the oldest enabled exact match wins, deterministically");
    assert.notEqual(evaluation.policy.id, second.id);
    assert.deepEqual(evaluation.decisionInput, { decision: "approved", surface: "policy", policyId: first.id });
    assert.equal(evaluation.labelSnapshot, "First match");
    void wrongApp;
    void wrongDeclaration;
    void disabledPolicy;

    // Make-runnable: a curated-registry policy matches any act pinned to that
    // source; a digest policy matches exactly one bundle.
    const registryPolicy = await harness.store.createPolicy(harness.writer, {
      label: "Anthropic marketplace skills",
      kind: "capability.skills.import",
      match: { source: "official:anthropics/skills" },
    });
    const { act: marketplaceAct } = await staged.stage(skillImportActInput({ contentDigest: "1".repeat(64) }));
    const { act: uploadAct } = await staged.stage(skillImportActInput({ source: "upload:helper.zip", contentDigest: "2".repeat(64) }));
    const marketplaceEvaluation = await harness.store.evaluate(marketplaceAct);
    assert.ok(marketplaceEvaluation.matched);
    assert.equal(marketplaceEvaluation.policy.id, registryPolicy.id);
    assert.equal((await harness.store.evaluate(uploadAct)).matched, false, "an unlisted source never rides a registry policy");

    const digestPolicy = await harness.store.createPolicy(harness.writer, {
      label: "One reviewed bundle",
      kind: "capability.skills.import",
      match: { contentDigest: "2".repeat(64) },
    });
    const uploadEvaluation = await harness.store.evaluate(uploadAct);
    assert.ok(uploadEvaluation.matched);
    assert.equal(uploadEvaluation.policy.id, digestPolicy.id);

    // Ineligible kinds never evaluate, and settled acts never re-match.
    const { act: destroyAct } = await staged.stage(filesDestroyActInput());
    assert.deepEqual(await harness.store.evaluate(destroyAct), { matched: false });
    const denied = await staged.decide(grantAct.id, { decision: "denied", surface: "popover" });
    assert.equal((await harness.store.evaluate(denied)).matched, false, "only a staged act can exercise a policy");
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("attestation fails closed: any out-of-band edit disables every policy until Settings re-saves", async () => {
  const harness = await policyHarness("attestation", { now: tickingClock().now });
  const staged = await FoldStagedActStore.create({ path: join(harness.sandbox, "staged-acts.json") });
  try {
    const policy = await harness.store.createPolicy(harness.writer, grantPolicyInput());
    const { act } = await staged.stage(grantActInput());
    assert.equal((await harness.store.evaluate(act)).matched, true);

    // A quiet edit that does not recompute the seal.
    const file = JSON.parse(await readFile(harness.path, "utf8")) as { attestation: string; policies: FoldStandingPolicy[] };
    file.policies[0]!.label = "Edited outside Settings";
    await writeFile(harness.path, JSON.stringify(file, null, 2), "utf8");

    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "unattested" });
    const status = harness.store.status();
    assert.equal(status.attested, false);
    assert.match(status.attestationIssue ?? "", /does not match its recorded attestation digest/);
    assert.equal(
      (await harness.store.list())[0]?.label,
      "Edited outside Settings",
      "the person reviews exactly what a re-save would bless",
    );
    const mismatches = (await readJournal(harness.journalPath)).filter((record) => record.event === "attestation-mismatch");
    assert.equal(mismatches.length, 1);
    assert.ok(mismatches[0]?.expectedAttestation, "the mismatch line names the last blessed digest");

    // Reopening observes the same edit without journaling it twice.
    const reopened = await harness.reopen();
    assert.equal(reopened.status().attested, false);
    assert.equal(
      (await readJournal(harness.journalPath)).filter((record) => record.event === "attestation-mismatch").length,
      1,
      "one out-of-band edit journals once, across restarts too",
    );

    // The explicit re-save blesses the reviewed records.
    await harness.store.reattest(harness.writer);
    assert.equal(harness.store.status().attested, true);
    assert.equal((await readJournal(harness.journalPath)).at(-1)?.event, "reattested");
    assert.equal((await harness.store.evaluate(act)).matched, true);

    // A rewrite that recomputes the seal is still caught while the app runs.
    const hostile = craftedPolicy({ id: "hostile-1", label: "Hostile standing approval" });
    await writeSealed(harness.path, [...(await harness.store.list()), hostile]);
    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "unattested" });
    assert.match(harness.store.status().attestationIssue ?? "", /rewritten outside Settings/);

    // Any Settings write is a re-save: deleting the hostile record re-attests the rest.
    await harness.store.removePolicy(harness.writer, hostile.id);
    assert.equal(harness.store.status().attested, true);
    assert.deepEqual((await harness.store.list()).map((entry) => entry.id), [policy.id]);
    const evaluation = await harness.store.evaluate(act);
    assert.ok(evaluation.matched);
    assert.equal(evaluation.policy.id, policy.id);

    // A vanished store file is an out-of-band edit too, and re-saving blesses the empty truth.
    await rm(harness.path, { force: true });
    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "unattested" });
    assert.equal((await readJournal(harness.journalPath)).at(-1)?.attestation, "absent");
    await harness.store.reattest(harness.writer);
    assert.equal(harness.store.status().attested, true);
    assert.deepEqual(await harness.store.list(), []);
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("a damaged store fails closed to clicks: no evaluation, no listing, no writes, nothing overwritten", async () => {
  const harness = await policyHarness("damaged", { now: tickingClock().now });
  const staged = await FoldStagedActStore.create({ path: join(harness.sandbox, "staged-acts.json") });
  try {
    await harness.store.createPolicy(harness.writer, grantPolicyInput());
    const { act } = await staged.stage(grantActInput());

    await writeFile(harness.path, "not json", "utf8");
    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "damaged" });
    const status = harness.store.status();
    assert.equal(status.damaged, true);
    assert.match(status.damageReason ?? "", /is not readable JSON/);
    await assert.rejects(harness.store.list(), isRefusal("STORE_DAMAGED"));
    await assert.rejects(harness.store.createPolicy(harness.writer, grantPolicyInput()), isRefusal("STORE_DAMAGED"));
    await assert.rejects(harness.store.reattest(harness.writer), isRefusal("STORE_DAMAGED"));
    assert.equal(await readFile(harness.path, "utf8"), "not json", "damaged authority state is never overwritten");

    // A correctly sealed file cannot smuggle an ineligible or malformed record.
    const smuggled = craftedPolicy({
      id: "smuggled-1",
      category: "widen-power",
      kind: "routing.enable" as unknown as FoldPolicyEligibleKind,
      match: {},
    });
    await writeSealed(harness.path, [smuggled]);
    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "damaged" });
    assert.match(harness.store.status().damageReason ?? "", /cannot carry a standing policy/);

    const duplicate = craftedPolicy({ id: "twin" });
    await writeSealed(harness.path, [duplicate, duplicate]);
    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "damaged" });
    assert.match(harness.store.status().damageReason ?? "", /duplicate policy id/);

    await writeFile(
      harness.path,
      JSON.stringify({ schemaVersion: 2, attestation: "f".repeat(64), policies: [] }),
      "utf8",
    );
    const reopened = await harness.reopen();
    assert.equal(reopened.status().damaged, true);
    assert.match(reopened.status().damageReason ?? "", /newer work-fold/);

    // Removing the damaged file outside the product recovers to unattested-until-resave.
    await rm(harness.path, { force: true });
    assert.deepEqual(await harness.store.evaluate(act), { matched: false, reason: "unattested" });
    await harness.store.reattest(harness.writer);
    assert.deepEqual(harness.store.status(), { damaged: false, attested: true, policyCount: 0, enabledCount: 0 });
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("an exercised policy rides the decision path: receipts carry surface policy and the policy id per receipts v2", async () => {
  const harness = await policyHarness("exercised", { now: tickingClock().now });
  const staged = await FoldStagedActStore.create({ path: join(harness.sandbox, "staged-acts.json") });
  try {
    type ReceiptEntry = Omit<WorkFoldCliActReceiptV2, "v" | "at">;
    const receipts = {
      entries: [] as ReceiptEntry[],
      async append(entry: ReceiptEntry): Promise<boolean> {
        receipts.entries.push(structuredClone(entry));
        return true;
      },
      async hasAccepted(requestId: string): Promise<boolean> {
        return receipts.entries.some((entry) => entry.requestId === requestId && entry.outcome === "accepted");
      },
    };
    const kernel = {
      finished: [] as string[],
      startExperimentalFoldDecisionTask(input: WorkFoldExperimentalFoldDecisionTaskInput): WorkFoldExperimentalFoldDecisionTask {
        return {
          id: "exec-1",
          kind: "fold_decision",
          status: "running",
          spaceId: input.spaceId ?? null,
          stagedActId: input.stagedActId,
          actor: input.actor,
          startedAt: "2026-08-10T10:00:00.000Z",
        };
      },
      finishTask(taskId: string): boolean {
        kernel.finished.push(taskId);
        return true;
      },
    };
    const fence = {
      probe: (_scope: FoldDecisionFenceScope): string | null => null,
      run: async <T>(_scope: FoldDecisionFenceScope, operation: () => Promise<T>): Promise<T> => await operation(),
    };
    const executed: FoldStagedAct[] = [];
    const adapter: FoldStagedActKindAdapter = {
      recheckPins: () => null,
      async execute(act): Promise<FoldDecisionExecutionEffect> {
        executed.push(act);
        return { detail: "Granted network destination." };
      },
    };
    const service = new FoldDecisionService({
      store: staged,
      receipts,
      kernel,
      fence,
      adapters: { "app.grant.network": adapter },
    });

    const policy = await harness.store.createPolicy(harness.writer, grantPolicyInput({ label: "Mail grants, pre-approved" }));
    const { act } = await staged.stage(grantActInput());

    // Host-side evaluation at admission; a match short-circuits into the same
    // decision path as a click.
    const evaluation = await harness.store.evaluate(act);
    assert.ok(evaluation.matched);
    assert.equal(evaluation.labelSnapshot, "Mail grants, pre-approved");
    const result = await service.decide(act.id, evaluation.decisionInput);

    assert.equal(result.act.state, "approved");
    assert.equal(result.act.decision?.surface, "policy");
    assert.equal(result.act.decision?.policyId, policy.id);
    assert.equal(result.act.execution?.outcome, "executed");
    assert.equal(executed.length, 1);

    const [accepted, terminal] = receipts.entries;
    assert.equal(receipts.entries.length, 2, "journal-first consumption, then the terminal receipt");
    assert.equal(accepted?.outcome, "accepted");
    assert.equal(accepted?.command, "decision.approve");
    assert.equal(accepted?.surface, "policy");
    assert.equal(accepted?.policyId, policy.id);
    assert.equal(accepted?.decisionId, act.id);
    assert.equal(accepted?.requestId, `fold-decision:${act.id}`);
    assert.equal(accepted?.spaceId, "space-alpha");
    assert.equal(terminal?.outcome, "ok");
    assert.equal(terminal?.surface, "policy");
    assert.equal(terminal?.policyId, policy.id);
    assert.equal(terminal?.decisionId, act.id);

    // One staged act exercises at most one decision: the settled act never re-matches.
    assert.equal((await harness.store.evaluate(result.act)).matched, false);
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});

test("journal-first authoring: an unwritable journal refuses the write, while mismatch observation stays best-effort", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-policies-journal-"));
  const path = join(sandbox, "fold", "policies.json");
  const journalPath = join(sandbox, "fold", "policy-changes.jsonl");
  try {
    // The journal path is a directory, so every append fails.
    await mkdir(journalPath, { recursive: true });
    const seeded = craftedPolicy({ id: "seeded-1" });
    await writeSealed(path, [seeded]);
    const store = await FoldStandingPolicyStore.create({ path, journalPath });
    const writer = mintFoldPolicySettingsWriter();
    assert.equal(store.status().attested, true, "a sealed store is trusted at open");

    await assert.rejects(
      store.createPolicy(writer, grantPolicyInput()),
      isRefusal("JOURNAL_UNAVAILABLE"),
      "a mutation that cannot journal changes nothing",
    );
    assert.deepEqual((await store.list()).map((policy) => policy.id), ["seeded-1"]);
    const file = JSON.parse(await readFile(path, "utf8")) as { policies: FoldStandingPolicy[] };
    assert.equal(file.policies.length, 1, "the store file is untouched by the refused write");

    // Observation journaling is best-effort: the disabled state never is.
    const edited = [craftedPolicy({ id: "seeded-1", label: "Edited outside Settings" })];
    await writeFile(path, JSON.stringify({ schemaVersion: 1, attestation: "0".repeat(64), policies: edited }), "utf8");
    const staged = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json") });
    const { act } = await staged.stage(grantActInput());
    assert.deepEqual(await store.evaluate(act), { matched: false, reason: "unattested" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the store is bounded: the policy cap refuses the sixty-fifth record", async () => {
  const harness = await policyHarness("cap", { now: tickingClock().now });
  try {
    for (let index = 0; index < FOLD_POLICY_CAP; index += 1) {
      await harness.store.createPolicy(harness.writer, {
        label: `Notify app ${index}`,
        kind: "app.grant.notifications",
        match: { appInstanceId: `app-${index}` },
      });
    }
    await assert.rejects(
      harness.store.createPolicy(harness.writer, {
        label: "One too many",
        kind: "app.grant.notifications",
        match: { appInstanceId: "app-overflow" },
      }),
      isRefusal("POLICY_CAP"),
    );
    assert.equal((await harness.store.list()).length, FOLD_POLICY_CAP);
  } finally {
    await rm(harness.sandbox, { recursive: true, force: true });
  }
});
