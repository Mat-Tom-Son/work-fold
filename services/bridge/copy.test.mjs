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

test("remote client uses the fold vocabulary for its entry surfaces", async () => {
  const app = await clientSource("app.js");

  // Sign-in eyebrow.
  assert.match(app, /eyebrow: "Your fold",\s*\n\s*headline: `Welcome back/);

  // Address-unavailable eyebrow and supporting line.
  assert.match(app, /eyebrow: "Your fold",\s*\n\s*headline: "This address isn’t active\."/);
  assert.ok(app.includes('Check the address, or enable web access from the <span class="nobr">work-fold</span> desktop app.'));

  // The retired phrasings must not come back.
  assert.equal(app.includes('eyebrow: "Remote access"'), false);
  assert.equal(app.includes("Check the address or enable Remote access"), false);
  assert.equal(app.includes("Go remote when needed"), false);
});

test("remote client keeps the load-bearing copy exact", async () => {
  const app = await clientSource("app.js");

  // work-fold stays the actor in the composer.
  assert.ok(app.includes('placeholder="Message work-fold"'));
  assert.ok(app.includes('prompt.placeholder = "Message work-fold"'));

  // Desktop-offline gate: it says the situation once, not four times.
  assert.ok(app.includes('eyebrow: "Desktop offline"'));
  assert.ok(app.includes('Open <span class="nobr">work-fold</span> to continue.'));
  assert.ok(app.includes("The desktop app holds your conversation and pairs new browsers."));
  assert.equal(app.includes("Nothing can be read or sent"), false);

  // Pairing copy: one instruction, and the one-time nature said once. It
  // says pair/confirm, never approve (docs/receipts-not-gates.md writing rule).
  assert.ok(app.includes('eyebrow: "Confirm this browser once"'));
  assert.ok(app.includes('Match the code in <span class="nobr">work-fold</span>.'));
  assert.ok(app.includes("Confirm that the same six digits appear in the desktop prompt."));
  assert.ok(app.includes("Once paired, this browser stays signed in until you remove it."));
  assert.ok(app.includes("<span>Waiting for your desktop…</span>"));

  // The screens name themselves: the door asks the question, and Needs you
  // and Spaces carry their own titles.
  assert.ok(app.includes('<h1 class="new-heading" tabindex="-1">What are we working on?</h1>'));
  assert.ok(app.includes('<h1 id="needs-title" class="context-title" tabindex="-1">Needs you</h1>'));
  assert.ok(app.includes('<h1 class="context-title" tabindex="-1">Spaces</h1>'));

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

test("the remote Needs you screen renders questions only", async () => {
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
  assert.ok(app.includes("Nothing needs you right now."));
  assert.ok(app.includes("${renderFromChats()}${renderGlance()}"));
  assert.match(app, /const questions = state\.glance\?\.needsYou \?\? \[\]/);
  assert.match(app, /const count = \(state\.glance\?\.needsYou \?\? \[\]\)\.length/);

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

test("remote glance renders the digest sections with quiet-not-hidden seen items", async () => {
  const app = await clientSource("app.js");

  // Section vocabulary from docs/fold-glance.md's remote spec.
  assert.ok(app.includes(">Running now</h3>"));
  assert.ok(app.includes(">Since you last looked</h3>"));
  assert.ok(app.includes(">Checks</h3>"));
  assert.ok(app.includes(">Needs you</h3>"));

  // Marking seen advances only this grant's own marker, only after the digest
  // rendered on the visible surface that shows it; fetching never advances it.
  assert.match(app, /renderFoldHome\(\);\s*\n\s*acknowledgeGlance\(\);/);
  assert.match(app, /if \(state\.contextName !== "needs"\) return;/);
  assert.match(app, /document\.visibilityState === "hidden"/);
  assert.match(app, /remote\("management\.glanceSeen", \{ cursor \}\)/);

  // Seen items render quieter, never hidden: Show earlier reveals the bounded
  // tail, and truncation is disclosed instead of pretending completeness.
  assert.ok(app.includes("Show earlier"));
  assert.match(app, /glance-item\$\{quiet \? " quiet" : ""\}/);
  assert.ok(app.includes("Nothing new since you last looked."));
  assert.ok(app.includes("More is running than fits here."));
  // "digest" is contract vocabulary; the client never says it to a person.
  assert.equal(app.includes("this digest"), false);
  assert.ok(app.includes("Some records could not be read just now:"));

  // A question raised inside a chat is answered in that chat — but only when
  // this browser can actually open it.
  assert.match(app, /state\.conversations\.some\(\(conversation\) => conversation\.id === conversationId\)/);
  assert.ok(app.includes(">Open chat</button>"));

  // Desktop offline means no digest: the client refreshes only while online
  // and keeps its honest offline state otherwise.
  assert.match(app, /if \(!state\.session\?\.desktopOnline\) return Promise\.resolve\(false\);/);
  assert.match(app, /if \(foldHomeRefresh\) return foldHomeRefresh;/);
});

test("remote client navigation is one sidebar over four screens", async () => {
  const app = await clientSource("app.js");
  const styles = await clientSource("app.css");

  // Four screens, New chat as the door; the retired hashes land there too.
  assert.match(app, /const contextNames = \["new", "chat", "needs", "spaces"\];/);
  // The Space browser is named for where it goes; `#files` still lands there.
  assert.match(app, /if \(raw === "files"\) return \{ context: "spaces"/);
  assert.match(app, /contextNames\.includes\(raw\) \? raw : "new"/);
  assert.match(app, /requested === "home" \|\| requested === "chats"\) return "new"/);
  assert.match(app, /id="context-new"[\s\S]*?id="context-chat"[\s\S]*?id="context-needs"[\s\S]*?id="context-spaces"/);
  assert.match(app, /id="new-composer-slot"[\s\S]*?id="messages"[\s\S]*?id="chat-composer-slot"/);

  // The sidebar exists once in the DOM and is both the desktop column and the
  // phone drawer; its state is remembered, and the bottom tab bar is gone.
  assert.equal(app.match(/class="sidebar"/g).length, 1);
  assert.ok(app.includes('<aside id="drawer" class="sidebar" aria-label="Menu">'));
  assert.ok(app.includes('const sidebarStorageKey = "work-fold-remote-sidebar-v1"'));
  assert.match(styles, /\.app-shell\[data-sidebar="collapsed"\] \.sidebar \{[^}]*width: 60px/);
  assert.equal(app.includes("tab-bar"), false);
  assert.equal(styles.includes(".tab-bar"), false);

  // Expanded order: New chat, Needs you with its count, the grouped chat
  // list, then Spaces, presence, and Settings in the footer.
  assert.match(app, /id="new-chat"[\s\S]*?data-nav-context="needs"[\s\S]*?data-nav-badge[\s\S]*?<ul id="chats"[\s\S]*?data-nav-context="spaces"[\s\S]*?id="desktop-presence"[\s\S]*?id="account-settings"/);
  assert.match(app, /"Today"[\s\S]*?"Yesterday"[\s\S]*?"Earlier"/);
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
  for (const name of ["New chat", "Chats", "Needs you", "Spaces", "Settings"]) {
    assert.ok(app.includes(`data-tip="${name}" aria-label="${name}"`) || app.includes(`aria-label="${name}" data-tip="${name}"`),
      `tooltip and accessible name disagree for ${name}`);
  }
  // The CSS tooltip is the only tooltip: no native title doubles it up.
  assert.equal(app.includes('title="Settings"'), false);

  // The phone's top bar: ☰ with the needs-you dot, and a drawer that
  // is a real dialog — focus trapped, Escape closing, body scroll locked.
  assert.match(app, /id="menu-button"[\s\S]*?aria-label="Menu"[\s\S]*?aria-controls="drawer"[\s\S]*?aria-expanded="false"/);
  assert.match(app, /class="menu-dot" data-nav-dot hidden/);
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

  // Needs you renders the questions first, then the digest.
  assert.ok(app.includes("${renderFromChats()}${renderGlance()}"));
  assert.ok(app.includes("Nothing needs you right now."));

  // Presence is a sidebar-footer line, honest in both directions.
  assert.ok(app.includes('online ? "Desktop online" : "Desktop offline"'));
});
