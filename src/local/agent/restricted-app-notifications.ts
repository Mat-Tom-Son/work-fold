import type { RestrictedAppNotificationDeclaration } from "./restricted-app-manifest.js";

export const restrictedAppNotificationLimits = {
  perInvocation: 2,
  perHour: 8,
  categoryIntervalMs: 5 * 60_000,
  outstandingPerApp: 3,
} as const;

export interface RestrictedAppNotificationOwner {
  spaceId: string;
  appId: string;
  digest: string;
}

export interface RestrictedAppNotificationContext extends RestrictedAppNotificationOwner {
  appTitle: string;
  declarations: readonly RestrictedAppNotificationDeclaration[];
  grants: readonly string[];
  automationEnabled: boolean;
  invocationId: string;
}

export interface RestrictedAppNotificationDisplay extends RestrictedAppNotificationOwner {
  permissionId: string;
  title: string;
  body: string;
}

export interface RestrictedAppNotificationOpenRequest extends RestrictedAppNotificationOwner {
  permissionId: string;
}

export interface RestrictedAppNotificationHandle {
  close(): void;
}

export interface RestrictedAppNotificationSink {
  isSupported(): boolean;
  show(
    notification: RestrictedAppNotificationDisplay,
    callbacks: { onClick: () => void; onClose: () => void },
  ): RestrictedAppNotificationHandle;
}

export type RestrictedAppNotificationStatus = "shown" | "rate-limited" | "unsupported";

export class RestrictedAppNotificationError extends Error {
  constructor(readonly code: "NOTIFICATION_DENIED" | "NOTIFICATION_FAILED", message: string) {
    super(message);
    this.name = "RestrictedAppNotificationError";
  }
}

export interface RestrictedAppNotificationBrokerOptions {
  sink: RestrictedAppNotificationSink;
  now?: () => number;
}

interface OutstandingNotification {
  key: string;
  appKey: string;
  owner: RestrictedAppNotificationOwner;
  shownAt: number;
  handle: RestrictedAppNotificationHandle;
}

/**
 * Pure policy around a host-owned notification sink. Runtime payloads select
 * only reviewed static copy; ownership and invocation authority remain host
 * inputs and never cross the restricted renderer boundary.
 */
export class RestrictedAppNotificationBroker {
  readonly #sink: RestrictedAppNotificationSink;
  readonly #now: () => number;
  readonly #hourly = new Map<string, number[]>();
  readonly #categoryLastShown = new Map<string, number>();
  readonly #invocations = new Map<string, { count: number; usedAt: number }>();
  readonly #outstanding = new Map<string, OutstandingNotification>();
  #pruneTimer?: NodeJS.Timeout;

  constructor(options: RestrictedAppNotificationBrokerOptions) {
    this.#sink = options.sink;
    this.#now = options.now ?? Date.now;
  }

  show(
    context: RestrictedAppNotificationContext,
    value: unknown,
    onOpen: (request: RestrictedAppNotificationOpenRequest) => void,
  ): { status: RestrictedAppNotificationStatus } {
    const request = notificationRequest(value);
    validateContext(context);
    if (!context.automationEnabled) {
      throw new RestrictedAppNotificationError("NOTIFICATION_DENIED", "Enable this automation before it can show notifications.");
    }
    const declaration = context.declarations.find((item) => item.id === request.permissionId);
    if (!declaration || !context.grants.includes(declaration.id)) {
      throw new RestrictedAppNotificationError("NOTIFICATION_DENIED", "This notification category is not granted to the app.");
    }
    if (!this.#sink.isSupported()) return { status: "unsupported" };

    const now = this.#now();
    this.#prune(now);
    const appKey = ownerKey(context);
    const categoryKey = `${appKey}:${declaration.id}`;
    const invocationKey = `${appKey}:${context.invocationId}`;
    const invocation = this.#invocations.get(invocationKey) ?? { count: 0, usedAt: now };
    const hourly = this.#hourly.get(appKey) ?? [];
    const lastCategory = this.#categoryLastShown.get(categoryKey);
    if (invocation.count >= restrictedAppNotificationLimits.perInvocation
      || hourly.length >= restrictedAppNotificationLimits.perHour
      || (lastCategory !== undefined && now - lastCategory < restrictedAppNotificationLimits.categoryIntervalMs)) {
      return { status: "rate-limited" };
    }

    const appOutstanding = [...this.#outstanding.values()]
      .filter((item) => item.appKey === appKey)
      .sort((left, right) => left.shownAt - right.shownAt);
    const existing = this.#outstanding.get(categoryKey);
    if (existing) this.#closeOutstanding(existing);
    else if (appOutstanding.length >= restrictedAppNotificationLimits.outstandingPerApp && appOutstanding[0]) {
      this.#closeOutstanding(appOutstanding[0]);
    }

    const owner = ownerValue(context);
    let outstanding: OutstandingNotification | undefined;
    let closedBeforeAssignment = false;
    try {
      const handle = this.#sink.show({
        ...owner,
        permissionId: declaration.id,
        title: `work-fold · ${context.appTitle} — ${declaration.title}`,
        body: declaration.description,
      }, {
        onClick: () => {
          if (!outstanding || this.#outstanding.get(categoryKey) !== outstanding) return;
          this.#closeOutstanding(outstanding);
          onOpen({ ...owner, permissionId: declaration.id });
        },
        onClose: () => {
          if (outstanding && this.#outstanding.get(categoryKey) === outstanding) this.#outstanding.delete(categoryKey);
          else closedBeforeAssignment = true;
        },
      });
      outstanding = { key: categoryKey, appKey, owner, shownAt: now, handle };
      if (!closedBeforeAssignment) this.#outstanding.set(categoryKey, outstanding);
    } catch {
      throw new RestrictedAppNotificationError("NOTIFICATION_FAILED", "work-fold could not show the app notification.");
    }

    invocation.count += 1;
    invocation.usedAt = now;
    this.#invocations.set(invocationKey, invocation);
    hourly.push(now);
    this.#hourly.set(appKey, hourly);
    this.#categoryLastShown.set(categoryKey, now);
    this.#schedulePrune(now);
    return { status: "shown" };
  }

  closeApp(owner: Pick<RestrictedAppNotificationOwner, "spaceId" | "appId">, digest?: string): void {
    for (const item of [...this.#outstanding.values()]) {
      if (item.owner.spaceId !== owner.spaceId || item.owner.appId !== owner.appId || (digest && item.owner.digest !== digest)) continue;
      this.#closeOutstanding(item);
    }
    const now = this.#now();
    this.#prune(now);
    this.#schedulePrune(now);
  }

  closeAll(): void {
    for (const item of [...this.#outstanding.values()]) this.#closeOutstanding(item);
    const now = this.#now();
    this.#prune(now);
    this.#schedulePrune(now);
  }

  dispose(): void {
    this.closeAll();
    if (this.#pruneTimer) clearTimeout(this.#pruneTimer);
    this.#pruneTimer = undefined;
    this.#hourly.clear();
    this.#categoryLastShown.clear();
    this.#invocations.clear();
  }

  #closeOutstanding(item: OutstandingNotification): void {
    if (this.#outstanding.get(item.key) === item) this.#outstanding.delete(item.key);
    try { item.handle.close(); } catch { /* notification cleanup is best effort */ }
  }

  #prune(now: number): void {
    const cutoff = now - 60 * 60_000;
    for (const [key, timestamps] of this.#hourly) {
      const current = timestamps.filter((timestamp) => timestamp > cutoff);
      if (current.length) this.#hourly.set(key, current);
      else this.#hourly.delete(key);
    }
    for (const [key, value] of this.#invocations) if (value.usedAt <= cutoff) this.#invocations.delete(key);
    for (const [key, value] of this.#categoryLastShown) if (value <= cutoff) this.#categoryLastShown.delete(key);
  }

  #schedulePrune(now: number): void {
    if (this.#pruneTimer) clearTimeout(this.#pruneTimer);
    const timestamps = [
      ...[...this.#hourly.values()].flat(),
      ...[...this.#invocations.values()].map((value) => value.usedAt),
      ...this.#categoryLastShown.values(),
    ];
    if (!timestamps.length) {
      this.#pruneTimer = undefined;
      return;
    }
    const delay = Math.max(1, Math.min(2_147_483_647, Math.min(...timestamps) + 60 * 60_000 - now + 1));
    this.#pruneTimer = setTimeout(() => {
      this.#pruneTimer = undefined;
      const current = this.#now();
      this.#prune(current);
      this.#schedulePrune(current);
    }, delay);
    this.#pruneTimer.unref?.();
  }
}

function notificationRequest(value: unknown): { permissionId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RestrictedAppNotificationError("NOTIFICATION_DENIED", "Notification request must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "permissionId" || typeof record.permissionId !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.permissionId)) {
    throw new RestrictedAppNotificationError("NOTIFICATION_DENIED", "Notification request may contain only a valid permissionId.");
  }
  return { permissionId: record.permissionId };
}

function validateContext(context: RestrictedAppNotificationContext): void {
  if (!context || typeof context !== "object" || !context.spaceId || !context.appId || !/^[0-9a-f]{64}$/.test(context.digest)
    || !context.appTitle || !context.invocationId || !Array.isArray(context.declarations) || !Array.isArray(context.grants)) {
    throw new RestrictedAppNotificationError("NOTIFICATION_DENIED", "Notification host authority is invalid.");
  }
}

function ownerValue(context: RestrictedAppNotificationContext): RestrictedAppNotificationOwner {
  return { spaceId: context.spaceId, appId: context.appId, digest: context.digest };
}

function ownerKey(owner: RestrictedAppNotificationOwner): string {
  // Rate history intentionally survives renderer restarts, permission churn,
  // background disable/enable, and reviewed digest updates. Lifecycle cleanup
  // closes handles but must not let an app regain its anti-spam budget.
  return `${owner.spaceId}:${owner.appId}`;
}
