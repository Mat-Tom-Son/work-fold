import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, Loader2, X } from "lucide-react";

import { useModalDialog } from "../../hooks/useModalDialog";
import { errorText } from "../../lib/api";
import { Banner } from "../chrome/common";

export function TextInputModal({
  title,
  description,
  label,
  initialValue = "",
  placeholder,
  confirmLabel,
  maxLength = 255,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  maxLength?: number;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useModalDialog({ onClose, blocked: saving, initialFocusRef: inputRef });

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextValue = value.trim();
    if (!nextValue) {
      setError(`Enter ${label.toLocaleLowerCase()}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(nextValue);
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop text-input-modal-backdrop" role="presentation" onMouseDown={saving ? undefined : onClose}>
      <section ref={dialogRef} tabIndex={-1} className="text-input-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <form className="text-input-modal-form" onSubmit={(event) => void submit(event)}>
          <div className="modal-title">
            <div><h2 id={titleId}>{title}</h2>{description ? <p>{description}</p> : null}</div>
            <button className="ui-control ui-control--icon" type="button" onClick={onClose} disabled={saving} aria-label={`Close ${title}`}><X size={16} /></button>
          </div>
          <div className="text-input-modal-content">
            <label className="settings-field" htmlFor={inputId}>{label}
              <input
                ref={inputRef}
                id={inputId}
                value={value}
                maxLength={maxLength}
                autoComplete="off"
                placeholder={placeholder}
                disabled={saving}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  if (error) setError(null);
                }}
              />
            </label>
            {error ? <Banner tone="error" text={error} /> : null}
          </div>
          <div className="text-input-modal-footer">
            <button className="ui-control" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="ui-control ui-control--primary" type="submit" disabled={saving || !value.trim()} aria-busy={saving ? "true" : undefined}>
              {saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{confirmLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
