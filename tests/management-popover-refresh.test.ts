import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("the persistent menu-bar popover reconciles replies whenever it becomes visible again", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(source, /window\.addEventListener\("focus", refreshWhenVisible\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(source, /refreshConversation\(\)/);
  assert.match(source, /api<\{ messages: ManagementMessage\[\] \}>\(`\/api\/management\/conversations\/\$\{encodeURIComponent\(nextConversationId\)\}`\)/);
  assert.match(source, /messages\.map\(\(message\) =>/);
  assert.match(source, /message\.role === "assistant"[\s\S]*?<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>\{message\.content\}<\/ReactMarkdown>/);
  assert.doesNotMatch(source, /\{request\.reply\.content\}/);
});

test("the popover surfaces pending decisions as a needs-you stack between the header and the transcript", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const component = await readFile(resolve(rootDir, "web-local/src/components/NeedsYouDecisions.tsx"), "utf8");
  // Durable pending decisions are their own region, distinct from the
  // conversational needs_you phase, rendered from the shared card component
  // the main-window flyout also mounts (one card contract).
  assert.match(popover, /useNeedsYouDecisions\(\{ surface: "popover" \}\)/);
  const stackIndex = popover.indexOf("<NeedsYouStack state={needsYou} />");
  assert.ok(stackIndex >= 0, "the popover mounts the shared needs-you stack");
  assert.ok(stackIndex > popover.indexOf('<header className="popover-header">'), "the stack sits below the header");
  assert.ok(stackIndex < popover.indexOf('className="popover-transcript"'), "the stack sits above the transcript");
  // Refresh rides the popover's existing reconcile discipline; no second watcher.
  assert.match(popover, /void refreshNeedsYou\(\);/);
  // The card body is host-composed by the decision routes: the component
  // renders typed fields, decides over the same routes with its surface
  // recorded, and offers no approve-all anywhere.
  assert.match(component, /api<\{ decisions: DecisionCardView\[\] \}>\("\/api\/management\/decisions"\)/);
  assert.match(component, /decisions\/\$\{encodeURIComponent\(card\.id\)\}\/decide/);
  assert.match(component, /surface,/);
  assert.match(component, /\{card\.categoryLine\}/);
  assert.match(component, /\{card\.title\}/);
  assert.match(component, /\{fact\.label\}/);
  assert.doesNotMatch(component, /approve all/i);
  // "Consecration" is a contract term for code comments only; the rendered
  // component text never says it.
  const withoutComments = component.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(withoutComments, /consecration/i, "person-facing copy never says consecration");
  // Destroy cards demand a second explicit confirmation inside the card, and
  // a denial takes one click with the note offered, never required.
  assert.match(component, /card\.secondConfirmation && !confirmingDestroy/);
  assert.match(component, /onDecide\("denied", \{ note \}\)/);
});

test("an app.grant.files card binds to a person-chosen folder through the main window's picker only", async () => {
  const component = await readFile(resolve(rootDir, "web-local/src/components/NeedsYouDecisions.tsx"), "utf8");
  const mainPreload = await readFile(resolve(rootDir, "desktop/src/preload.cts"), "utf8");
  const popoverPreload = await readFile(resolve(rootDir, "desktop/src/management-popover-preload.cts"), "utf8");
  const main = await readFile(resolve(rootDir, "desktop/src/main.ts"), "utf8");

  // The card refuses to approve without a chosen root, sends the root only
  // with an approval, and feature-detects the picker instead of assuming it.
  // The grant-root need is the host-computed `needsDesktopChosenFolder` flag
  // from the card projection, never re-inferred from the card's kind — the
  // projection alone knows when the staging contract carries a root.
  assert.match(component, /card\.needsDesktopChosenFolder && card\.state === "staged"/);
  assert.match(component, /needsDesktopChosenFolder: boolean;/);
  assert.doesNotMatch(component, /card\.kind === "app\.grant\.files"/);
  assert.match(component, /window\.workFoldDesktop\?\.decisions\?\.chooseFileGrantRoot/);
  assert.match(component, /if \(needsGrantRoot && grantRoot === null\) return;/);
  assert.match(component, /disabled=\{busy \|\| !grantRootReady\}/);
  assert.match(component, /decision === "approved" && options\?\.fileGrantRoot \? \{ fileGrantRoot: options\.fileGrantRoot \}/);
  assert.match(component, /grantRootMainWindowOnly/);

  // The picker is a main-window capability by construction: the main preload
  // exposes it, the popover's narrow preload must never grow it.
  assert.match(mainPreload, /chooseFileGrantRoot: \(spaceId: string\) => ipcRenderer\.invoke\("work-fold:decisions:choose-file-grant-root", spaceId\)/);
  assert.doesNotMatch(popoverPreload, /choose-file-grant-root|chooseFileGrantRoot/);

  // The desktop handler validates the pick against the Space's folder and
  // refuses work-fold metadata; the renderer never does path math on
  // absolute paths.
  const handlerStart = main.indexOf('ipcMain.handle("work-fold:decisions:choose-file-grant-root"');
  assert.ok(handlerStart >= 0, "main registers the grant-root picker handler");
  const handler = main.slice(handlerStart, main.indexOf("ipcMain.handle", handlerStart + 1));
  assert.match(handler, /relative\(space\.spaceRoot, resolve\(chosen\)\)/);
  assert.match(handler, /Choose a folder inside this Space's folder\./);
  assert.match(handler, /containsReservedSpacePathSegment/);
});

test("the popover accounts for every attachment outcome, including the Space-free Library placement", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The host-recorded trail renders all four recorded outcomes; the Library
  // line carries no Space name and no restore point, because the Library is
  // Space-free by design.
  assert.match(popover, /"placed" \| "registered" \| "library" \| "unrecorded"/);
  assert.match(popover, /Added \{disposition\.attachment\.name\} to your Library/);
  assert.match(popover, /no recorded placement — see the reply below/);
});

test("the popover renders the glance below the needs-you stack and acknowledges only after render", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const section = await readFile(resolve(rootDir, "web-local/src/popover/GlanceSection.tsx"), "utf8");

  // Section order (docs/fold-glance.md, the popover top): the needs-you card
  // stack first, then the glance, above the transcript and composer.
  assert.match(popover, /useGlance\("popover"\)/);
  const glanceIndex = popover.indexOf('<GlanceSection state={glance} surface="popover" />');
  assert.ok(glanceIndex >= 0, "the popover mounts the glance section");
  assert.ok(glanceIndex > popover.indexOf("<NeedsYouStack state={needsYou} />"), "the glance sits below the needs-you stack");
  assert.ok(glanceIndex < popover.indexOf('className="popover-transcript"'), "the glance sits above the transcript");
  // The glance rides the popover's existing refresh discipline; no second watcher.
  assert.match(popover, /void refreshGlance\(\);/);

  // Fetch and acknowledge are separate steps in the right order: the fetch
  // only stores the snapshot, and the cursor is posted from a post-render
  // effect that skips hidden surfaces and repeats — fetching never advances
  // a marker, and no acknowledge happens before render.
  assert.match(section, /api<\{ glance: GlanceSnapshotView \}>\("\/api\/management\/glance"\)/);
  const fetchBody = section.slice(section.indexOf("const refresh = useCallback"), section.indexOf("useEffect"));
  assert.doesNotMatch(fetchBody, /glance\/seen/, "the fetch path never acknowledges");
  assert.match(section, /document\.visibilityState === "hidden"\) return;/);
  assert.match(section, /snapshot\.seen\[surface\] === snapshot\.cursor \|\| acknowledgedRef\.current === snapshot\.cursor/);
  assert.match(section, /body: \{ surface, cursor: snapshot\.cursor \}/);

  // The digest's sections keep the recorded order and vocabulary, seen items
  // render quieter — never hidden — and bounds are disclosed, not curated.
  for (const heading of ["Needs you", "Running now", "Since you last looked", "Checks"]) {
    assert.ok(section.includes(`>${heading}</h3>`), `the glance renders the ${heading} heading`);
  }
  assert.ok(section.indexOf(">Needs you</h3>") < section.indexOf(">Running now</h3>"));
  assert.ok(section.indexOf(">Running now</h3>") < section.indexOf(">Since you last looked</h3>"));
  assert.ok(section.indexOf(">Since you last looked</h3>") < section.indexOf(">Checks</h3>"));
  assert.match(section, /quiet=\{!isNew\(item\)\}/);
  assert.match(section, /Show earlier \(\{earlierCount\}\)/);
  assert.match(section, /Nothing new since you last looked\./);
  assert.match(section, /More is running than fits in this digest\./);
  assert.match(section, /Some records could not be read just now:/);
  // Pending decisions stay the card stack's job; the glance renders the
  // digest's other needs-you kinds so no item appears twice.
  assert.match(section, /item\.kind !== "pending-decision"/);
});

test("the menu-bar popover starts a clean saved management chat without deleting the previous transcript", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(source, />\s*<SquarePen aria-hidden="true" \/>\s*<span>New chat<\/span>/);
  assert.match(source, /startingNewChatRef\.current = true/);
  assert.match(source, /body\.newConversation = true/);
  assert.match(source, /previous chat is still saved on this desktop/);
  assert.match(source, /idlePollIntervalMs = 5_000/);
});
