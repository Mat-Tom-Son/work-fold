import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export type ConfirmTone = "default" | "danger";

export interface ConfirmDialogOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  tone?: ConfirmTone;
}

export interface ConfirmDialogRequest extends ConfirmDialogOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
  returnFocusTo: HTMLElement | null;
}

export type ToastTone = "info" | "success" | "error";

export type ToastCloseReason = "action" | "dismiss" | "timeout";

export interface ToastOptions {
  text: string;
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
  onClose?: (reason: ToastCloseReason) => void;
}

export interface ToastEntry extends ToastOptions {
  id: number;
  tone: ToastTone;
}

let confirmDialogDispatch: ((request: ConfirmDialogRequest) => void) | null = null;
let confirmDialogRequestId = 0;
let toastDispatch: ((toast: ToastEntry) => void) | null = null;
let toastId = 0;

export function requestConfirm(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const request: ConfirmDialogRequest = {
      ...options,
      id: ++confirmDialogRequestId,
      resolve,
      returnFocusTo,
    };
    if (!confirmDialogDispatch) {
      resolve(false);
      return;
    }
    confirmDialogDispatch(request);
  });
}

export function showToast(options: ToastOptions): void {
  toastDispatch?.({
    ...options,
    id: ++toastId,
    tone: options.tone ?? "info",
  });
}

export function ConfirmDialogHost() {
  const [queue, setQueue] = useState<ConfirmDialogRequest[]>([]);
  const activeRequest = queue[0] ?? null;
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmDialogDispatch = (request) => setQueue((current) => [...current, request]);
    return () => {
      confirmDialogDispatch = null;
    };
  }, []);

  useEffect(() => {
    if (!activeRequest) return;
    window.requestAnimationFrame(() => {
      const target = activeRequest.tone === "danger" ? cancelButtonRef.current : confirmButtonRef.current;
      target?.focus();
    });
  }, [activeRequest]);

  useEffect(() => {
    if (!activeRequest) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        settleConfirmRequest(activeRequest, false);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        settleConfirmRequest(activeRequest, document.activeElement !== cancelButtonRef.current);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const target = document.activeElement === confirmButtonRef.current ? cancelButtonRef.current : confirmButtonRef.current;
        target?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [activeRequest, queue.length]);

  function settleConfirmRequest(request: ConfirmDialogRequest, confirmed: boolean): void {
    const returnFocus = queue.length <= 1 ? request.returnFocusTo : null;
    request.resolve(confirmed);
    setQueue((current) => current[0]?.id === request.id ? current.slice(1) : current.filter((item) => item.id !== request.id));
    if (returnFocus) {
      window.requestAnimationFrame(() => {
        if (returnFocus.isConnected) returnFocus.focus();
      });
    }
  }

  if (!activeRequest) return null;

  const titleId = `confirm-dialog-title-${activeRequest.id}`;
  const danger = activeRequest.tone === "danger";

  return (
    <div className="modal-backdrop confirm-dialog-backdrop" role="presentation" onMouseDown={() => settleConfirmRequest(activeRequest, false)}>
      <section
        className={danger ? "confirm-dialog confirm-dialog-danger" : "confirm-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title confirm-dialog-title">
          <div>
            <h2 id={titleId}>{activeRequest.title}</h2>
            {activeRequest.body ? <p>{activeRequest.body}</p> : null}
          </div>
        </div>
        <div className="confirm-dialog-footer">
          <button ref={cancelButtonRef} className="secondary-button" type="button" onClick={() => settleConfirmRequest(activeRequest, false)}>
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            className={danger ? "secondary-button danger" : "primary-button"}
            type="button"
            onClick={() => settleConfirmRequest(activeRequest, true)}
          >
            {activeRequest.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    toastDispatch = (toast) => setToasts((current) => {
      const next = [...current, toast];
      if (next.length <= 4) return next;
      // Capacity evicts plain notices before action-bearing toasts: dropping
      // an Undo toast settles its contract early and silently shortens the
      // promised undo window. Evicted toasts still settle their onClose
      // contract (must stay idempotent: StrictMode can run this twice).
      const keep = [...next];
      const evicted: ToastEntry[] = [];
      for (const candidate of next) {
        if (keep.length <= 4) break;
        if (candidate.actionLabel && candidate.onAction) continue;
        evicted.push(candidate);
        keep.splice(keep.indexOf(candidate), 1);
      }
      while (keep.length > 4) {
        const oldest = keep.shift();
        if (oldest) evicted.push(oldest);
      }
      for (const dropped of evicted) {
        queueMicrotask(() => dropped.onClose?.("timeout"));
      }
      return keep;
    });
    return () => {
      toastDispatch = null;
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
      ))}
    </div>
  );
}

export function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const remainingMsRef = useRef(toast.durationMs ?? 4500);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const closedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const closeToast = useCallback((reason: ToastCloseReason) => {
    if (closedRef.current) return;
    closedRef.current = true;
    clearTimer();
    toast.onClose?.(reason);
    onDismiss();
  }, [clearTimer, onDismiss, toast]);

  const startTimer = useCallback(() => {
    clearTimer();
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => closeToast("timeout"), remainingMsRef.current);
  }, [clearTimer, closeToast]);

  const pauseTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingMsRef.current = Math.max(400, remainingMsRef.current - (Date.now() - startedAtRef.current));
  }, []);

  useEffect(() => {
    startTimer();
    return clearTimer;
  }, [clearTimer, startTimer]);

  return (
    <div className={`toast toast-${toast.tone}`} role="status" onMouseEnter={pauseTimer} onMouseLeave={startTimer}>
      <span className="toast-text">{toast.text}</span>
      {toast.actionLabel && toast.onAction ? (
        <button
          className="toast-action"
          type="button"
          onClick={() => {
            toast.onAction?.();
            closeToast("action");
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button className="toast-dismiss" type="button" onClick={() => closeToast("dismiss")} aria-label="Dismiss notification" title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
