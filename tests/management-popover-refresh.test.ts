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

test("the popover keeps the door first: a quiet fold is the composer, one footer line, and nothing else", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The quiet state (no pending decisions, no active request) renders the
  // header, the drop zone + composer, and one muted footer line. Every other
  // region is conditional: decisions and the conversation render only when
  // their content exists, drawers only while their section is open.
  assert.match(popover, /\{decisionCount > 0 \|\| decisionNotice \? \(/);
  assert.match(popover, /\{conversationExists \? \(/);
  assert.match(popover, /const conversationExists = messages\.length > 0 \|\| request !== null;/);
  assert.match(popover, /\{openSection === "decisions" \? \(/);
  assert.match(popover, /\{openSection === "conversation" \? \(/);
  assert.match(popover, /\{openSection === "glance" \? \(/);
  // The footer line: quiet status at the left — honest about recorded running
  // work, deriving the Space count from the glance snapshot when it can — and
  // the What's new strip trigger at the right.
  assert.match(popover, /className="popover-foot"/);
  assert.match(popover, /\{decisionCount === 0 && !requestActive \? quietStatus : ""\}/);
  assert.match(popover, /`\$\{running\} running now`/);
  assert.match(popover, /`All quiet across \$\{spaces\} Spaces` : "All quiet"/);
  assert.match(popover, /glanceSpaceCount\(glance\.snapshot\)/);
  // The composer keeps its shipped drop-staging and two-state capture verb
  // (pinned exactly in work-fold-brand.test.ts), and takes focus first in the
  // quiet state without stealing it from anything the person focused.
  assert.match(popover, /const focusComposerFirst = \(\) => \{/);
  assert.match(popover, /if \(decisionCount > 0\) return;/);
  assert.match(popover, /if \(current && activePhases\.has\(current\.phase\)\) return;/);
  assert.match(popover, /if \(active && active !== document\.body && active !== document\.documentElement\) return;/);
  assert.match(popover, /composerRef\.current\?\.focus\(\);/);
  assert.match(popover, /window\.addEventListener\("focus", focusComposerFirst\)/);
  assert.match(popover, /document\.addEventListener\("visibilitychange", focusComposerFirst\)/);
});

test("the priority ladder auto-opens exactly one folded section at a time", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // One accordion: a single openSection state drives every drawer, so
  // expanding one section collapses the rest to their strips.
  assert.match(popover, /useState<FoldSection \| null>\(null\)/);
  // Rung 1 — decisions outrank everything: newly pending decisions open their
  // section, and it folds back once nothing pends and no just-settled outcome
  // notice is on screen.
  assert.match(popover, /if \(decisionCount > 0 && previous === 0\) setOpenSection\("decisions"\);/);
  assert.match(popover, /else if \(decisionCount === 0 && !decisionNotice\) \{\s*setOpenSection\(\(current\) => \(current === "decisions" \? null : current\)\);/);
  // Rung 2 — the active request: a needs_you reply opens the conversation,
  // and a request that just settled auto-expands it once so the result entry
  // is visible; both defer to pending decisions.
  assert.match(popover, /if \(decisionCount > 0\) return;\s*if \(phase === "needs_you"\) setOpenSection\("conversation"\);/);
  assert.match(popover, /activePhases\.has\(previous\) && terminalPhases\.has\(phase\)/);
  // The ladder acts only on transitions, so a person's own strip choices are
  // never fought mid-look.
  assert.match(popover, /prevDecisionCountRef/);
  assert.match(popover, /prevPhaseRef/);
  // The glance never auto-opens: no ladder effect assigns it.
  assert.doesNotMatch(popover, /setOpenSection\("glance"\)/);
});

test("the popover surfaces pending decisions one card at a time behind the warning strip", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const component = await readFile(resolve(rootDir, "web-local/src/components/NeedsYouDecisions.tsx"), "utf8");
  // Durable pending decisions are their own region, distinct from the
  // conversational needs_you phase, rendered from the shared card component
  // the main-window flyout also mounts (one card contract). The popover asks
  // for the single-card presentation; the flyout keeps the full stack.
  assert.match(popover, /useNeedsYouDecisions\(\{ surface: "popover" \}\)/);
  const stackIndex = popover.indexOf('<NeedsYouStack state={needsYou} presentation="single" />');
  assert.ok(stackIndex >= 0, "the popover mounts the shared needs-you machinery in its single-card presentation");
  assert.ok(stackIndex > popover.indexOf('<header className="popover-header">'), "the decisions section sits below the header");
  assert.ok(stackIndex < popover.indexOf('className="popover-transcript"'), "the decisions section sits above the conversation");
  // The strip is a warning-tinted disclosure button naming the count.
  assert.match(popover, /className="fold-strip fold-strip-decisions"/);
  assert.match(popover, /aria-controls="popover-decisions"/);
  assert.match(popover, /"1 decision needs you" : `\$\{decisionCount\} decisions need you`/);
  // Refresh rides the popover's existing reconcile discipline; no second watcher.
  assert.match(popover, /void refreshNeedsYou\(\);/);
  // Single-card presentation: one current card plus an "N more" advance
  // affordance that cycles; the cursor clamps when deciding shrinks the list.
  assert.match(component, /presentation = "stack"/);
  assert.match(component, /state\.cards\.slice\(index, index \+ 1\)/);
  assert.match(component, /Math\.min\(cardCursor, state\.cards\.length - 1\)/);
  assert.match(component, /\(index \+ 1\) % state\.cards\.length/);
  assert.match(component, /className="needs-you-advance"/);
  assert.match(component, /\{moreCount\} more/);
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

test("one narrator: the conversation drawer absorbs the request story and the live tail stays visible", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The working line is the conversation's live tail while a request is
  // active — rendered outside the collapsible drawer so it stays visible even
  // when the transcript is folded — with the shipped strings intact (the
  // close-your-fold line is additionally pinned in work-fold-brand.test.ts).
  const drawerStart = popover.indexOf('id="popover-conversation"');
  const drawerEnd = popover.indexOf('className="fold-tail"');
  assert.ok(drawerStart >= 0 && drawerEnd > drawerStart, "the conversation drawer precedes the live tail");
  assert.match(popover, /\{request && activePhases\.has\(request\.phase\) \? \(\s*<div className="fold-tail">/);
  assert.match(popover, /\{activity \|\| "Working on your request"\}/);
  assert.match(popover, /elapsedLabel \? `started \$\{elapsedLabel\} ago` : "just started"/);
  assert.match(popover, /item\$\{request\.attachments\.length === 1 \? "" : "s"\} attached/);
  assert.match(popover, /Handed off — work continues in \{request\.children\.filter\(\(child\) => child\.state === "running"\)\.length === 1 \? "a Space" : "Spaces"\}\./);
  assert.match(popover, /request\.phase === "handed_off" \? "Stop remaining work" : "Stop"/);
  assert.match(popover, /className="working-line" role="status" aria-live="polite"/);
  // The handed-off per-child trail and the settled result render inside the
  // drawer as inline entries, after the transcript messages — every recorded
  // state keeps its shipped label, and nothing silently disappears.
  const handedOffTrail = popover.indexOf('request.phase === "handed_off" ? (\n                <article className="popover-entry">');
  const resultEntry = popover.indexOf("<ResultEntry request={request} />");
  assert.ok(handedOffTrail > drawerStart && handedOffTrail < drawerEnd, "the handed-off trail is a conversation entry");
  assert.ok(resultEntry > handedOffTrail && resultEntry < drawerEnd, "the settled result is a conversation entry");
  assert.match(popover, /\{child\.spaceName\}: \{childStateLabel\(child\.state\)\}/);
  assert.match(popover, /Couldn't finish\{request\.error \? `: \$\{request\.error\}` : "\."\}/);
  assert.match(popover, /Stopped before it finished\./);
  // The phase pill stays in the header only while a request is active.
  assert.match(popover, /\{request && requestActive \? <PhasePill phase=\{request\.phase\} \/> : null\}/);
  assert.match(popover, /const requestActive = request !== null && !terminalPhases\.has\(request\.phase\);/);
});

test("the popover folds the glance behind What's new and marks seen only when the person expands it", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const section = await readFile(resolve(rootDir, "web-local/src/popover/GlanceSection.tsx"), "utf8");

  // The digest rides the popover's existing refresh cadence so the collapsed
  // strip's unseen count stays honest, but the seen marker is gated on the
  // person expanding the strip: fetching never acknowledges, and neither does
  // a collapsed strip.
  assert.match(popover, /useGlance\("popover", \{ acknowledge: openSection === "glance" \}\)/);
  assert.match(popover, /void refreshGlance\(\);/);
  assert.match(section, /const acknowledge = options\?\.acknowledge !== false;/);
  assert.match(section, /if \(!acknowledge\) return;/);
  const fetchBody = section.slice(section.indexOf("const refresh = useCallback"), section.indexOf("useEffect"));
  assert.doesNotMatch(fetchBody, /glance\/seen/, "the fetch path never acknowledges");
  assert.match(section, /document\.visibilityState === "hidden"\) return;/);
  assert.match(section, /snapshot\.seen\[surface\] === snapshot\.cursor \|\| acknowledgedRef\.current === snapshot\.cursor/);
  assert.match(section, /body: \{ surface, cursor: snapshot\.cursor \}/);
  assert.match(section, /api<\{ glance: GlanceSnapshotView \}>\("\/api\/management\/glance"\)/);

  // The strip trigger lives on the footer line, counts unseen change items
  // from the snapshot, and the digest mounts only while expanded — with the
  // main window's honest empty sentence when nothing is recorded.
  assert.match(popover, /aria-controls="popover-glance"/);
  assert.match(popover, /What's new\{unseenCount \? ` \(\$\{unseenCount\}\)` : ""\}/);
  assert.match(popover, /glanceUnseenChangeCount\(glance\.snapshot, "popover"\)/);
  assert.match(section, /export function glanceUnseenChangeCount/);
  const glanceMount = popover.indexOf('<GlanceSection state={glance} surface="popover" />');
  assert.ok(glanceMount > popover.indexOf('{openSection === "glance" ? ('), "the digest renders only inside the expanded drawer");
  assert.match(popover, /Nothing recorded right now: no running work, nothing waiting on you, and no recorded changes\./);

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
  // Pending decisions stay the card surface's job; the glance renders the
  // digest's other needs-you kinds so no item appears twice.
  assert.match(section, /item\.kind !== "pending-decision"/);
});

test("the popover's strips are accessible disclosures and Escape still hides the popover", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // Every strip is a button carrying aria-expanded and aria-controls; the
  // transcript keeps its polite live region and label.
  assert.match(popover, /aria-expanded=\{openSection === "decisions"\}/);
  assert.match(popover, /aria-expanded=\{openSection === "conversation"\}/);
  assert.match(popover, /aria-expanded=\{openSection === "glance"\}/);
  assert.match(popover, /aria-controls="popover-conversation"/);
  assert.match(popover, /aria-label="Your fold" aria-live="polite"/);
  // A person's strip click toggles the section: expanding moves focus to the
  // section's first actionable element (falling back to the drawer region),
  // collapsing leaves focus on the strip the click already focused, and the
  // ladder's auto-opens never move focus.
  assert.match(popover, /const toggleSection = useCallback\(\(section: FoldSection\) => \{/);
  assert.match(popover, /drawer\.querySelector<HTMLElement>\("button, \[href\], input, textarea, select, summary"\)/);
  assert.match(popover, /\(target \?\? drawer\)\.focus\(\);/);
  // Escape still hides the popover (and drops the overflow menu with it).
  assert.match(popover, /if \(event\.key === "Escape"\) \{\s*setMenuOpen\(false\);\s*bridge\?\.management\?\.hide\(\);/);
});

test("the popover composer behaves like every other work-fold composer", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const css = await readFile(resolve(rootDir, "web-local/src/popover/popover.css"), "utf8");
  // Enter sends, Shift+Enter keeps the newline, and a mid-IME-composition
  // Enter never sends — the same contract as the main window and the web
  // client's composer (services/bridge/public/composer.js).
  assert.match(popover, /event\.key === "Enter" && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  // Escape never dismisses the surface mid-IME-composition.
  assert.match(popover, /if \(event\.isComposing\) return;/);
  // The draft box grows with its content instead of scrolling in a fixed slit.
  assert.match(css, /field-sizing: content/);
  // The transcript follows new entries only while pinned near the bottom, so
  // reading scrollback is never yanked away by the poll cadence — and a
  // refetch that changes nothing keeps the old array identity.
  assert.match(popover, /transcriptPinnedRef/);
  assert.match(popover, /sameTranscript\(current, next\) \? current : next/);
  // Staged chips render outside the composer conditional so a mid-turn drop
  // is confirmed on screen instead of surfacing after the turn settles.
  const chips = popover.indexOf('className="chips"');
  const composer = popover.indexOf('className="composer"');
  assert.ok(chips >= 0 && composer > chips, "the chips list renders before (outside) the composer section");
  // New chat cannot orphan a running request's live tail and Stop button.
  assert.match(popover, /if \(current && activePhases\.has\(current\.phase\)\) return;\s*startingNewChatRef\.current = true/);
});

test("the menu-bar popover starts a clean saved management chat from the overflow menu", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // New chat moves from the header into the ⋯ overflow menu with its exact
  // behavior and title text; the menu is a real menu with outside-click and
  // Escape dismissal.
  assert.match(source, /aria-haspopup="menu"/);
  assert.match(source, /id="popover-overflow-menu" className="popover-menu" role="menu"/);
  assert.match(source, /role="menuitem"/);
  assert.match(source, /title="Start a new chat\. This chat stays saved on your desktop\."/);
  assert.match(source, />\s*<SquarePen aria-hidden="true" \/>\s*<span>New chat<\/span>/);
  assert.match(source, /document\.addEventListener\("pointerdown", closeFromOutside, true\)/);
  assert.match(source, /startingNewChatRef\.current = true/);
  assert.match(source, /body\.newConversation = true/);
  assert.match(source, /previous chat is still saved on this desktop/);
  assert.match(source, /idlePollIntervalMs = 5_000/);
});
