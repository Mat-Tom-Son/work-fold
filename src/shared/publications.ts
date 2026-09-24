/**
 * The shared, dependency-free half of "pages your fold serves"
 * (docs/fold-publishing.md, rung 2): the closed source set, the budget
 * ceilings, and the publisher-facing page state. The desktop publication
 * service (`src/local/publications.ts`) enforces these; the renderer reads
 * the same values so the file tab and Settings → Shared pages never offer
 * something the host would refuse.
 */

export type WorkFoldPublicationMediaType = "text/html" | "image/png" | "image/jpeg" | "application/pdf";

/**
 * The closed first-slice source set: Markdown and plain text render
 * desktop-side into one inert HTML body; PNG, JPEG, and PDF ship as bytes the
 * shell renders from local blob URLs. Person-authored HTML and SVG are
 * deliberately absent — an app (rung 3) is the vehicle for script.
 */
export const WORKFOLD_PUBLICATION_SOURCE_TYPES: Readonly<Record<string, WorkFoldPublicationMediaType>> = Object.freeze({
  ".md": "text/html",
  ".markdown": "text/html",
  ".txt": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
});

/** Budget defaults and ceilings, mirroring the bridge's admission bounds. */
export const WORKFOLD_PUBLICATION_SERVE_RATE_DEFAULT = 60;
export const WORKFOLD_PUBLICATION_SERVE_RATE_MAXIMUM = 600;
export const WORKFOLD_PUBLICATION_BYTE_BUDGET_DEFAULT = 256 * 1024 * 1024;
export const WORKFOLD_PUBLICATION_BYTE_BUDGET_MAXIMUM = 1024 * 1024 * 1024;

export const WORKFOLD_PUBLICATION_TITLE_MAX_LENGTH = 80;

/**
 * The one refusal for a share with no enrolled address
 * (docs/fold-publishing.md: sharing with no address fails). Setting up web
 * access is a person-only prerequisite; nothing waits behind it.
 */
export const WORKFOLD_PUBLICATION_NO_ADDRESS_MESSAGE = "Set up web access before sharing a page.";

/** True when a Space-relative path names a file type a page can be made from. */
export function isWorkFoldPublicationSourcePath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return Object.prototype.hasOwnProperty.call(WORKFOLD_PUBLICATION_SOURCE_TYPES, name.slice(dot).toLowerCase());
}

/**
 * The page's state as its publisher sees it. The viewer only ever gets the
 * vague honest states at the relay; the precise reason rides here.
 */
export type WorkFoldPublicationPageState = "live" | "asleep" | "resting" | "not-available" | "stopped";

export interface WorkFoldPublicationHealth {
  state: WorkFoldPublicationPageState;
  /** One plain sentence: the precise reason behind the state word. */
  reason: string;
}

export interface WorkFoldPublicationHealthInput {
  state: "active" | "revoked" | "expired";
  bridgeSlot: "pending" | "confirmed";
  bridgeCleanup?: "pending" | "ok";
  lastProblem?: { state: "not-available" | "resting"; reason: string };
}

/**
 * Derives the page state from the grant record alone: stopped (revoked or
 * expired) wins, then the record's one bounded health note (not available,
 * then resting), then an unconfirmed relay slot (asleep), else live. The
 * desktop's own relay connection is not in the record; the renderer layers
 * it on with {@link workFoldPublicationHealthWithConnection}.
 */
export function workFoldPublicationHealth(input: WorkFoldPublicationHealthInput): WorkFoldPublicationHealth {
  if (input.state === "revoked") {
    return {
      state: "stopped",
      reason: input.bridgeCleanup === "pending"
        ? "You stopped sharing this page. The relay is still removing it."
        : "You stopped sharing this page.",
    };
  }
  if (input.state === "expired") return { state: "stopped", reason: "This page's link expired." };
  if (input.lastProblem?.state === "not-available") return { state: "not-available", reason: problemSentence(input.lastProblem.reason) };
  if (input.lastProblem?.state === "resting") return { state: "resting", reason: problemSentence(input.lastProblem.reason) };
  if (input.bridgeSlot === "pending") return { state: "asleep", reason: "The relay has not confirmed this page yet." };
  return { state: "live", reason: "Your desktop is serving this page." };
}

export interface WorkFoldPublicationConnection {
  configured: boolean;
  enabled: boolean;
  connection: "stopped" | "connecting" | "connected" | "error";
}

/**
 * A live or asleep page is asleep while this desktop is not connected to
 * the relay; a page problem or a stopped page keeps its own state.
 */
export function workFoldPublicationHealthWithConnection(
  health: WorkFoldPublicationHealth,
  connection: WorkFoldPublicationConnection | null,
): WorkFoldPublicationHealth {
  if (!connection || (health.state !== "live" && health.state !== "asleep")) return health;
  if (!connection.configured) return { state: "asleep", reason: "Web access is not set up." };
  if (!connection.enabled) return { state: "asleep", reason: "Web access is turned off." };
  if (connection.connection === "error") return { state: "asleep", reason: "Your desktop cannot reach the relay." };
  if (connection.connection !== "connected") return { state: "asleep", reason: "Your desktop is not connected to the relay." };
  return health;
}

function problemSentence(reason: string): string {
  const trimmed = reason.trim().replace(/^its /i, "This page's ");
  if (!trimmed) return "This page cannot be served right now.";
  const capitalized = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?…]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
