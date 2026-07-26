import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = process.cwd();
const [app, tabBar, chatPanel, chatActions, messages, activity, panes, chrome, styles, identity, desktopMain, localServer] = await Promise.all([
  read("web-local/src/App.tsx"),
  read("web-local/src/components/chat/WorkspaceSurfaceTabBar.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/components/chat/ChatActionsPopover.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/chat/activity.tsx"),
  read("web-local/src/components/panes/workspacePanes.tsx"),
  read("web-local/src/components/panes/workspaceChrome.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/lib/workspace-identity.ts"),
  read("desktop/src/main.ts"),
  read("src/local/server.ts"),
]);

test("Files removes unsupported create controls and naming uses in-app UI", () => {
  assert.doesNotMatch(app, /aria-label="New (?:file|folder)"/i);
  assert.doesNotMatch(app, /onNewFolder=|onNewFile=/);
  assert.doesNotMatch(`${app}\n${panes}`, /window\.prompt\s*\(/);
  assert.match(app, /<TextInputModal[^>]*title=\{`Rename/);
  assert.match(panes, /<TextInputModal[^>]*title="New Library folder"/);
});

test("one Space menu trigger can create a Chat in every Space", () => {
  assert.equal((tabBar.match(/aria-label="Start a new Chat"/g) ?? []).length, 1);
  assert.match(tabBar, /menuWorkspaces\.map/);
  assert.match(tabBar, /onNewChatInWorkspace\(targetWorkspace\)/);
  assert.doesNotMatch(tabBar, /\bonNewChat:\s*\(\)\s*=>/);
  const tabBarCall = app.match(/<WorkspaceSurfaceTabBar[\s\S]*?\/>/)?.[0] ?? "";
  assert.doesNotMatch(tabBarCall, /newChatWorkspaceName=|onNewChat=\{/);
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
  assert.match(tabBar, /surface-tab-chat-status/);
  assert.match(chatPanel, /onRunningChangeRef\.current/);
  assert.match(chatPanel, /reportChatSettled\(conversationId\)/);
});

test("Chats foreground the active Space and collapse other Spaces until requested", () => {
  assert.match(panes, /const \[expandedOtherWorkspaceIds, setExpandedOtherWorkspaceIds\]/);
  assert.match(panes, /<span>Other Spaces<\/span>/);
  assert.match(panes, /aria-label=\{`\$\{expanded \? "Hide" : "Show"\} chats in \$\{item\.name\}`\}/);
  assert.match(panes, /aria-expanded=\{expanded\}/);
  assert.match(panes, /const expanded = Boolean\(normalized\) \|\| expandedOtherWorkspaceIds\.has/);
  assert.match(panes, /onClick=\{\(\) => toggleOtherWorkspace\(item\.id\)\}/);
  assert.match(panes, /aria-label=\{`New Chat in \$\{item\.name\}`\}/);
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
});

test("assistant rendering has complete Markdown chrome and Space-aware accents", () => {
  for (const contract of ["message-code-toolbar", "message-table-scroll", "message-image", "workspace-file-link"]) {
    assert.match(messages, new RegExp(contract));
    assert.match(styles, new RegExp(`\\.${contract}`));
  }
  const userRule = styles.match(/(?:^|\n)\.message\.user\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  for (const rule of [userRule, darkUserRule]) {
    assert.match(
      rule,
      /background:\s*var\(--workspace-accent-solid,\s*var\(--workspace-custom-color,\s*var\(--workspace-blue-600\)\)\)/,
    );
    assert.match(rule, /color:\s*var\(--workspace-on-accent-solid,\s*var\(--workspace-on-primary-accent/);
    assert.doesNotMatch(rule, /linear-gradient|workspace-selection-accent2/);
  }
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
  assert.match(identity, /"--workspace-on-primary-accent":\s*identity\.onPrimaryAccentColor/);
  assert.doesNotMatch(`${messages}\n${chatPanel}\n${styles}`, /message-avatar/);
  assert.doesNotMatch(activity, /Learned From/);
});

test("dark user messages keep their audited foregrounds and quiet icon-only action", () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <head><style>${styles}</style></head>
      <body>
        <div class="app-shell" data-theme="dark">
          <main style="--workspace-accent-solid:#fafafa;--workspace-on-accent-solid:#182846;--workspace-on-accent-muted:#4e5a71">
            <article class="message user">
              <div class="message-header">
                <span class="message-author">You</span>
                <span class="message-header-actions">
                  <time class="message-time">now</time>
                  <div class="message-actions">
                    <button class="message-copy-button" aria-label="Copy message"></button>
                  </div>
                </span>
              </div>
              <div class="message-body">
                <p>Plain text</p>
                <h1>Heading</h1>
              </div>
            </article>
          </main>
        </div>
      </body>
    </html>
  `, { pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;
  const styleFor = (selector: string) => window.getComputedStyle(document.querySelector(selector)!);

  for (const selector of [".message.user", ".message.user .message-body", ".message.user .message-body p", ".message.user .message-body h1"]) {
    assert.match(
      styleFor(selector).color,
      /--workspace-on-accent-solid/,
      `${selector} must retain the foreground audited against the user bubble`,
    );
  }
  for (const selector of [".message.user .message-author", ".message.user .message-time", ".message.user .message-copy-button"]) {
    assert.match(
      styleFor(selector).color,
      /--workspace-on-accent-muted/,
      `${selector} must use the muted on-solid role`,
    );
  }

  const copyStyle = styleFor(".message.user .message-copy-button");
  assert.equal(copyStyle.width, "24px");
  assert.equal(copyStyle.height, "24px");
  assert.equal(copyStyle.opacity, "0");
  assert.equal(copyStyle.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.match(messages, /<span className="message-header-actions">[\s\S]*?<MessageActions/);
  const messageActionsSource = messages.match(/export function MessageActions[\s\S]*?(?=\nexport function TurnLanding)/)?.[0] ?? "";
  assert.doesNotMatch(messageActionsSource, /<span>\{copied \? "Copied" : "Copy"\}<\/span>/);
});

test("audited desktop and pane controls have working destinations", () => {
  assert.match(chrome, /switchable = true/);
  assert.doesNotMatch(chrome, /workspaces\.length > 1/);
  assert.match(desktopMain, /About \$\{productName\}[\s\S]*?sendRendererMenuCommand\("open-about"\)/);
  assert.doesNotMatch(desktopMain, /About \$\{productName\}[^\n]*enabled:\s*false/);
  assert.doesNotMatch(panes, /onDoubleClick=\{\(\) => onOpen\?\.\(item\)\}/);
  assert.match(panes, /onOpen \? <button[\s\S]*?>Open<\/button> : null/);
  assert.match(app, /tab\.kind === "history" \? \(\s*<HistoryPane/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
