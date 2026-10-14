import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertWorkFoldAutomationAtAdmissionHorizon,
  declarationFromWorkFoldAutomationProposal,
  normalizeWorkFoldAutomationDeclaration,
  normalizeWorkFoldAutomationProposal,
  readWorkFoldAutomationProposal,
  workFoldAutomationBounds,
  workFoldAutomationDigest,
  workFoldAutomationDocumentMaxBytes,
  workFoldAutomationMessagePlaceholders,
  workFoldAutomationProposalFileSuffix,
  workFoldAutomationReferencedWorkFolderIds,
  workFoldAutomationTriggerCatchesUp,
} from "../src/local/automations/automation-declarations.js";

const manuscriptWorkFolder = "space-0123456789abcdef";
const publisherWorkFolder = "space-fedcba9876543210";
const collectorWorkFolder = "space-aaaaaaaaaaaaaaaa";

const proposalValue = {
  kind: "work-fold.automation-proposal",
  version: 1,
  name: "Weekly review handoff to Publisher",
  createdBy: "assistant",
  createdAt: "2026-08-10T17:00:00Z",
  automation: {
    title: "Move settled review notes to Publisher",
    trigger: { kind: "interval", intervalMinutes: 1440 },
    steps: [
      {
        id: "review",
        kind: "chat",
        workFolder: manuscriptWorkFolder,
        message: "Review chapters/ for unresolved notes and write a summary to reports/weekly-review.md.",
      },
      {
        id: "handoff",
        kind: "files",
        fromWorkFolder: manuscriptWorkFolder,
        from: { kind: "step-created-files", step: "review", extensions: ["md"], maxFiles: 10, maxTotalBytes: 10485760 },
        toWorkFolder: publisherWorkFolder,
        to: "Incoming/Manuscript",
      },
      {
        id: "verify",
        kind: "check",
        workFolder: publisherWorkFolder,
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

test("automation proposals canonicalize the documented example into an exact reviewable declaration", () => {
  const normalized = normalizeWorkFoldAutomationProposal(proposalValue);
  assert.equal(normalized.createdAt, "2026-08-10T17:00:00.000Z");
  assert.deepEqual(normalized.automation.trigger, { kind: "interval", intervalMinutes: 1440 });
  const handoff = normalized.automation.steps[1];
  assert.equal(handoff?.kind, "files");
  if (handoff?.kind !== "files" || handoff.from.kind !== "step-created-files") assert.fail("handoff shape");
  assert.deepEqual(handoff.from.extensions, [".md"], "bare extensions canonicalize to the dotted Check contract form");

  const declaration = declarationFromWorkFoldAutomationProposal(normalized, "automation-12345678");
  assert.equal(declaration.kind, "work-fold.automation");
  assert.equal(declaration.id, "automation-12345678");
  assert.deepEqual(normalizeWorkFoldAutomationDeclaration(structuredClone(declaration)), declaration, "normalization is idempotent");
  assert.deepEqual(workFoldAutomationReferencedWorkFolderIds(declaration), [manuscriptWorkFolder, publisherWorkFolder].sort());

  const multiLine = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "Line one.\nLine two.";
  }));
  const chat = multiLine.automation.steps[0];
  if (chat?.kind !== "chat") assert.fail("chat shape");
  assert.equal(chat.message, "Line one.\nLine two.", "newlines are ordinary message text");

  const manual = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "manual" };
  }));
  assert.deepEqual(manual.automation.trigger, { kind: "manual" });

  const allChecks = normalizeWorkFoldAutomationProposal(mutated((value) => {
    delete value.automation.steps[2].check;
  }));
  const checkStep = allChecks.automation.steps[2];
  if (checkStep?.kind !== "check") assert.fail("check shape");
  assert.equal("check" in checkStep, false, "an absent check id means every enabled Check in the work-folder");
});

test("digests pin the exact declaration independent of field order", () => {
  const declaration = declarationFromWorkFoldAutomationProposal(normalizeWorkFoldAutomationProposal(proposalValue), "automation-12345678");
  assert.equal(workFoldAutomationDigest(reversedKeys(declaration)), workFoldAutomationDigest(declaration));
  const edited = structuredClone(declaration);
  const chat = edited.steps[0];
  if (chat?.kind !== "chat") assert.fail("chat shape");
  chat.message = `${chat.message} Also archive.`;
  assert.notEqual(workFoldAutomationDigest(edited), workFoldAutomationDigest(declaration), "any message edit changes the digest");
  const renamed = declarationFromWorkFoldAutomationProposal(normalizeWorkFoldAutomationProposal(proposalValue), "automation-87654321");
  assert.notEqual(workFoldAutomationDigest(renamed), workFoldAutomationDigest(declaration));
});

test("on-settled triggers admit only recorded settle outcomes with fail-closed defaults", () => {
  const checkRun = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "on-settled", source: { kind: "check-run", workFolder: collectorWorkFolder } };
  }));
  assert.deepEqual(checkRun.automation.trigger, {
    kind: "on-settled",
    source: { kind: "check-run", workFolder: collectorWorkFolder, outcomes: ["succeeded"] },
  });
  assert.deepEqual(workFoldAutomationReferencedWorkFolderIds(checkRun.automation), [collectorWorkFolder, manuscriptWorkFolder, publisherWorkFolder].sort());

  const explicit = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = {
      kind: "on-settled",
      source: { kind: "check-run", workFolder: collectorWorkFolder, check: "check-12345678", outcomes: ["failed", "aborted"] },
    };
  }));
  if (explicit.automation.trigger.kind !== "on-settled" || explicit.automation.trigger.source.kind !== "check-run") assert.fail("trigger shape");
  assert.deepEqual(explicit.automation.trigger.source.outcomes, ["aborted", "failed"], "outcomes canonicalize sorted");
  assert.equal(explicit.automation.trigger.source.check, "check-12345678");

  const automation = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = {
      kind: "on-settled",
      source: { kind: "app-automation-run", workFolder: collectorWorkFolder, appId: "collector", appAutomationId: "collect" },
    };
  }));
  if (automation.automation.trigger.kind !== "on-settled") assert.fail("trigger shape");
  assert.deepEqual(automation.automation.trigger.source, {
    kind: "app-automation-run",
    workFolder: collectorWorkFolder,
    appId: "collector",
    appAutomationId: "collect",
    outcomes: ["success"],
  });

  const settled = (source: Record<string, unknown>) => mutated((value) => {
    value.automation.trigger = { kind: "on-settled", source };
  });
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "check-run", workFolder: collectorWorkFolder, outcomes: ["interrupted"] })), /cannot admit outcome "interrupted"/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "check-run", workFolder: collectorWorkFolder, outcomes: ["succeeded", "succeeded"] })), /repeat/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "check-run", workFolder: collectorWorkFolder, outcomes: [] })), /at least one/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "app-automation-run", workFolder: collectorWorkFolder, appId: "collector", appAutomationId: "collect", outcomes: ["skipped"] })), /cannot admit outcome "skipped"/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "app-automation-run", workFolder: collectorWorkFolder, appId: "collector", appAutomationId: "collect", outcomes: ["cancelled"] })), /cannot admit outcome "cancelled"/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "app-automation-run", workFolder: collectorWorkFolder, appId: "collector", appAutomationId: "collect", outcomes: ["exploded"] })), /must be among/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(settled({ kind: "app-automation-run", workFolder: collectorWorkFolder, appId: "collector" })), /missing required field: appAutomationId/);
});

test("version 2 admits explicit-offset one-time triggers and keeps their time-sensitive horizon out of stable parsing", () => {
  const oneTime = mutated((value) => {
    value.version = 2;
    value.automation.trigger = { kind: "at", at: "2026-08-10T14:30:00-04:00", ifMissed: "run" };
  });
  const normalized = normalizeWorkFoldAutomationProposal(oneTime);
  assert.equal(normalized.version, 2);
  assert.deepEqual(normalized.automation.trigger, {
    kind: "at",
    at: "2026-08-10T18:30:00.000Z",
    ifMissed: "run",
  });
  const atMs = Date.parse("2026-08-10T18:30:00.000Z");
  assert.doesNotThrow(() => assertWorkFoldAutomationAtAdmissionHorizon(
    normalized.automation,
    new Date(atMs - workFoldAutomationBounds.minAtAdvanceMs),
  ));
  assert.throws(() => assertWorkFoldAutomationAtAdmissionHorizon(
    normalized.automation,
    new Date(atMs - workFoldAutomationBounds.minAtAdvanceMs + 1),
  ), /in the future, and at most ten years ahead/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "at", at: "2026-08-10T18:30:00Z", ifMissed: "run" };
  })), /require contract version 2/);
  for (const at of ["2026-08-10T18:30:00", "not-a-time"]) {
    assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
      value.version = 2;
      value.automation.trigger = { kind: "at", at, ifMissed: "skip" };
    })), /explicit UTC offset/);
  }
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.version = 2;
    value.automation.trigger = { kind: "at", at: "2026-08-10T18:30:00Z", ifMissed: "later" };
  })), /ifMissed/);

  const farAt = "2036-08-11T00:00:00.000Z";
  const maximum = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.version = 2;
    value.automation.trigger = { kind: "at", at: farAt, ifMissed: "skip" };
  }));
  const earliestNow = Date.parse(farAt) - workFoldAutomationBounds.maxAtAdvanceMs;
  assert.doesNotThrow(() => assertWorkFoldAutomationAtAdmissionHorizon(
    maximum.automation,
    new Date(earliestNow),
  ));
  assert.throws(() => assertWorkFoldAutomationAtAdmissionHorizon(
    maximum.automation,
    new Date(earliestNow - 1),
  ), /in the future, and at most ten years ahead/);
});

test("automation declarations retain safety bounds without artificial count caps", () => {
  assert.doesNotThrow(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps = Array.from({ length: 17 }, (_, index) => ({
      id: `chat-${index}`,
      kind: "chat",
      workFolder: manuscriptWorkFolder,
      message: "Go.",
    }));
  })));
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps = [];
  })), /at least one step/);
  for (const intervalMinutes of [workFoldAutomationBounds.minIntervalMinutes - 1, workFoldAutomationBounds.maxIntervalMinutes + 1, 60.5]) {
    assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
      value.automation.trigger = { kind: "interval", intervalMinutes };
    })), new RegExp(`integer between ${workFoldAutomationBounds.minIntervalMinutes} and ${workFoldAutomationBounds.maxIntervalMinutes}`));
  }
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "m".repeat(workFoldAutomationBounds.maxChatMessageBytes + 1);
  })), /exceeds/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "   ";
  })), /empty/);
  assert.doesNotThrow(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = {
      kind: "paths",
      paths: Array.from({ length: 26 }, (_, index) => `reports/file-${index}.md`),
    };
  })));
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "paths", paths: ["reports/a.md", "reports/a.md"] };
  })), /repeat a path/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "tree", path: "reports", recursive: false, extensions: [] };
  })), /between 1 and 256 file extensions/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = {
      kind: "tree",
      path: "reports",
      recursive: false,
      extensions: Array.from({ length: 257 }, (_, index) => `.e${index}`),
    };
  })), /between 1 and 256 file extensions/);
  for (const maxFiles of [0, workFoldAutomationBounds.maxHandoffFiles + 1]) {
    assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
      value.automation.steps[1].from.maxFiles = maxFiles;
    })), new RegExp(`maxFiles must be an integer between 1 and ${workFoldAutomationBounds.maxHandoffFiles}`));
  }
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.maxTotalBytes = workFoldAutomationBounds.maxHandoffTotalBytes + 1;
  })), /maxTotalBytes must be an integer between/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    delete value.automation.steps[1].from.maxFiles;
  })), /missing required field: maxFiles/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.name = "n".repeat(121);
  })), /invalid or too long/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.title = "t".repeat(161);
  })), /invalid or too long/);
});

test("step graphs refuse duplicate ids and cyclic, forward, non-chat, or cross-work-folder handoffs", () => {
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[2].id = "review";
  })), /duplicate id "review"/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.step = "handoff";
  })), /earlier step; self and forward references/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.step = "verify";
  })), /earlier step; self and forward references/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.step = "missing";
  })), /unknown source step "missing"/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps = [value.automation.steps[2], { ...value.automation.steps[1], from: { ...value.automation.steps[1].from, step: "verify" } }];
  })), /earlier chat step/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].fromWorkFolder = publisherWorkFolder;
  })), new RegExp(`must copy from work-folder ${manuscriptWorkFolder}`));
});

test("unknown kinds, versions, fields, and unpinned references fail closed", () => {
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.kind = "work-fold.check-proposal";
  })), /kind must be work-fold\.automation-proposal/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.version = 6;
  })), /unsupported version 6/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.enabled = true;
  })), /unsupported field: enabled/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "cron", expression: "0 9 * * 1" };
  })), /manual, interval, or on-settled/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "manual", intervalMinutes: 60 };
  })), /unsupported field: intervalMinutes/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "on-settled", source: { kind: "assistant-turn", workFolder: manuscriptWorkFolder } };
  })), /check-run or app-automation-run/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0] = { id: "run", kind: "shell", workFolder: manuscriptWorkFolder, command: "rm -rf /" };
  })), /chat, files, or check/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.version = 4;
    value.automation.steps[0] = { id: "run", kind: "shell", workFolder: manuscriptWorkFolder, command: "rm -rf /" };
  })), /chat, files, check, or agent/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "glob", pattern: "**/*.md" };
  })), /paths, tree, or step-created-files/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0].workFolder = "Manuscript";
  })), /stable registered work-folder id/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[2].check = "weekly";
  })), /must be a Check id/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].to = "/tmp/out";
  })), /relative to the work-folder/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "paths", paths: ["../secrets.md"] };
  })), /normalized relative path/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "paths", paths: [".work-fold/work-folder.json"] };
  })), /hidden work-fold or Pi configuration/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "Review the \u202etfarcria plan.";
  })), /never allowed in an automation message/);

  const declaration = declarationFromWorkFoldAutomationProposal(normalizeWorkFoldAutomationProposal(proposalValue), "automation-12345678");
  assert.throws(() => normalizeWorkFoldAutomationDeclaration({ ...declaration, enabled: true }), /unsupported field: enabled/);
  assert.throws(() => normalizeWorkFoldAutomationDeclaration({ ...declaration, version: 6 }), /unsupported version 6/);
  assert.throws(() => normalizeWorkFoldAutomationDeclaration({ ...declaration, id: "check-12345678" }), /Automation id is invalid/);
});

test("proposal files read bounded and refuse damage", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-automation-declaration-"));
  const path = join(root, `weekly-review${workFoldAutomationProposalFileSuffix}`);
  await writeFile(path, `${JSON.stringify(proposalValue)}\n`);
  assert.deepEqual(await readWorkFoldAutomationProposal(path), normalizeWorkFoldAutomationProposal(proposalValue));

  const oversized = join(root, `oversized${workFoldAutomationProposalFileSuffix}`);
  await writeFile(oversized, Buffer.alloc(workFoldAutomationDocumentMaxBytes + 1, "x"));
  await assert.rejects(() => readWorkFoldAutomationProposal(oversized), /exceeds/);

  await assert.rejects(() => readWorkFoldAutomationProposal(root), /ordinary file/);

  const damaged = join(root, `damaged${workFoldAutomationProposalFileSuffix}`);
  await writeFile(damaged, "{not-json");
  await assert.rejects(() => readWorkFoldAutomationProposal(damaged));
});

// Version 4 (docs/receipts-not-gates.md, F23): the closed, host-filled
// placeholder set and the `agent` step. Everything else inside `{{ }}` is a
// declaration error, and a placeholder that could never be filled in for the
// declared trigger is refused at parse — so it is refused when enabling,
// rather than discovered as an empty sentence in a message already sent.
const version4Proposal = {
  kind: "work-fold.automation-proposal",
  version: 4,
  name: "Brief handoff",
  createdBy: "assistant",
  createdAt: "2026-08-10T17:00:00Z",
  automation: {
    title: "Brief handoff",
    trigger: {
      kind: "files-changed",
      workFolder: manuscriptWorkFolder,
      watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
      debounceSeconds: 5,
      cooldownMinutes: 1,
    },
    steps: [
      {
        id: "adopt",
        kind: "chat",
        workFolder: publisherWorkFolder,
        message: "{{trigger.summary}} Adopt the newest brief.\nChanged files:\n{{ trigger.changedFiles }}",
      },
      { id: "report", kind: "agent", message: "Files the adopt step created:\n{{steps.adopt.createdFiles}}" },
    ],
  },
};

function version4(mutate: (value: any) => void): unknown {
  const clone = structuredClone(version4Proposal) as any;
  mutate(clone);
  return clone;
}

test("version 4 admits the closed placeholder set and the agent step, and refuses everything else at parse", () => {
  const normalized = normalizeWorkFoldAutomationProposal(version4Proposal);
  assert.equal(normalized.version, 4);
  assert.deepEqual(normalized.automation.steps[1], {
    id: "report",
    kind: "agent",
    message: "Files the adopt step created:\n{{steps.adopt.createdFiles}}",
  });
  // Whitespace inside the braces is tolerated and the name is normalized.
  assert.deepEqual(
    workFoldAutomationMessagePlaceholders((normalized.automation.steps[0] as { message: string }).message).map((entry) => entry.name),
    ["trigger.summary", "trigger.changedFiles"],
  );
  assert.deepEqual(
    workFoldAutomationMessagePlaceholders((normalized.automation.steps[1] as { message: string }).message),
    [{ name: "steps.adopt.createdFiles", step: "adopt" }],
  );
  // A agent step names no work-folder; the work-fold agent sits above them.
  assert.deepEqual(workFoldAutomationReferencedWorkFolderIds(normalized.automation), [manuscriptWorkFolder, publisherWorkFolder].sort());

  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.steps[0].message = "Do the {{foo}} thing.";
  })), /unknown placeholder \{\{foo\}\}\. The placeholders are/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.steps[0].message = "{{trigger.findings}}";
  })), /is not a Check-run trigger/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.trigger = { kind: "interval", intervalMinutes: 60 };
  })), /is not a folder-change trigger/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.steps[0].message = "{{steps.report.createdFiles}}";
  })), /"report" is not an earlier chat step/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.steps[1].message = "{{steps.report.createdFiles}}";
  })), /"report" is not an earlier chat step/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.steps.splice(1, 0, { id: "verify", kind: "check", workFolder: publisherWorkFolder });
    value.automation.steps[2].message = "{{steps.verify.createdFiles}}";
  })), /"verify" is not an earlier chat step/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 3;
  })), /Agent steps require contract version 4/);

  // Versions 1-3 never scan: their messages are literal text, braces included.
  const literal = normalizeWorkFoldAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "Say {{trigger.summary}} and {{whatever}} verbatim.";
  })) as { automation: { steps: Array<{ message?: string }> } };
  assert.equal(literal.automation.steps[0]!.message, "Say {{trigger.summary}} and {{whatever}} verbatim.");
});

test("a Check-run trigger admits {{trigger.findings}} and a fold-only automation names no work-folder", () => {
  const workFoldAgentStepOnly = normalizeWorkFoldAutomationProposal({
    ...version4Proposal,
    automation: {
      title: "Nightly digest",
      trigger: { kind: "on-settled", source: { kind: "check-run", workFolder: collectorWorkFolder, outcomes: ["failed"] } },
      steps: [{ id: "digest", kind: "agent", message: "{{trigger.summary}}\n{{trigger.findings}}" }],
    },
  });
  assert.deepEqual(workFoldAutomationReferencedWorkFolderIds(workFoldAgentStepOnly.automation), [collectorWorkFolder]);
  assert.equal(workFoldAgentStepOnly.automation.steps.length, 1);
});

// Version 5 (docs/automations.md, 2026-10-11 amendment): a folder-change
// trigger may opt into one catch-up with `"ifMissed": "run"`. The field is
// optional and never defaulted, so every older declaration normalizes to
// exactly the shape — and the digest — it had before.
test("version 5 lets a folder-change trigger catch up, and older versions keep their exact shape", () => {
  const caughtUp = normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger.ifMissed = "run";
  }));
  assert.equal(caughtUp.version, 5);
  assert.deepEqual(caughtUp.automation.trigger, {
    kind: "files-changed",
    workFolder: manuscriptWorkFolder,
    watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
    debounceSeconds: 5,
    cooldownMinutes: 1,
    ifMissed: "run",
  });
  assert.equal(workFoldAutomationTriggerCatchesUp(caughtUp.automation.trigger), true);
  // Everything version 4 admits still parses in version 5.
  assert.deepEqual(
    workFoldAutomationMessagePlaceholders((caughtUp.automation.steps[0] as { message: string }).message).map((entry) => entry.name),
    ["trigger.summary", "trigger.changedFiles"],
  );

  const skipped = normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger.ifMissed = "skip";
  }));
  assert.equal((skipped.automation.trigger as { ifMissed?: string }).ifMissed, "skip", "an explicit choice is kept as declared");
  assert.equal(workFoldAutomationTriggerCatchesUp(skipped.automation.trigger), false);

  const unset = normalizeWorkFoldAutomationProposal(version4((value) => { value.version = 5; }));
  assert.equal("ifMissed" in unset.automation.trigger, false, "leaving it out keeps the fresh-baseline default");
  assert.equal(workFoldAutomationTriggerCatchesUp(unset.automation.trigger), false);

  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.automation.trigger.ifMissed = "run";
  })), /ifMissed requires contract version 5/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 3;
    value.automation.trigger.ifMissed = "skip";
  })), /ifMissed requires contract version 5/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger.ifMissed = "replay";
  })), /ifMissed must be "run" or "skip"/);
  assert.throws(() => normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger = { kind: "interval", intervalMinutes: 60, ifMissed: "run" };
    value.automation.steps = [{ id: "adopt", kind: "chat", workFolder: publisherWorkFolder, message: "Adopt the brief." }];
  })), /unsupported field: ifMissed/);

  // Older versions stay valid, and a stored declaration keeps its digest:
  // nothing new appears in what they normalize to.
  const version4Declaration = declarationFromWorkFoldAutomationProposal(
    normalizeWorkFoldAutomationProposal(version4Proposal),
    "automation-version4-brief",
  );
  assert.equal("ifMissed" in version4Declaration.trigger, false);
  const reparsed = normalizeWorkFoldAutomationDeclaration(JSON.parse(JSON.stringify(version4Declaration)));
  assert.equal(workFoldAutomationDigest(reparsed), workFoldAutomationDigest(version4Declaration));
  const version3 = normalizeWorkFoldAutomationProposal(version4((value) => {
    value.version = 3;
    value.automation.steps = [{ id: "adopt", kind: "chat", workFolder: publisherWorkFolder, message: "Adopt the brief." }];
  }));
  assert.equal(version3.version, 3);
  assert.equal("ifMissed" in version3.automation.trigger, false);
});

test("a chat or agent step may name its own model, and only as a provider and id", () => {
  const base = { kind: "work-fold.automation", version: 4, id: "automation-step-models", title: "Sort screenshots", createdBy: "assistant", createdAt: "2026-07-01T00:00:00.000Z", trigger: { kind: "manual" } };
  const parsed = normalizeWorkFoldAutomationDeclaration({ ...base, steps: [
    { id: "sort", kind: "chat", workFolder: "space-0000000000000001", message: "Sort.", model: { provider: " anthropic ", id: "claude-sonnet-4-5" } },
    { id: "tell", kind: "agent", message: "Done.", model: { provider: "openai", id: "gpt-5" } },
    { id: "plain", kind: "chat", workFolder: "space-0000000000000001", message: "Plain." },
  ] });
  assert.deepEqual(parsed.steps.map((step) => "model" in step ? step.model : undefined), [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
    undefined,
  ]);
  const withModel = (model: unknown) => normalizeWorkFoldAutomationDeclaration({ ...base, steps: [{ id: "sort", kind: "chat", workFolder: "space-0000000000000001", message: "Sort.", model }] });
  assert.throws(() => withModel("claude"), /model must be a JSON object/);
  assert.throws(() => withModel({ provider: "anthropic" }), /model/);
  assert.throws(() => withModel({ provider: "anthropic", id: "x", thinking: "high" }), /unsupported field: thinking/);
  assert.throws(() => withModel({ provider: "", id: "x" }), /provider/);
  assert.throws(() => withModel({ provider: "anthropic", id: "x\ny" }), /model id/);
  // An older folder-change declaration may name a model too.
  const v3 = normalizeWorkFoldAutomationDeclaration({ ...base, version: 3, steps: [{ id: "sort", kind: "chat", workFolder: "space-0000000000000001", message: "Sort.", model: { provider: "anthropic", id: "claude-sonnet-4-5" } }] });
  assert.deepEqual((v3.steps[0] as { model?: unknown }).model, { provider: "anthropic", id: "claude-sonnet-4-5" });
});
