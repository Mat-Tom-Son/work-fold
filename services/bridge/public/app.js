import { shouldSubmitComposerKey } from "./composer.js";
import { renderMarkdown } from "./markdown.js";

const app = document.querySelector("#app");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const localSlug = new URL(location.href).searchParams.get("slug") || "";

const state = {
  context: null,
  session: null,
  identity: null,
  pairing: null,
  eventSource: null,
  pendingOperations: new Map(),
  earlyEvents: new Map(),
  spaces: [],
  explorerSpaceId: null,
  trees: new Map(),
  expanded: new Set(),
  scope: { kind: "management", spaceId: null },
  conversations: [],
  chatListTruncated: false,
  selectedConversationId: null,
  contextPaths: new Set(),
  uploads: [],
  filesPanelOpen: window.matchMedia("(min-width: 981px)").matches,
  messages: [],
  transcriptTruncated: false,
  treeTruncated: new Map(),
  summary: null,
  activeTask: null,
  banner: "",
  refreshTimer: null,
  sending: false,
  startingNewChat: false,
};

void boot();

async function boot() {
  try {
    state.identity = await loadIdentity();
    state.context = await api(`/api/public/context${localSlug ? `?slug=${encodeURIComponent(localSlug)}` : ""}`);
    if (!state.context.addressAvailable) return renderAddressUnavailable();
    if (!state.context.authenticated) return renderLogin();
    state.session = await api("/api/auth/session");
    await continueAuthenticated();
  } catch (error) {
    renderFatal(errorText(error));
  }
}

async function continueAuthenticated() {
  if (state.identity?.grantId && !state.session.paired) {
    try {
      await bindIdentity();
      state.session = await api("/api/auth/session");
    } catch (error) {
      if (!isApiCode(error, "pairing_required")) throw error;
      clearGrantFromIdentity();
      await saveIdentity(state.identity);
    }
  }
  if (!state.session.paired) return startPairing();
  if (!state.identity?.grantId || state.identity.grantId !== state.session.grant?.id) return startPairing();
  await openApplication();
}

function renderAddressUnavailable() {
  if (!state.context.slug) return renderLanding();
  renderAuth({
    eyebrow: "Remote access",
    headline: "This address isn’t active.",
    supporting: "Check the address or enable Remote access from the work-fold desktop app.",
    panel: "<h2>Address unavailable</h2><p>Nothing is published here.</p>",
  });
}

function renderLanding() {
  app.innerHTML = `<main class="landing-shell">
    <header class="auth-top">
      <span class="brand"><img class="brand-mark" src="/work-fold-icon.svg" alt="" />work-fold</span>
      <nav class="landing-actions" aria-label="Download and source">
        <a class="header-download" href="/download/macos">Download for macOS</a>
        <a class="github-link" href="https://github.com/Mat-Tom-Son/work-fold" target="_blank" rel="noreferrer" aria-label="View work-fold on GitHub" title="View work-fold on GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.4 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.4 11.4 0 0 0 12 .8Z" /></svg>
        </a>
      </nav>
    </header>
    <section class="landing-stage">
      <div class="landing-copy">
        <p class="eyebrow">Folders first</p>
        <h1>Work with your desktop folders.</h1>
        <p>work-fold gives ordinary folders an Assistant, a running history, and simple Spaces—without turning your files into a proprietary workspace.</p>
      </div>
      <div class="landing-details" aria-label="How work-fold works">
        <section><span>01</span><div><h2>Keep folders ordinary</h2><p>Create a Space or register an existing folder. Your files stay visible in Finder and usable by the tools you already have.</p></div></section>
        <section><span>02</span><div><h2>Work with an Assistant</h2><p>Chat in the context you choose, keep a running local log, and move between Spaces without hiding where anything lives.</p></div></section>
        <section><span>03</span><div><h2>Go remote when needed</h2><p>Use a private web address to reach your chats and Spaces while your desktop is online.</p></div></section>
      </div>
    </section>
  </main>`;
}

function renderLogin(error = "") {
  renderAuth({
    eyebrow: "Remote access",
    headline: `Welcome back${state.context.slug ? `, ${escapeHtml(state.context.slug)}` : ""}.`,
    supporting: "Your desktop must be online.",
    panel: `
      <form id="login-form">
        <h2>Sign in</h2>
        <p>Use the password you set when you created this address.</p>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required autofocus /></div>
        <button class="primary" type="submit">Continue</button>
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ""}
      </form>`,
  });
  document.querySelector("#login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void login(new FormData(event.currentTarget));
  });
}

async function login(form) {
  const button = document.querySelector("#login-form button");
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    state.session = await api("/api/auth/login", {
      method: "POST",
      body: { password: String(form.get("password") || ""), ...(localSlug ? { slug: localSlug } : {}) },
    });
    await continueAuthenticated();
  } catch (error) {
    renderLogin(errorText(error));
  }
}

async function startPairing() {
  if (!state.session.desktopOnline) {
    return renderAuth({
      eyebrow: "Desktop offline",
      headline: "Open work-fold to continue.",
      supporting: "The desktop app holds your conversation and approves new browsers. Once it is running, refresh this page.",
      panel: `<h2>Waiting for your desktop</h2><p>Nothing can be read or sent while work-fold is offline.</p><button id="retry" class="primary">Try again</button>`,
    }, () => document.querySelector("#retry")?.addEventListener("click", () => location.reload()));
  }
  if (!state.identity) state.identity = await createBrowserIdentity();
  const pairing = await api("/api/pairings", {
    method: "POST",
    csrf: true,
    body: {
      browserId: state.identity.browserId,
      label: browserLabel(),
      signingPublicJwk: state.identity.signingPublicJwk,
      encryptionPublicJwk: state.identity.encryptionPublicJwk,
    },
  });
  state.pairing = pairing.pairing;
  renderPairing();
  void pollPairing();
}

function renderPairing(error = "") {
  renderAuth({
    eyebrow: "Approve this browser once",
    headline: "Match the code in work-fold.",
    supporting: "You’ll only match a code the first time you use this browser, unless you revoke it or clear its site data. Approval binds a non-exportable browser key to your desktop.",
    panel: `
      <h2>Approve ${escapeHtml(browserLabel())}</h2>
      <p>Confirm that the same six digits appear in the desktop prompt.</p>
      <div class="pairing-code" aria-label="Pairing code ${escapeHtml(state.pairing?.code || "")}">${escapeHtml(state.pairing?.code || "")}</div>
      <div class="pairing-status"><span class="spinner" aria-hidden="true"></span><span>Waiting for approval…</span></div>
      ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
    `,
  });
}

async function pollPairing() {
  for (;;) {
    await delay(1_300);
    let result;
    try { result = await api(`/api/pairings/${encodeURIComponent(state.pairing.id)}`); }
    catch (error) { return renderPairing(errorText(error)); }
    state.pairing = result.pairing;
    if (state.pairing.status === "pending") continue;
    if (state.pairing.status !== "approved") return renderPairing("The desktop did not approve this browser. Refresh to try again.");
    try {
      await acceptApproval(state.pairing);
      state.session = await api("/api/auth/session");
      await openApplication();
    } catch (error) {
      renderPairing(errorText(error));
    }
    return;
  }
}

async function acceptApproval(pairing) {
  const certificate = pairing.approvalCertificate;
  if (!certificate || certificate.browserId !== state.identity.browserId || certificate.grantId === undefined
    || certificate.pairingId !== pairing.id || certificate.pairingCode !== pairing.code
    || certificate.generation !== state.session.grantGeneration
    || canonicalize(certificate.browserSigningPublicJwk) !== canonicalize(state.identity.signingPublicJwk)
    || canonicalize(certificate.browserEncryptionPublicJwk) !== canonicalize(state.identity.encryptionPublicJwk)) {
    throw new Error("The desktop approval did not match this browser.");
  }
  const valid = await verifyText(
    state.session.deviceSigningPublicJwk,
    canonicalize(certificate),
    pairing.approvalSignature,
  );
  if (!valid) throw new Error("The desktop approval signature could not be verified.");
  Object.assign(state.identity, {
    grantId: certificate.grantId,
    generation: certificate.generation,
    approvalCertificate: certificate,
    approvalSignature: pairing.approvalSignature,
    deviceSigningPublicJwk: state.session.deviceSigningPublicJwk,
    deviceEncryptionPublicJwk: state.session.deviceEncryptionPublicJwk,
  });
  await saveIdentity(state.identity);
}

async function bindIdentity() {
  const proof = canonicalize({
    type: "work-fold.browser-bind.v1",
    accountId: state.identity.approvalCertificate.accountId,
    browserId: state.identity.browserId,
    challenge: state.session.challenge,
  });
  const signature = await signText(state.identity.signingPrivateKey, proof);
  return api("/api/auth/bind", {
    method: "POST",
    csrf: true,
    body: { browserId: state.identity.browserId, signature },
  });
}

async function openApplication() {
  renderApplication();
  openEvents();
  await loadSpaces();
  await loadConversations();
  scheduleRefresh();
}

function renderApplication() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="side-rail">
        <button id="management-home" class="rail-brand" type="button" aria-label="Open work-fold chats"><span class="brand"><img class="brand-mark" src="/work-fold-icon.svg" alt="" />work-fold</span></button>
        <button id="new-chat" class="rail-new-chat" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
          <span>New chat</span>
        </button>
        <p class="rail-heading">Chats</p>
        <ul id="chats" class="chat-list"></ul>
        <div class="rail-spacer"></div>
        <div class="rail-account"><span>${escapeHtml(state.context.slug)}.work-fold.com</span><button id="logout" class="quiet">Sign out</button></div>
      </aside>
      <main class="conversation">
        <header class="conversation-bar">
          <div class="conversation-identity"><span id="scope-name"></span><strong id="conversation-title"></strong></div>
          <div class="conversation-actions"><button id="stop-task" class="toolbar-button danger" type="button" hidden>Stop</button><button id="toggle-files" class="toolbar-button" type="button" aria-expanded="true">Files</button></div>
        </header>
        <div id="banner"></div>
        <section id="messages" class="messages"><div class="message-stream"></div></section>
        <footer class="composer-wrap">
          <form id="composer" class="composer">
            <div id="composer-context" class="composer-context"></div>
            <div class="composer-field">
              <button id="attach-files" class="attach-button" type="button" aria-label="Attach files" title="Attach files">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.5 5.7-5.7a3 3 0 1 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2" /></svg>
              </button>
              <input id="file-input" type="file" multiple hidden />
              <textarea id="prompt" rows="1" maxlength="12000" placeholder="Message work-fold" aria-label="Message work-fold" aria-describedby="composer-note" autofocus></textarea>
              <button class="send-button" type="submit" aria-label="Send message" aria-keyshortcuts="Enter" title="Send message" disabled>
                <svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-5 5 5-5 5 5" /></svg>
              </button>
            </div>
            <div id="composer-note" class="composer-note">
              <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
            </div>
          </form>
        </footer>
      </main>
      <aside id="workspace-pane" class="workspace-pane">
        <div class="workspace-pane-head">
          <label for="space-picker">Space</label>
          <button id="close-files" class="icon-button" type="button" aria-label="Close Files">×</button>
        </div>
        <select id="space-picker" class="space-picker" aria-label="Choose a Space"></select>
        <div class="workspace-actions"><button id="chat-with-space" class="space-chat-button" type="button">Chat with Space</button></div>
        <div id="file-tree" class="file-tree"></div>
      </aside>
    </div>`;
  document.querySelector("#logout")?.addEventListener("click", () => void logout());
  document.querySelector("#management-home")?.addEventListener("click", () => void switchScope({ kind: "management", spaceId: null }));
  document.querySelector("#new-chat")?.addEventListener("click", startNewChat);
  document.querySelector("#stop-task")?.addEventListener("click", () => void stopCurrentTask());
  document.querySelector("#toggle-files")?.addEventListener("click", () => setFilesPanelOpen(!state.filesPanelOpen));
  document.querySelector("#close-files")?.addEventListener("click", () => setFilesPanelOpen(false));
  document.querySelector("#chat-with-space")?.addEventListener("click", () => {
    if (state.explorerSpaceId) void switchScope({ kind: "space", spaceId: state.explorerSpaceId });
  });
  document.querySelector("#space-picker")?.addEventListener("change", (event) => void selectExplorerSpace(event.currentTarget.value));
  document.querySelector("#attach-files")?.addEventListener("click", () => document.querySelector("#file-input")?.click());
  document.querySelector("#file-input")?.addEventListener("change", (event) => {
    addUploads([...event.currentTarget.files]);
    event.currentTarget.value = "";
  });
  document.querySelector("#composer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt();
  });
  const prompt = document.querySelector("#prompt");
  prompt?.addEventListener("input", syncComposer);
  prompt?.addEventListener("keydown", (event) => {
    if (shouldSubmitComposerKey(event)) {
      event.preventDefault();
      document.querySelector("#composer")?.requestSubmit();
    }
  });
  syncComposer();
  renderConversationChrome();
  renderConversations();
  renderWorkspace();
  setFilesPanelOpen(state.filesPanelOpen);
  updateConnection();
}

function renderMessages() {
  const container = document.querySelector("#messages");
  if (!container) return;
  const wasNearBottom = !container.dataset.rendered
    || container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const visible = state.messages.filter((message) => (message.role === "user" || message.role === "assistant") && !message.kind);
  const requestPhase = state.summary?.latestRequest?.phase;
  const working = !state.startingNewChat && (
    state.summary?.state === "running" || requestPhase === "working" || requestPhase === "handed_off"
  );
  container.innerHTML = `<div class="message-stream">${state.transcriptTruncated ? `<div class="projection-notice">Earlier messages are hidden.</div>` : ""}${visible.length ? visible.map((message) => `
    <article class="message ${message.role} ${message.source === "remote_web" ? "web" : ""}">
      <div class="message-role">${message.role === "assistant" ? escapeHtml(assistantLabel()) : "You"}</div>
      <div class="message-content"><div class="message-body markdown">${renderMarkdown(message.content)}</div>${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((attachment) => `<span>${fileGlyph(attachment.kind)}${escapeHtml(attachment.name)}</span>`).join("")}</div>` : ""}</div>
    </article>`).join("") : ""}
    ${working ? `<div class="working-row"><span class="spinner"></span><span>${requestPhase === "handed_off" ? "Space working" : "Working"}</span></div>` : ""}
  </div>`;
  container.dataset.rendered = "true";
  if (wasNearBottom) container.scrollTop = container.scrollHeight;
  renderBanner();
}

async function refreshConversation() {
  try {
    if (state.startingNewChat || !state.selectedConversationId) {
      state.summary = { state: "idle" };
      state.messages = [];
      state.transcriptTruncated = false;
      renderConversationChrome();
      renderMessages();
      return;
    }
    if (state.scope.kind === "management") {
      state.summary = await remote("management.summary", { conversationId: state.selectedConversationId });
    } else {
      const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
      state.summary = { state: selected?.state ?? "idle" };
    }
    const summaryPhase = state.summary?.latestRequest?.phase;
    if (state.summary?.state !== "running" && summaryPhase !== "working" && summaryPhase !== "handed_off") {
      if (state.activeTask?.conversationId === state.selectedConversationId) state.activeTask = null;
    }
    updateConnection(true);
    const transcript = state.scope.kind === "management"
      ? await remote("management.transcript", { conversationId: state.selectedConversationId })
      : await remote("spaces.transcript", { spaceId: state.scope.spaceId, conversationId: state.selectedConversationId });
    state.messages = transcript.messages ?? [];
    state.transcriptTruncated = transcript.truncated === true;
    renderConversationChrome();
    renderMessages();
  } catch (error) {
    state.banner = errorText(error);
    if (state.banner.toLowerCase().includes("offline")) updateConnection(false);
    renderBanner();
  }
}

async function sendPrompt() {
  const input = document.querySelector("#prompt");
  const content = input.value.trim();
  if (!content || state.sending) return;
  state.sending = true;
  syncComposer();
  state.banner = "";
  try {
    const attachments = await serializeUploads();
    const request = {
      content,
      ...(state.startingNewChat || !state.selectedConversationId
        ? { newConversation: true }
        : { conversationId: state.selectedConversationId }),
      ...(attachments.length ? { attachments } : {}),
    };
    const result = state.scope.kind === "management"
      ? await remote("management.send", request)
      : await remote("spaces.send", {
        ...request,
        spaceId: state.scope.spaceId,
        contextPaths: [...state.contextPaths],
        selectedPath: [...state.contextPaths].at(-1) ?? null,
      });
    state.startingNewChat = false;
    state.selectedConversationId = result.conversationId;
    state.activeTask = result.taskId ? {
      taskId: result.taskId,
      conversationId: result.conversationId,
      kind: state.scope.kind,
      spaceId: state.scope.spaceId,
    } : null;
    input.value = "";
    state.uploads = [];
    state.contextPaths.clear();
    syncComposer();
    await loadConversations({ preferredConversationId: result.conversationId });
  } catch (error) {
    state.banner = errorText(error);
    renderBanner();
  } finally {
    state.sending = false;
    syncComposer();
    input.focus({ preventScroll: true });
  }
}

function startNewChat() {
  if (state.sending || state.startingNewChat) return;
  state.startingNewChat = true;
  state.selectedConversationId = null;
  state.messages = [];
  state.transcriptTruncated = false;
  state.banner = "";
  state.contextPaths.clear();
  state.uploads = [];
  state.activeTask = null;
  renderConversationChrome();
  renderConversations();
  renderMessages();
  syncComposer();
  document.querySelector("#prompt")?.focus({ preventScroll: true });
}

function syncComposer() {
  const input = document.querySelector("#prompt");
  const button = document.querySelector(".send-button");
  if (!input || !button) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 56), 180)}px`;
  const unavailable = !state.session?.desktopOnline;
  button.disabled = state.sending || unavailable || !input.value.trim();
  button.dataset.sending = String(state.sending);
  button.setAttribute("aria-label", state.sending ? "Sending message" : unavailable ? "Desktop offline" : "Send message");
  button.title = state.sending ? "Sending…" : unavailable ? "Desktop offline" : "Send message";
  input.setAttribute("aria-busy", String(state.sending));
  const newChatButton = document.querySelector("#new-chat");
  if (newChatButton) newChatButton.disabled = state.sending || state.startingNewChat;
  renderComposerContext();
}

async function loadSpaces() {
  try {
    const result = await remote("spaces.list");
    state.spaces = result.spaces ?? [];
    if (!state.explorerSpaceId && state.spaces[0]) state.explorerSpaceId = state.spaces[0].id;
    renderWorkspace();
    if (state.explorerSpaceId) await loadTree(state.explorerSpaceId, "");
  } catch (error) {
    state.banner = errorText(error);
    renderBanner();
  }
}

async function loadConversations({ preferredConversationId = state.selectedConversationId, refreshTranscript = true } = {}) {
  const result = state.scope.kind === "management"
    ? await remote("management.chats")
    : await remote("spaces.chats", { spaceId: state.scope.spaceId });
  state.conversations = (result.conversations ?? []).filter((conversation) => !conversation.archivedAt);
  state.chatListTruncated = result.truncated === true;
  const selected = preferredConversationId && state.conversations.some((conversation) => conversation.id === preferredConversationId)
    ? preferredConversationId
    : state.conversations[0]?.id ?? null;
  state.selectedConversationId = state.startingNewChat ? null : selected;
  renderConversations();
  renderConversationChrome();
  if (refreshTranscript) await refreshConversation();
}

function renderConversations() {
  const list = document.querySelector("#chats");
  if (!list) return;
  list.innerHTML = state.conversations.length ? `${state.conversations.map((conversation) => `
    <li><button class="chat-button ${conversation.id === state.selectedConversationId && !state.startingNewChat ? "active" : ""}" data-chat-id="${escapeAttribute(conversation.id)}">
      <span class="chat-title">${escapeHtml(conversation.title)}</span>
      <span class="chat-meta">${conversation.state === "running" ? "Working" : shortDate(conversation.updatedAt)}</span>
    </button></li>`).join("")}${state.chatListTruncated ? `<li class="empty-list">Older chats hidden</li>` : ""}` : `<li class="empty-list">No chats</li>`;
  for (const button of list.querySelectorAll("[data-chat-id]")) {
    button.addEventListener("click", () => void selectConversation(button.dataset.chatId));
  }
}

async function selectConversation(conversationId) {
  if (state.sending || !conversationId) return;
  state.startingNewChat = false;
  state.selectedConversationId = conversationId;
  state.banner = "";
  renderConversations();
  renderConversationChrome();
  await refreshConversation();
}

async function switchScope(scope) {
  if (state.sending || (scope.kind === "space" && !scope.spaceId)) return;
  state.scope = scope;
  state.startingNewChat = false;
  state.selectedConversationId = null;
  state.messages = [];
  state.contextPaths.clear();
  state.uploads = [];
  state.banner = "";
  if (scope.kind === "space") {
    state.explorerSpaceId = scope.spaceId;
    await loadTree(scope.spaceId, "");
  }
  renderWorkspace();
  syncComposer();
  await loadConversations();
}

async function loadTree(spaceId, path) {
  const result = await remote("spaces.tree", { spaceId, path });
  state.trees.set(`${spaceId}:${path}`, result.tree ?? []);
  state.treeTruncated.set(`${spaceId}:${path}`, result.truncated === true);
  renderWorkspace();
}

function findEntry(entries, path) { return entries.find((entry) => entry.path === path) ?? null; }
function findEntryInCaches(spaceId, path) {
  for (const [key, entries] of state.trees) if (key.startsWith(`${spaceId}:`)) {
    const found = findEntry(entries, path); if (found) return found;
  }
  return null;
}

function renderConversationChrome() {
  const scopeName = document.querySelector("#scope-name");
  const title = document.querySelector("#conversation-title");
  const prompt = document.querySelector("#prompt");
  const space = state.spaces.find((candidate) => candidate.id === state.scope.spaceId);
  if (scopeName) scopeName.textContent = state.scope.kind === "management" ? "work-fold" : space?.name ?? "Space";
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
  if (title) title.textContent = state.startingNewChat || !selected ? "New chat" : selected.title;
  if (prompt) prompt.placeholder = state.scope.kind === "management" ? "Message work-fold" : `Message ${space?.name ?? "Space"}`;
  const stop = document.querySelector("#stop-task");
  if (stop) stop.hidden = !state.activeTask || state.activeTask.conversationId !== state.selectedConversationId;
}

function renderWorkspace() {
  const picker = document.querySelector("#space-picker");
  const tree = document.querySelector("#file-tree");
  const chatButton = document.querySelector("#chat-with-space");
  if (picker) {
    picker.innerHTML = state.spaces.map((space) => `<option value="${escapeAttribute(space.id)}" ${space.id === state.explorerSpaceId ? "selected" : ""}>${escapeHtml(space.name)}</option>`).join("");
    picker.disabled = !state.spaces.length;
  }
  if (chatButton) {
    chatButton.disabled = !state.explorerSpaceId;
    chatButton.textContent = state.scope.kind === "space" && state.scope.spaceId === state.explorerSpaceId ? "Current chat" : "Chat with Space";
  }
  if (!tree) return;
  if (!state.explorerSpaceId) {
    tree.innerHTML = `<div class="file-empty">No Spaces</div>`;
    return;
  }
  const entries = state.trees.get(`${state.explorerSpaceId}:`) ?? [];
  tree.innerHTML = renderTreeRows(state.explorerSpaceId, entries, "", 0);
  for (const button of tree.querySelectorAll("[data-tree-path]")) {
    button.addEventListener("click", () => void toggleTree(button.dataset.spaceId, button.dataset.treePath));
  }
  for (const button of tree.querySelectorAll("[data-add-context]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void addFileContext(button.dataset.spaceId, button.dataset.addContext);
    });
  }
}

function renderTreeRows(spaceId, entries, path, depth) {
  const truncated = state.treeTruncated.get(`${spaceId}:${path}`) === true;
  if (!entries.length) return `<div class="file-empty">Empty</div>`;
  return `${truncated ? `<div class="tree-notice">First 500 items. Ignored files omitted.</div>` : ""}${entries.map((entry) => {
    const expanded = entry.kind === "folder" && state.expanded.has(`${spaceId}:${entry.path}`);
    const children = expanded ? state.trees.get(`${spaceId}:${entry.path}`) ?? [] : [];
    const selected = state.scope.kind === "space" && state.scope.spaceId === spaceId && state.contextPaths.has(entry.path);
    return `<div class="file-node">
      <div class="file-row ${selected ? "selected" : ""}" style="--depth:${depth}">
        <button class="file-main" type="button" data-space-id="${escapeAttribute(spaceId)}" data-tree-path="${escapeAttribute(entry.path)}" ${entry.kind === "folder" ? `aria-expanded="${String(expanded)}"` : ""}>
          <span class="tree-caret">${entry.kind === "folder" ? expanded ? "⌄" : "›" : ""}</span>${fileGlyph(entry.kind)}<span class="file-name">${escapeHtml(entry.name)}</span>
        </button>
        ${entry.kind === "file" ? `<span class="file-size">${formatBytes(entry.sizeBytes)}</span><button class="file-context-button" type="button" data-space-id="${escapeAttribute(spaceId)}" data-add-context="${escapeAttribute(entry.path)}" aria-label="Add ${escapeAttribute(entry.name)} to chat" title="Add to chat">+</button>` : ""}
      </div>
      ${expanded ? `<div>${renderTreeRows(spaceId, children, entry.path, depth + 1)}</div>` : ""}
    </div>`;
  }).join("")}`;
}

async function selectExplorerSpace(spaceId) {
  state.explorerSpaceId = spaceId;
  renderWorkspace();
  if (spaceId) await loadTree(spaceId, "");
}

async function toggleTree(spaceId, path) {
  const entry = findEntryInCaches(spaceId, path);
  if (entry?.kind !== "folder") return;
  const key = `${spaceId}:${path}`;
  if (state.expanded.has(key)) state.expanded.delete(key);
  else {
    state.expanded.add(key);
    if (!state.trees.has(key)) await loadTree(spaceId, path);
  }
  renderWorkspace();
}

async function addFileContext(spaceId, path) {
  if (state.scope.kind !== "space" || state.scope.spaceId !== spaceId) {
    await switchScope({ kind: "space", spaceId });
  }
  if (state.contextPaths.has(path)) state.contextPaths.delete(path);
  else state.contextPaths.add(path);
  syncComposer();
  renderWorkspace();
  document.querySelector("#prompt")?.focus({ preventScroll: true });
}

async function stopCurrentTask() {
  const task = state.activeTask;
  if (!task) return;
  const button = document.querySelector("#stop-task");
  if (button) button.disabled = true;
  try {
    if (task.kind === "management") await remote("management.stop", { taskId: task.taskId });
    else await remote("spaces.stop", { spaceId: task.spaceId, taskId: task.taskId });
    state.activeTask = null;
    await loadConversations({ preferredConversationId: task.conversationId });
  } catch (error) {
    state.banner = errorText(error);
    renderBanner();
  } finally {
    if (button) button.disabled = false;
    renderConversationChrome();
  }
}

function addUploads(files) {
  const maximumFiles = 6;
  const maximumFileBytes = 6 * 1024 * 1024;
  const maximumTotalBytes = 8 * 1024 * 1024;
  const next = [...state.uploads];
  for (const file of files) {
    if (next.length >= maximumFiles) return showUploadError(`Attach up to ${maximumFiles} files.`);
    if (file.size > maximumFileBytes) return showUploadError(`${file.name} is larger than 6 MB.`);
    if (next.reduce((total, item) => total + item.size, 0) + file.size > maximumTotalBytes) return showUploadError("Attachments are limited to 8 MB per message.");
    next.push(file);
  }
  state.uploads = next;
  state.banner = "";
  syncComposer();
  renderBanner();
}

function showUploadError(message) {
  state.banner = message;
  renderBanner();
}

async function serializeUploads() {
  return Promise.all(state.uploads.map(async (file) => ({ name: file.name, data: base64url(new Uint8Array(await file.arrayBuffer())) })));
}

function renderComposerContext() {
  const container = document.querySelector("#composer-context");
  if (!container) return;
  const context = [...state.contextPaths].map((path) => ({ kind: "context", name: path }));
  const uploads = state.uploads.map((file, index) => ({ kind: "upload", name: file.name, index }));
  container.innerHTML = [...context, ...uploads].map((item) => `<span class="context-chip">${fileGlyph("file")}<span>${escapeHtml(item.name)}</span><button type="button" ${item.kind === "context" ? `data-remove-context="${escapeAttribute(item.name)}"` : `data-remove-upload="${item.index}"`} aria-label="Remove ${escapeAttribute(item.name)}">×</button></span>`).join("");
  for (const button of container.querySelectorAll("[data-remove-context]")) button.addEventListener("click", () => {
    state.contextPaths.delete(button.dataset.removeContext);
    syncComposer();
    renderWorkspace();
  });
  for (const button of container.querySelectorAll("[data-remove-upload]")) button.addEventListener("click", () => {
    state.uploads.splice(Number(button.dataset.removeUpload), 1);
    syncComposer();
  });
}

function setFilesPanelOpen(open) {
  state.filesPanelOpen = open;
  document.querySelector(".app-shell")?.classList.toggle("files-closed", !open);
  document.querySelector("#toggle-files")?.setAttribute("aria-expanded", String(open));
}

function fileGlyph(kind) {
  return kind === "folder"
    ? `<svg class="file-glyph folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h5l1.4 1.6h8.6v8.4h-15Z" /></svg>`
    : `<svg class="file-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5Z"/><path d="M11 2.5v4h4" /></svg>`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function assistantLabel() {
  if (state.scope.kind === "management") return "work-fold";
  return state.spaces.find((space) => space.id === state.scope.spaceId)?.name ?? "Space";
}

function scheduleRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  const active = state.summary?.state === "running";
  state.refreshTimer = setTimeout(() => void loadConversations({ refreshTranscript: true })
    .catch((error) => {
      state.banner = errorText(error);
      renderBanner();
    })
    .finally(scheduleRefresh), active ? 4_000 : 10_000);
}

function openEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource("/api/events");
  state.eventSource.addEventListener("ready", () => updateConnection(true));
  state.eventSource.addEventListener("remote", (raw) => {
    void receiveRemoteEvent(JSON.parse(raw.data)).catch((error) => {
      state.banner = errorText(error);
      renderBanner();
    });
  });
  state.eventSource.onerror = () => updateConnection(false);
}

async function receiveRemoteEvent(event) {
  const pending = state.pendingOperations.get(event.operationId);
  if (event.type === "operation.complete" && !pending) {
    state.earlyEvents.set(event.operationId, event);
    while (state.earlyEvents.size > 64) state.earlyEvents.delete(state.earlyEvents.keys().next().value);
    return;
  }
  if (event.type === "operation.complete" && pending) {
    assertResponseEnvelope(event.envelope, event.operationId, pending.requestId, event.type);
    const payload = await decryptResponse(event.envelope);
    state.pendingOperations.delete(event.operationId);
    event.envelope.header.ok ? pending.resolve(payload.result) : pending.reject(new Error(payload.error || "The desktop could not complete this request."));
  }
}

async function remote(operation, input = {}) {
  if (!state.session?.paired || !state.identity?.grantId) throw new Error("This browser is not approved.");
  const requestId = crypto.randomUUID();
  const header = {
    type: "work-fold.remote-request.v1",
    accountId: state.identity.approvalCertificate.accountId,
    deviceId: state.identity.approvalCertificate.deviceId,
    grantId: state.identity.grantId,
    generation: state.identity.generation,
    requestId,
    operation,
    createdAt: new Date().toISOString(),
  };
  const envelope = await encryptRequest(header, { input });
  const accepted = await api("/api/operations", { method: "POST", csrf: true, body: { envelope } });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pendingOperations.delete(accepted.operation.id);
      reject(new Error("The desktop did not answer in time."));
    }, 120_000);
    state.pendingOperations.set(accepted.operation.id, {
      requestId,
      envelope,
      recoveryAttempts: 0,
      nextRecoveryAt: 0,
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    const early = state.earlyEvents.get(accepted.operation.id);
    if (early) {
      state.earlyEvents.delete(accepted.operation.id);
      void receiveRemoteEvent(early).catch((error) => state.pendingOperations.get(accepted.operation.id)?.reject(error));
    }
    void pollOperationFallback(accepted.operation.id);
  });
}

async function pollOperationFallback(operationId) {
  for (let attempt = 0; attempt < 120 && state.pendingOperations.has(operationId); attempt += 1) {
    await delay(1_000);
    let status;
    try { status = await api(`/api/operations/${encodeURIComponent(operationId)}`); } catch { continue; }
    updateConnection(status.desktopOnline);
    const event = status.events?.at(-1);
    const eventKind = event?.envelope?.header?.eventKind;
    if (eventKind === "operation.complete" && new Set(["done", "failed"]).has(status.operation.state)) {
      await receiveRemoteEvent({ type: "operation.complete", operationId, envelope: event.envelope });
      return;
    }
    if (status.operation.state === "lost"
      || (new Set(["done", "failed"]).has(status.operation.state) && eventKind !== "operation.complete")) {
      const pending = state.pendingOperations.get(operationId);
      if (!pending) return;
      if (Date.now() < pending.nextRecoveryAt) continue;
      if (pending.recoveryAttempts >= 5) {
        state.pendingOperations.delete(operationId);
        pending.reject(new Error("work-fold could not reconcile this request after the connection changed. Check the running log before sending anything again."));
        return;
      }
      pending.recoveryAttempts += 1;
      pending.nextRecoveryAt = Date.now() + 5_000;
      try {
        const recovered = await api("/api/operations", {
          method: "POST",
          csrf: true,
          body: { envelope: pending.envelope, recover: true },
        });
        if (recovered.operation.id !== operationId) throw new Error("Recovered request identity changed unexpectedly.");
      } catch (error) {
        if (pending.recoveryAttempts >= 5) {
          state.pendingOperations.delete(operationId);
          pending.reject(new Error(`work-fold could not reconcile this request. Check the running log before sending anything again. ${errorText(error)}`));
          return;
        }
      }
    }
  }
}

async function encryptRequest(header, payload) {
  const key = await transportKey(state.identity.encryptionPrivateKey, state.identity.deviceEncryptionPublicJwk, state.identity.grantId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(canonicalize(header));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoder.encode(JSON.stringify(payload)));
  const envelope = { header, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
  return { ...envelope, signature: await signText(state.identity.signingPrivateKey, `${canonicalize(header)}.${envelope.iv}.${envelope.ciphertext}`) };
}

async function decryptResponse(envelope) {
  const signed = `${canonicalize(envelope.header)}.${envelope.iv}.${envelope.ciphertext}`;
  if (!await verifyText(state.identity.deviceSigningPublicJwk, signed, envelope.signature)) throw new Error("The desktop response signature is invalid.");
  const key = await transportKey(state.identity.encryptionPrivateKey, state.identity.deviceEncryptionPublicJwk, state.identity.grantId);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: fromBase64url(envelope.iv),
    additionalData: encoder.encode(canonicalize(envelope.header)),
  }, key, fromBase64url(envelope.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

function assertResponseEnvelope(envelope, operationId, requestId, eventKind) {
  const header = envelope?.header;
  const createdAt = typeof header?.createdAt === "string" ? Date.parse(header.createdAt) : NaN;
  if (!header || header.type !== "work-fold.remote-response.v1"
    || header.accountId !== state.identity.approvalCertificate.accountId
    || header.deviceId !== state.identity.approvalCertificate.deviceId
    || header.grantId !== state.identity.grantId
    || header.generation !== state.identity.generation
    || header.operationId !== operationId
    || header.requestId !== requestId
    || header.eventKind !== eventKind
    || !Number.isInteger(header.sequence) || header.sequence < 1
    || typeof header.ok !== "boolean"
    || !Number.isFinite(createdAt)
    || Math.abs(Date.now() - createdAt) > 5 * 60_000) {
    throw new Error("The desktop response identity is invalid.");
  }
}

async function transportKey(privateKey, remotePublicJwk, grantId) {
  const publicKey = await crypto.subtle.importKey("jwk", remotePublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode(grantId), info: encoder.encode("work-fold.remote-envelope.v1"),
  }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function createBrowserIdentity() {
  const signing = await generateNonExportablePair("ECDSA");
  const encryption = await generateNonExportablePair("ECDH");
  const identity = {
    browserId: crypto.randomUUID(),
    signingPrivateKey: signing.privateKey,
    signingPublicJwk: { ...signing.publicJwk, use: "sig" },
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicJwk: { ...encryption.publicJwk, use: "enc" },
  };
  await saveIdentity(identity);
  return identity;
}

async function generateNonExportablePair(name) {
  const temporary = await crypto.subtle.generateKey({ name, namedCurve: "P-256" }, false, name === "ECDSA" ? ["sign", "verify"] : ["deriveBits"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", temporary.publicKey);
  return { privateKey: temporary.privateKey, publicJwk };
}

async function signText(key, text) {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(text));
  return base64url(new Uint8Array(signature));
}

async function verifyText(publicJwk, text, signature) {
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature), encoder.encode(text));
  } catch { return false; }
}

function canonicalize(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

async function api(path, { method = "GET", body, csrf = false } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(csrf && state.session?.csrfToken ? { "x-work-fold-csrf": state.session.csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status}).`), { status: response.status, code: result.code });
  return result;
}

async function logout() {
  try { await api("/api/auth/session", { method: "DELETE", csrf: true }); } catch {}
  location.reload();
}

function clearGrantFromIdentity() {
  for (const key of ["grantId", "generation", "approvalCertificate", "approvalSignature", "deviceSigningPublicJwk", "deviceEncryptionPublicJwk"]) delete state.identity[key];
}

function updateConnection(online = state.session?.desktopOnline) {
  if (state.session) state.session.desktopOnline = Boolean(online);
  syncComposer();
}

function renderBanner() {
  const element = document.querySelector("#banner");
  if (element) element.innerHTML = state.banner ? `<div class="banner" role="alert">${escapeHtml(state.banner)}</div>` : "";
}

function renderAuth({ eyebrow, headline, supporting, panel }, afterRender) {
  app.innerHTML = `<main class="auth-shell">
    <header class="auth-top"><span class="brand"><img class="brand-mark" src="/work-fold-icon.svg" alt="" />work-fold</span></header>
    <section class="auth-stage"><div class="auth-copy"><p class="eyebrow">${eyebrow}</p><h1>${headline}</h1><p>${supporting}</p></div><div class="auth-panel">${panel}</div></section>
  </main>`;
  afterRender?.();
}

function renderFatal(message) {
  renderAuth({ eyebrow: "Could not connect", headline: "work-fold is unavailable.", supporting: "Your local files and conversation have not moved.", panel: `<h2>Connection error</h2><p class="form-error">${escapeHtml(message)}</p><button id="fatal-retry" class="primary">Try again</button>` }, () => {
    document.querySelector("#fatal-retry")?.addEventListener("click", () => location.reload());
  });
}

function browserLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  return `${browserName()} on ${platform}`.slice(0, 80);
}
function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/") && !ua.includes("Chrome/")) return "Safari";
  if (ua.includes("Firefox/")) return "Firefox";
  return "Browser";
}

function openIdentityDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("work-fold-remote", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadIdentity() {
  const db = await openIdentityDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("identity").objectStore("identity").get("browser");
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function saveIdentity(identity) {
  const db = await openIdentityDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("identity", "readwrite");
    transaction.objectStore("identity").put(identity, "browser");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function base64url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value ?? ""); return node.innerHTML; }
function escapeAttribute(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function isApiCode(error, code) { return error && typeof error === "object" && error.code === code; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
