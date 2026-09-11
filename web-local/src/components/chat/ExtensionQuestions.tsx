import { useEffect, useId, useRef, useState } from "react";
import type { ExtensionUiRequest } from "../../types";
import { errorText } from "../../lib/api";

// Live drafts stay in this renderer, never in localStorage or a transcript.
const drafts = new Map<string, string>();

export function ExtensionQuestions({ requests, scope, respond }: {
  requests: ExtensionUiRequest[];
  scope: string;
  respond: (request: ExtensionUiRequest, value: unknown, cancelled?: boolean) => Promise<void>;
}) {
  useEffect(() => {
    const live = new Set(requests.map((request) => `${scope}/${request.id}`));
    for (const key of drafts.keys()) if (key.startsWith(`${scope}/`) && !live.has(key)) drafts.delete(key);
  }, [scope, requests]);
  if (!requests.length) return null;
  return <div className="extension-questions" aria-label="Extension questions">
    {requests.map((request) => <ExtensionQuestion key={`${scope}/${request.id}`} request={request} draftKey={`${scope}/${request.id}`} respond={respond} />)}
  </div>;
}

function ExtensionQuestion({ request, draftKey, respond }: {
  request: ExtensionUiRequest; draftKey: string;
  respond: (request: ExtensionUiRequest, value: unknown, cancelled?: boolean) => Promise<void>;
}) {
  const titleId = useId();
  const [value, setValue] = useState(() => (!request.secret ? drafts.get(draftKey) : undefined) ?? request.initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  async function send(answer: unknown, cancelled = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      await respond(request, answer, cancelled);
      drafts.delete(draftKey);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      submitting.current = false; setBusy(false);
    }
  }
  function change(text: string) {
    setValue(text);
    if (!request.secret) {
      drafts.delete(draftKey); drafts.set(draftKey, text);
      while (drafts.size > 64) drafts.delete(drafts.keys().next().value!);
    }
  }
  return <section className="extension-question" aria-labelledby={titleId} aria-busy={busy}>
    <p className="extension-question-source">Extension</p>
    <h3 id={titleId}>{request.title || "Your answer"}</h3>
    {request.message ? <p className="extension-question-detail">{request.message}</p> : null}
    <fieldset disabled={busy}>
      {request.method === "select" ? <div className="extension-question-actions">{request.options?.map((option, index) => <button key={index} type="button" onClick={() => void send(option)}>{option}</button>)}</div> : null}
      {request.method === "confirm" ? <div className="extension-question-actions"><button type="button" onClick={() => void send(true)}>Yes</button><button type="button" onClick={() => void send(false)}>No</button></div> : null}
      {request.method === "input" || request.method === "editor" ? <form onSubmit={(event) => { event.preventDefault(); void send(value); }}>
        {request.method === "editor"
          ? <textarea aria-labelledby={titleId} rows={5} value={value} onChange={(event) => change(event.target.value)} placeholder={request.placeholder} maxLength={65536} />
          : <input aria-labelledby={titleId} type={request.secret ? "password" : "text"} autoComplete="off" value={value} onChange={(event) => change(event.target.value)} placeholder={request.placeholder} maxLength={65536} />}
        <div className="extension-question-actions"><button className="extension-answer" type="submit">{busy ? "Sending…" : "Send answer"}</button><button className="extension-cancel" type="button" onClick={() => void send(null, true)}>Cancel</button></div>
      </form> : <button className="extension-cancel" type="button" onClick={() => void send(null, true)}>{busy ? "Sending…" : "Cancel"}</button>}
    </fieldset>
    {error ? <p className="extension-question-error" role="alert">{error}</p> : null}
  </section>;
}
