import { Children, cloneElement, isValidElement, memo, useEffect, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Checkmark20Regular, Copy20Regular, Sparkle20Regular } from "@fluentui/react-icons";

import { safeExternalHref } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { resolveMessageImageSource } from "../../lib/message-images";
import { collectSpacePathCandidates, findSpacePathMentions, spacePathCandidate } from "../../lib/space-path-links";
import type { AgentActivityEvent, ChatMessage, ChatMessageLanding, RuntimePreviewEntry } from "../../types";
import { FluentGlyph } from "../chrome/common";
import { AgentActivityRecap, RuntimeContextPreview } from "./activity";

export type SpacePathLinkResolver = (paths: string[]) => Promise<Map<string, string>>;

const assistantMessageSpacePathCache = new Map<string, {
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
  spaceId: string;
  onOpenSpaceFile?: (path: string) => void;
  resolveSpacePathLinks?: SpacePathLinkResolver;
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
  spaceId,
  onOpenSpaceFile,
  resolveSpacePathLinks,
  onCopyMessage,
}: ChatMessageRowProps) {
  const [spaceLinkVersion, setSpaceLinkVersion] = useState(0);
  const spaceLinkCacheKey = `${spaceId}:${message.id}`;
  const cachedSpaceLinks = assistantMessageSpacePathCache.get(spaceLinkCacheKey);
  const spaceLinks = cachedSpaceLinks?.content === message.content ? cachedSpaceLinks.resolved : null;
  const messageTime = message.createdAt ? formatDateTime(message.createdAt) : "";

  useEffect(() => {
    if (message.role !== "assistant" || !resolveSpacePathLinks || !onOpenSpaceFile) return;
    const candidates = collectSpacePathCandidates(message.content);
    if (!candidates.length) return;
    let cancelled = false;
    void resolveMessageSpaceLinks(spaceLinkCacheKey, message.content, candidates, resolveSpacePathLinks)
      .then(() => {
        if (!cancelled) setSpaceLinkVersion((current) => current + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [message.content, message.id, message.role, onOpenSpaceFile, resolveSpacePathLinks, spaceLinkCacheKey]);

  return (
    <article className={`message ${message.role}${suppressEnterAnimation ? " settled" : ""}`}>
      {showRuntimePreview ? <RuntimeContextPreview entries={runtimePreviews} /> : null}
      <MarkdownMessage
        content={message.content}
        spaceLinks={message.role === "assistant" ? spaceLinks : null}
        onOpenSpaceFile={message.role === "assistant" ? onOpenSpaceFile : undefined}
        key={spaceLinkVersion}
      />
      {message.role === "assistant" && showLanding && message.landing ? <TurnLanding landing={message.landing} /> : null}
      {message.role === "assistant" && message.interruption ? <InterruptedTurn interruption={message.interruption} /> : null}
      {message.role === "assistant" && message.interruption?.activities.length ? (
        <AgentActivityRecap
          events={message.interruption.activities.map((activity, index) => ({
            ...activity,
            id: `interrupted-${message.id}-${index}`,
          }))}
        />
      ) : showRecap ? <AgentActivityRecap events={activityRecap} /> : null}
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
    && previousMessage.interruption === nextMessage.interruption
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
    && previous.spaceId === next.spaceId
    && previous.onOpenSpaceFile === next.onOpenSpaceFile
    && previous.resolveSpacePathLinks === next.resolveSpacePathLinks
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

function InterruptedTurn({ interruption }: { interruption: NonNullable<ChatMessage["interruption"]> }) {
  const retryText = interruption.retryAttempts > 0
    ? `${interruption.retryAttempts} automatic ${interruption.retryAttempts === 1 ? "retry" : "retries"} were attempted.`
    : "The provider did not identify this as safely retryable.";
  return (
    <section className="turn-interruption" role="status" aria-label="Interrupted Assistant response">
      <strong>Response interrupted</strong>
      <span>work-fold preserved the partial response. {retryText}</span>
    </section>
  );
}

export function MarkdownMessage({
  content,
  spaceLinks = null,
  onOpenSpaceFile,
}: {
  content: string;
  spaceLinks?: Map<string, string> | null;
  onOpenSpaceFile?: (path: string) => void;
}) {
  const linkChildren = (children: ReactNode) => linkSpacePathText(children, spaceLinks, onOpenSpaceFile);
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
            const normalizedPath = spacePathCandidate(text, { allowSpaces: true });
            const resolvedPath = normalizedPath ? spaceLinks?.get(normalizedPath) ?? null : null;
            if (!resolvedPath || !onOpenSpaceFile) return <code>{children}</code>;
            return (
              <button
                className="space-file-link space-file-link-code"
                type="button"
                onClick={() => onOpenSpaceFile(resolvedPath)}
                title={resolvedPath}
              >
                {text}
              </button>
            );
          },
          a: ({ href, children }) => {
            const spacePath = spacePathCandidate(href ?? "", { allowSpaces: true });
            const resolvedPath = spacePath ? spaceLinks?.get(spacePath) ?? null : null;
            if (resolvedPath && onOpenSpaceFile) {
              return <button className="space-file-link" type="button" onClick={() => onOpenSpaceFile(resolvedPath)} title={resolvedPath}>{children}</button>;
            }
            const safeHref = safeExternalHref(href);
            return safeHref ? <a className="message-external-link" href={safeHref} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
          },
          img: ({ src, alt }) => {
            const spacePath = spacePathCandidate(src ?? "", { allowSpaces: true });
            const resolvedPath = spacePath ? spaceLinks?.get(spacePath) ?? null : null;
            if (resolvedPath && onOpenSpaceFile) {
              return <button className="message-image-file" type="button" onClick={() => onOpenSpaceFile(resolvedPath)} title={resolvedPath}>{alt || resolvedPath.split("/").pop() || "Open image"}</button>;
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

async function resolveMessageSpaceLinks(
  cacheKey: string,
  content: string,
  candidates: string[],
  resolver: SpacePathLinkResolver,
): Promise<Map<string, string>> {
  const cached = assistantMessageSpacePathCache.get(cacheKey);
  if (cached?.content === content) {
    if (cached.promise) return cached.promise;
    return cached.resolved;
  }
  const promise = resolver(candidates)
    .then((resolved) => {
      // Empty results are not cached: the tree (fixture mode) or the API may simply
      // not be ready yet, and a poisoned empty entry would never be retried.
      if (resolved.size) assistantMessageSpacePathCache.set(cacheKey, { content, resolved, promise: null });
      else assistantMessageSpacePathCache.delete(cacheKey);
      return resolved;
    })
    .catch(() => {
      assistantMessageSpacePathCache.delete(cacheKey);
      return new Map<string, string>();
    });
  assistantMessageSpacePathCache.set(cacheKey, { content, resolved: new Map(), promise });
  return promise;
}

function linkSpacePathText(
  children: ReactNode,
  spaceLinks: Map<string, string> | null | undefined,
  onOpenSpaceFile: ((path: string) => void) | undefined,
): ReactNode {
  if (!spaceLinks?.size || !onOpenSpaceFile) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") return linkSpacePathString(child, spaceLinks, onOpenSpaceFile);
    if (!isValidElement(child) || child.type === "a" || child.type === "code" || child.type === "button") return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    if (element.props.children === undefined) return child;
    return cloneElement(element, undefined, linkSpacePathText(element.props.children, spaceLinks, onOpenSpaceFile));
  });
}

function linkSpacePathString(
  text: string,
  spaceLinks: Map<string, string>,
  onOpenSpaceFile: (path: string) => void,
): ReactNode {
  const mentions = findSpacePathMentions(text).filter((mention) => spaceLinks.has(mention.normalizedPath));
  if (!mentions.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention, index) => {
    const resolvedPath = spaceLinks.get(mention.normalizedPath);
    if (!resolvedPath) return;
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(
      <button
        className="space-file-link"
        type="button"
        onClick={() => onOpenSpaceFile(resolvedPath)}
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
