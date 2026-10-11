import { Children, cloneElement, isValidElement, memo, useEffect, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Checkmark20Regular, Copy20Regular, Sparkle20Regular } from "@fluentui/react-icons";

import { safeExternalHref } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { formatDateTime } from "../../lib/format";
import { resolveMessageImageSource } from "../../lib/message-images";
import { assistantTurnView, savedWorkTrailPreviews } from "../../lib/chat-work-trail";
import { collectWorkFolderPathCandidates, findWorkFolderPathMentions, workFolderPathCandidate } from "../../lib/work-folder-path-links";
import type { ChatMessage, ChatMessageLanding, RuntimePreviewEntry } from "../../types";
import { FluentGlyph } from "../chrome/common";
import { RuntimeContextPreview, type WorkFolderPathLinkResolver } from "./activity";

export type { WorkFolderPathLinkResolver };

const assistantMessageWorkFolderPathCache = new Map<string, {
  content: string;
  resolved: Map<string, string>;
  promise: Promise<Map<string, string>> | null;
}>();

interface ChatMessageRowProps {
  message: ChatMessage;
  copied: boolean;
  showLanding: boolean;
  suppressEnterAnimation: boolean;
  showRuntimePreview: boolean;
  runtimePreviews: RuntimePreviewEntry[];
  workFolderId: string;
  workFolderRoot: string;
  onOpenWorkFolderFile?: (path: string) => void;
  resolveWorkFolderPathLinks?: WorkFolderPathLinkResolver;
  onCopyMessage: (messageId: string, content: string) => void | Promise<void>;
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  copied,
  showLanding,
  suppressEnterAnimation,
  showRuntimePreview,
  runtimePreviews,
  workFolderId,
  workFolderRoot,
  onOpenWorkFolderFile,
  resolveWorkFolderPathLinks,
  onCopyMessage,
}: ChatMessageRowProps) {
  const [workFolderLinkVersion, setWorkFolderLinkVersion] = useState(0);
  const workFolderLinkCacheKey = `${workFolderId}:${message.id}`;
  const cachedWorkFolderLinks = assistantMessageWorkFolderPathCache.get(workFolderLinkCacheKey);
  const workFolderLinks = cachedWorkFolderLinks?.content === message.content ? cachedWorkFolderLinks.resolved : null;
  const messageTime = message.createdAt ? formatDateTime(message.createdAt) : "";
  const savedRuntimePreviews = savedWorkTrailPreviews(message);
  const visibleRuntimePreviews = showRuntimePreview && runtimePreviews.length
    ? runtimePreviews
    : savedRuntimePreviews;
  const turnView = assistantTurnView(message.content, message.role === "assistant" ? message.assistantPresentation : undefined, visibleRuntimePreviews);

  useEffect(() => {
    if (message.role !== "assistant" || !resolveWorkFolderPathLinks || !onOpenWorkFolderFile) return;
    const candidates = collectWorkFolderPathCandidates(message.content);
    if (!candidates.length) return;
    let cancelled = false;
    void resolveMessageWorkFolderLinks(workFolderLinkCacheKey, message.content, candidates, resolveWorkFolderPathLinks)
      .then(() => {
        if (!cancelled) setWorkFolderLinkVersion((current) => current + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [message.content, message.id, message.role, onOpenWorkFolderFile, resolveWorkFolderPathLinks, workFolderLinkCacheKey]);

  if (message.kind === "assistant_continuation") return <p className="work-continuation" role="note">Continuing with the results from delegated work.</p>;

  return (
    <article className={`message ${message.role}${suppressEnterAnimation ? " settled" : ""}`}>
      <div className="message-surface">
        {turnView.steps.length ? (
          <RuntimeContextPreview
            entries={turnView.steps}
            workFolderRoot={workFolderRoot}
            onOpenWorkFolderFile={message.role === "assistant" ? onOpenWorkFolderFile : undefined}
            resolveWorkFolderPathLinks={message.role === "assistant" ? resolveWorkFolderPathLinks : undefined}
            renderText={(content, links) => <MarkdownMessage content={content} workFolderLinks={links} onOpenWorkFolderFile={onOpenWorkFolderFile} />}
          />
        ) : null}
        {turnView.answer ? <MarkdownMessage
          content={turnView.answer}
          workFolderLinks={message.role === "assistant" ? workFolderLinks : null}
          onOpenWorkFolderFile={message.role === "assistant" ? onOpenWorkFolderFile : undefined}
          key={workFolderLinkVersion}
        /> : null}
        {message.role === "assistant" && showLanding && message.landing ? <TurnLanding landing={message.landing} /> : null}
        {message.role === "assistant" && message.interruption ? <InterruptedTurn interruption={message.interruption} /> : null}
      </div>
      <footer className="message-footer">
        <span className="message-footer-meta">
          <MessageActions
            copied={copied}
            onCopy={() => void onCopyMessage(message.id, message.content)}
          />
          {message.createdAt && messageTime ? (
            <time className="message-time" dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
              {messageTime}
            </time>
          ) : null}
          {message.role === "user" && message.delivery === "steer" ? (
            <span className="message-delivery" title="Sent while the Worker was working; it applied after the step in progress.">Sent mid-turn</span>
          ) : null}
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
    && previousMessage.workTrail === nextMessage.workTrail
    && previousMessage.assistantPresentation === nextMessage.assistantPresentation
    && previousMessage.interruption === nextMessage.interruption
    && previousMessage.delivery === nextMessage.delivery
  );
  const sameRuntimePreview = !previous.showRuntimePreview && !next.showRuntimePreview
    ? true
    : previous.runtimePreviews === next.runtimePreviews;
  return sameMessage
    && previous.copied === next.copied
    && previous.showLanding === next.showLanding
    && previous.suppressEnterAnimation === next.suppressEnterAnimation
    && previous.showRuntimePreview === next.showRuntimePreview
    && sameRuntimePreview
    && previous.workFolderId === next.workFolderId
    && previous.workFolderRoot === next.workFolderRoot
    && previous.onOpenWorkFolderFile === next.onOpenWorkFolderFile
    && previous.resolveWorkFolderPathLinks === next.resolveWorkFolderPathLinks
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
  if (interruption.reason === "setup_error") {
    return (
      <section className="turn-interruption" role="status" aria-label="Worker setup needed">
        <strong>Worker setup needed</strong>
        <span>Open Settings → AI Models to choose a provider and model, then try again.</span>
      </section>
    );
  }
  if (interruption.reason === "assistant_error") {
    return (
      <section className="turn-interruption" role="status" aria-label="Failed Worker response">
        <strong>Request stopped</strong>
        <span>work-fold saved this result with your Chat. You can try again whenever you’re ready.</span>
      </section>
    );
  }
  if (interruption.reason === "cancelled") {
    return (
      <section className="turn-interruption" role="status" aria-label="Stopped Worker response">
        <strong>Response stopped</strong>
        <span>work-fold saved the response produced before you stopped the Worker.</span>
      </section>
    );
  }
  if (interruption.reason === "app_interrupted") {
    return (
      <section className="turn-interruption" role="status" aria-label="Worker response interrupted by app close">
        <strong>App interrupted this response</strong>
        <span>work-fold saved the partial response and did not rerun the turn because tools may already have changed something.</span>
      </section>
    );
  }
  const retryText = interruption.retryAttempts > 0
    ? `${interruption.retryAttempts} automatic ${interruption.retryAttempts === 1 ? "retry" : "retries"} were attempted.`
    : "The provider did not identify this as safely retryable.";
  return (
    <section className="turn-interruption" role="status" aria-label="Interrupted Worker response">
      <strong>Response interrupted</strong>
      <span>work-fold preserved the partial response. {retryText}</span>
    </section>
  );
}

export function MarkdownMessage({
  content,
  workFolderLinks = null,
  onOpenWorkFolderFile,
}: {
  content: string;
  workFolderLinks?: Map<string, string> | null;
  onOpenWorkFolderFile?: (path: string) => void;
}) {
  const linkChildren = (children: ReactNode) => linkWorkFolderPathText(children, workFolderLinks, onOpenWorkFolderFile);
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
            const normalizedPath = workFolderPathCandidate(text, { allowWorkFolders: true });
            const resolvedPath = normalizedPath ? workFolderLinks?.get(normalizedPath) ?? null : null;
            if (!resolvedPath || !onOpenWorkFolderFile) return <code>{children}</code>;
            return (
              <button
                className="work-folder-file-link work-folder-file-link-code"
                type="button"
                onClick={() => onOpenWorkFolderFile(resolvedPath)}
                title={resolvedPath}
              >
                {text}
              </button>
            );
          },
          a: ({ href, children }) => {
            const workFolderPath = workFolderPathCandidate(href ?? "", { allowWorkFolders: true });
            const resolvedPath = workFolderPath ? workFolderLinks?.get(workFolderPath) ?? null : null;
            if (resolvedPath && onOpenWorkFolderFile) {
              return <button className="work-folder-file-link" type="button" onClick={() => onOpenWorkFolderFile(resolvedPath)} title={resolvedPath}>{children}</button>;
            }
            const safeHref = safeExternalHref(href);
            return safeHref ? <a className="message-external-link" href={safeHref} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
          },
          img: ({ src, alt }) => {
            const workFolderPath = workFolderPathCandidate(src ?? "", { allowWorkFolders: true });
            const resolvedPath = workFolderPath ? workFolderLinks?.get(workFolderPath) ?? null : null;
            if (resolvedPath && onOpenWorkFolderFile) {
              return <button className="message-image-file" type="button" onClick={() => onOpenWorkFolderFile(resolvedPath)} title={resolvedPath}>{alt || resolvedPath.split("/").pop() || "Open image"}</button>;
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
      await copyToClipboard({ text });
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

async function resolveMessageWorkFolderLinks(
  cacheKey: string,
  content: string,
  candidates: string[],
  resolver: WorkFolderPathLinkResolver,
): Promise<Map<string, string>> {
  const cached = assistantMessageWorkFolderPathCache.get(cacheKey);
  if (cached?.content === content) {
    if (cached.promise) return cached.promise;
    return cached.resolved;
  }
  const promise = resolver(candidates)
    .then((resolved) => {
      // Empty results are not cached: the tree (fixture mode) or the API may simply
      // not be ready yet, and a poisoned empty entry would never be retried.
      if (resolved.size) assistantMessageWorkFolderPathCache.set(cacheKey, { content, resolved, promise: null });
      else assistantMessageWorkFolderPathCache.delete(cacheKey);
      return resolved;
    })
    .catch(() => {
      assistantMessageWorkFolderPathCache.delete(cacheKey);
      return new Map<string, string>();
    });
  assistantMessageWorkFolderPathCache.set(cacheKey, { content, resolved: new Map(), promise });
  return promise;
}

function linkWorkFolderPathText(
  children: ReactNode,
  workFolderLinks: Map<string, string> | null | undefined,
  onOpenWorkFolderFile: ((path: string) => void) | undefined,
): ReactNode {
  if (!workFolderLinks?.size || !onOpenWorkFolderFile) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") return linkWorkFolderPathString(child, workFolderLinks, onOpenWorkFolderFile);
    if (!isValidElement(child) || child.type === "a" || child.type === "code" || child.type === "button") return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    if (element.props.children === undefined) return child;
    return cloneElement(element, undefined, linkWorkFolderPathText(element.props.children, workFolderLinks, onOpenWorkFolderFile));
  });
}

function linkWorkFolderPathString(
  text: string,
  workFolderLinks: Map<string, string>,
  onOpenWorkFolderFile: (path: string) => void,
): ReactNode {
  const mentions = findWorkFolderPathMentions(text).filter((mention) => workFolderLinks.has(mention.normalizedPath));
  if (!mentions.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention, index) => {
    const resolvedPath = workFolderLinks.get(mention.normalizedPath);
    if (!resolvedPath) return;
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(
      <button
        className="work-folder-file-link"
        type="button"
        onClick={() => onOpenWorkFolderFile(resolvedPath)}
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
  await copyToClipboard({ text: content, html: markdownToClipboardHtml(content) });
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
