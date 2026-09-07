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
    let hasAppResult = false;
    for (const app of (Array.isArray(item?.apps) ? item.apps : []).slice(0, 64)) {
      if (!app || ![app.spaceId, app.appId, app.featureInstallationId].every((value) => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(value))
        || typeof app.digest !== "string" || !/^[a-f0-9]{64}$/.test(app.digest)
        || typeof app.title !== "string" || !app.title.length || app.title.length > 120
        || typeof app.version !== "string" || !app.version.length || app.version.length > 160) continue;
      hasAppResult = true;
      add(`app:${app.spaceId}:${app.featureInstallationId}`, { kind: "app", spaceId: app.spaceId, appId: app.appId,
        featureInstallationId: app.featureInstallationId, digest: app.digest, version: app.version, label: app.title });
    }
    if (!hasAppResult && typeof item?.decisionId === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(item.decisionId)) {
      add(`decision:${item.decisionId}`, { kind: "decision", id: item.decisionId, label: "Review decision" });
    }
  }
  for (const child of (Array.isArray(request.children) ? request.children : []).slice(0, 200)) {
    if (typeof child?.spaceId !== "string" || !["succeeded", "failed", "aborted"].includes(child.state) || !Array.isArray(child.files)) continue;
    for (const path of child.files.slice(0, 12)) if (safePath(path)) add(`file:${child.spaceId}:${path}`,
      { kind: "file", spaceId: child.spaceId, path, label: path.split("/").at(-1), spaceName: child.spaceName || "Space" });
  }
  return [...links.values()];
}

function safePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 2048 && !/[\\\u0000-\u001f\u007f]/u.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === ".." || [".work-fold", ".workspace", ".pi"].includes(part.toLowerCase()));
}
