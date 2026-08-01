export async function handleAction(action, input) {
  if (action !== "search") throw new Error("Unknown action.");
  const response = await globalThis.workFoldRestrictedApp.request({
    destinationId: "mail-api",
    method: "GET",
    path: `/messages?query=${encodeURIComponent(input.query)}`,
    headers: { accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300 || response.encoding !== "utf8") {
    throw new Error(`Mail search failed with status ${response.status}.`);
  }
  const data = JSON.parse(response.body);
  return { count: Number.isInteger(data.count) && data.count >= 0 ? data.count : 0 };
}

export async function handleAutomation(event) {
  if (event.automationId !== "refresh-inbox" || event.handler !== "refresh-inbox") {
    throw new Error("Unknown automation.");
  }
  let network;
  try {
    const response = await globalThis.workFoldRestrictedApp.request({
      destinationId: "mail-api",
      method: "GET",
      path: "/messages?limit=20",
      headers: { accept: "application/json" },
    });
    network = response.status >= 200 && response.status < 300
      ? { state: "connected", status: response.status }
      : { state: "http-error", status: response.status };
  } catch (error) {
    network = { state: "unavailable", code: errorCode(error, "NETWORK_FAILED") };
  }

  let notification;
  try {
    await globalThis.workFoldRestrictedApp.notifications.show({ permissionId: "inbox-refresh-finished" });
    notification = { state: "requested" };
  } catch (error) {
    notification = { state: "not-shown", code: errorCode(error, "NOTIFICATION_FAILED") };
  }

  await globalThis.workFoldRestrictedApp.storage.set("last-automation-refresh", {
    version: 2,
    reason: event.reason,
    scheduledAt: event.scheduledAt,
    completedAt: new Date().toISOString(),
    network,
    notification,
  });
}

function errorCode(error, fallback) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : fallback;
}
