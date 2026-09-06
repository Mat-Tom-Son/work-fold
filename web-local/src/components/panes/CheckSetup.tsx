import { useState } from "react";
import { api, errorText } from "../../lib/api";

/** Manual authoring is secondary to the fold. Saving creates an inert proposal. */
export function CheckSetup({ spaceId, onSaved, onCancel }: { spaceId: string; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("text-review");
  const [criteria, setCriteria] = useState("");
  const [paths, setPaths] = useState("");
  const [references, setReferences] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = (value: string) => [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const targets = [
        ...lines(paths).map((path) => ({ kind: "file", role: "primary", path })),
        ...(kind === "text-review" ? lines(references).map((path) => ({ kind: "file", role: "reference", path })) : []),
      ];
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/checks/configure`, { method: "POST", body: { proposal: {
        kind: "work-fold.check-proposal", version: 1, name: title, createdBy: "human", createdAt: new Date().toISOString(),
        check: { title, severity: "warning", trigger: "manual", targets,
          sensor: kind === "text-review" ? { id: "work-fold.text-review", revision: 1, parameters: { criteria } }
            : { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
        },
      } } });
      await onSaved();
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  return <form className="checks-setup" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h2>New Check</h2>
    <label>Name<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Claims match the reference" /></label>
    <label>Review type<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="text-review">Text review with the fold’s model</option><option value="file-presence">Required files exist</option></select></label>
    {kind === "text-review" ? <label>What should it look for?<textarea required maxLength={4096} rows={4} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="Flag unsupported claims, inconsistent terms, and unclear steps. Use the reference for terminology." /></label> : null}
    <label>Files to check · one path per line<textarea required rows={3} value={paths} onChange={(event) => setPaths(event.target.value)} placeholder={"Drafts/proposal.md\nNotes/summary.txt"} /></label>
    {kind === "text-review" ? <label>Reference files · optional<textarea rows={2} value={references} onChange={(event) => setReferences(event.target.value)} placeholder="Reference/style-guide.md" /></label> : null}
    <p>Paths are relative to this Space. This Check may inspect only the listed files.</p>
    {kind === "text-review" ? <p>Each run sends these UTF-8 text files and criteria to the fold’s selected model and may incur provider charges. Up to 16 files, 128 KiB per file, 256 KiB total. It returns quoted suggestions and does not edit files. Your fold conversation is not included.</p> : null}
    <p>Save a proposal, try it, then turn it on when you are happy with it. Automatic runs require a separately enabled routing.</p>
    {error ? <p role="alert" className="settings-inline-error">{error}</p> : null}
    <div className="checks-header-actions"><button className="professional-button professional-button-primary" disabled={busy} type="submit">{busy ? "Saving…" : "Save proposal"}</button><button className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
