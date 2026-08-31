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

test("the popover keeps the conversation and composer visible without idle chrome", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // Pending decisions remain conditional, but the transcript is an ordinary
  // always-visible chat surface instead of a Conversation disclosure.
  assert.match(popover, /\{decisionCount > 0 \|\| decisionNotice \? \(/);
  assert.match(popover, /<section className="fold-section fold-section-conversation">\s*<section\s*className="popover-transcript"/);
  assert.doesNotMatch(popover, />Conversation<\/span>/);
  assert.doesNotMatch(popover, /conversationExists|aria-controls="popover-conversation"/);
  // Idle status and glance chrome are absent from the compact menu-bar view.
  assert.doesNotMatch(popover, /popover-foot|All quiet|What's new|useGlance\("popover"/);
  assert.doesNotMatch(popover, /Drop files, folders, or links here/);
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

test("pending decisions remain the popover's only disclosure", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(popover, /useState\(false\)/);
  assert.match(popover, /if \(decisionCount > 0 && previous === 0\) setDecisionsOpen\(true\);/);
  assert.match(popover, /else if \(decisionCount === 0 && !decisionNotice\) setDecisionsOpen\(false\);/);
  assert.match(popover, /prevDecisionCountRef/);
  assert.doesNotMatch(popover, /FoldSection|openSection|prevPhaseRef/);
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

test("the fold uses ordinary chat geometry and one compact live line", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The working line follows the always-visible transcript while a request is
  // active without taking a second status panel's worth of vertical space.
  const drawerStart = popover.indexOf('id="popover-conversation"');
  const drawerEnd = popover.indexOf('className="fold-tail"');
  assert.ok(drawerStart >= 0 && drawerEnd > drawerStart, "the conversation drawer precedes the live tail");
  assert.match(popover, /\{request && activePhases\.has\(request\.phase\) \? \(\s*<div className="fold-tail">/);
  assert.match(popover, /\{activity \|\| "Thinking…"\}/);
  assert.match(popover, /<span className="working-elapsed">\{elapsedLabel\}<\/span>/);
  assert.match(popover, /Working in \{request\.children\.filter\(\(child\) => child\.state === "running"\)\.length === 1 \? "a Space" : "Spaces"\}…/);
  assert.match(popover, /className="working-line" role="status" aria-live="polite"/);
  assert.doesNotMatch(popover, /You can close your fold|item\$\{request\.attachments\.length/);
  assert.doesNotMatch(popover, /popover-message-role/);
  const css = await readFile(resolve(rootDir, "web-local/src/popover/popover.css"), "utf8");
  assert.match(css, /\.popover-message\.user \{[\s\S]*?align-self: flex-end;[\s\S]*?background: var\(--pop-accent\);/);
  assert.match(css, /\.popover-message\.assistant \{[\s\S]*?align-self: flex-start;/);
  assert.doesNotMatch(css, /\.popover-message \+ \.popover-message \{ border-top:/);
  // The handed-off per-child trail and the settled result render inside the
  // drawer as inline entries, after the transcript messages — every recorded
  // state keeps its shipped label, and nothing silently disappears.
  const handedOffTrail = popover.search(/request\.phase === "handed_off" \? \(\s*<article className="popover-entry">/);
  const resultEntry = popover.indexOf("<ResultEntry request={request} />");
  assert.ok(handedOffTrail > drawerStart && handedOffTrail < drawerEnd, "the handed-off trail is a conversation entry");
  assert.ok(resultEntry > handedOffTrail && resultEntry < drawerEnd, "the settled result is a conversation entry");
  assert.match(popover, /\{child\.spaceName\}: \{childStateLabel\(child\.state\)\}/);
  assert.match(popover, /Couldn't finish\{request\.error \? `: \$\{request\.error\}` : "\."\}/);
  assert.match(popover, /Stopped before it finished\./);
  // The header carries no redundant phase badge: the live status line and the
  // in-composer Stop action communicate the running state without crowding it.
  assert.doesNotMatch(popover, /PhasePill|pill-working/);
});

test("the popover renders the live Assistant response and reconciles the durable transcript", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // Reconnect snapshots replace the transient projection, deltas are batched
  // to an animation frame, and the authoritative final message replaces it.
  assert.match(popover, /event\.type === "turn_snapshot" && typeof event\.text === "string"[\s\S]*replaceStreamingAssistant\(event\.text\)/);
  assert.match(popover, /event\.type === "assistant_delta" && typeof event\.text === "string"[\s\S]*queueStreamingAssistant\(event\.text\)/);
  assert.match(popover, /event\.type === "assistant_message" && typeof event\.text === "string"[\s\S]*replaceStreamingAssistant\(event\.text\)/);
  assert.match(popover, /window\.requestAnimationFrame\(flushStreamingAssistant\)/);
  assert.match(popover, /className="popover-message assistant streaming" aria-label="work-fold is replying"/);
  assert.match(popover, /<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>\{streamingAssistant\}<\/ReactMarkdown>/);
  assert.match(popover, /if \(!summary\.latestRequest \|\| !activePhases\.has\(summary\.latestRequest\.phase\)\) replaceStreamingAssistant\(""\);/);
});

test("the compact popover leaves the glance to the main window and approved web clients", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.doesNotMatch(popover, /GlanceSection|useGlance|refreshGlance|popover-glance|What's new|All quiet/);
  assert.doesNotMatch(popover, /\/api\/management\/glance/);
});

test("the decision disclosure is accessible and Escape still hides the popover", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(popover, /aria-expanded=\{decisionsOpen\}/);
  assert.match(popover, /aria-controls="popover-decisions"/);
  assert.match(popover, /aria-label="Your fold" aria-live="polite"/);
  // Expanding moves focus to the first actionable element in the decision
  // card, falling back to the drawer region itself.
  assert.match(popover, /const toggleDecisions = useCallback\(\(\) => \{/);
  assert.match(popover, /drawer\.querySelector<HTMLElement>\("button, \[href\], input, textarea, select, summary"\)/);
  assert.match(popover, /\(target \?\? drawer\)\.focus\(\);/);
  assert.match(popover, /if \(event\.key === "Escape"\) \{\s*bridge\?\.management\?\.hide\(\);/);
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
  // The composer is one aligned field: a compact one-line textarea that grows
  // beside its action, never an absolutely positioned or second-row button.
  assert.match(popover, /className="composer-field"[\s\S]*rows=\{1\}[\s\S]*className=\{`composer-action\$\{requestRunning \? " composer-stop" : " primary"\}`\}/);
  assert.match(css, /\.composer-field \{[\s\S]*display: flex;[\s\S]*align-items: flex-end;[\s\S]*gap: 6px;/);
  assert.match(css, /\.composer-action \{[\s\S]*align-self: flex-end;[\s\S]*min-height: 32px;/);
  assert.doesNotMatch(css, /\.composer-action \{[\s\S]*position: absolute;/);
  assert.doesNotMatch(popover, /composer-footer/);
  // The same action becomes Stop while work is active; the composer remains
  // mounted as a safe draft area and sending is refused until the turn settles.
  assert.match(popover, /if \(requestRunning\) void stop\(\); else void send\(\);/);
  assert.match(popover, /requestRunning\s*\? stopping \? "Stopping…" : "Stop"/);
  assert.match(popover, /if \(!content \|\| sending \|\| \(currentRequest && activePhases\.has\(currentRequest\.phase\)\)\) return;/);
  // The transcript follows new entries only while pinned near the bottom, so
  // reading scrollback is never yanked away by the poll cadence — and a
  // refetch that changes nothing keeps the old array identity.
  assert.match(popover, /transcriptPinnedRef/);
  assert.match(popover, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?transcript\.scrollTop = transcript\.scrollHeight/);
  assert.match(popover, /\[messages, phase, streamingAssistant, activity, conversationId\]/);
  assert.match(popover, /sameTranscript\(current, next\) \? current : next/);
  // Staged chips render outside the composer conditional so a mid-turn drop
  // is confirmed on screen instead of surfacing after the turn settles.
  const chips = popover.indexOf('className="chips"');
  const composer = popover.indexOf('className="composer"');
  assert.ok(chips >= 0 && composer > chips, "the chips list renders before (outside) the composer section");
  // The whole surface becomes the drop target only during an actual drag;
  // there is no permanent instructional row in the composer.
  assert.match(popover, /onDragEnter=\{onDragEnter\}/);
  assert.match(popover, /dragDepthRef\.current \+= 1/);
  assert.match(popover, /\{dropActive \? \(\s*<div className="drop-overlay" role="status" aria-live="polite">/);
  assert.match(popover, />Drop to add<\/strong>/);
  assert.match(css, /\.drop-overlay \{[\s\S]*position: fixed;[\s\S]*inset: 6px;[\s\S]*pointer-events: none;/);
  assert.doesNotMatch(popover, /className="drop-hint"/);
  // New chat cannot orphan a running request's live tail and Stop button.
  assert.match(popover, /if \(current && activePhases\.has\(current\.phase\)\) return;\s*startingNewChatRef\.current = true/);
});

test("the fold composer names its model and exposes real text-only reasoning controls", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const preload = await readFile(resolve(rootDir, "desktop/src/management-popover-preload.cts"), "utf8");
  const main = await readFile(resolve(rootDir, "desktop/src/main.ts"), "utf8");

  assert.match(popover, /\/api\/agent\/composer\?scope=management/);
  assert.match(popover, /setManagementComposer\(result\.composer\)/);
  assert.match(popover, /bridge\?\.management\?\.openAssistantSettings\(\)/);
  assert.match(preload, /openAssistantSettings: \(\) => ipcRenderer\.invoke\("work-fold:management:open-assistant-settings"\)/);
  assert.match(main, /mainWindow\?\.webContents\.send\("work-fold:agent:open-settings", "management"\)/);

  assert.doesNotMatch(popover, /Brain(?:Circuit)?\d+(?:Filled|Regular)/);
  assert.match(popover, /thinkingLevels\.length >= 2 && composerThinking/);
  assert.match(popover, /\/api\/management\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/thinking/);
  assert.match(popover, /"\/api\/agent\/thinking"/);
  assert.match(popover, /body: \{ scope: "management", level \}/);
  assert.match(popover, /body: \{ level \}/);
  assert.match(popover, /setConversationRuntime\(result\.runtime\)/);
  const css = await readFile(resolve(rootDir, "web-local/src/popover/popover.css"), "utf8");
  assert.match(css, /\.composer-thinking \{\s*flex: none;[\s\S]*?field-sizing: content;[\s\S]*?\}/);
  assert.match(css, /\.composer-thinking \{\s*flex: none;[\s\S]*?padding: 1px 14px 1px 6px;/);
});

test("the header exposes Open app and New chat directly", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(source, /className="popover-open-app" type="button" onClick=\{\(\) => \{ void bridge\?\.management\?\.openMainWindow\(\); \}\}>Open app<\/button>/);
  assert.doesNotMatch(source, /<WorkFoldLockup className="popover-brand"/);
  assert.match(source, /className="popover-new-chat"/);
  assert.match(source, /title="Start a new chat\. This chat stays saved on your desktop\."/);
  assert.match(source, />\s*<SquarePen aria-hidden="true" \/>\s*<span>New chat<\/span>/);
  assert.doesNotMatch(source, /popover-overflow-menu|aria-haspopup="menu"|Ellipsis|role="menuitem"/);
  assert.match(source, /startingNewChatRef\.current = true/);
  assert.match(source, /body\.newConversation = true/);
  assert.match(source, /previous chat is still saved on this desktop/);
  assert.match(source, /idlePollIntervalMs = 5_000/);
});
