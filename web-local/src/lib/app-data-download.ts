/** Download only the host-produced data envelope; filenames contain no paths. */
export function downloadAppData(appId: string, backup: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${appId.replace(/[^a-z0-9-]/g, "-")}-data.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
