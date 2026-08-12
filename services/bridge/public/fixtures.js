// Canned local state for ?fixture=home|chat|files QA previews (the pattern
// set by the desktop renderer's ?fixture=space). Fixture mode is client-side
// only and inert against the real API: app.js refuses to attach auth, open
// the event stream, or call fetch while a fixture is showing, so nothing in
// this file can touch or confuse real state. Keep it small: just enough
// recorded-state shapes to render every screen.

const minutes = (count) => new Date(Date.now() - count * 60_000).toISOString();

export function buildFixture(name) {
  const grantId = "fixture-grant";
  const messages = [
    {
      id: "message-1",
      role: "user",
      content: "Pull the numbers together for the quarterly report and flag anything that looks off.",
      attachments: [{ kind: "file", name: "q3-numbers.csv" }],
    },
    {
      id: "message-2",
      role: "assistant",
      content: "Looked through **q3-numbers.csv** and started a summary:\n\n- Revenue is up 12% quarter over quarter\n- Two invoices are missing purchase orders\n- `travel` is coded inconsistently across months\n\nI put a draft in `reports/q3-summary.md`. Want me to reconcile the invoice gaps next?",
    },
    {
      id: "message-3",
      role: "user",
      source: "remote_web",
      content: "Yes — reconcile them, and keep the draft in sentence case.",
    },
  ];
  const conversations = [
    { id: "chat-1", title: "Quarterly report", updatedAt: minutes(2), state: "running" },
    { id: "chat-2", title: "Field notes cleanup", updatedAt: minutes(140), state: "idle" },
    { id: "chat-3", title: "Grant application draft", updatedAt: minutes(60 * 26), state: "idle" },
    { id: "chat-4", title: "Reading list", updatedAt: minutes(60 * 50), state: "idle" },
  ];
  const decisions = [
    {
      id: "card-1",
      category: "widen-power",
      categoryLine: "Grants a standing power",
      title: "Let Clipper reach api.example.com",
      facts: [
        { label: "App", value: "Clipper" },
        { label: "Destination", value: "api.example.com" },
      ],
      provenance: { stagedVia: "management-conversation", stagedAt: minutes(18) },
      expiresAt: minutes(-60 * 23),
    },
    {
      id: "card-2",
      category: "destroy",
      categoryLine: "Deletes something for good",
      title: "Delete the folder for Old scans",
      facts: [
        { label: "Space", value: "Old scans" },
        { label: "Folder", value: "~/Documents/old-scans" },
      ],
      provenance: { stagedVia: "act-lane", stagedAt: minutes(35) },
      expiresAt: minutes(-60 * 22),
      priorDenialAt: minutes(60 * 30),
      secondConfirmation: true,
    },
    {
      id: "card-3",
      category: "make-runnable",
      categoryLine: "Installs code that can run as you — Personal scope",
      title: "Install summarize-notes 1.4.0",
      facts: [
        { label: "Package", value: "summarize-notes 1.4.0" },
        { label: "Source", value: "registry.example.com" },
      ],
      provenance: { stagedVia: "management-conversation", stagedAt: minutes(9) },
      expiresAt: minutes(-60 * 23.5),
      desktopOnly: true,
    },
  ];
  const glance = {
    cursor: `${minutes(4)}/change-1`,
    seen: { [`remote:${grantId}`]: `${minutes(90)}/change-4` },
    running: [
      { id: "run-1", spaceName: "Quarterly report", headline: "Assistant turn running" },
      { id: "run-2", spaceName: "Field notes", headline: "Check run in progress" },
    ],
    needsYou: [
      { kind: "chat-question", spaceName: "Field notes", headline: "Keep the older duplicates or archive them?" },
    ],
    changes: [
      { id: "change-1", at: minutes(4), spaceName: "Quarterly report", headline: "Checkpoint saved before edits" },
      { id: "change-2", at: minutes(26), headline: "Chat renamed to Grant application draft" },
      { id: "change-3", at: minutes(70), spaceName: "Field notes", headline: "Turn finished" },
      { id: "change-4", at: minutes(95), headline: "Denied: install weather-widget 0.2.1" },
      { id: "change-5", at: minutes(60 * 9), spaceName: "Old scans", headline: "Check run settled: needs attention" },
    ],
    checks: [
      { spaceName: "Old scans", state: "needs-attention", needsAttention: 2 },
      { spaceName: "Quarterly report", state: "current-clear" },
    ],
    truncated: { changes: true },
    unavailable: [],
  };
  const summary = {
    state: "running",
    latestRequest: {
      phase: "working",
      canStop: true,
      taskId: "task-1",
      startedAt: minutes(2),
      children: [
        { spaceName: "Quarterly report", state: "running" },
        { spaceName: "Field notes", state: "succeeded" },
      ],
      dispositions: [{ attachment: { name: "q3-numbers.csv" }, status: "library" }],
    },
  };
  return {
    context: name,
    state: {
      context: { slug: "casey", addressAvailable: true, authenticated: true },
      session: { paired: true, desktopOnline: true, slug: "casey", grant: { id: grantId } },
      identity: { grantId },
      spaces: [
        { id: "space-1", name: "Quarterly report" },
        { id: "space-2", name: "Field notes" },
      ],
      explorerSpaceId: "space-1",
      trees: new Map([
        ["space-1:", [
          { kind: "folder", name: "reports", path: "reports" },
          { kind: "file", name: "q3-numbers.csv", path: "q3-numbers.csv", sizeBytes: 48_213 },
          { kind: "file", name: "notes.md", path: "notes.md", sizeBytes: 2_140 },
        ]],
        ["space-1:reports", [
          { kind: "file", name: "q3-summary.md", path: "reports/q3-summary.md", sizeBytes: 9_812 },
        ]],
      ]),
      treeStatus: new Map([
        ["space-1:", "loaded"],
        ["space-1:reports", "loaded"],
      ]),
      treeTruncated: new Map(),
      expanded: new Set(["space-1:reports"]),
      conversations,
      selectedConversationId: "chat-1",
      messages,
      transcriptConversationId: "chat-1",
      transcriptTruncated: false,
      summary,
      activeTasks: new Map([["chat-1", { taskId: "task-1", conversationId: "chat-1" }]]),
      decisions,
      glance,
    },
  };
}
