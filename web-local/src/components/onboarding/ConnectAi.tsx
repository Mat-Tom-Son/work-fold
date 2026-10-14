import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronRight, KeyRound, Loader2, Search } from "lucide-react";

import { api, errorText } from "../../lib/api";
import type { AgentModel, AgentProvider, AgentStatus } from "../../types";
import { AZURE_OPENAI_PROVIDER } from "../../../../src/shared/azure-openai";

/**
 * Connect your AI (2026-10-11): the one place a person connects a model
 * provider, used by first run, the Connect AI dialog, and Settings → AI Models
 * while nothing is connected. Three accounts most people already have come
 * first; every other provider is a search away. Connecting also gives every
 * Worker a model to start on (the server saves a recommended default).
 */
export interface FeaturedProvider {
  provider: string;
  title: string;
  /** What signing in uses, or what the key unlocks. */
  detail: string;
  /** Where to make an API key when sign-in is not available here. */
  keyUrl: string;
}

export const featuredProviders: FeaturedProvider[] = [
  { provider: "openai", title: "ChatGPT", detail: "Sign in with your ChatGPT account", keyUrl: "https://platform.openai.com/api-keys" },
  { provider: "anthropic", title: "Claude", detail: "Sign in with Claude Pro or Max", keyUrl: "https://console.anthropic.com/settings/keys" },
  { provider: "openrouter", title: "OpenRouter", detail: "Hundreds of models with one account", keyUrl: "https://openrouter.ai/settings/keys" },
];

/** Providers that need more than a key, or that another entry already covers. */
const hiddenProviders = new Set(["openai-codex"]);
const settingsOnlyProviders = new Set([AZURE_OPENAI_PROVIDER]);

type ModelsResponse = { models: AgentModel[]; providers?: AgentProvider[]; status: AgentStatus };
type ConnectResult = { status: AgentStatus; models?: AgentModel[]; providers?: AgentProvider[] };

export interface ConnectedAi {
  status: AgentStatus;
  providerName: string;
  modelName: string | null;
}

export function ConnectAi({ onConnected, onOpenSettings, providers: knownProviders, fixtureMode = false }: {
  onConnected: (connected: ConnectedAi) => void;
  /** For providers that need more than a key, such as Azure. */
  onOpenSettings?: () => void;
  /** Providers a surface already loaded (Settings → AI Models); otherwise they are read here. */
  providers?: AgentProvider[];
  fixtureMode?: boolean;
}) {
  const [loadedProviders, setProviders] = useState<AgentProvider[] | null>(null);
  const providers = knownProviders ?? loadedProviders;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<"pick" | "key" | "others">("pick");
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  useEffect(() => {
    if (knownProviders) return;
    const controller = new AbortController();
    (fixtureMode ? Promise.resolve(fixtureProviders()) : api<ModelsResponse>("/api/agent/models?scope=agent", { signal: controller.signal }).then((result) => result.providers ?? []))
      .then((next) => { if (!controller.signal.aborted) setProviders(next); })
      .catch((caught) => { if (!controller.signal.aborted) setLoadError(errorText(caught)); });
    return () => controller.abort();
  }, [fixtureMode, Boolean(knownProviders)]);

  useEffect(() => { if (mode === "key") keyField.current?.focus(); }, [mode, chosen]);

  const byId = useMemo(() => new Map((providers ?? []).map((item) => [item.id, item])), [providers]);
  const others = useMemo(() => {
    const featured = new Set(featuredProviders.map((item) => item.provider));
    const needle = query.trim().toLowerCase();
    return (providers ?? [])
      .filter((item) => !featured.has(item.id) && (!hiddenProviders.has(item.id) || item.configured))
      .filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.id.includes(needle));
  }, [providers, query]);
  const chosenProvider = chosen ? byId.get(chosen) : undefined;
  const chosenFeatured = featuredProviders.find((item) => item.provider === chosen);

  async function connect(provider: AgentProvider, method: "oauth" | "key") {
    if (busy) return;
    setBusy(provider.id);
    setError(null);
    try {
      const result = fixtureMode
        ? { status: { ready: true, configured: true, provider: provider.id, model: "fixture-model", piVersion: null, error: null } }
        : method === "oauth"
          ? await api<ConnectResult>("/api/agent/oauth", { method: "POST", body: { scope: "agent", provider: provider.id } })
          : await api<ConnectResult>("/api/agent/configure", { method: "POST", body: { scope: "agent", provider: provider.id, apiKey: apiKey.trim() } });
      if (!live.current) return;
      setApiKey("");
      const model = result.models?.find((item) => item.provider === result.status.provider && item.id === result.status.model);
      onConnected({ status: result.status, providerName: provider.name, modelName: model?.name ?? result.status.model });
    } catch (caught) {
      if (live.current) setError(errorText(caught));
    } finally {
      if (live.current) setBusy(null);
    }
  }

  function choose(id: string) {
    const provider = byId.get(id);
    if (!provider || busy) return;
    setChosen(id);
    setError(null);
    setApiKey("");
    if (settingsOnlyProviders.has(id) || (!provider.apiKey && !provider.oauthAvailable)) { setMode("others"); return; }
    // Sign-in comes first where the desktop app can run it; a key otherwise.
    if (provider.oauthAvailable) void connect(provider, "oauth");
    else setMode("key");
  }

  function submitKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosenProvider && apiKey.trim()) void connect(chosenProvider, "key");
  }

  if (loadError) return <div className="connect-ai"><p className="connect-ai-error" role="alert">{loadError}</p></div>;
  if (!providers) return <div className="connect-ai"><p className="connect-ai-loading" role="status"><Loader2 className="spin" size={16} aria-hidden="true" />Loading providers…</p></div>;

  if (mode === "key" && chosenProvider) {
    return (
      <div className="connect-ai">
        <form className="connect-ai-key" onSubmit={submitKey}>
          <label htmlFor="connect-ai-key">Paste your {chosenProvider.name} API key</label>
          <input
            ref={keyField}
            id="connect-ai-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder="API key"
            disabled={Boolean(busy)}
            onChange={(event) => { setApiKey(event.target.value); setError(null); }}
          />
          <p className="connect-ai-hint">
            It stays on this computer and is shared by all your Workers.
            {chosenFeatured ? <> <a href={chosenFeatured.keyUrl} target="_blank" rel="noreferrer">Get a {chosenProvider.name} key</a></> : null}
          </p>
          {error ? <p className="connect-ai-error" role="alert">{error}</p> : null}
          <div className="connect-ai-key-actions">
            <button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => { setMode("pick"); setError(null); }}>Back</button>
            {chosenProvider.oauthAvailable ? <button className="ui-control" type="button" disabled={Boolean(busy)} onClick={() => void connect(chosenProvider, "oauth")}>{chosenProvider.oauthLabel ?? "Sign in instead"}</button> : null}
            <button className="ui-control ui-control--primary" type="submit" disabled={Boolean(busy) || !apiKey.trim()}>
              {busy ? <Loader2 className="spin" size={16} aria-hidden="true" /> : null}Connect
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (mode === "others") {
    return (
      <div className="connect-ai">
        <label className="connect-ai-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search providers</span>
          <input type="search" value={query} placeholder="Search providers" autoFocus onChange={(event) => setQuery(event.target.value)} />
        </label>
        {chosenProvider && (settingsOnlyProviders.has(chosenProvider.id) || (!chosenProvider.apiKey && !chosenProvider.oauthAvailable)) ? (
          <p className="connect-ai-hint" role="status">
            {chosenProvider.name} needs a few more details.{onOpenSettings ? <> <button className="connect-ai-link" type="button" onClick={onOpenSettings}>Set it up in Settings → AI Models</button></> : " Set it up in Settings → AI Models."}
          </p>
        ) : null}
        <ul className="connect-ai-others" aria-label="Other providers">
          {others.map((item) => (
            <li key={item.id}>
              <button type="button" disabled={Boolean(busy)} onClick={() => choose(item.id)}>
                <span>{item.name}</span>
                {item.configured ? <span className="connect-ai-connected"><Check size={14} aria-hidden="true" />Connected</span> : <ChevronRight size={16} aria-hidden="true" />}
              </button>
            </li>
          ))}
          {!others.length ? <li className="connect-ai-hint">No provider matches “{query.trim()}”.</li> : null}
        </ul>
        {error ? <p className="connect-ai-error" role="alert">{error}</p> : null}
        <div className="connect-ai-key-actions">
          <button className="ui-control" type="button" onClick={() => { setMode("pick"); setChosen(null); setError(null); setQuery(""); }}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="connect-ai">
      <div className="connect-ai-cards">
        {featuredProviders.map((item) => {
          const provider = byId.get(item.provider);
          if (!provider) return null;
          const waiting = busy === item.provider;
          return (
            <button key={item.provider} className="connect-ai-card" type="button" disabled={Boolean(busy)} aria-busy={waiting ? "true" : undefined} onClick={() => choose(item.provider)}>
              <strong>{item.title}</strong>
              <span>{waiting ? "Finish signing in, then come back here" : provider.oauthAvailable ? item.detail : `Paste your ${provider.name} API key`}</span>
              {provider.configured ? <span className="connect-ai-connected"><Check size={14} aria-hidden="true" />Connected</span> : null}
              {waiting ? <Loader2 className="spin connect-ai-card-spinner" size={16} aria-hidden="true" /> : null}
            </button>
          );
        })}
        <button className="connect-ai-card" type="button" disabled={Boolean(busy)} onClick={() => { setMode("others"); setChosen(null); setError(null); }}>
          <strong><KeyRound size={15} aria-hidden="true" />Another provider</strong>
          <span>Google, xAI, Mistral, GitHub Copilot, and more</span>
        </button>
      </div>
      {error ? <p className="connect-ai-error" role="alert">{error}</p> : null}
    </div>
  );
}

function fixtureProviders(): AgentProvider[] {
  const base = { configured: false, apiKey: true, oauth: true, oauthAvailable: false, guidedSetup: false, modelCount: 10 };
  return [
    { ...base, id: "anthropic", name: "Anthropic", oauthLabel: "Anthropic (Claude Pro/Max)" },
    { ...base, id: "google", name: "Google", oauth: false },
    { ...base, id: "openai", name: "OpenAI", oauthLabel: "Sign in with ChatGPT" },
    { ...base, id: "openrouter", name: "OpenRouter", oauthLabel: "Sign in with OpenRouter" },
    { ...base, id: "xai", name: "xAI" },
  ];
}
