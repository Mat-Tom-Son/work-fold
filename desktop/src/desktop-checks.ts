import { WorkFoldCheckService, type WorkFoldCheckServiceOptions } from "../../src/local/checks/check-service.js";
import type { WorkFoldSettleSignal } from "../../src/local/routings/settle-signal.js";
import type { LocalApiHandle } from "../../src/local/server.js";
import type { WorkFoldKernel } from "../../src/local/work-fold-kernel.js";

/** One service for desktop status, renderer actions, CLI and Routing runs. */
export function createDesktopCheckService(options: {
  kernel: WorkFoldKernel;
  settleSignal: WorkFoldSettleSignal;
  getLocalApi: () => Promise<Pick<LocalApiHandle, "reviewCheck">>;
  /** Tells app views that read a selected Check to re-read (F30). Ids only. */
  onResultChanged?: WorkFoldCheckServiceOptions["onResultChanged"];
}): WorkFoldCheckService {
  return new WorkFoldCheckService({
    kernel: options.kernel,
    settleSignal: options.settleSignal,
    ...(options.onResultChanged ? { onResultChanged: options.onResultChanged } : {}),
    // The read CLI exists before the interactive API. Resolve its transport
    // only when an authorized model run actually needs the fold's runtime.
    reviewModel: async (request) => (await options.getLocalApi()).reviewCheck(request),
  });
}
