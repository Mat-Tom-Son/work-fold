// Transient Pi interactions. No localStorage, transcript writes, or action replay.
const controllers = new WeakMap();
const drafts = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderExtensionQuestions(container, { scope, requests = [], answer }) {
  if (!container) return;
  let controller = controllers.get(container);
  if (!controller || controller.scope !== scope) {
    container.replaceChildren();
    controller = { scope, entries: new Map(), answer };
    controllers.set(container, controller);
  }
  controller.answer = answer;
  container.className = "extension-questions";
  container.setAttribute("aria-label", "Extension questions");
  // The host omits secrets. Also refuse them here if an older/malformed peer sends one.
  const visible = requests.filter((request) => !request.secret && ["input", "editor", "select", "confirm"].includes(request.method));
  const ids = new Set(visible.map((request) => request.id));
  for (const [id, entry] of controller.entries) {
    if (ids.has(id)) continue;
    entry.node.remove(); controller.entries.delete(id); drafts.delete(`${scope}/${id}`);
  }
  for (const request of visible) {
    if (controller.entries.has(request.id)) continue;
    const entry = createQuestion(request, scope, (value, cancelled) => controller.answer(request, value, cancelled));
    controller.entries.set(request.id, entry);
    container.append(entry.node);
  }
}

function createQuestion(request, scope, answer) {
  const key = `${scope}/${request.id}`;
  const node = element("section", "extension-question");
  const title = element("h3", "", request.title || "Your answer");
  title.id = `extension-question-${request.id}`;
  node.setAttribute("aria-labelledby", title.id);
  node.append(element("p", "extension-question-source", "Extension"), title);
  if (request.message) node.append(element("p", "extension-question-detail", request.message));
  const fieldset = element("fieldset", "");
  const error = element("p", "extension-question-error"); error.setAttribute("role", "alert"); error.hidden = true;
  let busy = false;
  async function send(value, cancelled = false) {
    if (busy) return;
    busy = true; fieldset.disabled = true; node.setAttribute("aria-busy", "true"); error.hidden = true;
    try { await answer(value, cancelled); drafts.delete(key); }
    catch (caught) { error.textContent = caught instanceof Error ? caught.message : "Could not send your answer. Try again."; error.hidden = false; }
    finally { busy = false; fieldset.disabled = false; node.setAttribute("aria-busy", "false"); }
  }
  function button(label, action, className = "") {
    const result = element("button", className, label); result.type = "button"; result.addEventListener("click", action); return result;
  }
  const actions = element("div", "extension-question-actions");
  if (request.method === "select") {
    for (const option of request.options ?? []) actions.append(button(option, () => void send(option)));
  } else if (request.method === "confirm") {
    actions.append(button("Yes", () => void send(true)), button("No", () => void send(false)));
  } else {
    const form = element("form", "");
    const input = element(request.method === "editor" ? "textarea" : "input", "");
    if (request.method === "editor") input.rows = 5; else input.type = "text";
    input.value = drafts.get(key) ?? request.initialValue ?? "";
    input.maxLength = 65536; input.autocomplete = "off";
    input.setAttribute("aria-labelledby", title.id); input.placeholder = request.placeholder ?? "";
    input.addEventListener("input", () => {
      drafts.delete(key); drafts.set(key, input.value);
      while (drafts.size > 64) drafts.delete(drafts.keys().next().value);
    });
    const submit = element("button", "extension-answer", "Send answer"); submit.type = "submit";
    form.addEventListener("submit", (event) => { event.preventDefault(); void send(input.value); });
    actions.append(submit, button("Cancel", () => void send(null, true), "extension-cancel"));
    form.append(input, actions); fieldset.append(form);
  }
  if (request.method === "select" || request.method === "confirm") {
    fieldset.append(actions, button("Cancel", () => void send(null, true), "extension-cancel"));
  }
  node.append(fieldset, error);
  return { node };
}
