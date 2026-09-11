// Canned local state for ?fixture=new|chat|needs|spaces QA previews (the
// pattern set by the desktop renderer's ?fixture=space). Fixture mode is
// client-side only and inert against the real API: app.js refuses to attach
// auth, open the event stream, or call fetch while a fixture is showing, so
// nothing in this file can touch or confuse real state. Keep it small: just
// enough recorded-state shapes to render every screen.

const minutes = (count) => new Date(Date.now() - count * 60_000).toISOString();
// Calendar days, so the sidebar's Today / Yesterday / Earlier groups are the
// same in a screenshot taken at any hour.
const daysAgo = (count) => {
  const date = new Date();
  date.setDate(date.getDate() - count);
  date.setHours(9, 40, 0, 0);
  return date.toISOString();
};

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
    { id: "chat-3", title: "Grant application draft", updatedAt: daysAgo(1), state: "idle" },
    { id: "chat-4", title: "Reading list", updatedAt: daysAgo(4), state: "idle" },
  ];
  const glance = {
    cursor: `${minutes(4)}/change-1`,
    seen: { [`remote:${grantId}`]: `${minutes(90)}/change-4` },
    running: [
      { id: "run-1", spaceName: "Launch plan", headline: "Assistant turn running" },
      { id: "run-2", spaceName: "Field notes", headline: "Check run in progress" },
    ],
    needsYou: [
      {
        kind: "chat-question",
        spaceName: "Field notes",
        headline: "Keep the older duplicates or archive them?",
        ref: { conversationId: "chat-2" },
      },
    ],
    changes: [
      { id: "change-1", at: minutes(4), spaceName: "Launch plan", headline: "Checkpoint saved before edits" },
      { id: "change-2", at: minutes(26), headline: "Chat renamed to Grant application draft" },
      { id: "change-3", at: minutes(70), spaceName: "Field notes", headline: "Turn finished" },
      { id: "change-4", at: minutes(95), headline: "Denied: install weather-widget 0.2.1" },
      { id: "change-5", at: minutes(60 * 9), spaceName: "Old scans", headline: "Check run settled: needs attention" },
    ],
    checks: [
      { spaceName: "Old scans", state: "needs-attention", needsAttention: 2 },
      { spaceName: "Launch plan", state: "current-clear" },
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
        { spaceName: "Launch plan", state: "running" },
        { spaceId: "space-2", spaceName: "Field notes", state: "succeeded", files: ["delivery-plan.md"] },
      ],
      dispositions: [{ attachment: { name: "q3-numbers.csv" }, status: "library" }],
      actions: [
        { command: "files.add", spaceId: "space-1", spaceName: "Launch plan", copied: ["reports/q3-summary.md"] },
        { command: "apps.grant", spaceId: "space-1", spaceName: "Launch plan" },
        { command: "apps.install-preview", apps: [{ spaceId: "space-1", appId: "quote-board", featureInstallationId: "fixture-quote-board",
          digest: "b".repeat(64), title: "Quote board", version: "0.9.0" }] },
      ],
    },
  };
  return {
    context: name,
    state: {
      context: { slug: "casey", addressAvailable: true, authenticated: true },
      session: { paired: true, desktopOnline: true, slug: "casey", grant: { id: grantId } },
      identity: { grantId },
      spaces: [
        { id: "space-1", name: "Launch plan" },
        { id: "space-2", name: "Field notes" },
      ],
      explorerSpaceId: "space-1",
      spaceApps: new Map([["space-1", [{ spaceId: "space-1", appId: "quote-board", featureInstallationId: "fixture-quote-board", digest: "a".repeat(64), authorityDigest: "fixture", title: "Quote board", version: "1.0.0", preview: false, webView: true, actions: true }]]]),
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
      liveAssistantText: "I’m reconciling the two missing purchase orders now and checking the draft’s sentence case.",
      liveAssistantTextTruncated: false,
      glance,
    },
  };
}

/** Inert UI-only action fixture. No desktop request or worker is involved. */
export function createFixtureAppActions() {
  const records = new Map(); let runs = 0;
  return async (app, operation, input) => {
    if (app.featureInstallationId !== "fixture-quote-board") throw new Error("Unknown fixture app.");
    if (operation === "list") return { actions: [...records.values()].map(({ reviewDigest, inputJson, result, ...record }) => record) };
    const requestId = operation === "request" ? input.request.requestId : input.requestId;
    let record = records.get(requestId);
    if (operation === "request" && !record) {
      record = { id: crypto.randomUUID(), requestId, title: "Save quote", action: "save-quote", status: "pending",
        inputJson: JSON.stringify(input.request.input), reviewDigest: `fixture-review:${requestId}` };
      records.set(requestId, record);
    }
    if (!record) throw new Error("Unknown fixture request.");
    if (operation === "review") return { review: structuredClone(record) };
    if (operation === "approve") {
      if (input.reviewDigest !== record.reviewDigest) throw new Error("Review changed.");
      if (record.status === "pending") { record.status = "succeeded"; record.result = { saved: true, supplier: "North", runs: ++runs }; }
    } else if (operation === "cancel" && record.status === "pending") record.status = "cancelled";
    const { inputJson, reviewDigest, ...action } = record;
    return { action: structuredClone(action) };
  };
}

export const fixtureAppEntry = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;padding:20px;color:#20304a;background:#fff}button{font:inherit;padding:8px 14px;margin:0 6px 6px 0}p{line-height:1.5}</style></head>
<body><h1>Quote board</h1><p>Compare the saved purchasing quote.</p><button id="read">Read quote</button><button id="save">Save quote</button><button id="status">Check request</button><p id="result" role="status"></p>
<script>
let request;
document.getElementById("read").onclick=async()=>{const quote=await workFoldViewerApp.data.get("quotes:north");document.getElementById("result").textContent=quote.supplier+": $"+quote.unitPrice+" per unit, "+quote.days+" days"};
document.getElementById("save").onclick=async()=>{request??=workFoldBrowserApp.actions.createRequest("save-quote",{supplier:"North",unitPrice:42,quantity:10});const action=await workFoldBrowserApp.actions.request(request);document.getElementById("result").textContent=action.status==="pending"?"Waiting for you":action.status};
document.getElementById("status").onclick=async()=>{const action=request?await workFoldBrowserApp.actions.get(request.requestId):(await workFoldBrowserApp.actions.list())[0];document.getElementById("result").textContent=action?JSON.stringify(action):"No request yet"};
</script></body></html>`;
