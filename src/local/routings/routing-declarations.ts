import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeWorkFoldCheckTargetPath } from "../../shared/checks.js";
import { restrictedAppAutomationIntervalMinutes } from "../agent/restricted-app-manifest.js";
import { workFoldCheckDigest } from "../checks/check-integrity.js";
import { workFoldCheckTargetHardLimits } from "../checks/target-resolver.js";

/**
 * Routing declarations are closed, typed, machine-local data: a reviewed
 * trigger plus at most eight deterministic steps that move work between
 * Spaces. They carry no prompts beyond the literal chat-step message, no
 * instructions, no source code, no shell commands, no model names, no
 * credentials, no connection data, and no expressions — the closed field
 * vocabulary here is the enforcement. Parsing fails closed on unknown kinds,
 * versions, fields, and every bound in the routings bounds table; nothing a
 * parse produces holds authority until the routing store records an
 * exact-digest enablement grant.
 */
export const workFoldRoutingProposalKind = "work-fold.routing-proposal" as const;
export const workFoldRoutingDeclarationKind = "work-fold.routing" as const;
export const workFoldRoutingContractVersion = 2 as const;
export const workFoldRoutingSupportedContractVersions = [1, workFoldRoutingContractVersion] as const;
export type WorkFoldRoutingContractVersion = (typeof workFoldRoutingSupportedContractVersions)[number];

/** Filename convention for inert routing proposals in the fold's management working folder. */
export const workFoldRoutingProposalFileSuffix = ".work-fold-routing.json" as const;

/**
 * Every declaration bound, enforced at parse and re-enforced by the executor.
 * The values are inherited from contracts this codebase already proves rather
 * than invented here: the interval reuses the restricted-app automation
 * cadence, exact source paths mirror the act lane's `files add` bound
 * (`maxActFromPaths` in src/local/cli/act-commands.ts), and created-files
 * handoffs may tighten but never widen the Check target resolver's hard
 * limits.
 */
export const workFoldRoutingBounds = Object.freeze({
  /** Machine-wide declaration budget; the routing store enforces it at enablement. */
  maxRoutingsPerMachine: 32,
  maxSteps: 8,
  maxExactPathsPerFilesStep: 25,
  /** A fixed dispatch message, not a document. */
  maxChatMessageBytes: 16 * 1024,
  minIntervalMinutes: restrictedAppAutomationIntervalMinutes.minimum,
  maxIntervalMinutes: restrictedAppAutomationIntervalMinutes.maximum,
  minAtAdvanceMs: 60_000,
  maxAtAdvanceMs: 366 * 24 * 60 * 60 * 1_000,
  maxHandoffFiles: workFoldCheckTargetHardLimits.maxFiles,
  maxHandoffTotalBytes: workFoldCheckTargetHardLimits.maxTotalBytes,
});

/**
 * Check-run settles an on-settled trigger may admit. `interrupted` is never
 * admissible — it records a crashed run, not a result.
 */
export const workFoldRoutingCheckRunOutcomes = ["aborted", "failed", "succeeded"] as const;
export type WorkFoldRoutingCheckRunOutcome = (typeof workFoldRoutingCheckRunOutcomes)[number];

/**
 * Automation-run settles an on-settled trigger may admit. `skipped` and
 * `cancelled` are never admissible — they are lifecycle artifacts of
 * non-overlap, suspension, and revocation, and chaining on them oscillates.
 */
export const workFoldRoutingAutomationRunOutcomes = ["failure", "success"] as const;
export type WorkFoldRoutingAutomationRunOutcome = (typeof workFoldRoutingAutomationRunOutcomes)[number];

export interface WorkFoldRoutingCheckRunSettleSource {
  kind: "check-run";
  space: string;
  /** Absent: any Check in the Space. */
  check?: string;
  outcomes: WorkFoldRoutingCheckRunOutcome[];
}

export interface WorkFoldRoutingAutomationRunSettleSource {
  kind: "app-automation-run";
  space: string;
  appId: string;
  automationId: string;
  outcomes: WorkFoldRoutingAutomationRunOutcome[];
}

export type WorkFoldRoutingSettleSource =
  | WorkFoldRoutingCheckRunSettleSource
  | WorkFoldRoutingAutomationRunSettleSource;

/** Run-now only; every enabled routing additionally accepts manual run-now. */
export interface WorkFoldRoutingManualTrigger {
  kind: "manual";
}

export interface WorkFoldRoutingIntervalTrigger {
  kind: "interval";
  intervalMinutes: number;
}

export interface WorkFoldRoutingAtTrigger {
  kind: "at";
  /** Canonical absolute time; proposal input must name an explicit offset. */
  at: string;
  ifMissed: "run" | "skip";
}

export interface WorkFoldRoutingOnSettledTrigger {
  kind: "on-settled";
  source: WorkFoldRoutingSettleSource;
}

export type WorkFoldRoutingTrigger =
  | WorkFoldRoutingManualTrigger
  | WorkFoldRoutingIntervalTrigger
  | WorkFoldRoutingAtTrigger
  | WorkFoldRoutingOnSettledTrigger;

/**
 * Starts a new conversation in the named Space with exactly this message —
 * reviewed verbatim at enablement, sent with no ambient additions.
 */
export interface WorkFoldRoutingChatStep {
  id: string;
  kind: "chat";
  space: string;
  message: string;
}

export interface WorkFoldRoutingExactPathsSource {
  kind: "paths";
  paths: string[];
}

/** The bounded tree selector, reusing the Check target contract and resolver discipline. */
export interface WorkFoldRoutingTreeSource {
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
export interface WorkFoldRoutingStepCreatedFilesSource {
  kind: "step-created-files";
  step: string;
  extensions?: string[];
  maxFiles: number;
  maxTotalBytes: number;
}

export type WorkFoldRoutingFilesSource =
  | WorkFoldRoutingExactPathsSource
  | WorkFoldRoutingTreeSource
  | WorkFoldRoutingStepCreatedFilesSource;

/** Copies additively from one Space into another; a routing never moves, renames, or deletes. */
export interface WorkFoldRoutingFilesStep {
  id: string;
  kind: "files";
  fromSpace: string;
  from: WorkFoldRoutingFilesSource;
  toSpace: string;
  to: string;
}

export interface WorkFoldRoutingCheckStep {
  id: string;
  kind: "check";
  space: string;
  /** Absent: run all enabled Checks in the Space. */
  check?: string;
}

export type WorkFoldRoutingStep =
  | WorkFoldRoutingChatStep
  | WorkFoldRoutingFilesStep
  | WorkFoldRoutingCheckStep;

export interface WorkFoldRoutingDefinition {
  title: string;
  trigger: WorkFoldRoutingTrigger;
  steps: WorkFoldRoutingStep[];
}

export interface WorkFoldRoutingProposal {
  kind: typeof workFoldRoutingProposalKind;
  version: WorkFoldRoutingContractVersion;
  name: string;
  createdBy: "human" | "assistant" | "codex" | "claude-code" | "other";
  createdAt: string;
  routing: WorkFoldRoutingDefinition;
}

export interface WorkFoldRoutingDeclaration extends WorkFoldRoutingDefinition {
  kind: typeof workFoldRoutingDeclarationKind;
  version: WorkFoldRoutingContractVersion;
  id: string;
  createdBy: WorkFoldRoutingProposal["createdBy"];
  createdAt: string;
}

const maximumProposalBytes = 256 * 1024;

// Mirrors isSpaceId in src/local/space.ts: routings pin Spaces by stable
// registered Space id, never by name or path. A staging surface may resolve
// an exact name for convenience, but the stored declaration records ids only.
const spaceIdPattern = /^space-[a-f0-9]{16}$/;
// Mirrors the Check id rule in src/shared/checks.ts.
const checkIdPattern = /^check-[a-z0-9][a-z0-9-]{7,154}$/;
const routingIdPattern = /^routing-[a-z0-9][a-z0-9-]{7,154}$/;
// Mirrors the restricted-app manifest id rule for app and automation ids.
const restrictedAppIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const stepIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const extensionPattern = /^\.[a-z0-9][a-z0-9._+-]*$/;
// Tabs and newlines are ordinary message text; other C0/C1 controls and
// bidirectional overrides would defeat the verbatim review at enablement.
const forbiddenMessageCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const inadmissibleOutcomeReasons = new Map<string, string>([
  ["interrupted", "it records a crashed run, not a result"],
  ["skipped", "it is a lifecycle artifact of non-overlap and suspension"],
  ["cancelled", "it is a lifecycle artifact of shutdown and revocation"],
]);

export function normalizeWorkFoldRoutingProposal(value: unknown): WorkFoldRoutingProposal {
  const record = objectRecord(value, "Routing proposal must be a JSON object.");
  assertKeys(record, ["kind", "version", "name", "createdBy", "createdAt", "routing"], [], "Routing proposal");
  if (record.kind !== workFoldRoutingProposalKind) throw new Error(`Routing proposal kind must be ${workFoldRoutingProposalKind}.`);
  const version = contractVersion(record.version, "Routing proposal");
  return {
    kind: workFoldRoutingProposalKind,
    version,
    name: boundedText(record.name, "Routing proposal name", 120),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Routing proposal createdAt"),
    routing: normalizeRoutingDefinition(record.routing, version),
  };
}

export function normalizeWorkFoldRoutingDeclaration(value: unknown): WorkFoldRoutingDeclaration {
  const record = objectRecord(value, "Routing declaration must be a JSON object.");
  assertKeys(
    record,
    ["kind", "version", "id", "title", "trigger", "steps", "createdBy", "createdAt"],
    [],
    "Routing declaration",
  );
  if (record.kind !== workFoldRoutingDeclarationKind) throw new Error(`Routing declaration kind must be ${workFoldRoutingDeclarationKind}.`);
  const version = contractVersion(record.version, "Routing declaration");
  return {
    kind: workFoldRoutingDeclarationKind,
    version,
    id: routingId(record.id),
    ...normalizeRoutingDefinition({ title: record.title, trigger: record.trigger, steps: record.steps }, version),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Routing declaration createdAt"),
  };
}

export function declarationFromWorkFoldRoutingProposal(
  proposal: WorkFoldRoutingProposal,
  id = `routing-${randomUUID()}`,
): WorkFoldRoutingDeclaration {
  return normalizeWorkFoldRoutingDeclaration({
    kind: workFoldRoutingDeclarationKind,
    version: proposal.version,
    id,
    ...proposal.routing,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

/**
 * The digest that pins a routing: enablement records an exact-authority grant
 * over it, receipts carry it, and any edit changes it — an edited routing
 * never coasts on a stale approval. Canonicalization is the same stable JSON
 * used for Check digests, so field order can never change authority.
 */
export function workFoldRoutingDigest(value: unknown): string {
  return workFoldCheckDigest(value);
}

/**
 * Every Space a routing names, across its trigger source and all steps,
 * sorted and deduplicated. Removing any of them revokes the enablement grant
 * and suspends the routing.
 */
export function workFoldRoutingReferencedSpaceIds(definition: WorkFoldRoutingDefinition): string[] {
  const ids = new Set<string>();
  if (definition.trigger.kind === "on-settled") ids.add(definition.trigger.source.space);
  for (const step of definition.steps) {
    if (step.kind === "files") {
      ids.add(step.fromSpace);
      ids.add(step.toSpace);
    } else {
      ids.add(step.space);
    }
  }
  return [...ids].sort();
}

/**
 * Rechecks the time-sensitive one-time horizon at authority admission. The
 * declaration parser validates only the stable shape because a stored inert
 * proposal must not become syntactically damaged merely as time passes.
 */
export function assertWorkFoldRoutingAtAdmissionHorizon(
  definition: Pick<WorkFoldRoutingDefinition, "trigger">,
  now: Date,
): void {
  if (definition.trigger.kind !== "at") return;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Routing admission time is invalid.");
  const advanceMs = Date.parse(definition.trigger.at) - nowMs;
  if (advanceMs < workFoldRoutingBounds.minAtAdvanceMs || advanceMs > workFoldRoutingBounds.maxAtAdvanceMs) {
    throw new Error("Routing one-time trigger must be between 1 minute and 366 days in the future when it is enabled.");
  }
}

export async function readWorkFoldRoutingProposal(path: string): Promise<WorkFoldRoutingProposal> {
  const resolved = resolve(path);
  return normalizeWorkFoldRoutingProposal(JSON.parse(await readBoundedOrdinaryFile(resolved)));
}

function normalizeRoutingDefinition(value: unknown, version: WorkFoldRoutingContractVersion): WorkFoldRoutingDefinition {
  const record = objectRecord(value, "Routing definition must be a JSON object.");
  assertKeys(record, ["title", "trigger", "steps"], [], "Routing definition");
  if (!Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > workFoldRoutingBounds.maxSteps) {
    throw new Error(`Routing steps must contain between 1 and ${workFoldRoutingBounds.maxSteps} steps.`);
  }
  const steps = record.steps.map((step, index) => normalizeStep(step, index));
  const positions = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (positions.has(step.id)) throw new Error(`Routing steps contain duplicate id "${step.id}".`);
    positions.set(step.id, index);
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind !== "files" || step.from.kind !== "step-created-files") continue;
    const label = `Routing step "${step.id}"`;
    const sourceIndex = positions.get(step.from.step);
    if (sourceIndex === undefined) throw new Error(`${label} names unknown source step "${step.from.step}".`);
    if (sourceIndex >= index) {
      throw new Error(`${label} must take created files from an earlier step; self and forward references would make the routing cyclic.`);
    }
    const source = steps[sourceIndex]!;
    if (source.kind !== "chat") throw new Error(`${label} must take created files from an earlier chat step.`);
    if (source.space !== step.fromSpace) {
      throw new Error(`${label} must copy from Space ${source.space}, where its source chat step runs.`);
    }
  }
  return {
    title: boundedText(record.title, "Routing title", 160),
    trigger: normalizeTrigger(record.trigger, version),
    steps,
  };
}

function normalizeTrigger(value: unknown, version: WorkFoldRoutingContractVersion): WorkFoldRoutingTrigger {
  const record = objectRecord(value, "Routing trigger must be a JSON object.");
  if (record.kind === "manual") {
    assertKeys(record, ["kind"], [], "Routing manual trigger");
    return { kind: "manual" };
  }
  if (record.kind === "interval") {
    assertKeys(record, ["kind", "intervalMinutes"], [], "Routing interval trigger");
    return {
      kind: "interval",
      intervalMinutes: boundedInteger(
        record.intervalMinutes,
        "Routing interval minutes",
        workFoldRoutingBounds.minIntervalMinutes,
        workFoldRoutingBounds.maxIntervalMinutes,
      ),
    };
  }
  if (record.kind === "at") {
    if (version < 2) throw new Error("Routing one-time triggers require contract version 2.");
    assertKeys(record, ["kind", "at", "ifMissed"], [], "Routing one-time trigger");
    if (record.ifMissed !== "run" && record.ifMissed !== "skip") {
      throw new Error('Routing one-time trigger ifMissed must be "run" or "skip".');
    }
    return {
      kind: "at",
      at: explicitOffsetTimestamp(record.at, "Routing one-time trigger at"),
      ifMissed: record.ifMissed,
    };
  }
  if (record.kind === "on-settled") {
    assertKeys(record, ["kind", "source"], [], "Routing on-settled trigger");
    return { kind: "on-settled", source: normalizeSettleSource(record.source) };
  }
  throw new Error(version >= 2
    ? "Routing trigger kind must be manual, interval, at, or on-settled."
    : "Routing trigger kind must be manual, interval, or on-settled.");
}

function normalizeSettleSource(value: unknown): WorkFoldRoutingSettleSource {
  const record = objectRecord(value, "Routing trigger source must be a JSON object.");
  if (record.kind === "check-run") {
    assertKeys(record, ["kind", "space"], ["check", "outcomes"], "Routing check-run trigger source");
    return {
      kind: "check-run",
      space: spaceId(record.space, "Routing check-run trigger source space"),
      ...(record.check !== undefined ? { check: checkRef(record.check, "Routing check-run trigger source check") } : {}),
      outcomes: normalizeOutcomes(record.outcomes, "Routing check-run trigger source", workFoldRoutingCheckRunOutcomes, ["succeeded"]),
    };
  }
  if (record.kind === "app-automation-run") {
    assertKeys(record, ["kind", "space", "appId", "automationId"], ["outcomes"], "Routing app-automation-run trigger source");
    return {
      kind: "app-automation-run",
      space: spaceId(record.space, "Routing app-automation-run trigger source space"),
      appId: restrictedAppId(record.appId, "Routing app-automation-run trigger source appId"),
      automationId: restrictedAppId(record.automationId, "Routing app-automation-run trigger source automationId"),
      outcomes: normalizeOutcomes(record.outcomes, "Routing app-automation-run trigger source", workFoldRoutingAutomationRunOutcomes, ["success"]),
    };
  }
  throw new Error("Routing trigger source kind must be check-run or app-automation-run.");
}

function normalizeStep(value: unknown, index: number): WorkFoldRoutingStep {
  const label = `Routing step ${index + 1}`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  if (record.kind === "chat") {
    assertKeys(record, ["id", "kind", "space", "message"], [], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "chat",
      space: spaceId(record.space, `${label} space`),
      message: boundedMessage(record.message, `${label} message`),
    };
  }
  if (record.kind === "files") {
    assertKeys(record, ["id", "kind", "fromSpace", "from", "toSpace", "to"], [], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "files",
      fromSpace: spaceId(record.fromSpace, `${label} fromSpace`),
      from: normalizeFilesSource(record.from, label),
      toSpace: spaceId(record.toSpace, `${label} toSpace`),
      to: normalizeWorkFoldCheckTargetPath(record.to, `${label} destination`),
    };
  }
  if (record.kind === "check") {
    assertKeys(record, ["id", "kind", "space"], ["check"], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "check",
      space: spaceId(record.space, `${label} space`),
      ...(record.check !== undefined ? { check: checkRef(record.check, `${label} check`) } : {}),
    };
  }
  throw new Error(`${label} kind must be chat, files, or check.`);
}

function normalizeFilesSource(value: unknown, stepLabel: string): WorkFoldRoutingFilesSource {
  const label = `${stepLabel} source`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  if (record.kind === "paths") {
    assertKeys(record, ["kind", "paths"], [], label);
    if (!Array.isArray(record.paths) || record.paths.length < 1 || record.paths.length > workFoldRoutingBounds.maxExactPathsPerFilesStep) {
      throw new Error(`${label} paths must contain between 1 and ${workFoldRoutingBounds.maxExactPathsPerFilesStep} exact file paths.`);
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
      maxFiles: boundedInteger(record.maxFiles, `${label} maxFiles`, 1, workFoldRoutingBounds.maxHandoffFiles),
      maxTotalBytes: boundedInteger(record.maxTotalBytes, `${label} maxTotalBytes`, 1, workFoldRoutingBounds.maxHandoffTotalBytes),
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
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new Error(`${label} extensions must contain between 1 and 24 file extensions.`);
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
  if (Buffer.byteLength(message, "utf8") > workFoldRoutingBounds.maxChatMessageBytes) {
    throw new Error(`${label} exceeds ${workFoldRoutingBounds.maxChatMessageBytes} bytes.`);
  }
  if (forbiddenMessageCharacters.test(message)) {
    throw new Error(`${label} contains control or direction-override characters that would defeat verbatim review.`);
  }
  return message;
}

function spaceId(value: unknown, label: string): string {
  if (typeof value !== "string" || !spaceIdPattern.test(value)) {
    throw new Error(`${label} must be a stable registered Space id, not a name or path.`);
  }
  return value;
}

function checkRef(value: unknown, label: string): string {
  const id = boundedText(value, label, 160).toLocaleLowerCase("en-US");
  if (!checkIdPattern.test(id)) throw new Error(`${label} must be a Check id.`);
  return id;
}

function routingId(value: unknown): string {
  const id = boundedText(value, "Routing id", 160).toLocaleLowerCase("en-US");
  if (!routingIdPattern.test(id)) throw new Error("Routing id is invalid.");
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

function normalizeCreator(value: unknown): WorkFoldRoutingProposal["createdBy"] {
  if (value === "human" || value === "assistant" || value === "codex" || value === "claude-code" || value === "other") return value;
  throw new Error("Routing proposal createdBy is invalid.");
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

function contractVersion(value: unknown, label: string): WorkFoldRoutingContractVersion {
  if (!(workFoldRoutingSupportedContractVersions as readonly unknown[]).includes(value)) {
    throw new Error(`${label} uses unsupported version ${String(value)}.`);
  }
  return value as WorkFoldRoutingContractVersion;
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

async function readBoundedOrdinaryFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Routing document must be an ordinary file, not a link or special file.");
  if (info.size > maximumProposalBytes) throw new Error(`Routing document exceeds ${maximumProposalBytes} bytes.`);
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const afterOpen = await handle.stat();
    if (!afterOpen.isFile() || afterOpen.dev !== info.dev || afterOpen.ino !== info.ino) throw new Error("Routing document changed while it was opened.");
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source, "utf8") > maximumProposalBytes) throw new Error(`Routing document exceeds ${maximumProposalBytes} bytes.`);
    return source;
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
