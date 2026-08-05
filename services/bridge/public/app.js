import { shouldSubmitComposerKey } from "./composer.js";
import { renderMarkdown } from "./markdown.js";
import { assertPairingRelay, pairingCodeForKeys } from "./pairing-code.js";

const app = document.querySelector("#app");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const localSlug = new URL(location.href).searchParams.get("slug") || "";

const state = {
  context: null,
  session: null,
  identity: null,
  pairing: null,
  pairingExpectedCode: null,
  eventSource: null,
  pendingOperations: new Map(),
  earlyEvents: new Map(),
  spaces: [],
  explorerSpaceId: null,
  trees: new Map(),
  treeStatus: new Map(),
  expanded: new Set(),
  conversations: [],
  chatListTruncated: false,
  selectedConversationId: null,
  uploads: [],
  composerDrafts: new Map(),
  filesPanelOpen: window.matchMedia("(min-width: 981px)").matches,
  messages: [],
  transcriptConversationId: null,
  transcriptTruncated: false,
  treeTruncated: new Map(),
  settledTreeRefreshes: new Set(),
  summary: null,
  activeTasks: new Map(),
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
  // The browser contributes the commitment nonce. Letting the bridge choose
  // this id would let it cheaply search ids until two six-digit commitments
  // collide after substituting a key.
  const pairingId = crypto.randomUUID();
  const expectedCode = await pairingCodeForKeys({
    pairingId,
    browserId: state.identity.browserId,
    signingPublicJwk: state.identity.signingPublicJwk,
    encryptionPublicJwk: state.identity.encryptionPublicJwk,
  });
  const response = await api("/api/pairings", {
    method: "POST",
    csrf: true,
    body: {
      pairingId,
      browserId: state.identity.browserId,
      label: browserLabel(),
      signingPublicJwk: state.identity.signingPublicJwk,
      encryptionPublicJwk: state.identity.encryptionPublicJwk,
    },
  });
  const pairing = response.pairing;
  assertPairingRelay(pairing, { pairingId, browserId: state.identity.browserId, expectedCode });
  state.pairing = pairing;
  state.pairingExpectedCode = expectedCode;
  renderPairing();
  void pollPairing(pairingId, expectedCode);
}

function renderPairing(error = "") {
  renderAuth({
    eyebrow: "Approve this browser once",
    headline: "Match the code in work-fold.",
    supporting: "You’ll only match a code the first time you use this browser, unless you revoke it or clear its site data. Approval binds a non-exportable browser key to your desktop.",
    panel: `
      <h2>Approve ${escapeHtml(browserLabel())}</h2>
      <p>Confirm that the same six digits appear in the desktop prompt.</p>
      <div class="pairing-code" aria-label="Pairing code ${escapeHtml(state.pairingExpectedCode || "")}">${escapeHtml(state.pairingExpectedCode || "")}</div>
      <div class="pairing-status"><span class="spinner" aria-hidden="true"></span><span>Waiting for approval…</span></div>
      ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
    `,
  });
}

async function pollPairing(pairingId, expectedCode) {
  for (;;) {
    await delay(1_300);
    let result;
    try { result = await api(`/api/pairings/${encodeURIComponent(pairingId)}`); }
    catch (error) { return renderPairing(errorText(error)); }
    try {
      assertPairingRelay(result.pairing, { pairingId, browserId: state.identity.browserId, expectedCode });
    } catch (error) {
      return renderPairing(errorText(error));
    }
    if (state.pairingExpectedCode !== expectedCode) return;
    state.pairing = result.pairing;
    if (state.pairing.status === "pending") continue;
    if (state.pairing.status !== "approved") return renderPairing("The desktop did not approve this browser. Refresh to try again.");
    try {
      await acceptApproval(state.pairing, pairingId, expectedCode);
      state.session = await api("/api/auth/session");
      await openApplication();
    } catch (error) {
      renderPairing(errorText(error));
    }
    return;
  }
}

async function acceptApproval(pairing, pairingId, expectedCode) {
  const certificate = pairing.approvalCertificate;
  if (!certificate || certificate.browserId !== state.identity.browserId || certificate.grantId === undefined
    || pairing.id !== pairingId || certificate.pairingId !== pairingId || certificate.pairingCode !== expectedCode
    || certificate.generation !== state.session.grantGeneration
    || canonicalize(certificate.browserSigningPublicJwk) !== canonicalize(state.identity.signingPublicJwk)
    || canonicalize(certificate.browserEncryptionPublicJwk) !== canonicalize(state.identity.encryptionPublicJwk)) {
    throw new Error("The desktop approval did not match this browser.");
  }
  const certificateCode = await pairingCodeForKeys({
    pairingId: certificate.pairingId,
    browserId: certificate.browserId,
    signingPublicJwk: certificate.browserSigningPublicJwk,
    encryptionPublicJwk: certificate.browserEncryptionPublicJwk,
  });
  if (certificateCode !== expectedCode) throw new Error("The desktop approval did not match this browser.");
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
        <div class="rail-brand"><span class="brand"><img class="brand-mark" src="/work-fold-icon.svg" alt="" />work-fold</span></div>
        <button id="new-chat" class="rail-new-chat" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
          <span>New chat</span>
        </button>
        <p class="rail-heading">Chats</p>
        <ul id="chats" class="chat-list"></ul>
        <div class="rail-spacer"></div>
        <div class="rail-account">
          <button id="account-settings" class="account-settings" type="button" aria-label="Settings" title="Settings" aria-controls="account-menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
          </button>
          <div id="account-menu" class="account-menu" hidden><button id="logout" type="button">Sign out</button></div>
        </div>
      </aside>
      <main class="conversation">
        <header class="conversation-bar">
          <span aria-hidden="true"></span>
          <h1 id="conversation-title"></h1>
          <div class="conversation-actions"><button id="stop-task" class="toolbar-button danger" type="button" hidden>Stop</button></div>
        </header>
        <div id="banner"></div>
        <div id="chat-status" class="sr-only" role="status" aria-live="polite"></div>
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
          <strong class="files-title">Files</strong>
          <button id="toggle-files" class="files-toggle" type="button" aria-label="Hide Files" aria-expanded="true" title="Hide Files">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          </button>
        </div>
        <div class="workspace-pane-content">
          <select id="space-picker" class="space-picker" aria-label="Choose a Space"></select>
          <div id="file-tree" class="file-tree"></div>
        </div>
      </aside>
    </div>`;
  document.querySelector("#logout")?.addEventListener("click", () => void logout());
  document.querySelector("#account-settings")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = document.querySelector("#account-menu");
    setAccountMenuOpen(menu?.hidden !== false);
  });
  document.querySelector("#account-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => setAccountMenuOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector("#account-menu")?.hidden === false) {
      setAccountMenuOpen(false);
      document.querySelector("#account-settings")?.focus();
    }
  });
  document.querySelector("#new-chat")?.addEventListener("click", startNewChat);
  document.querySelector("#stop-task")?.addEventListener("click", () => void stopCurrentTask());
  document.querySelector("#toggle-files")?.addEventListener("click", () => setFilesPanelOpen(!state.filesPanelOpen));
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
  const request = state.startingNewChat ? null : state.summary?.latestRequest;
  const requestPhase = request?.phase;
  const workEvents = requestEvents(request);
  const working = !state.startingNewChat && (
    state.summary?.state === "running" || requestPhase === "working" || requestPhase === "handed_off"
  );
  const latestVisible = visible.at(-1);
  const previousMessageId = container.dataset.latestMessageId;
  if (latestVisible?.id) {
    container.dataset.latestMessageId = latestVisible.id;
    if (container.dataset.rendered && previousMessageId && previousMessageId !== latestVisible.id) {
      const status = document.querySelector("#chat-status");
      if (status) status.textContent = latestVisible.role === "assistant" ? "New reply from work-fold." : "Message sent.";
    }
  }
  container.innerHTML = `<div class="message-stream">${state.transcriptTruncated ? `<div class="projection-notice">Earlier messages are hidden.</div>` : ""}${visible.length ? visible.map((message) => `
    <article class="message ${message.role} ${message.source === "remote_web" ? "web" : ""}">
      <div class="message-role">${message.role === "assistant" ? escapeHtml(assistantLabel()) : "You"}</div>
      <div class="message-content"><div class="message-body markdown">${renderMarkdown(message.content)}</div>${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((attachment) => `<span>${fileGlyph(attachment.kind)}${escapeHtml(attachment.name)}</span>`).join("")}</div>` : ""}</div>
    </article>`).join("") : ""}
    ${workEvents.map((event) => `<div class="work-event ${event.state}"${event.title ? ` title="${escapeAttribute(event.title)}"` : ""}><span class="work-event-mark" aria-hidden="true"></span><span>${event.html}</span></div>`).join("")}
    ${working && !workEvents.some((event) => event.state === "running") ? `<div class="working-row"><span class="spinner"></span><span>Working</span></div>` : ""}
  </div>`;
  container.dataset.rendered = "true";
  if (wasNearBottom) container.scrollTop = container.scrollHeight;
  renderBanner();
}

function requestEvents(request) {
  if (!request || typeof request !== "object") return [];
  const events = [];
  const children = Array.isArray(request.children) ? request.children : [];
  for (const child of children) {
    if (!child?.spaceName) continue;
    const spaceName = `<strong>${escapeHtml(child.spaceName)}</strong>`;
    if (child.state === "running") events.push({ state: "running", html: `Working in ${spaceName}` });
    else if (child.state === "succeeded") events.push({ state: "succeeded", html: `Worked in ${spaceName}` });
    else if (child.state === "aborted") events.push({ state: "stopped", html: `Stopped in ${spaceName}` });
    else if (child.state === "failed" || child.state === "unknown") {
      events.push({ state: "failed", html: `Couldn’t finish in ${spaceName}`, title: child.error || request.error || "" });
    }
  }
  const dispositions = Array.isArray(request.dispositions) ? request.dispositions : [];
  for (const disposition of dispositions) {
    const attachment = disposition?.attachment?.name;
    const spaceName = disposition?.spaceName;
    if (!attachment || !spaceName) continue;
    if (disposition.status === "placed") {
      events.push({ state: "succeeded", html: `Placed <strong>${escapeHtml(attachment)}</strong> in <strong>${escapeHtml(spaceName)}</strong>` });
    } else if (disposition.status === "registered") {
      events.push({ state: "succeeded", html: `Added <strong>${escapeHtml(attachment)}</strong> as <strong>${escapeHtml(spaceName)}</strong>` });
    }
  }
  if (request.phase === "failed" && !events.some((event) => event.state === "failed")) {
    events.push({ state: "failed", html: "Couldn’t finish", title: request.error || "" });
  } else if (request.phase === "stopped" && !events.some((event) => event.state === "stopped")) {
    events.push({ state: "stopped", html: "Stopped" });
  }
  return events;
}

async function refreshConversation({ loadTranscript = true } = {}) {
  try {
    if (state.startingNewChat || !state.selectedConversationId) {
      state.summary = { state: "idle" };
      state.messages = [];
      state.transcriptConversationId = null;
      state.transcriptTruncated = false;
      renderConversationChrome();
      renderMessages();
      return;
    }
    state.summary = await remote("management.summary", { conversationId: state.selectedConversationId });
    const summaryPhase = state.summary?.latestRequest?.phase;
    const latest = state.summary?.latestRequest;
    const active = state.summary?.state === "running" || summaryPhase === "working" || summaryPhase === "handed_off";
    if (active && latest?.canStop === true && typeof latest.taskId === "string") {
      state.activeTasks.set(state.selectedConversationId, { taskId: latest.taskId, conversationId: state.selectedConversationId });
    } else {
      state.activeTasks.delete(state.selectedConversationId);
    }
    const settlementKey = !active && latest?.startedAt
      ? `${state.selectedConversationId}:${latest.startedAt}`
      : null;
    if (settlementKey && !state.settledTreeRefreshes.has(settlementKey)) {
      state.settledTreeRefreshes.add(settlementKey);
      await refreshExplorerTree();
    }
    updateConnection(true);
    if (loadTranscript) {
      if (state.transcriptConversationId !== state.selectedConversationId) {
        document.querySelector("#messages")?.removeAttribute("data-latest-message-id");
      }
      const transcript = await remote("management.transcript", { conversationId: state.selectedConversationId });
      state.messages = transcript.messages ?? [];
      state.transcriptConversationId = state.selectedConversationId;
      state.transcriptTruncated = transcript.truncated === true;
    }
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
  const sentDraftKey = currentComposerDraftKey();
  try {
    const attachments = await serializeUploads();
    const request = {
      content,
      ...(state.startingNewChat || !state.selectedConversationId
        ? { newConversation: true }
        : { conversationId: state.selectedConversationId }),
      ...(attachments.length ? { attachments } : {}),
    };
    const result = await remote("management.send", request);
    state.startingNewChat = false;
    state.selectedConversationId = result.conversationId;
    if (result.taskId) state.activeTasks.set(result.conversationId, {
      taskId: result.taskId,
      conversationId: result.conversationId,
    });
    else state.activeTasks.delete(result.conversationId);
    state.composerDrafts.delete(sentDraftKey);
    input.value = "";
    state.uploads = [];
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
  saveComposerDraft();
  state.startingNewChat = true;
  state.selectedConversationId = null;
  state.messages = [];
  state.transcriptConversationId = null;
  document.querySelector("#messages")?.removeAttribute("data-latest-message-id");
  state.transcriptTruncated = false;
  state.banner = "";
  restoreComposerDraft();
  renderConversationChrome();
  renderConversations();
  renderMessages();
  syncComposer();
  document.querySelector("#prompt")?.focus({ preventScroll: true });
}

function currentComposerDraftKey() {
  return state.startingNewChat || !state.selectedConversationId
    ? "new-chat"
    : `chat:${state.selectedConversationId}`;
}

function saveComposerDraft() {
  const input = document.querySelector("#prompt");
  if (!input) return;
  const content = input.value;
  if (!content && !state.uploads.length) state.composerDrafts.delete(currentComposerDraftKey());
  else state.composerDrafts.set(currentComposerDraftKey(), { content, uploads: [...state.uploads] });
}

function restoreComposerDraft() {
  const input = document.querySelector("#prompt");
  if (!input) return;
  const draft = state.composerDrafts.get(currentComposerDraftKey());
  input.value = draft?.content ?? "";
  state.uploads = [...(draft?.uploads ?? [])];
  syncComposer();
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
  const previous = state.conversations.find((conversation) => conversation.id === state.selectedConversationId) ?? null;
  const result = await remote("management.chats");
  state.conversations = (result.conversations ?? []).filter((conversation) => !conversation.archivedAt);
  state.chatListTruncated = result.truncated === true;
  const selected = preferredConversationId && state.conversations.some((conversation) => conversation.id === preferredConversationId)
    ? preferredConversationId
    : state.conversations[0]?.id ?? null;
  const target = state.startingNewChat ? null : selected;
  if (target !== state.selectedConversationId) {
    saveComposerDraft();
    state.selectedConversationId = target;
    restoreComposerDraft();
  }
  renderConversations();
  renderConversationChrome();
  if (refreshTranscript) {
    const current = state.conversations.find((conversation) => conversation.id === state.selectedConversationId) ?? null;
    const transcriptChanged = !previous || !current || previous.id !== current.id || previous.updatedAt !== current.updatedAt;
    await refreshConversation({
      loadTranscript: transcriptChanged || state.transcriptConversationId !== state.selectedConversationId,
    });
  }
}

function renderConversations() {
  const list = document.querySelector("#chats");
  if (!list) return;
  list.innerHTML = state.conversations.length ? `${state.conversations.map((conversation) => `
    <li><button class="chat-button ${conversation.id === state.selectedConversationId && !state.startingNewChat ? "active" : ""}" data-chat-id="${escapeAttribute(conversation.id)}" ${conversation.id === state.selectedConversationId && !state.startingNewChat ? 'aria-current="page"' : ""}>
      <span class="chat-title">${escapeHtml(conversation.title)}</span>
      <span class="chat-meta">${conversation.state === "running" ? "Working" : shortDate(conversation.updatedAt)}</span>
    </button></li>`).join("")}${state.chatListTruncated ? `<li class="empty-list">Older chats hidden</li>` : ""}` : `<li class="empty-list">No chats</li>`;
  for (const button of list.querySelectorAll("[data-chat-id]")) {
    button.addEventListener("click", () => void selectConversation(button.dataset.chatId));
  }
}

async function selectConversation(conversationId) {
  if (state.sending || !conversationId) return;
  saveComposerDraft();
  state.startingNewChat = false;
  state.selectedConversationId = conversationId;
  restoreComposerDraft();
  state.banner = "";
  renderConversations();
  renderConversationChrome();
  await refreshConversation();
}

async function loadTree(spaceId, path) {
  const key = `${spaceId}:${path}`;
  state.treeStatus.set(key, "loading");
  renderWorkspace();
  try {
    const result = await remote("spaces.tree", { spaceId, path });
    state.trees.set(key, result.tree ?? []);
    state.treeTruncated.set(key, result.truncated === true);
    state.treeStatus.set(key, "loaded");
  } catch (error) {
    state.treeStatus.set(key, "error");
    state.banner = errorText(error);
    renderBanner();
  }
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
  const title = document.querySelector("#conversation-title");
  const prompt = document.querySelector("#prompt");
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
  if (title) title.textContent = state.startingNewChat || !selected ? "New chat" : selected.title;
  if (prompt) prompt.placeholder = "Message work-fold";
  const stop = document.querySelector("#stop-task");
  if (stop) stop.hidden = !state.selectedConversationId || !state.activeTasks.has(state.selectedConversationId);
}

function renderWorkspace() {
  const picker = document.querySelector("#space-picker");
  const tree = document.querySelector("#file-tree");
  if (picker) {
    picker.innerHTML = state.spaces.map((space) => `<option value="${escapeAttribute(space.id)}" ${space.id === state.explorerSpaceId ? "selected" : ""}>${escapeHtml(space.name)}</option>`).join("");
    picker.disabled = !state.spaces.length;
  }
  if (!tree) return;
  if (!state.explorerSpaceId) {
    tree.innerHTML = `<div class="file-empty">No Spaces</div>`;
    return;
  }
  const entries = state.trees.get(`${state.explorerSpaceId}:`) ?? [];
  tree.setAttribute("aria-busy", String(state.treeStatus.get(`${state.explorerSpaceId}:`) === "loading"));
  tree.innerHTML = renderTreeRows(state.explorerSpaceId, entries, "", 0);
  for (const button of tree.querySelectorAll("[data-tree-path]")) {
    button.addEventListener("click", () => void toggleTree(button.dataset.spaceId, button.dataset.treePath));
  }
}

function renderTreeRows(spaceId, entries, path, depth) {
  const key = `${spaceId}:${path}`;
  const status = state.treeStatus.get(key);
  if (status === "loading" || (!status && !state.trees.has(key))) return `<div class="file-empty">Loading…</div>`;
  if (status === "error") return `<div class="file-empty error">Couldn’t load</div>`;
  const truncated = state.treeTruncated.get(`${spaceId}:${path}`) === true;
  if (!entries.length) return `<div class="file-empty">Empty</div>`;
  return `${truncated ? `<div class="tree-notice">First 500 items. Ignored files omitted.</div>` : ""}${entries.map((entry) => {
    const expanded = entry.kind === "folder" && state.expanded.has(`${spaceId}:${entry.path}`);
    const children = expanded ? state.trees.get(`${spaceId}:${entry.path}`) ?? [] : [];
    return `<div class="file-node">
      <div class="file-row" style="--depth:${depth}">
        ${entry.kind === "folder" ? `<button class="file-main" type="button" data-space-id="${escapeAttribute(spaceId)}" data-tree-path="${escapeAttribute(entry.path)}" aria-expanded="${String(expanded)}">` : `<div class="file-main">`}
          <span class="tree-caret" aria-hidden="true">${entry.kind === "folder" ? expanded ? "⌄" : "›" : ""}</span>${fileGlyph(entry.kind)}<span class="file-name">${escapeHtml(entry.name)}</span>
        ${entry.kind === "folder" ? `</button>` : `</div>`}
        ${entry.kind === "file" ? `<span class="file-size">${formatBytes(entry.sizeBytes)}</span>` : ""}
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

async function refreshExplorerTree() {
  const spaceId = state.explorerSpaceId;
  if (!spaceId) return;
  for (const key of [...state.trees.keys()]) if (key.startsWith(`${spaceId}:`)) state.trees.delete(key);
  for (const key of [...state.treeStatus.keys()]) if (key.startsWith(`${spaceId}:`)) state.treeStatus.delete(key);
  for (const key of [...state.treeTruncated.keys()]) if (key.startsWith(`${spaceId}:`)) state.treeTruncated.delete(key);
  for (const key of [...state.expanded]) if (key.startsWith(`${spaceId}:`)) state.expanded.delete(key);
  await loadTree(spaceId, "");
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

async function stopCurrentTask() {
  const task = state.selectedConversationId ? state.activeTasks.get(state.selectedConversationId) : null;
  if (!task) return;
  const button = document.querySelector("#stop-task");
  if (button) button.disabled = true;
  try {
    await remote("management.stop", { taskId: task.taskId });
    state.activeTasks.delete(task.conversationId);
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
  const uploads = state.uploads.map((file, index) => ({ kind: "upload", name: file.name, index }));
  container.innerHTML = uploads.map((item) => `<span class="context-chip">${fileGlyph("file")}<span>${escapeHtml(item.name)}</span><button type="button" data-remove-upload="${item.index}" aria-label="Remove ${escapeAttribute(item.name)}">×</button></span>`).join("");
  for (const button of container.querySelectorAll("[data-remove-upload]")) button.addEventListener("click", () => {
    state.uploads.splice(Number(button.dataset.removeUpload), 1);
    syncComposer();
  });
}

function setFilesPanelOpen(open) {
  state.filesPanelOpen = open;
  document.querySelector(".app-shell")?.classList.toggle("files-closed", !open);
  const button = document.querySelector("#toggle-files");
  button?.setAttribute("aria-expanded", String(open));
  button?.setAttribute("aria-label", open ? "Hide Files" : "Show Files");
  if (button) button.title = open ? "Hide Files" : "Show Files";
}

function setAccountMenuOpen(open) {
  const button = document.querySelector("#account-settings");
  const menu = document.querySelector("#account-menu");
  if (!button || !menu) return;
  button.setAttribute("aria-expanded", String(open));
  menu.hidden = !open;
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

function assistantLabel() { return "work-fold"; }

function scheduleRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  const phase = state.summary?.latestRequest?.phase;
  const active = state.summary?.state === "running" || phase === "working" || phase === "handed_off";
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
  state.eventSource.addEventListener("ready", (raw) => {
    const payload = JSON.parse(raw.data);
    updateConnection(payload.desktopOnline === true);
  });
  state.eventSource.addEventListener("remote", (raw) => {
    void receiveRemoteEvent(JSON.parse(raw.data)).catch((error) => {
      state.banner = errorText(error);
      renderBanner();
    });
  });
  state.eventSource.onerror = () => updateConnection(false);
}

async function receiveRemoteEvent(event) {
  if (event.type === "presence") {
    updateConnection(event.desktopOnline === true);
    return;
  }
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
