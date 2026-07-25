import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Archive, Check, ChevronLeft, Clock3, Loader2, Pencil, RotateCcw } from "lucide-react";

import { chatDisplayTitle } from "../../lib/format";
import {
  chatSnoozeTimeLabel,
  conversationLifecycleView,
  resolveChatSnoozePresets,
} from "../../lib/chat-lifecycle";
import { errorText } from "../../lib/api";
import type { ChatActionsState, ConversationSummary, WorkspaceSummary } from "../../types";

type ActionView = "menu" | "rename" | "snooze";

export function ChatActionsPopover({
  state,
  onRename,
  onLifecycle,
  onClose,
}: {
  state: ChatActionsState;
  onRename: (workspace: WorkspaceSummary, conversation: ConversationSummary, title: string) => Promise<void>;
  onLifecycle: (
    workspace: WorkspaceSummary,
    conversation: ConversationSummary,
    patch: { archived?: boolean; snoozedUntil?: string | null },
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [view, setView] = useState<ActionView>("menu");
  const [title, setTitle] = useState(chatDisplayTitle({ serverTitle: state.conversation.title }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const lifecycleView = conversationLifecycleView(state.conversation);
  const snoozePresets = useMemo(() => resolveChatSnoozePresets(new Date()), [state.conversation.id]);
  const position = popoverPosition(state.x, state.y);

  useEffect(() => {
    setView("menu");
    setTitle(chatDisplayTitle({ serverTitle: state.conversation.title }));
    setError(null);
    setBusy(false);
  }, [state.conversation.id, state.conversation.title]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      if (view === "rename") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        firstActionRef.current?.focus();
      }
    });
  }, [view, state.conversation.id]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (view === "menu") closeAndRestore();
      else setView("menu");
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [view, onClose, state.returnFocusTarget]);

  async function handleRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextTitle = title.replace(/\s+/g, " ").trim();
    if (!nextTitle) {
      setError("Enter a Chat title.");
      return;
    }
    await runAction(() => onRename(state.workspace, state.conversation, nextTitle));
  }

  async function handleLifecycle(patch: { archived?: boolean; snoozedUntil?: string | null }): Promise<void> {
    await runAction(() => onLifecycle(state.workspace, state.conversation, patch));
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      closeAndRestore();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  }

  function closeAndRestore(): void {
    const returnFocusTarget = state.returnFocusTarget;
    onClose();
    window.requestAnimationFrame(() => {
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
    });
  }

  return (
    <div
      ref={popoverRef}
      className="chat-rename-popover chat-actions-popover"
      style={position}
      role="dialog"
      aria-label={`Chat actions for ${state.conversation.title}`}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {view === "menu" ? (
        <div className="chat-actions-menu">
          <div className="chat-actions-heading">
            <strong>{state.conversation.title}</strong>
            <span>{state.workspace.name}</span>
          </div>
          <button ref={firstActionRef} type="button" disabled={busy} onClick={() => setView("rename")}>
            <Pencil size={14} />
            <span><strong>Rename</strong><small>Change the Chat title</small></span>
          </button>
          {lifecycleView === "snoozed" ? (
            <button type="button" disabled={busy} onClick={() => void handleLifecycle({ snoozedUntil: null })}>
              <RotateCcw size={14} />
              <span><strong>Resume now</strong><small>Return this Chat to Active</small></span>
            </button>
          ) : lifecycleView !== "archived" ? (
            <button type="button" disabled={busy} onClick={() => setView("snooze")}>
              <Clock3 size={14} />
              <span><strong>Snooze</strong><small>Hide it until later</small></span>
            </button>
          ) : null}
          <button
            className={lifecycleView === "archived" ? "" : "danger"}
            type="button"
            disabled={busy}
            onClick={() => void handleLifecycle({ archived: lifecycleView !== "archived" })}
          >
            {lifecycleView === "archived" ? <RotateCcw size={14} /> : <Archive size={14} />}
            <span>
              <strong>{lifecycleView === "archived" ? "Restore to Active" : "Archive"}</strong>
              <small>{lifecycleView === "archived" ? "Return this Chat to the main list" : "Move it out of active work"}</small>
            </span>
          </button>
        </div>
      ) : null}

      {view === "rename" ? (
        <form onSubmit={(event) => void handleRename(event)}>
          <button className="chat-actions-back" type="button" disabled={busy} onClick={() => setView("menu")}>
            <ChevronLeft size={14} />Actions
          </button>
          <label>
            <span>Rename Chat</span>
            <input
              ref={inputRef}
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="chat-rename-actions">
            <button type="button" disabled={busy} onClick={() => setView("menu")}>Cancel</button>
            <button className="primary" type="submit" disabled={busy || !title.trim()}>
              {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              Save
            </button>
          </div>
        </form>
      ) : null}

      {view === "snooze" ? (
        <div className="chat-actions-menu chat-snooze-menu">
          <button ref={firstActionRef} className="chat-actions-back" type="button" disabled={busy} onClick={() => setView("menu")}>
            <ChevronLeft size={14} />Actions
          </button>
          <div className="chat-actions-heading">
            <strong>Snooze until</strong>
            <span>This Chat will return to Active automatically.</span>
          </div>
          {snoozePresets.map((preset) => (
            <button
              type="button"
              disabled={busy}
              key={preset.id}
              onClick={() => void handleLifecycle({ snoozedUntil: preset.snoozedUntil })}
            >
              <Clock3 size={14} />
              <span><strong>{preset.label}</strong><small>{preset.detail}</small></span>
            </button>
          ))}
        </div>
      ) : null}

      {busy ? <span className="chat-actions-progress"><Loader2 className="spin" size={13} />Saving</span> : null}
      {error ? <span className="chat-rename-error">{error}</span> : null}
      {lifecycleView === "snoozed" && state.conversation.snoozedUntil && view === "menu" ? (
        <span className="chat-actions-current-state">
          Snoozed until {chatSnoozeTimeLabel(state.conversation.snoozedUntil)}
        </span>
      ) : null}
    </div>
  );
}

function popoverPosition(x: number, y: number): { left: number; top: number } {
  if (typeof window === "undefined") return { left: x, top: y };
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - 304)),
    top: Math.max(8, Math.min(y, window.innerHeight - 360)),
  };
}
