/** Trusted desktop setup status. No lease tokens, monitor names, pixels,
 * filesystem roots or desktop transport identifiers cross this boundary. */
export interface ComputerSessionOwner {
  scope: "space" | "management";
  conversationId: string;
  spaceId?: string;
}
export interface ComputerSessionSummary {
  state: "idle" | "requesting" | "active" | "stopping" | "error";
  owner?: ComputerSessionOwner;
  capture: boolean;
  pointer: boolean;
  keyboard: boolean;
  controlInUse: boolean;
  detail: string;
  checkedAt: string;
}
/** Native-only protocol. This is never a renderer or restricted-app bridge. */
export type SharedScreenAction =
  | { action: "click"; x: number; y: number; button?: "left" | "right" | "middle"; count?: number }
  | { action: "moveMouse"; x: number; y: number }
  | { action: "typeText"; text: string }
  | { action: "keypress"; keys: string[] }
  | { action: "scroll"; x: number; y: number; scrollX: number; scrollY: number }
  | { action: "drag"; path: Array<{ x: number; y: number }> };
export interface SharedScreenObservation {
  targetId: string;
  observationId: string;
  kind: "shared_screen";
  frame: { width: number; height: number; capturedAtMs: number; sha256: string };
  inputAvailable: boolean;
  image: { mimeType: "image/png"; data: string };
  inputSent?: boolean;
  actionCount?: number;
}
export interface SharedScreenTarget { id: string; kind: "shared_screen"; title: "Shared screen" }
export interface ComputerHostFacilities {
  releaseSharedScreenSession(): Promise<void>;
  listSharedScreens(signal?: AbortSignal): Promise<SharedScreenTarget[]>;
  observeSharedScreen(targetId: string, signal?: AbortSignal): Promise<SharedScreenObservation>;
  actOnSharedScreen(targetId: string, observationId: string, actions: SharedScreenAction[], signal?: AbortSignal): Promise<SharedScreenObservation>;
}
