import type { AgentExtensionSurface, AgentStatus, TreeEntry, WorkFolderCheckpoint, WorkFolderCustomizationMap, WorkFolderFixtureConversation, WorkFolderSummary } from "../types";
import { automationTriggerSummary, type FolderAutomationView } from "../../../src/shared/automation-presentation";
import { buildFixtureFileContents, buildFixtureRestorePoints, type FixtureRestorePoint } from "./work-folder-files";

export interface WorkFolderUiFixture {
  workFolders: WorkFolderSummary[];
  activeWorkFolderId: string;
  customizations: WorkFolderCustomizationMap;
  trees: Record<string, TreeEntry[]>;
  conversations: Record<string, WorkFolderFixtureConversation[]>;
  checkpoints: Record<string, WorkFolderCheckpoint[]>;
  /** Restore point pages and their Compare views, by restore point id. */
  restorePoints: Record<string, FixtureRestorePoint>;
  /** Text a file tab shows, by work-folder and path. */
  fileContents: Record<string, Record<string, string>>;
  surfaces: Record<string, AgentExtensionSurface[]>;
  agent: AgentStatus;
}

export function buildWorkFolderFixture(): WorkFolderUiFixture {
  const now = "2026-07-10T18:30:00.000Z";
  const snoozedUntil = new Date(Date.now() + 22 * 60 * 60 * 1_000).toISOString();
  // Chat times relative to now, so the Chats list shows a realistic history.
  const ago = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
  const pastChat = (id: string, title: string, hours: number, ask: string) => ({ id, title, createdAt: ago(hours), updatedAt: ago(hours), messages: [{ id: `${id}-u`, role: "user" as const, content: ask, createdAt: ago(hours) }] });
  const home: WorkFolderSummary = { id: "fixture-home", name: "Home projects", workFolderRoot: "/Users/you/Documents/Home projects", location: { kind: "local", storage: "linked" }, createdAt: now, updatedAt: now };
  const trip: WorkFolderSummary = { id: "fixture-trip", name: "Japan trip", workFolderRoot: "/Users/you/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/Japan trip", location: { kind: "local", storage: "linked", providerHint: "google-drive" }, createdAt: now, updatedAt: now };
  return {
    workFolders: [home, trip], activeWorkFolderId: home.id,
    customizations: {
      [home.id]: { color: "#0d74ce", color2: "#5c7c2e", iconName: "home", bannerName: "horizon" },
      [trip.id]: { color: "#6550b9", color2: "#c2298a", iconName: "airplane", bannerName: "aurora" },
    },
    agent: { ready: true, configured: true, provider: "openrouter", model: "anthropic/claude-sonnet-4", piVersion: "1.1.0", projectTrusted: true, error: null },
    trees: {
      [home.id]: [
        { name: "Kitchen refresh", path: "Kitchen refresh", kind: "folder", hasChildren: true, children: [{ name: "ideas.md", path: "Kitchen refresh/ideas.md", kind: "file", sizeBytes: 5240, updatedAt: now }, { name: "budget.xlsx", path: "Kitchen refresh/budget.xlsx", kind: "file", sizeBytes: 48200, updatedAt: now }] },
        { name: "Garden", path: "Garden", kind: "folder", hasChildren: true, children: [{ name: "ideas.md", path: "Garden/ideas.md", kind: "file", sizeBytes: 1180, updatedAt: now }, { name: "planting-plan.pdf", path: "Garden/planting-plan.pdf", kind: "file", sizeBytes: 812000, updatedAt: now }] },
        // A page folder (docs/pages.md); its page lives in fixtures/pages-fixture.ts.
        { name: "Garden Party RSVP", path: "Garden Party RSVP", kind: "folder", hasChildren: true, children: [{ name: "index.html", path: "Garden Party RSVP/index.html", kind: "file", sizeBytes: 2410, updatedAt: now }, { name: "page.json", path: "Garden Party RSVP/page.json", kind: "file", sizeBytes: 602, updatedAt: now }, { name: "notes.html", path: "Garden Party RSVP/notes.html", kind: "file", sizeBytes: 1800, updatedAt: now }] },
        { name: "weekend checklist.md", path: "weekend checklist.md", kind: "file", sizeBytes: 2120, updatedAt: now },
      ],
      [trip.id]: [{ name: "Bookings", path: "Bookings", kind: "folder", hasChildren: true, children: [{ name: "hotel.pdf", path: "Bookings/hotel.pdf", kind: "file", sizeBytes: 222000, updatedAt: now }] }, { name: "itinerary.md", path: "itinerary.md", kind: "file", sizeBytes: 8430, updatedAt: now }],
    },
    conversations: {
      [home.id]: [
        { id: "fixture-chat-1", title: "Compare contractor estimates", createdAt: ago(0.4), updatedAt: ago(0.4), runtimePreviews: [
          { id: "thinking-1", kind: "thinking", text: "I compared the scope and **checked the allowance assumptions before summarizing the tradeoffs.", phase: "complete", durationMs: 4_200 },
          { id: "tool-1", kind: "tool", toolName: "read", text: "Read finished", detail: "Kitchen refresh/ideas.md", phase: "complete" },
          { id: "thinking-2", kind: "thinking", text: "", phase: "complete", durationMs: 2_600 },
          { id: "tool-2", kind: "tool", toolName: "read", text: "Read finished", detail: "Kitchen refresh/budget.xlsx", phase: "complete" },
          { id: "tool-3", kind: "tool", toolName: "bash", text: "Bash finished", detail: "python3 -c \"import openpyxl; wb = openpyxl.load_workbook('Kitchen refresh/budget.xlsx'); print(sum(c.value or 0 for c in wb.active['C'][1:]))\"", phase: "complete" },
          { id: "tool-4", kind: "tool", toolName: "edit", text: "Edit finished", detail: "/Users/you/Documents/Home projects/Kitchen refresh/ideas.md", phase: "complete" },
          { id: "tool-5", kind: "tool", toolName: "write", text: "Write finished", detail: "weekend checklist.md", phase: "complete" },
          { id: "thinking-3", kind: "thinking", text: "The cabinetry line is the whole difference:\n\n```\nFixed-price quote ....... cabinetry included, no change orders unless the scope itself changes after signing\nAllowance quote ......... cabinetry allowance only, so the final cost moves with the finish choices\n```\n\nI’ll put that in a short table.", phase: "complete", durationMs: 3_900 },
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
        { id: "fixture-chat-2", title: "Plan this weekend", createdAt: now, updatedAt: "2026-07-09T16:00:00.000Z", archivedAt: null, snoozedUntil, messages: [
          { id: "u2", role: "user", content: "Turn my checklist into a realistic Saturday plan.", createdAt: now },
          { id: "c2", role: "system", kind: "context_compaction", content: "Conversation context compacted. Earlier messages were summarized to make room; your chat history is still available.", createdAt: now },
          { id: "a2", role: "assistant", content: "Saturday fits if the hardware store comes first and the garden waits until after lunch. I moved the contractor call to 4:00 so it lands after the measurements, and left Sunday afternoon open.", createdAt: now },
        ] },
        pastChat("fixture-chat-4", "Draft a reply to the contractor", 3, "Draft a short reply asking for the cabinetry allowance in writing."),
        pastChat("fixture-chat-5", "Find a dishwasher under $900", 26, "Find three quiet dishwashers under $900 that fit a 24-inch opening."),
        pastChat("fixture-chat-6", "Summarize the garden plan", 24 * 3, "Summarize planting-plan.pdf into a one-page checklist."),
        pastChat("fixture-chat-7", "Paint color shortlist", 24 * 9, "Pick three warm whites that work with sage cabinets."),
        pastChat("fixture-chat-8", "Insurance renewal questions", 24 * 36, "What should I ask before renewing the home insurance?"),
        pastChat("fixture-chat-9", "Organize receipts by month", 24 * 95, "Sort the receipts folder into one folder per month."),
      ],
      [trip.id]: [
        pastChat("fixture-chat-trip-1", "Compare JR Pass options", 30, "Is a 7-day JR Pass worth it for this itinerary?"),
        pastChat("fixture-chat-trip-2", "Restaurant list for Kyoto", 24 * 12, "Make a short list of quiet dinner spots near the ryokan."),
        { id: "fixture-chat-3", title: "Build a relaxed itinerary", createdAt: now, updatedAt: now, archivedAt: "2026-07-11T12:00:00.000Z", snoozedUntil: null, messages: [{ id: "u3", role: "user", content: "Use the bookings and make a relaxed seven-day itinerary.", createdAt: now }] },
      ],
    },
    restorePoints: buildFixtureRestorePoints(now, new Date().toISOString()),
    fileContents: buildFixtureFileContents(home.id, trip.id),
    checkpoints: {
      [home.id]: [{ checkpointId: "cp-home-1", createdAt: now, label: "Before reorganizing project notes", reason: "before_turn", fileCount: 5 }],
      [trip.id]: [{ checkpointId: "cp-trip-1", createdAt: now, label: "Before itinerary edits", reason: "before_turn", fileCount: 2 }],
    },
    surfaces: {
      [home.id]: [{
        id: "connected-inbox",
        title: "Connected inbox",
        description: "Connected work that needs attention in this work-folder.",
        icon: "mail",
        extensionPath: "/Users/you/Documents/Home projects/.pi/npm/connected-inbox/index.ts",
        manifestPath: "/Users/you/Documents/Home projects/.pi/npm/connected-inbox/surface.json",
        source: "This work-folder · local Pi package",
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
  };
}

/**
 * Sample automations for the preview's work-folder-owned Automations tab, keyed
 * by work-folder. One automation touches both work-folders — it watches Home projects and
 * copies to Japan trip — so each work-folder shows its own side of it; the other
 * starts a Chat in Home projects every 30 minutes and is off.
 */
export function buildFixtureFolderAutomations(): Record<string, FolderAutomationView[]> {
  const kitchenToTrip = {
    automationId: "fixture-kitchen-to-trip",
    title: "Send kitchen ideas to the trip folder",
    state: "on" as const,
    triggerSummary: automationTriggerSummary({
      kind: "files-changed",
      workFolderId: "fixture-home",
      watch: { kind: "tree", path: "Kitchen refresh", recursive: true, extensions: [".md"] },
      debounceSeconds: 10,
      cooldownMinutes: 30,
    }),
    nextRunAt: null,
    lastRun: { at: "2026-11-03T17:45:00.000Z", outcome: "succeeded" as const },
  };
  return {
    "fixture-home": [
      { ...kitchenToTrip, roles: ["watches", "copies-from"] },
      {
        automationId: "fixture-budget-check-in",
        title: "Budget check-in",
        state: "off",
        triggerSummary: automationTriggerSummary({ kind: "interval", intervalMinutes: 30 }),
        nextRunAt: null,
        lastRun: null,
        roles: ["chats-here"],
      },
    ],
    "fixture-trip": [{ ...kitchenToTrip, roles: ["copies-to"] }],
  };
}
