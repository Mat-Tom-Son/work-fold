import { X } from "lucide-react";
import { FileTypeIcon } from "../tree/FileTree";

export function AttachmentChip({ path, name, onRemove }: {
  path: string;
  name: string;
  onRemove: () => void;
}) {
  return <div className="context-chip" title={path}>
    <span className="context-chip-main">
      <FileTypeIcon path={path} />
      <span className="context-chip-name">{name}</span>
    </span>
    <button className="context-chip-remove" type="button" onClick={onRemove} aria-label={`Remove ${name}`}>
      <X size={12} />
    </button>
  </div>;
}
