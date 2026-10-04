import { api } from "../../lib/api";
import { TextInputModal } from "./TextInputModal";

export interface NewFolderTarget {
  spaceId: string;
  spaceName: string;
  parentPath: string;
}

export function NewFolderModal({ target, fixtureMode = false, onCreated, onClose }: {
  target: NewFolderTarget;
  fixtureMode?: boolean;
  onCreated: (folder: { path: string; name: string }) => void;
  onClose: () => void;
}) {
  return <TextInputModal
    title="New folder"
    description={`Create inside ${target.parentPath || target.spaceName}.`}
    label="Folder name"
    placeholder="Untitled folder"
    confirmLabel="Create folder"
    onSubmit={async (name) => {
      if (fixtureMode) throw new Error("Folder creation is disabled in the preview.");
      const result = await api<{ folder: { path: string; name: string } }>(`/api/spaces/${encodeURIComponent(target.spaceId)}/folders`, {
        method: "POST",
        body: { parentPath: target.parentPath, name },
      });
      onCreated(result.folder);
    }}
    onClose={onClose}
  />;
}
