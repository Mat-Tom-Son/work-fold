/** Navigation references come from host-composed receipts, never guessed from fold prose. */
export function requestResultLinks(request) {
  if (!request || typeof request !== "object") return [];
  const links = new Map();
  const add = (key, value) => { if (links.size < 12 && !links.has(key)) links.set(key, value); };
  for (const item of [...(Array.isArray(request.dispositions) ? request.dispositions : []), ...(Array.isArray(request.actions) ? request.actions : [])].slice(0, 256)) {
    if (typeof item?.spaceId === "string" && Array.isArray(item.copied)) {
      for (const path of item.copied.slice(0, 12)) {
        if (!safePath(path)) continue;
        add(`file:${item.spaceId}:${path}`, { kind: "file", spaceId: item.spaceId, path, label: path.split("/").at(-1), spaceName: item.spaceName || "Space" });
      }
    }
    if (typeof item?.decisionId === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(item.decisionId)) {
      add(`decision:${item.decisionId}`, { kind: "decision", id: item.decisionId, label: "Review decision" });
    }
  }
  return [...links.values()];
}

function safePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 2048 && !/[\\\u0000-\u001f\u007f]/u.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === ".." || [".work-fold", ".workspace", ".pi"].includes(part.toLowerCase()));
}
