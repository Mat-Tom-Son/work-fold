/**
 * `checklist`: the plan a Worker or the work-fold agent keeps for its request
 * (2026-10-18). The agent sends the whole list each time; the host keeps it
 * on the request record, shows it to the person beside the Chat's work, and
 * hands it back at the start of every later turn of that request, so a long
 * task keeps its shape across follow-ups and answered questions.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { WorkFoldChecklist, WorkFoldChecklistItem } from "../requests/request-records.js";

export interface ChecklistToolHost {
  set(input: { taskId: string; items: unknown }): Promise<WorkFoldChecklist | null>;
}

export interface ChecklistToolInput {
  host: ChecklistToolHost;
  /** The running turn's task id; the tool refuses outside a turn. */
  taskId: () => string | undefined;
}

const statusMarks: Record<WorkFoldChecklistItem["status"], string> = { todo: "[ ]", doing: "[~]", done: "[x]" };

/** The list as the agent and the turn context read it. */
export function describeChecklist(items: readonly WorkFoldChecklistItem[]): string {
  return items.map((item) => `${statusMarks[item.status]} ${item.text}`).join("\n");
}

export function createChecklistTool(input: ChecklistToolInput): ToolDefinition<any> {
  return {
    name: "checklist",
    label: "Checklist",
    description: "Keep a short checklist for this request that the person can see while you work. Send the whole list every time, in order; mark the item you are on as doing and finished ones as done. work-fold keeps it with the request and gives it back at the start of every later turn of this work, so a long task keeps its shape. An empty list clears it.",
    promptSnippet: "Keep a visible checklist for a multi-step request",
    promptGuidelines: [
      "Use checklist when a request has three or more real steps or will span several turns; skip it for quick answers.",
      "Update it as you go: one item doing at a time, and mark items done as you finish them, before your final reply.",
    ],
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The whole checklist, in order.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 1, description: "One step, in a few plain words." },
              status: { type: "string", enum: ["todo", "doing", "done"] },
            },
            required: ["text", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const taskId = input.taskId();
      if (!taskId) throw new Error("The checklist can change only inside a running turn.");
      const saved = await input.host.set({ taskId, items: (params as { items?: unknown }).items });
      if (!saved) return { content: [{ type: "text" as const, text: "Checklist cleared." }], details: { items: [] } };
      const done = saved.items.filter((item) => item.status === "done").length;
      return {
        content: [{ type: "text" as const, text: `Checklist saved (${done} of ${saved.items.length} done):\n${describeChecklist(saved.items)}` }],
        details: { items: saved.items },
      };
    },
  };
}
