import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ModelCatalogList, modelCatalogKey } from "./ModelCatalogList";
import { RefreshCw } from "lucide-react";
import { Eye20Regular, EyeOff20Regular } from "@fluentui/react-icons";
import { api, errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { resolveAssistantModelSelection } from "../../lib/assistant-model-selection";
import type { AgentModel, AgentModelCatalog, AgentProvider, AgentStatus, SpaceSummary } from "../../types";
import { AZURE_OPENAI_PROVIDER, normalizeAzureOpenAIConnection, parseAzureDeploymentNames, type AzureOpenAIConnection } from "../../../../src/shared/azure-openai";

const emptyAzureConnection: AzureOpenAIConnection = { baseUrl: "", deployments: [] };

export type AssistantModelScope = "space" | "management";

type AssistantSetupProps = {
  space: SpaceSummary | null;
  status: AgentStatus;
  fixtureMode?: boolean;
  embedded?: boolean;
  active?: boolean;
  initialScope?: AssistantModelScope;
  focusModelOnOpen?: boolean;
  focusInstructionsOnOpen?: boolean;
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

type AzureConnectionDraft = { baseUrl: string; deployments: string };
type AssistantDraft = { model?: { provider: string; model: string }; connectionProvider?: string; instructions?: string; azure?: AzureConnectionDraft };
export function AssistantSetupPane(props: AssistantSetupProps) {
  const { space, embedded = false, initialScope, active = true, focusModelOnOpen = false, focusInstructionsOnOpen = false } = props;
  const identity = JSON.stringify([space?.id ?? null, initialScope ?? null]);
  const defaultScope = initialScope === "management" || !space ? "management" : "space";
  const [selection, setSelection] = useState<{ identity: string; scope: AssistantModelScope }>({ identity, scope: defaultScope });
  // Resolve before effects so removing the last Space cannot issue an invalid
  // scope=space request while waiting for state to catch up.
  const scope = selection.identity === identity ? selection.scope : defaultScope;
  useEffect(() => { setSelection({ identity, scope: defaultScope }); }, [identity]);
  const currentSpaceTarget = useRef<string | null>(null);
  currentSpaceTarget.current = space ? `space:${space.id}` : null;
  const drafts = useRef(new Map<string, AssistantDraft>());
  for (const key of drafts.current.keys()) {
    if (key !== "management" && key !== currentSpaceTarget.current) drafts.current.delete(key);
  }
  const mutationBusy = useSyncExternalStore(subscribeMutation, () => assistantMutation !== null, () => false);
  const initialIdentity = useRef(identity);
  const focusRequest = useRef({ pending: (focusModelOnOpen || focusInstructionsOnOpen) && active, origin: null as Element | null });
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

  function focusModelWhenReady(node: HTMLElement | null) {
    const request = focusRequest.current;
    if (!node || ("disabled" in node && node.disabled) || !request.pending || !active) return;
    request.pending = false;
    if (document.activeElement === request.origin) node.focus();
  }
  function changeScope(next: AssistantModelScope) {
    focusRequest.current.pending = false;
    setSelection({ identity, scope: next });
  }
  function editDraftFor(draftTarget: string, edit: (draft: AssistantDraft) => AssistantDraft) {
    if (draftTarget !== "management" && draftTarget !== currentSpaceTarget.current) return;
    drafts.current.set(draftTarget, edit(drafts.current.get(draftTarget) ?? {}));
  }
  const target = scope === "space" ? `space:${space!.id}` : "management";
  // What each scope last showed. Switching scopes mounts from here at once and
  // refreshes quietly, instead of clearing the form behind a spinner; the
  // other scope is read ahead as soon as the visible one has loaded.
  const loaded = useRef(new Map<string, AssistantSettingsResponse>());
  const [prefetchTick, setPrefetchTick] = useState(0);
  useEffect(() => {
    if (!space || props.fixtureMode || prefetchTick === 0) return;
    const other: AssistantModelScope = scope === "space" ? "management" : "space";
    const otherTarget = other === "space" ? `space:${space.id}` : "management";
    if (loaded.current.has(otherTarget)) return;
    const controller = new AbortController();
    void (async () => {
      await (assistantMutation?.done ?? Promise.resolve());
      if (controller.signal.aborted) return;
      const result = await api<AssistantSettingsResponse>(`/api/agent/models?${assistantScopeParams(other, space)}`, { signal: controller.signal });
      if (!controller.signal.aborted && !loaded.current.has(otherTarget)) loaded.current.set(otherTarget, result);
    })().catch(() => { /* the switch loads normally */ });
    return () => controller.abort();
  }, [prefetchTick, scope, space?.id, props.fixtureMode]);

  return (
    <div className={embedded ? "assistant-settings-panel professional-assistant" : "space-pane-content assistant-pane professional-surface professional-assistant"}>
      {space ? <fieldset className="assistant-scope-control">
        <legend>Model defaults</legend>
        <label className={scope === "space" ? "active" : ""}>
          <input type="radio" name="assistant-model-scope" value="space" checked={scope === "space"} onChange={() => changeScope("space")} />
          <span>This worker<small>{space.name}</small></span>
        </label>
        <label className={scope === "management" ? "active" : ""}>
          <input type="radio" name="assistant-model-scope" value="management" checked={scope === "management"} onChange={() => changeScope("management")} />
          <span>work-fold agent</span>
        </label>
      </fieldset> : <div className="assistant-singleton-scope">work-fold agent</div>}
      <AssistantScopeSettings
        {...props}
        key={JSON.stringify([scope, scope === "space" ? space?.id : null])}
        scope={scope}
        mutationBusy={mutationBusy}
        beginMutation={beginAssistantMutation}
        waitForMutation={() => assistantMutation?.done ?? Promise.resolve()}
        isMutating={() => assistantMutation !== null}
        readDraft={() => drafts.current.get(target) ?? {}}
        editDraft={(edit) => editDraftFor(target, edit)}
        focusModelWhenReady={focusModelWhenReady}
        initialResult={loaded.current.get(target)}
        onSnapshot={(result) => loaded.current.set(target, result)}
        onLoaded={() => setPrefetchTick((current) => current + 1)}
      />
    </div>
  );
}

function AssistantScopeSettings({ space, status, scope, fixtureMode = false, active = true, onConfigured, onAssistantChanged, mutationBusy, beginMutation, waitForMutation, isMutating, readDraft, editDraft, focusModelWhenReady, focusInstructionsOnOpen, initialResult, onSnapshot, onLoaded }: AssistantSetupProps & {
  scope: AssistantModelScope;
  mutationBusy: boolean;
  beginMutation: () => (() => void) | null;
  waitForMutation: () => Promise<void>;
  isMutating: () => boolean;
  readDraft: () => AssistantDraft;
  editDraft: (edit: (draft: AssistantDraft) => AssistantDraft) => void;
  focusModelWhenReady: (node: HTMLElement | null) => void;
  /** The last saved settings this scope showed, applied at once while a fresh read runs quietly. */
  initialResult?: AssistantSettingsResponse;
  /** The saved settings this scope currently shows, kept for its next mount. */
  onSnapshot?: (result: AssistantSettingsResponse) => void;
  /** Called once this scope's first read has finished. */
  onLoaded?: () => void;
}) {
  const [scopeStatus, setScopeStatus] = useState(status);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [providerCatalog, setProviderCatalog] = useState<AgentProvider[]>([]);
  const [catalogs, setCatalogs] = useState<AgentModelCatalog[]>([]);
  const [provider, setProvider] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const apiKeyField = useRef<HTMLInputElement>(null);
  const [azure, setAzure] = useState<AzureConnectionDraft>(() => azureConnectionDraft(emptyAzureConnection));
  const [savedAzure, setSavedAzure] = useState<AzureOpenAIConnection>(emptyAzureConnection);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const initialResultRef = useRef(initialResult);
  const instructionsField = useRef<HTMLTextAreaElement>(null);
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [loading, setLoading] = useState(!initialResult);
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
  const modelSelect = useRef<HTMLElement>(null);
  const currentForm = useRef({ dirty: false, loading: true, snapshot: "" });

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; refresh.current?.abort(); };
  }, []);
  // What this scope last showed is on screen before the first paint.
  useLayoutEffect(() => {
    const cached = initialResultRef.current;
    if (cached) applyLoadedSettings(cached, true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const revision = localRevision.current;
    // A scope that was shown before comes back at once from what it last
    // showed; the read below then refreshes it without a spinner.
    const cached = loadAttempt === 0 ? initialResultRef.current : undefined;
    if (!cached) setLoading(true);
    setLoadError(null);
    async function load() {
      // A new target may open while the previous target's accepted write is
      // finishing. Read after it settles, rather than displaying old auth.
      await waitForMutation();
      if (controller.signal.aborted || revision !== localRevision.current || isMutating()) return;
      const result = fixtureMode ? {
        models: [
          // Enough OpenRouter models, across several vendors, for the dropdown's search box and vendor headings to appear.
          ...[
            ["deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash — Fast reasoning and general tasks"],
            ["deepseek/deepseek-v4.1", "DeepSeek: DeepSeek V4.1"],
            ["anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5"],
            ["anthropic/claude-opus-4.1", "Anthropic: Claude Opus 4.1"],
            ["openai/gpt-5", "OpenAI: GPT-5"],
            ["openai/gpt-5-mini", "OpenAI: GPT-5 Mini"],
            ["google/gemini-2.5-pro", "Google: Gemini 2.5 Pro"],
            ["google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"],
            ["meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick"],
            ["qwen/qwen3-coder", "Qwen: Qwen3 Coder"],
            ["mistralai/mistral-medium-3.1", "Mistral: Mistral Medium 3.1"],
          ].map(([id, name]) => ({ provider: "openrouter", providerName: "OpenRouter", id, name, authConfigured: true, authSource: "stored" as const, authType: "api_key" as const, oauthSupported: false })),
          { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-4", name: "Claude Sonnet", authConfigured: false, oauthSupported: false },
          { provider: "openai-chatgpt", providerName: "ChatGPT", id: "gpt-5", name: "GPT-5", authConfigured: true, authSource: "stored" as const, authType: "oauth" as const, oauthSupported: true },
        ],
        catalogs: [{ provider: "openrouter", refreshable: true, source: "live" as const, refreshedAt: new Date().toISOString(), modelCount: 11 }],
        status: { ...status, configured: true, provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
        instructions: scope === "space" ? "Keep answers concise and test changes in this work-folder." : null,
      } : await api<AssistantSettingsResponse>(`/api/agent/models?${assistantScopeParams(scope, space)}`, { signal: controller.signal });
      // Cached forms stay editable during this read. A save or a newer
      // accepted refresh owns the displayed settings once it has completed.
      if (controller.signal.aborted || revision !== localRevision.current || isMutating()) return;
      if (cached) {
        // Quiet refresh: leave a form the person is editing alone, like an outside change would.
        if (settingsSnapshot(result) === currentForm.current.snapshot) return;
        if (currentForm.current.dirty) { setExternalChange(true); return; }
      }
      applyLoadedSettings(result, true);
    }
    void load().catch((caught) => {
      if (!controller.signal.aborted && revision === localRevision.current && !isMutating()) setLoadError(errorText(caught));
    }).finally(() => { if (!controller.signal.aborted) { setLoading(false); onLoadedRef.current?.(); } });
    return () => controller.abort();
    // This component's key owns its exact scope. Parent status updates must
    // not reload and overwrite a person's unsaved model or instructions.
  }, [fixtureMode, loadAttempt]);

  const providers = providerCatalog.map((item) => item.id);
  const selectedProvider = providerCatalog.find((item) => item.id === provider);
  const providerModels = models.filter((item) => item.provider === provider);
  const connectedModels = models.filter((item) => item.authConfigured);
  const selectedModel = models.find((item) => item.provider === modelProvider && item.id === model);
  const providerAuth = selectedProvider ? { ...selectedProvider, authConfigured: selectedProvider.configured } : providerModels.find((item) => item.authConfigured);
  const authConfigured = Boolean(providerAuth?.authConfigured);
  const removableAuth = providerAuth?.authSource === "stored";
  const apiKeySupported = Boolean(selectedProvider?.apiKey);
  const replaceableApiKey = apiKeySupported && removableAuth;
  const oauthSupported = Boolean(selectedProvider?.oauthAvailable);
  const accountOnly = !apiKeySupported && Boolean(selectedProvider?.oauth);
  const isAzure = provider === AZURE_OPENAI_PROVIDER;
  const azureChanged = JSON.stringify(azure) !== JSON.stringify(azureConnectionDraft(savedAzure));
  const catalog = catalogs.find((item) => item.provider === provider);
  const providerName = selectedProvider?.name ?? provider;
  const modelChanged = modelProvider !== scopeStatus.provider || model !== scopeStatus.model;
  const instructionsChanged = instructions.trim() !== savedInstructions;
  const operationBusy = mutationBusy || refreshing;
  currentForm.current = { dirty: modelChanged || instructionsChanged || editingApiKey || Boolean(apiKey) || azureChanged, loading: loading || Boolean(loadError),
    snapshot: settingsSnapshot({ models, providers: providerCatalog, catalogs, status: scopeStatus, instructions: savedInstructions, azure: savedAzure }) };

  useEffect(() => {
    if (loading || loadError) return;
    onSnapshotRef.current?.({ models, providers: providerCatalog, catalogs, status: scopeStatus, instructions: savedInstructions, azure: savedAzure });
  }, [loading, loadError, models, providerCatalog, catalogs, scopeStatus, savedInstructions, savedAzure]);

  useEffect(() => {
    if (editingApiKey && active) apiKeyField.current?.focus();
  }, [editingApiKey, active]);

  function applyLoadedSettings(result: AssistantSettingsResponse, restoreDraft = false) {
    const draft = restoreDraft ? readDraft() : {};
    setModels(result.models);
    const connections = connectionProviders(result);
    setProviderCatalog(connections);
    setCatalogs(result.catalogs);
    setScopeStatus(result.status);
    setInstructions(draft.instructions ?? result.instructions ?? "");
    setSavedInstructions(result.instructions ?? "");
    setAzure(draft.azure ?? azureConnectionDraft(result.azure ?? emptyAzureConnection));
    setSavedAzure(result.azure ?? emptyAzureConnection);
    const first = result.models.find((item) => item.provider === result.status.provider && item.id === result.status.model)
      ?? result.models.find((item) => item.authConfigured);
    const nextProvider = draft.model?.provider ?? first?.provider ?? "";
    const nextConnection = draft.connectionProvider ?? provider;
    setProvider(connections.some(item => item.id === nextConnection) ? nextConnection
      : connections.find(item => item.id === result.status.provider)?.id ?? connections.find(item => item.configured)?.id ?? connections[0]?.id ?? "");
    setModelProvider(nextProvider);
    const requestedModel = draft.model?.model ?? result.status.model ?? "";
    setModel(resolveAssistantModelSelection(result.models, nextProvider, requestedModel));
    editDraft((current) => ({
      ...current,
      ...(current.model?.provider === result.status.provider && current.model?.model === result.status.model ? { model: undefined } : {}),
      ...(current.instructions?.trim() === (result.instructions ?? "") ? { instructions: undefined } : {}),
    }));
    setApiKey("");
    setEditingApiKey(false);
    setShowApiKey(false);
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
      if ((hint !== "models" && hint !== "reset") || isMutating()) return;
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
          else {
            localRevision.current += 1;
            applyLoadedSettings(result);
          }
        }).catch(() => {
          if (!disposed && !read.signal.aborted && revision === localRevision.current) setExternalChange(true);
        });
    });
    return () => { disposed = true; controller?.abort(); unsubscribe(); };
  }, [fixtureMode]);

  useEffect(() => {
    if (!loading && active) focusModelWhenReady(focusInstructionsOnOpen ? instructionsField.current : modelSelect.current);
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
    editDraft(draft => ({ ...draft, connectionProvider: next }));
    setApiKey("");
    setEditingApiKey(false);
    setShowApiKey(false);
    setConnectionFeedback(null);
  }

  async function configure(kind: "model" | "key" | "oauth" | "setup") {
    if (loading || refresh.current || (kind === "model" ? !modelProvider || !model || !selectedModel?.authConfigured || !modelChanged : !provider)
      || (kind === "key" && (isAzure ? !authConfigured && !apiKey.trim() : (authConfigured && !(replaceableApiKey && editingApiKey)) || !apiKey.trim()))) return;
    let submittedAzure: AzureOpenAIConnection | undefined;
    if (kind === "key" && isAzure) {
      try { submittedAzure = serializeAzureConnection(azure); }
      catch (caught) { setConnectionFeedback({ error: true, text: errorText(caught) }); return; }
    }
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    const connection = kind !== "model";
    const feedback = connection ? setConnectionFeedback : setModelFeedback;
    setSaving(connection ? "connection" : "model");
    feedback(null);
    const submittedApiKey = kind === "key" ? apiKey.trim() : "";
    try {
      const result = fixtureMode ? { status: kind === "model" ? { ...scopeStatus, configured: true, provider: modelProvider, model } : scopeStatus, azure: submittedAzure, models: undefined }
        : await api<{ status: AgentStatus; azure?: AzureOpenAIConnection; models?: AgentModel[]; providers?: AgentProvider[] }>(kind === "setup" ? "/api/agent/login" : kind === "oauth" ? "/api/agent/oauth" : "/api/agent/configure", {
          method: "POST",
          body: { ...assistantScopeBody(scope, space), provider: kind === "model" ? modelProvider : provider, ...(kind === "model" ? { model } : {}), ...(kind === "setup" ? { method: "api_key" } : {}), ...(submittedApiKey ? { apiKey: submittedApiKey } : {}), ...(submittedAzure ? { azure: submittedAzure } : {}) },
        });
      editDraft((draft) => ({ ...draft, model: kind === "model" && draft.model?.provider === modelProvider && draft.model?.model === model ? undefined : draft.model,
        ...(submittedAzure ? { azure: undefined } : {}) }));
      if (!live.current) return;
      if (result.azure) { setAzure(azureConnectionDraft(result.azure)); setSavedAzure(result.azure); }
      if (result.models) setModels(result.models);
      else if (connection) setModels((current) => current.map((item) => item.provider === provider ? {
        ...item, authConfigured: true, authSource: "stored", authType: kind === "oauth" ? "oauth" : "api_key",
      } : item));
      if ("providers" in result && result.providers) setProviderCatalog(result.providers);
      else if (connection) setProviderCatalog((current) => current.map((item) => item.id === provider ? {
        ...item, configured: true, authSource: "stored", authType: kind === "oauth" ? "oauth" : "api_key",
      } : item));
      if (connection) { setApiKey(""); setEditingApiKey(false); setShowApiKey(false); }
      reportConfigured(result.status);
      feedback({ text: submittedAzure ? "Azure settings saved" : connection ? "Connection saved" : "Model saved" });
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
        azure: isAzure ? emptyAzureConnection : undefined,
      } : await api<{ models: AgentModel[]; status: AgentStatus; azure?: AzureOpenAIConnection; providers?: AgentProvider[] }>("/api/agent/auth", {
        method: "DELETE", body: { ...assistantScopeBody(scope, space), provider },
      });
      if (!live.current) return;
      setModels(result.models);
      setProviderCatalog(connectionProviders(result));
      if (result.azure) {
        setSavedAzure(result.azure);
        if (!azureChanged) { setAzure(azureConnectionDraft(result.azure)); editDraft((draft) => ({ ...draft, azure: undefined })); }
      }
      setApiKey("");
      setEditingApiKey(false);
      setShowApiKey(false);
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
    setConnectionFeedback(null);
    try {
      const result = fixtureMode ? { models, catalogs, refresh: { modelCount: models.length } }
        : await api<{ models: AgentModel[]; catalogs: AgentModelCatalog[]; refresh: { modelCount: number } }>("/api/agent/models/refresh", {
          method: "POST", body: { ...assistantScopeBody(scope, space), provider }, signal: controller.signal,
        });
      if (!live.current || controller.signal.aborted || revision !== providerRevision.current) return;
      setModels(result.models);
      setCatalogs(result.catalogs);
      // Refresh updates catalog metadata; it must not overwrite saved defaults
      // or report an Assistant configuration change that never happened.
      setConnectionFeedback({ text: `${result.refresh.modelCount} models refreshed from ${providerName}` });
    } catch (caught) {
      if (live.current && !controller.signal.aborted && revision === providerRevision.current) setConnectionFeedback({ error: true, text: errorText(caught) });
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
  if (loadError) return <div className="assistant-settings-section"><AssistantOperationStatus feedback={{ error: true, text: loadError }} /><button className="ui-control" type="button" onClick={() => { localRevision.current += 1; setLoadAttempt((current) => current + 1); }}>Try Again</button></div>;

  return <>
    {externalChange ? <div className="assistant-external-change"><span>Saved settings have changed.</span><button className="assistant-refresh-models" type="button" disabled={operationBusy} onClick={() => { localRevision.current += 1; editDraft(() => ({})); setExternalChange(false); setLoading(true); setLoadAttempt((current) => current + 1); }}>Reload Saved Settings</button></div> : null}
    <section className="assistant-settings-section" aria-labelledby="assistant-model-heading"><span className="sr-only" id="assistant-model-heading">Model</span>
      <form onSubmit={(event) => { event.preventDefault(); void configure("model"); }}>
        <div className="professional-field">
          <span className="professional-field-label" id="assistant-model-label">Model</span>
          <ModelCatalogList id="assistant-model" labelledBy="assistant-model-label" models={connectedModels} value={modelCatalogKey({ provider: modelProvider, id: model })} groupByProvider disabled={mutationBusy || !connectedModels.length} onChange={(next) => {
            if (isMutating()) return;
            const selected = connectedModels.find(item => modelCatalogKey(item) === next);
            if (!selected) return;
            setModelProvider(selected.provider); setModel(selected.id); updateModelDraft(selected.provider, selected.id); setModelFeedback(null);
          }} controlRef={modelSelect} />
          {!connectedModels.length ? <span className="professional-field-hint">Connect a provider below to choose a model.</span> : null}
        </div>
        <div className="assistant-form-actions assistant-model-actions">
          <AssistantOperationStatus feedback={modelFeedback} />
          <button className="ui-control ui-control--primary" type="submit" disabled={operationBusy || !model || !modelChanged || !selectedModel?.authConfigured}>{saving === "model" ? "Saving…" : "Save Model"}</button>
        </div>
      </form>
    </section>
    <section className="assistant-settings-section" aria-labelledby="assistant-connection-heading">
      <div className="assistant-connection-panel">
        <div className="assistant-section-heading"><h3 id="assistant-connection-heading">Provider connections</h3></div>
        <label className="professional-field"><span className="sr-only">Provider</span>
          <select aria-label="Provider" value={provider} disabled={mutationBusy || !providers.length} onChange={(event) => changeProvider(event.target.value)}>
            {[true, false].map(connected => {
              const options = providerCatalog.filter(item => item.configured === connected);
              return options.length ? <optgroup key={String(connected)} label={connected ? "Connected" : "Available"}>{options.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup> : null;
            })}
          </select>
        </label>
        <div className="assistant-connection-row">
          <div><p>{assistantCredentialStatus(providerAuth) ?? "Not connected"}</p></div>
          <div className="assistant-connection-controls">
            {catalog?.refreshable ? <button className="assistant-refresh-models" type="button" disabled={operationBusy || !authConfigured} title={authConfigured ? `Refresh ${providerName} models${catalog.refreshedAt ? ` · Updated ${formatCatalogDate(catalog.refreshedAt)}` : ""}` : `Connect ${providerName} to refresh models`} onClick={() => void refreshModels()}><RefreshCw className={refreshing ? "spin" : undefined} />{refreshing ? "Refreshing…" : "Refresh"}</button> : null}
            {replaceableApiKey && !isAzure ? <button className="ui-control" type="button" disabled={operationBusy} aria-expanded={editingApiKey} aria-controls="assistant-key-form" onClick={() => { setEditingApiKey((current) => !current); setApiKey(""); setShowApiKey(false); setConnectionFeedback(null); }}>{editingApiKey ? "Cancel" : "Change API Key"}</button> : null}
            {removableAuth ? <button className="assistant-remove-credential" type="button" disabled={operationBusy} onClick={() => void removeCredential()}>{saving === "remove" ? "Removing…" : providerAuth?.authType === "oauth" ? "Disconnect Account" : "Remove API Key"}</button> : null}
          </div>
        </div>
        {(!authConfigured || isAzure || editingApiKey) && apiKeySupported && provider ? <form id="assistant-key-form" className={`assistant-key-connection${isAzure ? " assistant-azure-connection" : ""}`} onSubmit={(event) => { event.preventDefault(); void configure("key"); }}>
          {isAzure ? <>
            <label className="professional-field"><span className="professional-field-label">Azure endpoint</span><input id="assistant-azure-endpoint" type="url" value={azure.baseUrl} maxLength={2048} placeholder="https://your-resource.openai.azure.com" spellCheck={false} autoComplete="off" disabled={mutationBusy} onChange={(event) => {
              const next = { ...azure, baseUrl: event.target.value }; setAzure(next); editDraft((draft) => ({ ...draft, azure: next })); setConnectionFeedback(null);
            }} /></label>
            <label className="professional-field"><span className="professional-field-label">Deployment names</span><textarea id="assistant-azure-deployments" value={azure.deployments} maxLength={25800} rows={2} placeholder="my-deployment, another-deployment" spellCheck={false} autoComplete="off" disabled={mutationBusy} aria-describedby="assistant-azure-deployment-help" onChange={(event) => {
              const next = { ...azure, deployments: event.target.value };
              setAzure(next);
              editDraft((draft) => ({ ...draft, azure: next }));
              setConnectionFeedback(null);
            }} /><span className="professional-field-hint" id="assistant-azure-deployment-help">Deployment names, separated by commas or new lines.</span></label>
          </> : null}
          <label className="professional-field"><span className="professional-field-label">{isAzure && authConfigured ? "Replace API key (optional)" : editingApiKey ? "New API Key" : "API Key"}</span>
            <span className="assistant-key-input"><input ref={apiKeyField} id="assistant-api-key" type={showApiKey ? "text" : "password"} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConnectionFeedback(null); }} placeholder={isAzure && authConfigured ? "Leave blank to keep the current key" : `Paste your ${providerName} API key`} autoComplete="off" spellCheck={false} disabled={mutationBusy} />
              <button className="assistant-key-visibility" type="button" aria-label={showApiKey ? "Hide API key" : "Show API key"} aria-pressed={showApiKey} disabled={mutationBusy} onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? <EyeOff20Regular aria-hidden="true" /> : <Eye20Regular aria-hidden="true" />}</button>
            </span>
          </label>
          <div className="assistant-form-actions assistant-connection-actions"><button className="ui-control ui-control--primary" type="submit" disabled={operationBusy || (isAzure ? !parseAzureDeploymentNames(azure.deployments).length || !azure.baseUrl.trim() || (!authConfigured && !apiKey.trim()) || (authConfigured && !azureChanged && !apiKey.trim()) : !apiKey.trim())}>{saving === "connection" ? "Saving…" : isAzure ? "Save Azure settings" : editingApiKey ? "Save API Key" : "Connect Provider"}</button></div>
        </form> : null}
        {oauthSupported || selectedProvider?.guidedSetup ? <div className="assistant-provider-actions">
          {oauthSupported ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configure("oauth")}>{saving === "connection" ? "Connecting…" : providerAuth?.authType === "oauth" ? "Reconnect account" : selectedProvider?.oauthLabel ?? "Connect account"}</button> : null}
          {selectedProvider?.guidedSetup ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configure("setup")}>Guided setup</button> : null}
        </div> : null}
        {accountOnly && !oauthSupported ? <p className="professional-field-hint">Account sign-in is available in the desktop app.</p> : null}
        {!apiKeySupported && !selectedProvider?.oauth ? <p className="professional-field-hint">Uses credentials configured outside work-fold.</p> : null}
        {connectionFeedback ? <AssistantOperationStatus feedback={connectionFeedback} /> : null}
        <p className="assistant-connection-shared">Connections are shared by all Workers.</p>
      </div>
    </section>
    {scope === "space" ? <section className="assistant-settings-section" aria-labelledby="assistant-instructions-heading">
      <div className="assistant-section-heading"><h3 id="assistant-instructions-heading">Worker Instructions</h3></div>
      <form onSubmit={(event) => void saveInstructions(event)}>
        <label className="professional-field assistant-instructions-field"><span className="sr-only">Worker Instructions</span><textarea ref={instructionsField} value={instructions} rows={5} onChange={(event) => { setInstructions(event.target.value); editDraft((draft) => ({ ...draft, instructions: event.target.value.trim() === savedInstructions ? undefined : event.target.value })); setInstructionsFeedback(null); }}  /></label>
        <div className="assistant-form-actions assistant-instructions-actions"><AssistantOperationStatus feedback={instructionsFeedback?.error || !instructionsChanged ? instructionsFeedback : null} hint={instructionsChanged ? "Unsaved changes" : undefined} /><button className="ui-control" type="submit" disabled={mutationBusy || !instructionsChanged}>{savingInstructions ? "Saving…" : "Save Instructions"}</button></div>
      </form>
    </section> : null}
  </>;
}

function azureConnectionDraft(connection: AzureOpenAIConnection): AzureConnectionDraft {
  return { baseUrl: connection.baseUrl, deployments: connection.deployments.join(", ") };
}

function serializeAzureConnection(draft: AzureConnectionDraft): AzureOpenAIConnection {
  return normalizeAzureOpenAIConnection({ baseUrl: draft.baseUrl, deployments: parseAzureDeploymentNames(draft.deployments) });
}

type AssistantSettingsResponse = { models: AgentModel[]; providers?: AgentProvider[]; status: AgentStatus; catalogs: AgentModelCatalog[]; instructions: string | null; azure?: AzureOpenAIConnection };
function settingsSnapshot(result: AssistantSettingsResponse): string {
  return JSON.stringify([result.status.provider, result.status.model, result.status.configured, result.models, connectionProviders(result), result.catalogs, result.instructions ?? "", result.azure ?? emptyAzureConnection]);
}

type AssistantFeedback = { text: string; error?: boolean };
function AssistantOperationStatus({ feedback, hint }: { feedback: AssistantFeedback | null; hint?: string }) {
  return <div className={feedback?.error ? "assistant-operation-status error" : "assistant-operation-status"} role={feedback?.error ? "alert" : "status"}>{feedback?.text ?? hint ?? ""}</div>;
}

function unique<T>(items: T[]) { return [...new Set(items)]; }
function connectionProviders(result: { models: AgentModel[]; providers?: AgentProvider[] }): AgentProvider[] {
  return result.providers ?? unique(result.models.map((model) => model.provider)).map((id) => {
    const models = result.models.filter((model) => model.provider === id);
    const auth = models.find((model) => model.authConfigured);
    return { id, name: models[0]?.providerName ?? id, configured: Boolean(auth), authSource: auth?.authSource,
      authLabel: auth?.authLabel, authType: auth?.authType, apiKey: true, oauth: models.some((model) => model.oauthSupported),
      oauthAvailable: models.some((model) => model.oauthSupported), guidedSetup: false, modelCount: models.length };
  }).sort((left, right) => left.name.localeCompare(right.name));
}
function assistantCredentialStatus(model: Pick<AgentModel, "authConfigured" | "authSource" | "authType" | "authLabel"> | undefined) {
  if (!model?.authConfigured) return model?.authSource === "stored" ? "Saved · setup needed" : null;
  if (model.authSource === "stored") return model.authType === "oauth" ? "Provider account connected on this computer" : "API key saved on this computer";
  if (model.authSource === "environment") return `API key supplied by ${model.authLabel || "the app environment"}`;
  if (model.authSource === "models_json_key" || model.authSource === "models_json_command") return "Credential configured in Pi models settings";
  return "Credential supplied outside work-fold";
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
