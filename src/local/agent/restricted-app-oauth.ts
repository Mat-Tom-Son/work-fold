import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";

import { parseAppPlatformArtifactDigest } from "./app-platform-artifact.js";
import {
  parseFeatureInstallationId,
  parsePrincipalId,
  parseRuntimeInstanceId,
  parseSha256Digest,
  parseTenantId,
  type DeclarationDigest,
} from "./app-platform-contract.js";
import type {
  RestrictedAppConnectionBinding,
  RestrictedAppEffectAuthorizer,
} from "./restricted-app-connections.js";
import { isIssuerEndpointHost } from "./restricted-app-manifest.js";

export type RestrictedAppOAuthBinding = RestrictedAppConnectionBinding;

export type RestrictedAppOAuthDiscoveryKind =
  | "oauth-authorization-server"
  | "openid-configuration"
  | "pinned";

export interface RestrictedAppOAuthPkceConfiguration {
  issuer: string;
  clientId: string;
  scopes: string[];
  /** Defaults to RFC 8414 discovery when a caller omits it. */
  discovery?: RestrictedAppOAuthDiscoveryKind;
  /** Required when `discovery` is `pinned`, rejected otherwise. */
  authorizationEndpoint?: string;
  /** Required when `discovery` is `pinned`, rejected otherwise. */
  tokenEndpoint?: string;
  /** Reviewed static authorization-request parameters. */
  authorizationParameters?: Array<{ name: string; value: string }>;
}

/**
 * Advertisement mismatches work-fold deliberately does not fail on. Every one
 * of these describes a capability the client supplies itself: S256 is always
 * sent, no client secret exists to send, and the authorization-code flow is the
 * only flow implemented. Real providers under-populate these fields — neither
 * Google nor Microsoft advertises `none` for token-endpoint auth — so gating on
 * them rejects working providers while proving nothing about the ones it lets
 * through.
 */
export type RestrictedAppOAuthDiagnosticCode =
  | "METADATA_RESPONSE_TYPE_UNDECLARED"
  | "METADATA_PKCE_UNDECLARED"
  | "METADATA_PUBLIC_CLIENT_UNDECLARED";

export interface RestrictedAppOAuthDiagnostic {
  code: RestrictedAppOAuthDiagnosticCode;
  issuer: string;
  message: string;
}

export interface RestrictedAppOAuthConnection {
  kind: "oauth2-pkce";
  issuer: string;
  clientId: string;
  requestedScopes: string[];
  grantedScopes: string[];
  tokenType: "Bearer";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  connectedAt: string;
  /** Public provider-compatibility notes retained with the encrypted connection. */
  diagnostics?: RestrictedAppOAuthDiagnostic[];
}

/**
 * Implementations are part of the desktop host and must persist these records
 * only through operating-system-backed encryption. Restricted app JavaScript
 * must never receive this interface or a stored record.
 */
export interface RestrictedAppOAuthEncryptedConnectionStore {
  readonly encrypted: true;
  get(binding: RestrictedAppOAuthBinding): Promise<RestrictedAppOAuthConnection | undefined>;
  set(binding: RestrictedAppOAuthBinding, connection: RestrictedAppOAuthConnection, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<void>;
  delete(binding: RestrictedAppOAuthBinding, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<boolean>;
}

export interface RestrictedAppOAuthJsonResponse {
  status: number;
  body: unknown;
}

/**
 * The desktop implementation must reject redirects, resolve and pin a public
 * address, preserve TLS hostname verification, enforce the supplied byte
 * limit, and honor the abort signal. The OAuth client still validates every
 * URL and response before handing it to this transport.
 */
export interface RestrictedAppOAuthPublicHttpsTransport {
  getJson(
    url: URL,
    options: { signal: AbortSignal; maxResponseBytes: number; authorizeEffect?: RestrictedAppEffectAuthorizer },
  ): Promise<RestrictedAppOAuthJsonResponse>;
  postForm(
    url: URL,
    form: URLSearchParams,
    options: { signal: AbortSignal; maxResponseBytes: number; authorizeEffect?: RestrictedAppEffectAuthorizer },
  ): Promise<RestrictedAppOAuthJsonResponse>;
}

export interface RestrictedAppOAuthPkceClientOptions {
  store: RestrictedAppOAuthEncryptedConnectionStore;
  transport: RestrictedAppOAuthPublicHttpsTransport;
  openExternal(url: string): Promise<void>;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  flowTimeoutMs?: number;
  networkTimeoutMs?: number;
  refreshLeewayMs?: number;
  maxResponseBytes?: number;
  /**
   * Receives metadata mismatches that no longer block a connection. Host code
   * should surface these where a person reviews the connection; they are never
   * returned to app JavaScript.
   */
  onDiagnostic?: (diagnostic: RestrictedAppOAuthDiagnostic) => void;
}

export interface RestrictedAppOAuthConnectionStatus {
  kind: "oauth2-pkce";
  configured: true;
  scopes: string[];
  expiresAt?: string;
  diagnostics?: RestrictedAppOAuthDiagnostic[];
}

export type RestrictedAppOAuthErrorCode =
  | "AUTH_CANCELLED"
  | "AUTH_DENIED"
  | "AUTH_REQUIRED"
  | "CONFIG_INVALID"
  | "NETWORK_FAILED"
  | "PROVIDER_UNSUPPORTED"
  | "STORAGE_FAILED";

export class RestrictedAppOAuthError extends Error {
  constructor(readonly code: RestrictedAppOAuthErrorCode, message: string) {
    super(message);
    this.name = "RestrictedAppOAuthError";
  }
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  authorizationResponseIssuer: boolean;
  diagnostics: RestrictedAppOAuthDiagnostic[];
}

interface AuthorizationCallback {
  code: string;
}

interface CallbackListener {
  redirectUri: string;
  result: Promise<AuthorizationCallback>;
  close(): Promise<void>;
}

const maximumClientIdLength = 512;
const maximumScopeLength = 256;
const maximumTokenLength = 32 * 1024;
const maximumCallbackUrlLength = 16 * 1024;
const maximumFlowTimeoutMs = 10 * 60 * 1_000;
const maximumNetworkTimeoutMs = 60 * 1_000;

export class RestrictedAppOAuthPkceClient {
  readonly #store: RestrictedAppOAuthEncryptedConnectionStore;
  readonly #transport: RestrictedAppOAuthPublicHttpsTransport;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #flowTimeoutMs: number;
  readonly #networkTimeoutMs: number;
  readonly #refreshLeewayMs: number;
  readonly #maxResponseBytes: number;
  readonly #onDiagnostic?: (diagnostic: RestrictedAppOAuthDiagnostic) => void;
  readonly #refreshes = new Map<string, Promise<RestrictedAppOAuthConnection>>();
  readonly #generations = new Map<string, number>();

  constructor(options: RestrictedAppOAuthPkceClientOptions) {
    if (options.store.encrypted !== true) throw new Error("OAuth connections require an encrypted host store.");
    this.#store = options.store;
    this.#transport = options.transport;
    this.#openExternal = options.openExternal;
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#flowTimeoutMs = boundedDuration(options.flowTimeoutMs ?? 5 * 60 * 1_000, "OAuth flow timeout", 1, maximumFlowTimeoutMs);
    this.#networkTimeoutMs = boundedDuration(options.networkTimeoutMs ?? 15_000, "OAuth network timeout", 1, maximumNetworkTimeoutMs);
    this.#refreshLeewayMs = boundedDuration(options.refreshLeewayMs ?? 60_000, "OAuth refresh leeway", 0, 10 * 60 * 1_000);
    this.#maxResponseBytes = boundedDuration(options.maxResponseBytes ?? 64 * 1024, "OAuth response byte limit", 1_024, 512 * 1024);
    this.#onDiagnostic = options.onDiagnostic;
  }

  async connect(
    bindingValue: RestrictedAppOAuthBinding,
    configurationValue: RestrictedAppOAuthPkceConfiguration,
    cancellation?: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<RestrictedAppOAuthConnectionStatus> {
    const binding = normalizeBinding(bindingValue);
    const configuration = normalizeConfiguration(configurationValue);
    const generation = this.#advanceGeneration(binding);
    const flow = timedSignal(cancellation, this.#flowTimeoutMs);
    let callback: CallbackListener | undefined;
    try {
      const metadata = await this.#discover(binding, generation, configuration, flow.signal, authorizeEffect);
      const state = base64Url(this.#entropy(32));
      const verifier = base64Url(this.#entropy(32));
      const challenge = base64Url(createHash("sha256").update(verifier, "ascii").digest());
      const callbackPath = `/oauth/callback/${base64Url(this.#entropy(24))}`;
      callback = await createCallbackListener({
        path: callbackPath,
        expectedIssuer: configuration.issuer,
        requireIssuer: metadata.authorizationResponseIssuer,
        state,
        signal: flow.signal,
      });
      // A callback can arrive while the host is still awaiting openExternal.
      // Attach a rejection observer immediately so a denied callback never
      // becomes a transient unhandled rejection before we await it below.
      void callback.result.catch(() => undefined);
      const authorizationUrl = authorizationRequestUrl(metadata.authorizationEndpoint, {
        clientId: configuration.clientId,
        scopes: configuration.scopes,
        redirectUri: callback.redirectUri,
        state,
        challenge,
        ...(configuration.authorizationParameters ? { parameters: configuration.authorizationParameters } : {}),
      });
      await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
      try {
        await abortable(this.#openExternal(authorizationUrl.href), flow.signal);
      } catch (error) {
        if (error instanceof RestrictedAppOAuthError) throw error;
        throw new RestrictedAppOAuthError("NETWORK_FAILED", "work-fold could not open the OAuth authorization page.");
      }
      const authorization = await callback.result;
      const token = await this.#exchangeCode(
        binding,
        generation,
        metadata,
        configuration,
        callback.redirectUri,
        verifier,
        authorization.code,
        flow.signal,
        authorizeEffect,
      );
      await this.#storeMutation(
        binding,
        generation,
        authorizeEffect,
        (authorizeCommit) => this.#store.set(binding, token, authorizeCommit),
        "work-fold could not save the OAuth connection securely.",
      );
      return status(token);
    } finally {
      flow.dispose();
      await callback?.close();
    }
  }

  async status(
    bindingValue: RestrictedAppOAuthBinding,
    configurationValue: RestrictedAppOAuthPkceConfiguration,
  ): Promise<RestrictedAppOAuthConnectionStatus | null> {
    const binding = normalizeBinding(bindingValue);
    const configuration = normalizeConfiguration(configurationValue);
    const connection = await this.#read(binding, configuration);
    return connection ? status(connection) : null;
  }

  /** Inject a current token into a host-owned request without exposing it to app JavaScript. */
  async authorize(
    bindingValue: RestrictedAppOAuthBinding,
    configurationValue: RestrictedAppOAuthPkceConfiguration,
    headers: Headers,
    cancellation?: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<void> {
    const binding = normalizeBinding(bindingValue);
    const configuration = normalizeConfiguration(configurationValue);
    const generation = this.#generation(binding);
    let connection = await this.#read(binding, configuration);
    if (!connection) throw new RestrictedAppOAuthError("AUTH_REQUIRED", "Connect this app before it accesses the destination.");
    if (expiresSoon(connection, this.#now(), this.#refreshLeewayMs)) {
      connection = await this.#refresh(binding, configuration, cancellation, authorizeEffect);
    }
    await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
    headers.set("authorization", `${connection.tokenType} ${connection.accessToken}`);
  }

  async disconnect(bindingValue: RestrictedAppOAuthBinding, authorizeEffect?: RestrictedAppEffectAuthorizer): Promise<boolean> {
    const binding = normalizeBinding(bindingValue);
    const generation = this.#advanceGeneration(binding);
    return await this.#storeMutation(
      binding,
      generation,
      authorizeEffect,
      (authorizeCommit) => this.#store.delete(binding, authorizeCommit),
      "work-fold could not remove the OAuth connection securely.",
    );
  }

  async #refresh(
    binding: RestrictedAppOAuthBinding,
    configuration: RestrictedAppOAuthPkceConfiguration,
    cancellation?: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<RestrictedAppOAuthConnection> {
    const key = bindingKey(binding);
    const active = this.#refreshes.get(key);
    if (active) {
      const generation = this.#generation(binding);
      const connection = await active;
      await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
      return connection;
    }
    const refresh = this.#performRefresh(binding, configuration, cancellation, authorizeEffect);
    this.#refreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#refreshes.get(key) === refresh) this.#refreshes.delete(key);
    }
  }

  async #performRefresh(
    binding: RestrictedAppOAuthBinding,
    configuration: RestrictedAppOAuthPkceConfiguration,
    cancellation?: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<RestrictedAppOAuthConnection> {
    const generation = this.#generation(binding);
    const current = await this.#read(binding, configuration);
    if (!current) throw new RestrictedAppOAuthError("AUTH_REQUIRED", "The OAuth connection is no longer available.");
    if (!expiresSoon(current, this.#now(), this.#refreshLeewayMs)) return current;
    if (!current.refreshToken) throw new RestrictedAppOAuthError("AUTH_REQUIRED", "The OAuth connection must be renewed in the browser.");
    const flow = timedSignal(cancellation, this.#networkTimeoutMs);
    try {
      const metadata = await this.#discover(binding, generation, configuration, flow.signal, authorizeEffect);
      const response = await this.#postForm(binding, generation, metadata.tokenEndpoint, new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: configuration.clientId,
      }), flow.signal, authorizeEffect);
      const refreshed = tokenConnection(response, configuration, this.#now(), {
        connectedAt: current.connectedAt,
        refreshToken: current.refreshToken,
        scopes: current.grantedScopes,
      }, metadata.diagnostics);
      await this.#storeMutation(
        binding,
        generation,
        authorizeEffect,
        (authorizeCommit) => this.#store.set(binding, refreshed, authorizeCommit),
        "work-fold could not rotate the OAuth connection securely.",
      );
      return refreshed;
    } finally {
      flow.dispose();
    }
  }

  async #discover(
    binding: RestrictedAppOAuthBinding,
    generation: number,
    configuration: RestrictedAppOAuthPkceConfiguration,
    cancellation: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<AuthorizationServerMetadata> {
    // Pinned endpoints skip the fetch entirely. The review surface renders them
    // for transparency, but the security boundary remains the issuer-host
    // constraint applied in normalizeConfiguration: a pinned endpoint must use
    // the issuer's exact host, so declaring one requires the same control that
    // declaring the issuer does.
    //
    // Pinned mode is genuinely weaker in one respect: with no metadata document
    // there is nothing to tell us whether the provider supports RFC 9207, so
    // the authorization-response `iss` check cannot be required here.
    if (configuration.discovery === "pinned") {
      return {
        issuer: configuration.issuer,
        authorizationEndpoint: publicHttpsUrl(configuration.authorizationEndpoint, "OAuth authorization endpoint"),
        tokenEndpoint: publicHttpsUrl(configuration.tokenEndpoint, "OAuth token endpoint"),
        authorizationResponseIssuer: false,
        diagnostics: [],
      };
    }
    const issuer = new URL(configuration.issuer);
    const metadataUrl = authorizationServerMetadataUrl(issuer, configuration.discovery ?? "oauth-authorization-server");
    const response = await this.#getJson(binding, generation, metadataUrl, cancellation, authorizeEffect);
    const metadata = strictRecord(response, "OAuth authorization-server metadata");
    // The issuer match stays a hard failure. It is the one assertion that binds
    // the fetched document to the reviewed identity, and unlike the capability
    // fields below it cannot be satisfied by anything the client does itself.
    if (metadata.issuer !== configuration.issuer) {
      throw new RestrictedAppOAuthError("PROVIDER_UNSUPPORTED", "The OAuth provider metadata does not match its declared issuer.");
    }
    if (metadata.grant_types_supported !== undefined) {
      const grants = stringArray(metadata.grant_types_supported, "OAuth grant types", 1, 32);
      if (!grants.includes("authorization_code")) unsupported("The OAuth provider does not advertise the authorization-code grant.");
    }
    const diagnostics: RestrictedAppOAuthDiagnostic[] = [];
    this.#reportAdvertisement(diagnostics, configuration.issuer, metadata, "response_types_supported", "code", 32,
      "METADATA_RESPONSE_TYPE_UNDECLARED", "does not advertise the authorization-code response type");
    this.#reportAdvertisement(diagnostics, configuration.issuer, metadata, "code_challenge_methods_supported", "S256", 16,
      "METADATA_PKCE_UNDECLARED", "does not advertise PKCE S256; work-fold always sends S256");
    this.#reportAdvertisement(diagnostics, configuration.issuer, metadata, "token_endpoint_auth_methods_supported", "none", 32,
      "METADATA_PUBLIC_CLIENT_UNDECLARED", "does not advertise public clients; work-fold never sends a client secret");
    return {
      issuer: configuration.issuer,
      authorizationEndpoint: publicHttpsUrl(metadata.authorization_endpoint, "OAuth authorization endpoint"),
      tokenEndpoint: publicHttpsUrl(metadata.token_endpoint, "OAuth token endpoint"),
      authorizationResponseIssuer: metadata.authorization_response_iss_parameter_supported === true,
      diagnostics,
    };
  }

  /**
   * Reports, rather than enforces, one capability advertisement. A malformed
   * value is still rejected: a provider that sends a non-array here is not
   * merely under-populating its metadata.
   */
  #reportAdvertisement(
    diagnostics: RestrictedAppOAuthDiagnostic[],
    issuer: string,
    metadata: Record<string, unknown>,
    field: string,
    required: string,
    maximum: number,
    code: RestrictedAppOAuthDiagnosticCode,
    detail: string,
  ): void {
    let diagnostic: RestrictedAppOAuthDiagnostic | undefined;
    if (metadata[field] === undefined) {
      diagnostic = { code, issuer, message: `The OAuth provider ${detail}.` };
    } else {
      const values = stringArray(metadata[field], `OAuth ${field}`, 1, maximum);
      if (!values.includes(required)) diagnostic = { code, issuer, message: `The OAuth provider ${detail}.` };
    }
    if (!diagnostic) return;
    diagnostics.push(diagnostic);
    this.#diagnostic(diagnostic);
  }

  #diagnostic(diagnostic: RestrictedAppOAuthDiagnostic): void {
    try {
      this.#onDiagnostic?.(diagnostic);
    } catch {
      // A host reporting sink must never break an otherwise valid connection.
    }
  }

  async #exchangeCode(
    binding: RestrictedAppOAuthBinding,
    generation: number,
    metadata: AuthorizationServerMetadata,
    configuration: RestrictedAppOAuthPkceConfiguration,
    redirectUri: string,
    verifier: string,
    code: string,
    cancellation: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<RestrictedAppOAuthConnection> {
    const response = await this.#postForm(binding, generation, metadata.tokenEndpoint, new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: configuration.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }), cancellation, authorizeEffect);
    return tokenConnection(response, configuration, this.#now(), undefined, metadata.diagnostics);
  }

  async #read(
    binding: RestrictedAppOAuthBinding,
    configuration: RestrictedAppOAuthPkceConfiguration,
  ): Promise<RestrictedAppOAuthConnection | undefined> {
    let connection: RestrictedAppOAuthConnection | undefined;
    try {
      connection = await this.#store.get(binding);
    } catch {
      throw new RestrictedAppOAuthError("STORAGE_FAILED", "work-fold could not read the OAuth connection securely.");
    }
    if (!connection) return undefined;
    const normalized = normalizeRestrictedAppOAuthConnection(connection);
    if (normalized.issuer !== configuration.issuer
      || normalized.clientId !== configuration.clientId
      || !sameStrings(normalized.requestedScopes, configuration.scopes)) {
      throw new RestrictedAppOAuthError("AUTH_REQUIRED", "The saved OAuth connection does not match this app revision.");
    }
    return normalized;
  }

  async #getJson(
    binding: RestrictedAppOAuthBinding,
    generation: number,
    url: URL,
    cancellation: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<unknown> {
    const network = timedSignal(cancellation, this.#networkTimeoutMs);
    try {
      let response: RestrictedAppOAuthJsonResponse;
      await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
      let authorityError: unknown;
      const authorizeTransportEffect = async (): Promise<void> => {
        try {
          await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
        } catch (error) {
          authorityError = error;
          throw error;
        }
      };
      try {
        response = await this.#transport.getJson(url, {
          signal: network.signal,
          maxResponseBytes: this.#maxResponseBytes,
          authorizeEffect: authorizeTransportEffect,
        });
      } catch (error) {
        if (error === authorityError || error instanceof RestrictedAppOAuthError) throw error;
        throw new RestrictedAppOAuthError("NETWORK_FAILED", "work-fold could not read the OAuth provider metadata.");
      }
      return successfulJson(response, this.#maxResponseBytes, "OAuth provider metadata");
    } finally {
      network.dispose();
    }
  }

  async #postForm(
    binding: RestrictedAppOAuthBinding,
    generation: number,
    url: URL,
    form: URLSearchParams,
    cancellation: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<unknown> {
    const network = timedSignal(cancellation, this.#networkTimeoutMs);
    try {
      let response: RestrictedAppOAuthJsonResponse;
      await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
      let authorityError: unknown;
      const authorizeTransportEffect = async (): Promise<void> => {
        try {
          await this.#assertEffectAuthorized(binding, generation, authorizeEffect);
        } catch (error) {
          authorityError = error;
          throw error;
        }
      };
      try {
        response = await this.#transport.postForm(url, form, {
          signal: network.signal,
          maxResponseBytes: this.#maxResponseBytes,
          authorizeEffect: authorizeTransportEffect,
        });
      } catch (error) {
        if (error === authorityError || error instanceof RestrictedAppOAuthError) throw error;
        throw new RestrictedAppOAuthError("NETWORK_FAILED", "work-fold could not complete the OAuth token request.");
      }
      return successfulJson(response, this.#maxResponseBytes, "OAuth token response");
    } finally {
      network.dispose();
    }
  }

  #entropy(size: number): Uint8Array {
    const value = this.#randomBytes(size);
    if (!(value instanceof Uint8Array) || value.byteLength !== size) throw new Error("OAuth entropy source returned an invalid value.");
    return value;
  }

  #generation(binding: RestrictedAppOAuthBinding): number {
    return this.#generations.get(bindingKey(binding)) ?? 0;
  }

  #advanceGeneration(binding: RestrictedAppOAuthBinding): number {
    const key = bindingKey(binding);
    const generation = this.#generation(binding) + 1;
    this.#generations.set(key, generation);
    this.#refreshes.delete(key);
    return generation;
  }

  #assertGeneration(binding: RestrictedAppOAuthBinding, expected: number): void {
    if (this.#generation(binding) !== expected) {
      throw new RestrictedAppOAuthError("AUTH_REQUIRED", "The OAuth connection changed before authorization completed.");
    }
  }

  async #assertEffectAuthorized(
    binding: RestrictedAppOAuthBinding,
    expectedGeneration: number,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<void> {
    this.#assertGeneration(binding, expectedGeneration);
    await authorizeEffect?.();
    this.#assertGeneration(binding, expectedGeneration);
  }

  async #storeMutation<T>(
    binding: RestrictedAppOAuthBinding,
    expectedGeneration: number,
    authorizeEffect: RestrictedAppEffectAuthorizer | undefined,
    mutate: (authorizeCommit: RestrictedAppEffectAuthorizer) => Promise<T>,
    failureMessage: string,
  ): Promise<T> {
    let authorityError: unknown;
    const authorizeCommit = async (): Promise<void> => {
      try {
        await this.#assertEffectAuthorized(binding, expectedGeneration, authorizeEffect);
      } catch (error) {
        authorityError = error;
        throw error;
      }
    };
    await authorizeCommit();
    try {
      return await mutate(authorizeCommit);
    } catch (error) {
      if (error === authorityError || error instanceof RestrictedAppOAuthError) throw error;
      throw new RestrictedAppOAuthError("STORAGE_FAILED", failureMessage);
    }
  }
}

function normalizeConfiguration(value: RestrictedAppOAuthPkceConfiguration): RestrictedAppOAuthPkceConfiguration {
  // `kind` is accepted and ignored because the production caller
  // (RestrictedAppService.connectOAuth) passes the parsed manifest auth
  // declaration verbatim, and that object always carries kind: "oauth2-pkce".
  // Omitting it from this allow-list made every real connect and refresh fail
  // CONFIG_INVALID; no suite caught it because the tests build kind-less
  // configuration literals.
  const record = strictRecord(value, "OAuth PKCE configuration", [
    "kind", "issuer", "clientId", "scopes", "discovery", "authorizationEndpoint", "tokenEndpoint", "authorizationParameters",
  ]);
  if (record.kind !== undefined && record.kind !== "oauth2-pkce") {
    configInvalid("OAuth PKCE configuration kind is unsupported.");
  }
  const issuerUrl = publicHttpsUrl(record.issuer, "OAuth issuer", true);
  const issuer = boundedString(record.issuer, "OAuth issuer", 2_048);
  const canonicalIssuer = issuerUrl.pathname === "/" && !issuerUrl.search ? issuerUrl.origin : issuerUrl.href;
  if (canonicalIssuer !== issuer) configInvalid("OAuth issuer must use its canonical HTTPS URL.");
  const clientId = boundedString(record.clientId, "OAuth client id", maximumClientIdLength);
  if (/[^\x20-\x7e]/.test(clientId) || /\s/.test(clientId)) configInvalid("OAuth client id contains unsupported characters.");
  const scopes = stringArray(record.scopes, "OAuth scopes", 1, 32).map((scope) => {
    if (scope.length > maximumScopeLength || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)) {
      configInvalid("OAuth scope contains unsupported characters.");
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) configInvalid("OAuth scopes must be unique.");
  if (scopes.includes("openid")) configInvalid("OpenID Connect scopes are not supported by this OAuth connection.");
  if (scopes.join(" ").length > 2_048) configInvalid("OAuth scopes exceed the size limit.");
  const discovery = record.discovery === undefined ? "oauth-authorization-server" as const : record.discovery;
  if (discovery !== "oauth-authorization-server" && discovery !== "openid-configuration" && discovery !== "pinned") {
    configInvalid("OAuth discovery mode is unsupported.");
  }
  if (discovery === "pinned") {
    if (record.authorizationEndpoint === undefined || record.tokenEndpoint === undefined) {
      configInvalid("Pinned OAuth discovery requires an authorization endpoint and a token endpoint.");
    }
  } else if (record.authorizationEndpoint !== undefined || record.tokenEndpoint !== undefined) {
    configInvalid("OAuth endpoints may only be supplied with pinned discovery.");
  }
  // `true` here also refuses a query string. A pinned authorization endpoint
  // must not arrive with parameters of its own, because the request builder
  // would merge them with the ones it sets and no reviewer saw that combination.
  //
  // The issuer-host constraint is enforced again here, not only in the manifest
  // parser. A configuration reaching this client by any other path must not be
  // able to point the token exchange — which carries the authorization code and
  // the PKCE verifier — at a host the issuer does not own.
  const issuerHost = new URL(issuer).hostname;
  const authorizationEndpoint = record.authorizationEndpoint === undefined
    ? undefined
    : issuerOwnedEndpoint(record.authorizationEndpoint, "OAuth authorization endpoint", issuerHost);
  const tokenEndpoint = record.tokenEndpoint === undefined
    ? undefined
    : issuerOwnedEndpoint(record.tokenEndpoint, "OAuth token endpoint", issuerHost);
  const authorizationParameters = normalizeAuthorizationParameters(record.authorizationParameters);
  return {
    issuer,
    clientId,
    scopes,
    discovery,
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(authorizationParameters.length ? { authorizationParameters } : {}),
  };
}

/**
 * Re-validates reviewed parameters at use time. The manifest parser is the
 * first gate; this is the second, so a configuration reaching the client by any
 * other path still cannot smuggle a protocol-owned name into the request.
 */
function normalizeAuthorizationParameters(value: unknown): Array<{ name: string; value: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) configInvalid("OAuth authorization parameters are invalid.");
  const seen = new Set<string>();
  return (value as unknown[]).map((entry) => {
    const item = strictRecord(entry, "OAuth authorization parameter", ["name", "value"]);
    const name = boundedString(item.name, "OAuth authorization parameter name", 32);
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) configInvalid("OAuth authorization parameter name is invalid.");
    if (reservedAuthorizationParameters.has(name)) {
      configInvalid("OAuth authorization parameter is owned by the authorization request.");
    }
    if (seen.has(name)) configInvalid("OAuth authorization parameters must be unique.");
    seen.add(name);
    const text = boundedString(item.value, "OAuth authorization parameter value", 256);
    if (!/^[\x20-\x7e]+$/.test(text)) configInvalid("OAuth authorization parameter value is invalid.");
    return { name, value: text };
  });
}

const reservedAuthorizationParameters = new Set([
  "client_assertion", "client_assertion_type", "client_id", "client_secret", "code", "code_challenge",
  "code_challenge_method", "code_verifier", "grant_type", "redirect_uri", "refresh_token",
  // RFC 9101 request objects and OIDC `request_uri` replace the parameters of
  // the request they appear in, so either one could restore a name this list
  // otherwise refuses. `response_mode` chooses how the response is delivered,
  // which the one-shot loopback listener depends on.
  "request", "request_uri", "response_mode", "response_type",
  "scope", "state",
]);

function issuerOwnedEndpoint(value: unknown, label: string, issuerHost: string): string {
  const url = publicHttpsUrl(value, label, true);
  if (!isIssuerEndpointHost(url.hostname, issuerHost)) {
    configInvalid(`${label} must use the OAuth issuer's exact host.`);
  }
  return url.href;
}

function normalizeBinding(value: RestrictedAppOAuthBinding): RestrictedAppOAuthBinding {
  const record = strictRecord(value, "OAuth connection binding", [
    "tenantId", "runtimeInstanceId", "featureId", "featureInstallationId", "featureRevisionDigest",
    "declarationId", "declarationDigest", "targetIdentity", "owner",
  ]);
  let tenantId;
  let runtimeInstanceId;
  let featureInstallationId;
  let featureRevisionDigest;
  let declarationDigest: DeclarationDigest;
  try {
    tenantId = parseTenantId(record.tenantId);
    runtimeInstanceId = parseRuntimeInstanceId(record.runtimeInstanceId);
    featureInstallationId = parseFeatureInstallationId(record.featureInstallationId);
    featureRevisionDigest = parseAppPlatformArtifactDigest(record.featureRevisionDigest);
    declarationDigest = parseSha256Digest(record.declarationDigest, "OAuth declaration digest") as unknown as DeclarationDigest;
  } catch (error) {
    configInvalid(error instanceof Error ? error.message : "OAuth connection identity is invalid.");
  }
  const featureId = identifier(record.featureId, "OAuth Feature id");
  const declarationId = identifier(record.declarationId, "OAuth declaration id");
  const originUrl = publicHttpsUrl(record.targetIdentity, "OAuth destination identity");
  if (originUrl.origin !== record.targetIdentity || originUrl.pathname !== "/" || originUrl.search || originUrl.hash) {
    configInvalid("OAuth destination identity must be an exact public HTTPS origin.");
  }
  const ownerRecord = strictRecord(record.owner, "OAuth connection owner", (record.owner as { kind?: unknown })?.kind === "instance"
    ? ["kind", "runtimeInstanceId"]
    : ["kind", "principalId"]);
  const owner = ownerRecord.kind === "instance"
    ? { kind: "instance" as const, runtimeInstanceId: parseRuntimeInstanceId(ownerRecord.runtimeInstanceId) }
    : ownerRecord.kind === "principal"
      ? { kind: "principal" as const, principalId: parsePrincipalId(ownerRecord.principalId) }
      : configInvalid("OAuth connection owner kind is invalid.");
  if (owner.kind === "instance" && owner.runtimeInstanceId !== runtimeInstanceId) {
    configInvalid("OAuth instance-owned connection does not belong to its Runtime Instance.");
  }
  return {
    tenantId,
    runtimeInstanceId,
    featureId,
    featureInstallationId,
    featureRevisionDigest,
    declarationId,
    declarationDigest,
    targetIdentity: originUrl.origin,
    owner,
  };
}

export function normalizeRestrictedAppOAuthConnection(value: RestrictedAppOAuthConnection): RestrictedAppOAuthConnection {
  const record = strictRecord(value, "Stored OAuth connection", [
    "kind", "issuer", "clientId", "requestedScopes", "grantedScopes", "tokenType", "accessToken", "refreshToken", "expiresAt", "connectedAt", "diagnostics",
  ]);
  if (record.kind !== "oauth2-pkce" || record.tokenType !== "Bearer") throw new Error("Stored OAuth connection kind is invalid.");
  const configuration = normalizeConfiguration({ issuer: record.issuer as string, clientId: record.clientId as string, scopes: record.requestedScopes as string[] });
  const grantedScopes = stringArray(record.grantedScopes, "Stored OAuth scopes", 1, 32);
  if (new Set(grantedScopes).size !== grantedScopes.length || grantedScopes.some((scope) => !configuration.scopes.includes(scope))) {
    throw new Error("Stored OAuth scopes exceed the requested grant.");
  }
  const accessToken = secret(record.accessToken, "Stored OAuth access token");
  const refreshToken = record.refreshToken === undefined ? undefined : secret(record.refreshToken, "Stored OAuth refresh token");
  const expiresAt = optionalIsoDate(record.expiresAt, "Stored OAuth expiration");
  const connectedAt = isoDate(record.connectedAt, "Stored OAuth connection time");
  const diagnostics = normalizeOAuthDiagnostics(record.diagnostics, configuration.issuer);
  return {
    kind: "oauth2-pkce",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    requestedScopes: configuration.scopes,
    grantedScopes,
    tokenType: "Bearer",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    connectedAt,
    ...(diagnostics.length ? { diagnostics } : {}),
  } as RestrictedAppOAuthConnection;
}

function tokenConnection(
  value: unknown,
  configuration: RestrictedAppOAuthPkceConfiguration,
  now: Date,
  prior?: { connectedAt: string; refreshToken: string; scopes: string[] },
  diagnostics: RestrictedAppOAuthDiagnostic[] = [],
): RestrictedAppOAuthConnection {
  const record = strictRecord(value, "OAuth token response");
  const accessToken = secret(record.access_token, "OAuth access token");
  if (typeof record.token_type !== "string" || record.token_type.toLowerCase() !== "bearer") {
    unsupported("The OAuth provider returned an unsupported token type.");
  }
  const refreshToken = record.refresh_token === undefined
    ? prior?.refreshToken
    : secret(record.refresh_token, "OAuth refresh token");
  let grantedScopes = prior?.scopes ?? configuration.scopes;
  if (record.scope !== undefined) {
    const scopeText = boundedString(record.scope, "OAuth granted scopes", 2_048);
    grantedScopes = scopeText.split(" ").filter(Boolean);
    if (!grantedScopes.length || new Set(grantedScopes).size !== grantedScopes.length
      || grantedScopes.some((scope) => !configuration.scopes.includes(scope))) {
      unsupported("The OAuth provider returned scopes outside the requested grant.");
    }
  }
  let expiresAt: string | undefined;
  if (record.expires_in !== undefined) {
    if (!Number.isInteger(record.expires_in) || (record.expires_in as number) < 1 || (record.expires_in as number) > 10 * 365 * 24 * 60 * 60) {
      unsupported("The OAuth provider returned an invalid token lifetime.");
    }
    expiresAt = new Date(now.valueOf() + (record.expires_in as number) * 1_000).toISOString();
  }
  return {
    kind: "oauth2-pkce",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    requestedScopes: [...configuration.scopes],
    grantedScopes: [...grantedScopes],
    tokenType: "Bearer",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    connectedAt: prior?.connectedAt ?? now.toISOString(),
    ...(diagnostics.length ? { diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })) } : {}),
  };
}

function normalizeOAuthDiagnostics(value: unknown, issuer: string): RestrictedAppOAuthDiagnostic[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) throw new Error("Stored OAuth diagnostics are invalid.");
  const codes = new Set<RestrictedAppOAuthDiagnosticCode>([
    "METADATA_RESPONSE_TYPE_UNDECLARED",
    "METADATA_PKCE_UNDECLARED",
    "METADATA_PUBLIC_CLIENT_UNDECLARED",
  ]);
  return value.map((entry) => {
    const record = strictRecord(entry, "Stored OAuth diagnostic", ["code", "issuer", "message"]);
    if (typeof record.code !== "string" || !codes.has(record.code as RestrictedAppOAuthDiagnosticCode)) {
      throw new Error("Stored OAuth diagnostic code is invalid.");
    }
    const diagnosticIssuer = boundedString(record.issuer, "Stored OAuth diagnostic issuer", 2_048);
    if (diagnosticIssuer !== issuer) throw new Error("Stored OAuth diagnostic issuer is invalid.");
    return {
      code: record.code as RestrictedAppOAuthDiagnosticCode,
      issuer: diagnosticIssuer,
      message: boundedString(record.message, "Stored OAuth diagnostic message", 500),
    };
  });
}

/**
 * RFC 8414 inserts the well-known segment before the issuer path; OpenID
 * Connect Discovery appends it after. Both documents carry the same fields this
 * client reads, so only the URL shape differs between the two modes.
 */
function authorizationServerMetadataUrl(issuer: URL, discovery: RestrictedAppOAuthDiscoveryKind): URL {
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  if (discovery === "openid-configuration") {
    const result = new URL(issuer.origin);
    result.pathname = `${issuerPath}/.well-known/openid-configuration`;
    return result;
  }
  const result = new URL(issuer.origin);
  result.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  return result;
}

function authorizationRequestUrl(endpoint: URL, input: {
  clientId: string;
  scopes: string[];
  redirectUri: string;
  state: string;
  challenge: string;
  parameters?: Array<{ name: string; value: string }>;
}): URL {
  const url = new URL(endpoint);
  // Reviewed extras are applied first so the protocol parameters below
  // overwrite them unconditionally. The manifest parser already refuses these
  // names; this ordering means a gap there still cannot change what is sent.
  for (const parameter of input.parameters ?? []) {
    url.searchParams.set(parameter.name, parameter.value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function createCallbackListener(input: {
  path: string;
  expectedIssuer: string;
  requireIssuer: boolean;
  state: string;
  signal: AbortSignal;
}): Promise<CallbackListener> {
  let settle: ((value: AuthorizationCallback) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  let consumed = false;
  const result = new Promise<AuthorizationCallback>((resolvePromise, reject) => {
    settle = resolvePromise;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const host = request.headers.host;
    if (request.method !== "GET" || typeof request.url !== "string" || request.url.length > maximumCallbackUrlLength) {
      callbackResponse(response, 405, false);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url, `http://${host ?? "invalid"}`);
    } catch {
      callbackResponse(response, 400, false);
      return;
    }
    const address = server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    if (url.pathname !== input.path || host !== expectedHost || request.socket.remoteAddress !== "127.0.0.1") {
      callbackResponse(response, 404, false);
      return;
    }
    if (consumed) {
      callbackResponse(response, 409, false);
      return;
    }
    consumed = true;
    const state = singleParameter(url, "state");
    const code = singleParameter(url, "code");
    const oauthError = singleParameter(url, "error");
    const responseIssuer = singleParameter(url, "iss");
    let error: RestrictedAppOAuthError | undefined;
    if (!state || !constantTimeEqual(state, input.state)) {
      error = new RestrictedAppOAuthError("AUTH_DENIED", "The OAuth callback state did not match the authorization request.");
    } else if ((input.requireIssuer || responseIssuer !== undefined) && responseIssuer !== input.expectedIssuer) {
      error = new RestrictedAppOAuthError("AUTH_DENIED", "The OAuth callback issuer did not match the authorization request.");
    } else if (oauthError !== undefined) {
      error = new RestrictedAppOAuthError("AUTH_DENIED", `The OAuth provider declined authorization${safeOAuthError(oauthError)}.`);
    } else if (!code || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("error").length) {
      error = new RestrictedAppOAuthError("AUTH_DENIED", "The OAuth callback did not contain one authorization code.");
    }
    callbackResponse(response, error ? 400 : 200, !error);
    setImmediate(() => void closeServer(server));
    if (error) fail?.(error);
    else settle?.({ code: code! });
  });
  server.maxHeadersCount = 20;
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  const abort = () => {
    if (consumed) return;
    consumed = true;
    fail?.(new RestrictedAppOAuthError("AUTH_CANCELLED", "The OAuth authorization was cancelled or timed out."));
    void closeServer(server);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  try {
    await listenLoopback(server);
  } catch {
    input.signal.removeEventListener("abort", abort);
    throw new RestrictedAppOAuthError("NETWORK_FAILED", "work-fold could not open a loopback OAuth callback listener.");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    input.signal.removeEventListener("abort", abort);
    await closeServer(server);
    throw new RestrictedAppOAuthError("NETWORK_FAILED", "work-fold could not determine the OAuth callback address.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${input.path}`,
    result,
    close: async () => {
      input.signal.removeEventListener("abort", abort);
      await closeServer(server);
    },
  };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeListener("error", onError);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function callbackResponse(response: import("node:http").ServerResponse, statusCode: number, success: boolean): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>work-fold sign-in</title><p>${success ? "Sign-in complete. You can return to work-fold." : "Sign-in could not be completed. You can return to work-fold."}</p>`);
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function successfulJson(response: RestrictedAppOAuthJsonResponse, maximum: number, label: string): unknown {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
    throw new RestrictedAppOAuthError("NETWORK_FAILED", `${label} failed.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(response.body);
  } catch {
    throw new RestrictedAppOAuthError("NETWORK_FAILED", `${label} was not valid JSON.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maximum) {
    throw new RestrictedAppOAuthError("NETWORK_FAILED", `${label} exceeded the response limit.`);
  }
  return response.body;
}

function publicHttpsUrl(value: unknown, label: string, issuer = false): URL {
  const text = boundedString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    configInvalid(`${label} must be an HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname || url.hostname.includes("*")) {
    configInvalid(`${label} must be a public HTTPS URL without credentials or a fragment.`);
  }
  if (issuer && url.search) configInvalid(`${label} cannot contain a query.`);
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) !== 0 || !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    configInvalid(`${label} must name a public DNS host.`);
  }
  return url;
}

function strictRecord(value: unknown, label: string, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (allowed) {
    const unknown = Object.keys(record).find((key) => !allowed.includes(key));
    if (unknown) configInvalid(`${label} contains an unsupported field: ${unknown}`);
  }
  return record;
}

function stringArray(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((item) => typeof item !== "string" || !item)) {
    throw new RestrictedAppOAuthError("PROVIDER_UNSUPPORTED", `${label} is invalid.`);
  }
  return value as string[];
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/.test(value)) configInvalid(`${label} is invalid.`);
  return value;
}

function identifier(value: unknown, label: string, maximum = 64): string {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9._-]+$/.test(value)) configInvalid(`${label} is invalid.`);
  return value;
}

function secret(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > maximumTokenLength || /[\0\r\n]/.test(value)) {
    throw new RestrictedAppOAuthError("PROVIDER_UNSUPPORTED", `${label} is invalid.`);
  }
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function optionalIsoDate(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : isoDate(value, label);
}

function status(connection: RestrictedAppOAuthConnection): RestrictedAppOAuthConnectionStatus {
  return {
    kind: "oauth2-pkce",
    configured: true,
    scopes: [...connection.grantedScopes],
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
    ...(connection.diagnostics?.length
      ? { diagnostics: connection.diagnostics.map((diagnostic) => ({ ...diagnostic })) }
      : {}),
  };
}

function expiresSoon(connection: RestrictedAppOAuthConnection, now: Date, leewayMs: number): boolean {
  return connection.expiresAt !== undefined && Date.parse(connection.expiresAt) <= now.valueOf() + leewayMs;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function safeOAuthError(value: string): string {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value) ? ` (${value})` : "";
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bindingKey(binding: RestrictedAppOAuthBinding): string {
  return JSON.stringify([
    binding.tenantId,
    binding.runtimeInstanceId,
    binding.featureId,
    binding.featureInstallationId,
    binding.featureRevisionDigest,
    binding.declarationId,
    binding.declarationDigest,
    binding.targetIdentity,
    binding.owner.kind,
    binding.owner.kind === "instance" ? binding.owner.runtimeInstanceId : binding.owner.principalId,
  ]);
}

function boundedDuration(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid.`);
  return value;
}

function timedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(new RestrictedAppOAuthError("AUTH_CANCELLED", "The OAuth authorization was cancelled or timed out."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function configInvalid(message: string): never {
  throw new RestrictedAppOAuthError("CONFIG_INVALID", message);
}

function unsupported(message: string): never {
  throw new RestrictedAppOAuthError("PROVIDER_UNSUPPORTED", message);
}
