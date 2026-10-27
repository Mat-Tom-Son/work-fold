/**
 * One window's view of a Chat's queued message, kept in step with the copy
 * the app holds (2026-10-27).
 *
 * The app numbers every queue change. A window applies an app event only when
 * it is newer than every change the window has seen or made, and only while
 * none of its own writes or Cancels are in flight: until those finish, the
 * window's local text is the newest and an echo of an older write must not
 * replace it. Writes and Cancels are acknowledged with their numbers, so a
 * late echo of either is recognised as old. All of this is plain state the
 * Chat panel mirrors into React, so event handlers never read a value that
 * only a later render would update.
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

  /** A new event stream for the Chat starts from the app's numbering afresh. */
  resetRevision(): void {
    this.revision = 0;
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

  /** A write finished; `revision` is present when the app accepted it. */
  writeSettled(revision?: number): void {
    this.writesInFlight -= 1;
    if (revision === undefined) return;
    this.revision = Math.max(this.revision, revision);
    if (this.cancelsInFlight === 0 && this.content !== null) this.onServer = true;
  }

  /** Takes the message back. `needsDelete` when the app holds or may soon hold a copy. */
  cancel(): { content: string | null; needsDelete: boolean } {
    const content = this.content;
    const needsDelete = content !== null && (this.onServer || this.writesInFlight > 0);
    this.clear();
    if (needsDelete) this.cancelsInFlight += 1;
    return { content, needsDelete };
  }

  cancelSettled(revision?: number): void {
    this.cancelsInFlight -= 1;
    if (revision !== undefined) this.revision = Math.max(this.revision, revision);
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
    const newer = revision > this.revision;
    this.revision = Math.max(this.revision, revision);
    if (!newer || this.writesInFlight > 0 || this.cancelsInFlight > 0) return false;
    if (event.queued) {
      this.content = event.queued.content;
      this.onServer = true;
      this.held = event.queued.held === true;
      return true;
    }
    if (!this.onServer) return false;
    this.clear();
    return true;
  }
}
