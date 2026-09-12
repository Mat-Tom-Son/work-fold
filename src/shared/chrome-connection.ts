/** Content-free setup state. No connection credentials belong in this shape. */
export type ChromeConnectionState =
  | "not_connected" | "connecting" | "connected" | "app_not_running"
  | "native_host_missing" | "update_app" | "update_extension"
  | "profile_conflict" | "busy" | "store_unavailable" | "connection_error";

export interface ChromeConnectionSummary {
  state: ChromeConnectionState;
  checkedAt: string;
  extensionVersion?: string;
  /** Supplied by the running host; an unreachable helper must not guess it. */
  hasSelection?: boolean;
}

export type ChromeSetupAction = "connect-chrome" | "disconnect-chrome" | "change-chrome-profile" | "check";

export interface ChromeBridgeCompatibility {
  major: number;
  minor: number;
  capabilities: string[];
}

/** Native-only data. Never serialize this through renderer, CLI or Chat APIs. */
export interface ChromeRuntimeConnection {
  connectionId: string;
  leaseToken: string;
  extensionOrigin: string;
  bridge: ChromeBridgeCompatibility;
}

export interface ChromeConnectionObservation {
  connectionId: string;
  state: "connected" | "not_connected" | "update_app" | "update_extension" | "connection_error";
  extensionVersion?: string;
}

/** Optional native Pi host facilities; factories and catalog reads stay inert. */
export interface ChromeHostFacilities {
  getChromeConnection(): Promise<ChromeRuntimeConnection | undefined>;
  onChromeConnectionRevoked(listener: () => void): () => void;
  reportChromeConnectionObservation(observation: ChromeConnectionObservation): void;
  /** Acquired on a turn's first Chrome operation, released on end/Stop/disposal. */
  beginChromeWork(connectionId: string): () => void;
}

/** The helper supplies its checked caller origin separately from this message. */
export interface ChromeBootstrapRequest {
  version: 1;
  action: "connect" | "resume" | "disconnect" | "status" | "open-app";
  requestId: string;
  clientId: string;
  clientProof?: string;
  extensionVersion: string;
  bridge: ChromeBridgeCompatibility;
}

export type ChromeBootstrapResponse =
  | { version: 1; state: "lease_ready"; connection: ChromeRuntimeConnection }
  | { version: 1; state: "status"; status: ChromeConnectionSummary };
