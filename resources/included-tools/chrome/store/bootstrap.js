/* work-fold Store bootstrap. All browser operations remain in pi-chrome. */
importScripts("connection-config.js");
(() => {
  const config = globalThis.WORK_FOLD_CHROME_CONFIG;
  const identityKey = "work-fold.connection.v1";
  let lease;
  let pendingResume;
  let identityPromise;
  let nextResumeAt = 0;
  let retryDelay = 2_000;
  let connectionRevision = 0;
  let summary = { state: "not_connected", checkedAt: new Date().toISOString() };
  const status = (state) => ({ state, checkedAt: new Date().toISOString() });
  const allowedStates = new Set(["not_connected", "connecting", "connected", "app_not_running", "native_host_missing", "update_app", "update_extension", "profile_conflict", "busy", "store_unavailable", "connection_error"]);
  function cleanSummary(value) {
    return { state: allowedStates.has(value?.state) ? value.state : "connection_error",
      checkedAt: typeof value?.checkedAt === "string" ? value.checkedAt : new Date().toISOString(),
      ...(typeof value?.hasSelection === "boolean" ? { hasSelection: value.hasSelection } : {}),
      ...(typeof value?.extensionVersion === "string" ? { extensionVersion: value.extensionVersion.slice(0, 64) } : {}) };
  }
  function secret() { return [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, "0")).join(""); }
  async function identity() {
    if (!identityPromise) identityPromise = (async () => {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      const saved = (await chrome.storage.local.get(identityKey))[identityKey];
      if (typeof saved?.clientId === "string" && /^[a-f0-9-]{36}$/.test(saved.clientId) && /^[a-f0-9]{64}$/.test(saved.clientProof ?? "")) return saved;
      const created = { clientId: crypto.randomUUID(), clientProof: secret(), enabled: false };
      await chrome.storage.local.set({ [identityKey]: created });
      return created;
    })().catch(error => { identityPromise = undefined; throw error; });
    return identityPromise;
  }
  async function clearLease() { lease = undefined; }
  function validLease(value) {
    return value && /^[a-f0-9]{64}$/.test(value.leaseToken ?? "") && typeof value.connectionId === "string"
      && value.connectionId.length <= 128 && value.extensionOrigin === `chrome-extension://${chrome.runtime.id}/`
      && value.bridge?.major === config.bridge.major && Array.isArray(value.bridge.capabilities)
      && config.bridge.capabilities.every(item => value.bridge.capabilities.includes(item));
  }
  async function native(action) {
    const own = await identity();
    const revision = action === "status" ? connectionRevision : ++connectionRevision;
    try {
      const response = await chrome.runtime.sendNativeMessage(config.nativeHostName, {
        version: 1, action, requestId: crypto.randomUUID(), clientId: own.clientId, clientProof: own.clientProof,
        extensionVersion: chrome.runtime.getManifest().version, bridge: config.bridge,
      });
      if (revision !== connectionRevision) return summary;
      if (response?.version !== 1) throw new Error("Native bootstrap version mismatch");
      if (response.state === "lease_ready" && (action === "connect" || action === "resume") && validLease(response.connection)) {
        lease = response.connection;
        summary = { ...status("connecting"), hasSelection: true };
        retryDelay = 2_000; nextResumeAt = 0;
      } else if (response.state === "status") {
        summary = cleanSummary(response.status);
        if ((summary.state === "not_connected" && summary.hasSelection === false) || ["profile_conflict", "update_app", "update_extension", "app_not_running"].includes(summary.state)) await clearLease();
      } else throw new Error("Invalid native bootstrap response");
    } catch (error) {
      if (revision !== connectionRevision) return summary;
      await clearLease();
      // Chrome supplies this local API error; raw native diagnostics never reach UI.
      const message = String(error?.message ?? error);
      summary = status(/not found|not registered|specified native messaging host/i.test(message) ? "native_host_missing" : "connection_error");
    }
    return summary;
  }
  async function connection() {
    if (lease) return lease;
    if (pendingAction) await pendingAction;
    if (lease) return lease;
    const own = await identity();
    if (!own.enabled || Date.now() < nextResumeAt) throw new Error("Chrome is not connected.");
    if (!pendingResume) pendingResume = native("resume").finally(() => {
      pendingResume = undefined;
      if (!lease) { nextResumeAt = Date.now() + retryDelay; retryDelay = Math.min(retryDelay * 2, 30_000); }
    });
    await pendingResume;
    if (!lease) throw new Error("Chrome is not connected.");
    return lease;
  }
  globalThis.workFoldChrome = {
    protocol: config.bridge,
    async config() {
      const active = await connection();
      return { version: 1, mode: "embedded", token: active.leaseToken, connectionId: active.connectionId };
    },
    async response(response, connectionId) {
      if (!lease || lease.connectionId !== connectionId) return;
      if (response.status === 403) { await clearLease(); nextResumeAt = 0; }
      if (response.status === 409) {
        const revision = connectionRevision;
        const body = await response.clone().json().catch(() => ({}));
        if (revision !== connectionRevision || lease?.connectionId !== connectionId) return;
        summary = status(body.state === "update_app" ? "update_app" : "update_extension");
        await clearLease(); nextResumeAt = Date.now() + 30_000;
      }
    },
  };
  let pendingAction;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const ownOrigin = `chrome-extension://${chrome.runtime.id}/`;
    if (sender.id !== chrome.runtime.id || ![`${ownOrigin}popup.html`, `${ownOrigin}welcome.html`].includes(sender.url ?? "")) return false;
    const action = message?.action;
    if (!new Set(["status", "connect", "disconnect", "open-app"]).has(action) || message?.type !== "work-fold.connection") return false;
    if (pendingAction && action !== "status") { respond(status("connecting")); return false; }
    const operation = async () => {
      if (action === "status") return pendingAction ? await pendingAction : native("status");
      const own = await identity();
      if (action === "connect") { own.enabled = true; await chrome.storage.local.set({ [identityKey]: own }); nextResumeAt = 0; }
      const result = await native(action);
      if (action === "disconnect" && result.state === "not_connected") {
        own.enabled = false; await chrome.storage.local.set({ [identityKey]: own }); await clearLease();
      }
      return result;
    };
    const request = operation();
    if (action !== "status") pendingAction = request;
    const settled = value => { if (pendingAction === request) pendingAction = undefined; respond(value); };
    request.then(settled, () => settled(status("connection_error")));
    return true;
  });
  chrome.runtime.onInstalled.addListener(details => {
    if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  });
})();
