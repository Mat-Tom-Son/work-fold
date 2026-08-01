import type { WorkspaceCliKernel } from "../../src/local/cli/protocol.js";
import { WorkspaceCliFileBroker } from "../../src/local/cli/broker.js";
import { executeWorkspaceCliRequest } from "../../src/local/cli/commands.js";
import {
  executeWorkspaceCliActRequest,
  type WorkspaceCliActAuthority,
} from "../../src/local/cli/act-commands.js";
import { isWorkspaceCliActRequest } from "../../src/local/cli/act-protocol.js";
import { WorkspaceCliActReceipts } from "../../src/local/cli/act-receipts.js";
import { normalizeWorkspaceCliRequestId } from "../../src/local/cli/protocol.js";

const cliRequestArgument = "--workspace-cli-request";

export interface WorkspaceCliInstanceData {
  kind: "workspace-cli";
  requestId: string;
}

export interface WorkspaceDesktopCliHostOptions {
  stateRoot: string;
  kernel: WorkspaceCliKernel;
  version: string;
  productName?: string;
  /** Act-lane authority; null while the interactive local API is not running. */
  getActFacade?: () => WorkspaceCliActAuthority | null;
}

/**
 * Desktop-owned bridge between the stable request-file protocol and the
 * reusable Workspace kernel. Requests are serialized so catalog discovery and
 * task snapshots never race one another inside a single desktop host. Act-lane
 * requests dispatch to the act executor, which only accepts the queue entry
 * itself — a long Assistant turn runs detached inside the interactive API, so
 * it never blocks later status polls.
 */
export class WorkspaceDesktopCliHost {
  readonly broker: WorkspaceCliFileBroker;
  readonly receipts: WorkspaceCliActReceipts;
  readonly #kernel: WorkspaceCliKernel;
  readonly #version: string;
  readonly #productName: string;
  readonly #getActFacade: () => WorkspaceCliActAuthority | null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceDesktopCliHostOptions) {
    this.broker = new WorkspaceCliFileBroker({ stateRoot: options.stateRoot });
    this.receipts = new WorkspaceCliActReceipts({ stateRoot: options.stateRoot });
    this.#kernel = options.kernel;
    this.#version = options.version;
    this.#productName = options.productName ?? "Workspace";
    this.#getActFacade = options.getActFacade ?? (() => null);
  }

  async initialize(): Promise<void> {
    await this.broker.initialize();
    await this.broker.cleanup();
  }

  processRequest(requestId: string): Promise<void> {
    const id = normalizeWorkspaceCliRequestId(requestId);
    const operation = this.#queue.catch(() => undefined).then(async () => {
      await this.broker.processRequest(id, (request) => isWorkspaceCliActRequest(request)
        ? executeWorkspaceCliActRequest(request, {
            version: this.#version,
            productName: this.#productName,
            getActFacade: this.#getActFacade,
            receipts: this.receipts,
          })
        : executeWorkspaceCliRequest(request, this.#kernel, {
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

export function workspaceCliRequestIdFromArgv(argv: readonly string[]): string | null {
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
    requestId = normalizeWorkspaceCliRequestId(candidate);
  }
  return requestId;
}

export function workspaceCliRequestIdFromInstanceData(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "workspace-cli" || typeof record.requestId !== "string") return null;
  return normalizeWorkspaceCliRequestId(record.requestId);
}

export function workspaceCliInstanceData(requestId: string | null): WorkspaceCliInstanceData | { kind: "workspace-gui" } {
  return requestId
    ? { kind: "workspace-cli", requestId: normalizeWorkspaceCliRequestId(requestId) }
    : { kind: "workspace-gui" };
}
