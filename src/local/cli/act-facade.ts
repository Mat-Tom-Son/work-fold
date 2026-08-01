/**
 * In-process authority the act-lane executor calls to apply commands. The
 * interactive local API implements this interface inside `startLocalApi`
 * (where the chat runtime state lives) and exposes it on `LocalApiHandle`;
 * the desktop CLI host receives it through a getter that answers null while
 * the interactive app is not running. Methods throw `WorkspaceCliError` so
 * exit codes map without translation.
 */

export interface WorkspaceActSpaceRef {
  id: string;
  name: string;
  rootPath: string;
}

export interface WorkspaceActConversationRef {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

export type WorkspaceActChatState = "idle" | "running" | "compacting";

/**
 * Task-scoped view of one accepted Assistant turn. `unknown` means the app
 * run holding the record has ended or the id was never accepted here — turn
 * outcomes are kept in memory for the app run; transcripts stay durable.
 */
export type WorkspaceActTurnState = "running" | "succeeded" | "failed" | "aborted" | "unknown";

export interface WorkspaceActTurnStatus {
  taskId: string;
  state: WorkspaceActTurnState;
  conversationId: string | null;
  messageId: string | null;
  error: string | null;
  endedAt: string | null;
}

export interface WorkspaceActChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  interrupted?: true;
}

export interface WorkspaceActFacade {
  createConversation(input: { space: string }): Promise<{ space: WorkspaceActSpaceRef; conversation: WorkspaceActConversationRef }>;
  listConversations(input: { space: string }): Promise<{ space: WorkspaceActSpaceRef; conversations: WorkspaceActConversationRef[] }>;
  sendMessage(input: {
    space: string;
    conversationId?: string;
    newConversation?: boolean;
    content: string;
  }): Promise<{ space: WorkspaceActSpaceRef; conversationId: string; messageId: string; taskId: string }>;
  conversationStatus(input: { space: string; conversationId: string }): Promise<{
    space: WorkspaceActSpaceRef;
    conversation: WorkspaceActConversationRef;
    state: WorkspaceActChatState;
  }>;
  conversationResult(input: { space: string; conversationId: string; messages?: number }): Promise<{
    space: WorkspaceActSpaceRef;
    conversationId: string;
    state: WorkspaceActChatState;
    total: number;
    lastAssistant: string | null;
    messages: WorkspaceActChatMessage[];
  }>;
  abortTurn(input: { space: string; conversationId: string }): Promise<{
    space: WorkspaceActSpaceRef;
    conversationId: string;
    aborted: boolean;
  }>;
  turnStatus(input: { space: string; taskId: string }): Promise<{
    space: WorkspaceActSpaceRef;
    task: WorkspaceActTurnStatus;
  }>;
  turnResult(input: { space: string; taskId: string }): Promise<{
    space: WorkspaceActSpaceRef;
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: WorkspaceActChatMessage;
  }>;
  createSpace(input: { name: string }): Promise<{ space: WorkspaceActSpaceRef }>;
  registerSpace(input: { rootPath: string }): Promise<{ space: WorkspaceActSpaceRef }>;
  addFiles(input: { space: string; fromPaths: string[]; toDir?: string; cwd: string }): Promise<{
    space: WorkspaceActSpaceRef;
    copied: string[];
    checkpointId: string | null;
  }>;

  /**
   * Management scope: the conversation above all Spaces. It reuses the same
   * turn orchestration and Pi runtime as Space Chats, but its transcript is
   * machine-local application state, it carries no Space's project
   * configuration, and its cross-Space hands are these same act commands.
   * Omitting conversationId targets the default (most recent active)
   * management conversation, creating it on first send.
   */
  manageList(): Promise<{ conversations: WorkspaceActConversationRef[] }>;
  manageSend(input: { conversationId?: string; newConversation?: boolean; content: string }): Promise<{
    conversationId: string;
    messageId: string;
    taskId: string;
  }>;
  manageConversationStatus(input: { conversationId?: string }): Promise<{
    conversation: WorkspaceActConversationRef;
    state: WorkspaceActChatState;
  }>;
  manageTurnStatus(input: { taskId: string }): Promise<{ task: WorkspaceActTurnStatus }>;
  manageConversationResult(input: { conversationId?: string; messages?: number }): Promise<{
    conversationId: string;
    state: WorkspaceActChatState;
    total: number;
    lastAssistant: string | null;
    messages: WorkspaceActChatMessage[];
  }>;
  manageTurnResult(input: { taskId: string }): Promise<{
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: WorkspaceActChatMessage;
  }>;
  manageAbort(input: { conversationId?: string }): Promise<{ conversationId: string; aborted: boolean }>;
}
