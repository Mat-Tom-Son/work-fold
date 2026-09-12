import type { WorkFoldCliActUndoRef } from "./cli/act-receipts.js";
import type {
  WorkFoldExperimentalFoldActTask,
  WorkFoldExperimentalFoldActTaskInput,
} from "./work-fold-kernel.js";

/**
 * Prepared acts (docs/receipts-not-gates.md, F19): the closed kind vocabulary
 * behind every verb that installs code, widens a power, or destroys data,
 * reduced to what a receipted act needs — typed parameters, pinned
 * identities, an effect-time recheck against live state, the capability
 * fence, and one internal kernel task around the execution. There is no
 * store, no pending state, and no decision: the calling verb prepares the act
 * from live state, the act executor journals the request first
 * (src/local/cli/act-commands.ts, `runDesktopSettingsAct` in server.ts), and
 * this executor runs it at once. Journaling stays with those callers so the
 * accepted line always precedes the effect and a replayed request id is
 * refused before anything here runs.
 */

/**
 * Prepared-act fields are closed, flat, and typed — exact ids, paths,
 * digests, scopes, and host-composed one-line summaries. No free-form
 * payloads, no nesting, no secrets: `app.connection.save` names only the
 * connection's shape, and the field vocabulary has nowhere to put a
 * credential.
 */
export type FoldPreparedActFieldValue = string | number | boolean | readonly string[];

export type FoldPreparedActFields = Readonly<Record<string, FoldPreparedActFieldValue>>;

export type FoldPreparedActFieldType = "string" | "number" | "boolean" | "string-list";

export interface FoldPreparedActFieldSpec {
  type: FoldPreparedActFieldType;
  required: boolean;
  values?: readonly string[];
}

export interface FoldPreparedActKindDescriptor {
  parameters: Readonly<Record<string, FoldPreparedActFieldSpec>>;
  pins: Readonly<Record<string, FoldPreparedActFieldSpec>>;
}

const CAPABILITY_SCOPES = ["personal", "space"] as const;
const VIEWER_EXPOSURES = ["page", "hosted-app"] as const;

function req(type: FoldPreparedActFieldType, values?: readonly string[]): FoldPreparedActFieldSpec {
  return values ? { type, required: true, values } : { type, required: true };
}

function opt(type: FoldPreparedActFieldType, values?: readonly string[]): FoldPreparedActFieldSpec {
  return values ? { type, required: false, values } : { type, required: false };
}

/**
 * One descriptor per kind: the typed parameters the calling verb supplies
 * and the pinned identities the effect-time recheck verifies. Unknown kinds
 * fail closed, so adding one is a deliberate contract change.
 */
const KIND_DESCRIPTORS = {
  "capability.resource.enabled": {
    parameters: { path: req("string"), kind: req("string", ["extensions", "skills", "prompts", "themes"]), enabled: req("boolean"), scope: req("string", CAPABILITY_SCOPES), spaceId: opt("string") },
    pins: { path: req("string"), digest: req("string"), scope: req("string", CAPABILITY_SCOPES) },
  },
  "app.review.install": {
    parameters: { spaceId: req("string"), proposalId: req("string") },
    pins: { proposalId: req("string"), reviewDigest: req("string") },
  },
  "capability.package.install": {
    parameters: {
      source: opt("string"),
      catalogId: opt("string"),
      scope: req("string", CAPABILITY_SCOPES),
      spaceId: opt("string"),
    },
    pins: {
      packageId: req("string"),
      version: req("string"),
      source: req("string"),
      scope: req("string", CAPABILITY_SCOPES),
      resourceSummary: req("string"),
    },
  },
  "capability.package.update": {
    parameters: {
      source: opt("string"),
      catalogId: opt("string"),
      scope: req("string", CAPABILITY_SCOPES),
      spaceId: opt("string"),
    },
    pins: {
      packageId: req("string"),
      version: req("string"),
      source: req("string"),
      scope: req("string", CAPABILITY_SCOPES),
      resourceSummary: req("string"),
    },
  },
  "capability.skills.import": {
    parameters: {
      source: req("string"),
      scope: req("string", CAPABILITY_SCOPES),
      spaceId: opt("string"),
    },
    pins: {
      source: req("string"),
      contentDigest: req("string"),
      skillNames: req("string-list"),
    },
  },
  "app.grant.network": {
    parameters: { spaceId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.grant.files": {
    parameters: { spaceId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.grant.notifications": {
    parameters: { spaceId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.connection.save": {
    parameters: { spaceId: req("string"), appInstanceId: req("string"), destinationId: req("string") },
    pins: {
      appInstanceId: req("string"),
      declarationId: req("string"),
      target: req("string"),
      adapterKind: req("string"),
    },
  },
  "app.automation.enable": {
    parameters: { spaceId: req("string"), appInstanceId: req("string"), automationId: req("string") },
    pins: {
      appInstanceId: req("string"),
      automationId: req("string"),
      reviewedDigest: req("string"),
      scheduleSummary: req("string"),
    },
  },
  "routing.enable": {
    parameters: { routingId: req("string") },
    pins: { routingId: req("string"), declarationDigest: req("string") },
  },
  "publish.viewer.expose": {
    parameters: {
      exposure: req("string", VIEWER_EXPOSURES),
      spaceId: opt("string"),
      appInstanceId: opt("string"),
    },
    pins: {
      exposure: req("string", VIEWER_EXPOSURES),
      spaceId: opt("string"),
      relativePath: opt("string"),
      title: opt("string"),
      snapshotEnabled: opt("boolean"),
      byteBudget: opt("number"),
      serveBudget: opt("number"),
      appInstanceId: opt("string"),
      releaseDigest: opt("string"),
      viewerEntry: opt("string"),
      viewerSurface: opt("string-list"),
      priorBindingSummary: opt("string"),
      priorByteBudget: opt("number"),
      priorServeBudget: opt("number"),
      priorReleaseDigest: opt("string"),
      priorViewerSurface: opt("string-list"),
    },
  },
  "space.delete-folder": {
    parameters: { spaceId: req("string") },
    pins: { spaceId: req("string"), spaceRoot: req("string") },
  },
  "app.data.purge": {
    parameters: {
      spaceId: req("string"),
      appInstanceId: req("string"),
      purgeTarget: opt("string", ["retained", "runtime-instance"]),
    },
    pins: {
      appInstanceId: req("string"),
      dataNamespaceIds: req("string-list"),
      retainedDataId: opt("string"),
      runtimeInstanceId: opt("string"),
      sourceSpaceId: opt("string"),
    },
  },
  "app.storage.clear": {
    parameters: { spaceId: req("string"), appInstanceId: req("string") },
    pins: {
      appInstanceId: req("string"),
      dataNamespaceIds: req("string-list"),
      observedBytes: req("number"),
    },
  },
} satisfies Record<string, FoldPreparedActKindDescriptor>;

export type FoldPreparedActKind = keyof typeof KIND_DESCRIPTORS;

export const FOLD_PREPARED_ACT_KINDS = Object.keys(KIND_DESCRIPTORS) as readonly FoldPreparedActKind[];

export const FOLD_PREPARED_ACT_KIND_DESCRIPTORS: Readonly<Record<FoldPreparedActKind, FoldPreparedActKindDescriptor>> =
  KIND_DESCRIPTORS;

/** One prepared act: validated, cloned, and frozen typed fields for a known kind. */
export interface FoldPreparedAct {
  kind: FoldPreparedActKind;
  parameters: FoldPreparedActFields;
  pins: FoldPreparedActFields;
}

export interface FoldPreparedActInput {
  kind: FoldPreparedActKind;
  parameters: FoldPreparedActFields;
  pins: FoldPreparedActFields;
}

export type FoldPreparedActErrorCode =
  | "KIND_UNKNOWN"
  | "INPUT_INVALID"
  /** A pinned identity no longer matches live state; nothing executed. */
  | "PIN_MISMATCH"
  /** No execution adapter is bound for this kind in this build; nothing executed. */
  | "EXECUTION_UNAVAILABLE";

export class FoldPreparedActError extends Error {
  readonly code: FoldPreparedActErrorCode;

  constructor(code: FoldPreparedActErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FoldPreparedActError";
    this.code = code;
  }
}

/**
 * Validates the typed fields against the kind's descriptor and returns a
 * frozen copy. Every field is checked before anything is executed: unknown
 * kinds, unknown or malformed fields, and a parameter/pin identity mismatch
 * are typed refusals.
 */
export function prepareFoldAct(input: FoldPreparedActInput): FoldPreparedAct {
  const descriptor = descriptorFor(input.kind);
  if (!descriptor) {
    throw new FoldPreparedActError(
      "KIND_UNKNOWN",
      `work-fold does not know the act kind "${String(input.kind)}"; the kind vocabulary is closed and unknown kinds fail closed.`,
    );
  }
  const inputIssue = fieldsIssue(input.kind, "parameters", input.parameters)
    ?? fieldsIssue(input.kind, "pins", input.pins);
  if (inputIssue) throw new FoldPreparedActError("INPUT_INVALID", `work-fold refused this act: ${inputIssue}`);
  const parameters = cloneFields(input.parameters);
  const pins = cloneFields(input.pins);
  const sharedIssue = sharedFieldIssue(parameters, pins);
  if (sharedIssue) throw new FoldPreparedActError("INPUT_INVALID", `work-fold refused this act: ${sharedIssue}`);
  return Object.freeze({ kind: input.kind, parameters: Object.freeze(parameters), pins: Object.freeze(pins) });
}

/** The Space a prepared act mutates, when it names one. */
export function foldPreparedActSpaceId(act: FoldPreparedAct): string | undefined {
  const value = act.parameters.spaceId ?? act.pins.spaceId;
  return typeof value === "string" ? value : undefined;
}

/** The capability-mutation scope an execution reserves. */
export type FoldActFenceScope =
  | { scope: "global" }
  | { scope: "space"; spaceId: string };

/**
 * Injectable seam over the local API's capability-mutation reservation
 * (`runCapabilityMutation` / `runRestrictedAppMutation` in
 * src/local/server.ts): reserves the scope for the operation and releases it
 * on every outcome, exactly as the equivalent desktop route would. A busy
 * scope refuses with the routes' own conflict.
 */
export interface FoldActFence {
  run<T>(scope: FoldActFenceScope, operation: () => Promise<T>): Promise<T>;
}

/** The kernel surface the executor needs: one internal task per execution. */
export interface FoldActKernelSeam {
  startExperimentalFoldActTask(input: WorkFoldExperimentalFoldActTaskInput): WorkFoldExperimentalFoldActTask;
  finishTask(taskId: string): boolean;
}

/**
 * Typed identifiers an execution hands back for the terminal receipt.
 * Identifiers and short host-composed lines only — receipts never grow file
 * contents, credentials, or model prose.
 */
export interface FoldPreparedActEffect {
  detail?: string;
  checkpointId?: string;
  taskId?: string;
  undoRef?: WorkFoldCliActUndoRef;
}

/**
 * One per-kind execution adapter: the bridge from a prepared act's typed pins
 * to the same domain service the equivalent desktop action uses. `context`
 * carries execution inputs the calling verb already validated that are not
 * flat receipt fields (a normalized routing declaration, a resolved app
 * record); receipts never grow from it.
 */
export interface FoldPreparedActAdapter<Context = unknown> {
  /**
   * Re-verifies every pinned identity against current state immediately
   * before execution, inside the fence. A returned reason refuses the act as
   * a pin mismatch; nothing executes.
   */
  recheckPins(act: FoldPreparedAct, context: Context): Promise<string | null> | string | null;
  /** Runs the same mutation the equivalent desktop action runs. */
  execute(act: FoldPreparedAct, context: Context): Promise<FoldPreparedActEffect | void>;
  /**
   * The capability-fence scope the execution reserves. Omit for the default
   * (the act's Space, or global when the act names none). Return null when
   * the bound execution path performs its own reservation — reserving twice
   * for the same Space would deadlock against the server's mutation state.
   */
  fenceScope?(act: FoldPreparedAct): FoldActFenceScope | null;
}

export type FoldPreparedActAdapters = Partial<Record<FoldPreparedActKind, FoldPreparedActAdapter>>;

/** Default fence scope: the act's Space when it names one, otherwise global. */
export function foldPreparedActFenceScope(act: FoldPreparedAct): FoldActFenceScope {
  const spaceId = foldPreparedActSpaceId(act);
  return spaceId ? { scope: "space", spaceId } : { scope: "global" };
}

export interface FoldPreparedActExecutorOptions {
  adapters: FoldPreparedActAdapters;
  fence: FoldActFence;
  kernel: FoldActKernelSeam;
}

export interface FoldPreparedActRunInput {
  act: FoldPreparedAct;
  /** The journaled request id of the act being performed. */
  requestId: string;
  context?: unknown;
}

/**
 * The prepare → pin recheck → execute path every formerly gated verb takes:
 * resolve the adapter (an unbound kind refuses before anything runs),
 * reserve the fence, recheck every pin against live state, start one
 * internal `fold_act` kernel task, execute through the bound domain path,
 * and finish the task on every outcome so no ghost task survives. A refusal
 * or a failed execution is never retried here; the caller's receipts record
 * it and a second attempt is a fresh request id.
 */
export class FoldPreparedActExecutor {
  readonly #adapters: FoldPreparedActAdapters;
  readonly #fence: FoldActFence;
  readonly #kernel: FoldActKernelSeam;

  constructor(options: FoldPreparedActExecutorOptions) {
    this.#adapters = options.adapters;
    this.#fence = options.fence;
    this.#kernel = options.kernel;
  }

  async run(input: FoldPreparedActRunInput): Promise<FoldPreparedActEffect> {
    const { act } = input;
    const requestId = input.requestId.trim();
    if (!requestId) throw new FoldPreparedActError("INPUT_INVALID", "work-fold refused this act: a request id is required.");
    const adapter = this.#adapters[act.kind] as FoldPreparedActAdapter | undefined;
    if (!adapter) {
      throw new FoldPreparedActError(
        "EXECUTION_UNAVAILABLE",
        `work-fold cannot perform "${act.kind}" acts in this build; nothing was changed.`,
      );
    }
    const scope = adapter.fenceScope ? adapter.fenceScope(act) : foldPreparedActFenceScope(act);
    const perform = async (): Promise<FoldPreparedActEffect> => {
      const pinIssue = await adapter.recheckPins(act, input.context);
      if (pinIssue) {
        throw new FoldPreparedActError("PIN_MISMATCH", `This act no longer matches live state, so nothing was changed: ${pinIssue}`);
      }
      const spaceId = foldPreparedActSpaceId(act);
      const task = this.#kernel.startExperimentalFoldActTask({
        ...(spaceId ? { spaceId } : {}),
        requestId,
        kind: act.kind,
        actor: { kind: "system" },
      });
      try {
        const effect = await adapter.execute(act, input.context);
        return { taskId: task.id, ...(effect ?? {}) };
      } finally {
        this.#kernel.finishTask(task.id);
      }
    };
    return scope ? await this.#fence.run(scope, perform) : await perform();
  }
}

const MAX_TEXT_CHARS = 2048;
const MAX_LIST_ITEMS = 256;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

type FieldSection = "parameters" | "pins";

function descriptorFor(kind: string): FoldPreparedActKindDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(KIND_DESCRIPTORS, kind)
    ? KIND_DESCRIPTORS[kind as FoldPreparedActKind]
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textIssue(value: unknown, label: string): string | null {
  if (typeof value !== "string") return `${label} must be a string.`;
  if (!value.trim() || value.length > MAX_TEXT_CHARS) return `${label} must be 1-${MAX_TEXT_CHARS} characters.`;
  if (FORBIDDEN_TEXT.test(value)) return `${label} must not contain control or direction-override characters.`;
  return null;
}

function fieldValueIssue(value: unknown, spec: FoldPreparedActFieldSpec, label: string): string | null {
  switch (spec.type) {
    case "string": {
      const issue = textIssue(value, label);
      if (issue) return issue;
      if (spec.values && !spec.values.includes(value as string)) {
        return `${label} must be one of: ${spec.values.join(", ")}.`;
      }
      return null;
    }
    case "number":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? null
        : `${label} must be a non-negative integer.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${label} must be a boolean.`;
    case "string-list": {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
        return `${label} must list 1-${MAX_LIST_ITEMS} entries.`;
      }
      for (const entry of value) {
        const issue = textIssue(entry, `each ${label} entry`);
        if (issue) return issue;
      }
      return null;
    }
  }
}

function fieldsIssue(kind: FoldPreparedActKind, section: FieldSection, value: unknown): string | null {
  const descriptor = descriptorFor(kind);
  if (!descriptor) return `unknown kind ${String(kind)}.`;
  const spec = descriptor[section];
  if (!isPlainRecord(value)) return `${section} must be an object of typed fields.`;
  for (const name of Object.keys(value)) {
    if (value[name] === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(spec, name)) {
      return `${section}.${name} is not a typed field of ${kind}; the field vocabulary is closed.`;
    }
  }
  for (const [name, fieldSpec] of Object.entries(spec)) {
    if (value[name] === undefined) {
      if (fieldSpec.required) return `${section}.${name} is required for ${kind}.`;
      continue;
    }
    const issue = fieldValueIssue(value[name], fieldSpec, `${section}.${name}`);
    if (issue) return issue;
  }
  return crossFieldIssue(kind, section, value as Record<string, FoldPreparedActFieldValue>);
}

function crossFieldIssue(
  kind: FoldPreparedActKind,
  section: FieldSection,
  fields: Record<string, FoldPreparedActFieldValue>,
): string | null {
  if (kind === "capability.package.install" || kind === "capability.package.update") {
    if (section !== "parameters") return null;
    if ((fields.source === undefined) === (fields.catalogId === undefined)) {
      return `${section} must name exactly one of source or catalogId.`;
    }
    return scopedSpaceIssue(section, fields);
  }
  if ((kind === "capability.skills.import" || kind === "capability.resource.enabled") && section === "parameters") {
    return scopedSpaceIssue(section, fields);
  }
  if (kind === "publish.viewer.expose") return exposureIssue(section, fields);
  return null;
}

function scopedSpaceIssue(section: FieldSection, fields: Record<string, FoldPreparedActFieldValue>): string | null {
  if (fields.scope === "space" && fields.spaceId === undefined) {
    return `${section}.spaceId is required at Space scope.`;
  }
  if (fields.scope === "personal" && fields.spaceId !== undefined) {
    return `${section}.spaceId must be absent at Personal scope.`;
  }
  return null;
}

function exposureIssue(section: FieldSection, fields: Record<string, FoldPreparedActFieldValue>): string | null {
  const page = fields.exposure === "page";
  const required = section === "parameters"
    ? (page ? ["spaceId"] : ["appInstanceId"])
    : (page
      ? ["spaceId", "relativePath", "title", "snapshotEnabled", "byteBudget", "serveBudget"]
      : ["appInstanceId", "releaseDigest", "viewerEntry", "viewerSurface"]);
  const foreign = section === "parameters"
    ? (page ? ["appInstanceId"] : ["spaceId"])
    : (page
      ? ["appInstanceId", "releaseDigest", "viewerEntry", "viewerSurface", "priorReleaseDigest", "priorViewerSurface"]
      : ["spaceId", "relativePath", "title", "snapshotEnabled", "byteBudget", "serveBudget", "priorByteBudget", "priorServeBudget"]);
  const exposure = String(fields.exposure);
  for (const name of required) {
    if (fields[name] === undefined) return `${section}.${name} is required for ${exposure} exposure.`;
  }
  for (const name of foreign) {
    if (fields[name] !== undefined) return `${section}.${name} does not belong to ${exposure} exposure.`;
  }
  return null;
}

/** Fields present in both sections must pin the same identity. */
function sharedFieldIssue(parameters: FoldPreparedActFields, pins: FoldPreparedActFields): string | null {
  for (const [name, value] of Object.entries(parameters)) {
    const pinned = pins[name];
    if (value === undefined || pinned === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(pinned)) {
      return `parameters.${name} and pins.${name} must name the same identity.`;
    }
  }
  return null;
}

function cloneFields(fields: FoldPreparedActFields): FoldPreparedActFields {
  const clean: Record<string, FoldPreparedActFieldValue> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    clean[name] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return clean;
}
