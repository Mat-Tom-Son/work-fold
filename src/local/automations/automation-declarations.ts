import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeWorkFoldCheckTargetPath } from "../../shared/checks.js";
import { workFoldAutomationDeclarationBounds } from "../../shared/work-fold-limits.js";
import { folderAutomationRoles, type FolderAutomationRole } from "../../shared/automation-presentation.js";
import { restrictedAppAutomationIntervalMinutes } from "../agent/restricted-app-manifest.js";
import { workFoldCheckDigest } from "../checks/check-integrity.js";

/**
 * Automation declarations are closed, typed, machine-local data: a declared
 * trigger plus deterministic steps that move work
 * between work-folders. They carry no prompts beyond the literal chat- and
 * agent-step message plus a closed set of host-filled placeholders, no
 * instructions, no source code, no shell commands, no model names, no
 * credentials, no connection data, and no expressions — the closed field
 * vocabulary here is the enforcement. Parsing fails closed on unknown kinds,
 * versions, fields, placeholders, and every bound in the automations bounds
 * table; the automation store records an exact-digest enablement receipt over
 * whatever a parse produces.
 */
export const workFoldAutomationProposalKind = "work-fold.automation-proposal" as const;
export const workFoldAutomationDeclarationKind = "work-fold.automation" as const;
export const workFoldAutomationContractVersion = 4 as const;
export const workFoldAutomationSupportedContractVersions = [1, 2, 3, workFoldAutomationContractVersion] as const;
export type WorkFoldAutomationContractVersion = (typeof workFoldAutomationSupportedContractVersions)[number];

/** Filename convention for inert automation proposals in the work-fold agent's working folder. */
export const workFoldAutomationProposalFileSuffix = ".work-fold-automation.json" as const;

/**
 * Every declaration bound, enforced at parse and re-enforced by the executor.
 * The values are inherited from contracts this codebase already proves rather
 * than invented here: the interval reuses the restricted-app automation
 * cadence, exact source paths mirror the act lane's `files add` bound
 * (`maxActFromPaths` in src/local/cli/act-commands.ts), and created-files
 * handoffs may tighten but never widen the Check target resolver's hard
 * limits.
 */
export const workFoldAutomationBounds = Object.freeze({
  ...workFoldAutomationDeclarationBounds,
  minIntervalMinutes: restrictedAppAutomationIntervalMinutes.minimum,
  maxIntervalMinutes: restrictedAppAutomationIntervalMinutes.maximum,
  maxHandoffFiles: 100_000,
  maxHandoffTotalBytes: 64 * 1024 * 1024 * 1024,
});

/**
 * Check-run settles an on-settled trigger may admit. `interrupted` is never
 * admissible — it records a crashed run, not a result.
 */
export const workFoldAutomationCheckRunOutcomes = ["aborted", "failed", "succeeded"] as const;
export type WorkFoldAutomationCheckRunOutcome = (typeof workFoldAutomationCheckRunOutcomes)[number];

/**
 * Automation-run settles an on-settled trigger may admit. `skipped` and
 * `cancelled` are never admissible — they are lifecycle artifacts of
 * non-overlap, suspension, and revocation, and chaining on them oscillates.
 */
export const workFoldAutomationAppAutomationRunOutcomes = ["failure", "success"] as const;
export type WorkFoldAutomationAppAutomationRunOutcome = (typeof workFoldAutomationAppAutomationRunOutcomes)[number];

export interface WorkFoldAutomationCheckRunSettleSource {
  kind: "check-run";
  workFolder: string;
  /** Absent: any Check in the work-folder. */
  check?: string;
  outcomes: WorkFoldAutomationCheckRunOutcome[];
}

export interface WorkFoldAutomationAppAutomationRunSettleSource {
  kind: "app-automation-run";
  workFolder: string;
  appId: string;
  appAutomationId: string;
  outcomes: WorkFoldAutomationAppAutomationRunOutcome[];
}

export type WorkFoldAutomationSettleSource =
  | WorkFoldAutomationCheckRunSettleSource
  | WorkFoldAutomationAppAutomationRunSettleSource;

/** Run-now only; every enabled automation additionally accepts manual run-now. */
export interface WorkFoldAutomationManualTrigger {
  kind: "manual";
}

export interface WorkFoldAutomationIntervalTrigger {
  kind: "interval";
  intervalMinutes: number;
}

export interface WorkFoldAutomationAtTrigger {
  kind: "at";
  /** Canonical absolute time; proposal input must name an explicit offset. */
  at: string;
  ifMissed: "run" | "skip";
}

export interface WorkFoldAutomationOnSettledTrigger {
  kind: "on-settled";
  source: WorkFoldAutomationSettleSource;
}

export interface WorkFoldAutomationFilesChangedTrigger {
  kind: "files-changed";
  workFolder: string;
  watch: WorkFoldAutomationTreeSource;
  debounceSeconds: number;
  cooldownMinutes: number;
}

export type WorkFoldAutomationTrigger =
  | WorkFoldAutomationManualTrigger
  | WorkFoldAutomationIntervalTrigger
  | WorkFoldAutomationAtTrigger
  | WorkFoldAutomationOnSettledTrigger
  | WorkFoldAutomationFilesChangedTrigger;

/**
 * Starts a new conversation in the named work-folder with exactly this message,
 * sent with no ambient additions beyond the closed placeholder set.
 */
export interface WorkFoldAutomationChatStep {
  id: string;
  kind: "chat";
  workFolder: string;
  message: string;
}

export interface WorkFoldAutomationExactPathsSource {
  kind: "paths";
  paths: string[];
}

/** The bounded tree selector, reusing the Check target contract and resolver discipline. */
export interface WorkFoldAutomationTreeSource {
  kind: "tree";
  path: string;
  recursive: boolean;
  extensions: string[];
}

/**
 * The declared created-files handoff: the files an earlier chat step's turn
 * added or changed, resolved host-side from that turn's own History
 * checkpoint pair. Bounds are mandatory in the declaration.
 */
export interface WorkFoldAutomationStepCreatedFilesSource {
  kind: "step-created-files";
  step: string;
  extensions?: string[];
  maxFiles: number;
  maxTotalBytes: number;
}

export type WorkFoldAutomationFilesSource =
  | WorkFoldAutomationExactPathsSource
  | WorkFoldAutomationTreeSource
  | WorkFoldAutomationStepCreatedFilesSource;

/** Copies additively from one work-folder into another; an automation never moves, renames, or deletes. */
export interface WorkFoldAutomationFilesStep {
  id: string;
  kind: "files";
  fromWorkFolder: string;
  from: WorkFoldAutomationFilesSource;
  toWorkFolder: string;
  to: string;
}

export interface WorkFoldAutomationCheckStep {
  id: string;
  kind: "check";
  workFolder: string;
  /** Absent: run all enabled Checks in the work-folder. */
  check?: string;
}

/**
 * Starts a new work-fold agent chat with exactly this message, so a person
 * can put the work-fold agent on a cadence deliberately. It names no
 * work-folder: the work-fold agent sits above them. Version 4 only.
 */
export interface WorkFoldAutomationAgentStep {
  id: string;
  kind: "agent";
  message: string;
}

export type WorkFoldAutomationStep =
  | WorkFoldAutomationChatStep
  | WorkFoldAutomationFilesStep
  | WorkFoldAutomationCheckStep
  | WorkFoldAutomationAgentStep;

/** The closed set of trigger placeholders a version-4 message may carry. */
export const workFoldAutomationTriggerPlaceholders = [
  "trigger.summary",
  "trigger.changedFiles",
  "trigger.findings",
] as const;
export type WorkFoldAutomationTriggerPlaceholder = (typeof workFoldAutomationTriggerPlaceholders)[number];

/** One `{{…}}` occurrence: a trigger name, or an earlier chat step's created files. */
export interface WorkFoldAutomationPlaceholder {
  name: WorkFoldAutomationTriggerPlaceholder | string;
  /** Present only for `steps.<id>.createdFiles`. */
  step?: string;
}

const createdFilesPlaceholderPattern = /^steps\.([a-z0-9][a-z0-9-]{0,63})\.createdFiles$/;
const placeholderOccurrencePattern = /\{\{([^{}]*)\}\}/g;

/**
 * Every `{{…}}` occurrence in a version-4 chat- or agent-step message, in
 * message order and with duplicates kept. The set is closed: anything else
 * inside braces is a declaration error, so nothing an automation sends can ever
 * interpolate something the person did not read. Versions 1–3 never reach
 * here — their messages are literal text, braces included.
 */
export function workFoldAutomationMessagePlaceholders(
  message: string,
  label = "This automation step",
): WorkFoldAutomationPlaceholder[] {
  const placeholders: WorkFoldAutomationPlaceholder[] = [];
  for (const match of message.matchAll(placeholderOccurrencePattern)) {
    const name = (match[1] ?? "").trim();
    if ((workFoldAutomationTriggerPlaceholders as readonly string[]).includes(name)) {
      placeholders.push({ name });
      continue;
    }
    const created = createdFilesPlaceholderPattern.exec(name);
    if (created) {
      placeholders.push({ name, step: created[1]! });
      continue;
    }
    throw new Error(
      `${label} message uses an unknown placeholder ${match[0]}. The placeholders are `
        + "{{trigger.summary}}, {{trigger.changedFiles}}, {{trigger.findings}}, and {{steps.<id>.createdFiles}}.",
    );
  }
  return placeholders;
}

export interface WorkFoldAutomationDefinition {
  title: string;
  trigger: WorkFoldAutomationTrigger;
  steps: WorkFoldAutomationStep[];
}

export interface WorkFoldAutomationProposal {
  kind: typeof workFoldAutomationProposalKind;
  version: WorkFoldAutomationContractVersion;
  name: string;
  createdBy: "human" | "assistant" | "codex" | "claude-code" | "other";
  createdAt: string;
  automation: WorkFoldAutomationDefinition;
}

export interface WorkFoldAutomationDeclaration extends WorkFoldAutomationDefinition {
  kind: typeof workFoldAutomationDeclarationKind;
  version: WorkFoldAutomationContractVersion;
  id: string;
  createdBy: WorkFoldAutomationProposal["createdBy"];
  createdAt: string;
}

/** Room for the largest step messages a declaration may carry. */
export const workFoldAutomationDocumentMaxBytes = 64 * 1024 * 1024;

// Mirrors isWorkFolderId in src/local/work-folder.ts: automations pin
// work-folders by stable registered work-folder id, never by name or path. The
// CLI may resolve an exact name for convenience, but the stored declaration
// records ids only.
const workFolderIdPattern = /^space-[a-f0-9]{16}$/;
// Mirrors the Check id rule in src/shared/checks.ts.
const checkIdPattern = /^check-[a-z0-9][a-z0-9-]{7,154}$/;
const automationIdPattern = /^automation-[a-z0-9][a-z0-9-]{7,154}$/;
// Mirrors the restricted-app manifest id rule for app and automation ids.
const restrictedAppIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const stepIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const extensionPattern = /^\.[a-z0-9][a-z0-9._+-]*$/;
/**
 * Tabs and newlines are ordinary message text; other C0/C1 controls and
 * bidirectional overrides are never allowed in an automation message.
 *
 * The one character rule for anything that becomes an automation message. A
 * declared message is refused outright when it carries these; filled-in
 * placeholder text is host-supplied and cannot be refused at declaration
 * time, so the executor replaces the same characters before substitution
 * (src/local/automations/automation-service.ts). Both go through this class so the
 * hop receipt records exactly the text the destination received.
 */
export const workFoldAutomationForbiddenMessageCharacters = "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069";
const forbiddenMessageCharacters = new RegExp(`[${workFoldAutomationForbiddenMessageCharacters}]`);

/** Replaces every forbidden message character; the result is safe to substitute and to record. */
export function scrubWorkFoldAutomationMessageText(value: string): string {
  return value.replace(new RegExp(`[${workFoldAutomationForbiddenMessageCharacters}]`, "gu"), "\uFFFD");
}

const inadmissibleOutcomeReasons = new Map<string, string>([
  ["interrupted", "it records a crashed run, not a result"],
  ["skipped", "it is a lifecycle artifact of non-overlap and suspension"],
  ["cancelled", "it is a lifecycle artifact of shutdown and revocation"],
]);

export function normalizeWorkFoldAutomationProposal(value: unknown): WorkFoldAutomationProposal {
  const record = objectRecord(value, "Automation proposal must be a JSON object.");
  assertKeys(record, ["kind", "version", "name", "createdBy", "createdAt", "automation"], [], "Automation proposal");
  if (record.kind !== workFoldAutomationProposalKind) throw new Error(`Automation proposal kind must be ${workFoldAutomationProposalKind}.`);
  const version = contractVersion(record.version, "Automation proposal");
  return {
    kind: workFoldAutomationProposalKind,
    version,
    name: boundedText(record.name, "Automation proposal name", 120),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Automation proposal createdAt"),
    automation: normalizeAutomationDefinition(record.automation, version),
  };
}

export function normalizeWorkFoldAutomationDeclaration(value: unknown): WorkFoldAutomationDeclaration {
  const record = objectRecord(value, "Automation declaration must be a JSON object.");
  assertKeys(
    record,
    ["kind", "version", "id", "title", "trigger", "steps", "createdBy", "createdAt"],
    [],
    "Automation declaration",
  );
  if (record.kind !== workFoldAutomationDeclarationKind) throw new Error(`Automation declaration kind must be ${workFoldAutomationDeclarationKind}.`);
  const version = contractVersion(record.version, "Automation declaration");
  return {
    kind: workFoldAutomationDeclarationKind,
    version,
    id: automationId(record.id),
    ...normalizeAutomationDefinition({ title: record.title, trigger: record.trigger, steps: record.steps }, version),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Automation declaration createdAt"),
  };
}

export function declarationFromWorkFoldAutomationProposal(
  proposal: WorkFoldAutomationProposal,
  id = `automation-${randomUUID()}`,
): WorkFoldAutomationDeclaration {
  return normalizeWorkFoldAutomationDeclaration({
    kind: workFoldAutomationDeclarationKind,
    version: proposal.version,
    id,
    ...proposal.automation,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

/**
 * The declaration a proposal enables as: a deterministic content-derived
 * automation id, so identical proposal content always names one automation. The
 * CLI's `automations enable --proposal` and Settings' pending-proposal scan both
 * go through this, so a scanned file's digest is exactly what enabling it pins.
 */
export function contentAddressedWorkFoldAutomationDeclaration(
  proposal: WorkFoldAutomationProposal,
): { declaration: WorkFoldAutomationDeclaration; digest: string } {
  const contentId = `automation-${workFoldAutomationDigest(proposal).slice(0, 16)}`;
  const declaration = declarationFromWorkFoldAutomationProposal(proposal, contentId);
  return { declaration, digest: workFoldAutomationDigest(declaration) };
}

/**
 * The digest that pins an automation: enablement records an exact-authority grant
 * over it, receipts carry it, and any edit changes it — an edited automation
 * never coasts on a stale approval. Canonicalization is the same stable JSON
 * used for Check digests, so field order can never change authority.
 */
export function workFoldAutomationDigest(value: unknown): string {
  return workFoldCheckDigest(value);
}

/**
 * Every work-folder an automation names, across its trigger source and all steps,
 * sorted and deduplicated. Removing any of them revokes the enablement grant
 * and suspends the automation.
 */
export function workFoldAutomationReferencedWorkFolderIds(definition: WorkFoldAutomationDefinition): string[] {
  const ids = new Set<string>();
  if (definition.trigger.kind === "files-changed") ids.add(definition.trigger.workFolder);
  if (definition.trigger.kind === "on-settled") ids.add(definition.trigger.source.workFolder);
  for (const step of definition.steps) {
    if (step.kind === "files") {
      ids.add(step.fromWorkFolder);
      ids.add(step.toWorkFolder);
    } else if (step.kind === "chat" || step.kind === "check") {
      ids.add(step.workFolder);
    }
    // An agent step names no work-folder: the work-fold agent sits above them.
  }
  return [...ids].sort();
}

/**
 * What this automation does in one work-folder, derived from the declaration alone:
 * the trigger watches it (a folder change, or a Check or app automation
 * settling there), a files step copies into or out of it, a chat step starts
 * a conversation there, a check step runs Checks there. Empty exactly when
 * `workFoldAutomationReferencedWorkFolderIds` does not name the work-folder.
 */
export function workFoldAutomationWorkFolderRoles(definition: WorkFoldAutomationDefinition, workFolderId: string): FolderAutomationRole[] {
  const roles = new Set<FolderAutomationRole>();
  if (definition.trigger.kind === "files-changed" && definition.trigger.workFolder === workFolderId) roles.add("watches");
  if (definition.trigger.kind === "on-settled" && definition.trigger.source.workFolder === workFolderId) roles.add("watches");
  for (const step of definition.steps) {
    if (step.kind === "files") {
      if (step.toWorkFolder === workFolderId) roles.add("copies-to");
      if (step.fromWorkFolder === workFolderId) roles.add("copies-from");
    } else if (step.kind === "chat" && step.workFolder === workFolderId) {
      roles.add("chats-here");
    } else if (step.kind === "check" && step.workFolder === workFolderId) {
      roles.add("checks-here");
    }
  }
  return folderAutomationRoles.filter((role) => roles.has(role));
}

/**
 * Rechecks the time-sensitive one-time horizon when the automation is enabled.
 * The declaration parser validates only the stable shape because a stored
 * inert proposal must not become syntactically damaged merely as time passes.
 */
export function assertWorkFoldAutomationAtAdmissionHorizon(
  definition: Pick<WorkFoldAutomationDefinition, "trigger">,
  now: Date,
): void {
  if (definition.trigger.kind !== "at") return;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Automation admission time is invalid.");
  const advanceMs = Date.parse(definition.trigger.at) - nowMs;
  if (advanceMs < workFoldAutomationBounds.minAtAdvanceMs || advanceMs > workFoldAutomationBounds.maxAtAdvanceMs) {
    throw new Error("Automation one-time trigger must be in the future, and at most ten years ahead, when it is enabled.");
  }
}

export async function readWorkFoldAutomationProposal(path: string): Promise<WorkFoldAutomationProposal> {
  const resolved = resolve(path);
  return normalizeWorkFoldAutomationProposal(JSON.parse(await readWorkFoldAutomationDocument(resolved)));
}

function normalizeAutomationDefinition(value: unknown, version: WorkFoldAutomationContractVersion): WorkFoldAutomationDefinition {
  const record = objectRecord(value, "Automation definition must be a JSON object.");
  assertKeys(record, ["title", "trigger", "steps"], [], "Automation definition");
  if (!Array.isArray(record.steps) || record.steps.length < 1) {
    throw new Error("Automation steps must contain at least one step.");
  }
  const trigger = normalizeTrigger(record.trigger, version);
  const steps = record.steps.map((step, index) => normalizeStep(step, index, version));
  const positions = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (positions.has(step.id)) throw new Error(`Automation steps contain duplicate id "${step.id}".`);
    positions.set(step.id, index);
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind !== "files" || step.from.kind !== "step-created-files") continue;
    const label = `Automation step "${step.id}"`;
    const sourceIndex = positions.get(step.from.step);
    if (sourceIndex === undefined) throw new Error(`${label} names unknown source step "${step.from.step}".`);
    if (sourceIndex >= index) {
      throw new Error(`${label} must take created files from an earlier step; self and forward references would make the automation cyclic.`);
    }
    const source = steps[sourceIndex]!;
    if (source.kind !== "chat") throw new Error(`${label} must take created files from an earlier chat step.`);
    if (source.workFolder !== step.fromWorkFolder) {
      throw new Error(`${label} must copy from work-folder ${source.workFolder}, where its source chat step runs.`);
    }
  }
  if (version >= 4) assertPlaceholdersResolvable(steps, positions, trigger);
  return {
    title: boundedText(record.title, "Automation title", 160),
    trigger,
    steps,
  };
}

/**
 * A placeholder that could never be filled in for the declared trigger — or
 * that names a step whose created files no run can know — is a declaration
 * error, refused when the automation is enabled rather than discovered as an
 * empty sentence in a message a Worker already received.
 */
function assertPlaceholdersResolvable(
  steps: WorkFoldAutomationStep[],
  positions: Map<string, number>,
  trigger: WorkFoldAutomationTrigger,
): void {
  for (const [index, step] of steps.entries()) {
    if (step.kind !== "chat" && step.kind !== "agent") continue;
    const label = `Automation step "${step.id}"`;
    for (const placeholder of workFoldAutomationMessagePlaceholders(step.message, label)) {
      if (placeholder.name === "trigger.changedFiles" && trigger.kind !== "files-changed") {
        throw new Error(`${label} uses {{trigger.changedFiles}}, but the trigger is not a folder-change trigger.`);
      }
      if (placeholder.name === "trigger.findings"
        && !(trigger.kind === "on-settled" && trigger.source.kind === "check-run")) {
        throw new Error(`${label} uses {{trigger.findings}}, but the trigger is not a Check-run trigger.`);
      }
      if (placeholder.step === undefined) continue;
      const sourceIndex = positions.get(placeholder.step);
      const source = sourceIndex === undefined ? undefined : steps[sourceIndex];
      if (sourceIndex === undefined || sourceIndex >= index || source?.kind !== "chat") {
        throw new Error(
          `${label} uses {{steps.${placeholder.step}.createdFiles}}, but "${placeholder.step}" `
            + "is not an earlier chat step in this automation.",
        );
      }
    }
  }
}

function normalizeTrigger(value: unknown, version: WorkFoldAutomationContractVersion): WorkFoldAutomationTrigger {
  const record = objectRecord(value, "Automation trigger must be a JSON object.");
  if (record.kind === "manual") {
    assertKeys(record, ["kind"], [], "Automation manual trigger");
    return { kind: "manual" };
  }
  if (record.kind === "interval") {
    assertKeys(record, ["kind", "intervalMinutes"], [], "Automation interval trigger");
    return {
      kind: "interval",
      intervalMinutes: boundedInteger(
        record.intervalMinutes,
        "Automation interval minutes",
        workFoldAutomationBounds.minIntervalMinutes,
        workFoldAutomationBounds.maxIntervalMinutes,
      ),
    };
  }
  if (record.kind === "at") {
    if (version < 2) throw new Error("Automation one-time triggers require contract version 2.");
    assertKeys(record, ["kind", "at", "ifMissed"], [], "Automation one-time trigger");
    if (record.ifMissed !== "run" && record.ifMissed !== "skip") {
      throw new Error('Automation one-time trigger ifMissed must be "run" or "skip".');
    }
    return {
      kind: "at",
      at: explicitOffsetTimestamp(record.at, "Automation one-time trigger at"),
      ifMissed: record.ifMissed,
    };
  }
  if (record.kind === "files-changed") {
    if (version < 3) throw new Error("folder-change triggers require contract version 3.");
    assertKeys(record, ["kind", "workFolder", "watch", "debounceSeconds", "cooldownMinutes"], [], "folder-change trigger");
    const watch = normalizeFilesSource(record.watch, "Watched folder");
    if (watch.kind !== "tree") throw new Error("A folder-change trigger requires one bounded folder selector.");
    return { kind: "files-changed", workFolder: workFolderId(record.workFolder, "Watched work-folder"), watch,
      debounceSeconds: boundedInteger(record.debounceSeconds, "folder-change debounce seconds", 1, 3_600),
      cooldownMinutes: boundedInteger(record.cooldownMinutes, "folder-change cooldown minutes", 0, 10_080) };
  }
  if (record.kind === "on-settled") {
    assertKeys(record, ["kind", "source"], [], "Automation on-settled trigger");
    return { kind: "on-settled", source: normalizeSettleSource(record.source) };
  }
  throw new Error(version >= 3 ? "Automation trigger kind must be manual, interval, at, on-settled, or files-changed." : version >= 2
    ? "Automation trigger kind must be manual, interval, at, or on-settled."
    : "Automation trigger kind must be manual, interval, or on-settled.");
}

function normalizeSettleSource(value: unknown): WorkFoldAutomationSettleSource {
  const record = objectRecord(value, "Automation trigger source must be a JSON object.");
  if (record.kind === "check-run") {
    assertKeys(record, ["kind", "workFolder"], ["check", "outcomes"], "Automation check-run trigger source");
    return {
      kind: "check-run",
      workFolder: workFolderId(record.workFolder, "Automation check-run trigger source work-folder"),
      ...(record.check !== undefined ? { check: checkRef(record.check, "Automation check-run trigger source check") } : {}),
      outcomes: normalizeOutcomes(record.outcomes, "Automation check-run trigger source", workFoldAutomationCheckRunOutcomes, ["succeeded"]),
    };
  }
  if (record.kind === "app-automation-run") {
    assertKeys(record, ["kind", "workFolder", "appId", "appAutomationId"], ["outcomes"], "Automation app-automation-run trigger source");
    return {
      kind: "app-automation-run",
      workFolder: workFolderId(record.workFolder, "Automation app-automation-run trigger source work-folder"),
      appId: restrictedAppId(record.appId, "Automation app-automation-run trigger source appId"),
      appAutomationId: restrictedAppId(record.appAutomationId, "Automation app-automation-run trigger source automationId"),
      outcomes: normalizeOutcomes(record.outcomes, "Automation app-automation-run trigger source", workFoldAutomationAppAutomationRunOutcomes, ["success"]),
    };
  }
  throw new Error("Automation trigger source kind must be check-run or app-automation-run.");
}

function normalizeStep(value: unknown, index: number, version: WorkFoldAutomationContractVersion): WorkFoldAutomationStep {
  const label = `Automation step ${index + 1}`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  if (record.kind === "chat") {
    assertKeys(record, ["id", "kind", "workFolder", "message"], [], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "chat",
      workFolder: workFolderId(record.workFolder, `${label} work-folder`),
      message: boundedMessage(record.message, `${label} message`),
    };
  }
  if (record.kind === "files") {
    assertKeys(record, ["id", "kind", "fromWorkFolder", "from", "toWorkFolder", "to"], [], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "files",
      fromWorkFolder: workFolderId(record.fromWorkFolder, `${label} fromWorkFolder`),
      from: normalizeFilesSource(record.from, label),
      toWorkFolder: workFolderId(record.toWorkFolder, `${label} toWorkFolder`),
      to: normalizeWorkFoldCheckTargetPath(record.to, `${label} destination`),
    };
  }
  if (record.kind === "check") {
    assertKeys(record, ["id", "kind", "workFolder"], ["check"], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "check",
      workFolder: workFolderId(record.workFolder, `${label} work-folder`),
      ...(record.check !== undefined ? { check: checkRef(record.check, `${label} check`) } : {}),
    };
  }
  if (record.kind === "agent") {
    if (version < 4) throw new Error("Agent steps require contract version 4.");
    assertKeys(record, ["id", "kind", "message"], [], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "agent",
      message: boundedMessage(record.message, `${label} message`),
    };
  }
  throw new Error(version >= 4
    ? `${label} kind must be chat, files, check, or agent.`
    : `${label} kind must be chat, files, or check.`);
}

function normalizeFilesSource(value: unknown, stepLabel: string): WorkFoldAutomationFilesSource {
  const label = `${stepLabel} source`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  if (record.kind === "paths") {
    assertKeys(record, ["kind", "paths"], [], label);
    if (!Array.isArray(record.paths) || record.paths.length < 1) {
      throw new Error(`${label} paths must contain at least one exact file path.`);
    }
    const paths = record.paths.map((path, pathIndex) => normalizeWorkFoldCheckTargetPath(path, `${label} path ${pathIndex + 1}`));
    if (new Set(paths).size !== paths.length) throw new Error(`${label} paths repeat a path.`);
    return { kind: "paths", paths };
  }
  if (record.kind === "tree") {
    assertKeys(record, ["kind", "path", "recursive", "extensions"], [], label);
    if (record.recursive !== true && record.recursive !== false) throw new Error(`${label} recursive must be a boolean.`);
    return {
      kind: "tree",
      path: normalizeWorkFoldCheckTargetPath(record.path, `${label} path`),
      recursive: record.recursive,
      extensions: normalizeExtensions(record.extensions, label),
    };
  }
  if (record.kind === "step-created-files") {
    assertKeys(record, ["kind", "step", "maxFiles", "maxTotalBytes"], ["extensions"], label);
    return {
      kind: "step-created-files",
      step: stepId(record.step, `${label} step`),
      ...(record.extensions !== undefined ? { extensions: normalizeExtensions(record.extensions, label) } : {}),
      maxFiles: boundedInteger(record.maxFiles, `${label} maxFiles`, 1, workFoldAutomationBounds.maxHandoffFiles),
      maxTotalBytes: boundedInteger(record.maxTotalBytes, `${label} maxTotalBytes`, 1, workFoldAutomationBounds.maxHandoffTotalBytes),
    };
  }
  throw new Error(`${label} kind must be paths, tree, or step-created-files.`);
}

function normalizeOutcomes<Outcome extends string>(
  value: unknown,
  label: string,
  admissible: readonly Outcome[],
  fallback: readonly Outcome[],
): Outcome[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${label} outcomes must name at least one outcome.`);
  const outcomes = new Set<Outcome>();
  for (const item of value) {
    if (typeof item === "string" && (admissible as readonly string[]).includes(item)) {
      outcomes.add(item as Outcome);
      continue;
    }
    const reason = typeof item === "string" ? inadmissibleOutcomeReasons.get(item) : undefined;
    if (reason) throw new Error(`${label} cannot admit outcome "${item}": ${reason}.`);
    throw new Error(`${label} outcomes must be among: ${admissible.join(", ")}.`);
  }
  if (outcomes.size !== value.length) throw new Error(`${label} outcomes repeat an outcome.`);
  return [...outcomes].sort();
}

function normalizeExtensions(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new Error(`${label} extensions must contain between 1 and 256 file extensions.`);
  }
  const extensions = value.map((item) => {
    const raw = boundedText(item, `${label} extension`, 24).toLocaleLowerCase("en-US");
    // Canonicalize to the dotted Check contract form: a bare "md" filter would
    // otherwise match any suffix ending in those letters at resolution time.
    const extension = raw.startsWith(".") ? raw : `.${raw}`;
    if (!extensionPattern.test(extension)) throw new Error(`${label} contains an invalid extension.`);
    return extension;
  });
  return [...new Set(extensions)].sort();
}

function boundedMessage(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const message = value.trim();
  if (!message) throw new Error(`${label} cannot be empty.`);
  if (Buffer.byteLength(message, "utf8") > workFoldAutomationBounds.maxChatMessageBytes) {
    throw new Error(`${label} exceeds ${workFoldAutomationBounds.maxChatMessageBytes} bytes.`);
  }
  if (forbiddenMessageCharacters.test(message)) {
    throw new Error(`${label} contains control or direction-override characters, which are never allowed in an automation message.`);
  }
  return message;
}

function workFolderId(value: unknown, label: string): string {
  if (typeof value !== "string" || !workFolderIdPattern.test(value)) {
    throw new Error(`${label} must be a stable registered work-folder id, not a name or path.`);
  }
  return value;
}

function checkRef(value: unknown, label: string): string {
  const id = boundedText(value, label, 160).toLocaleLowerCase("en-US");
  if (!checkIdPattern.test(id)) throw new Error(`${label} must be a Check id.`);
  return id;
}

function automationId(value: unknown): string {
  const id = boundedText(value, "Automation id", 160).toLocaleLowerCase("en-US");
  if (!automationIdPattern.test(id)) throw new Error("Automation id is invalid.");
  return id;
}

function restrictedAppId(value: unknown, label: string): string {
  const id = boundedText(value, label, 64).toLocaleLowerCase("en-US");
  if (!restrictedAppIdPattern.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function stepId(value: unknown, label: string): string {
  const id = boundedText(value, label, 64).toLocaleLowerCase("en-US");
  if (!stepIdPattern.test(id)) throw new Error(`${label} must be a short lowercase id of letters, digits, and hyphens.`);
  return id;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function normalizeCreator(value: unknown): WorkFoldAutomationProposal["createdBy"] {
  if (value === "human" || value === "assistant" || value === "codex" || value === "claude-code" || value === "other") return value;
  throw new Error("Automation proposal createdBy is invalid.");
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function explicitOffsetTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO timestamp with an explicit UTC offset.`);
  }
  return new Date(value).toISOString();
}

function contractVersion(value: unknown, label: string): WorkFoldAutomationContractVersion {
  if (!(workFoldAutomationSupportedContractVersions as readonly unknown[]).includes(value)) {
    throw new Error(`${label} uses unsupported version ${String(value)}.`);
  }
  return value as WorkFoldAutomationContractVersion;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported field: ${unexpected[0]}.`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${label} is missing required field: ${missing[0]}.`);
}

/** The shared bounded, no-follow reader for proposal scans and enablement. */
export async function readWorkFoldAutomationDocument(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Automation document must be an ordinary file, not a link or special file.");
  if (info.size > workFoldAutomationDocumentMaxBytes) throw new Error("Automation document exceeds the 64 MiB bound.");
  // A raced FIFO must not block the app; a raced symlink must not redirect it.
  const handle = await open(path, constants.O_RDONLY | noFollowFlag() | (constants.O_NONBLOCK ?? 0));
  try {
    const afterOpen = await handle.stat();
    if (!sameAutomationFile(info, afterOpen)) throw new Error("Automation document changed while it was opened.");
    // Read the admitted size only: readFile() could allocate without a bound
    // if another process grew the file after stat. The final metadata checks
    // also refuse a changed/truncated document instead of parsing mixed bytes.
    const bytes = Buffer.alloc(afterOpen.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Automation document changed while it was read.");
      offset += read.bytesRead;
    }
    if (!sameAutomationFile(afterOpen, await handle.stat()) || !sameAutomationFile(afterOpen, await lstat(path))) {
      throw new Error("Automation document changed while it was read.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function sameAutomationFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
