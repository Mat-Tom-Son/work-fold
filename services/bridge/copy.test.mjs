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
  assert.ok(app.includes("Check the address, or enable web access from the work-fold desktop app."));

  // Landing detail 03.
  assert.ok(app.includes("<h2>Your fold on the web</h2>"));
  assert.ok(app.includes("One private address opens the same conversation your menu bar does, while your desktop is online."));

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

  // Desktop-offline gate: approval and presence language stays exact.
  assert.match(app, /eyebrow: "Desktop offline",\s*\n\s*headline: "Open work-fold to continue\."/);
  assert.ok(app.includes("The desktop app holds your conversation and approves new browsers."));

  // Pairing copy: security copy is load-bearing.
  assert.ok(app.includes('eyebrow: "Approve this browser once"'));
  assert.ok(app.includes('headline: "Match the code in work-fold."'));
  assert.ok(app.includes("Approval binds a non-exportable browser key to your desktop."));

  // The Chats screen lists the fold's saved chats; Home is the door and
  // carries the quiet fold header.
  assert.ok(app.includes('<h1 class="context-title" tabindex="-1">Chats</h1>'));
  assert.ok(app.includes('<h1 class="context-title" tabindex="-1">Your fold</h1>'));

  // Page title stays the product name.
  const page = await clientSource("index.html");
  assert.ok(page.includes("<title>work-fold</title>"));
});

test("remote needs-you cards keep the decision vocabulary and state the surface rules up front", async () => {
  const app = await clientSource("app.js");

  // The one card contract's vocabulary (web-local/src/ui-contract.ts):
  // heading, verbs, note copy, and the destroy second confirmation, exact.
  assert.ok(app.includes(">Approve</button>"));
  assert.ok(app.includes(">Deny</button>"));
  assert.ok(app.includes("<summary>Add a note</summary>"));
  assert.ok(app.includes('placeholder="Optional note, kept with a denial"'));
  assert.ok(app.includes("This deletes something for good. There is no undo."));
  assert.ok(app.includes(">Yes, delete for good</button>"));
  assert.ok(app.includes(">Keep it</button>"));
  assert.ok(app.includes("`Needs you (${state.decisions.length})`"));

  // The surface rules are stated on the card, not discovered at refusal
  // time (docs/fold-consecrations.md): desktop-only Personal-scope
  // make-runnable, and no self-approval by the staging grant.
  assert.ok(app.includes("Loads into the fold's own runtime, so its decision belongs to your desktop."));
  assert.ok(app.includes("Staged at this browser's request, so this browser cannot decide it."));
  assert.match(app, /card\.stagedByGrantId === state\.identity\?\.grantId/);
  assert.match(app, /card\.secondConfirmation && !state\.confirmingDestroy\.has\(cardId\)/);
  assert.doesNotMatch(app, /approve all/i);

  // A rootless file grant approves only where the folder picker lives: the
  // typed card flag disables Approve up front, states the rule, and keeps
  // denial available from this browser.
  assert.ok(app.includes("Approving binds this grant to a folder chosen in the main work-fold window's needs-you flyout"));
  assert.match(app, /const needsChosenFolder = !rule && Boolean\(card\.needsDesktopChosenFolder\)/);
  assert.match(app, /data-decision="approved"\$\{busy \|\| needsChosenFolder \? " disabled" : ""\}>Approve<\/button>/);

  // Denial memory and outcome sentences match the desktop surfaces.
  assert.ok(app.includes("now staged again."));
  assert.ok(app.includes("work-fold never retries a denied act."));
  assert.ok(app.includes("Approved, but interrupted before it finished. It was not replayed."));

  // Person-facing copy never says "consecration" — that is a contract term.
  const withoutComments = app.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /consecration/i);
});

test("remote glance home renders the digest sections with quiet-not-hidden seen items", async () => {
  const app = await clientSource("app.js");

  // Section vocabulary from docs/fold-glance.md's remote-home spec.
  assert.ok(app.includes(">Running now</h3>"));
  assert.ok(app.includes(">Since you last looked</h3>"));
  assert.ok(app.includes(">Checks</h3>"));

  // Marking seen advances only this grant's own marker, only after the digest
  // rendered on a visible surface; fetching never advances it.
  assert.match(app, /renderFoldHome\(\);\s*\n\s*acknowledgeGlance\(\);/);
  assert.match(app, /document\.visibilityState === "hidden"/);
  assert.match(app, /remote\("management\.glanceSeen", \{ cursor \}\)/);

  // Seen items render quieter, never hidden: Show earlier reveals the bounded
  // tail, and truncation is disclosed instead of pretending completeness.
  assert.ok(app.includes("Show earlier"));
  assert.match(app, /glance-item\$\{quiet \? " quiet" : ""\}/);
  assert.ok(app.includes("Nothing new since you last looked."));
  assert.ok(app.includes("More is running than fits in this digest."));
  assert.ok(app.includes("Some records could not be read just now:"));

  // Desktop offline means no digest: the client refreshes only while online
  // and keeps its honest offline state otherwise.
  assert.match(app, /if \(state\.foldHomeRefreshing \|\| !state\.session\?\.desktopOnline\) return;/);
});

test("remote client navigation keeps the four-context single-column shell", async () => {
  const app = await clientSource("app.js");

  // Bottom tabs on the phone; the icon rail from 860px up. The same three
  // destinations either way, and the Chat screen belongs to Chats in both.
  assert.match(app, /class="tab-bar"[\s\S]*?<span>Home<\/span>[\s\S]*?<span>Chats<\/span>[\s\S]*?<span>Files<\/span>/);
  assert.match(app, /class="icon-rail"[\s\S]*?aria-label="Home"[\s\S]*?aria-label="Chats"[\s\S]*?aria-label="Files"[\s\S]*?aria-label="New chat"/);
  assert.match(app, /const highlighted = name === "chat" \? "chats" : name;/);
  assert.match(app, /setAttribute\("aria-current", "page"\)/);

  // Chat is a single column with a back affordance at every width; the saved
  // list lives only in the Chats context — there is no desktop sidebar.
  assert.match(app, /id="context-chats"[\s\S]*?<ul id="chats"[\s\S]*?id="context-chat"[\s\S]*?id="back-to-chats"/);
  assert.ok(app.includes('aria-label="Back to chats"'));

  // The Home status line stays honest: the desktop is online or asleep,
  // never an error page pretending otherwise.
  assert.ok(app.includes('online ? "Desktop online" : "Desktop asleep"'));

  // The Home composer always starts a new request, and "Fold it in" appears
  // exactly when material is staged on the message (fold.md rule 3).
  assert.match(app, /sentFromHome \|\| state\.startingNewChat \|\| !state\.selectedConversationId/);
  assert.ok(app.includes('state.uploads.length ? "Fold it in" : "Send message"'));

  // Home renders pending decisions first, then the live request tail, then
  // the glance body — the needs-you stack is never below the digest.
  assert.ok(app.includes("${renderNeedsYou()}${renderHomeActivity()}${renderGlance()}"));
});
