import { isIP } from "node:net";
import { extname, posix } from "node:path";

export const restrictedAppManifestVersion = 2 as const;
export const restrictedAppRuntimeKind = "sandboxed-web" as const;

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const toolNamePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const allowedAuthKinds = new Set<RestrictedAppAuthKind>([
  "none",
  "api-key",
  "bearer",
  "basic",
  "oauth2-pkce",
]);
const forbiddenRequestHeaders = new Set([
  "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization",
  "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "forwarded", "via", "x-real-ip",
]);

export type RestrictedAppAuthKind =
  | "none"
  | "api-key"
  | "bearer"
  | "basic"
  | "oauth2-pkce";

export type RestrictedAppAuthDeclaration =
  | { kind: "api-key"; header: string }
  | { kind: "oauth2-pkce"; issuer: string; clientId: string; scopes: string[] }
  | { kind: Exclude<RestrictedAppAuthKind, "api-key" | "oauth2-pkce"> };

export interface RestrictedAppJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, RestrictedAppJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: RestrictedAppJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface RestrictedAppToolDeclaration {
  name: string;
  description: string;
  action: string;
  inputSchema: RestrictedAppJsonSchema;
  resultSchema: RestrictedAppJsonSchema;
}

export interface RestrictedAppNetworkDeclaration {
  id: string;
  target:
    | { kind: "public-https"; origin: string }
    | { kind: "loopback-http"; host: "127.0.0.1" | "::1"; port: number };
  methods: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
  auth: RestrictedAppAuthDeclaration[];
  /** Reviewed request header names this destination may set, beyond the always-allowed content negotiation set. */
  requestHeaders?: string[];
}

export interface RestrictedAppFileDeclaration {
  id: string;
  target: "file" | "directory";
  access: "read" | "read-write";
}

export interface RestrictedAppNotificationDeclaration {
  id: string;
  title: string;
  description: string;
}

export interface RestrictedAppAutomationDeclaration {
  id: string;
  title: string;
  description?: string;
  handler: string;
  trigger: {
    kind: "interval";
    intervalMinutes: number;
  };
  permissions: {
    network: string[];
    files: string[];
    notifications: string[];
  };
  catchUp: "none" | "latest";
  overlap: "skip";
}

export interface RestrictedAppManifest {
  version: typeof restrictedAppManifestVersion;
  id: string;
  title: string;
  description?: string;
  runtime: {
    kind: typeof restrictedAppRuntimeKind;
    entry: string;
    worker?: string;
  };
  ui: {
    icon?: string;
  };
  tools: RestrictedAppToolDeclaration[];
  permissions: {
    network: RestrictedAppNetworkDeclaration[];
    files: RestrictedAppFileDeclaration[];
    notifications: RestrictedAppNotificationDeclaration[];
  };
  automations: RestrictedAppAutomationDeclaration[];
}

export function validateRestrictedAppValue(
  schema: RestrictedAppJsonSchema,
  value: unknown,
  label = "Restricted app value",
): void {
  if (!runtimeValueMatchesType(schema.type, value)) throw new Error(`${label} must have type ${schema.type}.`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${label} is not one of the declared values.`);
  }
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) throw new Error(`${label} is missing required property ${required}.`);
    }
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (!propertySchema) throw new Error(`${label} contains undeclared property ${key}.`);
      validateRestrictedAppValue(propertySchema, item, `${label}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) throw new Error(`${label} has too few items.`);
    if (schema.maxItems !== undefined && items.length > schema.maxItems) throw new Error(`${label} has too many items.`);
    const itemSchema = schema.items!;
    items.forEach((item, index) => validateRestrictedAppValue(itemSchema, item, `${label}[${index}]`));
    return;
  }
  if (schema.type === "string") {
    const text = value as string;
    if (schema.minLength !== undefined && text.length < schema.minLength) throw new Error(`${label} is too short.`);
    if (schema.maxLength !== undefined && text.length > schema.maxLength) throw new Error(`${label} is too long.`);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = value as number;
    if (schema.minimum !== undefined && number < schema.minimum) throw new Error(`${label} is below the minimum.`);
    if (schema.maximum !== undefined && number > schema.maximum) throw new Error(`${label} is above the maximum.`);
  }
}

/**
 * Parse the data-only contract before an app package is staged or any package
 * JavaScript is evaluated. Unknown fields fail closed so adding a new power
 * requires an explicit host/version change instead of being silently ignored.
 */
export function parseRestrictedAppManifest(value: unknown): RestrictedAppManifest {
  const candidate = objectValue(value, "Restricted app manifest");
  if (candidate.version !== restrictedAppManifestVersion) {
    throw new Error(`Restricted app manifest version must be ${restrictedAppManifestVersion}.`);
  }
  const manifest = objectValue(value, "Restricted app manifest", [
    "version", "id", "title", "description", "runtime", "ui", "tools", "automations", "permissions",
  ]);
  const runtime = objectValue(manifest.runtime, "Restricted app runtime", ["kind", "entry", "worker"]);
  if (runtime.kind !== restrictedAppRuntimeKind) {
    throw new Error(`Restricted app runtime kind must be ${restrictedAppRuntimeKind}.`);
  }
  const entry = packagePathValue(runtime.entry, "Restricted app UI entry", [".html"]);
  const worker = runtime.worker === undefined
    ? undefined
    : packagePathValue(runtime.worker, "Restricted app worker entry", [".js", ".mjs"]);
  const ui = objectValue(manifest.ui, "Restricted app UI", ["icon"]);
  const icon = optionalIdValue(ui.icon, "Restricted app UI icon");
  const tools = arrayValue(manifest.tools, "Restricted app tools", 0, 16)
    .map((tool, index) => parseTool(tool, index));
  if (tools.length && !worker) throw new Error("Restricted apps that expose Assistant tools must declare a sandboxed worker entry.");
  assertUnique(tools.map((tool) => tool.name), "Restricted app tool name");
  assertUnique(tools.map((tool) => tool.action), "Restricted app tool action");

  const permissions = objectValue(manifest.permissions, "Restricted app permissions", ["network", "files", "notifications"]);
  const network = arrayValue(permissions.network, "Restricted app network permissions", 0, 16)
    .map((destination, index) => parseNetworkDestination(destination, index));
  assertUnique(network.map((destination) => destination.id), "Restricted app network permission id");
  const files = permissions.files === undefined
    ? []
    : arrayValue(permissions.files, "Restricted app file permissions", 0, 16)
      .map((declaration, index) => parseFileDeclaration(declaration, index));
  assertUnique(files.map((declaration) => declaration.id), "Restricted app file permission id");
  const notifications = permissions.notifications === undefined
    ? []
    : arrayValue(permissions.notifications, "Restricted app notification permissions", 0, 8)
      .map((declaration, index) => parseNotificationDeclaration(declaration, index));
  assertUnique(notifications.map((declaration) => declaration.id), "Restricted app notification permission id");

  const description = optionalStringValue(manifest.description, "Restricted app description", 280);
  const automations = arrayValue(manifest.automations, "Restricted app automations", 0, 16)
    .map((automation, index) => parseAutomationDeclaration(automation, index, { network, files, notifications }));
  assertUnique(automations.map((automation) => automation.id), "Restricted app automation id");
  if (automations.length && !worker) {
    throw new Error("Restricted apps that declare automations must declare a sandboxed worker entry.");
  }
  if (notifications.length) {
    if (!worker) {
      throw new Error("Restricted apps that request notifications must declare a sandboxed automation worker.");
    }
    const referencedNotifications = new Set(automations.flatMap((automation) => automation.permissions.notifications));
    const unreferenced = notifications.find((notification) => !referencedNotifications.has(notification.id));
    if (unreferenced) {
      throw new Error(`Restricted app notification permission ${unreferenced.id} must be referenced by an automation.`);
    }
  }
  return {
    version: restrictedAppManifestVersion,
    id: idValue(manifest.id, "Restricted app id"),
    title: notificationTextValue(manifest.title, "Restricted app title", 80),
    ...(description ? { description } : {}),
    runtime: { kind: restrictedAppRuntimeKind, entry, ...(worker ? { worker } : {}) },
    ui: { ...(icon ? { icon } : {}) },
    tools,
    permissions: { network, files, notifications },
    automations,
  };
}

function parseAutomationDeclaration(
  value: unknown,
  index: number,
  declaredPermissions: RestrictedAppManifest["permissions"],
): RestrictedAppAutomationDeclaration {
  const label = `Restricted app automation ${index + 1}`;
  const automation = objectValue(value, label, [
    "id", "title", "description", "handler", "trigger", "permissions", "catchUp", "overlap",
  ]);
  const trigger = objectValue(automation.trigger, `${label} trigger`, ["kind", "intervalMinutes"]);
  if (trigger.kind !== "interval") throw new Error(`${label} trigger kind must be interval.`);
  const intervalMinutes = intervalMinutesValue(trigger.intervalMinutes, `${label} interval`);

  const permissions = objectValue(automation.permissions, `${label} permissions`, ["network", "files", "notifications"]);
  const network = parseAutomationPermissionIds(permissions.network, `${label} network permissions`, declaredPermissions.network);
  const files = parseAutomationPermissionIds(permissions.files, `${label} file permissions`, declaredPermissions.files);
  const notifications = parseAutomationPermissionIds(
    permissions.notifications,
    `${label} notification permissions`,
    declaredPermissions.notifications,
  );

  if (automation.catchUp !== "none" && automation.catchUp !== "latest") {
    throw new Error(`${label} catch-up policy must be none or latest.`);
  }
  if (automation.overlap !== "skip") throw new Error(`${label} overlap policy must be skip.`);
  const description = optionalStringValue(automation.description, `${label} description`, 280);
  return {
    id: idValue(automation.id, `${label} id`),
    title: notificationTextValue(automation.title, `${label} title`, 80),
    ...(description ? { description } : {}),
    handler: idValue(automation.handler, `${label} handler`),
    trigger: { kind: "interval", intervalMinutes },
    permissions: { network, files, notifications },
    catchUp: automation.catchUp,
    overlap: "skip",
  };
}

function parseAutomationPermissionIds<T extends { id: string }>(
  value: unknown,
  label: string,
  declarations: T[],
): string[] {
  const ids = arrayValue(value, label, 0, 16).map((id) => idValue(id, `${label} id`));
  assertUnique(ids, `${label} id`);
  const declaredIds = new Set(declarations.map((declaration) => declaration.id));
  const unknown = ids.find((id) => !declaredIds.has(id));
  if (unknown) throw new Error(`${label} references undeclared permission id ${unknown}.`);
  return ids;
}

function intervalMinutesValue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 15 || (value as number) > 1_440) {
    throw new Error(`${label} must be between 15 and 1440 minutes.`);
  }
  return value as number;
}

function parseFileDeclaration(value: unknown, index: number): RestrictedAppFileDeclaration {
  const label = `Restricted app file permission ${index + 1}`;
  const declaration = objectValue(value, label, ["id", "target", "access"]);
  if (declaration.target !== "file" && declaration.target !== "directory") {
    throw new Error(`${label} target must be file or directory.`);
  }
  if (declaration.access !== "read" && declaration.access !== "read-write") {
    throw new Error(`${label} access must be read or read-write.`);
  }
  return {
    id: idValue(declaration.id, `${label} id`),
    target: declaration.target,
    access: declaration.access,
  };
}

function parseNotificationDeclaration(value: unknown, index: number): RestrictedAppNotificationDeclaration {
  const label = `Restricted app notification permission ${index + 1}`;
  const declaration = objectValue(value, label, ["id", "title", "description"]);
  return {
    id: idValue(declaration.id, `${label} id`),
    title: notificationTextValue(declaration.title, `${label} title`, 80),
    description: notificationTextValue(declaration.description, `${label} description`, 160),
  };
}

function notificationTextValue(value: unknown, label: string, maxLength: number): string {
  const result = stringValue(value, label, maxLength);
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(result)) {
    throw new Error(`${label} must be plain single-line text without control or direction-override characters.`);
  }
  return result;
}

function parseTool(value: unknown, index: number): RestrictedAppToolDeclaration {
  const label = `Restricted app tool ${index + 1}`;
  const tool = objectValue(value, label, ["name", "description", "action", "inputSchema", "resultSchema"]);
  const name = stringValue(tool.name, `${label} name`, 64);
  if (!toolNamePattern.test(name)) throw new Error(`${label} name is invalid.`);
  return {
    name,
    description: stringValue(tool.description, `${label} description`, 500),
    action: idValue(tool.action, `${label} action`),
    inputSchema: parseJsonSchema(tool.inputSchema, `${label} input schema`, 0),
    resultSchema: parseJsonSchema(tool.resultSchema, `${label} result schema`, 0),
  };
}

function parseNetworkDestination(value: unknown, index: number): RestrictedAppNetworkDeclaration {
  const label = `Restricted app network permission ${index + 1}`;
  const destination = objectValue(value, label, ["id", "target", "methods", "auth", "requestHeaders"]);
  const target = parseNetworkTarget(destination.target, `${label} target`);
  const methods = arrayValue(destination.methods, `${label} methods`, 1, 5).map((method) => {
    if (typeof method !== "string" || !allowedMethods.has(method)) throw new Error(`${label} method is unsupported.`);
    return method as RestrictedAppNetworkDeclaration["methods"][number];
  });
  assertUnique(methods, `${label} method`);
  const auth = arrayValue(destination.auth, `${label} auth`, 1, allowedAuthKinds.size).map((value, authIndex) => {
    const declaration = objectValue(value, `${label} auth ${authIndex + 1}`, ["kind", "header", "issuer", "clientId", "scopes"]);
    if (typeof declaration.kind !== "string" || !allowedAuthKinds.has(declaration.kind as RestrictedAppAuthKind)) {
      throw new Error(`${label} auth kind is unsupported.`);
    }
    if (declaration.kind === "api-key") {
      const header = stringValue(declaration.header, `${label} API-key header`, 80).toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(header) || isForbiddenRequestHeader(header)) throw new Error(`${label} API-key header is not allowed.`);
      return { kind: "api-key" as const, header };
    }
    if (declaration.kind === "oauth2-pkce") {
      if (declaration.header !== undefined) throw new Error(`${label} OAuth auth cannot declare a header.`);
      const clientId = stringValue(declaration.clientId, `${label} OAuth client id`, 512);
      if (/[\0\r\n]/.test(clientId)) throw new Error(`${label} OAuth client id is invalid.`);
      const scopes = arrayValue(declaration.scopes, `${label} OAuth scopes`, 1, 32).map((scope) => {
        if (typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/.test(scope) || scope === "openid") {
          throw new Error(`${label} OAuth scope is invalid or unsupported.`);
        }
        return scope;
      });
      assertUnique(scopes, `${label} OAuth scope`);
      return {
        kind: "oauth2-pkce" as const,
        issuer: publicIssuerValue(declaration.issuer, `${label} OAuth issuer`),
        clientId,
        scopes,
      };
    }
    if (declaration.header !== undefined || declaration.issuer !== undefined || declaration.clientId !== undefined || declaration.scopes !== undefined) {
      throw new Error(`${label} ${declaration.kind} auth cannot declare OAuth or header fields.`);
    }
    return { kind: declaration.kind as "none" | "bearer" | "basic" };
  });
  assertUnique(auth.map((item) => item.kind), `${label} auth kind`);
  if (auth.some((item) => item.kind === "none") && auth.length !== 1) {
    throw new Error(`${label} cannot combine unauthenticated access with credential auth kinds.`);
  }
  if (target.kind === "loopback-http" && (auth.length !== 1 || auth[0]?.kind !== "none")) {
    throw new Error(`${label} loopback services cannot receive saved credentials.`);
  }
  // Extra request headers are reviewed per destination so an app can satisfy an
  // ordinary API contract without gaining a general header channel. The
  // forbidden set keeps hop-by-hop, routing, and credential-bearing names out,
  // and a destination may not name the header its own credential occupies.
  const requestHeaders = destination.requestHeaders === undefined
    ? []
    : arrayValue(destination.requestHeaders, `${label} request headers`, 1, 16).map((item) => {
      const header = stringValue(item, `${label} request header`, 80).toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(header) || isForbiddenRequestHeader(header)) {
        throw new Error(`${label} request header is not allowed.`);
      }
      return header;
    });
  assertUnique(requestHeaders, `${label} request header`);
  const credentialHeader = auth
    .find((item): item is Extract<RestrictedAppAuthDeclaration, { kind: "api-key" }> => item.kind === "api-key")
    ?.header;
  if (credentialHeader !== undefined && requestHeaders.includes(credentialHeader)) {
    throw new Error(`${label} cannot declare its own credential header as a request header.`);
  }
  return {
    id: idValue(destination.id, `${label} id`),
    target,
    methods,
    auth,
    ...(requestHeaders.length ? { requestHeaders } : {}),
  };
}

function isForbiddenRequestHeader(header: string): boolean {
  return forbiddenRequestHeaders.has(header)
    || header.startsWith("x-forwarded-")
    || header.startsWith("proxy-");
}

function parseJsonSchema(value: unknown, label: string, depth: number): RestrictedAppJsonSchema {
  if (depth > 6) throw new Error(`${label} exceeds the maximum nesting depth.`);
  const schema = objectValue(value, label, [
    "type", "description", "properties", "required", "additionalProperties", "items", "enum",
    "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
  ]);
  const type = schema.type;
  if (type !== "object" && type !== "array" && type !== "string" && type !== "number"
    && type !== "integer" && type !== "boolean" && type !== "null") {
    throw new Error(`${label} type is unsupported.`);
  }
  const result: RestrictedAppJsonSchema = { type };
  const description = optionalStringValue(schema.description, `${label} description`, 500);
  if (description) result.description = description;

  if (schema.enum !== undefined) {
    const values = arrayValue(schema.enum, `${label} enum`, 1, 32);
    if (values.some((item) => item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) {
      throw new Error(`${label} enum may contain only primitive JSON values.`);
    }
    const serialized = values.map((item) => JSON.stringify(item));
    assertUnique(serialized, `${label} enum value`);
    if (!values.every((item) => schemaValueMatchesType(item, type))) {
      throw new Error(`${label} enum values must match its declared type.`);
    }
    result.enum = values as RestrictedAppJsonSchema["enum"];
  }

  if (type === "object") {
    if (schema.additionalProperties !== false) throw new Error(`${label} must set additionalProperties to false.`);
    const properties = objectValue(schema.properties ?? {}, `${label} properties`, undefined, 32);
    const parsedProperties: Record<string, RestrictedAppJsonSchema> = {};
    for (const [name, property] of Object.entries(properties)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`${label} property name is invalid: ${name}`);
      parsedProperties[name] = parseJsonSchema(property, `${label} property ${name}`, depth + 1);
    }
    const required = schema.required === undefined
      ? []
      : arrayValue(schema.required, `${label} required`, 0, Object.keys(parsedProperties).length).map((name) => {
        if (typeof name !== "string" || !(name in parsedProperties)) throw new Error(`${label} required property is not declared.`);
        return name;
      });
    assertUnique(required, `${label} required property`);
    result.properties = parsedProperties;
    result.required = required;
    result.additionalProperties = false;
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    throw new Error(`${label} object keywords require type object.`);
  }

  if (type === "array") {
    if (schema.items === undefined) throw new Error(`${label} must declare array items.`);
    result.items = parseJsonSchema(schema.items, `${label} items`, depth + 1);
    copyBound(schema, result, "minItems", label, 0, 100);
    copyBound(schema, result, "maxItems", label, 0, 100);
    if ((result.minItems ?? 0) > (result.maxItems ?? 100)) throw new Error(`${label} item bounds are invalid.`);
  } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    throw new Error(`${label} array keywords require type array.`);
  }

  if (type === "string") {
    copyBound(schema, result, "minLength", label, 0, 10_000);
    copyBound(schema, result, "maxLength", label, 0, 10_000);
    if ((result.minLength ?? 0) > (result.maxLength ?? 10_000)) throw new Error(`${label} string bounds are invalid.`);
  } else if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    throw new Error(`${label} string keywords require type string.`);
  }

  if (type === "number" || type === "integer") {
    copyNumber(schema, result, "minimum", label);
    copyNumber(schema, result, "maximum", label);
    if ((result.minimum ?? -Infinity) > (result.maximum ?? Infinity)) throw new Error(`${label} numeric bounds are invalid.`);
  } else if (schema.minimum !== undefined || schema.maximum !== undefined) {
    throw new Error(`${label} numeric keywords require a numeric type.`);
  }
  return result;
}

function packagePathValue(value: unknown, label: string, extensions: string[]): string {
  const path = stringValue(value, label, 240);
  if (path.includes("\\") || path.includes(":") || path.includes("\0") || path.startsWith("/") || posix.isAbsolute(path)) {
    throw new Error(`${label} must be a portable relative package path.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isReservedWindowsName(segment))) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  if (!extensions.includes(extname(path).toLowerCase())) throw new Error(`${label} has an unsupported file type.`);
  return segments.join("/");
}

function parseNetworkTarget(value: unknown, label: string): RestrictedAppNetworkDeclaration["target"] {
  const target = objectValue(value, label, ["kind", "origin", "host", "port"]);
  if (target.kind === "loopback-http") {
    if (target.origin !== undefined) throw new Error(`${label} loopback target cannot declare an origin.`);
    if (target.host !== "127.0.0.1" && target.host !== "::1") throw new Error(`${label} loopback host must be 127.0.0.1 or ::1.`);
    if (!Number.isInteger(target.port) || (target.port as number) < 1_024 || (target.port as number) > 65_535) {
      throw new Error(`${label} loopback port must be between 1024 and 65535.`);
    }
    return { kind: "loopback-http", host: target.host, port: target.port as number };
  }
  if (target.kind !== "public-https") throw new Error(`${label} kind is unsupported.`);
  if (target.host !== undefined || target.port !== undefined) throw new Error(`${label} public target cannot declare a host or port.`);
  return { kind: "public-https", origin: publicOriginValue(target.origin, `${label} origin`) };
}

function publicOriginValue(value: unknown, label: string): string {
  const text = stringValue(value, label, 300);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an exact origin.`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname || url.hostname.includes("*")) {
    throw new Error(`${label} must be an exact origin without credentials or a path.`);
  }
  if (url.protocol !== "https:" || isIP(url.hostname) !== 0) {
    throw new Error(`${label} must be an exact HTTPS public DNS origin.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new Error(`${label} must name a public DNS origin; local-network destinations require a future separate permission.`);
  }
  return url.origin;
}

function publicIssuerValue(value: unknown, label: string): string {
  const text = stringValue(value, label, 500);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an exact public HTTPS issuer URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || isIP(url.hostname) !== 0
    || !url.hostname.includes(".") || url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal") || url.hostname.endsWith(".home.arpa")) {
    throw new Error(`${label} must be an exact public HTTPS issuer URL.`);
  }
  return url.pathname === "/" ? url.origin : url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

export function restrictedAppNetworkOrigin(destination: RestrictedAppNetworkDeclaration): string {
  return destination.target.kind === "public-https"
    ? destination.target.origin
    : `http://${destination.target.host === "::1" ? "[::1]" : destination.target.host}:${destination.target.port}`;
}

function optionalIdValue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return idValue(value, label);
}

function objectValue(
  value: unknown,
  label: string,
  allowedKeys?: string[],
  maximumKeys = allowedKeys?.length ?? 64,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > maximumKeys) throw new Error(`${label} has too many fields.`);
  if (allowedKeys) {
    const unknown = keys.find((key) => !allowedKeys.includes(key));
    if (unknown) throw new Error(`${label} contains an unsupported field: ${unknown}`);
  }
  return record;
}

function arrayValue(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain between ${minimum} and ${maximum} items.`);
  }
  return value;
}

function stringValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  return text;
}

function optionalStringValue(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, label, maximum);
}

function idValue(value: unknown, label: string): string {
  const id = stringValue(value, label, 64);
  if (!idPattern.test(id)) throw new Error(`${label} must use lowercase letters, numbers, and hyphens.`);
  return id;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is duplicated.`);
}

function copyBound<K extends "minLength" | "maxLength" | "minItems" | "maxItems">(
  source: Record<string, unknown>,
  target: RestrictedAppJsonSchema,
  key: K,
  label: string,
  minimum: number,
  maximum: number,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} ${key} is invalid.`);
  }
  target[key] = value as RestrictedAppJsonSchema[K];
}

function copyNumber<K extends "minimum" | "maximum">(
  source: Record<string, unknown>,
  target: RestrictedAppJsonSchema,
  key: K,
  label: string,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} ${key} is invalid.`);
  target[key] = value;
}

function isReservedWindowsName(segment: string): boolean {
  const stem = segment.split(".")[0]?.toUpperCase();
  return stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/.test(stem ?? "") || /^LPT[1-9]$/.test(stem ?? "")
    || segment.endsWith(".") || segment.endsWith(" ");
}

function schemaValueMatchesType(value: unknown, type: RestrictedAppJsonSchema["type"]): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function runtimeValueMatchesType(type: RestrictedAppJsonSchema["type"], value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
