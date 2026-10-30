/**
 * One window's view of a Chat's queued message, kept in step with the copy
 * the app holds (2026-10-27).
 *
 * The app numbers every queue change. A window applies an app event only when
 * it is newer than every change the window has applied or made. While its own
 * writes or Cancels are in flight, the window's local text is the newest, so
 * it keeps the newest app event aside instead of applying it; when they have
 * all finished, that event is applied if it is still newer than the window's
 * own last change — the app sent the message or a Stop held it meanwhile —
 * and dropped if it was only an echo. Writes and Cancels are acknowledged
 * with their numbers. While anything is in flight (`unsettled`) the window
 * must not send the message itself: the app may already own it. All of this
 * is plain state the Chat panel mirrors into React, so event handlers never
 * read a value that only a later render would update.
 */
export class QueuedMessageSync {
  content: string | null = null;
  /** The app holds a copy (it sends it when the turn ends). */
  onServer = false;
  /** A Stop held it: kept for the person, unsent. */
  held = false;
  private revision = 0;
  private writesInFlight = 0;
  private cancelsInFlight = 0;
  /** The newest app event that arrived while this window's own changes were in flight. */
  private pending: { revision: number; queued: { content: string; held?: boolean } | null } | null = null;

  /** This window's writes or Cancels are still in flight; who holds the message is not settled yet. */
  get unsettled(): boolean {
    return this.writesInFlight > 0 || this.cancelsInFlight > 0;
  }

  /** A new event stream for the Chat starts from the app's numbering afresh. */
  resetRevision(): void {
    this.revision = 0;
    this.pending = null;
  }

  /** Adds a line to the queued message and returns the whole text to write. */
  append(text: string): string {
    this.content = this.content ? `${this.content}\n${text}` : text;
    this.held = false;
    return this.content;
  }

  writeStarted(): void {
    this.writesInFlight += 1;
  }

  /** A write finished; `revision` is present when the app accepted it. Returns whether the view changed. */
  writeSettled(revision?: number): boolean {
    this.writesInFlight -= 1;
    let changed = false;
    if (revision !== undefined) {
      this.revision = Math.max(this.revision, revision);
      if (this.cancelsInFlight === 0 && this.content !== null && !this.onServer) {
        this.onServer = true;
        changed = true;
      }
    }
    return this.reconcile() || changed;
  }

  /** Takes the message back. `needsDelete` when the app holds or may soon hold a copy. */
  cancel(): { content: string | null; needsDelete: boolean } {
    const content = this.content;
    const needsDelete = content !== null && (this.onServer || this.writesInFlight > 0);
    this.clear();
    if (needsDelete) this.cancelsInFlight += 1;
    return { content, needsDelete };
  }

  /** Returns whether the view changed. */
  cancelSettled(revision?: number): boolean {
    this.cancelsInFlight -= 1;
    if (revision !== undefined) this.revision = Math.max(this.revision, revision);
    return this.reconcile();
  }

  /** Forgets the message locally (this window sent it itself). */
  clear(): void {
    this.content = null;
    this.onServer = false;
    this.held = false;
  }

  /** Applies an app event; returns whether the window's view changed. */
  applyEvent(event: { revision?: number; queued?: { content: string; held?: boolean } | null }): boolean {
    const revision = typeof event.revision === "number" ? event.revision : 0;
    if (revision <= this.revision) return false;
    if (this.unsettled) {
      if (!this.pending || revision > this.pending.revision) this.pending = { revision, queued: event.queued ?? null };
      return false;
    }
    return this.apply(revision, event.queued ?? null);
  }

  /** Once nothing is in flight, applies the event kept aside if it is newer than this window's own last change. */
  private reconcile(): boolean {
    if (this.unsettled || !this.pending) return false;
    const pending = this.pending;
    this.pending = null;
    return pending.revision > this.revision ? this.apply(pending.revision, pending.queued) : false;
  }

  private apply(revision: number, queued: { content: string; held?: boolean } | null): boolean {
    this.revision = revision;
    if (queued) {
      this.content = queued.content;
      this.onServer = true;
      this.held = queued.held === true;
      return true;
    }
    if (!this.onServer) return false;
    this.clear();
    return true;
  }
}
