import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Pi's default system prompt opens with a coding-assistant sentence. work-fold
 * is for general computer work, so each request a Worker or the work-fold
 * agent sends opens with its own role instead.
 *
 * Pi exposes the preamble only through `customPrompt`, which also drops the
 * tool list, the tool rules, and the docs section, or through a forced prompt,
 * which freezes those sections for the run while tool_search can still add
 * tools. This hook therefore swaps that one sentence request-locally, where
 * Pi's own sections are already rendered: the tools, rules, docs, Skills, and
 * appendices stay Pi's, the transcript keeps recording Pi's sections, and the
 * text is identical on every request, so prompt caching is unaffected. A
 * person's own SYSTEM.md replaces the default preamble and is left alone.
 */
export const piDefaultPreamble = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export type WorkFoldSessionRole = "worker" | "work-fold-agent";

export function workFoldRolePreamble(role: WorkFoldSessionRole): string {
  return role === "work-fold-agent"
    ? "You are the work-fold agent in work-fold, a local app built on the pi agent harness. You sit above the person's work-folders and help with general computer work across them — documents, research, data, files, and code — by reading files, running commands, editing and writing files, and coordinating each work-folder's Worker."
    : "You are this work-folder's Worker in work-fold, a local app built on the pi agent harness. You help the person with general computer work in one ordinary folder — documents, research, data, files, and code — by reading files, running commands, and editing and writing files.";
}

export function workFoldRolePreambleExtension(role: WorkFoldSessionRole): ExtensionFactory {
  const preamble = workFoldRolePreamble(role);
  return (pi) => {
    pi.on("context_with_system", (event) => {
      let replaced = false;
      const messages = event.messages.map((message) => {
        if (message.role !== "system" || message.sections?.preamble !== piDefaultPreamble) return message;
        replaced = true;
        // Overwriting an existing key keeps its position, so the preamble still leads.
        return { ...message, sections: { ...message.sections, preamble } };
      });
      return replaced ? { messages } : undefined;
    });
  };
}
