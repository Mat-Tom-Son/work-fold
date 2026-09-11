// This adapter renders the host's work projection. It never derives lifecycle
// state from a transcript or exposes a request graph to a public viewer.
import { readQuestionDraft, writeQuestionDraft, clearQuestionDraft } from "./question-drafts.js";
const controllers = new WeakMap();

export function renderWorkRequest(container, work, { act, openFile, onClose, error = "" } = {}) {
  if (!container) return;
  let controller = controllers.get(container);
  if (!controller) { controller = { signature: "", busy: false, error: "", deliveryId: null, scope: 0 }; controllers.set(container, controller); }
  if (controller.work?.requestId !== work?.requestId) {
    controller.scope++; controller.busy = false; controller.error = ""; controller.deliveryId = null;
  }
  controller.work = work;
  controller.options = { act, openFile, onClose, error };
  draw(container, controller);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action, disabled = false) {
  const node = element("button", className, text);
  node.type = "button"; node.disabled = disabled; node.addEventListener("click", action);
  return node;
}
function draw(container, controller) {
  const work = controller.work;
  const { act, openFile, onClose, error } = controller.options;
  const signature = JSON.stringify([work, controller.busy, controller.error, error]);
  if (signature === controller.signature) return;
  controller.signature = signature;
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const expanded = container.querySelector("details")?.open;
  container.replaceChildren();
  container.className = "work-request";
  container.setAttribute("aria-label", "Work progress");
  container.setAttribute("aria-busy", String(controller.busy));
  container.tabIndex = -1;
  if (!work) {
    if (error) container.append(element("p", "work-error", error));
    return;
  }
  const status = element("div", "work-status-line");
  const dot = element("span", `work-status-dot state-${work.state}`); dot.setAttribute("aria-hidden", "true");
  const label = element("span", "", work.label); label.setAttribute("role", "status");
  status.append(dot, label);
  if (work.canStop) status.append(button("Stop", "work-text-button", () => send("stop"), controller.busy));
  if (onClose) status.append(button("Close", "work-text-button", onClose));
  container.append(status);
  if (work.detail) container.append(element("p", "work-detail", work.detail));
  if (work.canContinue) container.append(button("Continue with saved results", "work-primary-button", () => send("continue"), controller.busy));
  for (const question of work.questions) {
    const form = element("form", "work-question");
    const inputId = `${container.id}-answer-${question.id}`;
    const prompt = element("label", "", question.text); if (question.state === "open") prompt.htmlFor = inputId;
    form.append(element("span", "work-question-origin", `${question.from} asks`), prompt);
    let input;
    if (question.state === "recorded") {
      form.append(element("p", "work-detail", "Your answer is saved. Continue to deliver it once."));
      const saved = element("blockquote", "work-saved-answer", question.answer);
      saved.tabIndex = 0; saved.setAttribute("aria-label", "Your saved answer"); form.append(saved);
    }
    else {
      input = element("textarea"); input.id = inputId; input.rows = 2; input.placeholder = "Your answer";
      input.value = readQuestionDraft(question.id);
      form.append(input);
    }
    if (question.reason) form.append(element("p", "work-detail", question.reason));
    const submit = button(controller.busy ? "Sending…" : question.state === "recorded" ? "Continue with saved answer" : "Send answer", "work-primary-button", () => {});
    submit.type = "submit";
    const update = () => { submit.disabled = controller.busy || !question.canAnswer || (input && !input.value.trim()); };
    input?.addEventListener("input", () => { writeQuestionDraft(question.id, input.value); update(); });
    update(); form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); if (submit.disabled) return;
      void send("answer", { questionId: question.id, answer: question.state === "recorded" ? question.answer : input.value }, question.id);
    });
    container.append(form);
  }
  if (work.questionCount > work.questions.length) container.append(element("p", "work-detail", `${work.questionCount - work.questions.length} more questions follow these answers.`));
  if (work.children.length) {
    const details = element("details", "work-details"); details.open = expanded ?? false;
    details.append(element("summary", "", `Work across ${work.children.length === 1 ? "another Assistant" : `${work.children.length} Assistants`}`));
    const list = element("ul");
    for (const child of work.children) { const row = element("li"); row.append(element("span", "", child.title), element("span", "", child.label)); list.append(row); }
    details.append(list); container.append(details);
  }
  if (work.result) {
    container.append(element("p", "work-result-summary", work.result.summary));
    const files = element("ul", "work-result-files"); files.setAttribute("aria-label", "Result files");
    for (const file of work.result.files) {
      const row = element("li"); const link = button("", "work-file-button", () => {
        const scope = controller.scope;
        void Promise.resolve().then(() => openFile?.(file.spaceId, file.path)).catch((caught) => {
          if (scope !== controller.scope) return;
          controller.error = caught?.message || "Could not open this file."; draw(container, controller);
        });
      });
      link.title = `${file.spaceName} · ${file.path}`;
      link.append(element("span", "", file.path.split("/").at(-1)), element("small", "", `${file.spaceName} · Open file`)); row.append(link); files.append(row);
    }
    container.append(files);
  }
  if (controller.error || error) { const notice = element("p", "work-error", controller.error || error); notice.setAttribute("role", "alert"); container.append(notice); }
  if (focus) {
    const target = document.getElementById(focus.id);
    if (target && container.contains(target)) { target.focus({ preventScroll: true }); if (typeof target.setSelectionRange === "function") target.setSelectionRange(focus.start, focus.end); }
    else container.focus({ preventScroll: true });
  } else if (active) {
    container.focus({ preventScroll: true });
  }
  async function send(action, input = {}, questionId) {
    if (controller.busy || !act) return;
    controller.busy = true; controller.error = "";
    const scope = controller.scope;
    if (action === "continue") controller.deliveryId ??= `resume-${crypto.randomUUID()}`;
    draw(container, controller);
    try {
      const result = await act(action, { ...input, ...(action === "continue" ? { deliveryId: controller.deliveryId } : {}) }, work);
      if (questionId) clearQuestionDraft(questionId);
      if (scope !== controller.scope) return;
      controller.deliveryId = null;
      if (result?.work && controller.work?.requestId === work.requestId) controller.work = result.work;
    } catch (caught) { if (scope === controller.scope) controller.error = caught?.message || "Could not send. Your answer is still here; try again."; }
    finally { if (scope === controller.scope) { controller.busy = false; draw(container, controller); } }
  }
}
