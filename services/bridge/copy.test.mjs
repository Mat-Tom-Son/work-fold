import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The bridge deploys separately from the desktop release lanes, so nothing
// else keeps the remote client's copy aligned with the desktop vocabulary.
// These are static string pins over the shipped client source: the fold
// naming rows plus the copy rows that are load-bearing and must not drift.

async function clientSource(file) {
  return await readFile(new URL(`./public/${file}`, import.meta.url), "utf8");
}

test("remote client identifies the work-fold agent at its entry surfaces", async () => {
  const app = await clientSource("app.js");

  // Sign-in eyebrow.
  assert.match(app, /eyebrow: "work-fold agent",\s*\n\s*headline: `Welcome back/);

  // Address-unavailable eyebrow and supporting line.
  assert.match(app, /eyebrow: "work-fold agent",\s*\n\s*headline: "This address isn’t active\."/);
  assert.ok(app.includes('Check the address, or enable web access from the <span class="nobr">work-fold</span> desktop app.'));

  // The retired phrasings must not come back.
  assert.equal(app.includes('eyebrow: "Remote access"'), false);
  assert.equal(app.includes("Check the address or enable Remote access"), false);
  assert.equal(app.includes("Go remote when needed"), false);
});

test("remote client keeps the load-bearing copy exact", async () => {
  const app = await clientSource("app.js");

  // The work-fold agent stays the actor in the composer.
  assert.ok(app.includes('placeholder="Message work-fold agent"'));
  assert.ok(app.includes('prompt.placeholder = "Message work-fold agent"'));

  // Desktop-offline gate: it says the situation once, not four times.
  assert.ok(app.includes('eyebrow: "Desktop offline"'));
  assert.ok(app.includes('Open <span class="nobr">work-fold</span> to continue.'));
  assert.equal(app.includes("Nothing can be read or sent"), false);

  // Pairing keeps the explicit code-matching instruction. It
  // says pair/confirm, never approve (docs/receipts-not-gates.md writing rule).
  assert.ok(app.includes('eyebrow: "Confirm this browser once"'));
  assert.ok(app.includes('Match the code in <span class="nobr">work-fold</span>.'));
  assert.ok(app.includes("Confirm that the same six digits appear in the desktop prompt."));
  assert.ok(app.includes("<span>Waiting for your desktop…</span>"));

  // The screens name themselves: the door asks the question, and Needs you
  // and the folder view carries the selected folder title.
  assert.ok(app.includes('<h1 class="new-heading" tabindex="-1">What are we working on?</h1>'));
  assert.equal(app.includes('id="context-needs"'), false);
  assert.ok(app.includes('<h1 id="space-title" tabindex="-1">Folder</h1>'));

  // The retired shell's copy is gone, not hidden: the Home heading and its
  // address line, the recent-chat tail, the back affordance, the composer
  // keyboard note, the capture verb, and the asleep presence word.
  for (const retired of [
    "Your fold</h1>",
    "Recent chats",
    "All chats",
    "Back to chats",
    "Fold it in",
    "Desktop asleep",
    "for a new line",
  ]) assert.equal(app.includes(retired), false, `retired copy still present: ${retired}`);

  // Page title stays the product name.
  const page = await clientSource("index.html");
  assert.ok(page.includes("<title>work-fold</title>"));
});

test("remote questions live in their owning Chats", async () => {
  const app = await clientSource("app.js");

  // Needs you means questions (docs/receipts-not-gates.md, F24): no decision
  // cards, no approve/deny controls, and no decision operations anywhere in
  // the client — an older desktop that still emits other needs-you kinds gets
  // an inert row, never a control.
  for (const retired of [
    ">Approve</button>",
    ">Deny</button>",
    "decisions.list",
    "decisions.decide",
    "needs-you-card",
    "expiryPhrase",
    "Review decision",
    "Add a note",
    "pending-decision",
  ]) assert.equal(app.includes(retired), false, `retired decision copy still present: ${retired}`);
  assert.ok(app.includes('id="request-work"'));
  assert.ok(app.includes('class="chat-waiting">Needs your answer'));
  assert.equal(app.includes('data-nav-context="needs"'), false);

  // Person-facing copy never carries the retired gate vocabulary
  // (docs/receipts-not-gates.md acceptance). Protocol identifiers that survive
  // — approvalCertificate, approvalSignature, the "approved" grant status —
  // are matched exactly so a new person-facing "approve" cannot sneak back.
  const withoutComments = app.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /consecration/i);
  const speakable = withoutComments
    .replaceAll("approvalCertificate", "pairingRecord")
    .replaceAll("approvalSignature", "pairingSignature")
    .replaceAll("acceptApproval", "acceptPairing")
    .replaceAll('"approved"', '"paired"');
  assert.doesNotMatch(speakable, /\bstaged\b|\bapprov|\bpolicy\b|\bReviewed\b|\bUnrestricted\b/i);
});

test("the remote client does not fetch or acknowledge a hidden activity feed", async () => {
  const app = await clientSource("app.js");
  assert.doesNotMatch(app, /remote\("management\.glance(?:Seen)?"/);
  assert.doesNotMatch(app, /id="fold-home"|Since you last looked|Nothing needs you right now/);
});

test("remote client navigation keeps folders in a compact picker", async () => {
  const app = await clientSource("app.js");
  const styles = await clientSource("app.css");
  const dateGroups = await clientSource("date-groups.js");

  // Three screens, New chat as the door; the retired hashes land there too.
  assert.match(app, /const contextNames = \["new", "chat", "spaces"\];/);
  // The internal folder browser retains its route; `#files` still lands there.
  assert.match(app, /if \(raw === "files"\) return \{ context: "spaces"/);
  assert.match(app, /contextNames\.includes\(raw\) \? raw : "new"/);
  assert.match(app, /requested === "home" \|\| requested === "chats"\) return "new"/);
  assert.match(app, /id="context-new"[\s\S]*?id="context-chat"[\s\S]*?id="context-spaces"/);
  assert.match(app, /id="new-composer-slot"[\s\S]*?id="messages"[\s\S]*?id="chat-composer-slot"/);

  // The sidebar exists once in the DOM and is both the desktop column and the
  // phone drawer; its state is remembered, and the bottom tab bar is gone.
  assert.equal(app.match(/class="sidebar"/g).length, 1);
  assert.ok(app.includes('<aside id="drawer" class="sidebar" aria-label="Menu">'));
  assert.ok(app.includes('const sidebarStorageKey = "work-fold-remote-sidebar-v1"'));
  assert.match(styles, /\.app-shell\[data-sidebar="collapsed"\] \.sidebar \{[^}]*width: 60px/);
  assert.equal(app.includes("tab-bar"), false);
  assert.equal(styles.includes(".tab-bar"), false);

  // Expanded order: New chat, the grouped chat list, a Folders picker, and
  // Settings. Online presence stays out of the way; offline remains visible.
  assert.match(app, /id="new-chat"[\s\S]*?<ul id="chats"[\s\S]*?id="folder-picker-button"[\s\S]*?id="folder-picker"[\s\S]*?id="account-settings"[\s\S]*?id="desktop-presence"/);
  assert.ok(app.includes('import { groupConversationsByDate } from "./date-groups.js";'));
  assert.match(dateGroups, /"Today"[\s\S]*?"Yesterday"[\s\S]*?"Earlier this week"[\s\S]*?"Last week"[\s\S]*?"Older"/);
  assert.ok(app.includes("No chats yet"));
  assert.ok(app.includes("Older chats hidden"));

  // Collapsed, Chats is an icon that opens the list by expanding the sidebar.
  assert.match(app, /data-sidebar-expand="true" data-tip="Chats" aria-label="Chats"/);
  assert.match(app, /setSidebarState\("expanded"/);

  // Tooltips are the collapsed rail's labels only, and each one repeats the
  // button's accessible name rather than inventing a second word for it.
  assert.match(styles, /\.app-shell\[data-sidebar="collapsed"\] \.sidebar \[data-tip\]::after \{\s*\n\s*content: attr\(data-tip\)/);
  assert.match(styles, /@media \(min-width: 860px\) and \(hover: hover\)[\s\S]*?\[data-tip\]:hover::after/);
  assert.match(styles, /\[data-tip\]:focus-visible::after/);
  for (const name of ["New chat", "Chats", "Folders", "Settings"]) {
    assert.ok(app.includes(`data-tip="${name}" aria-label="${name}"`) || app.includes(`aria-label="${name}" data-tip="${name}"`),
      `tooltip and accessible name disagree for ${name}`);
  }
  // The CSS tooltip is the only tooltip: no native title doubles it up.
  assert.equal(app.includes('title="Settings"'), false);

  // The phone's top bar: ☰ and a drawer that
  // is a real dialog — focus trapped, Escape closing, body scroll locked.
  assert.match(app, /id="menu-button"[\s\S]*?aria-label="Menu"[\s\S]*?aria-controls="drawer"[\s\S]*?aria-expanded="false"/);
  assert.doesNotMatch(app, /data-nav-dot/);
  assert.match(app, /drawer\?\.setAttribute\("role", "dialog"\);\s*\n\s*drawer\?\.setAttribute\("aria-modal", "true"\);/);
  assert.match(app, /document\.body\.classList\.add\("drawer-locked"\)/);
  assert.match(app, /if \(event\.key === "Tab" && state\.drawerOpen\) return trapDrawerFocus\(event\)/);
  assert.match(app, /if \(state\.drawerOpen\) \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*closeDrawer\(\);/);
  assert.ok(app.includes('"Close menu"'));

  // The New chat screen sends the way Home did — always a new conversation —
  // and the send button says one thing.
  assert.match(app, /sentFromNewChat \|\| state\.startingNewChat \|\| !state\.selectedConversationId/);
  assert.match(app, /if \(sentFromNewChat\) showContext\("chat"\)/);
  assert.match(app, /state\.sending \? "Sending message" : unavailable \? "Desktop offline" : "Send message"/);

  assert.ok(app.includes('id="request-work"'));

  // Presence only appears for an offline desktop.
  assert.ok(app.includes('const label = online ? "" : "Desktop offline"'));
  assert.ok(app.includes("presence.hidden = online"));
  assert.ok(app.includes("toggleFolderPicker"));
  assert.ok(app.includes("closeFolderPicker"));
  assert.ok(app.includes("Folder ID: ${space.id}"));
  assert.match(styles, /\[data-tip\]\[aria-expanded="true"\]:hover::after \{ opacity: 0; \}/);
  // Component layout rules use display values, so their semantic hidden
  // states need explicit higher-specificity guards in both sidebar modes.
  assert.match(styles, /#desktop-presence\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.app-shell\[data-sidebar="collapsed"\] \.folder-picker\[hidden\] \{ display: none; \}/);
});
