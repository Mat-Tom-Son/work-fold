import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertWorkFoldRoutingAtAdmissionHorizon,
  assertWorkFoldRoutingAtStagingHorizon,
  declarationFromWorkFoldRoutingProposal,
  normalizeWorkFoldRoutingDeclaration,
  normalizeWorkFoldRoutingProposal,
  readWorkFoldRoutingProposal,
  workFoldRoutingBounds,
  workFoldRoutingDigest,
  workFoldRoutingProposalFileSuffix,
  workFoldRoutingReferencedSpaceIds,
} from "../src/local/routings/routing-declarations.js";

const manuscriptSpace = "space-0123456789abcdef";
const publisherSpace = "space-fedcba9876543210";
const collectorSpace = "space-aaaaaaaaaaaaaaaa";

const proposalValue = {
  kind: "work-fold.routing-proposal",
  version: 1,
  name: "Weekly review handoff to Publisher",
  createdBy: "assistant",
  createdAt: "2026-08-10T17:00:00Z",
  routing: {
    title: "Move settled review notes to Publisher",
    trigger: { kind: "interval", intervalMinutes: 1440 },
    steps: [
      {
        id: "review",
        kind: "chat",
        space: manuscriptSpace,
        message: "Review chapters/ for unresolved notes and write a summary to reports/weekly-review.md.",
      },
      {
        id: "handoff",
        kind: "files",
        fromSpace: manuscriptSpace,
        from: { kind: "step-created-files", step: "review", extensions: ["md"], maxFiles: 10, maxTotalBytes: 10485760 },
        toSpace: publisherSpace,
        to: "Incoming/Manuscript",
      },
      {
        id: "verify",
        kind: "check",
        space: publisherSpace,
        check: "check-12345678",
      },
    ],
  },
};

function mutated(mutate: (value: any) => void): unknown {
  const clone = structuredClone(proposalValue) as any;
  mutate(clone);
  return clone;
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reversedKeys(item)]),
    );
  }
  return value;
}

test("routing proposals canonicalize the documented example into an exact reviewable declaration", () => {
  const normalized = normalizeWorkFoldRoutingProposal(proposalValue);
  assert.equal(normalized.createdAt, "2026-08-10T17:00:00.000Z");
  assert.deepEqual(normalized.routing.trigger, { kind: "interval", intervalMinutes: 1440 });
  const handoff = normalized.routing.steps[1];
  assert.equal(handoff?.kind, "files");
  if (handoff?.kind !== "files" || handoff.from.kind !== "step-created-files") assert.fail("handoff shape");
  assert.deepEqual(handoff.from.extensions, [".md"], "bare extensions canonicalize to the dotted Check contract form");

  const declaration = declarationFromWorkFoldRoutingProposal(normalized, "routing-12345678");
  assert.equal(declaration.kind, "work-fold.routing");
  assert.equal(declaration.id, "routing-12345678");
  assert.deepEqual(normalizeWorkFoldRoutingDeclaration(structuredClone(declaration)), declaration, "normalization is idempotent");
  assert.deepEqual(workFoldRoutingReferencedSpaceIds(declaration), [manuscriptSpace, publisherSpace].sort());

  const multiLine = normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[0].message = "Line one.\nLine two.";
  }));
  const chat = multiLine.routing.steps[0];
  if (chat?.kind !== "chat") assert.fail("chat shape");
  assert.equal(chat.message, "Line one.\nLine two.", "newlines are ordinary message text");

  const manual = normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = { kind: "manual" };
  }));
  assert.deepEqual(manual.routing.trigger, { kind: "manual" });

  const allChecks = normalizeWorkFoldRoutingProposal(mutated((value) => {
    delete value.routing.steps[2].check;
  }));
  const checkStep = allChecks.routing.steps[2];
  if (checkStep?.kind !== "check") assert.fail("check shape");
  assert.equal("check" in checkStep, false, "an absent check id means every enabled Check in the Space");
});

test("digests pin the exact declaration independent of field order", () => {
  const declaration = declarationFromWorkFoldRoutingProposal(normalizeWorkFoldRoutingProposal(proposalValue), "routing-12345678");
  assert.equal(workFoldRoutingDigest(reversedKeys(declaration)), workFoldRoutingDigest(declaration));
  const edited = structuredClone(declaration);
  const chat = edited.steps[0];
  if (chat?.kind !== "chat") assert.fail("chat shape");
  chat.message = `${chat.message} Also archive.`;
  assert.notEqual(workFoldRoutingDigest(edited), workFoldRoutingDigest(declaration), "any message edit changes the digest");
  const renamed = declarationFromWorkFoldRoutingProposal(normalizeWorkFoldRoutingProposal(proposalValue), "routing-87654321");
  assert.notEqual(workFoldRoutingDigest(renamed), workFoldRoutingDigest(declaration));
});

test("on-settled triggers admit only recorded settle outcomes with fail-closed defaults", () => {
  const checkRun = normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = { kind: "on-settled", source: { kind: "check-run", space: collectorSpace } };
  }));
  assert.deepEqual(checkRun.routing.trigger, {
    kind: "on-settled",
    source: { kind: "check-run", space: collectorSpace, outcomes: ["succeeded"] },
  });
  assert.deepEqual(workFoldRoutingReferencedSpaceIds(checkRun.routing), [collectorSpace, manuscriptSpace, publisherSpace].sort());

  const explicit = normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = {
      kind: "on-settled",
      source: { kind: "check-run", space: collectorSpace, check: "check-12345678", outcomes: ["failed", "aborted"] },
    };
  }));
  if (explicit.routing.trigger.kind !== "on-settled" || explicit.routing.trigger.source.kind !== "check-run") assert.fail("trigger shape");
  assert.deepEqual(explicit.routing.trigger.source.outcomes, ["aborted", "failed"], "outcomes canonicalize sorted");
  assert.equal(explicit.routing.trigger.source.check, "check-12345678");

  const automation = normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = {
      kind: "on-settled",
      source: { kind: "app-automation-run", space: collectorSpace, appId: "collector", automationId: "collect" },
    };
  }));
  if (automation.routing.trigger.kind !== "on-settled") assert.fail("trigger shape");
  assert.deepEqual(automation.routing.trigger.source, {
    kind: "app-automation-run",
    space: collectorSpace,
    appId: "collector",
    automationId: "collect",
    outcomes: ["success"],
  });

  const settled = (source: Record<string, unknown>) => mutated((value) => {
    value.routing.trigger = { kind: "on-settled", source };
  });
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "check-run", space: collectorSpace, outcomes: ["interrupted"] })), /cannot admit outcome "interrupted"/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "check-run", space: collectorSpace, outcomes: ["succeeded", "succeeded"] })), /repeat/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "check-run", space: collectorSpace, outcomes: [] })), /at least one/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "app-automation-run", space: collectorSpace, appId: "collector", automationId: "collect", outcomes: ["skipped"] })), /cannot admit outcome "skipped"/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "app-automation-run", space: collectorSpace, appId: "collector", automationId: "collect", outcomes: ["cancelled"] })), /cannot admit outcome "cancelled"/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "app-automation-run", space: collectorSpace, appId: "collector", automationId: "collect", outcomes: ["exploded"] })), /must be among/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(settled({ kind: "app-automation-run", space: collectorSpace, appId: "collector" })), /missing required field: automationId/);
});

test("version 2 admits explicit-offset one-time triggers and keeps their time-sensitive horizon out of stable parsing", () => {
  const oneTime = mutated((value) => {
    value.version = 2;
    value.routing.trigger = { kind: "at", at: "2026-08-10T14:30:00-04:00", ifMissed: "run" };
  });
  const normalized = normalizeWorkFoldRoutingProposal(oneTime);
  assert.equal(normalized.version, 2);
  assert.deepEqual(normalized.routing.trigger, {
    kind: "at",
    at: "2026-08-10T18:30:00.000Z",
    ifMissed: "run",
  });
  assert.doesNotThrow(() => assertWorkFoldRoutingAtAdmissionHorizon(
    normalized.routing,
    new Date("2026-08-10T18:29:00.000Z"),
  ));
  assert.throws(() => assertWorkFoldRoutingAtAdmissionHorizon(
    normalized.routing,
    new Date("2026-08-10T18:29:00.001Z"),
  ), /between 1 minute and 366 days/);
  assert.doesNotThrow(() => assertWorkFoldRoutingAtStagingHorizon(
    normalized.routing,
    new Date("2026-08-10T18:28:00.000Z"),
  ));
  assert.throws(() => assertWorkFoldRoutingAtStagingHorizon(
    normalized.routing,
    new Date("2026-08-10T18:28:00.001Z"),
  ), /between 2 minutes and 366 days/);

  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = { kind: "at", at: "2026-08-10T18:30:00Z", ifMissed: "run" };
  })), /require contract version 2/);
  for (const at of ["2026-08-10T18:30:00", "not-a-time"]) {
    assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
      value.version = 2;
      value.routing.trigger = { kind: "at", at, ifMissed: "skip" };
    })), /explicit UTC offset/);
  }
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.version = 2;
    value.routing.trigger = { kind: "at", at: "2026-08-10T18:30:00Z", ifMissed: "later" };
  })), /ifMissed/);

  const maximum = normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.version = 2;
    value.routing.trigger = { kind: "at", at: "2027-08-11T00:00:00Z", ifMissed: "skip" };
  }));
  assert.doesNotThrow(() => assertWorkFoldRoutingAtAdmissionHorizon(
    maximum.routing,
    new Date("2026-08-10T00:00:00Z"),
  ));
  assert.throws(() => assertWorkFoldRoutingAtAdmissionHorizon(
    maximum.routing,
    new Date("2026-08-09T23:59:59.999Z"),
  ), /between 1 minute and 366 days/);
});

test("every bounds-table limit refuses at parse", () => {
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps = Array.from({ length: workFoldRoutingBounds.maxSteps + 1 }, (_, index) => ({
      id: `chat-${index}`,
      kind: "chat",
      space: manuscriptSpace,
      message: "Go.",
    }));
  })), /between 1 and 8 steps/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps = [];
  })), /between 1 and 8 steps/);
  for (const intervalMinutes of [workFoldRoutingBounds.minIntervalMinutes - 1, workFoldRoutingBounds.maxIntervalMinutes + 1, 60.5]) {
    assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
      value.routing.trigger = { kind: "interval", intervalMinutes };
    })), /integer between 15 and 1440/);
  }
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[0].message = "m".repeat(workFoldRoutingBounds.maxChatMessageBytes + 1);
  })), /exceeds/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[0].message = "   ";
  })), /empty/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = {
      kind: "paths",
      paths: Array.from({ length: workFoldRoutingBounds.maxExactPathsPerFilesStep + 1 }, (_, index) => `reports/file-${index}.md`),
    };
  })), /between 1 and 25 exact file paths/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = { kind: "paths", paths: ["reports/a.md", "reports/a.md"] };
  })), /repeat a path/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = { kind: "tree", path: "reports", recursive: false, extensions: [] };
  })), /between 1 and 24 file extensions/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = {
      kind: "tree",
      path: "reports",
      recursive: false,
      extensions: Array.from({ length: 25 }, (_, index) => `.e${index}`),
    };
  })), /between 1 and 24 file extensions/);
  for (const maxFiles of [0, workFoldRoutingBounds.maxHandoffFiles + 1]) {
    assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
      value.routing.steps[1].from.maxFiles = maxFiles;
    })), /maxFiles must be an integer between 1 and 512/);
  }
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from.maxTotalBytes = workFoldRoutingBounds.maxHandoffTotalBytes + 1;
  })), /maxTotalBytes must be an integer between/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    delete value.routing.steps[1].from.maxFiles;
  })), /missing required field: maxFiles/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.name = "n".repeat(121);
  })), /invalid or too long/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.title = "t".repeat(161);
  })), /invalid or too long/);
});

test("step graphs refuse duplicate ids and cyclic, forward, non-chat, or cross-Space handoffs", () => {
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[2].id = "review";
  })), /duplicate id "review"/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from.step = "handoff";
  })), /earlier step; self and forward references/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from.step = "verify";
  })), /earlier step; self and forward references/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from.step = "missing";
  })), /unknown source step "missing"/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps = [value.routing.steps[2], { ...value.routing.steps[1], from: { ...value.routing.steps[1].from, step: "verify" } }];
  })), /earlier chat step/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].fromSpace = publisherSpace;
  })), new RegExp(`must copy from Space ${manuscriptSpace}`));
});

test("unknown kinds, versions, fields, and unpinned references fail closed", () => {
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.kind = "work-fold.check-proposal";
  })), /kind must be work-fold\.routing-proposal/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.version = 3;
  })), /unsupported version 3/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.enabled = true;
  })), /unsupported field: enabled/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = { kind: "cron", expression: "0 9 * * 1" };
  })), /manual, interval, or on-settled/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = { kind: "manual", intervalMinutes: 60 };
  })), /unsupported field: intervalMinutes/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.trigger = { kind: "on-settled", source: { kind: "assistant-turn", space: manuscriptSpace } };
  })), /check-run or app-automation-run/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[0] = { id: "run", kind: "shell", space: manuscriptSpace, command: "rm -rf /" };
  })), /chat, files, or check/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = { kind: "glob", pattern: "**/*.md" };
  })), /paths, tree, or step-created-files/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[0].space = "Manuscript";
  })), /stable registered Space id/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[2].check = "weekly";
  })), /must be a Check id/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].to = "/tmp/out";
  })), /relative to the Space/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = { kind: "paths", paths: ["../secrets.md"] };
  })), /normalized relative path/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[1].from = { kind: "paths", paths: [".work-fold/space.json"] };
  })), /hidden work-fold or Pi configuration/);
  assert.throws(() => normalizeWorkFoldRoutingProposal(mutated((value) => {
    value.routing.steps[0].message = "Approve the \u202etfarcria plan.";
  })), /verbatim review/);

  const declaration = declarationFromWorkFoldRoutingProposal(normalizeWorkFoldRoutingProposal(proposalValue), "routing-12345678");
  assert.throws(() => normalizeWorkFoldRoutingDeclaration({ ...declaration, enabled: true }), /unsupported field: enabled/);
  assert.throws(() => normalizeWorkFoldRoutingDeclaration({ ...declaration, version: 3 }), /unsupported version 3/);
  assert.throws(() => normalizeWorkFoldRoutingDeclaration({ ...declaration, id: "check-12345678" }), /Routing id is invalid/);
});

test("proposal files read bounded and refuse damage", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-routing-declaration-"));
  const path = join(root, `weekly-review${workFoldRoutingProposalFileSuffix}`);
  await writeFile(path, `${JSON.stringify(proposalValue)}\n`);
  assert.deepEqual(await readWorkFoldRoutingProposal(path), normalizeWorkFoldRoutingProposal(proposalValue));

  const oversized = join(root, `oversized${workFoldRoutingProposalFileSuffix}`);
  await writeFile(oversized, "x".repeat(256 * 1024 + 1));
  await assert.rejects(() => readWorkFoldRoutingProposal(oversized), /exceeds/);

  await assert.rejects(() => readWorkFoldRoutingProposal(root), /ordinary file/);

  const damaged = join(root, `damaged${workFoldRoutingProposalFileSuffix}`);
  await writeFile(damaged, "{not-json");
  await assert.rejects(() => readWorkFoldRoutingProposal(damaged));
});
