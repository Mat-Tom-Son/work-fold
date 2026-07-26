import { Children, cloneElement, isValidElement, memo, useEffect, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Checkmark20Regular, Copy20Regular, Sparkle20Regular } from "@fluentui/react-icons";

import { safeExternalHref } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { resolveMessageImageSource } from "../../lib/message-images";
import { collectWorkspacePathCandidates, findWorkspacePathMentions, workspacePathCandidate } from "../../lib/workspace-path-links";
import type { AgentActivityEvent, ChatMessage, ChatMessageLanding, RuntimePreviewEntry } from "../../types";
import { FluentGlyph } from "../chrome/common";
import { AgentActivityRecap, RuntimeContextPreview } from "./activity";

export type WorkspacePathLinkResolver = (paths: string[]) => Promise<Map<string, string>>;

const assistantMessageWorkspacePathCache = new Map<string, {
  content: string;
  resolved: Map<string, string>;
  promise: Promise<Map<string, string>> | null;
}>();

interface ChatMessageRowProps {
  message: ChatMessage;
  copied: boolean;
  showLanding: boolean;
  suppressEnterAnimation: boolean;
  showRecap: boolean;
  showRuntimePreview: boolean;
  runtimePreviews: RuntimePreviewEntry[];
  activityRecap: AgentActivityEvent[];
  workspaceId: string;
  onOpenWorkspaceFile?: (path: string) => void;
  resolveWorkspacePathLinks?: WorkspacePathLinkResolver;
  onCopyMessage: (messageId: string, content: string) => void | Promise<void>;
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  copied,
  showLanding,
  suppressEnterAnimation,
  showRecap,
  showRuntimePreview,
  runtimePreviews,
  activityRecap,
  workspaceId,
  onOpenWorkspaceFile,
  resolveWorkspacePathLinks,
  onCopyMessage,
}: ChatMessageRowProps) {
  const [workspaceLinkVersion, setWorkspaceLinkVersion] = useState(0);
  const workspaceLinkCacheKey = `${workspaceId}:${message.id}`;
  const cachedWorkspaceLinks = assistantMessageWorkspacePathCache.get(workspaceLinkCacheKey);
  const workspaceLinks = cachedWorkspaceLinks?.content === message.content ? cachedWorkspaceLinks.resolved : null;
  const messageTime = message.createdAt ? formatDateTime(message.createdAt) : "";

  useEffect(() => {
    if (message.role !== "assistant" || !resolveWorkspacePathLinks || !onOpenWorkspaceFile) return;
    const candidates = collectWorkspacePathCandidates(message.content);
    if (!candidates.length) return;
    let cancelled = false;
    void resolveMessageWorkspaceLinks(workspaceLinkCacheKey, message.content, candidates, resolveWorkspacePathLinks)
      .then(() => {
        if (!cancelled) setWorkspaceLinkVersion((current) => current + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [message.content, message.id, message.role, onOpenWorkspaceFile, resolveWorkspacePathLinks, workspaceLinkCacheKey]);

  return (
    <article className={`message ${message.role}${suppressEnterAnimation ? " settled" : ""}`}>
      {showRuntimePreview ? <RuntimeContextPreview entries={runtimePreviews} /> : null}
      <MarkdownMessage
        content={message.content}
        workspaceLinks={message.role === "assistant" ? workspaceLinks : null}
        onOpenWorkspaceFile={message.role === "assistant" ? onOpenWorkspaceFile : undefined}
        key={workspaceLinkVersion}
      />
      {message.role === "assistant" && showLanding && message.landing ? <TurnLanding landing={message.landing} /> : null}
      {showRecap ? <AgentActivityRecap events={activityRecap} /> : null}
      <footer className="message-footer">
        <span className="message-footer-meta">
          {message.createdAt && messageTime ? (
            <time className="message-time" dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
              {messageTime}
            </time>
          ) : null}
          <MessageActions
            copied={copied}
            onCopy={() => void onCopyMessage(message.id, message.content)}
          />
        </span>
      </footer>
    </article>
  );
}, areChatMessageRowPropsEqual);

function areChatMessageRowPropsEqual(previous: ChatMessageRowProps, next: ChatMessageRowProps): boolean {
  const previousMessage = previous.message;
  const nextMessage = next.message;
  const sameMessage = previousMessage === nextMessage || (
    previousMessage.id === nextMessage.id
    && previousMessage.role === nextMessage.role
    && previousMessage.content === nextMessage.content
    && previousMessage.createdAt === nextMessage.createdAt
    && previousMessage.kind === nextMessage.kind
    && previousMessage.landing === nextMessage.landing
  );
  const sameRuntimePreview = !previous.showRuntimePreview && !next.showRuntimePreview
    ? true
    : previous.runtimePreviews === next.runtimePreviews;
  const sameActivityRecap = !previous.showRecap && !next.showRecap
    ? true
    : previous.activityRecap === next.activityRecap;
  return sameMessage
    && previous.copied === next.copied
    && previous.showLanding === next.showLanding
    && previous.suppressEnterAnimation === next.suppressEnterAnimation
    && previous.showRecap === next.showRecap
    && previous.showRuntimePreview === next.showRuntimePreview
    && sameRuntimePreview
    && sameActivityRecap
    && previous.workspaceId === next.workspaceId
    && previous.onOpenWorkspaceFile === next.onOpenWorkspaceFile
    && previous.resolveWorkspacePathLinks === next.resolveWorkspacePathLinks
    && previous.onCopyMessage === next.onCopyMessage;
}

export function MessageActions({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <div className="message-actions">
      <button
        className="message-copy-button"
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied message" : "Copy message"}
        title={copied ? "Copied" : "Copy message"}
      >
        {copied ? <FluentGlyph icon={Checkmark20Regular} size={14} /> : <FluentGlyph icon={Copy20Regular} size={14} />}
      </button>
    </div>
  );
}

export function TurnLanding({ landing }: { landing: ChatMessageLanding }) {
  return (
    <section className="turn-landing" aria-label="Turn summary">
      <div className="turn-landing-heading">
        <span>
          <FluentGlyph icon={Sparkle20Regular} size={15} />
          Turn summary
        </span>
      </div>
      <p>{landing.summary}</p>
      {landing.nextActions.length ? (
        <ul>
          {landing.nextActions.map((action) => <li key={action}>{action}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

export function MarkdownMessage({
  content,
  workspaceLinks = null,
  onOpenWorkspaceFile,
}: {
  content: string;
  workspaceLinks?: Map<string, string> | null;
  onOpenWorkspaceFile?: (path: string) => void;
}) {
  const linkChildren = (children: ReactNode) => linkWorkspacePathText(children, workspaceLinks, onOpenWorkspaceFile);
  return (
    <div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{linkChildren(children)}</p>,
          li: ({ children }) => <li>{linkChildren(children)}</li>,
          td: ({ children }) => <td>{linkChildren(children)}</td>,
          th: ({ children }) => <th>{linkChildren(children)}</th>,
          table: ({ children }) => <div className="message-table-scroll"><table>{children}</table></div>,
          pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
          code: ({ children, className }) => {
            const text = reactNodeText(children);
            if (className || text.includes("\n")) return <code className={className}>{children}</code>;
            const normalizedPath = workspacePathCandidate(text, { allowSpaces: true });
            const resolvedPath = normalizedPath ? workspaceLinks?.get(normalizedPath) ?? null : null;
            if (!resolvedPath || !onOpenWorkspaceFile) return <code>{children}</code>;
            return (
              <button
                className="workspace-file-link workspace-file-link-code"
                type="button"
                onClick={() => onOpenWorkspaceFile(resolvedPath)}
                title={resolvedPath}
              >
                {text}
              </button>
            );
          },
          a: ({ href, children }) => {
            const workspacePath = workspacePathCandidate(href ?? "", { allowSpaces: true });
            const resolvedPath = workspacePath ? workspaceLinks?.get(workspacePath) ?? null : null;
            if (resolvedPath && onOpenWorkspaceFile) {
              return <button className="workspace-file-link" type="button" onClick={() => onOpenWorkspaceFile(resolvedPath)} title={resolvedPath}>{children}</button>;
            }
            const safeHref = safeExternalHref(href);
            return safeHref ? <a className="message-external-link" href={safeHref} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
          },
          img: ({ src, alt }) => {
            const workspacePath = workspacePathCandidate(src ?? "", { allowSpaces: true });
            const resolvedPath = workspacePath ? workspaceLinks?.get(workspacePath) ?? null : null;
            if (resolvedPath && onOpenWorkspaceFile) {
              return <button className="message-image-file" type="button" onClick={() => onOpenWorkspaceFile(resolvedPath)} title={resolvedPath}>{alt || resolvedPath.split("/").pop() || "Open image"}</button>;
            }
            const resolution = resolveMessageImageSource(src, window.location.href);
            if (resolution.kind === "embed") return <img className="message-image" src={resolution.src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
            if (resolution.kind === "external-link") {
              return <a className="message-image-external" href={resolution.href} target="_blank" rel="noreferrer">{alt ? `Open image: ${alt}` : "Open external image"}</a>;
            }
            return <span className="message-image-unavailable">{alt ? `${alt} (image unavailable)` : "Image unavailable"}</span>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = reactNodeText(children).replace(/\n$/, "");
  const codeElement = Children.toArray(children).find((child) => isValidElement(child)) as ReactElement<{ className?: string }> | undefined;
  const language = codeElement?.props.className?.match(/(?:^|\s)language-([\w-]+)/)?.[1] ?? "";
  const label = language ? language.toLocaleUpperCase() : "Code";

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="message-code-block">
      <div className="message-code-toolbar">
        <span>{label}</span>
        <button type="button" onClick={() => void copyCode()} aria-label={copied ? "Copied code" : "Copy code"} title={copied ? "Copied" : "Copy code"}>
          <FluentGlyph icon={copied ? Checkmark20Regular : Copy20Regular} size={13} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

async function resolveMessageWorkspaceLinks(
  cacheKey: string,
  content: string,
  candidates: string[],
  resolver: WorkspacePathLinkResolver,
): Promise<Map<string, string>> {
  const cached = assistantMessageWorkspacePathCache.get(cacheKey);
  if (cached?.content === content) {
    if (cached.promise) return cached.promise;
    return cached.resolved;
  }
  const promise = resolver(candidates)
    .then((resolved) => {
      // Empty results are not cached: the tree (fixture mode) or the API may simply
      // not be ready yet, and a poisoned empty entry would never be retried.
      if (resolved.size) assistantMessageWorkspacePathCache.set(cacheKey, { content, resolved, promise: null });
      else assistantMessageWorkspacePathCache.delete(cacheKey);
      return resolved;
    })
    .catch(() => {
      assistantMessageWorkspacePathCache.delete(cacheKey);
      return new Map<string, string>();
    });
  assistantMessageWorkspacePathCache.set(cacheKey, { content, resolved: new Map(), promise });
  return promise;
}

function linkWorkspacePathText(
  children: ReactNode,
  workspaceLinks: Map<string, string> | null | undefined,
  onOpenWorkspaceFile: ((path: string) => void) | undefined,
): ReactNode {
  if (!workspaceLinks?.size || !onOpenWorkspaceFile) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") return linkWorkspacePathString(child, workspaceLinks, onOpenWorkspaceFile);
    if (!isValidElement(child) || child.type === "a" || child.type === "code" || child.type === "button") return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    if (element.props.children === undefined) return child;
    return cloneElement(element, undefined, linkWorkspacePathText(element.props.children, workspaceLinks, onOpenWorkspaceFile));
  });
}

function linkWorkspacePathString(
  text: string,
  workspaceLinks: Map<string, string>,
  onOpenWorkspaceFile: (path: string) => void,
): ReactNode {
  const mentions = findWorkspacePathMentions(text).filter((mention) => workspaceLinks.has(mention.normalizedPath));
  if (!mentions.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention, index) => {
    const resolvedPath = workspaceLinks.get(mention.normalizedPath);
    if (!resolvedPath) return;
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(
      <button
        className="workspace-file-link"
        type="button"
        onClick={() => onOpenWorkspaceFile(resolvedPath)}
        title={resolvedPath}
        key={`${mention.start}:${mention.normalizedPath}:${index}`}
      >
        {mention.text}
      </button>,
    );
    cursor = mention.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function reactNodeText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement(child)) return "";
    return reactNodeText((child as ReactElement<{ children?: ReactNode }>).props.children);
  }).join("");
}

export async function copyMarkdownToClipboard(content: string): Promise<void> {
  const html = markdownToClipboardHtml(content);
  if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([content], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // Fall through to plain text for clipboard hosts that block rich writes.
    }
  }
  await navigator.clipboard.writeText(content);
}

function markdownToClipboardHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/).filter((block) => block.trim());
  const html = blocks.map((block) => {
    const trimmed = block.trim();
    const codeFence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (codeFence) return `<pre><code>${escapeHtml(codeFence[1] ?? "")}</code></pre>`;
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(3, heading[1]?.length ?? 1);
      return `<h${level}>${inlineMarkdownToHtml(heading[2] ?? "")}</h${level}>`;
    }
    const lines = trimmed.split(/\r?\n/);
    if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
      return `<ul>${lines.map((line) => `<li>${inlineMarkdownToHtml(line.trim().replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    if (lines.every((line) => /^\d+[.)]\s+/.test(line.trim()))) {
      return `<ol>${lines.map((line) => `<li>${inlineMarkdownToHtml(line.trim().replace(/^\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    }
    return `<p>${inlineMarkdownToHtml(lines.join("\n"))}</p>`;
  }).join("");
  return `<div>${html}</div>`;
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
