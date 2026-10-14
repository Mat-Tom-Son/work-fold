/**
 * Where an app's own view opens: an origin-relative route and small JSON
 * state. App tabs and notification clicks share these rules, so a route an
 * app can name for one is valid for the other
 * (docs/restricted-app-runtime.md, Visible app host).
 */
export const restrictedAppNavigationLimits = Object.freeze({
  /** Characters in a route, including its query and fragment. */
  routeLength: 2_048,
  /** Bytes of serialized JSON state. */
  stateBytes: 64 * 1024,
});

/**
 * How the left-pane view was opened when it was not the person's own rail
 * click. Only a notification click opens it this way today; the app reads it
 * from `context.get().openedFrom`, never as authority.
 */
export interface RestrictedAppOpenedFrom {
  kind: "notification";
  /** The reviewed notification category the person clicked. */
  permissionId: string;
}

const permissionIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * An origin-relative route inside the app, normalized. Throws when the value
 * is not a path, is too long, or could resolve outside the app's own origin.
 */
export function restrictedAppRoute(value: unknown): string {
  if (typeof value !== "string" || value.length > restrictedAppNavigationLimits.routeLength
    || /[\\\0\r\n]/.test(value) || !value.startsWith("/") || value.startsWith("//")) {
    throw new Error("Restricted app route must be an origin-relative path.");
  }
  const parsed = new URL(value, "https://restricted-app.invalid");
  if (parsed.origin !== "https://restricted-app.invalid") throw new Error("Restricted app route escapes its app.");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** A copy of JSON state an app view opens with; throws when it is not JSON or is over 64 KiB serialized. */
export function restrictedAppState(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Restricted app state must be JSON-compatible.");
  }
  if (serialized === undefined) throw new Error("Restricted app state must be JSON-compatible.");
  if (new TextEncoder().encode(serialized).byteLength > restrictedAppNavigationLimits.stateBytes) {
    throw new Error("Restricted app state exceeds the 64 KiB limit.");
  }
  return JSON.parse(serialized) as unknown;
}

/** A valid `openedFrom`, or null for none; throws on a malformed value. */
export function restrictedAppOpenedFrom(value: unknown): RestrictedAppOpenedFrom | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Restricted app opened-from must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "permissionId")
    || record.kind !== "notification"
    || typeof record.permissionId !== "string" || !permissionIdPattern.test(record.permissionId)) {
    throw new Error("Restricted app opened-from must name a notification category.");
  }
  return { kind: "notification", permissionId: record.permissionId };
}
