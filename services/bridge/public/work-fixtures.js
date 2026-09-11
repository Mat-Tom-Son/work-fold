/** Inert visual states, used only by the existing explicit fixture preview. */
export function buildWorkFixture(conversationId, state = "question") {
  const work = { version: 1, requestId: "fixture-work", taskId: "fixture-task", owner: { conversationId }, state: "waiting", label: "Needs your answer", detail: null, canStop: true, canContinue: false, hadQuestions: true,
    questions: [{ id: "fixture-currency", requestId: "fixture-child", from: "Supplier quotes", text: "Which currency should I use for the comparison? The quotes include both US dollars and Canadian dollars.", state: "open", canAnswer: true }], questionCount: 1,
    children: [{ requestId: "fixture-child", title: "Supplier quotes", state: "waiting", label: "Needs your answer" }], result: null };
  if (state === "saved-answer") {
    work.questions[0] = { ...work.questions[0], state: "recorded", answer: "Canadian dollars" };
    work.label = work.children[0].label = "Ready to continue";
  }
  if (state === "partial") Object.assign(work, { state: "partial", label: "Partly finished", canStop: false, questions: [], questionCount: 0,
    children: [{ requestId: "fixture-child", title: "Supplier quotes", state: "partial", label: "Partly finished" }],
    result: { summary: "North is the lower materials quote. Installation still needs a quote before the full budget is ready.", outcome: "partial", files: [] } });
  if (state === "interrupted") Object.assign(work, { state: "failed", label: "Couldn’t finish", detail: "The follow-up did not start. Your saved results are still available.", canContinue: true, canStop: false, questions: [], questionCount: 0 });
  return work;
}
