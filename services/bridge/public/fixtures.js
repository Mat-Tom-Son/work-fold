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
  // The app result's revision differs from the installed fixture app, so
  // opening it shows "Updated since this task".
  fixtureThreads.get("chat-2").summary.latestRequest = { phase: "succeeded",
    actions: [{ command: "files.add", workFolderId: "work-folder-1", workFolderName: "Launch plan", copied: ["reports/q3-summary.md"] },
      { command: "apps.install-preview", workFolderId: "work-folder-1", workFolderName: "Launch plan", apps: [{ workFolderId: "work-folder-1",
        workFolderName: "Launch plan", appId: "quote-board", featureInstallationId: "fixture-quote-board", digest: "b".repeat(64), title: "Quote board", version: "1.0.0" }] }] };
  if (running) {
    const report = fixtureThreads.get("chat-2");
    Object.assign(report, {
      messages: report.messages.slice(0, 1),
      summary: { state: "running", latestRequest: { phase: "working", canStop: true, taskId: "task-2",
        actions: [{ command: "files.add", workFolderId: "work-folder-1", workFolderName: "Launch plan", copied: ["reports/q3-summary.md"] }] } },
      activeTasks: new Map([["chat-2", { taskId: "task-2", conversationId: "chat-2", phase: "working" }]]),
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
      workFolderApps: new Map([["work-folder-2", []], ["work-folder-1", [{ workFolderId: "work-folder-1", appId: "quote-board", featureInstallationId: "fixture-quote-board", digest: "a".repeat(64), authorityDigest: "fixture", title: "Quote board", version: "1.0.0", preview: false, webView: true, actions: true }]]]),
      conversations,
      conversationsLoaded: true,
      // Current desktops take a message into running work.
      steerAvailable: true,
      selectedConversationId,
      fixtureThreads,
      ...structuredClone(fixtureThreads.get(selectedConversationId)),
      transcriptConversationId: selectedConversationId,
      transcriptTruncated: false,
    },
  };
}

/**
 * Canned online pages for the Published view (?fixture=chat&published=1, or
 * published=page for the first page's entries). Unpublish changes only this
 * in-memory copy; Export refuses, since a preview never downloads anything.
 */
export function buildPublishedFixture() {
  const garden = "pg_gardenpartyrsvpabcdefghijk";
  const club = "pg_bookclubsignupabcdefghijkl";
  const poll = "pg_bakesalepollabcdefghijklmn";
  const rsvp = (index, name, email, guests, bringing, minutesAgo) => ({
    id: `rsvp-${index}`, visitor: `v_${String(index).repeat(32).slice(0, 32)}`, createdAt: minutes(minutesAgo), updatedAt: minutes(minutesAgo),
    deletedAt: null, name, email, guests, bringing,
  });
  const rsvpColumns = [
    { name: "name", type: "text", retired: false, required: true },
    { name: "email", type: "email", retired: false, required: true, unique: true },
    { name: "guests", type: "number", retired: false, min: 0, max: 10 },
    { name: "bringing", type: "choice", retired: false, options: ["Salad", "Dessert", "Drinks"] },
  ];
  const rsvps = [
    rsvp(1, "Priya Natarajan", "priya@example.com", 2, "Dessert", 3 * 24 * 60),
    rsvp(2, "Tom Becker", "tom@example.com", 0, "Drinks", 26 * 60),
    rsvp(3, "Ana Lima", "ana@example.com", 3, "Salad", 95),
    rsvp(4, "Jordan Ellis", "jordan@example.com", 1, null, 12),
  ];
  const votes = [
    { id: "vote-1", visitor: "v_1", createdAt: daysAgo(9), updatedAt: daysAgo(9), deletedAt: null, choice: "Lemon bars", comment: "" },
    { id: "vote-2", visitor: "v_2", createdAt: daysAgo(8), updatedAt: daysAgo(8), deletedAt: null, choice: "Brownies", comment: "Happy to bake two trays." },
    { id: "vote-3", visitor: "v_3", createdAt: daysAgo(8), updatedAt: daysAgo(8), deletedAt: null, choice: "Lemon bars", comment: "" },
  ];
  const view = (table, columns, rows, limit) => ({ table, retired: false, limit, deleted: false, columns, rows, total: rows.length, lastSeen: null });
  const summary = (name, live, limit) => ({ name, retired: false, limit, live, deleted: 0, newCount: 0, lastSeen: null });
  return {
    pagesOrigin: "https://pages.work-fold.com",
    pages: [
      { pageId: garden, title: "Garden Party RSVP", status: "online", revision: 3, publishedAt: daysAgo(4), updatedAt: daysAgo(1), dataRevision: 9, entries: rsvps.length },
      { pageId: club, title: "Book club sign-up", status: "online", revision: 1, publishedAt: daysAgo(2), updatedAt: daysAgo(2), dataRevision: 0, entries: 0 },
      { pageId: poll, title: "Bake sale poll", status: "unpublished", revision: 2, publishedAt: daysAgo(12), updatedAt: daysAgo(6), dataRevision: 3, entries: votes.length },
    ],
    data: {
      [garden]: { tables: [summary("rsvps", rsvps.length, 50)], views: { rsvps: view("rsvps", rsvpColumns, rsvps, 50) } },
      [club]: {
        tables: [summary("signups", 0, 12)],
        views: { signups: view("signups", [{ name: "name", type: "text", retired: false }, { name: "email", type: "email", retired: false }], [], 12) },
      },
      [poll]: {
        tables: [summary("votes", votes.length, 10_000)],
        views: { votes: view("votes", [{ name: "choice", type: "choice", retired: false }, { name: "comment", type: "long-text", retired: false }], votes, 10_000) },
      },
    },
  };
}

/** The Published view's client over the canned pages; nothing leaves the page. */
export function createFixturePublishedClient() {
  const fixture = buildPublishedFixture();
  const page = (pageId) => {
    const found = fixture.pages.find((item) => item.pageId === pageId);
    if (!found) throw new Error("That page isn't published.");
    return found;
  };
  return {
    list: async () => ({ pages: structuredClone(fixture.pages), pagesOrigin: fixture.pagesOrigin }),
    tables: async (pageId) => ({ tables: structuredClone(fixture.data[page(pageId).pageId].tables) }),
    table: async (pageId, table) => structuredClone(fixture.data[page(pageId).pageId].views[table]),
    exportTable: async () => { throw new Error("Fixture preview is inert; nothing is downloaded."); },
    unpublish: async (pageId) => {
      const found = page(pageId);
      found.status = "unpublished";
      found.updatedAt = new Date().toISOString();
      return { page: structuredClone(found) };
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
