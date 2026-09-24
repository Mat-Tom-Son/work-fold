import type { AgentExtensionSurface, AgentStatus, ConversationSummary, TreeEntry, SpaceCheckpoint, SpaceCustomizationMap, SpaceFixtureConversation, SpaceSummary } from "../types";
import type { SharedPageView } from "../lib/page-sharing";

export interface SpaceUiFixture {
  spaces: SpaceSummary[];
  activeSpaceId: string;
  customizations: SpaceCustomizationMap;
  trees: Record<string, TreeEntry[]>;
  conversations: Record<string, SpaceFixtureConversation[]>;
  checkpoints: Record<string, SpaceCheckpoint[]>;
  surfaces: Record<string, AgentExtensionSurface[]>;
  library: TreeEntry[];
  agent: AgentStatus;
}

export function buildSpaceFixture(): SpaceUiFixture {
  const now = "2026-07-10T18:30:00.000Z";
  const snoozedUntil = new Date(Date.now() + 22 * 60 * 60 * 1_000).toISOString();
  const home: SpaceSummary = { id: "fixture-home", name: "Home projects", spaceRoot: "C:\\Users\\you\\Documents\\Home projects", location: { kind: "local", storage: "linked" }, createdAt: now, updatedAt: now };
  const trip: SpaceSummary = { id: "fixture-trip", name: "Japan trip", spaceRoot: "G:\\My Drive\\Japan trip", location: { kind: "local", storage: "linked", providerHint: "google-drive" }, createdAt: now, updatedAt: now };
  return {
    spaces: [home, trip], activeSpaceId: home.id,
    customizations: {
      [home.id]: { color: "#0d74ce", color2: "#5c7c2e", iconName: "home", bannerName: "horizon" },
      [trip.id]: { color: "#6550b9", color2: "#c2298a", iconName: "airplane", bannerName: "aurora" },
    },
    agent: { ready: true, configured: true, provider: "openrouter", model: "anthropic/claude-sonnet-4", piVersion: "0.80.3", projectTrusted: true, error: null },
    trees: {
      [home.id]: [
        { name: "Kitchen refresh", path: "Kitchen refresh", kind: "folder", hasChildren: true, children: [{ name: "ideas.md", path: "Kitchen refresh/ideas.md", kind: "file", sizeBytes: 5240, updatedAt: now }, { name: "budget.xlsx", path: "Kitchen refresh/budget.xlsx", kind: "file", sizeBytes: 48200, updatedAt: now }] },
        { name: "Garden", path: "Garden", kind: "folder", hasChildren: true, children: [{ name: "planting-plan.pdf", path: "Garden/planting-plan.pdf", kind: "file", sizeBytes: 812000, updatedAt: now }] },
        { name: "weekend checklist.md", path: "weekend checklist.md", kind: "file", sizeBytes: 2120, updatedAt: now },
      ],
      [trip.id]: [{ name: "Bookings", path: "Bookings", kind: "folder", hasChildren: true, children: [{ name: "hotel.pdf", path: "Bookings/hotel.pdf", kind: "file", sizeBytes: 222000, updatedAt: now }] }, { name: "itinerary.md", path: "itinerary.md", kind: "file", sizeBytes: 8430, updatedAt: now }],
    },
    conversations: {
      [home.id]: [
        { id: "fixture-chat-1", title: "Compare contractor estimates", createdAt: now, updatedAt: now, runtimePreviews: [
          { id: "thinking-1", kind: "thinking", text: "I compared the scope and **checked the allowance assumptions before summarizing the tradeoffs.", phase: "complete" },
          { id: "tool-1", kind: "tool", toolName: "read", text: "Read finished", detail: "Kitchen refresh/estimates", phase: "complete" },
          { id: "tool-2", kind: "tool", toolName: "bash", text: "Bash finished", detail: "Compare line-item totals", phase: "complete" },
        ], messages: [{ id: "u1", role: "user", content: "Compare the two estimates and make me a short decision table.", createdAt: now }, { id: "a1", role: "assistant", content: [
          "I compared the scope, allowances, and timelines. The biggest difference is cabinetry: one quote is fixed-price, while the other leaves it as an allowance.",
          "",
          "### Short decision table",
          "",
          "| Option | Best for | Main risk |",
          "| --- | --- | --- |",
          "| Fixed-price quote | Cost certainty | Less flexibility after signing |",
          "| Allowance quote | More finish choices | Final cost can move |",
          "",
          "> Clarify the cabinetry allowance in writing before choosing.",
          "",
          "- [x] Compare scope",
          "- [ ] Confirm cabinetry amount",
          "- [ ] Check the timeline against [weekend checklist.md](<weekend checklist.md>)",
          "",
          "```text",
          "Decision: wait for the cabinetry clarification, then choose the fixed-price quote if scope is equivalent.",
          "```",
        ].join("\n"), createdAt: now }] },
        { id: "fixture-chat-2", title: "Plan this weekend", createdAt: now, updatedAt: "2026-07-09T16:00:00.000Z", archivedAt: null, snoozedUntil, messages: [{ id: "u2", role: "user", content: "Turn my checklist into a realistic Saturday plan.", createdAt: now }] },
      ],
      [trip.id]: [{ id: "fixture-chat-3", title: "Build a relaxed itinerary", createdAt: now, updatedAt: now, archivedAt: "2026-07-11T12:00:00.000Z", snoozedUntil: null, messages: [{ id: "u3", role: "user", content: "Use the bookings and make a relaxed seven-day itinerary.", createdAt: now }] }],
    },
    checkpoints: {
      [home.id]: [{ checkpointId: "cp-home-1", createdAt: now, label: "Before reorganizing project notes", reason: "before_turn", fileCount: 5 }],
      [trip.id]: [{ checkpointId: "cp-trip-1", createdAt: now, label: "Before itinerary edits", reason: "before_turn", fileCount: 2 }],
    },
    surfaces: {
      [home.id]: [{
        id: "connected-inbox",
        title: "Connected inbox",
        description: "Connected work that needs attention in this Space.",
        icon: "mail",
        extensionPath: "C:\\Users\\you\\Documents\\Home projects\\.pi\\npm\\connected-inbox\\index.ts",
        manifestPath: "C:\\Users\\you\\Documents\\Home projects\\.pi\\npm\\connected-inbox\\surface.json",
        source: "This Space · local Pi package",
        scope: "project",
        origin: "top-level",
        enabled: true,
        loaded: true,
        status: "loaded",
        views: [{
          id: "inbox",
          title: "Inbox",
          description: "Messages and requests collected by the package.",
          blocks: [
            { type: "heading", text: "Connected inbox", level: 2 },
            { type: "metrics", items: [{ label: "Needs reply", value: "4", detail: "Two from today" }, { label: "Waiting", value: "7", detail: "Oldest is 3 days" }, { label: "Last sync", value: "9:42 AM", detail: "Connected package" }] },
            { type: "callout", tone: "warning", title: "Needs a reply", text: "Confirm whether the fixed-price quote includes cabinet hardware." },
            { type: "table", columns: ["From", "Subject", "State"], rows: [["Avery", "Launch window", "Reply"], ["Procurement", "Vendor quote", "Review"]] },
          ],
        }, {
          id: "follow-ups",
          title: "Follow-ups",
          description: "A compact connected-work queue.",
          blocks: [{ type: "list", items: [{ title: "Confirm launch window", detail: "Avery · today", badge: "Reply" }, { title: "Review vendor quote", detail: "Procurement · yesterday", badge: "Review" }] }],
        }],
      }],
      [trip.id]: [],
    },
    library: [{ name: "Templates", path: "Templates", kind: "folder", hasChildren: true, children: [{ name: "comparison-table.docx", path: "Templates/comparison-table.docx", kind: "file", sizeBytes: 18600, updatedAt: now }] }, { name: "packing-list.md", path: "packing-list.md", kind: "file", sizeBytes: 1240, updatedAt: now }],
  };
}

/** The preview's web address for share links. Not a real address. */
export const fixtureViewerOrigin = "https://pages-you.work-fold.com";
/** A sample link key for the preview; it opens nothing. */
export const fixtureShareLinkKey = "sampleKeyForThePreviewOnly0000000000000000";

/**
 * Sample shared pages for the preview (`?fixture=space`), one per page state
 * Settings → Shared pages shows — Live, Asleep, Resting, Not available, and
 * Stopped — with the default and raised budgets a person would see.
 */
export function buildFixturePublications(): SharedPageView[] {
  const mib = 1024 * 1024;
  return [
    {
      publicationId: "fixture-page-live", kind: "page", spaceId: "fixture-home", spaceName: "Home projects",
      relativePath: "weekend checklist.md", title: "weekend checklist", state: "active", live: true,
      serveRatePerMinute: 60, byteBudgetPerDay: 256 * mib, snapshotEnabled: true,
      createdAt: "2026-09-20T15:04:00.000Z", bridgeSlot: "confirmed",
      counters: { served: 42, servedBytes: 3_870_000, lastServedAt: "2026-09-24T08:12:00.000Z" },
      health: { state: "live", reason: "Your desktop is serving this page." },
      viewerPath: "/p/fixture-page-live",
    },
    {
      publicationId: "fixture-page-asleep", kind: "page", spaceId: "fixture-home", spaceName: "Home projects",
      relativePath: "Garden/planting-plan.pdf", title: "Planting plan", state: "active", live: false,
      serveRatePerMinute: 120, byteBudgetPerDay: 512 * mib, snapshotEnabled: false,
      createdAt: "2026-09-18T10:30:00.000Z", bridgeSlot: "pending",
      counters: { served: 7, servedBytes: 5_684_000, lastServedAt: "2026-09-22T19:45:00.000Z" },
      health: { state: "asleep", reason: "The relay has not confirmed this page yet." },
      viewerPath: "/p/fixture-page-asleep",
    },
    {
      publicationId: "fixture-page-resting", kind: "page", spaceId: "fixture-trip", spaceName: "Japan trip",
      relativePath: "itinerary.md", title: "Japan itinerary", state: "active", live: true,
      serveRatePerMinute: 30, byteBudgetPerDay: 64 * mib, snapshotEnabled: false,
      createdAt: "2026-09-12T07:00:00.000Z", bridgeSlot: "confirmed",
      counters: { served: 1_318, servedBytes: 67_108_864, lastServedAt: "2026-09-24T09:58:00.000Z" },
      lastProblem: { state: "resting", reason: "its daily byte budget at the relay is used up", at: "2026-09-24T09:58:30.000Z" },
      health: { state: "resting", reason: "This page's daily byte budget at the relay is used up." },
      viewerPath: "/p/fixture-page-resting",
    },
    {
      publicationId: "fixture-page-missing", kind: "page", spaceId: "fixture-trip", spaceName: "Japan trip",
      relativePath: "Bookings/hotel.pdf", title: "Hotel booking", state: "active", live: true,
      serveRatePerMinute: 60, byteBudgetPerDay: 256 * mib, snapshotEnabled: false,
      createdAt: "2026-09-10T12:00:00.000Z", bridgeSlot: "confirmed",
      lastProblem: { state: "not-available", reason: "The designated file does not exist as a regular file.", at: "2026-09-23T16:20:00.000Z" },
      health: { state: "not-available", reason: "The designated file does not exist as a regular file." },
      viewerPath: "/p/fixture-page-missing",
    },
    {
      publicationId: "fixture-page-stopped", kind: "page", spaceId: "fixture-home", spaceName: "Home projects",
      relativePath: "Kitchen refresh/ideas.md", title: "Kitchen ideas", state: "revoked", live: false,
      serveRatePerMinute: 60, byteBudgetPerDay: 256 * mib, snapshotEnabled: false,
      createdAt: "2026-09-02T09:00:00.000Z", bridgeSlot: "confirmed", bridgeCleanup: "pending",
      counters: { served: 12, servedBytes: 96_000, lastServedAt: "2026-09-21T11:03:00.000Z" },
      health: { state: "stopped", reason: "You stopped sharing this page. The relay is still removing it." },
      viewerPath: "/p/fixture-page-stopped",
    },
  ];
}
