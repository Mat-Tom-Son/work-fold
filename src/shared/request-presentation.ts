/** Trusted person-facing projection. Never exposed to sandboxed App bridges. */
export interface WorkRequestOwner {
  workFolderId?: string;
  workFolderName?: string;
  conversationId: string;
}

export type WorkRequestState = "working" | "waiting" | "handed_off" | "done" | "partial" | "failed" | "stopped" | "expired";

export interface WorkQuestionView {
  id: string;
  requestId: string;
  text: string;
  from: string;
  /** Suggested answers the person can pick with one click, beside writing their own. */
  options?: string[];
  state: "open" | "recorded";
  answer?: string;
  canAnswer: boolean;
  reason?: string;
}

export interface WorkRequestView {
  version: 1;
  requestId: string;
  taskId: string;
  owner: WorkRequestOwner;
  state: WorkRequestState;
  label: string;
  detail: string | null;
  canStop: boolean;
  canContinue: boolean;
  questions: WorkQuestionView[];
  questionCount: number;
  hadQuestions?: boolean;
  /** The checklist the agent keeps for this work (2026-10-18), in its order. */
  checklist?: Array<{ text: string; status: "todo" | "doing" | "done" }>;
  children: Array<{ requestId: string; title: string; state: WorkRequestState; label: string }>;
  result: {
    outcome: "succeeded" | "partial" | "failed";
    summary: string;
    data?: unknown;
    files: Array<{ workFolderId: string; workFolderName: string; path: string; sizeBytes: number }>;
  } | null;
}

export function workRequestLabel(state: WorkRequestState, personQuestions = 0, savedAnswers = 0): string {
  switch (state) {
    case "working": return "Working";
    case "handed_off": return "Working with other Workers";
    case "waiting": return personQuestions ? "Needs your answer" : savedAnswers ? "Ready to continue" : "Waiting for a Worker";
    case "done": return "Finished";
    case "partial": return "Partly finished";
    case "failed": return "Couldn’t finish";
    case "stopped": return "Stopped";
    case "expired": return "Time window ended";
  }
}
