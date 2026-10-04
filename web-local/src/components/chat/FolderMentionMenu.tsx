import type { CSSProperties, ReactNode } from "react";

import type { ChatActivityStatus } from "../../types";
import { ActivityDot } from "../chrome/ActivityDot";

/** A Worker the composer can address with @: its Folder's look and live status. */
export interface MentionFolderOption {
  id: string;
  name: string;
  icon?: ReactNode;
  style?: CSSProperties;
  status?: ChatActivityStatus | null;
}

/** The @ menu above a composer. Same shape and keys as the / command menu. */
export function FolderMentionMenu({ id, folders, activeIndex, className = "composer-command-menu composer-mention-menu", onHover, onChoose }: {
  /** The listbox id; options are `${id}-<index>` for the textarea's aria-activedescendant. */
  id: string;
  folders: readonly MentionFolderOption[];
  activeIndex: number;
  className?: string;
  onHover: (index: number) => void;
  onChoose: (folder: MentionFolderOption) => void;
}) {
  return (
    <div className={className} id={id} role="listbox" aria-label="Workers">
      {folders.map((folder, index) => (
        <button
          className={index === activeIndex ? "active" : ""}
          type="button"
          role="option"
          id={`${id}-${index}`}
          tabIndex={-1}
          aria-selected={index === activeIndex}
          key={folder.id}
          style={folder.style}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(folder)}
        >
          <span className="composer-mention-icon" aria-hidden="true">{folder.icon}</span>
          <span className="composer-mention-name">{folder.name}</span>
          {folder.status ? <ActivityDot status={folder.status} /> : null}
        </button>
      ))}
    </div>
  );
}
