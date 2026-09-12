// State transition shared by the paired client and its focused UI tests.
export function canDeleteChat(state, conversationId) {
  const selected = state.conversations.find((conversation) => conversation.id === conversationId);
  return Boolean(conversationId && !state.deleteSaving && !state.renameSaving && selected
    && selected.state !== "running" && selected.state !== "compacting" && !state.activeTasks.has(conversationId));
}

export function removeDeletedChat(state, conversationId) {
  if (!conversationId) return null;
  const nextConversationId = state.conversations.find((conversation) => conversation.id !== conversationId)?.id ?? null;
  state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
  state.composerDrafts.delete(`chat:${conversationId}`);
  return { nextConversationId };
}
