import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = process.cwd();
const [app, tabBar, chatPanel, chatActions, messages, workTrail, activity, panes, settingsModal, chrome, styles, identity, modelDisplay, desktopMain, localServer, piClient, activityDot] = await Promise.all([
  read("web-local/src/App.tsx"),
  read("web-local/src/components/chat/WorkFolderSurfaceTabBar.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/components/chat/ChatActionsPopover.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/lib/chat-work-trail.ts"),
  read("web-local/src/components/chat/activity.tsx"),
  Promise.all([read("web-local/src/components/panes/workFolderPanes.tsx"), read("web-local/src/components/panes/AiModelsPane.tsx")]).then((sources) => sources.join("\n")),
  read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
  read("web-local/src/components/panes/workFolderChrome.tsx"),
  Promise.all([read("web-local/src/styles.css"), read("web-local/src/components/chat/work-steps.css")]).then((sources) => sources.join("\n")),
  read("web-local/src/lib/work-folder-identity.ts"),
  read("web-local/src/lib/model-display.ts"),
  read("desktop/src/main.ts"),
  read("src/local/server.ts"),
  read("src/local/agent/pi-client.ts"),
  read("web-local/src/components/chrome/ActivityDot.tsx"),
]);

test("mid-turn Enter steers the running turn; ⌘Enter queues one visible, cancellable draft that sends on settle", () => {
  // Plain Enter while a turn runs delivers the text through Pi's steering
  // queue (the agent reads it after its current step) and shows it as a
  // mid-turn user message; if the turn settles first (409) it becomes the
  // queued draft. ⌘/Ctrl+Enter holds the draft as a dashed queued bubble;
  // further Enters append; the queued draft fires through the ordinary send
  // path when the turn settles; Stop and the bubble's cancel return it to the
  // composer ahead of any newer text.
  assert.match(chatPanel, /void steerMessage\(content\);/);
  assert.match(chatPanel, /body: \{ content, delivery: "steer", requestId, userMessageId \}/);
  assert.match(chatPanel, /caught instanceof ApiError && caught\.status === 409/);
  assert.match(chatPanel, /event\.metaKey \|\| event\.ctrlKey \|\| pendingSendRef\.current \|\| fixtureMode/);
  assert.match(localServer, /body\.delivery === "steer"/);
  assert.match(localServer, /await client\.steer\(input\.content\);/);
  assert.match(chatPanel, /setQueuedSend\(\(current\) => \(current \? `\$\{current\}\\n\$\{content\}` : content\)\);/);
  assert.match(chatPanel, /if \(running \|\| workState\.work\?\.canStop \|\| !queuedSend \|\| lifecycleView !== "active"\) return;/);
  assert.match(chatPanel, /className="queued-send-row"/);
  assert.match(chatPanel, /aria-label="Cancel queued message"/);
  assert.match(chatPanel, /returnQueuedSendToComposer\(\);\s*\n\s*if \(pendingSendRef\.current\)/);
  assert.match(styles, /\.queued-send-bubble \{/);
});

test("the file tab previews bounded text, images, and PDFs inline through work-folder-policy routes", () => {
  // The preview endpoint reads a bounded head under the same path policy as
  // every entry route, declines binary and oversized content with a reason,
  // and images ride the existing same-origin raw-file route.
  assert.match(localServer, /file-preview\$\//);
  assert.match(localServer, /getWorkFolderFilePreview\(workFolder\.workFolderRoot, path\)/);
  const pane = readFileSyncLike("web-local/src/components/panes/FileDetailsPane.tsx");
  return pane.then((source) => {
    assert.match(source, /file-preview\?path=/);
    assert.match(source, /workFolderRawFileObjectUrl\(workFolder\.id, path, controller\.signal\)/);
    assert.match(source, /<iframe title=\{fileName\} src=\{`\$\{objectUrl\}\$\{pdfViewerParameters\}`\} \/>/);
    assert.match(source, /const pdfViewerParameters = "#toolbar=0&navpanes=0&view=FitH";/);
    assert.match(source, /<MarkdownMessage content=\{preview\.content\} \/>/);
    assert.match(source, /className="file-preview-text"/);
    assert.match(source, /Preview stops at 256 KB\./);
    assert.doesNotMatch(source, /label: "Created"|label: "Location"/, "the tab shows one quiet line of facts, not a metadata grid");
  }).then(() => readFileSyncLike("web-local/src/lib/raw-file.ts")).then((source) => {
    // A blob URL carries the session header and stays inside the renderer's
    // img-src/frame-src policy, which a direct local API URL would not.
    assert.match(source, /apiUrl\(`\/api\/work-folders\/\$\{workFolderId\}\/raw-file\?path=/);
    assert.match(source, /getSessionHeaders/);
    assert.match(source, /URL\.createObjectURL/);
  });
});

function readFileSyncLike(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

test("Files exposes folder creation and naming uses in-app UI", () => {
  // work-folder creation lives in the right-click menu (2026-10-01); Files has no toolbar buttons.
  assert.doesNotMatch(app, /aria-label="New folder"/);
  assert.match(app, /onNewFolder=\{requestNewFolder\}/);
  assert.match(app, /else if \(command === "new-folder"\) requestNewFolder\(entry\.path\);/);
  assert.doesNotMatch(app, /aria-label="New file"|onNewFile=/i);
  assert.doesNotMatch(`${app}\n${panes}`, /window\.prompt\s*\(/);
  assert.match(app, /<TextInputModal[^>]*title=\{`Rename/);
});

test("one work-folder menu trigger can create a Chat in every work-folder", () => {
  assert.equal((tabBar.match(/aria-label="Start a new Chat"/g) ?? []).length, 1);
  assert.match(tabBar, /menuWorkFolders\.map/);
  assert.match(tabBar, /onNewChatInWorkFolder\(targetWorkFolder\)/);
  assert.doesNotMatch(tabBar, /\bonNewChat:\s*\(\)\s*=>/);
  const tabBarCall = app.match(/<WorkFolderSurfaceTabBar[\s\S]*?\/>/)?.[0] ?? "";
  assert.doesNotMatch(tabBarCall, /newChatWorkFolderName=|onNewChat=\{/);
  assert.doesNotMatch(app, /fixtureConversations=\{[^}]*:\s*\[\]\s*\}/, "blank fixture tabs must not receive a fresh array on every render");
  assert.doesNotMatch(tabBar, /Keep each work-folder together|Applies when multiple work-folders are open/);
});

test("Chat work can be deferred, found again, and resumed without interrupting active turns", () => {
  // Snoozed and Archived are closed rows at the bottom (2026-10-01), not a
  // tab bar: active Chats lead, and deferred ones stay one click away.
  assert.doesNotMatch(panes, /role="tablist"\s+aria-label="Chat view"/);
  assert.match(panes, /\(\["snoozed", "archived"\] as const\)/);
  assert.match(panes, /className="chat-shelf-toggle"/);
  assert.match(panes, /aria-label="Snoozed and archived Chats"/);
  assert.match(panes, /aria-label=\{`Actions for \$\{chat\.title\}`\}/);
  assert.match(chatActions, />Snooze</);
  assert.match(chatActions, />Resume Now</);
  assert.match(chatActions, /Restore to Active/);
  assert.match(chatActions, /<strong>Delete<\/strong>/);
  assert.match(chatActions, /<small>Hide until a time you pick<\/small>/);
  assert.match(app, /onDelete=\{deleteChat\}/);
  assert.match(app, /Moved "\$\{chatDisplayTitle\(\{ serverTitle: conversation\.title \}\)\}" to Recently Deleted/);
  assert.match(app, /actionLabel:\s*"Undo"/);
  assert.match(localServer, /state\.runningTurns\.has\(key\)/);
  assert.match(app, /chatActivity\.setAttention/);
  assert.match(app, /hidden=\{!active\}/);
  assert.match(app, /<ChatPanel[\s\S]*?active=\{active\}/);
  assert.match(tabBar, /surface-tab-chat-status/);
  assert.match(panes, /status=\{status\} labeled/);
  // One shared activity mark (2026-10-01) labels the Chats list, the work-folder switcher, and Files.
  assert.match(panes, /import \{ ActivityDot \} from "\.\.\/chrome\/ActivityDot"/);
  assert.match(activityDot, /status === "running" \? "Working" : "New reply"/);
  assert.match(chatPanel, /onRunningChangeRef\.current/);
  assert.match(chatPanel, /reportChatSettled\(conversationId\)/);
});

test("Chats show the work-folders inside this one under its own Chats", () => {
  assert.match(panes, /folderTreeRows\(descendantFolders\(workFolder, workFolders\)\)/);
  assert.match(panes, /className="chat-nested-work-folder"/);
  assert.match(panes, /\.filter\(\(item\) => item\.id !== workFolder\.id && !nestedIds\.has\(item\.id\)\)/, "nested work-folders are not repeated under Other work-folders");
});

test("Chats foreground the active work-folder and collapse other work-folders until requested", () => {
  assert.match(panes, /const \[expandedOtherWorkFolderIds, setExpandedOtherWorkFolderIds\]/);
  assert.match(panes, /aria-label="Chats in other work-folders"/);
  assert.doesNotMatch(panes, /\.filter\(\(\{ list \}\) => list\.length > 0\)/);
  assert.match(panes, /aggregateChatActivityStatus\(item\.id, conversations\[item\.id\] \?\? \[\], activityStatuses\)/);
  assert.match(panes, /aria-label=\{`\$\{expanded \? "Hide" : "Show"\} chats in \$\{item\.name\}`\}/);
  assert.match(panes, /aria-expanded=\{expanded\}/);
  assert.match(panes, /const expanded = Boolean\(normalized\) \|\| expandedOtherWorkFolderIds\.has/);
  assert.match(panes, /onClick=\{\(\) => toggle\(setExpandedOtherWorkFolderIds, item\.id\)\}/);
  assert.match(panes, /aria-label=\{`New Chat in \$\{item\.name\}`\}/);
});

test("Other work-folder identity glyphs stay centered without decorative tiles", () => {
  assert.match(panes, /className="work-folder-identity-icon chat-other-work-folder-icon"/);
  const iconRule = styles.match(/\.chat-other-work-folder-icon\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(iconRule, /width:\s*18px/);
  assert.match(iconRule, /height:\s*18px/);
  assert.match(iconRule, /display:\s*grid/);
  assert.match(iconRule, /place-items:\s*center/);
  assert.match(iconRule, /background:\s*transparent/);
  assert.match(iconRule, /border:\s*0/);
  assert.match(iconRule, /box-shadow:\s*none/);
  assert.match(styles, /\.app-shell\[data-theme="dark"\] \.chat-other-work-folder-icon\s*\{[\s\S]*?background:\s*transparent/);
});

test("Chat titles flow from conversation metadata into tabs without tab labels mutating Chats", () => {
  assert.doesNotMatch(chatPanel, /targetConversationTitle/);
  assert.doesNotMatch(app, /targetConversationTitle=/);
  assert.match(app, /tabs\.syncSurfaceTabConversationTitles\(conversationGroups\)/);
  assert.match(panes, /aria-current=\{chat\.id === activeConversationId \? "page" : undefined\}/);
});

test("Chat and File selection use an immediate whole-row state without a leading stripe", () => {
  const chatShellRule = styles.match(/\.chat-work-folder-row-shell\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const activeChatRule = styles.match(/\.chat-work-folder-row-shell\.active\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const selectedFileRule = styles.match(/\.file-row\.selected\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.doesNotMatch(chatShellRule, /transition:/);
  for (const rule of [activeChatRule, selectedFileRule]) {
    assert.match(styles, /\.chat-work-folder-row-shell\.active[\s\S]*?work-folder-accent-soft-fill/);
    assert.match(styles, /\.file-row\.selected[\s\S]*?work-folder-accent-soft-fill/);
    assert.doesNotMatch(rule, /inset\s+[23]px\s+0\s+0/);
  }
  assert.match(styles, /\.chat-work-folder-row-shell:has\(> \.chat-work-folder-row:active\)/);
});

test("surface tab labels use crisp shell typography", () => {
  const tabMainRule = styles.match(/\.surface-tab-main\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const tabTitleRule = styles.match(/\.surface-tab-title\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(styles, /\.surface-tab-main\s*\{[\s\S]*?font-size:\s*\.8rem/);
  assert.match(styles, /\.surface-tab-main\s*\{[\s\S]*?font-weight:\s*500/);
  assert.match(tabMainRule, /line-height:\s*16px/);
  assert.match(tabTitleRule, /font:\s*inherit/);
  assert.match(tabTitleRule, /text-shadow:\s*none/);
  assert.doesNotMatch(`${tabMainRule}\n${tabTitleRule}`, /font-weight:\s*800/);
  assert.match(tabBar, /new ResizeObserver\(\(\) => revealActiveTab\(\)\)/);
  assert.match(tabBar, /surface-tabs-grouped/);
  assert.match(tabBar, /role="menuitemcheckbox"/);
});

test("assistant rendering has complete Markdown chrome and work-folder-aware accents", () => {
  for (const contract of ["message-code-toolbar", "message-table-scroll", "message-image", "work-folder-file-link"]) {
    assert.match(messages, new RegExp(contract));
    assert.match(styles, new RegExp(`\\.${contract}`));
  }
  const userRule = styles.match(/(?:^|\n)\.message\.user\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const userSurfaceRule = styles.match(/(?:^|\n)\.message\.user \.message-surface\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserSurfaceRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user \.message-surface\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  for (const rule of [userSurfaceRule, darkUserSurfaceRule]) {
    assert.match(
      rule,
      /background:\s*var\(--work-folder-accent-solid,\s*var\(--work-folder-custom-color,\s*var\(--work-fold-blue-600\)\)\)/,
    );
    assert.match(rule, /color:\s*var\(--work-folder-on-accent-solid,\s*var\(--work-folder-on-primary-accent/);
    assert.doesNotMatch(rule, /linear-gradient|work-folder-selection-accent2/);
  }
  for (const rule of [userRule, darkUserRule]) {
    assert.match(rule, /background:\s*transparent/);
    assert.match(rule, /box-shadow:\s*none/);
  }
  assert.match(messages, /<div className="message-surface">[\s\S]*?<\/div>\s*<footer className="message-footer">/);
  assert.match(styles, /\.message\.assistant \.message-footer\s*\{[^}]*justify-content:\s*flex-start/);
  const userInlineCodeRule = styles.match(/(?:^|\n)\.message\.user \.message-body code\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserInlineCodeRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user \.message-body code\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  for (const rule of [userInlineCodeRule, darkUserInlineCodeRule]) {
    assert.match(rule, /background:\s*transparent/, "inline code must not reduce the audited on-accent text contrast");
    assert.match(rule, /color:\s*inherit/);
  }
  const darkFencedCodeRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message-body \.message-code-block pre code\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(darkFencedCodeRule, /background:\s*transparent/, "dark fenced code must not inherit the inline-code highlight");
  assert.match(darkFencedCodeRule, /color:\s*inherit/);
  assert.match(chatPanel, /running \|\| requestBusy \? \(\s*<button className="send-button stop-send-button"/);
  assert.doesNotMatch(chatPanel, /chat-floating-actions|stop-chat-button/);
  assert.match(identity, /onPrimaryAccentColor:\s*readableTextColorOn\(colorOption\.color\)/);
  assert.match(identity, /"--work-folder-on-primary-accent":\s*identity\.onPrimaryAccentColor/);
  assert.doesNotMatch(`${messages}\n${chatPanel}\n${styles}`, /message-avatar/);
  assert.doesNotMatch(activity, /Learned From/);
});

test("provider interruptions stay visible and the configured model is disclosed before first send", () => {
  assert.match(chatPanel, /ConfiguredModel/);
  assert.match(chatPanel, /\/api\/agent\/status\?workFolderId=/);
  assert.match(chatPanel, /\/api\/agent\/composer\?scope=work-folder&workFolderId=/);
  assert.match(chatPanel, /setComposerState\(composerResult\.status === "fulfilled"/);
  assert.match(chatPanel, /loadMessages\(conversationId, false, \{ settleStreamingTurn: true \}\)/);
  assert.match(messages, /Response interrupted/);
  assert.match(messages, /work-fold preserved/);
  assert.match(messages, /Worker setup needed/);
  assert.match(messages, /Request stopped/);
  assert.match(messages, /savedWorkTrailPreviews\(message\)/);
  assert.match(workTrail, /message\.workTrail\?\.length/);
  assert.match(workTrail, /message\.interruption\?\.activities \?\? \[\]/);
  assert.match(workTrail, /saved-\$\{entry\.kind\}-\$\{message\.id\}-\$\{index\}/);
  assert.match(workTrail, /saved-tool-\$\{message\.id\}-\$\{index\}/);
  assert.doesNotMatch(chatPanel, /addAgentEvent/);
  assert.match(chatPanel, /modelStatus\?\.configured && conversationRuntime/);
  assert.match(chatPanel, /if \(!modelStatus \|\| !modelStatus\.configured\) \{[\s\S]*?setConversationRuntime\(null\)/);
  assert.match(styles, /\.turn-interruption/);
});

test("a new turn clears the prior idle stream snapshot before running becomes visible", () => {
  const sendMessage = chatPanel.match(/async function sendMessage\(contentOverride\?: string\) \{[\s\S]*?\n  async function steerMessage/)?.[0] ?? "";
  assert.match(sendMessage, /cancelStreamingFlush\(\);\s*\n\s*setStreamingAssistant\(""\);/);
  assert.ok(sendMessage.indexOf('setStreamingAssistant("");') < sendMessage.indexOf("setRunning(true);"));
  assert.match(chatPanel, /typeof data\.text === "string" && data\.running === true/);
  const admissionStart = localServer.match(/state\.runningTurns\.add\(turnKey\);[\s\S]*?const userMessageId/)?.[0] ?? "";
  assert.match(admissionStart, /state\.runningTurns\.add\(turnKey\);\s*\n[\s\S]*?resetChatEventTurn\(state, turnKey\);/);
  assert.doesNotMatch(admissionStart, /await /);
});

test("settlement prefers a persisted work trail over still-running live previews", () => {
  assert.match(chatPanel, /const hasPersistedWorkTrail = \[\.\.\.transcript\]\.reverse\(\)/);
  assert.match(chatPanel, /if \(!keepSettledTurnArtifacts \|\| hasPersistedWorkTrail\) \{\s*\n\s*clearRuntimePreviews\(\)/);
  assert.match(piClient, /const preserveActiveTurnTrail = this\.promptInFlight/);
  assert.match(piClient, /if \(!preserveActiveTurnTrail\) this\.resetTurnState\(\)/);
  assert.match(localServer, /const finalText = await client\.prompt[\s\S]*?capturedWorkTrail = client\.getTurnWorkTrail\(\);\s*\n\s*promptStarted = false;/);
});

test("Chat composer model and reasoning controls are truthful, scoped, and functional", () => {
  // The control names the actual provider model, never the product. Its
  // click opens an inline list of this work-folder's connected models that saves
  // through the same configure endpoint as Settings, and its last item opens
  // the agent page already scoped to this work-folder's model.
  assert.match(chatPanel, /runtime\.model\?\.name\s*\n\s*\?\? runtime\.model\?\.id/);
  assert.match(chatPanel, /displayModelLabel\(status\.provider \?\? "", status\.model \?\? ""\)/);
  assert.doesNotMatch(modelDisplay, /work-fold agent/i);
  assert.match(chatPanel, /`\/api\/agent\/models\?\$\{params\.toString\(\)\}`/);
  assert.match(chatPanel, /\.filter\(\(model\) => model\.authConfigured\)/);
  assert.match(chatPanel, /"\/api\/agent\/configure", \{\s*method: "POST",\s*body: \{ scope: "work-folder", workFolderId, provider: model\.provider, model: model\.id \}/);
  assert.match(chatPanel, /onOpenModelSettings\?\.\(\);\s*\}\}\s*>\s*Model settings/);
  assert.match(app, /onOpenModelSettings=\{\(\) => onOpenSettings\("ai-models", "work-folder", true, targetWorkFolder\.id\)\}/);
  assert.match(settingsModal, /initialScope=\{initialModelScope\} focusModelOnOpen=\{focusAiModel\}/);
  assert.match(panes, /<ModelCatalogList id="ai-model" labelledBy="ai-model-label"/);

  // Thinking is text-only and calls the real per-conversation endpoint. The
  // control appears only when the current model reports an actual choice.
  assert.doesNotMatch(chatPanel, /Brain(?:Circuit)?\d+(?:Filled|Regular)/);
  assert.match(chatPanel, /if \(levels\.length < 2\) return null;/);
  assert.match(chatPanel, /\/conversations\/\$\{conversationId\}\/thinking/);
  assert.match(chatPanel, /body: \{ level \}/);
  assert.match(chatPanel, /setConversationRuntime\(result\.runtime\)/);
  assert.match(chatPanel, /className="composer-thinking-label">\{thinkingLevelLabel\(state\.thinkingLevel\)\}/);
  assert.match(chatPanel, /conversationRuntime \?\? composerState/);
  assert.match(chatPanel, /"\/api\/agent\/thinking"/);
  assert.match(chatPanel, /body: \{ scope: "work-folder", workFolderId: workFolder\.id, level \}/);
  assert.doesNotMatch(chatPanel, /No extended reasoning|A brief think before answering|Balanced reasoning|Deeper reasoning/);
  assert.match(styles, /\.composer-thinking-trigger > span:first-child \{[\s\S]*?font: inherit;/);
  assert.match(styles, /\.conversation-context-meter \{[\s\S]*?font-family: inherit;[\s\S]*?font-size: 0\.7rem;[\s\S]*?font-weight: 700;/);
  assert.match(localServer, /await client\.setThinkingLevel\(body\.level\)/);
});

test("reasoning and real tool calls form one chronological steps strip", () => {
  // Rows keep the order events arrived in; the strip folds into a plain
  // summary once a native final reply is known; hidden reasoning keeps its duration.
  assert.match(activity, /entry\.kind === "thinking"/);
  assert.match(activity, /entry\.kind === "tool"/);
  assert.match(activity, /className="work-steps-summary"/);
  assert.match(activity, /Thinking…/);
  assert.match(activity, /Working…/);
  assert.match(activity, /Thought for \$\{formatDuration\(entry\.durationMs \?\? 0\)\}/);
  assert.match(activity, /className=\{`work-step-thought\$\{live \? " live" : ""\}`\}[\s\S]*?<ReactMarkdown/);
  assert.match(activity, /repairReasoningMarkdownArtifacts/);
  assert.match(activity, /node\.type === "text"/);
  assert.match(activity, /workFolderPathCandidate\(value\.slice\(root\.length \+ 1\)/);
  assert.match(chatPanel, /if \(data\.type === "tool"\)/);
  assert.match(chatPanel, /kind: "tool"/);
  assert.match(chatPanel, /replyStarted=\{liveTurnView\.hasFinal\}/);
  assert.match(chatPanel, /durationMs: Math\.max\(0, endedAt - entry\.startedAt\)/);
  assert.match(messages, /workFolderRoot=\{workFolderRoot\}/);
  assert.match(piClient, /event\.detail = previous\?\.detail \|\| event\.detail \|\| ""/);
  assert.match(piClient, /summarizeToolValue\(args\)/);
  assert.doesNotMatch(piClient, /summarizeToolValue\(args \?\? result\)/);
  assert.match(piClient, /\|\| \(entry\.durationMs \?\? 0\) > 0\)/);
  assert.doesNotMatch(activity, /Brain|["']THINKING["']|Working through the request|AgentActivityEvent/);
  assert.doesNotMatch(activity, /return "Complete"/);
  assert.doesNotMatch(chatPanel, /agent-activity-toggle|agent-activity-log|>Activity</);
  assert.doesNotMatch(chatPanel, /typing-line|working-message/);
  assert.match(styles, /\.work-step-thought \{[^}]*min-width: 0;/);
  assert.match(styles, /\.work-step-thought pre \{[^}]*white-space: pre-wrap;/);
  assert.match(styles, /\.work-steps\.settled:not\(\.open\) \.work-steps-rows \{[^}]*grid-template-rows: 0fr;/);
  assert.doesNotMatch(styles, /\.runtime-preview|\.runtime-tool-|\.runtime-thinking|\.typing-line/);
});

test("manual restore points distinguish a new snapshot from already-covered files", () => {
  assert.match(localServer, /const created = !existingIds\.has\(checkpoint\.checkpointId\)/);
  assert.match(panes, /Current files already match the latest restore point\./);
  assert.match(app, /Current files already match the latest restore point/);
});

test("user actions retain semantic footer structure; the real cascade is exercised in application-appearance-surfaces", () => {
  assert.match(messages, /<div className="message-surface">[\s\S]*?<MarkdownMessage[\s\S]*?<\/div>\s*<footer className="message-footer">[\s\S]*?<MessageActions/);
  assert.doesNotMatch(`${messages}\n${chatPanel}`, /message-author|>You<|workerName/);
  const messageActionsSource = messages.match(/export function MessageActions[\s\S]*?(?=\nexport function TurnLanding)/)?.[0] ?? "";
  assert.doesNotMatch(messageActionsSource, /<span>\{copied \? "Copied" : "Copy"\}<\/span>/);
});

test("audited desktop and pane controls have working destinations", () => {
  assert.match(chrome, /switchable = true/);
  assert.doesNotMatch(chrome, /workFolders\.length > 1/);
  assert.match(desktopMain, /About \$\{productName\}[\s\S]*?sendRendererMenuCommand\("open-about"\)/);
  assert.doesNotMatch(desktopMain, /About \$\{productName\}[^\n]*enabled:\s*false/);
  assert.doesNotMatch(panes, /onDoubleClick=\{\(\) => onOpen\?\.\(item\)\}/);
  assert.match(panes, /onClick=\{\(\)=>onOpen \? onOpen\(item\) : void restore\(item\)\}/);
  assert.match(app, /tab\.kind === "history" \? \(\s*<HistoryPane/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
