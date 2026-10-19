import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type CollaborationOperation = "handoff" | "steer" | "stop" | "copy" | "report" | "ask" | "answer" | "wait";
export interface CollaborationToolHost {
  invoke(operation: CollaborationOperation, taskId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
const text = { type: "string", minLength: 1 };
const strings = { type: "array", items: text };
const specs: Array<{ operation: CollaborationOperation; description: string; properties: Record<string, unknown>; required: string[] }> = [
  { operation: "handoff", description: "Delegate work to a new Chat, or follow up in a child Chat. Defaults to this work-folder. Pass assignment text directly; no shell quoting or own task ids are needed.", properties: { message: text, workFolder: text, conversation: text, files: strings }, required: ["message"] },
  { operation: "steer", description: "Redirect a running child Chat after its current step. Only Chats you handed work to may be steered.", properties: { conversation: text, message: text, workFolder: text }, required: ["conversation", "message"] },
  { operation: "stop", description: "Stop a child Chat and its outstanding delegated work and jobs. Only Chats you handed work to may be stopped.", properties: { conversation: text, workFolder: text }, required: ["conversation"] },
  { operation: "copy", description: "Branch your Chat or a child Chat from its last finished reply, optionally starting a new assignment in the copy.", properties: { conversation: text, message: text, title: text, workFolder: text }, required: [] },
  { operation: "report", description: "Submit your delegated result with summary, optional structured data and deliverable paths. The host supplies this turn's exact identity.", properties: { summary: text, data: {}, files: strings, outcome: { type: "string", enum: ["succeeded", "partial", "failed"] } }, required: ["summary", "outcome"] },
  { operation: "ask", description: "Ask the person or parent a durable question. Set asynchronous to keep doing independent work; the answer is delivered once, including when it arrives before this turn ends. Otherwise end your turn after asking.", properties: { question: text, options: strings, to: { type: "string", enum: ["person", "parent"] }, asynchronous: { type: "boolean" } }, required: ["question"] },
  { operation: "answer", description: "Answer a question from delegated work once. Name the work-folder that asked it.", properties: { question: text, answer: text, workFolder: text }, required: ["question", "answer"] },
  { operation: "wait", description: "Read a delegated task's result, or wait up to 120 seconds. Returns immediately when the child needs an answer. Reading a completed result records delivery so it is not repeated.", properties: { task: text, workFolder: text, seconds: { type: "number", minimum: 0, maximum: 120 } }, required: ["task"] },
];

export function createCollaborationTools(host: CollaborationToolHost, currentTask: () => string | undefined): ToolDefinition<any>[] {
  return specs.map(({ operation, description, properties, required }) => ({
    name: `chat_${operation}`, label: `Chat ${operation}`, description,
    parameters: { type: "object", properties, required, additionalProperties: false } as any,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const taskId = currentTask();
      if (!taskId) throw new Error("Collaboration tools require your own running turn.");
      const result = await host.invoke(operation, taskId, params, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  }));
}
