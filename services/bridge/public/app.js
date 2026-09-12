import { buildWorkFixture } from "./work-fixtures.js";
import { clearQuestionDrafts } from "./question-drafts.js";
import { renderExtensionQuestions } from "./extension-questions.js";
import { renderWorkRequest } from "./work-request.js";
import { scheduleBrowserRefresh, deferAfterRateLimit, canResume, canRecover, pollDelay } from "./refresh.js";
import { shouldSubmitComposerKey } from "./composer.js";
import { browserApiPath } from "./api-path.js";
import { buildFixture, createFixtureAppActions, fixtureAppEntry } from "./fixtures.js";
import { renderLanding } from "./landing.js";
import { renderMarkdown } from "./markdown.js";
import { createFilePreview } from "./file-preview.js";
import { createBrowserAppView } from "./browser-app.js";
import { requestResultLinks } from "./request-results.js";
import { assertPairingRelay, pairingCodeForKeys } from "./pairing-code.js";
import { normalizeChatTitle, replaceHtmlIfChanged } from "./rendering.js";
import { groupConversationsByDate } from "./date-groups.js";

const app = document.querySelector("#app");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const localSlug = new URL(location.href).searchParams.get("slug") || "";
// Touch keyboards have no Shift+Enter, so their return key writes newlines
// and the send button sends; hardware keyboards keep Enter-to-send.
const coarsePointer = matchMedia("(pointer: coarse)").matches;

// ?fixture=new|chat|needs|spaces renders canned local state for QA (the desktop
// renderer's ?fixture=space precedent). Fixture mode is client-side only and
// inert against the real API: api() and remote() refuse before any fetch or
// auth material is touched, and the event stream never opens.
const fixtureName = (() => {
  const requested = new URL(location.href).searchParams.get("fixture");
  if (requested === "home" || requested === "chats") return "new";
  if (requested === "files") return "spaces";
  if (requested === "needs") return "chat";
  return requested === "new" || requested === "chat" || requested === "spaces" ? requested : null;
})();
const fixtureCapture = fixtureName !== null && new URL(location.href).searchParams.get("capture") === "1";

// Fixture-only chrome overrides, so a QA screenshot can capture the collapsed
// sidebar and the open drawer. They are read only while a fixture is showing.
const fixtureChrome = (() => {
  if (!fixtureName) return { sidebar: null, drawer: false };
  const parameters = new URL(location.href).searchParams;
  return {
    sidebar: parameters.get("sidebar") === "collapsed" ? "collapsed" : parameters.get("sidebar") === "expanded" ? "expanded" : null,
    drawer: parameters.get("drawer") === "open",
  };
})();

// The conversation and folder screens of the client. One is visible at a time on every width; the
// chrome around them differs (sidebar on desktop, top bar plus drawer on the
// phone) but the screens themselves are the same.
const contextNames = ["new", "chat", "spaces"];

// The sidebar's desktop state outlives the tab: it is a workspace preference,
// not a per-visit one.
const sidebarStorageKey = "work-fold-remote-sidebar-v1";
const phoneQuery = matchMedia("(max-width: 859.98px)");

const state = {
  work: null,
  workError: "",
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
  explorerTab: "files",
  trees: new Map(),
  treeStatus: new Map(),
  expanded: new Set(),
  conversations: [],
  chatListTruncated: false,
  selectedConversationId: null,
  uploads: [],
  composerDrafts: new Map(),
  contextName: "new",
  sidebarState: readSidebarState(),
  drawerOpen: false,
  messages: [],
  transcriptConversationId: null,
  transcriptTruncated: false,
  treeTruncated: new Map(),
  settledTreeRefreshes: new Set(),
  summary: null,
  activeTasks: new Map(),
  banner: "",
  stoppingTask: false,
  refreshTimer: null,
  conversationListRequestVersion: 0,
  conversationRefreshVersion: 0,
  sending: false,
  startingNewChat: false,
  renamingConversationId: null,
  renameSaving: false,
  conversationsLoaded: false,
  spacesLoaded: false,
  filePreviewAvailable: false,
  appViewsAvailable: false,
  spaceApps: new Map(),
  transcriptLoading: false,
  sessionRebooting: false,
  rateLimitedUntil: 0,
  refreshTick: 0,
  lastResumeAt: 0,
  watchToken: null,
  watchOperationId: null,
  watchUnsupported: false,
  liveActivity: "",
  liveAssistantText: "",
  liveAssistantTextTruncated: false,
};

let filePreview = null;
function openFilePreview(spaceId, path) {
  const space = state.spaces.find((item) => item.id === spaceId);
  filePreview ??= createFilePreview({
    available: () => Boolean(fixtureName || state.filePreviewAvailable),
    online: () => Boolean(state.session?.desktopOnline),
    fetchPreview: readSpaceFilePreview,
  });
  void filePreview.open({ spaceId, path, spaceName: space?.name ?? "Space" });
}

async function readSpaceFilePreview(selectedSpaceId, selectedPath) {
  if (fixtureName) {
    const text = selectedPath.endsWith(".csv") ? "item,next_step\nTwo invoices,Match purchase orders\nTravel,Reconcile category labels"
      : selectedPath === "delivery-plan.md" ? "# Delivery plan\n\nDelivery target: five days."
      : selectedPath === "notes.md" ? `# Field notes\n\n${"Keep the original quote and delivery estimate together so the next review has the same evidence.\n\n".repeat(60)}`
        : "# Quarterly summary\n\nRevenue is up **12%**.\n\n| Item | Next step |\n|---|---|\n| Two invoices | Match purchase orders |\n| Travel | Reconcile category labels |";
    return { spaceId: selectedSpaceId, path: selectedPath, kind: "text", format: selectedPath.endsWith(".md") ? "markdown" : "text", text, truncated: false };
  }
  return (await remote("spaces.filePreview", { spaceId: selectedSpaceId, path: selectedPath })).preview;
}

let inlineFilePreview = null;
function closeInlinePreview() { inlineFilePreview?.destroy(); inlineFilePreview = null; }
function closeFilePreview() { filePreview?.destroy(); filePreview = null; closeInlinePreview(); }
function openSpaceFile(spaceId, path) {
  const container = document.querySelector("#space-preview");
  const empty = document.querySelector("#space-preview-empty");
  const space = state.spaces.find((item) => item.id === spaceId);
  if (!container || !space) return;
  inlineFilePreview ??= createFilePreview({ container, fetchPreview: readSpaceFilePreview,
    available: () => Boolean(fixtureName || state.filePreviewAvailable),
    online: () => Boolean(state.session?.desktopOnline),
    askAboutFile: (file) => draftSpaceQuestion(file.spaceId, file.path),
    onClose: () => { if (empty) empty.hidden = false; },
  });
  if (empty) empty.hidden = true;
  void inlineFilePreview.open({ spaceId, path, spaceName: space.name });
  container.scrollIntoView?.({ block: "nearest", behavior: "instant" });
}
function draftSpaceQuestion(spaceId, path = null) {
  const space = state.spaces.find((item) => item.id === spaceId);
  if (!space || state.sending || state.renameSaving) return;
  startNewChat();
  const prompt = document.querySelector("#prompt");
  if (!prompt) return;
  const reference = `I’d like to work ${path ? `on the file ${JSON.stringify(path)} in` : "in"} the folder ${JSON.stringify(space.name)} (Folder ID: ${space.id}).`;
  prompt.value = prompt.value ? `${prompt.value}\n\n${reference}\n\n` : `${reference}\n\n`;
  syncComposer(); saveComposerDraft(); persistDrafts();
  prompt.focus({ preventScroll: true });
}

let browserApp = null;
const fixtureAppActions = createFixtureAppActions();
function openBrowserApp(spaceId, installationId) {
  const selected = (state.spaceApps.get(spaceId) ?? []).find((app) => app.featureInstallationId === installationId);
  if (!selected) return;
  void browserAppController().open({ ...selected, spaceName: state.spaces.find((space) => space.id === spaceId)?.name ?? "Space" });
}
function openBrowserAppResult(reference) {
  void browserAppController().open({ ...reference, title: reference.label, webView: true, sourceDigest: reference.digest,
    spaceName: state.spaces.find((space) => space.id === reference.spaceId)?.name ?? "Space" });
}
function browserAppController() {
  browserApp ??= createBrowserAppView({
    actions: async (app, operation, input) => {
      if (fixtureName) return fixtureAppActions(app, operation, input);
      const { spaceId, appId, featureInstallationId, digest, authorityDigest } = app;
      return remote(`apps.actions.${operation}`, { spaceId, appId, featureInstallationId, digest, authorityDigest, ...input });
    },
    online: () => Boolean(state.session?.desktopOnline),
    resolve: async (app) => {
      if (fixtureName) return (state.spaceApps.get(app.spaceId) ?? []).find((item) => item.featureInstallationId === app.featureInstallationId);
      const result = await remote("apps.list", { spaceId: app.spaceId });
      return (result.apps ?? []).find((item) => item.featureInstallationId === app.featureInstallationId);
    },
    read: async (app, call) => {
      if (fixtureName) {
        const html = fixtureAppEntry;
        const result = call.kind === "entry" ? { kind: "entry", mediaType: "text/html", bytes: btoa(html) }
          : call.kind === "data.get" ? { kind: "data.get", key: call.key, present: true, value: { supplier: "North", unitPrice: 42, days: 4 } }
            : { kind: "data.keys", keys: ["quotes:north"] };
        return { state: "served", result: { ok: true, result } };
      }
      const { spaceId, appId, featureInstallationId, digest, authorityDigest } = app;
      return remote("apps.read", { spaceId, appId, featureInstallationId, digest, authorityDigest, call });
    },
  });
  return browserApp;
}

void boot();

window.addEventListener("popstate", onPopState);
window.addEventListener("online", () => resumeLiveConnection());
window.addEventListener("pagehide", () => {
  saveComposerDraft();
});
// Web fonts reflow the transcript after the boot pin; once they settle, a
// still-near-bottom view re-pins so the newest message stays on screen.
document.fonts?.ready?.then(() => {
  if (state.contextName !== "chat") return;
  const container = document.querySelector("#messages");
  if (!container) return;
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 360) {
    container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
  }
  updateJumpLatest();
});

// With the on-screen keyboard up, keep the newest message pinned above it.
window.visualViewport?.addEventListener("resize", () => {
  if (state.contextName !== "chat") return;
  const container = document.querySelector("#messages");
  if (!container) return;
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 120) {
    container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
  }
});

async function boot() {
  // One microtask so every module-level declaration below finishes
  // initializing before the synchronous fixture path renders.
  await Promise.resolve();
  if (fixtureName) return bootFixture(fixtureName);
  state.sessionRebooting = false;
  state.session = null;
  try {
    state.identity = await loadIdentity();
    state.context = await api(`/api/public/context${localSlug ? `?slug=${encodeURIComponent(localSlug)}` : ""}`);
    if (!state.context.addressAvailable) return renderAddressUnavailable();
    if (!state.context.authenticated) return renderLogin();
    state.session = await api("/api/auth/session");
    await continueAuthenticated();
  } catch (error) {
    if (error?.status === 401 && state.context?.addressAvailable) return renderLogin();
    renderFatal(errorText(error));
  }
}

function bootFixture(name) {
  const fixture = buildFixture(name);
  Object.assign(state, fixture.state);
  if (new URL(location.href).searchParams.get("extensions") === "1") {
    state.summary = { ...state.summary, conversation: { id: state.selectedConversationId }, extensionRequests: [
      { id: "fixture-extension", taskId: "fixture-task", method: "select", title: "Which account should I use for the report?", options: ["Work account", "Personal account"] },
    ] };
  }
  const workFixture = new URL(location.href).searchParams.get("work");
  if (["question", "saved-answer", "partial", "interrupted"].includes(workFixture)) {
    state.work = buildWorkFixture(state.selectedConversationId, workFixture);
    state.activeTasks.clear(); state.liveAssistantText = ""; state.liveActivity = "";
    state.conversations = state.conversations.map((chat) => chat.id === state.selectedConversationId ? { ...chat, title: "Kitchen budget", state: "idle" } : chat);
    state.messages = [
      { id: "work-user", role: "user", content: "Compare the supplier quotes and put together a budget for the kitchen refresh." },
      { id: "work-assistant", role: "assistant", content: "I’ve asked the worker in Supplier quotes to check the totals. I’ll bring the comparison back here." },
    ];
    state.summary = { state: "idle", latestRequest: { phase: "needs_you", children: [], actions: [], dispositions: [] } };
  }
  if (fixtureChrome.sidebar) state.sidebarState = fixtureChrome.sidebar;
  renderApplication();
  renderMessages();
  showContext(name);
  if (fixtureChrome.drawer) openDrawer({ moveFocus: false });
}

function readSidebarState() {
  try {
    return localStorage.getItem(sidebarStorageKey) === "collapsed" ? "collapsed" : "expanded";
  } catch { return "expanded"; }
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
  if (!state.context.slug) return renderLanding(app);
  renderAuth({
    eyebrow: "work-fold agent",
    headline: "This address isn’t active.",
    supporting: `Check the address, or enable web access from the <span class="nobr">work-fold</span> desktop app.`,
    panel: "",
  });
}

function renderLogin(error = "") {
  renderAuth({
    eyebrow: "work-fold agent",
    headline: `Welcome back${state.context.slug ? `, ${escapeHtml(state.context.slug)}` : ""}.`,
    supporting: "Your desktop must be online.",
    panel: `
      <form id="login-form">
        <h2>Sign in</h2>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required autofocus /></div>
        <button class="primary" type="submit">Sign in</button>
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
    // The error lands in the standing form instead of a full re-render, so
    // focus stays in the field and the phone keyboard stays up.
    const standing = document.querySelector("#login-form");
    if (!standing) return renderLogin(errorText(error));
    button.disabled = false;
    button.textContent = "Sign in";
    let errorNode = standing.querySelector(".form-error");
    if (!errorNode) {
      errorNode = document.createElement("p");
      errorNode.className = "form-error";
      errorNode.setAttribute("role", "alert");
      standing.append(errorNode);
    }
    if (errorNode.textContent !== errorText(error)) errorNode.textContent = errorText(error);
    const password = standing.querySelector("#password");
    password?.focus();
    password?.select();
  }
}

async function startPairing() {
  if (!state.session.desktopOnline) {
    return renderAuth({
      eyebrow: "Desktop offline",
      headline: `Open <span class="nobr">work-fold</span> to continue.`,
      panel: `<button id="retry" class="primary">Try again</button>`,
    }, () => {
      const retry = document.querySelector("#retry");
      retry?.addEventListener("click", () => location.reload());
      // The gate notices the desktop coming online by itself and continues
      // to pairing without needing the button.
      const timer = setInterval(async () => {
        if (!retry || !document.contains(retry)) return clearInterval(timer);
        try {
          const session = await api("/api/auth/session");
          if (!session.desktopOnline) return;
          clearInterval(timer);
          state.session = session;
          await startPairing();
        } catch {
          // Keep waiting; the button and a reload both remain available.
        }
      }, 4_000);
    });
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
    eyebrow: "Confirm this browser once",
    headline: `Match the code in <span class="nobr">work-fold</span>.`,
    panel: `
      <h2>Confirm ${escapeHtml(browserLabel())}</h2>
      <p>Confirm that the same six digits appear in the desktop prompt.</p>
      <div class="pairing-code" aria-label="Pairing code ${escapeHtml(state.pairingExpectedCode || "")}">${escapeHtml(state.pairingExpectedCode || "")}</div>
      ${error
        ? `<p class="form-error">${escapeHtml(error)}</p><button id="pairing-retry" class="primary" type="button">Try again</button>`
        : `<div class="pairing-status"><span class="spinner" aria-hidden="true"></span><span>Waiting for your desktop…</span></div>`}
    `,
  }, () => {
    // A declined, expired, or failed pairing restarts with a fresh code in
    // place — the installed PWA has no address bar to reload from.
    document.querySelector("#pairing-retry")?.addEventListener("click", () => {
      void startPairing().catch((retryError) => renderPairing(errorText(retryError)));
    });
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
    if (state.pairing.status !== "approved") return renderPairing("Your desktop did not pair this browser. Refresh to try again.");
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
    throw new Error("The pairing from your desktop did not match this browser.");
  }
  const certificateCode = await pairingCodeForKeys({
    pairingId: certificate.pairingId,
    browserId: certificate.browserId,
    signingPublicJwk: certificate.browserSigningPublicJwk,
    encryptionPublicJwk: certificate.browserEncryptionPublicJwk,
  });
  if (certificateCode !== expectedCode) throw new Error("The pairing from your desktop did not match this browser.");
  const valid = await verifyText(
    state.session.deviceSigningPublicJwk,
    canonicalize(certificate),
    pairing.approvalSignature,
  );
  if (!valid) throw new Error("The pairing signature from your desktop could not be verified.");
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
  restorePersistedDrafts();
  renderApplication();
  const requested = parseLocationHash();
  showContext(requested.context === "chat" && requested.conversationId ? "new" : requested.context, { fromHistory: true });
  restoreComposerDraft();
  openEvents();
  await loadSpaces();
  // The desktop being offline is presence, not a broken app: the shell stays
  // up with the honest presence line and the refresh loop keeps trying.
  try {
    await loadConversations(requested.conversationId ? { preferredConversationId: requested.conversationId } : {});
    if (requested.context === "chat" && requested.conversationId && state.selectedConversationId === requested.conversationId) {
      showContext("chat", { fromHistory: true });
    }
  } catch (error) {
    state.banner = errorText(error);
    if (state.banner.toLowerCase().includes("offline")) updateConnection(false);
    renderBanner();
  }
  history.replaceState({ context: state.contextName }, "", contextHash(state.contextName));
  scheduleRefresh();
}

// --- History: each screen is a history entry, so the browser's back gesture
// walks Chat → New chat instead of leaving the app, and a reload restores the
// screen (and conversation) it left. The retired `#home` and `#chats` hashes
// land on the New chat screen rather than dead-ending. --------------------

function contextHash(name) {
  if (name === "chat" && state.selectedConversationId) return `#chat=${encodeURIComponent(state.selectedConversationId)}`;
  return `#${name}`;
}

function parseLocationHash() {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("chat=")) {
    const conversationId = decodeURIComponent(raw.slice("chat=".length));
    return { context: "chat", conversationId: conversationId || null };
  }
  if (raw === "needs") return { context: "chat", conversationId: state.selectedConversationId };
  // `#files` remains an internal route for the folder screen; a link from
  // that window still lands where it meant to.
  if (raw === "files") return { context: "spaces", conversationId: null };
  return { context: contextNames.includes(raw) ? raw : "new", conversationId: null };
}

function onPopState() {
  if (fixtureName || !document.querySelector(".app-shell")) return;
  const requested = parseLocationHash();
  if (requested.context === "chat" && requested.conversationId
    && requested.conversationId !== state.selectedConversationId
    && !state.sending && !state.renameSaving) {
    releaseConversationWatch();
    saveComposerDraft();
    cancelChatRename({ restoreFocus: false });
    state.startingNewChat = false;
    state.selectedConversationId = requested.conversationId;
    showContext("chat", { fromHistory: true });
    restoreComposerDraft();
    renderConversations();
    renderConversationChrome();
    void refreshConversation();
    return;
  }
  showContext(requested.context, { fromHistory: true });
}

// --- The shell: conversations and folders ---------------------------------
// New chat is the door; Chat holds the work and its questions; the folder view holds
// browsable files and apps. The sidebar exists
// once in the DOM: from 860px up it is the left column (expanded or collapsed
// to an icon rail), and below that the same markup is the drawer behind ☰.

function renderApplication() {
  closeInlinePreview();
  // A rebuilt shell starts from no context so the next showContext call
  // re-toggles every section even when the name is unchanged (session reboot
  // while browsing folders).
  state.contextName = null;
  app.innerHTML = `
    <div class="app-shell" data-context="new" data-sidebar="${escapeAttribute(state.sidebarState)}" data-drawer="closed">
      <div id="drawer-scrim" class="drawer-scrim"></div>
      <aside id="drawer" class="sidebar" aria-label="Menu">
        <div class="sidebar-head">
          <span class="sidebar-brand"><img src="/brand-mark.png" alt="" /></span>
          <button id="sidebar-toggle" class="rail-item sidebar-toggle" type="button" aria-label="Hide menu" data-tip="Hide menu" aria-controls="drawer">
            <svg class="glyph-collapse" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v13H4Z" /><path d="M9.5 5.5v13" /><path d="m16 9.5-2.5 2.5 2.5 2.5" /></svg>
            <svg class="glyph-expand" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v13H4Z" /><path d="M9.5 5.5v13" /><path d="m13.5 9.5 2.5 2.5-2.5 2.5" /></svg>
            <svg class="glyph-close" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div class="sidebar-actions">
          <button id="new-chat" class="rail-new-chat" type="button" data-nav-current="new" data-tip="New chat" aria-label="New chat">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
            <span class="sidebar-label">New chat</span>
          </button>
          <button class="sidebar-item sidebar-chats-item" type="button" data-sidebar-expand="true" data-tip="Chats" aria-label="Chats">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v11h-9l-4 3.5v-3.5H4Z" /></svg>
            <span class="sidebar-label">Chats</span>
          </button>

        </div>
        <div class="sidebar-chats">
          <ul id="chats" class="chat-list"></ul>
        </div>
        <div class="sidebar-foot">
          <div class="sidebar-footer-actions">
            <div class="folder-picker-shell">
            <button id="folder-picker-button" class="sidebar-item" type="button" data-tip="Folders" aria-label="Folders" aria-controls="folder-picker" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l1.8 2h9.2v9H3.5Z" /></svg>
              <span class="sidebar-label">Folders</span>
            </button>
            <div id="folder-picker" class="folder-picker" role="dialog" aria-label="Choose a folder" hidden></div>
            </div>
            <div class="rail-account">
              <button id="account-settings" class="account-settings" type="button" aria-label="Settings" data-tip="Settings" aria-controls="account-menu" aria-expanded="false" data-account-toggle="account-menu">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
              </button>
              <div id="account-menu" class="account-menu" hidden><button type="button" data-logout="true">Sign out</button></div>
            </div>
          </div>
          <p id="desktop-presence" class="presence" hidden><span class="presence-dot" aria-hidden="true"></span><span id="desktop-presence-text"></span></p>
        </div>
      </aside>
      <div class="app-main">
        <header class="top-bar">
          <button id="menu-button" class="rail-item top-bar-menu" type="button" aria-label="Menu" title="Menu" aria-controls="drawer" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div class="top-bar-center">
            <img class="top-bar-mark" src="/brand-mark.png" alt="work-fold" />
            <span id="top-bar-title" class="top-bar-title"></span>
            <div class="conversation-title-shell">
              <div id="conversation-title-view" class="conversation-title-view">
                <h1 id="conversation-title"></h1>
                <button id="rename-chat" class="conversation-title-button" type="button" aria-label="Rename chat" title="Rename chat">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                </button>
              </div>
              <form id="rename-chat-form" class="conversation-title-form" hidden>
                <label class="sr-only" for="rename-chat-input">Chat title</label>
                <input id="rename-chat-input" maxlength="80" autocomplete="off" />
                <button class="title-edit-action save" type="submit" aria-label="Save title" title="Save title">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                </button>
                <button id="cancel-chat-rename" class="title-edit-action" type="button" aria-label="Cancel" title="Cancel">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </form>
            </div>
          </div>
          <div class="top-bar-actions">
            <button id="top-new-chat" class="rail-item top-bar-new-chat" type="button" aria-label="New chat" title="New chat">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
            </button>
          </div>
        </header>
        <div class="app-contexts">
          ${fixtureName && !fixtureCapture ? `<div class="fixture-badge" role="status">Fixture preview</div>` : ""}
          <div id="banner"></div>
          <div id="chat-status" class="sr-only" role="status" aria-live="polite"></div>
          <section id="context-new" class="context context-new" aria-label="New chat">
            <div class="new-stage">
              <h1 class="new-heading" tabindex="-1">What are we working on?</h1>
            </div>
            <footer class="composer-wrap" id="new-composer-slot"></footer>
          </section>
          <section id="context-chat" class="context context-chat" aria-label="Chat" hidden>
            <section id="messages" class="messages" tabindex="0"><div class="message-stream"><div id="transcript-notice"></div><div id="message-rows"></div><div id="work-status"></div><div id="request-work"></div><div id="extension-questions"></div></div><button id="jump-latest" class="jump-latest" type="button" aria-label="Jump to newest" title="Jump to newest" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m-5-5 5 5 5-5" /></svg></button></section>
            <footer class="composer-wrap" id="chat-composer-slot"></footer>
          </section>
          <section id="context-spaces" class="context context-spaces" aria-label="Folders" hidden>
            <div class="space-workspace">
              <header class="space-workspace-header">
                <div class="space-title-row">
                  <h1 id="space-title" tabindex="-1">Folder</h1>
                  <button id="refresh-space" type="button" class="space-refresh" title="Refresh files and apps" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13.2 3M4.7 15a8 8 0 0 0 13.2 3" /></svg><span>Refresh</span></button>
                </div>
              </header>
              <div id="workspace-pane" class="workspace-pane" hidden>
                <nav class="space-views" aria-label="Folder view"><button type="button" data-space-view="files" aria-pressed="true">Files</button><button type="button" data-space-view="apps" aria-pressed="false">Apps</button></nav>
                <div id="space-files" class="space-files"><div id="file-tree" class="file-tree" aria-label="Folder files"></div><div id="space-preview" class="space-preview"><p id="space-preview-empty">Select a file</p></div></div>
                <section id="space-apps" class="space-apps" aria-label="Folder apps" hidden></section>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>`;
  const composer = document.createElement("form");
  composer.id = "composer";
  composer.className = "composer";
  composer.innerHTML = `
    <div id="composer-context" class="composer-context"></div>
    <div class="composer-field">
      <button id="attach-files" class="attach-button" type="button" aria-label="Attach files" title="Attach files">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.5 5.7-5.7a3 3 0 1 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2" /></svg>
      </button>
      <input id="file-input" type="file" multiple hidden />
      <textarea id="prompt" rows="1" maxlength="12000" placeholder="Message work-fold agent" aria-label="Message work-fold agent"${coarsePointer ? "" : " autofocus"}></textarea>
      <button class="send-button" type="submit" aria-label="Send message" aria-keyshortcuts="Enter" title="Send message" disabled>
        <svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-5 5 5-5 5 5" /></svg>
      </button>
      <button id="stop-task" class="send-button stop-button" type="button" aria-label="Stop work-fold" title="Stop work-fold" hidden>
        <svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
      </button>
    </div>`;
  document.querySelector("#new-composer-slot")?.append(composer);

  for (const button of document.querySelectorAll("[data-nav-context]")) {
    button.addEventListener("click", () => {
      closeDrawer({ restoreFocus: false });
      showContext(button.dataset.navContext, { moveFocus: true });
    });
  }
  for (const button of document.querySelectorAll("#new-chat, #top-new-chat")) {
    button.addEventListener("click", () => {
      closeDrawer({ restoreFocus: false });
      startNewChat();
    });
  }
  // The collapsed rail's Chats item has nowhere of its own to go: it opens the
  // list by expanding the sidebar.
  document.querySelector("[data-sidebar-expand]")?.addEventListener("click", () => setSidebarState("expanded", { moveFocus: true }));
  document.querySelector("#sidebar-toggle")?.addEventListener("click", () => {
    if (phoneQuery.matches) return closeDrawer();
    setSidebarState(state.sidebarState === "collapsed" ? "expanded" : "collapsed");
  });
  document.querySelector("#menu-button")?.addEventListener("click", () => openDrawer());
  document.querySelector("#drawer-scrim")?.addEventListener("click", () => closeDrawer());
  // A window that grows past the breakpoint leaves no drawer behind, and the
  // composer re-measures for the width it now has.
  phoneQuery.addEventListener("change", () => {
    if (!phoneQuery.matches) closeDrawer({ restoreFocus: false });
    syncSidebarChrome();
    syncComposer();
  });
  document.querySelector("#chats")?.addEventListener("click", (event) => {
    const chat = event.target.closest?.("[data-chat-id]");
    if (!chat) return;
    closeDrawer({ restoreFocus: false });
    void selectConversation(chat.dataset.chatId);
  });
  for (const button of document.querySelectorAll("[data-account-toggle]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = document.getElementById(button.dataset.accountToggle);
      const open = menu?.hidden !== false;
      closeAccountMenus();
      if (menu) setAccountMenuOpen(button, menu, open);
    });
  }
  for (const menu of document.querySelectorAll(".account-menu")) {
    menu.addEventListener("click", (event) => event.stopPropagation());
  }
  for (const button of document.querySelectorAll("[data-logout]")) {
    button.addEventListener("click", () => void logout());
  }
  document.addEventListener("click", (event) => {
    closeAccountMenus();
    const shell = event.target.closest?.(".folder-picker-shell");
    if (!shell) closeFolderPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && state.drawerOpen) return trapDrawerFocus(event);
    if (event.key !== "Escape") return;
    if (document.querySelector("#folder-picker")?.hidden === false) {
      event.preventDefault();
      closeFolderPicker({ restoreFocus: true });
      return;
    }
    const openMenu = [...document.querySelectorAll(".account-menu")].find((menu) => menu.hidden === false);
    if (openMenu) {
      closeAccountMenus();
      document.querySelector(`[data-account-toggle="${openMenu.id}"]`)?.focus();
      return;
    }
    if (state.drawerOpen) {
      event.preventDefault();
      closeDrawer();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // A backgrounded phone tab may never come back: park the draft.
      saveComposerDraft();
      persistDrafts();
      return;
    }
    // iOS kills background event streams and throttles timers; returning to
    // the app refreshes immediately instead of waiting out the next tick.
    resumeLiveConnection();
  });
  document.querySelector("#rename-chat")?.addEventListener("click", beginChatRename);
  document.querySelector("#rename-chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveChatRename();
  });
  document.querySelector("#cancel-chat-rename")?.addEventListener("click", cancelChatRename);
  document.querySelector("#rename-chat-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelChatRename();
  });
  document.querySelector("#stop-task")?.addEventListener("click", () => void stopCurrentTask());
  document.querySelector("#refresh-space")?.addEventListener("click", () => void refreshExplorerTree());
  document.querySelector("#folder-picker-button")?.addEventListener("click", () => toggleFolderPicker());
  document.querySelector("#folder-picker")?.addEventListener("click", (event) => {
    const row = event.target.closest?.("[data-explore-space]");
    if (row) {
      closeDrawer({ restoreFocus: false });
      void selectExplorerSpace(row.dataset.exploreSpace);
    }
  });
  for (const button of document.querySelectorAll("[data-space-view]")) button.addEventListener("click", () => {
    state.explorerTab = button.dataset.spaceView; renderWorkspace();
  });
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
    if (shouldSubmitComposerKey(event, { coarsePointer })) {
      event.preventDefault();
      document.querySelector("#composer")?.requestSubmit();
    }
  });
  document.querySelector("#messages")?.addEventListener("scroll", updateJumpLatest, { passive: true });
  document.querySelector("#jump-latest")?.addEventListener("click", () => {
    const container = document.querySelector("#messages");
    container?.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    updateJumpLatest();
  });
  document.querySelector("#banner")?.addEventListener("click", (event) => {
    if (!event.target.closest?.(".banner-dismiss")) return;
    state.banner = "";
    renderBanner();
  });
  syncSidebarChrome();
  syncComposer();
  renderConversationChrome();
  renderConversations();
  renderWorkspace();
  updateConnection();
}

function showContext(name, { moveFocus = false, fromHistory = false } = {}) {
  if (!contextNames.includes(name)) name = "new";
  if (state.contextName !== name) {
    // Only New chat and Chat host the composer; drafts save under the outgoing
    // context's key and restore under the incoming one.
    saveComposerDraft();
    state.contextName = name;
    document.querySelector(".app-shell")?.setAttribute("data-context", name);
    for (const context of contextNames) {
      const section = document.querySelector(`#context-${context}`);
      if (section) section.hidden = context !== name;
    }
    const slot = name === "new" ? "#new-composer-slot" : name === "chat" ? "#chat-composer-slot" : null;
    const composer = document.querySelector("#composer");
    if (slot && composer) document.querySelector(slot)?.append(composer);
    restoreComposerDraft();
    syncComposer();
    if (name === "chat") {
      const messages = document.querySelector("#messages");
      // Entering a chat lands on the newest message immediately; the CSS
      // smooth behavior is for people, not programmatic pins.
      messages?.scrollTo({ top: messages.scrollHeight, behavior: "instant" });
      updateJumpLatest();
    }
    renderConversationChrome();
    renderConversations();
  }
  // Outside the change guard: the first render lands on a screen the shell
  // already claims, and its destination still has to read as the current one.
  for (const button of document.querySelectorAll("[data-nav-current]")) {
    if (button.dataset.navCurrent === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  updateContextTitle();
  if (!fromHistory && !fixtureName && document.querySelector(".app-shell")) {
    const hash = contextHash(name);
    if (location.hash !== hash) history.pushState({ context: name }, "", hash);
  }
  if (moveFocus) focusContextHeading(name);
}

function focusContextHeading(name) {
  // The Chat screen's heading is its title in the bar above the transcript.
  const heading = name === "chat"
    ? document.querySelector("#conversation-title")
    : document.querySelector(`#context-${name} h1`);
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

// --- The sidebar and its phone form, the drawer ---------------------------
// One markup, two presentations: `data-sidebar` chooses the desktop width and
// `data-drawer` opens the phone overlay. Tooltips belong to the collapsed
// state alone (app.css), so the expanded sidebar and the drawer stay quiet.

function setSidebarState(next, { moveFocus = false } = {}) {
  state.sidebarState = next === "collapsed" ? "collapsed" : "expanded";
  document.querySelector(".app-shell")?.setAttribute("data-sidebar", state.sidebarState);
  try { localStorage.setItem(sidebarStorageKey, state.sidebarState); } catch {}
  syncSidebarChrome();
  if (moveFocus) document.querySelector("#sidebar-toggle")?.focus({ preventScroll: true });
}

function syncSidebarChrome() {
  const toggle = document.querySelector("#sidebar-toggle");
  if (!toggle) return;
  const label = phoneQuery.matches
    ? "Close menu"
    : state.sidebarState === "collapsed" ? "Show menu" : "Hide menu";
  toggle.setAttribute("aria-label", label);
  toggle.dataset.tip = label;
}

function openDrawer({ moveFocus = true } = {}) {
  if (state.drawerOpen) return;
  state.drawerOpen = true;
  document.querySelector(".app-shell")?.setAttribute("data-drawer", "open");
  const drawer = document.querySelector("#drawer");
  drawer?.setAttribute("role", "dialog");
  drawer?.setAttribute("aria-modal", "true");
  document.querySelector("#menu-button")?.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-locked");
  syncSidebarChrome();
  // The open state is already on the shell, so the drawer is focusable now.
  if (moveFocus) document.querySelector("#sidebar-toggle")?.focus({ preventScroll: true });
}

function closeDrawer({ restoreFocus = true } = {}) {
  if (!state.drawerOpen) return;
  state.drawerOpen = false;
  document.querySelector(".app-shell")?.setAttribute("data-drawer", "closed");
  const drawer = document.querySelector("#drawer");
  drawer?.removeAttribute("role");
  drawer?.removeAttribute("aria-modal");
  document.querySelector("#menu-button")?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("drawer-locked");
  syncSidebarChrome();
  if (restoreFocus) document.querySelector("#menu-button")?.focus({ preventScroll: true });
}

function trapDrawerFocus(event) {
  const drawer = document.querySelector("#drawer");
  if (!drawer) return;
  const focusable = [...drawer.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])")]
    .filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !drawer.contains(active))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function renderMessages() {
  const container = document.querySelector("#messages");
  const notice = document.querySelector("#transcript-notice");
  const rows = document.querySelector("#message-rows");
  const workStatus = document.querySelector("#work-status");
  if (!container || !notice || !rows || !workStatus) return;
  const wasNearBottom = !container.dataset.rendered
    || container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const visible = state.messages.filter((message) => (message.role === "user" || message.role === "assistant") && (!message.kind || message.kind === "assistant_continuation"));
  const request = state.startingNewChat ? null : state.summary?.latestRequest;
  const requestPhase = request?.phase;
  const visibleWork = !state.startingNewChat && state.work?.owner.conversationId === state.selectedConversationId ? state.work : null;
  const workEvents = requestEvents(request, Boolean(visibleWork));
  renderWorkRequest(document.querySelector("#request-work"), visibleWork, { act: workAction, openFile: openFilePreview, error: state.workError });
  renderExtensionQuestions(document.querySelector("#extension-questions"), {
    scope: state.selectedConversationId,
    requests: !state.startingNewChat && state.summary?.conversation?.id === state.selectedConversationId ? state.summary.extensionRequests ?? [] : [],
    answer: async (question, value, cancelled = false) => {
      const conversationId = state.selectedConversationId;
      if (!fixtureName) await remote("management.extensionAnswer", { taskId: question.taskId, id: question.id, value, cancelled });
      if (state.selectedConversationId !== conversationId) return;
      if (state.summary?.extensionRequests) state.summary.extensionRequests = state.summary.extensionRequests.filter((item) => item.id !== question.id);
      renderMessages();
      await refreshConversation();
    },
  });
  const working = !state.startingNewChat && (
    state.summary?.state === "running"
    || requestPhase === "working"
    || requestPhase === "handed_off"
    || Boolean(state.selectedConversationId && state.activeTasks.has(state.selectedConversationId))
  );
  if (working && state.liveAssistantText) {
    visible.push({
      id: `live-assistant:${state.selectedConversationId ?? "management"}`,
      role: "assistant",
      content: state.liveAssistantText,
      streaming: true,
      truncated: state.liveAssistantTextTruncated,
    });
  }
  const conversationKey = state.startingNewChat ? "new-chat" : state.selectedConversationId ?? "none";
  const sameConversation = container.dataset.conversationId === conversationKey;
  if (!sameConversation) {
    rows.replaceChildren();
    container.dataset.conversationId = conversationKey;
    delete container.dataset.latestMessageId;
  }
  const latestVisible = visible.at(-1);
  const previousMessageId = container.dataset.latestMessageId;
  if (latestVisible?.id && latestVisible.id !== previousMessageId) {
    container.dataset.latestMessageId = latestVisible.id;
    if (container.dataset.rendered && previousMessageId && previousMessageId !== latestVisible.id) {
      const status = document.querySelector("#chat-status");
      if (status) status.textContent = latestVisible.role === "assistant" ? "New reply from work-fold agent." : "Message sent.";
    }
  } else if (!latestVisible?.id && previousMessageId) {
    delete container.dataset.latestMessageId;
  }
  const noticeChanged = replaceHtmlIfChanged(
    notice,
    state.transcriptLoading && !sameConversation
      ? `<div class="working-row"><span class="spinner"></span></div>`
      : state.transcriptTruncated ? `<div class="projection-notice">Earlier messages are hidden.</div>` : "",
  );
  const messagesChanged = reconcileMessageRows(rows, visible, sameConversation && container.dataset.rendered === "true");
  const workChanged = replaceHtmlIfChanged(workStatus, `
    ${workEvents.map((event) => `<div class="work-event ${event.state}"${event.title ? ` title="${escapeAttribute(event.title)}"` : ""}><span class="work-event-mark" aria-hidden="true"></span><span>${event.html}</span></div>`).join("")}
    ${working && !visibleWork && !workEvents.some((event) => event.state === "running") ? `<div class="working-row"><span class="spinner"></span><span>${escapeHtml(state.liveActivity || "Working")}</span></div>` : ""}
  `);
  if (workChanged) {
    const resultLinks = requestResultLinks(request);
    for (const button of workStatus.querySelectorAll("[data-result-app]")) button.addEventListener("click", () => {
      const reference = resultLinks.find((item) => item.kind === "app" && item.featureInstallationId === button.dataset.resultApp && item.spaceId === button.dataset.spaceId);
      if (reference) openBrowserAppResult(reference);
    });
    for (const button of workStatus.querySelectorAll("[data-result-file]")) button.addEventListener("click", () => openFilePreview(button.dataset.spaceId, button.dataset.resultFile));
  }
  if (container.dataset.rendered !== "true") container.dataset.rendered = "true";
  if (wasNearBottom && (noticeChanged || messagesChanged || workChanged || !sameConversation)) {
    // Instant, not smooth: an animated pin momentarily reads as "not at the
    // bottom" and would un-pin the very next render.
    container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
  }
  updateJumpLatest();
  renderBanner();
}

// The floating jump-to-latest affordance: visible only while the reader has
// scrolled up in a chat, so returning to the newest message is one tap.
// Measured after layout (rAF) so mid-render heights never flash it.
let jumpLatestFrame = 0;
function updateJumpLatest() {
  if (jumpLatestFrame) return;
  jumpLatestFrame = requestAnimationFrame(() => {
    jumpLatestFrame = 0;
    const container = document.querySelector("#messages");
    const button = document.querySelector("#jump-latest");
    if (!container || !button) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    button.hidden = nearBottom || state.contextName !== "chat";
  });
}

function reconcileMessageRows(container, messages, animateNew) {
  const existing = new Map(
    [...container.children]
      .filter((row) => row.dataset.messageId)
      .map((row) => [row.dataset.messageId, row]),
  );
  const desiredIds = new Set();
  let cursor = container.firstElementChild;
  let changed = false;
  for (const message of messages) {
    desiredIds.add(message.id);
    let row = existing.get(message.id);
    if (!row) {
      row = document.createElement("article");
      row.classList.add("message");
      row.dataset.messageId = message.id;
      if (animateNew) {
        row.classList.add("message-enter");
        row.addEventListener("animationend", () => row.classList.remove("message-enter"), { once: true });
      }
      changed = true;
    }
    row.classList.toggle("user", message.role === "user" && message.kind !== "assistant_continuation");
    row.classList.toggle("assistant", message.role === "assistant");
    row.classList.toggle("web", message.source === "remote_web");
    row.classList.toggle("pending", message.pending === true);
    row.classList.toggle("streaming", message.streaming === true);
    changed = replaceHtmlIfChanged(row, message.kind === "assistant_continuation" ? `<p class="work-continuation">Continuing with the results from delegated work.</p>` : `
      <div class="message-role"${message.createdAt ? ` title="${escapeAttribute(cardTime(message.createdAt))}"` : ""}>${message.role === "assistant" ? escapeHtml(assistantLabel()) : "You"}</div>
      <div class="message-content"><div class="message-body markdown">${renderMarkdown(message.content)}</div>${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((attachment) => `<span>${fileGlyph(attachment.kind)}${escapeHtml(attachment.name)}</span>`).join("")}</div>` : ""}${message.streaming && message.truncated ? `<div class="live-reply-limit">The rest will appear when this reply finishes.</div>` : ""}</div>
    `) || changed;
    if (row !== cursor) {
      container.insertBefore(row, cursor);
      changed = true;
    }
    cursor = row.nextElementSibling;
  }
  for (const [messageId, row] of existing) {
    if (desiredIds.has(messageId)) continue;
    row.remove();
    changed = true;
  }
  return changed;
}

function requestEvents(request, hasWork = false) {
  if (!request || typeof request !== "object") return [];
  const events = [];
  const children = !hasWork && Array.isArray(request.children) ? request.children : [];
  for (const child of children) {
    if (!child?.spaceName) continue;
    const spaceName = `<strong>${escapeHtml(child.spaceName)}</strong>`;
    if (child.state === "running") events.push({ state: "running", html: `Working in ${spaceName}` });
    else if (child.state === "succeeded") events.push({ state: "succeeded", html: `Finished in ${spaceName}` });
    else if (child.state === "aborted") events.push({ state: "stopped", html: `Stopped in ${spaceName}` });
    else if (child.state === "failed" || child.state === "unknown") {
      events.push({ state: "failed", html: `Couldn’t finish in ${spaceName}`, title: child.error || request.error || "" });
    }
  }
  const dispositions = Array.isArray(request.dispositions) ? request.dispositions : [];
  for (const disposition of dispositions) {
    const attachment = disposition?.attachment?.name;
    if (!attachment) continue;
    // The Library disposition is Space-free by design, so it renders before
    // the Space-name guard the placed/registered branches require.
    if (disposition.status === "library") {
      events.push({ state: "succeeded", html: `Added <strong>${escapeHtml(attachment)}</strong> to the Library` });
      continue;
    }
    const spaceName = disposition?.spaceName;
    if (!spaceName) continue;
    if (disposition.status === "placed") {
      events.push({ state: "succeeded", html: `Placed <strong>${escapeHtml(attachment)}</strong> in <strong>${escapeHtml(spaceName)}</strong>` });
    } else if (disposition.status === "registered") {
      events.push({ state: "succeeded", html: `Added <strong>${escapeHtml(attachment)}</strong> as <strong>${escapeHtml(spaceName)}</strong>` });
    }
  }
  if (!hasWork && request.phase === "failed" && !events.some((event) => event.state === "failed")) {
    events.push({ state: "failed", html: "Couldn’t finish", title: request.error || "" });
  } else if (!hasWork && request.phase === "stopped" && !events.some((event) => event.state === "stopped")) {
    events.push({ state: "stopped", html: "Stopped" });
  }
  const results = requestResultLinks(request).filter((result) => !hasWork || result.kind !== "file");
  if (results.length) events.push({ state: "result", html: `<span class="request-result-links">${results.map((result) => result.kind === "file"
    ? `<button type="button" class="quiet" data-space-id="${escapeAttribute(result.spaceId)}" data-result-file="${escapeAttribute(result.path)}" title="${escapeAttribute(result.spaceName)} · ${escapeAttribute(result.path)}">${escapeHtml(result.label)}</button>`
    : `<button type="button" class="quiet" data-space-id="${escapeAttribute(result.spaceId)}" data-result-app="${escapeAttribute(result.featureInstallationId)}">${escapeHtml(result.label)}</button>`).join("")}</span>` });
  return events;
}

async function refreshConversation({ loadTranscript = true } = {}) {
  // Fixture previews re-render the canned state instead of asking anything.
  if (fixtureName) {
    renderConversationChrome();
    renderMessages();
    return;
  }
  const refreshVersion = ++state.conversationRefreshVersion;
  try {
    if (state.startingNewChat || !state.selectedConversationId) {
      state.summary = { state: "idle" };
      state.work = null; state.workError = "";
      state.messages = [];
      state.transcriptConversationId = null;
      state.transcriptTruncated = false;
      renderConversationChrome();
      renderMessages();
      return;
    }
    const conversationId = state.selectedConversationId;
    const summary = await remote("management.summary", { conversationId });
    if (!conversationRefreshIsCurrent(refreshVersion, conversationId)) return;
    state.summary = summary;
    if (summary.capabilities?.work && summary.latestRequest?.taskId) {
      try {
        const result = await remote("management.work", { taskId: summary.latestRequest.taskId });
        if (!conversationRefreshIsCurrent(refreshVersion, conversationId)) return;
        state.work = result.work; state.workError = "";
      } catch (error) {
        if (!conversationRefreshIsCurrent(refreshVersion, conversationId)) return;
        if (state.work?.requestId !== summary.latestRequest.requestId) state.work = null;
        state.workError = errorText(error);
      }
    } else { state.work = null; state.workError = ""; }
    const summaryPhase = summary?.latestRequest?.phase;
    const latest = summary?.latestRequest;
    const active = summary?.state === "running" || summaryPhase === "working" || summaryPhase === "handed_off";
    if (active && latest?.canStop === true && typeof latest.taskId === "string") {
      state.activeTasks.set(conversationId, { taskId: latest.taskId, conversationId });
    } else {
      state.activeTasks.delete(conversationId);
    }
    const settlementKey = !active && latest?.startedAt
      ? `${conversationId}:${latest.startedAt}`
      : null;
    if (settlementKey && !state.settledTreeRefreshes.has(settlementKey)) {
      state.settledTreeRefreshes.add(settlementKey);
      await refreshExplorerTree();
      if (!conversationRefreshIsCurrent(refreshVersion, conversationId)) return;
    }
    updateConnection(true);
    if (loadTranscript) {
      if (state.transcriptConversationId !== conversationId) {
        document.querySelector("#messages")?.removeAttribute("data-latest-message-id");
        // A switched-to chat shows its loading state instead of a blank
        // transcript while the fetch is in flight.
        state.transcriptLoading = true;
        renderMessages();
      }
      const transcript = await remote("management.transcript", { conversationId });
      if (!conversationRefreshIsCurrent(refreshVersion, conversationId)) return;
      state.messages = transcript.messages ?? [];
      state.transcriptConversationId = conversationId;
      state.transcriptTruncated = transcript.truncated === true;
      state.transcriptLoading = false;
      if (!active) {
        state.liveAssistantText = "";
        state.liveAssistantTextTruncated = false;
      }
    }
    renderConversationChrome();
    renderMessages();
    ensureConversationWatch();
  } catch (error) {
    state.transcriptLoading = false;
    if (refreshVersion !== state.conversationRefreshVersion) return;
    state.banner = errorText(error);
    if (state.banner.toLowerCase().includes("offline")) updateConnection(false);
    renderBanner();
  }
}

// --- Live watch: while the desktop advertises the capability and a turn is
// running in the selected chat, one bounded management.watch operation at a
// time streams the desktop's activity line and settles the moment the turn
// does — replies arrive on the event, not the next poll tick. Old desktops
// never advertise it, so the client simply keeps polling. -------------------

function ensureConversationWatch() {
  if (fixtureName || state.watchUnsupported || state.sessionRebooting) return;
  if (!state.session?.desktopOnline || Date.now() < state.rateLimitedUntil) return;
  if (state.summary?.capabilities?.watch !== true) return;
  const conversationId = state.startingNewChat ? null : state.selectedConversationId;
  const running = state.summary?.state === "running" || state.summary?.latestRequest?.phase === "working";
  if (!conversationId || !running) return;
  if (state.watchToken) return;
  const token = { conversationId };
  state.watchToken = token;
  remote("management.watch", { conversationId }, {
    fallbackIntervalMs: 10_000,
    onAccepted: (operationId) => {
      if (state.watchToken === token) state.watchOperationId = operationId;
    },
  }).then((result) => {
    if (state.watchToken !== token) return;
    state.watchToken = null;
    state.watchOperationId = null;
    state.liveActivity = "";
    if (result && result.settled === true) {
      void loadConversations({ preferredConversationId: conversationId })
        .then(() => ensureConversationWatch())
        .catch(() => {});
    } else if (result && result.state === "running") {
      ensureConversationWatch();
    }
  }).catch(() => {
    if (state.watchToken !== token) return;
    state.watchToken = null;
    state.watchOperationId = null;
    state.liveActivity = "";
    // Fail quiet and stay on polling for this page; a reload re-tries.
    state.watchUnsupported = true;
  });
}

function releaseConversationWatch() {
  // Switching chats or starting fresh: the pending watch keeps running to its
  // window server-side, but its ticks and resolution no longer touch state.
  state.watchToken = null;
  state.watchOperationId = null;
  state.liveActivity = "";
  state.liveAssistantText = "";
  state.liveAssistantTextTruncated = false;
}

function conversationRefreshIsCurrent(refreshVersion, conversationId) {
  return refreshVersion === state.conversationRefreshVersion
    && !state.startingNewChat
    && state.selectedConversationId === conversationId;
}

async function sendPrompt() {
  const input = document.querySelector("#prompt");
  const content = input.value.trim();
  const selectedTaskRunning = Boolean(state.selectedConversationId && state.activeTasks.has(state.selectedConversationId));
  if (!content || state.sending || state.renameSaving || selectedTaskRunning) return;
  cancelChatRename({ restoreFocus: false });
  state.sending = true;
  state.liveAssistantText = "";
  state.liveAssistantTextTruncated = false;
  syncComposer();
  state.banner = "";
  const sentFromNewChat = state.contextName === "new";
  const sentDraftKey = currentComposerDraftKey();
  const toExistingConversation = !sentFromNewChat && !state.startingNewChat && Boolean(state.selectedConversationId);
  let pendingId = null;
  let sentUploads = [];
  try {
    const attachments = await serializeUploads();
    // The New chat screen's composer always starts a new request — the same
    // path as New chat followed by a send.
    const request = {
      content,
      ...(sentFromNewChat || state.startingNewChat || !state.selectedConversationId
        ? { newConversation: true }
        : { conversationId: state.selectedConversationId }),
      ...(attachments.length ? { attachments } : {}),
    };
    // Sends into an open chat render immediately as a pending bubble; the
    // transcript refresh after acceptance replaces it with the recorded one.
    if (toExistingConversation) {
      pendingId = `pending-${crypto.randomUUID()}`;
      state.messages = [...state.messages, {
        id: pendingId,
        role: "user",
        content,
        pending: true,
        ...(state.uploads.length ? { attachments: state.uploads.map((file) => ({ kind: "file", name: file.name })) } : {}),
      }];
      sentUploads = state.uploads;
      state.composerDrafts.delete(sentDraftKey);
      persistDrafts();
      input.value = "";
      state.uploads = [];
      syncComposer();
      renderMessages();
    }
    const result = await remote("management.send", request);
    state.startingNewChat = false;
    state.selectedConversationId = result.conversationId;
    if (result.taskId) state.activeTasks.set(result.conversationId, {
      taskId: result.taskId,
      conversationId: result.conversationId,
    });
    else state.activeTasks.delete(result.conversationId);
    if (!toExistingConversation) {
      state.composerDrafts.delete(sentDraftKey);
      persistDrafts();
      input.value = "";
      state.uploads = [];
      syncComposer();
    }
    if (sentFromNewChat) showContext("chat");
    await loadConversations({ preferredConversationId: result.conversationId });
  } catch (error) {
    if (pendingId) {
      // Nothing was accepted: the message returns to the composer, ahead of
      // anything typed while it was in flight, with its attachments restored.
      state.messages = state.messages.filter((message) => message.id !== pendingId);
      input.value = input.value.trim() ? `${content}\n${input.value}` : content;
      state.uploads = sentUploads;
      renderMessages();
    }
    state.banner = errorText(error);
    renderBanner();
  } finally {
    state.sending = false;
    syncComposer();
    input.focus({ preventScroll: true });
  }
}

function startNewChat() {
  if (state.sending || state.renameSaving) return;
  // Already opening a new chat elsewhere in the app: this is navigation back
  // to the door, not a second reset that would discard the draft.
  if (state.startingNewChat) {
    showContext("new");
    document.querySelector("#prompt")?.focus({ preventScroll: true });
    return;
  }
  releaseConversationWatch();
  saveComposerDraft();
  // The screen changes before the selection does, so the outgoing draft is
  // parked under the chat it was typed in rather than under the new one.
  showContext("new");
  state.conversationRefreshVersion += 1;
  cancelChatRename({ restoreFocus: false });
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

function composerContextActive() {
  return state.contextName === "new" || state.contextName === "chat";
}

// Draft text survives reloads, tab discards, and session reboots in this
// tab's sessionStorage; picked files cannot be persisted and stay in memory.
const draftStorageKey = "work-fold-remote-drafts-v1";
const explorerSpaceStorageKey = "work-fold-remote-files-space-v1";

function persistDrafts() {
  try {
    const drafts = {};
    for (const [key, value] of state.composerDrafts) if (value?.content) drafts[key] = value.content;
    if (Object.keys(drafts).length) sessionStorage.setItem(draftStorageKey, JSON.stringify(drafts));
    else sessionStorage.removeItem(draftStorageKey);
  } catch {}
}

function restorePersistedDrafts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(draftStorageKey) ?? "{}");
    for (const [key, content] of Object.entries(parsed)) {
      if (typeof content === "string" && content && !state.composerDrafts.has(key)) {
        state.composerDrafts.set(key, { content, uploads: [] });
      }
    }
  } catch {}
}

function currentComposerDraftKey() {
  return state.contextName === "new" || state.startingNewChat || !state.selectedConversationId
    ? "new-chat"
    : `chat:${state.selectedConversationId}`;
}

function saveComposerDraft() {
  if (!composerContextActive()) return;
  const input = document.querySelector("#prompt");
  if (!input) return;
  const content = input.value;
  if (!content && !state.uploads.length) state.composerDrafts.delete(currentComposerDraftKey());
  else state.composerDrafts.set(currentComposerDraftKey(), { content, uploads: [...state.uploads] });
  persistDrafts();
}

function restoreComposerDraft() {
  if (!composerContextActive()) return;
  const input = document.querySelector("#prompt");
  if (!input) return;
  const draft = state.composerDrafts.get(currentComposerDraftKey());
  input.value = draft?.content ?? "";
  state.uploads = [...(draft?.uploads ?? [])];
  syncComposer();
}

function syncComposer() {
  const input = document.querySelector("#prompt");
  const button = document.querySelector(".send-button:not(.stop-button)");
  const stop = document.querySelector("#stop-task");
  if (!input || !button || !stop) return;
  // The New chat screen opens with a taller field on desktop, so the first
  // sentence has room; every other placement keeps the one-line field.
  const minimumHeight = state.contextName === "new" && !phoneQuery.matches ? 108 : 56;
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, minimumHeight), 180)}px`;
  const unavailable = !state.session?.desktopOnline;
  const running = Boolean(state.selectedConversationId && state.activeTasks.has(state.selectedConversationId));
  button.hidden = running;
  stop.hidden = !running || state.contextName !== "chat";
  button.disabled = state.sending || state.renameSaving || unavailable || running || !input.value.trim();
  button.dataset.sending = String(state.sending);
  button.setAttribute("aria-label", state.sending ? "Sending message" : unavailable ? "Desktop offline" : "Send message");
  button.title = state.sending ? "Sending…" : unavailable ? "Desktop offline" : "Send message";
  input.setAttribute("aria-busy", String(state.sending));
  for (const newChatButton of document.querySelectorAll("#new-chat, #top-new-chat")) {
    // New chat stays reachable from every other screen while a new chat is
    // being started; only the screen it leads to disables it.
    newChatButton.disabled = state.sending || state.renameSaving || state.contextName === "new";
  }
  renderComposerContext();
}

async function loadSpaces() {
  if (fixtureName) return renderWorkspace();
  try {
    const result = await remote("spaces.list");
    state.spaces = result.spaces ?? [];
    state.filePreviewAvailable = result.capabilities?.filePreview === true;
    state.appViewsAvailable = result.capabilities?.appViews === true;
    state.spacesLoaded = true;
    if (state.explorerSpaceId && !state.spaces.some((space) => space.id === state.explorerSpaceId)) { closeInlinePreview(); state.explorerSpaceId = null; }
    if (!state.explorerSpaceId && state.spaces.length) {
      // The Files context remembers its Space across reloads on this tab.
      let remembered = null;
      try { remembered = sessionStorage.getItem(explorerSpaceStorageKey); } catch {}
      state.explorerSpaceId = remembered && state.spaces.some((space) => space.id === remembered)
        ? remembered
        : null;
    }
    renderWorkspace();
    if (state.explorerSpaceId) await loadTree(state.explorerSpaceId, "");
  } catch (error) {
    state.banner = errorText(error);
    renderBanner();
  }
}

async function loadConversations(options = {}) {
  if (fixtureName) {
    renderConversations();
    renderConversationChrome();
    return;
  }
  const requestVersion = ++state.conversationListRequestVersion;
  const previousConversations = state.conversations;
  const result = await remote("management.chats");
  if (requestVersion !== state.conversationListRequestVersion) return;
  state.conversations = (result.conversations ?? []).filter((conversation) => !conversation.archivedAt);
  state.conversationsLoaded = true;
  state.chatListTruncated = result.truncated === true;
  const renaming = state.conversations.find((conversation) => conversation.id === state.renamingConversationId);
  if (renaming && renaming.state !== "idle") cancelChatRename({ restoreFocus: false });
  const preferredConversationId = Object.hasOwn(options, "preferredConversationId")
    ? options.preferredConversationId
    : state.selectedConversationId;
  const selected = preferredConversationId && state.conversations.some((conversation) => conversation.id === preferredConversationId)
    ? preferredConversationId
    : state.conversations[0]?.id ?? null;
  const target = state.startingNewChat ? null : selected;
  if (target !== state.selectedConversationId) {
    saveComposerDraft();
    state.conversationRefreshVersion += 1;
    cancelChatRename({ restoreFocus: false });
    state.selectedConversationId = target;
    restoreComposerDraft();
  }
  renderConversations();
  renderConversationChrome();
  if (options.refreshTranscript !== false) {
    const previous = previousConversations.find((conversation) => conversation.id === state.selectedConversationId) ?? null;
    const current = state.conversations.find((conversation) => conversation.id === state.selectedConversationId) ?? null;
    const transcriptChanged = !previous || !current || previous.id !== current.id || previous.updatedAt !== current.updatedAt;
    await refreshConversation({
      loadTranscript: transcriptChanged || state.transcriptConversationId !== state.selectedConversationId,
    });
  }
}

// The sidebar's saved-chat list, grouped by the day it last moved. The group
// heading is the date, so a row carries only its title and — while a turn is
// running — the Working mark.
function renderConversations() {
  const list = document.querySelector("#chats");
  if (!list) return;
  const groups = groupConversations(state.conversations);
  const busy = state.sending || state.renameSaving;
  const rows = groups.map((group) => `
    <li class="chat-group" role="presentation"><span class="chat-group-heading">${escapeHtml(group.label)}</span></li>
    ${group.conversations.map((conversation) => {
      const active = conversation.id === state.selectedConversationId && !state.startingNewChat && state.contextName !== "new";
      // The open chat keeps its fill from anywhere in the app, but it is only
      // the current page while its transcript is the screen being shown.
      return `<li><button class="chat-button${active ? " active" : ""}" type="button" data-chat-id="${escapeAttribute(conversation.id)}"${active && state.contextName === "chat" ? ` aria-current="page"` : ""}${busy ? " disabled" : ""}><span class="chat-title">${escapeHtml(conversation.title)}</span>${conversation.needsAnswer ? `<span class="chat-waiting">Needs your answer</span>` : conversation.state === "running" || conversation.requestState === "working" || conversation.requestState === "handed_off" ? `<span class="chat-working"><span class="chat-working-dot" aria-hidden="true"></span>Working</span>` : ""}</button></li>`;
    }).join("")}`).join("");
  // "No chats yet" is an answer, not a guess: before the first load the list
  // shows its loading state instead of a false empty.
  const loading = !state.conversationsLoaded && !state.conversations.length;
  const noteText = state.conversations.length
    ? (state.chatListTruncated ? "Older chats hidden" : "")
    : state.conversationsLoaded ? "No chats yet" : "";
  const note = loading
    ? `<li class="empty-list"><span class="spinner" aria-hidden="true"></span></li>`
    : noteText ? `<li class="empty-list">${escapeHtml(noteText)}</li>` : "";
  const focusedChatId = document.activeElement?.closest?.("#chats [data-chat-id]")?.dataset.chatId ?? "";
  if (!replaceHtmlIfChanged(list, `${rows}${note}`)) return;
  // A background refresh must not drop the keyboard out of the list.
  if (focusedChatId) list.querySelector(`[data-chat-id="${CSS.escape(focusedChatId)}"]`)?.focus({ preventScroll: true });
}

function groupConversations(conversations) {
  return groupConversationsByDate(conversations);
}

async function selectConversation(conversationId) {
  if (state.sending || state.renameSaving || !conversationId) return;
  releaseConversationWatch();
  saveComposerDraft();
  cancelChatRename({ restoreFocus: false });
  state.startingNewChat = false;
  state.selectedConversationId = conversationId;
  state.banner = "";
  showContext("chat", { moveFocus: true });
  restoreComposerDraft();
  renderConversations();
  renderConversationChrome();
  await refreshConversation();
}

async function loadTree(spaceId, path) {
  if (fixtureName) return renderWorkspace();
  if (!path && state.appViewsAvailable) void loadSpaceApps(spaceId);
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

async function loadSpaceApps(spaceId) {
  try {
    const result = await remote("apps.list", { spaceId });
    state.spaceApps.set(spaceId, result.apps ?? []);
    renderWorkspace();
  } catch {
    state.spaceApps.set(spaceId, null);
    renderWorkspace();
  }
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
  const titleView = document.querySelector("#conversation-title-view");
  const titleButton = document.querySelector("#rename-chat");
  const renameForm = document.querySelector("#rename-chat-form");
  const renameInput = document.querySelector("#rename-chat-input");
  const prompt = document.querySelector("#prompt");
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
  const editing = Boolean(selected && state.renamingConversationId === selected.id);
  const chatBusy = selected?.state === "running" || selected?.state === "compacting";
  if (title) title.textContent = state.startingNewChat || !selected ? "New chat" : selected.title;
  if (titleView) titleView.hidden = editing;
  if (titleButton) {
    titleButton.disabled = state.startingNewChat || !selected || chatBusy || state.renameSaving;
  }
  if (renameForm) renameForm.hidden = !editing;
  if (renameInput) renameInput.disabled = state.renameSaving;
  for (const button of renameForm?.querySelectorAll("button") ?? []) button.disabled = state.renameSaving;
  if (prompt) prompt.placeholder = "Message work-fold agent";
  const stop = document.querySelector("#stop-task");
  const send = document.querySelector(".send-button:not(.stop-button)");
  const running = Boolean(state.selectedConversationId && state.activeTasks.has(state.selectedConversationId));
  if (stop) stop.hidden = !running || state.contextName !== "chat";
  if (send) send.hidden = running;
}

function beginChatRename() {
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
  if (!selected || state.startingNewChat || state.renameSaving || selected.state !== "idle") return;
  const input = document.querySelector("#rename-chat-input");
  if (!input) return;
  state.renamingConversationId = selected.id;
  state.banner = "";
  input.value = selected.title;
  renderConversationChrome();
  renderBanner();
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
}

async function saveChatRename() {
  const conversationId = state.renamingConversationId;
  const input = document.querySelector("#rename-chat-input");
  const selected = state.conversations.find((conversation) => conversation.id === conversationId);
  if (!conversationId || !input || !selected || state.renameSaving) return;
  const title = normalizeChatTitle(input.value);
  if (!title) {
    state.banner = "Enter a Chat title.";
    renderBanner();
    input.focus({ preventScroll: true });
    return;
  }
  if (title === selected.title) {
    cancelChatRename();
    return;
  }
  state.renameSaving = true;
  renderConversationChrome();
  renderConversations();
  syncComposer();
  try {
    const result = await remote("management.rename", { conversationId, title });
    state.conversationListRequestVersion += 1;
    state.conversations = state.conversations
      .map((conversation) => conversation.id === conversationId ? { ...conversation, ...result.conversation } : conversation)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    state.renamingConversationId = null;
    state.banner = "";
    const status = document.querySelector("#chat-status");
    if (status) status.textContent = "Chat title renamed.";
    renderConversations();
    renderBanner();
  } catch (error) {
    state.banner = errorText(error);
    renderBanner();
  } finally {
    state.renameSaving = false;
    renderConversationChrome();
    renderConversations();
    syncComposer();
    const target = state.renamingConversationId ? input : document.querySelector("#rename-chat");
    target?.focus({ preventScroll: true });
  }
}

function cancelChatRename({ restoreFocus = true } = {}) {
  if (state.renameSaving) return;
  const wasEditing = Boolean(state.renamingConversationId);
  state.renamingConversationId = null;
  renderConversationChrome();
  if (restoreFocus && wasEditing) {
    requestAnimationFrame(() => document.querySelector("#rename-chat")?.focus({ preventScroll: true }));
  }
}

function renderWorkspace() {
  const pane = document.querySelector("#workspace-pane");
  const tree = document.querySelector("#file-tree");
  const selected = state.spaces.find((space) => space.id === state.explorerSpaceId);
  const hasSpace = Boolean(selected);
  if (!pane || !tree) return;
  pane.hidden = !hasSpace;
  document.querySelector("#refresh-space").hidden = !hasSpace;
  document.querySelector("#space-title").textContent = selected?.name ?? "Folder";
  renderFolderPicker();
  if (!hasSpace) return;
  document.querySelector("#space-files").hidden = state.explorerTab !== "files";
  document.querySelector("#space-apps").hidden = state.explorerTab !== "apps";
  for (const button of document.querySelectorAll("[data-space-view]")) button.setAttribute("aria-pressed", String(button.dataset.spaceView === state.explorerTab));
  const spaceId = selected.id;
  const entries = state.trees.get(`${spaceId}:`) ?? [];
  tree.setAttribute("aria-busy", String(state.treeStatus.get(`${spaceId}:`) === "loading"));
  const apps = state.spaceApps.get(spaceId);
  const appsPane = document.querySelector("#space-apps");
  const appsStatus = !fixtureName && !state.appViewsAvailable ? "Update work-fold on your desktop to browse apps here." : apps === undefined ? "Loading apps…" : apps === null ? "Couldn’t load apps. Try Refresh." : "No apps in this folder.";
  if (replaceHtmlIfChanged(appsPane, apps?.length ? apps.map((app) => `<button type="button" class="space-app-row" data-open-app="${escapeAttribute(app.featureInstallationId)}"><span>${escapeHtml(app.title)}</span><small>${app.webView ? app.preview ? "Preview" : "Open app" : "Desktop only"}</small></button>`).join("") : `<p class="file-empty">${appsStatus}</p>`)) {
    for (const button of appsPane.querySelectorAll("[data-open-app]")) button.addEventListener("click", () => openBrowserApp(spaceId, button.dataset.openApp));
  }
  const focusedPath = document.activeElement?.closest?.("[data-file-path], [data-tree-path]")?.dataset;
  const changed = replaceHtmlIfChanged(tree, renderTreeRows(spaceId, entries, "", 0));
  if (!changed) return;
  for (const row of tree.querySelectorAll("[data-depth]")) row.style.setProperty("--depth", row.dataset.depth);
  for (const button of tree.querySelectorAll("[data-tree-path]")) button.addEventListener("click", () => void toggleTree(button.dataset.spaceId, button.dataset.treePath));
  for (const button of tree.querySelectorAll("[data-file-path]")) button.addEventListener("click", () => openSpaceFile(button.dataset.spaceId, button.dataset.filePath));
  if (focusedPath?.filePath) tree.querySelector(`[data-file-path="${CSS.escape(focusedPath.filePath)}"]`)?.focus({ preventScroll: true });
  else if (focusedPath?.treePath) tree.querySelector(`[data-tree-path="${CSS.escape(focusedPath.treePath)}"]`)?.focus({ preventScroll: true });
}

function renderTreeRows(spaceId, entries, path, depth) {
  const key = `${spaceId}:${path}`;
  const status = state.treeStatus.get(key);
  if (status === "loading" || (!status && !state.trees.has(key))) return `<div class="file-empty">Loading…</div>`;
  if (status === "error") return `<div class="file-empty error">Couldn’t load files. Try Refresh.</div>`;
  const truncated = state.treeTruncated.get(`${spaceId}:${path}`) === true;
  if (!entries.length) return `<div class="file-empty">${path ? "This folder is empty." : "No visible files in this folder yet."}</div>`;
  return `${truncated ? `<div class="tree-notice">First 500 items. Ignored files omitted.</div>` : ""}${entries.map((entry) => {
    const expanded = entry.kind === "folder" && state.expanded.has(`${spaceId}:${entry.path}`);
    const children = expanded ? state.trees.get(`${spaceId}:${entry.path}`) ?? [] : [];
    return `<div class="file-node">
      <div class="file-row" data-depth="${depth}">
        ${entry.kind === "folder" ? `<button class="file-main" type="button" data-space-id="${escapeAttribute(spaceId)}" data-tree-path="${escapeAttribute(entry.path)}" aria-expanded="${String(expanded)}">` : `<button class="file-main" type="button" data-space-id="${escapeAttribute(spaceId)}" data-file-path="${escapeAttribute(entry.path)}" aria-label="Preview ${escapeAttribute(entry.name)}">`}
          <span class="tree-caret" aria-hidden="true">${entry.kind === "folder" ? expanded ? "⌄" : "›" : ""}</span>${fileGlyph(entry.kind)}<span class="file-name">${escapeHtml(entry.name)}</span>
        </button>
        ${entry.kind === "file" ? `<span class="file-size">${formatBytes(entry.sizeBytes)}</span>` : ""}
      </div>
      ${expanded ? `<div>${renderTreeRows(spaceId, children, entry.path, depth + 1)}</div>` : ""}
    </div>`;
  }).join("")}`;
}

async function selectExplorerSpace(spaceId) {
  closeInlinePreview();
  state.explorerTab = "files";
  state.explorerSpaceId = spaceId;
  try { if (spaceId) sessionStorage.setItem(explorerSpaceStorageKey, spaceId); else sessionStorage.removeItem(explorerSpaceStorageKey); } catch {}
  renderWorkspace();
  closeFolderPicker();
  if (spaceId) {
    showContext("spaces", { moveFocus: false });
    document.querySelector("#space-title")?.focus({ preventScroll: true });
    await loadTree(spaceId, "");
  }
}

function renderFolderPicker() {
  const picker = document.querySelector("#folder-picker");
  if (!picker) return;
  picker.setAttribute("aria-busy", String(!state.spacesLoaded));
  const content = state.spaces.length
    ? `<p class="folder-picker-label">Folders</p>${state.spaces.map((space) => `<button type="button" data-explore-space="${escapeAttribute(space.id)}"${space.id === state.explorerSpaceId ? ' aria-current="true"' : ""}>${fileGlyph("folder")}<span>${escapeHtml(space.name)}</span></button>`).join("")}`
    : `<p class="file-empty">${state.spacesLoaded ? "No folders yet. Add one in the desktop app." : "Loading folders…"}</p>`;
  replaceHtmlIfChanged(picker, content);
}

function closeFolderPicker({ restoreFocus = false } = {}) {
  const picker = document.querySelector("#folder-picker");
  const trigger = document.querySelector("#folder-picker-button");
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}

function toggleFolderPicker() {
  const picker = document.querySelector("#folder-picker");
  const trigger = document.querySelector("#folder-picker-button");
  if (!picker || !trigger) return;
  const open = picker.hidden;
  picker.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  if (open) picker.querySelector("button")?.focus({ preventScroll: true });
}

async function refreshExplorerTree() {
  if (fixtureName) return renderWorkspace();
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
  if (!task || state.stoppingTask) return;
  state.stoppingTask = true;
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
    state.stoppingTask = false;
    if (button) button.disabled = false;
    renderConversationChrome();
    }
}

// The conversation is the only question surface. Receipts remain on the host;
// this client neither reads nor acknowledges a feed it does not display.
function updateContextTitle() {
  const title = document.querySelector("#top-bar-title");
  if (title) title.textContent = state.contextName === "spaces" ? "Folders" : "";
}

function cardTime(value) {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return String(value ?? "");
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How long ago, in the words a person would use, then a plain date. */
function relativeTime(value) {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return String(value ?? "");
  const minutesAgo = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutesAgo < 1) return "just now";
  if (minutesAgo < 60) return `${minutesAgo} min ago`;
  const hoursAgo = Math.round(minutesAgo / 60);
  if (hoursAgo < 24) return `${hoursAgo} h ago`;
  return calendarDay(value);
}

function calendarDay(value) {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return String(value ?? "");
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function workAction(action, input, work) {
  if (fixtureName) {
    state.work = action === "stop" ? { ...work, state: "stopped", label: "Stopped", canStop: false, canContinue: false, questions: [], questionCount: 0 } : buildWorkFixture(work.owner.conversationId, "partial");
    return { work: state.work };
  }
  if (action === "stop") {
    await remote("management.stop", { taskId: work.taskId });
    return remote("management.work", { taskId: work.taskId });
  }
  const result = await remote(action === "answer" ? "management.answer" : "management.continue", { taskId: work.taskId, ...input });
  void refreshConversation();
  return result;
}

function addUploads(files) {
  const maximumFiles = 6;
  const maximumFileBytes = 6 * 1024 * 1024;
  const maximumTotalBytes = 8 * 1024 * 1024;
  const next = [...state.uploads];
  // One offending file rejects itself, not the rest of the batch.
  let error = "";
  for (const file of files) {
    if (next.length >= maximumFiles) { error = `Attach up to ${maximumFiles} files.`; break; }
    if (file.size > maximumFileBytes) { error = `${file.name} is larger than 6 MB.`; continue; }
    if (next.reduce((total, item) => total + item.size, 0) + file.size > maximumTotalBytes) { error = "Attachments are limited to 8 MB per message."; continue; }
    next.push(file);
  }
  state.uploads = next;
  state.banner = error;
  syncComposer();
  renderBanner();
}

async function serializeUploads() {
  return Promise.all(state.uploads.map(async (file) => ({ name: file.name, data: base64url(new Uint8Array(await file.arrayBuffer())) })));
}

function renderComposerContext() {
  const container = document.querySelector("#composer-context");
  if (!container) return;
  const uploads = state.uploads.map((file, index) => ({ kind: "upload", name: file.name, index }));
  const changed = replaceHtmlIfChanged(container, uploads.map((item) => `<span class="context-chip">${fileGlyph("file")}<span>${escapeHtml(item.name)}</span><button type="button" data-remove-upload="${item.index}" aria-label="Remove ${escapeAttribute(item.name)}">×</button></span>`).join(""));
  if (!changed) return;
  for (const button of container.querySelectorAll("[data-remove-upload]")) button.addEventListener("click", () => {
    state.uploads.splice(Number(button.dataset.removeUpload), 1);
    syncComposer();
  });
}

function setAccountMenuOpen(button, menu, open) {
  button.setAttribute("aria-expanded", String(open));
  menu.hidden = !open;
}

function closeAccountMenus() {
  for (const button of document.querySelectorAll("[data-account-toggle]")) {
    const menu = document.getElementById(button.dataset.accountToggle);
    if (menu) setAccountMenuOpen(button, menu, false);
  }
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

function assistantLabel() { return "work-fold agent"; }

// Connectivity only appears when action is needed; an available desktop is
// the normal condition and does not consume persistent sidebar space.
function renderDesktopPresence() {
  const presence = document.querySelector("#desktop-presence");
  const text = document.querySelector("#desktop-presence-text");
  if (!presence || !text) return;
  const online = Boolean(state.session?.desktopOnline);
  presence.dataset.online = String(online);
  const label = online ? "" : "Desktop offline";
  presence.hidden = online;
  if (text.textContent !== label) text.textContent = label;
  // In the collapsed rail only the dot is visible; its name rides the tooltip.
  if (presence.dataset.tip !== label) presence.dataset.tip = label;
}

function scheduleRefresh() {
  if (fixtureName) return;
  scheduleBrowserRefresh(state, {
    refreshChats: () => loadConversations({ refreshTranscript: true }),
    onError: (error) => {
      state.banner = errorText(error);
      renderBanner();
    },
  });
}

function openEvents() {
  if (fixtureName) return;
  state.eventSource?.close();
  state.eventSource = new EventSource(browserApiPath("/api/events", location.href));
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
    const wasOnline = Boolean(state.session?.desktopOnline);
    updateConnection(event.desktopOnline === true);
    // A desktop waking up refreshes the stale projections right away instead
    // of waiting out the idle poll interval.
    if (!wasOnline && event.desktopOnline === true) resumeLiveConnection();
    return;
  }
  if (event.type === "operation.event") {
    // Live-watch progress ticks: decrypt, verify the envelope against the
    // watch's own pending request, and paint the activity line. Ticks from a
    // superseded watch are ignored.
    const pendingEvent = state.pendingOperations.get(event.operationId);
    if (!pendingEvent || event.operationId !== state.watchOperationId) return;
    assertResponseEnvelope(event.envelope, event.operationId, pendingEvent.requestId, event.type);
    const payload = await decryptResponse(event.envelope);
    const progress = payload && typeof payload === "object" && payload.progress && typeof payload.progress === "object"
      ? payload.progress
      : null;
    const activity = typeof progress?.activity === "string" ? progress.activity : "";
    const assistantText = typeof progress?.assistantText === "string" ? progress.assistantText : null;
    const assistantDelta = typeof progress?.assistantDelta === "string" ? progress.assistantDelta : "";
    if (activity) state.liveActivity = activity;
    if (assistantText !== null) state.liveAssistantText = assistantText;
    else if (assistantDelta) state.liveAssistantText += assistantDelta;
    if (progress?.assistantTextTruncated === true) state.liveAssistantTextTruncated = true;
    if (activity || assistantText !== null || assistantDelta) {
      renderMessages();
    }
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

async function remote(operation, input = {}, options = {}) {
  if (fixtureName) throw new Error("Fixture preview is inert; nothing is sent.");
  if (!state.session?.paired || !state.identity?.grantId) throw new Error("This browser is not paired.");
  if (!state.session.desktopOnline) throw new Error("Your work-fold desktop is offline.");
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
  options.onAccepted?.(accepted.operation.id);
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
    void pollOperationFallback(accepted.operation.id, options.fallbackIntervalMs);
  });
}

async function pollOperationFallback(operationId, fallbackIntervalMs) {
  // The event stream normally delivers completion first; this fallback exists
  // for a dead or throttled stream. It starts fast, then backs off — further
  // while the stream is healthy — instead of holding a 1Hz poll per request.
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; Date.now() < deadline && state.pendingOperations.has(operationId); attempt += 1) {
    const streamHealthy = state.eventSource?.readyState === EventSource.OPEN;
    await delay(fallbackIntervalMs ?? pollDelay(attempt, streamHealthy));
    if (!state.pendingOperations.has(operationId)) return;
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
      // Recovery re-POSTs count against the operation budget; wait out a
      // cooldown rather than converting throttling into failed recoveries.
      if (!canRecover(state, pending)) continue;
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
  if (fixtureName) throw new Error("Fixture preview is inert; nothing is sent.");
  const response = await fetch(browserApiPath(path, location.href), {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(csrf && state.session?.csrfToken ? { "x-work-fold-csrf": state.session.csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    // An expired or revoked session returns to sign-in once, instead of a
    // zombie shell repeating the same failure every poll.
    if (response.status === 401 && state.session && path !== "/api/auth/login") scheduleSessionReboot();
    // The relay said slow down: background refresh and recovery hold off for
    // a cooldown instead of hammering through the limit at full cadence.
    if (response.status === 429) deferAfterRateLimit(state);
    throw Object.assign(new Error(result.error || `Request failed (${response.status}).`), { status: response.status, code: result.code });
  }
  return result;
}

function scheduleSessionReboot() {
  if (state.sessionRebooting) return;
  state.sessionRebooting = true;
  saveComposerDraft();
  state.session = null;
  filePreview?.connectionChanged(false);
  inlineFilePreview?.connectionChanged(false);
  browserApp?.connectionChanged(false);
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  state.eventSource?.close();
  state.eventSource = null;
  setTimeout(() => void boot(), 0);
}

// Reopens the live lane after a phone unlock, tab restore, or network return:
// the event stream is recreated if the browser killed it, and the projections
// refresh immediately instead of waiting out the poll interval.
function resumeLiveConnection() {
  if (fixtureName || state.sessionRebooting || !state.session?.paired) return;
  if (!document.querySelector(".app-shell")) return;
  if (!state.eventSource || state.eventSource.readyState === EventSource.CLOSED) openEvents();
  // Visibility and connectivity can flap (screen lock, app switching, weak
  // signal); one burst per ten seconds is plenty, and none during a cooldown.
  if (!canResume(state)) return;
  state.lastResumeAt = Date.now();
  void loadConversations().catch((error) => {
    state.banner = errorText(error);
    renderBanner();
  });
}

async function logout() {
  clearQuestionDrafts();
  try { await api("/api/auth/session", { method: "DELETE", csrf: true }); } catch {}
  location.reload();
}

function clearGrantFromIdentity() {
  clearQuestionDrafts();
  for (const key of ["grantId", "generation", "approvalCertificate", "approvalSignature", "deviceSigningPublicJwk", "deviceEncryptionPublicJwk"]) delete state.identity[key];
}

function updateConnection(online = state.session?.desktopOnline) {
  if (Boolean(online) !== Boolean(state.session?.desktopOnline)) { filePreview?.connectionChanged(Boolean(online)); inlineFilePreview?.connectionChanged(Boolean(online)); }
  if (Boolean(online) !== Boolean(state.session?.desktopOnline)) browserApp?.connectionChanged(Boolean(online));
  if (state.session) state.session.desktopOnline = Boolean(online);
  if (online && state.banner === "Your work-fold desktop is offline.") {
    state.banner = "";
    renderBanner();
  }
  renderDesktopPresence();
  syncComposer();
}

function renderBanner() {
  const element = document.querySelector("#banner");
  if (element) replaceHtmlIfChanged(element, state.banner ? `<div class="banner" role="alert"><span>${escapeHtml(state.banner)}</span><button type="button" class="banner-dismiss" aria-label="Dismiss">✕</button></div>` : "");
}

function renderAuth({ eyebrow, headline, supporting, panel }, afterRender) {
  closeFilePreview();
  browserApp?.destroy(); browserApp = null; state.spaceApps.clear();
  app.innerHTML = `<main class="auth-shell">
    <header class="auth-top"><span class="brand" role="img" aria-label="work-fold"><img class="brand-lockup brand-lockup-black" src="/brand-lockup-black.png" alt="" /><img class="brand-lockup brand-lockup-white" src="/brand-lockup-white.png" alt="" /></span></header>
    <section class="auth-stage"><div class="auth-copy"><p class="eyebrow">${eyebrow}</p><h1>${headline}</h1>${supporting ? `<p>${supporting}</p>` : ""}</div><div class="auth-panel">${panel}</div></section>
  </main>`;
  afterRender?.();
}

function renderFatal(message) {
  renderAuth({ eyebrow: "Could not connect", headline: `<span class="nobr">work-fold</span> is unavailable.`, panel: `<p class="form-error">${escapeHtml(message)}</p><button id="fatal-retry" class="primary">Try again</button>` }, () => {
    document.querySelector("#fatal-retry")?.addEventListener("click", () => location.reload());
  });
}

function browserLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  return `${browserName()} on ${platform}`.slice(0, 80);
}
function browserName() {
  const ua = navigator.userAgent;
  // iOS third-party browsers carry their own tokens (CriOS/FxiOS/EdgiOS) and
  // would otherwise all read "Safari" in the pairing prompt.
  if (ua.includes("EdgiOS/")) return "Edge";
  if (ua.includes("CriOS/")) return "Chrome";
  if (ua.includes("FxiOS/")) return "Firefox";
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
