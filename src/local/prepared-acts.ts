import type { WorkFoldCliActUndoRef } from "./cli/act-receipts.js";
import type {
  WorkFoldExperimentalPreparedActTask,
  WorkFoldExperimentalPreparedActTaskInput,
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
export type PreparedActFieldValue = string | number | boolean | readonly string[];

export type PreparedActFields = Readonly<Record<string, PreparedActFieldValue>>;

export type PreparedActFieldType = "string" | "number" | "boolean" | "string-list";

export interface PreparedActFieldSpec {
  type: PreparedActFieldType;
  required: boolean;
  values?: readonly string[];
}

export interface PreparedActKindDescriptor {
  parameters: Readonly<Record<string, PreparedActFieldSpec>>;
  pins: Readonly<Record<string, PreparedActFieldSpec>>;
}

const CAPABILITY_SCOPES = ["everywhere", "work-folder"] as const;
const VIEWER_EXPOSURES = ["page", "hosted-app"] as const;

function req(type: PreparedActFieldType, values?: readonly string[]): PreparedActFieldSpec {
  return values ? { type, required: true, values } : { type, required: true };
}

function opt(type: PreparedActFieldType, values?: readonly string[]): PreparedActFieldSpec {
  return values ? { type, required: false, values } : { type, required: false };
}

/**
 * One descriptor per kind: the typed parameters the calling verb supplies
 * and the pinned identities the effect-time recheck verifies. Unknown kinds
 * fail closed, so adding one is a deliberate contract change.
 */
const KIND_DESCRIPTORS = {
  "capability.resource.enabled": {
    parameters: { path: req("string"), kind: req("string", ["extensions", "skills", "prompts", "themes"]), enabled: req("boolean"), scope: req("string", CAPABILITY_SCOPES), workFolderId: opt("string") },
    pins: { path: req("string"), digest: req("string"), scope: req("string", CAPABILITY_SCOPES) },
  },
  "app.review.install": {
    parameters: { workFolderId: req("string"), proposalId: req("string") },
    pins: { proposalId: req("string"), reviewDigest: req("string") },
  },
  "capability.package.install": {
    parameters: {
      source: opt("string"),
      catalogId: opt("string"),
      scope: req("string", CAPABILITY_SCOPES),
      workFolderId: opt("string"),
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
      workFolderId: opt("string"),
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
      workFolderId: opt("string"),
    },
    pins: {
      source: req("string"),
      contentDigest: req("string"),
      skillNames: req("string-list"),
    },
  },
  "app.grant.network": {
    parameters: { workFolderId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.grant.files": {
    parameters: { workFolderId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.grant.notifications": {
    parameters: { workFolderId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.connection.save": {
    parameters: { workFolderId: req("string"), appInstanceId: req("string"), destinationId: req("string") },
    pins: {
      appInstanceId: req("string"),
      declarationId: req("string"),
      target: req("string"),
      adapterKind: req("string"),
    },
  },
  "app.automation.enable": {
    parameters: { workFolderId: req("string"), appInstanceId: req("string"), appAutomationId: req("string") },
    pins: {
      appInstanceId: req("string"),
      appAutomationId: req("string"),
      reviewedDigest: req("string"),
      scheduleSummary: req("string"),
    },
  },
  "automation.enable": {
    parameters: { automationId: req("string") },
    pins: { automationId: req("string"), declarationDigest: req("string") },
  },
  "publish.viewer.expose": {
    parameters: {
      exposure: req("string", VIEWER_EXPOSURES),
      workFolderId: opt("string"),
      appInstanceId: opt("string"),
    },
    pins: {
      exposure: req("string", VIEWER_EXPOSURES),
      workFolderId: opt("string"),
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
  "work-folder.delete-folder": {
    parameters: { workFolderId: req("string") },
    pins: { workFolderId: req("string"), workFolderRoot: req("string") },
  },
  "app.data.purge": {
    parameters: {
      workFolderId: req("string"),
      appInstanceId: req("string"),
      purgeTarget: opt("string", ["retained", "runtime-instance"]),
    },
    pins: {
      appInstanceId: req("string"),
      dataNamespaceIds: req("string-list"),
      retainedDataId: opt("string"),
      runtimeInstanceId: opt("string"),
      sourceWorkFolderId: opt("string"),
    },
  },
  "app.storage.clear": {
    parameters: { workFolderId: req("string"), appInstanceId: req("string") },
    pins: {
      appInstanceId: req("string"),
      dataNamespaceIds: req("string-list"),
      observedBytes: req("number"),
    },
  },
} satisfies Record<string, PreparedActKindDescriptor>;

export type PreparedActKind = keyof typeof KIND_DESCRIPTORS;

export const PREPARED_ACT_KINDS = Object.keys(KIND_DESCRIPTORS) as readonly PreparedActKind[];
/** One prepared act: validated, cloned, and frozen typed fields for a known kind. */
export interface PreparedAct {
  kind: PreparedActKind;
  parameters: PreparedActFields;
  pins: PreparedActFields;
}

export interface PreparedActInput {
  kind: PreparedActKind;
  parameters: PreparedActFields;
  pins: PreparedActFields;
}

export type PreparedActErrorCode =
  | "KIND_UNKNOWN"
  | "INPUT_INVALID"
  /** A pinned identity no longer matches live state; nothing executed. */
  | "PIN_MISMATCH"
  /** No execution adapter is bound for this kind in this build; nothing executed. */
  | "EXECUTION_UNAVAILABLE";

export class PreparedActError extends Error {
  readonly code: PreparedActErrorCode;

  constructor(code: PreparedActErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PreparedActError";
    this.code = code;
  }
}

/**
 * Validates the typed fields against the kind's descriptor and returns a
 * frozen copy. Every field is checked before anything is executed: unknown
 * kinds, unknown or malformed fields, and a parameter/pin identity mismatch
 * are typed refusals.
 */
export function prepareAct(input: PreparedActInput): PreparedAct {
  const descriptor = descriptorFor(input.kind);
  if (!descriptor) {
    throw new PreparedActError(
      "KIND_UNKNOWN",
      `work-fold does not know the act kind "${String(input.kind)}"; the kind vocabulary is closed and unknown kinds fail closed.`,
    );
  }
  const inputIssue = fieldsIssue(input.kind, "parameters", input.parameters)
    ?? fieldsIssue(input.kind, "pins", input.pins);
  if (inputIssue) throw new PreparedActError("INPUT_INVALID", `work-fold refused this act: ${inputIssue}`);
  const parameters = cloneFields(input.parameters);
  const pins = cloneFields(input.pins);
  const sharedIssue = sharedFieldIssue(parameters, pins);
  if (sharedIssue) throw new PreparedActError("INPUT_INVALID", `work-fold refused this act: ${sharedIssue}`);
  return Object.freeze({ kind: input.kind, parameters: Object.freeze(parameters), pins: Object.freeze(pins) });
}

/** The work-folder a prepared act mutates, when it names one. */
export function preparedActWorkFolderId(act: PreparedAct): string | undefined {
  const value = act.parameters.workFolderId ?? act.pins.workFolderId;
  return typeof value === "string" ? value : undefined;
}

/** The capability-mutation scope an execution reserves. */
export type PreparedActFenceScope =
  | { scope: "global" }
  | { scope: "work-folder"; workFolderId: string };

/**
 * Injectable seam over the local API's capability-mutation reservation
 * (`runCapabilityMutation` / `runRestrictedAppMutation` in
 * src/local/server.ts): reserves the scope for the operation and releases it
 * on every outcome, exactly as the equivalent desktop route would. A busy
 * scope refuses with the routes' own conflict.
 */
export interface PreparedActFence {
  run<T>(scope: PreparedActFenceScope, operation: () => Promise<T>): Promise<T>;
}

/** The kernel surface the executor needs: one internal task per execution. */
export interface PreparedActKernelSeam {
  startExperimentalPreparedActTask(input: WorkFoldExperimentalPreparedActTaskInput): WorkFoldExperimentalPreparedActTask;
  finishTask(taskId: string): boolean;
}

/**
 * Typed identifiers an execution hands back for the terminal receipt.
 * Identifiers and short host-composed lines only — receipts never grow file
 * contents, credentials, or model prose.
 */
export interface PreparedActEffect {
  detail?: string;
  checkpointId?: string;
  taskId?: string;
  undoRef?: WorkFoldCliActUndoRef;
}

/**
 * One per-kind execution adapter: the bridge from a prepared act's typed pins
 * to the same domain service the equivalent desktop action uses. `context`
 * carries execution inputs the calling verb already validated that are not
 * flat receipt fields (a normalized automation declaration, a resolved app
 * record); receipts never grow from it.
 */
export interface PreparedActAdapter<Context = unknown> {
  /**
   * Re-verifies every pinned identity against current state immediately
   * before execution, inside the fence. A returned reason refuses the act as
   * a pin mismatch; nothing executes.
   */
  recheckPins(act: PreparedAct, context: Context): Promise<string | null> | string | null;
  /** Runs the same mutation the equivalent desktop action runs. */
  execute(act: PreparedAct, context: Context): Promise<PreparedActEffect | void>;
  /**
   * The capability-fence scope the execution reserves. Omit for the default
   * (the act's work-folder, or global when the act names none). Return null when
   * the bound execution path performs its own reservation — reserving twice
   * for the same work-folder would deadlock against the server's mutation state.
   */
  fenceScope?(act: PreparedAct): PreparedActFenceScope | null;
}

export type PreparedActAdapters = Partial<Record<PreparedActKind, PreparedActAdapter>>;

/** Default fence scope: the act's work-folder when it names one, otherwise global. */
export function preparedActFenceScope(act: PreparedAct): PreparedActFenceScope {
  const workFolderId = preparedActWorkFolderId(act);
  return workFolderId ? { scope: "work-folder", workFolderId } : { scope: "global" };
}

export interface PreparedActExecutorOptions {
  adapters: PreparedActAdapters;
  fence: PreparedActFence;
  kernel: PreparedActKernelSeam;
}

export interface PreparedActRunInput {
  act: PreparedAct;
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
export class PreparedActExecutor {
  readonly #adapters: PreparedActAdapters;
  readonly #fence: PreparedActFence;
  readonly #kernel: PreparedActKernelSeam;

  constructor(options: PreparedActExecutorOptions) {
    this.#adapters = options.adapters;
    this.#fence = options.fence;
    this.#kernel = options.kernel;
  }

  async run(input: PreparedActRunInput): Promise<PreparedActEffect> {
    const { act } = input;
    const requestId = input.requestId.trim();
    if (!requestId) throw new PreparedActError("INPUT_INVALID", "work-fold refused this act: a request id is required.");
    const adapter = this.#adapters[act.kind] as PreparedActAdapter | undefined;
    if (!adapter) {
      throw new PreparedActError(
        "EXECUTION_UNAVAILABLE",
        `work-fold cannot perform "${act.kind}" acts in this build; nothing was changed.`,
      );
    }
    const scope = adapter.fenceScope ? adapter.fenceScope(act) : preparedActFenceScope(act);
    const perform = async (): Promise<PreparedActEffect> => {
      const pinIssue = await adapter.recheckPins(act, input.context);
      if (pinIssue) {
        throw new PreparedActError("PIN_MISMATCH", `This act no longer matches live state, so nothing was changed: ${pinIssue}`);
      }
      const workFolderId = preparedActWorkFolderId(act);
      const task = this.#kernel.startExperimentalPreparedActTask({
        ...(workFolderId ? { workFolderId } : {}),
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

function descriptorFor(kind: string): PreparedActKindDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(KIND_DESCRIPTORS, kind)
    ? KIND_DESCRIPTORS[kind as PreparedActKind]
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

function fieldValueIssue(value: unknown, spec: PreparedActFieldSpec, label: string): string | null {
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

function fieldsIssue(kind: PreparedActKind, section: FieldSection, value: unknown): string | null {
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
  return crossFieldIssue(kind, section, value as Record<string, PreparedActFieldValue>);
}

function crossFieldIssue(
  kind: PreparedActKind,
  section: FieldSection,
  fields: Record<string, PreparedActFieldValue>,
): string | null {
  if (kind === "capability.package.install" || kind === "capability.package.update") {
    if (section !== "parameters") return null;
    if ((fields.source === undefined) === (fields.catalogId === undefined)) {
      return `${section} must name exactly one of source or catalogId.`;
    }
    return scopedWorkFolderIssue(section, fields);
  }
  if ((kind === "capability.skills.import" || kind === "capability.resource.enabled") && section === "parameters") {
    return scopedWorkFolderIssue(section, fields);
  }
  if (kind === "publish.viewer.expose") return exposureIssue(section, fields);
  return null;
}

function scopedWorkFolderIssue(section: FieldSection, fields: Record<string, PreparedActFieldValue>): string | null {
  if (fields.scope === "work-folder" && fields.workFolderId === undefined) {
    return `${section}.workFolderId is required at work-folder scope.`;
  }
  if (fields.scope === "everywhere" && fields.workFolderId !== undefined) {
    return `${section}.workFolderId must be absent at Everywhere scope.`;
  }
  return null;
}

function exposureIssue(section: FieldSection, fields: Record<string, PreparedActFieldValue>): string | null {
  const page = fields.exposure === "page";
  const required = section === "parameters"
    ? (page ? ["workFolderId"] : ["appInstanceId"])
    : (page
      ? ["workFolderId", "relativePath", "title", "snapshotEnabled", "byteBudget", "serveBudget"]
      : ["appInstanceId", "releaseDigest", "viewerEntry", "viewerSurface"]);
  const foreign = section === "parameters"
    ? (page ? ["appInstanceId"] : ["workFolderId"])
    : (page
      ? ["appInstanceId", "releaseDigest", "viewerEntry", "viewerSurface", "priorReleaseDigest", "priorViewerSurface"]
      : ["workFolderId", "relativePath", "title", "snapshotEnabled", "byteBudget", "serveBudget", "priorByteBudget", "priorServeBudget"]);
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
function sharedFieldIssue(parameters: PreparedActFields, pins: PreparedActFields): string | null {
  for (const [name, value] of Object.entries(parameters)) {
    const pinned = pins[name];
    if (value === undefined || pinned === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(pinned)) {
      return `parameters.${name} and pins.${name} must name the same identity.`;
    }
  }
  return null;
}

function cloneFields(fields: PreparedActFields): PreparedActFields {
  const clean: Record<string, PreparedActFieldValue> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    clean[name] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return clean;
}
