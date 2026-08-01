import type { WorkFoldCliKernel } from "../../src/local/cli/protocol.js";
import { WorkFoldCliFileBroker } from "../../src/local/cli/broker.js";
import { executeWorkFoldCliRequest } from "../../src/local/cli/commands.js";
import {
  executeWorkFoldCliActRequest,
  type WorkFoldCliActAuthority,
} from "../../src/local/cli/act-commands.js";
import { isWorkFoldCliActRequest } from "../../src/local/cli/act-protocol.js";
import { WorkFoldCliActReceipts } from "../../src/local/cli/act-receipts.js";
import { normalizeWorkFoldCliRequestId } from "../../src/local/cli/protocol.js";

const cliRequestArgument = "--work-fold-cli-request";

export interface WorkFoldCliInstanceData {
  kind: "work-fold-cli";
  requestId: string;
}

export interface WorkFoldDesktopCliHostOptions {
  stateRoot: string;
  kernel: WorkFoldCliKernel;
  version: string;
  productName?: string;
  /** Act-lane authority; null while the interactive local API is not running. */
  getActFacade?: () => WorkFoldCliActAuthority | null;
  /** Validates explicit management-turn lineage for act receipts. */
  resolveLineageParent?: (taskId: string) => { taskId: string } | null;
}

/**
 * Desktop-owned bridge between the stable request-file protocol and the
 * reusable work-fold kernel. Requests are serialized so catalog discovery and
 * task snapshots never race one another inside a single desktop host. Act-lane
 * requests dispatch to the act executor, which only accepts the queue entry
 * itself — a long Assistant turn runs detached inside the interactive API, so
 * it never blocks later status polls.
 */
export class WorkFoldDesktopCliHost {
  readonly broker: WorkFoldCliFileBroker;
  readonly receipts: WorkFoldCliActReceipts;
  readonly #kernel: WorkFoldCliKernel;
  readonly #version: string;
  readonly #productName: string;
  readonly #getActFacade: () => WorkFoldCliActAuthority | null;
  readonly #resolveLineageParent: (taskId: string) => { taskId: string } | null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: WorkFoldDesktopCliHostOptions) {
    this.broker = new WorkFoldCliFileBroker({ stateRoot: options.stateRoot });
    this.receipts = new WorkFoldCliActReceipts({ stateRoot: options.stateRoot });
    this.#kernel = options.kernel;
    this.#version = options.version;
    this.#productName = options.productName ?? "work-fold";
    this.#getActFacade = options.getActFacade ?? (() => null);
    this.#resolveLineageParent = options.resolveLineageParent ?? (() => null);
  }

  async initialize(): Promise<void> {
    await this.broker.initialize();
    await this.broker.cleanup();
  }

  processRequest(requestId: string): Promise<void> {
    const id = normalizeWorkFoldCliRequestId(requestId);
    const operation = this.#queue.catch(() => undefined).then(async () => {
      await this.broker.processRequest(id, (request) => isWorkFoldCliActRequest(request)
        ? executeWorkFoldCliActRequest(request, {
            version: this.#version,
            productName: this.#productName,
            getActFacade: this.#getActFacade,
            receipts: this.receipts,
            resolveLineageParent: this.#resolveLineageParent,
          })
        : executeWorkFoldCliRequest(request, this.#kernel, {
            version: this.#version,
            productName: this.#productName,
          }));
    });
    this.#queue = operation;
    return operation;
  }

  /** Resolves only after every request observed so far has completed. */
  whenIdle(): Promise<void> {
    return this.#queue.catch(() => undefined);
  }
}

export function workFoldCliRequestIdFromArgv(argv: readonly string[]): string | null {
  let requestId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    let candidate: string | null = null;
    if (argument === cliRequestArgument) {
      candidate = argv[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith(`${cliRequestArgument}=`)) {
      candidate = argument.slice(cliRequestArgument.length + 1);
    }
    if (candidate === null) continue;
    if (requestId !== null) throw new Error(`${cliRequestArgument} may be provided only once.`);
    requestId = normalizeWorkFoldCliRequestId(candidate);
  }
  return requestId;
}

export function workFoldCliRequestIdFromInstanceData(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "work-fold-cli" || typeof record.requestId !== "string") return null;
  return normalizeWorkFoldCliRequestId(record.requestId);
}

export function workFoldCliInstanceData(requestId: string | null): WorkFoldCliInstanceData | { kind: "work-fold-gui" } {
  return requestId
    ? { kind: "work-fold-cli", requestId: normalizeWorkFoldCliRequestId(requestId) }
    : { kind: "work-fold-gui" };
}
