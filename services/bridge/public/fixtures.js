// Canned local state for ?fixture=new|chat|needs QA previews (the
// pattern set by the desktop renderer's folder view). Fixture mode is
// client-side only and inert against the real API: app.js refuses to attach
// auth, open the event stream, or call fetch while a fixture is showing, so
// nothing in this file can touch or confuse real state. Keep it small: just
// enough recorded-state shapes to render every screen.

const minutes = (count) => new Date(Date.now() - count * 60_000).toISOString();
// Keep the saved-chat order stable in a screenshot taken at any hour.
const daysAgo = (count) => {
  const date = new Date();
  date.setDate(date.getDate() - count);
  date.setHours(9, 40, 0, 0);
  return date.toISOString();
};

export function buildFixture(name, { running = false } = {}) {
  const grantId = "fixture-grant";
  const conversations = [
    { id: "chat-1", title: "A weekend in Montréal", updatedAt: minutes(2), state: "idle" },
    { id: "chat-2", title: "Quarterly report", updatedAt: minutes(140), state: running ? "running" : "idle" },
    { id: "chat-3", title: "Website copy", updatedAt: daysAgo(1), state: "idle" },
    { id: "chat-4", title: "Reading notes", updatedAt: daysAgo(4), state: "idle" },
  ];
  const transcript = (id, entries) => entries.map(([role, content, attachments], index) => ({
    id: `${id}-message-${index + 1}`, role, content, ...(attachments ? { attachments } : {}),
  }));
  const idle = (messages) => ({ messages, summary: { state: "idle", capabilities: { delete: true } }, work: null,
    activeTasks: new Map(), liveAssistantText: "", liveAssistantTextTruncated: false, liveActivity: "" });
  const fixtureThreads = new Map([
    ["chat-1", idle(transcript("trip", [
      ["user", "Help me plan a relaxed weekend in Montréal. We arrive Friday afternoon and head home Sunday."],
      ["assistant", "I’d leave room to wander and give each day just one main plan.\n\n**Friday** — Settle in, take a walk through Old Montréal, and have dinner nearby.\n\n**Saturday** — Start with a slow breakfast, spend the afternoon around Mile End, and leave the evening open.\n\n**Sunday** — Coffee, a walk in Mount Royal Park, then head home.\n\nWhere are you staying? I can shape the route around your neighborhood."],
      ["user", "Near the Plateau. We’d rather walk than drive."],
      ["assistant", "Then I’d make the Plateau your base and keep Saturday entirely on foot. Put Old Montréal on Friday and Mount Royal on Sunday. That gives you three different parts of the city without spending the weekend in transit."],
    ]))],
    ["chat-2", idle(transcript("report", [
      ["user", "Summarize the quarter and flag anything I should check before sharing the report.", [{ kind: "file", name: "q3-numbers.csv" }]],
      ["assistant", "Revenue is up **12%** over last quarter. Two invoices need purchase-order references, and travel expenses use different category names across the months.\n\nI saved the summary in `reports/q3-summary.md`, with those three items called out for review."],
    ]))],
    ["chat-3", idle(transcript("copy", [
      ["user", "Make this website introduction sound less corporate: ‘We deliver innovative solutions that empower organizations to unlock their potential.’"],
      ["assistant", "Try something more direct:\n\n> We help small teams turn good ideas into useful products.\n\nIt says who you work with and what you help them do. If you tell me what you actually make, I can make the line more specific."],
      ["user", "We design websites for independent shops."],
      ["assistant", "> Thoughtful websites for independent shops.\n\nFor a supporting sentence: ‘We design clear, welcoming sites that make it easy for people to find you and buy from you.’"],
    ]))],
    ["chat-4", idle(transcript("reading", [
      ["user", "Give me a simple way to keep notes from the books I’m reading. Nothing elaborate."],
      ["assistant", "One file per book, with three headings:\n\n### Ideas to keep\nA few sentences in your own words.\n\n### Passages to return to\nThe quote and its page number.\n\n### What this changes\nOne thing you might think about or do differently.\n\nAdd to it as you read. You don’t need to fill every section."],
    ]))],
  ]);
  fixtureThreads.get("chat-2").summary.latestRequest = { phase: "succeeded",
    actions: [{ command: "files.add", spaceId: "space-1", spaceName: "Launch plan", copied: ["reports/q3-summary.md"] }] };
  if (running) {
    const report = fixtureThreads.get("chat-2");
    Object.assign(report, {
      messages: report.messages.slice(0, 1),
      summary: { state: "running", latestRequest: { phase: "working", canStop: true, taskId: "task-2",
        actions: [{ command: "files.add", spaceId: "space-1", spaceName: "Launch plan", copied: ["reports/q3-summary.md"] }] } },
      activeTasks: new Map([["chat-2", { taskId: "task-2", conversationId: "chat-2" }]]),
      liveAssistantText: "I’m checking the invoice references and putting the summary together.",
    });
  }
  const selectedConversationId = running ? "chat-2" : "chat-1";
  return {
    context: name,
    state: {
      context: { slug: "casey", addressAvailable: true, authenticated: true },
      session: { paired: true, desktopOnline: true, slug: "casey", grant: { id: grantId } },
      identity: { grantId },
      spaceApps: new Map([["space-2", []], ["space-1", [{ spaceId: "space-1", appId: "quote-board", featureInstallationId: "fixture-quote-board", digest: "a".repeat(64), authorityDigest: "fixture", title: "Quote board", version: "1.0.0", preview: false, webView: true, actions: true }]]]),
      conversations,
      conversationsLoaded: true,
      sharedPagesAvailable: true,
      fixtureSharedPages: [
        { publicationId: "fixture-quarterly", title: "Quarterly overview", kind: "page", health: { state: "live" } },
        { publicationId: "fixture-trip", title: "Montréal weekend", kind: "page", health: { state: "live" } },
        { publicationId: "fixture-reading", title: "Reading notes", kind: "page", health: { state: "live" } },
      ],
      selectedConversationId,
      fixtureThreads,
      ...structuredClone(fixtureThreads.get(selectedConversationId)),
      transcriptConversationId: selectedConversationId,
      transcriptTruncated: false,
    },
  };
}

/** Inert UI-only action fixture. No desktop request or worker is involved. A request runs as soon as it is accepted. */
export function createFixtureAppActions() {
  const records = new Map(); let runs = 0;
  return async (app, operation, input) => {
    if (app.featureInstallationId !== "fixture-quote-board") throw new Error("Unknown fixture app.");
    if (operation === "list") return { actions: [...records.values()].map(({ result, ...record }) => record) };
    const requestId = operation === "request" ? input.request.requestId : input.requestId;
    let record = records.get(requestId);
    if (operation === "request" && !record) {
      const at = new Date().toISOString();
      record = { id: crypto.randomUUID(), requestId, title: "Save quote", action: "save-quote", status: "running", createdAt: at, updatedAt: at, startedAt: at };
      records.set(requestId, record);
      setTimeout(() => { if (record.status === "running") { record.status = "succeeded"; record.result = { saved: true, supplier: "North", runs: ++runs }; } }, 800);
    }
    if (!record) throw new Error("Unknown fixture request.");
    if (operation === "cancel" && record.status === "running") record.status = "cancelled";
    return { action: structuredClone(record) };
  };
}

export const fixtureAppEntry = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;padding:20px;color:#20304a;background:#fff}button{font:inherit;padding:8px 14px;margin:0 6px 6px 0}p{line-height:1.5}</style></head>
<body><h1>Quote board</h1><p>Compare the saved purchasing quote.</p><button id="read">Read quote</button><button id="save">Save quote</button><button id="status">Check request</button><p id="result" role="status"></p>
<script>
let request;
document.getElementById("read").onclick=async()=>{const quote=await workFoldViewerApp.data.get("quotes:north");document.getElementById("result").textContent=quote.supplier+": $"+quote.unitPrice+" per unit, "+quote.days+" days"};
document.getElementById("save").onclick=async()=>{request??=workFoldBrowserApp.actions.createRequest("save-quote",{supplier:"North",unitPrice:42,quantity:10});const action=await workFoldBrowserApp.actions.request(request);document.getElementById("result").textContent=action.status};
document.getElementById("status").onclick=async()=>{const action=request?await workFoldBrowserApp.actions.get(request.requestId):(await workFoldBrowserApp.actions.list())[0];document.getElementById("result").textContent=action?JSON.stringify(action):"No request yet"};
</script></body></html>`;
