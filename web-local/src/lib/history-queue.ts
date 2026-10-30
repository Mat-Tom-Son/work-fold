/**
 * The host runs one History operation at a time in each work-folder and turns
 * a second one away. Every History request the app sends for a work-folder
 * (the list, a restore point's preview, Compare, Restore, saving a restore
 * point, file versions) waits its turn here, so open History tabs never refuse
 * each other. Different work-folders never wait on each other.
 *
 * Queue single requests only: a queued request that queues another for the
 * same work-folder would wait on itself.
 */
const queues = new Map<string, Promise<void>>();

export function queueHistoryRequest<T>(workFolderId: string, request: () => Promise<T>): Promise<T> {
  const turn = (queues.get(workFolderId) ?? Promise.resolve()).then(request);
  const settled = turn.then(() => undefined, () => undefined);
  queues.set(workFolderId, settled);
  void settled.then(() => { if (queues.get(workFolderId) === settled) queues.delete(workFolderId); });
  return turn;
}
