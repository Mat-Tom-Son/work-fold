import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
export interface WorktreeToolHost { invoke(taskId: string, input: { action: "create" | "list" | "archive" | "restore"; id?: string; ref?: string }): Promise<unknown> }
export function createWorktreeTool(host: WorktreeToolHost, currentTask: () => string | undefined): ToolDefinition<any> {
  return {
    name: "worktree", label: "Managed working copy",
    description: "Create an isolated Git working copy from a committed revision (default HEAD), registered as a new work-folder. Delegate edits to its returned workFolderId with chat_handoff. Source files stay unchanged. List copies; archive an idle copy without deleting any files or Git history; restore it later. Changes are never automatically merged. Requires this work-folder to be a Git repository root.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "list", "archive", "restore"] }, ref: { type: "string", description: "Committed Git revision; local uncommitted changes are not copied." }, id: { type: "string", description: "Managed working copy id for archive or restore." } }, required: ["action"], additionalProperties: false } as any,
    async execute(_id, input) {
      const task = currentTask(); if (!task) throw new Error("Working copies require your own running turn.");
      const result = await host.invoke(task, input as any);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
