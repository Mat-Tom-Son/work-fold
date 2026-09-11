// Answers remain drafts in this browser tab until the host accepts them.
// Session storage survives a renderer reload, but never becomes model context.
const memory = new Map();
const key = (id) => `work-fold.question-draft:${id}`;
export function readQuestionDraft(id) {
  try { return sessionStorage.getItem(key(id)) ?? memory.get(id) ?? ""; }
  catch { return memory.get(id) ?? ""; }
}
export function writeQuestionDraft(id, value) {
  memory.set(id, value);
  try { sessionStorage.setItem(key(id), value); } catch { /* memory remains */ }
}
export function clearQuestionDraft(id) {
  memory.delete(id);
  try { sessionStorage.removeItem(key(id)); } catch { /* memory is clear */ }
}

export function clearQuestionDrafts() {
  memory.clear();
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const name = sessionStorage.key(index);
      if (name?.startsWith("work-fold.question-draft:")) sessionStorage.removeItem(name);
    }
  } catch { /* memory is clear */ }
}
