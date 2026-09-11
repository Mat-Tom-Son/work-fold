import { useId, useRef, useState } from "react";
import { readQuestionDraft, writeQuestionDraft, clearQuestionDraft } from "../../../../services/bridge/public/question-drafts.js";
import type { WorkQuestionView, WorkRequestView } from "../../../../src/shared/request-presentation";
import { useWorkRequest } from "../../hooks/useWorkRequest";

export async function openWorkFile(spaceId: string, path: string): Promise<void> {
  if (window.workFoldDesktop?.management?.openResultFile) {
    await window.workFoldDesktop.management.openResultFile(spaceId, path);
  } else window.dispatchEvent(new window.CustomEvent("work-fold:open-result-file", { detail: { spaceId, path } }));
}

export function ConnectedWorkRequest({ path, onOpenFile, showResultSummary = true, showResultFiles = true, showStop = true }: {
  path: string; onOpenFile?: (spaceId: string, path: string) => void; showResultSummary?: boolean; showResultFiles?: boolean; showStop?: boolean;
}) {
  const state = useWorkRequest(path);
  return <WorkRequest {...state} onOpenFile={onOpenFile} showResultSummary={showResultSummary} showResultFiles={showResultFiles} showStop={showStop} />;
}

export function WorkRequest({ work, error, busy, act, refresh, onOpenFile = openWorkFile, showStop = true, showResultSummary = false, showProgress = true, showResultFiles = true }: {
  work: WorkRequestView | null; error: string | null; busy: boolean;
  act: (action: "answer" | "stop" | "continue", body?: Record<string, unknown>) => Promise<boolean>;
  refresh: () => Promise<void>;
  onOpenFile?: (spaceId: string, path: string) => void | Promise<void>;
  showStop?: boolean; showResultSummary?: boolean; showProgress?: boolean; showResultFiles?: boolean;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  // A simple completed reply already speaks for itself. Collaboration,
  // questions, deliverables, and recovery earn the extra line.
  const visible = work && (work.state !== "done" || work.hadQuestions || work.children.length || work.result?.files.length || showResultSummary);
  if (!visible && !error) return null;
  return <section className="work-request" aria-label="Work progress" aria-busy={busy} tabIndex={-1}>
    {work && visible ? <>
      {showProgress ? <div className="work-status-line">
        <span className={`work-status-dot state-${work.state}`} aria-hidden="true" />
        <span role="status" aria-live="polite">{work.label}</span>
        {showStop && work.canStop ? <button type="button" className="work-text-button" disabled={busy} onClick={() => void act("stop")}>Stop</button> : null}
      </div> : null}
      {work.detail ? <p className="work-detail">{work.detail}</p> : null}
      {work.canContinue ? <button className="work-primary-button" type="button" disabled={busy} onClick={() => void act("continue")}>Continue with saved results</button> : null}
      {work.questions.map((question) => <WorkQuestion key={question.id} question={question} busy={busy} answer={(text) => act("answer", { questionId: question.id, answer: text })} />)}
      {work.questionCount > work.questions.length ? <p className="work-detail">{work.questionCount - work.questions.length} more questions follow these answers.</p> : null}
      {work.children.length ? <details className="work-details">
        <summary>Work across {work.children.length === 1 ? "another Assistant" : `${work.children.length} Assistants`}</summary>
        <ul>{work.children.map((child) => <li key={child.requestId}><span>{child.title}</span><span>{child.label}</span></li>)}</ul>
      </details> : null}
      {work.result ? <div className="work-result">
        {showResultSummary ? <p className="work-result-summary">{work.result.summary}</p> : null}
        {showResultFiles && work.result.files.length ? <ul className="work-result-files" aria-label="Result files">{work.result.files.map((file) => <li key={`${file.spaceId}:${file.path}`}>
          <button type="button" className="work-file-button" onClick={() => { setFileError(null); void Promise.resolve().then(() => onOpenFile(file.spaceId, file.path)).catch((caught) => setFileError(caught instanceof Error ? caught.message : "Could not open this file.")); }} title={`${file.spaceName} · ${file.path}`}>
            <span>{file.path.split("/").at(-1)}</span><small>{file.spaceName} · Open file</small>
          </button>
        </li>)}</ul> : null}
      </div> : null}
    </> : null}
    {error ? <p className="work-error" role="alert">{error} <button className="work-text-button" type="button" onClick={() => void refresh()}>Refresh</button></p> : null}
    {fileError ? <p className="work-error" role="alert">{fileError}</p> : null}
  </section>;
}

function WorkQuestion({ question, busy, answer }: { question: WorkQuestionView; busy: boolean; answer: (text: string) => Promise<boolean> }) {
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => readQuestionDraft(question.id));
  const [sent, setSent] = useState(false);
  async function send() {
    const form = formRef.current;
    const container = form?.closest<HTMLElement>(".work-request");
    const fallback = form?.closest<HTMLElement>("article");
    if (await answer(question.state === "recorded" ? question.answer ?? "" : draft)) {
      clearQuestionDraft(question.id); setSent(true); setDraft("");
      window.requestAnimationFrame(() => {
        if (document.activeElement === document.body || form?.contains(document.activeElement)) (container?.isConnected ? container : fallback)?.focus({ preventScroll: true });
      });
    }
  }
  return <form ref={formRef} className="work-question" onSubmit={(event) => { event.preventDefault(); if (question.canAnswer && !busy && !sent) void send(); }}>
    <span className="work-question-origin">{question.from} asks</span>
    <label htmlFor={question.state === "open" ? inputId : undefined}>{question.text}</label>
    {question.state === "recorded" ? <>
      <p className="work-detail">Your answer is saved. Continue to deliver it once.</p>
      <blockquote className="work-saved-answer" tabIndex={0} aria-label="Your saved answer">{question.answer}</blockquote>
    </>
      : <textarea id={inputId} rows={2} value={draft} onChange={(event) => { setDraft(event.target.value); writeQuestionDraft(question.id, event.target.value); }} placeholder="Your answer" disabled={sent} />}
    {question.reason ? <p className="work-detail">{question.reason}</p> : null}
    <button type="submit" className="work-primary-button" disabled={busy || sent || !question.canAnswer || (question.state === "open" && !draft.trim())}>
      {sent ? "Answer sent" : busy ? "Sending…" : question.state === "recorded" ? "Continue with saved answer" : "Send answer"}
    </button>
  </form>;
}
