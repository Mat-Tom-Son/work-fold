import { ApiError, apiUrl } from "./api";

/**
 * Reads one work-folder file through the raw-file route with the session header
 * and hands back a same-document `blob:` URL. A plain `src` pointing at the
 * local API would carry no session header in the desktop app and would fall
 * outside the renderer's `img-src`/`frame-src` policy; a blob URL has neither
 * problem. The caller revokes the URL when the preview changes.
 */
export async function workFolderRawFileObjectUrl(workFolderId: string, path: string, signal?: AbortSignal): Promise<string> {
  return URL.createObjectURL(await workFolderRawFileBlob(workFolderId, path, signal));
}

/** The same file's bytes, for a caller that keeps them (a `blob:` URL cannot be fetched back under the renderer's policy). */
export async function workFolderRawFileBlob(workFolderId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  return sessionBlob(apiUrl(`/api/work-folders/${workFolderId}/raw-file?path=${encodeURIComponent(path)}`), signal);
}

/**
 * A picture generate_image made, from work-fold's machine-local store
 * (2026-10-11). Rejects with a 404 ApiError when the picture is not on this
 * computer, for example in a Chat that traveled.
 */
export async function generatedImageBlob(imageId: string, signal?: AbortSignal): Promise<Blob> {
  return sessionBlob(apiUrl(`/api/generated-images/${encodeURIComponent(imageId)}`), signal);
}

async function sessionBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const sessionHeaders = await window.workFoldDesktop?.api.getSessionHeaders?.();
  const response = await fetch(url, { headers: sessionHeaders ?? {}, signal });
  if (!response.ok) throw new ApiError(response.status, response.statusText || `Request failed (${response.status}).`);
  return response.blob();
}
