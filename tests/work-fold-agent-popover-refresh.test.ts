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
  assert.match(source, /api<\{ messages: WorkFoldAgentMessage\[\] \}>\(`\/api\/work-fold-agent\/conversations\/\$\{encodeURIComponent\(nextConversationId\)\}`\)/);
  assert.match(source, /messages\.map\(\(message\) =>/);
  assert.match(source, /message\.role === "assistant"[\s\S]*?<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>\{message\.content\}<\/ReactMarkdown>/);
  assert.doesNotMatch(source, /\{request\.reply\.content\}/);
});

test("the popover keeps the conversation and composer visible without idle chrome", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The transcript is an ordinary always-visible chat surface instead of a
  // Conversation disclosure.
  assert.match(popover, /<section className="agent-section agent-section-conversation">\s*<section\s*className="popover-transcript"/);
  assert.doesNotMatch(popover, />Conversation<\/span>/);
  assert.doesNotMatch(popover, /conversationExists|aria-controls="popover-conversation"/);
  // Idle status and overview chrome are absent from the compact menu-bar view.
  assert.doesNotMatch(popover, /popover-foot|All quiet|What's new|useOverview\("popover"/);
  assert.doesNotMatch(popover, /Drop files, folders, or links here/);
  // The composer keeps its shipped drop-staging and two-state capture verb
  // (pinned exactly in work-fold-brand.test.ts), and takes focus first in the
  // quiet state without stealing it from anything the person focused.
  assert.match(popover, /const focusComposerFirst = \(\) => \{/);
  assert.match(popover, /if \(current && activePhases\.has\(current\.phase\)\) return;/);
  assert.match(popover, /if \(active && active !== document\.body && active !== document\.documentElement\) return;/);
  assert.match(popover, /composerRef\.current\?\.focus\(\);/);
  assert.match(popover, /window\.addEventListener\("focus", focusComposerFirst\)/);
  assert.match(popover, /document\.addEventListener\("visibilitychange", focusComposerFirst\)/);
});

test("the popover has no decision surface", async () => {
  // Needs you means questions (docs/receipts-not-gates.md, F24): the popover
  // renders the conversation and the composer, never a decision card, and the
  // preloads expose no decision helpers.
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const mainPreload = await readFile(resolve(rootDir, "desktop/src/preload.cts"), "utf8");
  const popoverPreload = await readFile(resolve(rootDir, "desktop/src/work-fold-agent-popover-preload.cts"), "utf8");
  const main = await readFile(resolve(rootDir, "desktop/src/main.ts"), "utf8");
  assert.doesNotMatch(popover, /NeedsYou|useNeedsYouDecisions|decisionCount|decisionsOpen|fold-strip-decisions|popover-decisions|\/api\/work-fold-agent\/decisions/);
  assert.doesNotMatch(mainPreload, /decisions|choose-file-grant-root|chooseFileGrantRoot/);
  assert.doesNotMatch(popoverPreload, /decisions|choose-file-grant-root|chooseFileGrantRoot/);
  assert.doesNotMatch(main, /work-fold:decisions:|choose-file-grant-root/);
  assert.match(mainPreload, /enable: \(automationId: string\) => ipcRenderer\.invoke\("work-fold:automations:enable", automationId\)/);
});

test("the popover accounts for every attachment outcome", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The host-recorded trail renders all three recorded outcomes.
  assert.match(popover, /"placed" \| "registered" \| "unrecorded"/);
  assert.match(popover, /no recorded placement — see the reply below/);
});

test("the work-fold agent streams its steps and keeps one compact line for delegated work", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // The working line follows the always-visible transcript while a request is
  // active without taking a second status panel's worth of vertical work-folder.
  const drawerStart = popover.indexOf('id="popover-conversation"');
  const drawerEnd = popover.indexOf('className="agent-tail"');
  assert.ok(drawerStart >= 0 && drawerEnd > drawerStart, "the conversation drawer precedes the live tail");
  assert.match(popover, /\{request && activePhases\.has\(request\.phase\) \? \(\s*<div className="agent-tail">/);
  // The agent's own turn shows its thinking and tool steps the way a Worker's Chat does.
  assert.match(popover, /<RuntimeContextPreview entries=\{liveSteps\} running=\{request\?\.phase === "working"\} replyStarted=\{Boolean\(streamingAssistant\)\}/);
  assert.match(popover, /<RuntimeContextPreview entries=\{savedWorkTrailPreviews\(message as ChatMessage\)\}/);
  assert.match(popover, /<span className="working-elapsed">\{elapsedLabel\}<\/span>/);
  assert.match(popover, /Working in \{request\.children\.filter\(\(child\) => child\.state === "running"\)\.length === 1 \? "a work-folder" : "work-folders"\}…/);
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
  const handedOffTrail = popover.search(/request\.phase === "handed_off" && !workState\.work \? \(\s*<article className="popover-entry">/);
  const resultEntry = popover.indexOf("<ResultEntry request={request} showState={!workState.work} />");
  assert.ok(handedOffTrail > drawerStart && handedOffTrail < drawerEnd, "the handed-off trail is a conversation entry");
  assert.ok(resultEntry > handedOffTrail && resultEntry < drawerEnd, "the settled result is a conversation entry");
  assert.match(popover, /\{child\.workFolderName\}: \{childStateLabel\(child\.state\)\}/);
  assert.match(popover, /Couldn't finish\{request\.error \? `: \$\{request\.error\}` : "\."\}/);
  assert.match(popover, /Stopped before it finished\./);
  // The header carries no redundant phase badge: the live status line and the
  // in-composer Stop action communicate the running state without crowding it.
  assert.doesNotMatch(popover, /PhasePill|pill-working/);
});

test("the popover renders the live agent response and reconciles the durable transcript", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  // Reconnect snapshots replace the transient projection, deltas are batched
  // to an animation frame, and the authoritative final message replaces it.
  assert.match(popover, /event\.type === "turn_snapshot" && typeof event\.text === "string"[\s\S]*replaceStreamingAssistant\(event\.text\)/);
  assert.match(popover, /event\.type === "assistant_delta" && typeof event\.text === "string"[\s\S]*queueStreamingAssistant\(event\.text\)/);
  assert.match(popover, /event\.type === "assistant_message" && typeof event\.text === "string"[\s\S]*replaceStreamingAssistant\(event\.text\)/);
  assert.match(popover, /window\.requestAnimationFrame\(flushStreamingAssistant\)/);
  assert.match(popover, /className="popover-message assistant streaming" aria-label="work-fold is replying"/);
  assert.match(popover, /<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>\{streamingAssistant\}<\/ReactMarkdown>/);
  assert.match(popover, /if \(!summary\.latestRequest \|\| !activePhases\.has\(summary\.latestRequest\.phase\)\) \{\s*replaceStreamingAssistant\(""\);/);
});

test("the compact popover leaves the overview to the main window and approved web clients", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.doesNotMatch(popover, /OverviewSection|useOverview|refreshOverview|popover-overview|What's new|All quiet/);
  assert.doesNotMatch(popover, /\/api\/work-fold-agent\/overview/);
});

test("Escape still hides the popover and the work-fold agent region stays live", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(popover, /aria-label="work-fold agent chat" aria-live="polite"/);
  assert.match(popover, /if \(event\.key === "Escape"\) \{[\s\S]*?else bridge\?\.workFoldAgent\?\.hide\(\);/);
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
  // The compact circular action lives in the centered model/reasoning row.
  assert.match(popover, /className="composer-field"[\s\S]*rows=\{1\}[\s\S]*className=\{`composer-action\$\{requestRunning \? " composer-stop" : " primary"\}`\}/);
  assert.match(css, /\.composer-controls \{[\s\S]*align-items: center;/);
  assert.match(css, /\.composer-action \{[\s\S]*width: 28px;[\s\S]*height: 28px;/);
  assert.doesNotMatch(css, /\.composer-action \{[\s\S]*position: absolute;/);
  assert.doesNotMatch(popover, /composer-footer/);
  // The same action becomes Stop while work is active; the composer remains
  // mounted as a safe draft area and sending is refused until the turn settles.
  assert.match(popover, /if \(requestRunning\) void stop\(\); else void send\(\);/);
  assert.match(popover, /aria-label=\{requestRunning \? \(stopping \? "Stopping" : "Stop"\)/);
  assert.match(popover, /if \(!content \|\| sending \|\| loadingChat \|\| stopping \|\| \(currentRequest && activePhases\.has\(currentRequest\.phase\)\)\) return;/);
  // The transcript follows new entries only while pinned near the bottom, so
  // reading scrollback is never yanked away by the poll cadence — and a
  // refetch that changes nothing keeps the old array identity.
  assert.match(popover, /transcriptPinnedRef/);
  assert.match(popover, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?transcript\.scrollTop = transcript\.scrollHeight/);
  assert.match(popover, /\[messages, phase, streamingAssistant, activity, liveSteps, conversationId\]/);
  assert.match(popover, /sameTranscript\(current, next\) \? current : next/);
  // Staged chips render outside the composer conditional so a mid-turn drop
  // is confirmed on screen instead of surfacing after the turn settles.
  const chips = popover.indexOf('className="chips"');
  const composer = popover.indexOf('className="agent-composer"');
  assert.ok(chips >= 0 && composer > chips, "the chips list renders before (outside) the composer section");
  // The whole surface becomes the drop target only during an actual drag;
  // there is no permanent instructional row in the composer.
  assert.match(popover, /onDragEnter=\{onDragEnter\}/);
  assert.match(popover, /dragDepthRef\.current \+= 1/);
  assert.match(popover, /\{dropActive \? \(\s*<div className="drop-overlay" role="status" aria-live="polite">/);
  assert.match(popover, />Drop to add<\/strong>/);
  assert.match(css, /\.drop-overlay \{[\s\S]*position: fixed;[\s\S]*inset: 6px;[\s\S]*pointer-events: none;/);
  assert.doesNotMatch(popover, /className="drop-hint"/);
  // Background work remains reachable when navigating to another Chat.
  assert.match(popover, /className="agent-background-work"/);
});

test("the fold composer names its model and exposes real text-only reasoning controls", async () => {
  const popover = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  const preload = await readFile(resolve(rootDir, "desktop/src/work-fold-agent-popover-preload.cts"), "utf8");
  const main = await readFile(resolve(rootDir, "desktop/src/main.ts"), "utf8");

  assert.match(popover, /\/api\/agent\/composer\?scope=agent/);
  assert.match(popover, /setWorkFoldAgentComposer\(result\.composer\)/);
  assert.match(popover, /bridge\?\.workFoldAgent\?\.openAiModelsSettings\(\)/);
  assert.match(preload, /openAiModelsSettings: \(\) => ipcRenderer\.invoke\("work-fold:agent:open-ai-models-settings"\)/);
  assert.match(main, /mainWindow\?\.webContents\.send\("work-fold:agent:open-settings", "agent"\)/);

  assert.doesNotMatch(popover, /Brain(?:Circuit)?\d+(?:Filled|Regular)/);
  assert.match(popover, /thinkingLevels\.length >= 2 && composerThinking/);
  assert.match(popover, /\/api\/work-fold-agent\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/thinking/);
  assert.match(popover, /"\/api\/agent\/thinking"/);
  assert.match(popover, /body: \{ scope: "agent", level \}/);
  assert.match(popover, /body: \{ level \}/);
  assert.match(popover, /setConversationRuntime\(result\.runtime\)/);
  const css = await readFile(resolve(rootDir, "web-local/src/popover/popover.css"), "utf8");
  assert.match(css, /\.composer-thinking \{\s*flex: none;[\s\S]*?field-sizing: content;[\s\S]*?\}/);
  assert.match(css, /\.composer-thinking \{\s*flex: none;[\s\S]*?padding: 1px 14px 1px 6px;/);
});

test("the header exposes the active chat title and New chat directly", async () => {
  const source = await readFile(resolve(rootDir, "web-local/src/popover/PopoverApp.tsx"), "utf8");
  assert.match(source, /<h1 className="popover-chat-title">\{chatTitle\}<\/h1>/);
  assert.doesNotMatch(source, /<WorkFoldLockup className="popover-brand"/);
  assert.match(source, /className="popover-new-chat"/);
  assert.match(source, /aria-label="New Chat"/);
  assert.match(source, />\s*<SquarePen aria-hidden="true" \/>\s*<span>New Chat<\/span>/);
  assert.doesNotMatch(source, /popover-overflow-menu|aria-haspopup="menu"|Ellipsis|role="menuitem"/);
  assert.match(source, /startingNewChatRef\.current = id === null/);
  assert.match(source, /body\.newConversation = true/);
  assert.doesNotMatch(source, /setBanner\("New chat ready/);
  assert.match(source, /idlePollIntervalMs = 5_000/);
});
