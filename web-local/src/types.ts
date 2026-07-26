import type { AccentIdentity, SpaceAppearanceState } from "../../src/shared/space-appearance";

export type WorkspacePane = "files" | "chats" | "history";
export type WorkspaceExtensionRailMode = `app:${string}`;
export type WorkspaceRailMode = "workspaces" | WorkspacePane | WorkspaceExtensionRailMode;
export type AppTheme = "light" | "dark";
export type AppThemePreference = AppTheme | "system";
export type AppTypographyFont = "default" | "stable" | "verdana" | "aptos";
export type AppTextSize = "compact" | "standard" | "comfortable";

export interface AppTypographyPreference {
  font: AppTypographyFont;
  textSize: AppTextSize;
}

export interface WorkspaceLocation {
  kind: "local";
  storage: "managed" | "linked";
  providerHint?: "google-drive";
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  rootPath: string;
  location: WorkspaceLocation;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCustomization {
  schema?: 1 | 2;
  color?: string;
  color2?: string;
  primary?: AccentIdentity;
  secondary?: AccentIdentity;
  iconName?: string;
  bannerName?: string;
  bannerImage?: string | null;
  bannerImagePosition?: WorkspaceBannerImagePosition;
}

export type WorkspaceCustomizationMap = Record<string, WorkspaceCustomization>;
export type WorkspaceCustomizationPatch = WorkspaceCustomization;
export interface WorkspaceColorOption { label: string; color: string; soft: string; border: string }
export interface WorkspaceBannerOption { name: string; label: string }
export type WorkspaceBannerImagePosition = "top" | "center" | "bottom";
export interface WorkspacePaneBounds { min: number; max: number; fallback: number }

export interface TreeEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  hasChildren?: boolean;
  ignored?: boolean;
  descendantIgnoredCount?: number;
  children?: TreeEntry[];
}

export type ChangeKind = "created" | "modified" | "deleted" | "remote_deleted";
export interface ChangeEntry { path: string; kind: ChangeKind }
export type ChangeKindCounts = Record<ChangeKind, number>;

export interface FileContextMenuState {
  entry: TreeEntry;
  x: number;
  y: number;
  returnFocusTarget?: HTMLElement | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
}

export interface ChatMessageLanding {
  title?: string;
  summary: string;
  nextActions: string[];
  followUpPrompt: string | null;
  conversationTitle?: string;
  generatedAt: string;
  provider: string;
  model: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  kind?: "conversation_title" | "conversation_lifecycle";
  lifecycle?: { archived?: boolean; snoozedUntil?: string | null };
  landing?: ChatMessageLanding;
}

export type AgentActivityPhase = "queued" | "running" | "streaming" | "complete" | "error";
export interface AgentActivityEvent {
  id: string;
  message: string;
  detail?: string;
  toolName?: string;
  toolCallId?: string;
  phase?: AgentActivityPhase;
}
export interface AgentActivityLogEntry extends AgentActivityEvent { arrivedAt: string }
export interface RuntimePreviewEntry {
  id: string;
  kind: "thinking" | "tool";
  text: string;
  phase?: "streaming" | "complete";
}
export interface RuntimeThinkingSection { id: string; title: string; text: string; pending?: boolean }

export interface ChatActionsState {
  workspace: WorkspaceSummary;
  conversation: ConversationSummary;
  x: number;
  y: number;
  returnFocusTarget?: HTMLElement | null;
}

export type ChatActivityStatus = "running" | "attention";
export type ChatLifecycleView = "active" | "snoozed" | "archived";

export type ContextAttachmentMode = "full_original_text" | "full_extracted_text" | "path_only_reference";
export interface ContextAttachment {
  sourcePath: string;
  sourceFileName: string;
  sourceSizeBytes: number;
  mode: ContextAttachmentMode;
  includedInPrompt: boolean;
  reason: string | null;
  estimatedTokens: number;
  budgetTokens: number;
  provenance: string[];
  warnings: string[];
  userLabel: string;
  detail: string;
}
export interface ChatContextPathRequest {
  id: number;
  path: string;
  workspaceId: string;
  surfaceTabId: string;
}
export interface PendingChatSend {
  conversation: ConversationSummary;
  content: string;
  localUserMessage: ChatMessage;
  selectedPath: string | null;
  contextPaths: string[];
  transientConversation: boolean;
  draftStorageKey: string;
}
export interface WorkspaceFixtureConversation extends ConversationSummary {
  messages: ChatMessage[];
  activityEvents?: AgentActivityEvent[];
  runtimePreviews?: RuntimePreviewEntry[];
  running?: boolean;
  streamingAssistant?: string;
  contextAttachments?: ContextAttachment[];
}

export type AssistantToolsView = "installed" | "discover";

interface WorkspaceSurfaceTabBase {
  id: string;
  workspaceId: string;
  title: string;
}

export type WorkspaceSurfaceTab =
  | (WorkspaceSurfaceTabBase & { kind: "chat"; conversationId: string | null })
  | (WorkspaceSurfaceTabBase & { kind: "file"; path: string })
  | (WorkspaceSurfaceTabBase & { kind: "history"; checkpointId?: string })
  | (WorkspaceSurfaceTabBase & { kind: "library" })
  | (WorkspaceSurfaceTabBase & { kind: "appearance" })
  | (WorkspaceSurfaceTabBase & { kind: "app-studio" })
  | (WorkspaceSurfaceTabBase & { kind: "assistant-tools"; view: AssistantToolsView })
  | (WorkspaceSurfaceTabBase & { kind: "extension"; surfaceId: string; surfaceExecution: "full-trust-pi"; viewId: string })
  | (WorkspaceSurfaceTabBase & {
    kind: "restricted-app";
    appId: string;
    digest: string;
    appTabId: string;
    route: string;
    state?: unknown;
  });

export interface AgentStatus {
  ready: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  piVersion: string | null;
  projectTrusted?: boolean;
  error: string | null;
}

export interface AgentModel {
  provider: string;
  providerName?: string;
  id: string;
  name: string;
  authConfigured: boolean;
  oauthSupported: boolean;
  contextWindow?: number;
}

export interface AgentCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export interface ConversationRuntime {
  sessionId: string;
  model?: { provider: string; id: string; name: string };
  usage: {
    contextTokens: number | null;
    contextWindow: number | null;
    contextPercent: number | null;
    totalTokens: number;
    cost: number;
  };
  thinkingLevel: string;
  activeTools: string[];
  isStreaming: boolean;
  isCompacting: boolean;
}

export interface AgentSkill {
  id?: string;
  name: string;
  description: string;
  path: string;
  source: string | AgentCapabilitySource;
  sourceInfo?: AgentCapabilitySource;
  scope?: AgentCapabilityScope | "user";
  origin?: AgentCapabilityOrigin;
  packageSource?: string;
  enabled?: boolean;
  loaded?: boolean;
  status?: AgentCapabilityStatus;
  disableModelInvocation?: boolean;
  content?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentExtension {
  id: string;
  name: string;
  path: string;
  source: string | AgentCapabilitySource;
  sourceInfo?: AgentCapabilitySource;
  scope?: AgentCapabilityScope | "user";
  origin?: AgentCapabilityOrigin;
  packageSource?: string;
  enabled?: boolean;
  loaded?: boolean;
  status?: AgentCapabilityStatus;
  commands: string[];
  tools: string[];
  flags?: string[];
  diagnostics?: AgentDiagnostic[];
}

export type AgentCapabilityScope = "global" | "project";
export type AgentCapabilityOrigin = "package" | "top-level";
export type AgentCapabilityStatus = "loaded" | "available" | "disabled" | "error" | "blocked" | "missing";
export interface AgentCapabilitySource {
  label?: string;
  path?: string;
  source: string;
  scope: "user" | "project" | "temporary" | AgentCapabilityScope;
  origin: AgentCapabilityOrigin;
  baseDir?: string;
  packageSource?: string;
}
export interface AgentProjectTrust {
  required: boolean;
  trusted: boolean;
  savedDecision: boolean | null;
  mutationTrusted?: boolean;
}
export interface AgentPackage {
  source: string;
  scope: AgentCapabilityScope;
  enabled?: boolean;
  installed?: boolean;
  loaded?: boolean;
  filtered?: boolean;
  installedPath?: string;
  updateAvailable?: boolean;
  displayName?: string;
  types?: Array<"skill" | "extension" | "prompt" | "theme">;
}
export interface AgentTool {
  name: string;
  label?: string;
  description: string;
  source: string;
  active: boolean;
  kind?: "core" | "extension";
  core?: boolean;
  configurable?: false;
  configurationScope?: "chat";
}
export interface AgentToolManagement {
  mode: "session-only";
  persisted: false;
  mutable: false;
  scope: "chat";
  reason: string;
}
export interface AgentDiagnostic { type: "info" | "warning" | "error"; message: string; path?: string }
export type AgentSurfaceBlock =
  | { type: "heading"; text: string; level: 1 | 2 | 3 }
  | { type: "text"; text: string }
  | { type: "callout"; tone: "info" | "success" | "warning"; title?: string; text: string }
  | { type: "metrics"; items: Array<{ label: string; value: string; detail?: string }> }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "list"; items: Array<{ title: string; detail?: string; badge?: string }> };
export interface AgentExtensionSurfaceView {
  id: string;
  title: string;
  description?: string;
  blocks: AgentSurfaceBlock[];
}
export interface AgentExtensionSurface {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  extensionPath: string;
  manifestPath: string;
  source: string | AgentCapabilitySource;
  sourceInfo?: AgentCapabilitySource;
  scope?: AgentCapabilityScope | "user" | "temporary";
  origin?: AgentCapabilityOrigin;
  packageSource?: string;
  enabled?: boolean;
  loaded?: boolean;
  status?: AgentCapabilityStatus;
  views: AgentExtensionSurfaceView[];
}

export type CapabilitySurfaceExecution = "full-trust-pi";

export interface CapabilitySurface {
  key: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  scope: AgentCapabilityScope | "user" | "temporary";
  execution: "full-trust-pi";
  views: AgentExtensionSurfaceView[];
}

export type RestrictedAppAuthDeclaration =
  | { kind: "api-key"; header: string }
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "basic" }
  | { kind: "oauth2-pkce"; issuer: string; clientId: string; scopes: string[] };

export interface RestrictedAppJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, RestrictedAppJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: RestrictedAppJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface RestrictedAppTool {
  name: string;
  description: string;
  action: string;
  inputSchema: RestrictedAppJsonSchema;
  resultSchema: RestrictedAppJsonSchema;
}

export interface RestrictedAppNetworkDestination {
  id: string;
  target:
    | { kind: "public-https"; origin: string }
    | { kind: "loopback-http"; host: "127.0.0.1" | "::1"; port: number };
  methods: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
  auth: RestrictedAppAuthDeclaration[];
}

export interface RestrictedAppFilePermission {
  id: string;
  target: "file" | "directory";
  access: "read" | "read-write";
}

export interface RestrictedAppFileGrant {
  id: string;
  declarationId: string;
  root: string;
  access: "read" | "read-write";
}

export interface RestrictedAppNotificationPermission {
  id: string;
  title: string;
  description: string;
}

export interface RestrictedAppAutomation {
  id: string;
  title: string;
  description?: string;
  handler: string;
  trigger: { kind: "interval"; intervalMinutes: number };
  permissions: {
    network: string[];
    files: string[];
    notifications: string[];
  };
  catchUp: "none" | "latest";
  overlap: "skip";
}

export interface RestrictedAppManifest {
  version: 2;
  id: string;
  title: string;
  description?: string;
  runtime: { kind: "sandboxed-web"; entry: string; worker?: string };
  ui: { icon?: string };
  tools: RestrictedAppTool[];
  automations: RestrictedAppAutomation[];
  permissions: {
    network: RestrictedAppNetworkDestination[];
    files: RestrictedAppFilePermission[];
    notifications: RestrictedAppNotificationPermission[];
  };
}

export interface RestrictedAppReview {
  packageName: string;
  version: string;
  digest: string;
  artifactDigest: string;
  manifest: RestrictedAppManifest;
  fileCount: number;
  totalBytes: number;
}

export interface RestrictedAppInstalled extends RestrictedAppReview {
  workspaceId: string;
  sourceWorkspaceId: string;
  projectId: string;
  tenantId: string;
  principalId: string;
  runtimeInstanceId: string;
  runtimeInstanceKind: "development" | "app";
  releaseDigest: string | null;
  featureInstallationId: string;
  dataNamespaceId: string;
  authority: AppPlatformAuthorityStamp;
  networkGrants: string[];
  fileGrants: RestrictedAppFileGrant[];
  notificationGrants: string[];
  automations: RestrictedAppAutomationState[];
  installedAt: string;
  updatedAt: string;
}

export interface LocalAppPresentation {
  title: string;
  description: string | null;
  icon: string | null;
}

export interface LocalAppProject {
  workspaceId: string;
  projectId: string;
  presentation: LocalAppPresentation;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAppRelease {
  projectId: string;
  sourceWorkspaceId: string;
  releaseDigest: string;
  displayVersion: string;
  presentation: LocalAppPresentation;
  featureIds: string[];
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
}

export interface LocalAppReleaseDeletionResult {
  deleted: boolean;
  cleanupPending: boolean;
}

export interface LocalAppInstance {
  runtimeInstanceId: string;
  projectId: string;
  workspaceId: string;
  releaseDigest: string;
  displayVersion: string;
  presentation: LocalAppPresentation;
  featureIds: string[];
  installedAt: string;
  updatedAt: string;
}

export interface LocalAppInstallOperation {
  operationId: string;
  kind: "install";
  projectId: string;
  targetWorkspaceId: string;
  releaseDigest: string;
  runtimeInstanceId: string;
  features: Array<{ featureId: string; featureInstallationId: string; dataNamespaceId: string }>;
  preparedAt: string;
}

export interface LocalAppUpdateOperation {
  operationId: string;
  kind: "update";
  projectId: string;
  targetWorkspaceId: string;
  releaseDigest: string;
  runtimeInstanceId: string;
  continuityPolicy: "eligible" | "reset";
  plan: {
    planDigest: string;
    fromReleaseDigest: string;
    toReleaseDigest: string;
    canCommit: boolean;
    blockedReasons: string[];
    transitions: Array<{
      featureId: string;
      action: "add" | "keep" | "update" | "remove";
      data: "create" | "retain" | "migrate" | "retain-disabled";
      continuity: { grants: string[]; connections: string[]; enabledJobs: string[] };
      resets: Array<"grants" | "connections" | "jobs">;
      blockedReason?: string;
    }>;
  };
  preparedAt: string;
}

export type LocalAppOperation = LocalAppInstallOperation | LocalAppUpdateOperation;

export interface LocalAppRetainedData {
  retainedDataId: string;
  projectId: string;
  runtimeInstanceId: string;
  featureId: string;
  featureInstallationId: string;
  dataNamespaceId: string;
  releaseDigest: string;
  removedAt: string;
}

export interface LocalAppStudioSnapshot {
  project: LocalAppProject | null;
  previews: RestrictedAppInstalled[];
  releases: LocalAppRelease[];
  instances: LocalAppInstance[];
  operations: LocalAppOperation[];
  retainedData: LocalAppRetainedData[];
}

export interface LocalAppWorkspaceRemovalImpact {
  activeSourceInstanceCount: number;
  activeTargetInstanceCount: number;
  retainedDataCount: number;
  incomingPreparedOperationCount: number;
}

export interface RestrictedAppAutomationState {
  id: string;
  enabled: boolean;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface RestrictedAppAutomationRunReceipt {
  receiptId: string;
  verification: "captured" | "legacy-unverified";
  runId: string;
  automationId: string;
  reason: "scheduled" | "manual" | "resume";
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "failure" | "skipped" | "cancelled" | "interrupted";
  error?: string;
  kind?: "job";
  tenantId?: string;
  runtimeInstanceId?: string;
  featureInstallationId?: string;
  featureRevisionDigest?: string;
  dataNamespaceId?: string;
  effectivePrincipal?: AppPlatformEffectivePrincipal;
  authority?: AppPlatformAuthorityStamp;
  acceptedAt?: string;
  state?: "succeeded" | "failed" | "skipped" | "cancelled" | "expired";
  occurrenceId?: string;
  attemptId?: string;
}

export interface AppPlatformEffectivePrincipal {
  principalId: string;
  kind: "human" | "agent" | "service" | "system";
  realm: "local" | "cloud";
}

export interface AppPlatformAuthorityStamp {
  runtimeInstanceGeneration: string;
  featureInstallationGeneration: string;
  grantGeneration: string;
  connectionGeneration: string;
  jobGeneration: string;
  principalGeneration: string;
  dataGeneration: string;
}

export interface RestrictedAppViewRequest {
  workspaceId: string;
  appId: string;
  digest: string;
  mountId: string;
  placement: "navigator" | "tab";
  appTabId?: string;
  route: string;
  state?: unknown;
  sequence: number;
  bounds: { x: number; y: number; width: number; height: number };
  active: boolean;
  occluded: boolean;
  theme: AppTheme;
}

export interface RestrictedAppProposal {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourcePath: string;
  review: RestrictedAppReview;
  status: "pending" | "installed" | "dismissed" | "revision-changed";
  createdAt: string;
  updatedAt: string;
  installedApp?: RestrictedAppInstalled;
}

export interface RestrictedAppConnectionStatus {
  destinationId: string;
  owner: "instance" | "principal";
  kind: "api-key" | "bearer" | "basic" | "oauth2-pkce" | "none" | null;
  configured: boolean;
}

export interface RestrictedAppStorageUsage {
  revision: number;
  usageBytes: number;
  quotaBytes: number;
  keyCount: number;
  keyLimit: number;
}

export type RestrictedAppCredential =
  | { kind: "api-key"; value: string }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string };
export interface AgentCatalog {
  skills: AgentSkill[];
  extensions: AgentExtension[];
  packages: AgentPackage[];
  tools: AgentTool[];
  commands?: AgentCommand[];
  toolManagement?: AgentToolManagement;
  diagnostics: AgentDiagnostic[];
  surfaces?: AgentExtensionSurface[];
  trust?: AgentProjectTrust;
  projectTrusted?: boolean;
}

export interface CapabilityDiscoverItem {
  id: string;
  name: string;
  description: string;
  types: Array<"skill" | "extension">;
  sourceKind: string;
  installSource?: string;
  official: boolean;
  author?: string;
  version?: string;
  downloads?: number;
  publishedAt?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  npmUrl?: string;
  license?: string;
}

export interface CapabilityDiscoverResponse {
  items: CapabilityDiscoverItem[];
  total: number;
  offset: number;
  limit: number;
  catalogUrl: string;
  truncated?: boolean;
  diagnostics?: string[];
}

export interface CapabilityDiscoverDetailsItem extends CapabilityDiscoverItem {
  skills?: string[];
  extensions?: string[];
  prompts?: string[];
  themes?: string[];
  installScripts?: Array<{ name: "preinstall" | "install" | "postinstall"; command: string }>;
  dependencyCount?: number;
}

export interface CapabilityDiscoverDetailsResponse {
  item: CapabilityDiscoverDetailsItem;
}

export interface WorkspaceCheckpoint {
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  fileCount: number;
}

export interface FileVersionEntry {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
  source?: "checkpoint" | "edit";
}
export interface FileVersionRestoreOutcome {
  restored: boolean;
  path: string;
  hashSha256: string;
  previousHashSha256: string | null;
  safetyCheckpointId: string;
}

export interface LocalEventStream {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  close: () => void;
}

export type WorkspaceFileEvent =
  | { type: "ready"; recursive: boolean }
  | { type: "file_event"; eventType: string; path: string | null }
  | { type: "error"; message: string };

export interface ExtensionUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  initialValue?: string;
  secret?: boolean;
}

export interface ChatStreamEvent {
  type: "status" | "turn_state" | "assistant_delta" | "assistant_message" | "assistant_thinking" | "tool" | "resources_changed" | "error" | "done" | "extension_ui_request" | "restricted_app_proposal" | "restricted_app_proposal_settled" | "editor";
  conversationId: string;
  running?: boolean;
  message?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  phase?: AgentActivityPhase;
  thinkingPhase?: "start" | "delta" | "end";
  detail?: string;
  request?: ExtensionUiRequest;
  proposal?: RestrictedAppProposal;
  editorMode?: "replace" | "append";
}

export interface BootstrapResponse { workspaces: WorkspaceSummary[]; agent: AgentStatus; appearance?: SpaceAppearanceState }
export interface DesktopUpdateStatus {
  supported: boolean;
  phase: "unsupported" | "idle" | "checking" | "available" | "not_available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
}
export type CommandPaletteGroupId = "go-to" | "switch-workspace" | "chats" | "files" | "actions";
export interface ShortcutRow { keys: string[]; action: string }
export interface ShortcutGroup { title: string; rows: ShortcutRow[] }
