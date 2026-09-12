/** A renderer's subscriptions to existing local read streams. No work is dispatched. */
export interface LocalEventSubscription {
  id: string;
  path: string;
  lastEventId?: string;
}

export interface LocalEventEnvelope {
  subscriptionId: string;
  event?: unknown;
  eventId?: string;
  ready?: boolean;
  closed?: boolean;
  error?: { status: number; message: string };
}

export const localEventStreamLimits = { subscriptions: 128, bodyBytes: 64 * 1024, queuedBytes: 512 * 1024 } as const;
