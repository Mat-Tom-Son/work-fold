import { ApiError, apiUrl } from "./api";

/**
 * Reads one Space file through the raw-file route with the session header
 * and hands back a same-document `blob:` URL. A plain `src` pointing at the
 * local API would carry no session header in the desktop app and would fall
 * outside the renderer's `img-src`/`frame-src` policy; a blob URL has neither
 * problem. The caller revokes the URL when the preview changes.
 */
export async function spaceRawFileObjectUrl(spaceId: string, path: string, signal?: AbortSignal): Promise<string> {
  const sessionHeaders = await window.workFoldDesktop?.api.getSessionHeaders?.();
  const response = await fetch(apiUrl(`/api/spaces/${spaceId}/raw-file?path=${encodeURIComponent(path)}`), {
    headers: sessionHeaders ?? {},
    signal,
  });
  if (!response.ok) throw new ApiError(response.status, response.statusText || `Request failed (${response.status}).`);
  return URL.createObjectURL(await response.blob());
}
