/** Trusted parent controls. The app frame receives request/status/cancel only. */
export function createBrowserAppActions({ element, execute, active }) {
  let app;
  let generation = 0;
  let timer;
  let refreshing = false;
  let busy = false;
  let records = [];
  let detail;
  let error = "";
  let fingerprint = "";
  const labels = { pending: "Needs review", running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", expired: "Expired" };
  const live = (record) => record.status === "pending" || record.status === "running";
  const titleFor = (record) => String(record.title).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
  const current = (version) => version === generation && app && active();
  function reset() {
    generation++; clearInterval(timer); app = null; refreshing = false; busy = false;
    records = []; detail = null; error = ""; fingerprint = "";
    element.replaceChildren(); element.hidden = true;
  }
  async function invoke(operation, input = {}) {
    const version = generation;
    if (!current(version)) throw new Error("This app view is no longer active.");
    const result = await execute(app, operation, input);
    if (!current(version)) throw new Error("This app view is no longer active.");
    return result;
  }
  function button(label, run, className = "quiet") {
    const node = document.createElement("button"); node.type = "button";
    node.className = className; node.textContent = label; node.disabled = busy;
    node.addEventListener("click", () => void task(run)); return node;
  }
  async function task(run) {
    if (busy || !app) return;
    const version = generation; busy = true; error = ""; render();
    for (const control of element.querySelectorAll("button")) control.disabled = true;
    try { await run(); }
    catch { if (current(version)) error = "Couldn't complete the request. Refresh its status before trying again."; }
    finally { if (current(version)) { busy = false; render(); for (const control of element.querySelectorAll("button")) control.disabled = false; } }
  }
  async function show(requestId) {
    const result = await invoke("review", { requestId });
    detail = result.review; error = ""; render();
    element.scrollTop = 0;
    const heading = element.querySelector("h3"); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
  async function refresh() {
    if (refreshing || !app || !active() || document.visibilityState === "hidden") return;
    const version = generation; refreshing = true;
    try {
      const result = await invoke("list");
      records = Array.isArray(result.actions) ? result.actions.slice(0, 50) : [];
      if (detail) {
        const record = records.find((item) => item.requestId === detail.requestId);
        if (!record) detail = null;
        else if (record.status !== detail.status) {
          // Refresh the authoritative outcome before showing a completed result.
          const result = await invoke("review", { requestId: record.requestId });
          detail = result.review;
        }
      }
      error = ""; render();
    } catch { if (current(version)) { error = "Action status unavailable. Refresh to try again."; render(); } }
    finally { if (version === generation) refreshing = false; }
  }
  function render() {
    const next = JSON.stringify({ records, detail, error });
    if (next === fingerprint) return;
    fingerprint = next;
    element.replaceChildren(); element.hidden = !records.length && !error && !detail;
    if (element.hidden) return;
    const heading = document.createElement("div"); heading.className = "browser-action-heading";
    const title = document.createElement("h3"); title.textContent = detail ? titleFor(detail) : "App requests";
    heading.append(title, button(detail ? "Back" : "Refresh", async () => { detail = null; await refresh(); render(); }));
    element.append(heading);
    if (error) { const message = document.createElement("p"); message.setAttribute("role", "status"); message.textContent = error; element.append(message); }
    if (detail) {
      const state = document.createElement("p"); state.className = "browser-action-status";
      state.textContent = labels[detail.status] || "Unavailable"; element.append(state);
      if (detail.status === "pending" && detail.description) {
        const description = document.createElement("p"); description.textContent = detail.description; element.append(description);
      }
      const value = document.createElement("pre"); value.tabIndex = 0;
      value.setAttribute("aria-label", detail.status === "succeeded" ? "Action result" : "Action inputs");
      try { value.textContent = detail.status === "succeeded" ? JSON.stringify(detail.result, null, 2) : JSON.stringify(JSON.parse(detail.inputJson), null, 2); }
      catch { value.textContent = "Details unavailable."; }
      element.append(value);
      if (["failed", "cancelled", "interrupted"].includes(detail.status)) {
        const notice = document.createElement("p"); notice.textContent = "Earlier changes may remain. Check the app before starting again."; element.append(notice);
      }
      const controls = document.createElement("div"); controls.className = "browser-action-controls";
      if (detail.status === "pending") {
        controls.append(button("Run", async () => {
          const { requestId, reviewDigest } = detail;
          await invoke("approve", { requestId, reviewDigest });
          await show(requestId); await refresh();
        }, "primary"));
      }
      if (live(detail)) controls.append(button(detail.status === "running" ? "Stop" : "Cancel", async () => {
        const requestId = detail.requestId; await invoke("cancel", { requestId }); await show(requestId); await refresh();
      }));
      element.append(controls);
      return;
    }
    const list = document.createElement("ul");
    for (const record of records.slice(0, 8)) {
      const row = document.createElement("li");
      const label = document.createElement("span"); label.textContent = `${titleFor(record)} · ${labels[record.status] || "Unavailable"}`;
      row.append(label, button(record.status === "pending" ? "Review" : "View", () => show(record.requestId))); list.append(row);
    }
    element.append(list);
  }
  return {
    reset,
    async open(value) { reset(); app = { ...value }; const version = generation; await refresh(); if (current(version)) timer = setInterval(() => void refresh(), 5000); },
    async call(call) {
      const kind = call?.kind;
      const method = { "actions.request": "request", "actions.get": "get", "actions.list": "list", "actions.cancel": "cancel" }[kind];
      if (!method) throw new Error("This app cannot review or approve its own requests.");
      const fields = method === "list" ? ["kind"] : method === "request" ? ["kind", "request"] : ["kind", "requestId"];
      if (Object.keys(call).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(call, key))) throw new Error("Invalid app request.");
      const input = method === "list" ? {} : method === "request" ? { request: call.request } : { requestId: call.requestId };
      const result = await invoke(method, input);
      if (method === "request" || method === "cancel") void refresh();
      return method === "list" ? result.actions : result.action;
    },
  };
}
