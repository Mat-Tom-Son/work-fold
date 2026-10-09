import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const toolFailureGuidance = "Before another call, compare the actual arguments with this tool's schema and the error above; use tool_search if you need its current definition. Correct missing or invalid inputs rather than repeating the same failed call. If execution may have had effects, inspect the outcome before retrying. Codemode uses the same tools and validation; it does not bypass requirements or permissions.";

/** Native result hook shared by built-ins, Extensions, MCP and nested calls. */
export const toolInputFeedbackExtension: ExtensionFactory = (pi) => {
  pi.on("tool_result", (event) => {
    if (!event.isError) return;
    return {
      content: [...event.content, { type: "text", text: toolFailureGuidance }],
      // Pi drops structured data on content replacement unless it is returned
      // explicitly. Keep failed structured results usable by programmatic callers.
      ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
    };
  });
  // Native argument-validation failures settle before tool_result hooks. The
  // finalized transcript event supplies the same guidance for those calls.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "toolResult" || !message.isError
      || message.content.some(item => item.type === "text" && item.text === toolFailureGuidance)) return;
    return { message: { ...message, content: [...message.content, { type: "text", text: toolFailureGuidance }] } };
  });
};
