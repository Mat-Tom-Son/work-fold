import { useRef, useState, type FormEvent } from "react";
import { CirclePlus, Loader2 } from "lucide-react";
import { errorText } from "../../lib/api";
import { useModalDialog } from "../../hooks/useModalDialog";
import { Banner } from "../chrome/common";

export function CreateSpaceModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog({ onClose, blocked: creating, initialFocusRef: inputRef });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return setError("Enter a name for this Space.");
    setCreating(true); setError(null);
    try { await onCreate(nextName); } catch (caught) { setError(errorText(caught)); setCreating(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={creating ? undefined : onClose}>
    <section ref={dialogRef} tabIndex={-1} className="create-space-modal" role="dialog" aria-modal="true" aria-labelledby="create-space-title" onMouseDown={(event) => event.stopPropagation()}>
      <form className="create-space-form" onSubmit={(event) => void submit(event)}>
        <div className="modal-title"><div><h2 id="create-space-title">Create a Space</h2><p>A Space keeps files, chats, history, and your Assistant together.</p></div><button className="ghost-button" type="button" onClick={onClose} disabled={creating}>Close</button></div>
        <div className="create-space-content"><label className="settings-field" htmlFor="create-space-name">Space name<input ref={inputRef} id="create-space-name" value={name} maxLength={80} autoComplete="off" placeholder="Plan a trip, manage a move…" onChange={(event) => { setName(event.currentTarget.value); setError(null); }} disabled={creating} /></label>{error ? <Banner tone="error" text={error} /> : null}</div>
        <div className="create-space-footer"><button className="secondary-button" type="button" onClick={onClose} disabled={creating}>Cancel</button><button className="primary-button" type="submit" disabled={creating || !name.trim()} aria-busy={creating ? "true" : undefined}>{creating ? <Loader2 className="spin" size={16} /> : <CirclePlus size={16} />}Create Space</button></div>
      </form>
    </section>
  </div>;
}
