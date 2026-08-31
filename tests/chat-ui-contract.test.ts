import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = process.cwd();
const [app, tabBar, chatPanel, chatActions, messages, activity, panes, chrome, styles, identity, desktopMain, localServer] = await Promise.all([
  read("web-local/src/App.tsx"),
  read("web-local/src/components/chat/SpaceSurfaceTabBar.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/components/chat/ChatActionsPopover.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/chat/activity.tsx"),
  read("web-local/src/components/panes/spacePanes.tsx"),
  read("web-local/src/components/panes/spaceChrome.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/lib/space-identity.ts"),
  read("desktop/src/main.ts"),
  read("src/local/server.ts"),
]);

test("mid-turn Enter steers the running turn; ⌘Enter queues one visible, cancellable draft that sends on settle", () => {
  // Plain Enter while a turn runs delivers the text through Pi's steering
  // queue (the Assistant reads it after its current step) and shows it as a
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
  assert.match(chatPanel, /if \(running \|\| !queuedSend \|\| lifecycleView !== "active"\) return;/);
  assert.match(chatPanel, /className="queued-send-row"/);
  assert.match(chatPanel, /aria-label="Cancel queued message"/);
  assert.match(chatPanel, /returnQueuedSendToComposer\(\);\s*\n\s*addAgentEvent\(\{ message: "Stopping the Assistant"/);
  assert.match(styles, /\.queued-send-bubble \{/);
});

test("the file tab previews bounded text and images inline through Space-policy routes", () => {
  // The preview endpoint reads a bounded head under the same path policy as
  // every entry route, declines binary and oversized content with a reason,
  // and images ride the existing same-origin raw-file route.
  assert.match(localServer, /file-preview\$\//);
  assert.match(localServer, /getSpaceFilePreview\(space\.spaceRoot, path\)/);
  const pane = readFileSyncLike("web-local/src/components/panes/FileDetailsPane.tsx");
  return pane.then((source) => {
    assert.match(source, /file-preview\?path=/);
    assert.match(source, /apiUrl\(`\/api\/spaces\/\$\{space\.id\}\/raw-file\?path=/);
    assert.match(source, /className="file-preview-text"/);
    assert.match(source, /Preview stops at 256 KB\./);
  });
});

function readFileSyncLike(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

test("Files removes unsupported create controls and naming uses in-app UI", () => {
  assert.doesNotMatch(app, /aria-label="New (?:file|folder)"/i);
  assert.doesNotMatch(app, /onNewFolder=|onNewFile=/);
  assert.doesNotMatch(`${app}\n${panes}`, /window\.prompt\s*\(/);
  assert.match(app, /<TextInputModal[^>]*title=\{`Rename/);
  assert.match(panes, /<TextInputModal[^>]*title="New Library folder"/);
});

test("one Space menu trigger can create a Chat in every Space", () => {
  assert.equal((tabBar.match(/aria-label="Start a new Chat"/g) ?? []).length, 1);
  assert.match(tabBar, /menuSpaces\.map/);
  assert.match(tabBar, /onNewChatInSpace\(targetSpace\)/);
  assert.doesNotMatch(tabBar, /\bonNewChat:\s*\(\)\s*=>/);
  const tabBarCall = app.match(/<SpaceSurfaceTabBar[\s\S]*?\/>/)?.[0] ?? "";
  assert.doesNotMatch(tabBarCall, /newChatSpaceName=|onNewChat=\{/);
  assert.doesNotMatch(app, /fixtureConversations=\{[^}]*:\s*\[\]\s*\}/, "blank fixture tabs must not receive a fresh array on every render");
});

test("Chat work can be deferred, found again, and resumed without interrupting active turns", () => {
  for (const view of ["active", "snoozed", "archived"]) {
    assert.match(panes, new RegExp(`"${view}"`));
  }
  assert.match(panes, /role="tablist"\s+aria-label="Chat view"/);
  assert.match(panes, /aria-label=\{`Actions for \$\{chat\.title\}`\}/);
  assert.match(chatActions, />Snooze</);
  assert.match(chatActions, />Resume now</);
  assert.match(chatActions, /Restore to Active/);
  assert.match(app, /actionLabel:\s*"Undo"/);
  assert.match(localServer, /state\.runningTurns\.has\(key\)/);
  assert.match(app, /chatActivity\.setAttention/);
  assert.match(app, /hidden=\{!active\}/);
  assert.match(app, /<ChatPanel[\s\S]*?active=\{active\}/);
  assert.match(tabBar, /surface-tab-chat-status/);
  assert.match(panes, /status=\{status\} labeled/);
  assert.match(panes, /status === "running" \? "Working" : "New reply"/);
  assert.match(chatPanel, /onRunningChangeRef\.current/);
  assert.match(chatPanel, /reportChatSettled\(conversationId\)/);
});

test("Chats foreground the active Space and collapse other Spaces until requested", () => {
  assert.match(panes, /const \[expandedOtherSpaceIds, setExpandedOtherSpaceIds\]/);
  assert.match(panes, /<span>Other Spaces<\/span>/);
  assert.doesNotMatch(panes, /\.filter\(\(\{ list \}\) => list\.length > 0\)/);
  assert.match(panes, /<small>\{list\.length\}<\/small>/);
  assert.match(panes, /aggregateChatActivityStatus\(item\.id, conversations\[item\.id\] \?\? \[\], activityStatuses\)/);
  assert.match(panes, /aria-label=\{`\$\{expanded \? "Hide" : "Show"\} chats in \$\{item\.name\}`\}/);
  assert.match(panes, /aria-expanded=\{expanded\}/);
  assert.match(panes, /const expanded = Boolean\(normalized\) \|\| expandedOtherSpaceIds\.has/);
  assert.match(panes, /onClick=\{\(\) => toggleOtherSpace\(item\.id\)\}/);
  assert.match(panes, /aria-label=\{`New Chat in \$\{item\.name\}`\}/);
});

test("Other Space identity glyphs stay centered without decorative tiles", () => {
  assert.match(panes, /className="space-identity-icon chat-other-space-icon"/);
  const iconRule = styles.match(/\.chat-other-space-icon\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(iconRule, /width:\s*18px/);
  assert.match(iconRule, /height:\s*18px/);
  assert.match(iconRule, /display:\s*grid/);
  assert.match(iconRule, /place-items:\s*center/);
  assert.match(iconRule, /background:\s*transparent/);
  assert.match(iconRule, /border:\s*0/);
  assert.match(iconRule, /box-shadow:\s*none/);
  assert.match(styles, /\.app-shell\[data-theme="dark"\] \.chat-other-space-icon\s*\{[\s\S]*?background:\s*transparent/);
});

test("Chat titles flow from conversation metadata into tabs without tab labels mutating Chats", () => {
  assert.doesNotMatch(chatPanel, /targetConversationTitle/);
  assert.doesNotMatch(app, /targetConversationTitle=/);
  assert.match(app, /tabs\.syncSurfaceTabConversationTitles\(conversationGroups\)/);
  assert.match(panes, /aria-current=\{chat\.id === activeConversationId \? "page" : undefined\}/);
});

test("Chat and File selection use an immediate whole-row state without a leading stripe", () => {
  const chatShellRule = styles.match(/\.chat-space-row-shell\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const activeChatRule = styles.match(/\.chat-space-row-shell\.active\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const selectedFileRule = styles.match(/\.file-row\.selected\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.doesNotMatch(chatShellRule, /transition:/);
  for (const rule of [activeChatRule, selectedFileRule]) {
    assert.match(rule, /space-accent-soft-fill/);
    assert.doesNotMatch(rule, /inset\s+[23]px\s+0\s+0/);
  }
  assert.match(styles, /\.chat-space-row-shell:has\(> \.chat-space-row:active\)/);
});

test("surface tab labels use crisp shell typography", () => {
  const tabMainRule = styles.match(/\.surface-tab-main\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const tabTitleRule = styles.match(/\.surface-tab-title\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(tabMainRule, /font-size:\s*13px/);
  assert.match(tabMainRule, /font-weight:\s*600/);
  assert.match(tabMainRule, /line-height:\s*16px/);
  assert.match(tabTitleRule, /font:\s*inherit/);
  assert.match(tabTitleRule, /text-shadow:\s*none/);
  assert.doesNotMatch(`${tabMainRule}\n${tabTitleRule}`, /font-weight:\s*800/);
  assert.match(tabBar, /new ResizeObserver\(\(\) => revealActiveTab\(\)\)/);
  assert.match(tabBar, /surface-tabs-grouped/);
  assert.match(tabBar, /role="menuitemcheckbox"/);
});

test("assistant rendering has complete Markdown chrome and Space-aware accents", () => {
  for (const contract of ["message-code-toolbar", "message-table-scroll", "message-image", "space-file-link"]) {
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
      /background:\s*var\(--space-accent-solid,\s*var\(--space-custom-color,\s*var\(--work-fold-blue-600\)\)\)/,
    );
    assert.match(rule, /color:\s*var\(--space-on-accent-solid,\s*var\(--space-on-primary-accent/);
    assert.doesNotMatch(rule, /linear-gradient|space-selection-accent2/);
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
  assert.match(chatPanel, /running \? \(\s*<button className="send-button stop-send-button"/);
  assert.doesNotMatch(chatPanel, /chat-floating-actions|stop-chat-button/);
  assert.match(identity, /onPrimaryAccentColor:\s*readableTextColorOn\(colorOption\.color\)/);
  assert.match(identity, /"--space-on-primary-accent":\s*identity\.onPrimaryAccentColor/);
  assert.doesNotMatch(`${messages}\n${chatPanel}\n${styles}`, /message-avatar/);
  assert.doesNotMatch(activity, /Learned From/);
});

test("provider interruptions stay visible and the configured model is disclosed before first send", () => {
  assert.match(chatPanel, /ConfiguredAssistantModel/);
  assert.match(chatPanel, /\/api\/agent\/status\?spaceId=/);
  assert.match(chatPanel, /loadMessages\(conversationId, false, \{ settleStreamingTurn: true \}\)/);
  assert.match(messages, /Response interrupted/);
  assert.match(messages, /work-fold preserved/);
  assert.match(messages, /Assistant setup needed/);
  assert.match(messages, /Request stopped/);
  assert.match(messages, /interruption\.activities/);
  assert.match(chatPanel, /data\.message !== "Connected\."/);
  assert.match(chatPanel, /configuredAssistant\?\.configured && conversationRuntime/);
  assert.match(chatPanel, /if \(!configuredAssistant \|\| !configuredAssistant\.configured\) \{[\s\S]*?setConversationRuntime\(null\)/);
  assert.match(styles, /\.turn-interruption/);
});

test("manual restore points distinguish a new snapshot from already-covered files", () => {
  assert.match(localServer, /const created = !existingIds\.has\(checkpoint\.checkpointId\)/);
  assert.match(panes, /Current files already match the latest restore point\./);
  assert.match(app, /Current files already match the latest restore point/);
});

test("dark user messages keep their audited foregrounds and quiet icon-only action", () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <head><style>${styles}</style></head>
      <body>
        <div class="app-shell" data-theme="dark">
          <main style="--space-accent-solid:#fafafa;--space-on-accent-solid:#182846;--space-on-accent-muted:#4e5a71">
            <article class="message user">
              <div class="message-surface">
                <div class="message-body">
                  <p>Plain text</p>
                  <h1>Heading</h1>
                </div>
              </div>
              <footer class="message-footer">
                <span class="message-footer-meta">
                  <time class="message-time">now</time>
                  <div class="message-actions">
                    <button class="message-copy-button" aria-label="Copy message"></button>
                  </div>
                </span>
              </footer>
            </article>
          </main>
        </div>
      </body>
    </html>
  `, { pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;
  const styleFor = (selector: string) => window.getComputedStyle(document.querySelector(selector)!);

  for (const selector of [".message.user .message-surface", ".message.user .message-body", ".message.user .message-body p", ".message.user .message-body h1"]) {
    assert.match(
      styleFor(selector).color,
      /--space-on-accent-solid/,
      `${selector} must retain the foreground audited against the user bubble`,
    );
  }
  for (const selector of [".message.user .message-time", ".message.user .message-copy-button"]) {
    assert.equal(styleFor(selector).color, "rgb(148, 163, 184)", `${selector} must sit neutrally below the bubble`);
  }

  const copyStyle = styleFor(".message.user .message-copy-button");
  assert.equal(copyStyle.width, "24px");
  assert.equal(copyStyle.height, "24px");
  assert.equal(copyStyle.opacity, "0.42");
  assert.equal(copyStyle.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.match(messages, /<div className="message-surface">[\s\S]*?<MarkdownMessage[\s\S]*?<\/div>\s*<footer className="message-footer">[\s\S]*?<MessageActions/);
  assert.doesNotMatch(`${messages}\n${chatPanel}`, /message-author|>You<|assistantName/);
  const messageActionsSource = messages.match(/export function MessageActions[\s\S]*?(?=\nexport function TurnLanding)/)?.[0] ?? "";
  assert.doesNotMatch(messageActionsSource, /<span>\{copied \? "Copied" : "Copy"\}<\/span>/);
});

test("audited desktop and pane controls have working destinations", () => {
  assert.match(chrome, /switchable = true/);
  assert.doesNotMatch(chrome, /spaces\.length > 1/);
  assert.match(desktopMain, /About \$\{productName\}[\s\S]*?sendRendererMenuCommand\("open-about"\)/);
  assert.doesNotMatch(desktopMain, /About \$\{productName\}[^\n]*enabled:\s*false/);
  assert.doesNotMatch(panes, /onDoubleClick=\{\(\) => onOpen\?\.\(item\)\}/);
  assert.match(panes, /onOpen \? <button[\s\S]*?>Open<\/button> : null/);
  assert.match(app, /tab\.kind === "history" \? \(\s*<HistoryPane/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
