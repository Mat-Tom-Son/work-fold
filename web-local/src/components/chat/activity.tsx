import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookOpen20Regular,
  Chat20Regular,
  ChevronRight20Regular,
  DocumentAdd20Regular,
  DocumentEdit20Regular,
  Folder20Regular,
  Search20Regular,
  Thinking20Regular,
  WindowConsole20Regular,
  Wrench20Regular,
  type FluentIcon,
} from "@fluentui/react-icons";

import { collectSpacePathCandidates, spacePathCandidate } from "../../lib/space-path-links";
import { safeExternalHref } from "../../lib/api";
import type { AgentActivityPhase, RuntimePreviewEntry } from "../../types";
import { FluentGlyph } from "../chrome/common";

export type SpacePathLinkResolver = (paths: string[]) => Promise<Map<string, string>>;
export type WorkStepsRunningView = "every-step" | "current-step";

interface RuntimeContextPreviewProps {
  entries: RuntimePreviewEntry[];
  /** The turn is still running: rows stay open and the active one shimmers. */
  running?: boolean;
  /** Reply text has started, so the steps fold into their summary line. */
  replyStarted?: boolean;
  /** Which rows stay visible while the turn runs. */
  runningView?: WorkStepsRunningView;
  spaceRoot?: string;
  onOpenSpaceFile?: (path: string) => void;
  resolveSpacePathLinks?: SpacePathLinkResolver;
  /** Already-resolved Folder paths (candidate → existing path); skips the resolver. */
  resolvedSpacePaths?: Map<string, string>;
  /** The Chat supplies its existing Markdown renderer without a module cycle. */
  renderText?: (text: string, links: Map<string, string> | null) => ReactNode;
}

/**
 * The Worker's steps for one turn, in the order they happened. Thinking rows
 * carry only model-supplied reasoning; tool rows carry the safe summaries the
 * runtime already emitted. While the turn runs the rows stay open and the
 * active one shimmers; once reply text starts they fold into one plain
 * summary line that opens on click.
 */
export function RuntimeContextPreview({
  entries,
  running = false,
  replyStarted = false,
  runningView = "every-step",
  spaceRoot,
  onOpenSpaceFile,
  resolveSpacePathLinks,
  resolvedSpacePaths,
  renderText,
}: RuntimeContextPreviewProps) {
  const settled = !running || replyStarted;
  const working = running && !replyStarted;
  const [expanded, setExpanded] = useState(false);
  const [openThoughts, setOpenThoughts] = useState<ReadonlySet<string>>(() => new Set());
  const steps = entries.filter(isVisibleStep);
  const timerRunning = working && steps.some((entry) => entry.kind === "thinking" && isActivePhase(entry.phase) && !entry.text.trim());
  const now = useClock(timerRunning);
  const spaceLinks = useSpacePathLinks(steps, spaceRoot, resolveSpacePathLinks, resolvedSpacePaths);
  if (!steps.length && !working) return null;
  const summary = workStepsSummary(steps);
  const rows = working && runningView === "current-step" ? steps.slice(-1) : steps;
  const open = !settled || expanded;
  const toggleThought = (id: string) => setOpenThoughts((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <section className={`work-steps ${settled ? "settled" : "running"}${open ? " open" : ""}`} aria-label="Worker steps">
      {settled && summary ? (
        <button type="button" className="work-steps-summary" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          <FluentGlyph icon={summaryIcon(steps)} size={16} filled={false} className="work-steps-icon" />
          <span className="work-steps-label">{summary}</span>
          <FluentGlyph icon={ChevronRight20Regular} size={14} filled={false} className="work-steps-chevron" />
        </button>
      ) : null}
      <div className="work-steps-rows" inert={settled && !expanded ? true : undefined}>
        <div className="work-steps-list">
          {working && !steps.length ? (
            <div className="work-step working active">
              <FluentGlyph icon={Thinking20Regular} size={16} filled={false} className="work-step-icon" />
              <div className="work-step-line"><span className="work-step-verb work-step-shimmer">Working…</span></div>
            </div>
          ) : null}
          {rows.map((entry) => (entry.kind === "tool" ? (
            <ToolStep entry={entry} spaceRoot={spaceRoot} spaceLinks={spaceLinks} onOpenSpaceFile={onOpenSpaceFile} key={entry.id} />
          ) : entry.kind === "progress" || entry.kind === "command" ? (
            <TextStep entry={entry} rendered={renderText?.(entry.text, spaceLinks)} key={entry.id} />
          ) : (
            <ThoughtStep
              entry={entry}
              live={working && isActivePhase(entry.phase)}
              now={now}
              open={openThoughts.has(entry.id)}
              onToggle={() => toggleThought(entry.id)}
              key={entry.id}
            />
          )))}
        </div>
      </div>
    </section>
  );
}

function ToolStep({
  entry,
  spaceRoot,
  spaceLinks,
  onOpenSpaceFile,
}: {
  entry: RuntimePreviewEntry;
  spaceRoot?: string;
  spaceLinks: Map<string, string> | null;
  onOpenSpaceFile?: (path: string) => void;
}) {
  const key = toolKey(entry);
  const active = isActivePhase(entry.phase);
  const failed = entry.phase === "error";
  const target = entry.edit?.path ?? entry.detail?.trim() ?? "";
  const command = commandTools.has(key);
  const candidate = !command && target ? spaceRelativeToolPath(target, spaceRoot) : null;
  const resolved = candidate ? spaceLinks?.get(candidate) ?? null : null;
  const display = command ? target : targetFileName(target);
  const shimmer = active ? " work-step-shimmer" : "";
  const diffLines = entry.edit?.diff.split("\n") ?? [];
  return (
    <div className={`work-step tool ${entry.phase ?? "running"}${active ? " active" : ""}`}>
      <FluentGlyph icon={toolIcon(key)} size={16} filled={false} className="work-step-icon" />
      <div className="work-step-body">
        <div className="work-step-line">
          <span className={`work-step-verb${shimmer}`}>{toolVerb(key, active)}</span>
          {target ? (resolved && onOpenSpaceFile ? (
            <button type="button" className={`work-step-target file${shimmer}`} title={resolved} onClick={() => onOpenSpaceFile(resolved)}>
              {display}
            </button>
          ) : (
            <span className={`work-step-target${command ? " command" : ""}${shimmer}`} title={target}>{display}</span>
          )) : null}
          {failed ? <span className="work-step-status">Failed</span> : null}
        </div>
        {entry.edit && entry.toolName === "edit" && entry.phase === "complete" ? (
          <details className="work-step-edit">
            <summary>View edit{entry.edit.firstChangedLine ? ` at line ${entry.edit.firstChangedLine}` : ""}</summary>
            <p className="work-step-evidence-note">Captured when this edit completed.{entry.edit.truncated ? " This edit preview is incomplete." : ""}</p>
            <pre aria-label={`Captured edit to ${entry.edit.path}`}><code>{diffLines.map((line, index) => (
              <span className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : undefined} key={index}>{line}{index < diffLines.length - 1 ? "\n" : ""}</span>
            ))}</code></pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function TextStep({ entry, rendered }: { entry: RuntimePreviewEntry; rendered?: ReactNode }) {
  return (
    <div className={`work-step progress${isActivePhase(entry.phase) ? " active" : ""}`}>
      <FluentGlyph icon={Chat20Regular} size={16} filled={false} className="work-step-icon" />
      <div className="work-step-body work-step-progress">
        {rendered ?? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => { const safe = safeExternalHref(href); return safe ? <a href={safe} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>; },
          img: ({ alt }) => <span>{alt ?? ""}</span>,
        }}>{entry.text}</ReactMarkdown>}
      </div>
    </div>
  );
}

function ThoughtStep({
  entry,
  live,
  now,
  open,
  onToggle,
}: {
  entry: RuntimePreviewEntry;
  live: boolean;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const text = entry.text.trim();
  const silent = !text;
  const canOpen = !live && !silent;
  const showBody = !silent && (live || open);
  const elapsedMs = live && silent && entry.startedAt ? Math.max(0, now - entry.startedAt) : null;
  return (
    <div className={`work-step thinking${live ? " live active" : ""}${open ? " open" : ""}${silent ? " silent" : ""}`}>
      <FluentGlyph icon={Thinking20Regular} size={16} filled={false} className="work-step-icon" />
      <div className="work-step-body">
        {canOpen ? (
          <button type="button" className="work-step-line work-step-toggle" aria-expanded={open} onClick={onToggle}>
            <span className="work-step-verb">Thought</span>
            <span className="work-step-target">{thoughtPreview(text)}</span>
          </button>
        ) : (
          <div className="work-step-line">
            <span className={`work-step-verb${live ? " work-step-shimmer" : ""}`}>
              {live ? "Thinking…" : `Thought for ${formatDuration(entry.durationMs ?? 0)}`}
            </span>
            {elapsedMs !== null ? <span className="work-step-timer">{formatDuration(elapsedMs)}</span> : null}
          </div>
        )}
        {showBody ? (
          <div className={`work-step-thought${live ? " live" : ""}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, repairReasoningMarkdownArtifacts]}
              components={{
                a: ({ children }) => <>{children}</>,
                img: ({ alt }) => <span>{alt ?? ""}</span>,
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function useSpacePathLinks(
  steps: RuntimePreviewEntry[],
  spaceRoot: string | undefined,
  resolver: SpacePathLinkResolver | undefined,
  override: Map<string, string> | undefined,
): Map<string, string> | null {
  const candidates = toolPathCandidates(steps, spaceRoot);
  const key = candidates.join("\n");
  const [links, setLinks] = useState<Map<string, string> | null>(null);
  const skip = Boolean(override) || !resolver || !key;
  useEffect(() => {
    if (skip || !resolver) return;
    let cancelled = false;
    void resolver(key.split("\n"))
      .then((resolved) => {
        if (cancelled || !resolved.size) return;
        setLinks((current) => new Map([...(current ?? []), ...resolved]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, resolver, skip]);
  return override ?? links;
}

function toolPathCandidates(steps: RuntimePreviewEntry[], spaceRoot: string | undefined): string[] {
  const candidates = new Set<string>();
  for (const entry of steps) {
    if (entry.kind === "progress" || entry.kind === "command") {
      for (const path of collectSpacePathCandidates(entry.text)) candidates.add(path);
      continue;
    }
    if (entry.kind !== "tool" || commandTools.has(toolKey(entry)) || !entry.detail?.trim()) continue;
    const candidate = spaceRelativeToolPath(entry.detail, spaceRoot);
    if (candidate) candidates.add(candidate);
  }
  return [...candidates];
}

/**
 * Tool calls name files by absolute path more often than not. A path inside the
 * Folder becomes Folder-relative so it resolves and opens like a link in a
 * reply; anything outside stays plain text.
 */
export function spaceRelativeToolPath(detail: string, spaceRoot?: string): string | null {
  const value = detail.trim().replace(/\\/g, "/");
  if (!value) return null;
  const root = spaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && value.startsWith(`${root}/`)) return spacePathCandidate(value.slice(root.length + 1), { allowSpaces: true });
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:\//.test(value)) return null;
  return spacePathCandidate(value, { allowSpaces: true });
}

function targetFileName(target: string): string {
  const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.split("/").pop();
  return name || target;
}

const toolVerbs: Record<string, { running: string; done: string; one: string; many: string }> = {
  read: { running: "Reading", done: "Read", one: "Read a file", many: "Read files" },
  write: { running: "Writing", done: "Wrote", one: "Wrote a file", many: "Wrote files" },
  edit: { running: "Editing", done: "Edited", one: "Edited a file", many: "Edited files" },
  bash: { running: "Running", done: "Ran", one: "Ran a command", many: "Ran commands" },
  grep: { running: "Searching", done: "Searched", one: "Searched files", many: "Searched files" },
  search: { running: "Searching", done: "Searched", one: "Searched", many: "Searched" },
  find: { running: "Finding", done: "Found", one: "Found files", many: "Found files" },
  ls: { running: "Listing", done: "Listed", one: "Listed files", many: "Listed files" },
};
const commandTools = new Set(["bash"]);

function toolIcon(key: string): FluentIcon {
  switch (key) {
    case "read": return BookOpen20Regular;
    case "write": return DocumentAdd20Regular;
    case "edit": return DocumentEdit20Regular;
    case "bash": return WindowConsole20Regular;
    case "grep":
    case "search":
    case "find": return Search20Regular;
    case "ls": return Folder20Regular;
    default: return Wrench20Regular;
  }
}

function summaryIcon(steps: RuntimePreviewEntry[]): FluentIcon {
  const firstTool = steps.find((entry) => entry.kind === "tool");
  return firstTool ? toolIcon(toolKey(firstTool)) : Thinking20Regular;
}

export function toolKey(entry: RuntimePreviewEntry): string {
  return (entry.toolName?.trim() || entry.text
    .replace(/\s+(?:queued|running|updating|finished|failed)$/i, "")
    .trim() || "Assistant tool").toLowerCase();
}

function humanizeTool(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function toolVerb(key: string, active: boolean): string {
  const verbs = toolVerbs[key];
  if (verbs) return active ? verbs.running : verbs.done;
  return `${active ? "Using" : "Used"} ${humanizeTool(key)}`;
}

/** One finished tool call as a sentence fragment: "Read Character Map.md". */
export function toolStepLabel(entry: RuntimePreviewEntry): string {
  const key = toolKey(entry);
  const target = entry.detail?.trim() ?? "";
  const display = commandTools.has(key) ? target : targetFileName(target);
  return `${toolVerb(key, false)} ${display}`.trim();
}

/**
 * The folded line for a finished turn. Tool kinds appear in first-use order
 * and count what they touched; reasoning is only named when nothing else ran.
 */
export function workStepsSummary(entries: RuntimePreviewEntry[]): string {
  const tools = entries.filter((entry) => entry.kind === "tool");
  const thoughts = entries.filter((entry) => entry.kind === "thinking");
  if (!tools.length) {
    if (entries.some((entry) => entry.kind === "progress" || entry.kind === "command")) return "Worker updates";
    if (thoughts.some((entry) => entry.text.trim())) return "Thought it through";
    const total = thoughts.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
    return total > 0 ? `Thought for ${formatDuration(total)}` : "";
  }
  if (tools.length === 1 && tools[0]) return toolStepLabel(tools[0]);
  const order: string[] = [];
  const touched = new Map<string, Set<string>>();
  for (const tool of tools) {
    const key = toolKey(tool);
    let targets = touched.get(key);
    if (!targets) {
      targets = new Set();
      touched.set(key, targets);
      order.push(key);
    }
    targets.add(commandTools.has(key) ? tool.id : tool.detail?.trim() || tool.id);
  }
  return order.map((key, index) => {
    const verbs = toolVerbs[key];
    const count = touched.get(key)?.size ?? 1;
    const phrase = verbs ? (count > 1 ? verbs.many : verbs.one) : `Used ${humanizeTool(key)}`;
    return index === 0 ? phrase : `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
  }).join(", ");
}

/** The first sentence of a finished thought, without Markdown or code. */
export function thoughtPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?]["')\]]*)(?:\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 110 ? `${sentence.slice(0, 107).trimEnd()}…` : sentence;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function isActivePhase(phase: AgentActivityPhase | undefined): boolean {
  return phase === "queued" || phase === "running" || phase === "streaming";
}

/** Tool rows always show; a thinking row needs text, a live phase, or a recorded duration. */
function isVisibleStep(entry: RuntimePreviewEntry): boolean {
  if (entry.kind === "tool") return true;
  return Boolean(entry.text.trim()) || isActivePhase(entry.phase) || (entry.durationMs ?? 0) > 0;
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * CommonMark has already converted valid emphasis into `strong` nodes by the
 * time this runs. Only plain text nodes still contain stray model-authored
 * markers, so code and legitimate Markdown remain byte-for-byte untouched.
 */
function repairReasoningMarkdownArtifacts() {
  return (tree: MarkdownNode) => visitMarkdownNodes(tree, (node) => {
    if (node.type === "text" && typeof node.value === "string") {
      node.value = cleanReasoningTextNode(node.value);
    }
  });
}

export function cleanReasoningTextNode(value: string): string {
  return value.replace(/(^|[\s(—:])(?:\*\*|__)(?=[\p{L}\p{N}_])/gu, "$1");
}

function visitMarkdownNodes(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) visitMarkdownNodes(child, visit);
}
