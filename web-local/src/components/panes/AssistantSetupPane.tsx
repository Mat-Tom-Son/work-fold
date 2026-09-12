import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { resolveAssistantModelSelection } from "../../lib/assistant-model-selection";
import type { AgentModel, AgentModelCatalog, AgentStatus, SpaceSummary } from "../../types";

export type AssistantModelScope = "space" | "management";

type AssistantSetupProps = {
  space: SpaceSummary | null;
  status: AgentStatus;
  fixtureMode?: boolean;
  embedded?: boolean;
  active?: boolean;
  initialScope?: AssistantModelScope;
  focusModelOnOpen?: boolean;
  onConfigured: (status: AgentStatus) => void;
  onAssistantChanged?: (scope: AssistantModelScope, status: AgentStatus) => void;
};

type AssistantMutation = { done: Promise<void>; release: () => void };
// Accepted writes outlive a Settings window. A reopened form must wait for
// them too; this holds no settings or credentials, only completion ownership.
let assistantMutation: AssistantMutation | null = null;
const mutationListeners = new Set<() => void>();
function subscribeMutation(listener: () => void) { mutationListeners.add(listener); return () => { mutationListeners.delete(listener); }; }
function beginAssistantMutation(): (() => void) | null {
  if (assistantMutation) return null;
  let resolve!: () => void;
  const operation = { done: new Promise<void>((done) => { resolve = done; }), release: () => {} };
  operation.release = () => {
    if (assistantMutation !== operation) return;
    assistantMutation = null;
    resolve();
    for (const listener of mutationListeners) listener();
  };
  assistantMutation = operation;
  for (const listener of mutationListeners) listener();
  return operation.release;
}

type AssistantDraft = { model?: { provider: string; model: string }; instructions?: string };
export function AssistantSetupPane(props: AssistantSetupProps) {
  const { space, embedded = false, initialScope, active = true, focusModelOnOpen = false } = props;
  const identity = JSON.stringify([space?.id ?? null, initialScope ?? null]);
  const defaultScope = initialScope === "management" || !space ? "management" : "space";
  const [selection, setSelection] = useState<{ identity: string; scope: AssistantModelScope }>({ identity, scope: defaultScope });
  // Resolve before effects so removing the last Space cannot issue an invalid
  // scope=space request while waiting for state to catch up.
  const scope = selection.identity === identity ? selection.scope : defaultScope;
  useEffect(() => { setSelection({ identity, scope: defaultScope }); }, [identity]);
  const target = scope === "space" ? `space:${space!.id}` : "management";
  const currentSpaceTarget = useRef<string | null>(null);
  currentSpaceTarget.current = space ? `space:${space.id}` : null;
  const drafts = useRef(new Map<string, AssistantDraft>());
  for (const key of drafts.current.keys()) {
    if (key !== "management" && key !== currentSpaceTarget.current) drafts.current.delete(key);
  }
  const mutationBusy = useSyncExternalStore(subscribeMutation, () => assistantMutation !== null, () => false);
  const initialIdentity = useRef(identity);
  const focusRequest = useRef({ pending: focusModelOnOpen && active, origin: null as Element | null });
  if (!active || identity !== initialIdentity.current) focusRequest.current.pending = false;
  useEffect(() => {
    let disposed = false;
    const yieldFocus = () => { focusRequest.current.pending = false; };
    // Parent modal effects establish the opening focus after child effects.
    // Capture that owned entry before the next user-input event can arrive.
    queueMicrotask(() => {
      if (disposed) return;
      focusRequest.current.origin = document.activeElement;
      document.addEventListener("focusin", yieldFocus);
      document.addEventListener("pointerdown", yieldFocus);
    });
    return () => { disposed = true; document.removeEventListener("focusin", yieldFocus); document.removeEventListener("pointerdown", yieldFocus); };
  }, []);

  function focusModelWhenReady(node: HTMLSelectElement | null) {
    const request = focusRequest.current;
    if (!node || node.disabled || !request.pending || !active) return;
    request.pending = false;
    if (document.activeElement === request.origin) node.focus();
  }
  function changeScope(next: AssistantModelScope) {
    focusRequest.current.pending = false;
    setSelection({ identity, scope: next });
  }
  function editDraft(edit: (draft: AssistantDraft) => AssistantDraft) {
    if (target !== "management" && target !== currentSpaceTarget.current) return;
    drafts.current.set(target, edit(drafts.current.get(target) ?? {}));
  }

  return (
    <div className={embedded ? "assistant-settings-panel professional-assistant" : "space-pane-content assistant-pane professional-surface professional-assistant"}>
      <fieldset className="assistant-scope-control">
        <legend>Model defaults for</legend>
        {space ? <label className={scope === "space" ? "active" : ""}>
          <input type="radio" name="assistant-model-scope" value="space" checked={scope === "space"} onChange={() => changeScope("space")} />
          <span>This worker<small>{space.name}</small></span>
        </label> : null}
        <label className={scope === "management" ? "active" : ""}>
          <input type="radio" name="assistant-model-scope" value="management" checked={scope === "management"} onChange={() => changeScope("management")} />
          <span>work-fold agent<small>Menu bar and web</small></span>
        </label>
      </fieldset>
      <AssistantScopeSettings
        {...props}
        key={JSON.stringify([scope, scope === "space" ? space?.id : null])}
        scope={scope}
        mutationBusy={mutationBusy}
        beginMutation={beginAssistantMutation}
        waitForMutation={() => assistantMutation?.done ?? Promise.resolve()}
        isMutating={() => assistantMutation !== null}
        readDraft={() => drafts.current.get(target) ?? {}}
        editDraft={editDraft}
        focusModelWhenReady={focusModelWhenReady}
      />
    </div>
  );
}

function AssistantScopeSettings({ space, status, scope, fixtureMode = false, active = true, onConfigured, onAssistantChanged, mutationBusy, beginMutation, waitForMutation, isMutating, readDraft, editDraft, focusModelWhenReady }: AssistantSetupProps & {
  scope: AssistantModelScope;
  mutationBusy: boolean;
  beginMutation: () => (() => void) | null;
  waitForMutation: () => Promise<void>;
  isMutating: () => boolean;
  readDraft: () => AssistantDraft;
  editDraft: (edit: (draft: AssistantDraft) => AssistantDraft) => void;
  focusModelWhenReady: (node: HTMLSelectElement | null) => void;
}) {
  const [scopeStatus, setScopeStatus] = useState(status);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [catalogs, setCatalogs] = useState<AgentModelCatalog[]>([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [externalChange, setExternalChange] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<AssistantFeedback | null>(null);
  const [connectionFeedback, setConnectionFeedback] = useState<AssistantFeedback | null>(null);
  const [instructionsFeedback, setInstructionsFeedback] = useState<AssistantFeedback | null>(null);
  const [saving, setSaving] = useState<"model" | "connection" | "remove" | null>(null);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(false);
  const providerRevision = useRef(0);
  const refresh = useRef<AbortController | null>(null);
  const localRevision = useRef(0);
  const modelSelect = useRef<HTMLSelectElement>(null);
  const currentForm = useRef({ dirty: false, loading: true, snapshot: "" });

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; refresh.current?.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    async function load() {
      // A new target may open while the previous target's accepted write is
      // finishing. Read after it settles, rather than displaying old auth.
      await waitForMutation();
      if (controller.signal.aborted) return;
      const result = fixtureMode ? {
        models: [
          { provider: "openrouter", providerName: "OpenRouter", id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash — Fast reasoning and general tasks", authConfigured: true, authSource: "stored" as const, authType: "api_key" as const, oauthSupported: false },
          { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-4", name: "Claude Sonnet", authConfigured: false, oauthSupported: false },
        ],
        catalogs: [{ provider: "openrouter", refreshable: true, source: "live" as const, refreshedAt: new Date().toISOString(), modelCount: 1 }],
        status: { ...status, configured: true, provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
        instructions: scope === "space" ? "Keep answers concise and test changes in this folder." : null,
      } : await api<{ models: AgentModel[]; status: AgentStatus; catalogs: AgentModelCatalog[]; instructions: string | null }>(`/api/agent/models?${assistantScopeParams(scope, space)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      applyLoadedSettings(result, true);
    }
    void load().catch((caught) => {
      if (!controller.signal.aborted) setLoadError(errorText(caught));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // This component's key owns its exact scope. Parent status updates must
    // not reload and overwrite a person's unsaved model or instructions.
  }, [fixtureMode, loadAttempt]);

  const providers = unique(models.map((item) => item.provider)).sort((left, right) => providerDisplayName(models, left).localeCompare(providerDisplayName(models, right)));
  const providerModels = models.filter((item) => item.provider === provider);
  const providerAuth = providerModels.find((item) => item.authConfigured);
  const authConfigured = Boolean(providerAuth);
  const removableAuth = providerAuth?.authSource === "stored";
  const oauthSupported = providerModels.some((item) => item.oauthSupported);
  const accountOnly = providerAccountOnly(provider);
  const subscriptionNote = oauthSupported ? providerSubscriptionNote(provider) : null;
  const catalog = catalogs.find((item) => item.provider === provider);
  const providerName = providerDisplayName(models, provider);
  const scopeLabel = scope === "management" ? "work-fold agent" : space?.name ?? "This worker";
  const modelChanged = !scopeStatus.configured || provider !== scopeStatus.provider || model !== scopeStatus.model;
  const instructionsChanged = instructions.trim() !== savedInstructions;
  const operationBusy = mutationBusy || refreshing;
  currentForm.current = { dirty: provider !== scopeStatus.provider || model !== scopeStatus.model || instructionsChanged || Boolean(apiKey), loading: loading || Boolean(loadError),
    snapshot: settingsSnapshot({ models, catalogs, status: scopeStatus, instructions: savedInstructions }) };

  function applyLoadedSettings(result: AssistantSettingsResponse, restoreDraft = false) {
    const draft = restoreDraft ? readDraft() : {};
    setModels(result.models);
    setCatalogs(result.catalogs);
    setScopeStatus(result.status);
    setInstructions(draft.instructions ?? result.instructions ?? "");
    setSavedInstructions(result.instructions ?? "");
    const first = result.models.find((item) => item.provider === result.status.provider)
      ?? result.models.find((item) => item.provider === "openrouter") ?? result.models[0];
    const nextProvider = draft.model?.provider ?? first?.provider ?? "";
    setProvider(nextProvider);
    setModel(resolveAssistantModelSelection(result.models, nextProvider, draft.model?.model ?? result.status.model ?? ""));
    editDraft((current) => ({
      ...current,
      ...(current.model?.provider === result.status.provider && current.model?.model === result.status.model ? { model: undefined } : {}),
      ...(current.instructions?.trim() === (result.instructions ?? "") ? { instructions: undefined } : {}),
    }));
    setApiKey("");
    setExternalChange(false);
    setModelFeedback(null);
    setConnectionFeedback(null);
    setInstructionsFeedback(null);
  }

  useEffect(() => {
    if (fixtureMode) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const unsubscribe = subscribeControlEvents((hint) => {
      if ((hint !== "assistant" && hint !== "reset") || isMutating()) return;
      if (currentForm.current.loading) { setLoadAttempt((current) => current + 1); return; }
      controller?.abort();
      const read = new AbortController();
      controller = read;
      const revision = localRevision.current;
      void api<AssistantSettingsResponse>(`/api/agent/models?${assistantScopeParams(scope, space)}`, { signal: read.signal })
        .then((result) => {
          if (disposed || read.signal.aborted || revision !== localRevision.current || isMutating()) return;
          if (settingsSnapshot(result) === currentForm.current.snapshot) return;
          // An outside write can refresh a clean form in place. Dirty drafts
          // remain visible until the person explicitly reloads saved values.
          if (currentForm.current.dirty || refresh.current) setExternalChange(true);
          else applyLoadedSettings(result);
        }).catch(() => {
          if (!disposed && !read.signal.aborted && revision === localRevision.current) setExternalChange(true);
        });
    });
    return () => { disposed = true; controller?.abort(); unsubscribe(); };
  }, [fixtureMode]);

  useEffect(() => {
    if (!loading && active) focusModelWhenReady(modelSelect.current);
  }, [loading, active]);

  function updateModelDraft(nextProvider: string, nextModel: string) {
    editDraft((draft) => ({ ...draft, model: nextProvider === scopeStatus.provider && nextModel === scopeStatus.model
      ? undefined : { provider: nextProvider, model: nextModel } }));
  }
  function reportConfigured(next: AgentStatus) {
    setScopeStatus(next);
    if (scope === "space") onConfigured(next);
    onAssistantChanged?.(scope, next);
  }

  function changeProvider(next: string) {
    if (isMutating()) return;
    providerRevision.current += 1;
    refresh.current?.abort();
    setProvider(next);
    const nextModel = resolveAssistantModelSelection(models, next, "");
    setModel(nextModel);
    updateModelDraft(next, nextModel);
    setApiKey("");
    setModelFeedback(null);
    setConnectionFeedback(null);
  }

  async function configure(kind: "model" | "key" | "oauth") {
    if (loading || !model || refresh.current || (kind === "model" && (!authConfigured || !modelChanged))
      || (kind === "key" && (authConfigured || !apiKey.trim()))) return;
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    const connection = kind !== "model";
    const feedback = connection ? setConnectionFeedback : setModelFeedback;
    setSaving(connection ? "connection" : "model");
    feedback(null);
    const submittedApiKey = kind === "key" ? apiKey.trim() : "";
    try {
      const result = fixtureMode ? { status: { ...scopeStatus, configured: true, provider, model } }
        : await api<{ status: AgentStatus }>(kind === "oauth" ? "/api/agent/oauth" : "/api/agent/configure", {
          method: "POST",
          body: { ...assistantScopeBody(scope, space), provider, model, ...(submittedApiKey ? { apiKey: submittedApiKey } : {}) },
        });
      editDraft((draft) => ({ ...draft, model: draft.model?.provider === provider && draft.model?.model === model ? undefined : draft.model }));
      if (!live.current) return;
      if (connection) setModels((current) => current.map((item) => item.provider === provider ? {
        ...item, authConfigured: true, authSource: "stored", authType: kind === "oauth" ? "oauth" : "api_key",
      } : item));
      setApiKey("");
      reportConfigured(result.status);
      feedback({ text: connection ? "Connected and model saved" : "Model saved" });
    } catch (caught) { if (live.current) feedback({ error: true, text: errorText(caught) }); }
    finally { if (live.current) setSaving(null); release(); }
  }

  async function removeCredential() {
    if (!removableAuth || refresh.current) return;
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    setSaving("remove");
    setConnectionFeedback(null);
    try {
      const result = fixtureMode ? {
        models: models.map((item) => item.provider === provider ? { ...item, authConfigured: false } : item),
        status: { ...scopeStatus, configured: false },
      } : await api<{ models: AgentModel[]; status: AgentStatus }>("/api/agent/auth", {
        method: "DELETE", body: { ...assistantScopeBody(scope, space), provider },
      });
      if (!live.current) return;
      setModels(result.models);
      setApiKey("");
      reportConfigured(result.status);
      setModelFeedback(null);
      setConnectionFeedback({ text: providerAuth?.authType === "oauth" ? "Account disconnected" : "API key removed" });
    } catch (caught) { if (live.current) setConnectionFeedback({ error: true, text: errorText(caught) }); }
    finally { if (live.current) setSaving(null); release(); }
  }

  async function refreshModels() {
    if (isMutating() || refresh.current || !catalog?.refreshable || !authConfigured) return;
    const controller = new AbortController();
    localRevision.current += 1;
    const revision = providerRevision.current;
    refresh.current = controller;
    setRefreshing(true);
    setModelFeedback(null);
    try {
      const result = fixtureMode ? { models, catalogs, refresh: { modelCount: models.length } }
        : await api<{ models: AgentModel[]; catalogs: AgentModelCatalog[]; refresh: { modelCount: number } }>("/api/agent/models/refresh", {
          method: "POST", body: { ...assistantScopeBody(scope, space), provider }, signal: controller.signal,
        });
      if (!live.current || controller.signal.aborted || revision !== providerRevision.current) return;
      setModels(result.models);
      setCatalogs(result.catalogs);
      setModel((current) => resolveAssistantModelSelection(result.models, provider, current));
      // Refresh updates catalog metadata; it must not overwrite saved defaults
      // or report an Assistant configuration change that never happened.
      setModelFeedback({ text: `${result.refresh.modelCount} models refreshed from ${providerName}` });
    } catch (caught) {
      if (live.current && !controller.signal.aborted && revision === providerRevision.current) setModelFeedback({ error: true, text: errorText(caught) });
    } finally {
      if (refresh.current === controller) refresh.current = null;
      if (live.current) setRefreshing(false);
    }
  }

  async function saveInstructions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (scope !== "space" || !space || !instructionsChanged || loading) return;
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    const submitted = instructions;
    setSavingInstructions(true);
    setInstructionsFeedback(null);
    try {
      const result = fixtureMode ? { instructions: submitted.trim() }
        : await api<{ instructions: string }>("/api/agent/instructions", {
          method: "POST", body: { scope: "space", spaceId: space.id, instructions: submitted },
        });
      editDraft((draft) => ({ ...draft, instructions: draft.instructions?.trim() === result.instructions ? undefined : draft.instructions }));
      if (!live.current) return;
      setSavedInstructions(result.instructions);
      setInstructions((current) => current === submitted ? result.instructions : current);
      setInstructionsFeedback({ text: "Instructions saved" });
    } catch (caught) { if (live.current) setInstructionsFeedback({ error: true, text: errorText(caught) }); }
    finally { if (live.current) setSavingInstructions(false); release(); }
  }

  if (loading) return <div className="professional-loading-row" role="status"><RefreshCw className="spin" />Loading Assistant settings…</div>;
  if (loadError) return <div className="assistant-settings-section"><AssistantOperationStatus feedback={{ error: true, text: loadError }} /><button className="professional-button professional-button-secondary" type="button" onClick={() => { localRevision.current += 1; setLoadAttempt((current) => current + 1); }}>Try again</button></div>;

  return <>
    {externalChange ? <div className="assistant-external-change"><span>Saved settings have changed.</span><button className="assistant-refresh-models" type="button" disabled={operationBusy} onClick={() => { localRevision.current += 1; editDraft(() => ({})); setExternalChange(false); setLoading(true); setLoadAttempt((current) => current + 1); }}>Reload saved settings</button></div> : null}
    <section className="assistant-settings-section" aria-labelledby="assistant-model-heading">
      <div className="assistant-section-heading"><h3 id="assistant-model-heading">Model</h3><p>For new Chats</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void configure("model"); }}>
        <div className="assistant-form-fields">
          <label className="professional-field"><span className="professional-field-label">Provider</span>
            <select aria-label="Provider" value={provider} disabled={mutationBusy || !providers.length} onChange={(event) => changeProvider(event.target.value)}>{providers.map((item) => <option value={item} key={item}>{providerDisplayName(models, item)}</option>)}</select>
          </label>
          <div className="professional-field">
            <div className="assistant-model-field-heading"><label className="professional-field-label" htmlFor="assistant-model">Model</label>
              {catalog?.refreshable ? <button className="assistant-refresh-models" type="button" disabled={operationBusy || !authConfigured} title={authConfigured ? `Refresh ${providerName} models` : `Connect ${providerName} below to refresh models`} onClick={() => void refreshModels()}><RefreshCw className={refreshing ? "spin" : undefined} />{refreshing ? "Refreshing…" : "Refresh"}</button> : null}
            </div>
            <select id="assistant-model" ref={modelSelect} value={model} disabled={mutationBusy || !providerModels.length} onChange={(event) => { if (isMutating()) return; setModel(event.target.value); updateModelDraft(provider, event.target.value); setModelFeedback(null); }}>{providerModels.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}</select>
            {catalog?.source === "live" && catalog.refreshedAt ? <span className="professional-field-hint">List updated {formatCatalogDate(catalog.refreshedAt)}</span> : null}
          </div>
        </div>
        <div className="assistant-form-actions">
          <button className="professional-button professional-button-primary" type="submit" disabled={operationBusy || !model || !modelChanged || !authConfigured}>{saving === "model" ? "Saving…" : "Save model"}</button>
          <AssistantOperationStatus feedback={modelFeedback} hint={!models.length ? "No models available." : !authConfigured ? "Connect this provider first." : undefined} />
        </div>
      </form>
    </section>
    <section className="assistant-settings-section" aria-labelledby="assistant-connection-heading">
      <div className="assistant-section-heading"><h3 id="assistant-connection-heading">Connection</h3><p>Shared on this computer</p></div>
      <div className="assistant-connection-row">
        <div><strong>{providerName || "Choose a provider"}</strong><p>{assistantCredentialStatus(providerAuth) ?? "Not connected"}</p></div>
        {removableAuth ? <button className="professional-button professional-button-secondary" type="button" disabled={operationBusy} onClick={() => void removeCredential()}>{saving === "remove" ? "Removing…" : providerAuth?.authType === "oauth" ? "Disconnect account" : "Remove API key"}</button> : null}
      </div>
      {!authConfigured && !accountOnly && provider ? <form onSubmit={(event) => { event.preventDefault(); void configure("key"); }}>
        <label className="professional-field"><span className="professional-field-label">API key</span><input id="assistant-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConnectionFeedback(null); }} placeholder="Paste a key" autoComplete="off" spellCheck={false} disabled={mutationBusy} /></label>
        <div className="assistant-form-actions"><button className="professional-button professional-button-secondary" type="submit" disabled={operationBusy || !model || !apiKey.trim()}>{saving === "connection" ? "Connecting…" : "Connect and save model"}</button></div>
      </form> : null}
      {oauthSupported ? <div className="assistant-form-actions"><button className="professional-button professional-button-secondary" type="button" disabled={operationBusy || !model} onClick={() => void configure("oauth")}>{saving === "connection" ? "Connecting…" : assistantAccountAction(provider, providerAuth?.authType === "oauth")}</button><span className="professional-field-hint">Also saves the selected model for {scopeLabel}.</span></div> : null}
      {accountOnly && !oauthSupported ? <p className="professional-field-hint">Account sign-in is available in the desktop app.</p> : null}
      <AssistantOperationStatus feedback={connectionFeedback} />
      {subscriptionNote ? <p className="assistant-provider-note">{subscriptionNote}</p> : null}
    </section>
    {scope === "space" ? <section className="assistant-settings-section" aria-labelledby="assistant-instructions-heading">
      <div className="assistant-section-heading"><h3 id="assistant-instructions-heading">Worker instructions</h3></div>
      <form onSubmit={(event) => void saveInstructions(event)}>
        <label className="professional-field assistant-instructions-field"><span className="sr-only">Worker instructions</span><textarea value={instructions} maxLength={8000} rows={5} onChange={(event) => { setInstructions(event.target.value); editDraft((draft) => ({ ...draft, instructions: event.target.value.trim() === savedInstructions ? undefined : event.target.value })); setInstructionsFeedback(null); }}  /></label>
        <div className="assistant-form-actions"><button className="professional-button professional-button-secondary" type="submit" disabled={mutationBusy || !instructionsChanged}>{savingInstructions ? "Saving…" : "Save instructions"}</button><AssistantOperationStatus feedback={instructionsFeedback?.error || !instructionsChanged ? instructionsFeedback : null} hint={instructionsChanged ? "Unsaved changes" : undefined} /></div>
      </form>
    </section> : null}
  </>;
}

type AssistantSettingsResponse = { models: AgentModel[]; status: AgentStatus; catalogs: AgentModelCatalog[]; instructions: string | null };
function settingsSnapshot(result: AssistantSettingsResponse): string {
  return JSON.stringify([result.status.provider, result.status.model, result.status.configured, result.models, result.catalogs, result.instructions ?? ""]);
}

type AssistantFeedback = { text: string; error?: boolean };
function AssistantOperationStatus({ feedback, hint }: { feedback: AssistantFeedback | null; hint?: string }) {
  return <div className={feedback?.error ? "assistant-operation-status error" : "assistant-operation-status"} role={feedback?.error ? "alert" : "status"}>{feedback?.text ?? hint ?? ""}</div>;
}

function unique<T>(items: T[]) { return [...new Set(items)]; }
function providerDisplayName(models: AgentModel[], provider: string) { return models.find((item) => item.provider === provider)?.providerName || provider; }
function assistantCredentialStatus(model: AgentModel | undefined) {
  if (!model?.authConfigured) return null;
  if (model.authSource === "stored") return model.authType === "oauth" ? "Provider account connected on this computer" : "API key saved on this computer";
  if (model.authSource === "environment") return `API key supplied by ${model.authLabel || "the app environment"}`;
  if (model.authSource === "models_json_key" || model.authSource === "models_json_command") return "Credential configured in Pi models settings";
  return "Credential supplied outside work-fold";
}
function providerAccountOnly(provider: string) {
  return provider === "openai-codex" || provider === "github-copilot";
}
function assistantAccountAction(provider: string, configured: boolean) {
  if (configured) return "Reconnect account";
  if (provider === "openai-codex") return "Sign in with ChatGPT";
  if (provider === "github-copilot") return "Sign in with GitHub";
  if (provider === "anthropic") return "Connect Anthropic account";
  return "Connect account";
}
function providerSubscriptionNote(provider: string) {
  if (provider === "openai-codex") return "Connects to OpenAI’s Codex subscription service. Eligibility and limits follow your ChatGPT plan; OpenAI API usage is a separate connection under the OpenAI provider.";
  if (provider === "github-copilot") return "Connects through GitHub OAuth. GitHub controls account eligibility, available models, and billing.";
  if (provider === "anthropic") return "Anthropic recommends API-key authentication for third-party tools. A Claude subscription may not cover work-fold; usage credits and current account terms can apply.";
  return "Availability and limits follow the provider’s current account terms.";
}
function assistantScopeParams(scope: AssistantModelScope, space: SpaceSummary | null) {
  const params = new URLSearchParams({ scope });
  if (scope === "space" && space) params.set("spaceId", space.id);
  return params.toString();
}
function assistantScopeBody(scope: AssistantModelScope, space: SpaceSummary | null) {
  return scope === "management" ? { scope } : { scope, spaceId: space?.id };
}
function formatCatalogDate(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
