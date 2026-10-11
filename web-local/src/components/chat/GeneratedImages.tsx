import { useEffect, useState, type CSSProperties } from "react";
import { Checkmark16Regular, Copy16Regular, FolderAdd16Regular, FolderOpen16Regular } from "@fluentui/react-icons";

import type { ChatToolImage } from "../../../../src/shared/chat-presentation";
import { api, errorText } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { generatedImageBlob, workFolderRawFileBlob } from "../../lib/raw-file";
import { showToast } from "../../ui/feedback";

/** The completed pictures in a turn's steps, once each, in the order they were made. */
export function turnGeneratedImages(entries: ReadonlyArray<{ kind: string; phase?: string; image?: ChatToolImage }>): ChatToolImage[] {
  const seen = new Set<string>();
  const images: ChatToolImage[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool" || !entry.image || (entry.phase && entry.phase !== "complete") || seen.has(entry.image.id)) continue;
    seen.add(entry.image.id);
    images.push(entry.image);
  }
  return images;
}

/**
 * Pictures a Worker made in this turn (2026-10-11), shown under its reply
 * whatever the Worker-steps setting is. Hovering one offers Copy and Add to
 * folder, or Show in Files once it is in the folder.
 */
export function GeneratedImages({ images, workFolderId, onOpenWorkFolderFile }: {
  images: ChatToolImage[];
  workFolderId: string;
  onOpenWorkFolderFile?: (path: string) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="generated-images">
      {images.map((image) => <GeneratedImage key={image.id} image={image} workFolderId={workFolderId} onOpenWorkFolderFile={onOpenWorkFolderFile} />)}
    </div>
  );
}

function GeneratedImage({ image, workFolderId, onOpenWorkFolderFile }: {
  image: ChatToolImage;
  workFolderId: string;
  onOpenWorkFolderFile?: (path: string) => void;
}) {
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [folderPath, setFolderPath] = useState<string | undefined>(image.path);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    // The machine-local copy first; a picture saved in the folder also loads from there.
    generatedImageBlob(image.id, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted || !image.path) throw error;
        return workFolderRawFileBlob(workFolderId, image.path, controller.signal);
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPicture({ blob, url: objectUrl });
      })
      .catch(() => { if (!controller.signal.aborted) setMissing(true); });
    if (!image.path) {
      api<{ addedPath?: string }>(`/api/work-folders/${encodeURIComponent(workFolderId)}/generated-images/${encodeURIComponent(image.id)}`, { signal: controller.signal })
        .then((info) => { if (info.addedPath) setFolderPath(info.addedPath); })
        .catch(() => undefined);
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.id, image.path, workFolderId]);

  async function copy() {
    if (!picture || busy) return;
    setBusy(true);
    try {
      await copyToClipboard({ text: "", image: await pngDataUrl(picture.blob, picture.url) });
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      showToast({ text: `Could not copy the picture: ${errorText(error)}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function addToFolder() {
    if (busy) return;
    setBusy(true);
    try {
      const added = await api<{ path: string }>(`/api/work-folders/${encodeURIComponent(workFolderId)}/generated-images/${encodeURIComponent(image.id)}/add`, { method: "POST", body: {} });
      setFolderPath(added.path);
      showToast({ text: `Added ${added.path} to the folder`, tone: "success" });
    } catch (error) {
      showToast({ text: `Could not add the picture: ${errorText(error)}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const ratio = image.width && image.height ? image.width / image.height : undefined;
  if (missing) return <p className="generated-image-missing">{image.name} is not on this computer.</p>;
  return (
    <figure className="generated-image" style={ratio ? { "--generated-image-ratio": ratio } as CSSProperties : undefined}>
      {picture ? <img src={picture.url} alt={image.name} /> : <span className="generated-image-loading" role="status" aria-label={`Loading ${image.name}`} />}
      <div className="generated-image-actions">
        <button type="button" disabled={!picture || busy} onClick={() => void copy()}>
          {copied ? <Checkmark16Regular aria-hidden="true" /> : <Copy16Regular aria-hidden="true" />}{copied ? "Copied" : "Copy"}
        </button>
        {folderPath ? (
          onOpenWorkFolderFile ? <button type="button" onClick={() => onOpenWorkFolderFile(folderPath)}><FolderOpen16Regular aria-hidden="true" />Show in Files</button> : null
        ) : (
          <button type="button" disabled={busy} onClick={() => void addToFolder()}><FolderAdd16Regular aria-hidden="true" />Add to folder</button>
        )}
      </div>
    </figure>
  );
}

/** The picture as PNG data for the clipboard; other formats are redrawn as PNG from the shown image. */
async function pngDataUrl(blob: Blob, objectUrl: string): Promise<string> {
  if (blob.type === "image/png") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return `data:image/png;base64,${btoa(binary)}`;
  }
  const element = new Image();
  element.src = objectUrl;
  await element.decode();
  const canvas = document.createElement("canvas");
  canvas.width = element.naturalWidth;
  canvas.height = element.naturalHeight;
  canvas.getContext("2d")!.drawImage(element, 0, 0);
  return canvas.toDataURL("image/png");
}
