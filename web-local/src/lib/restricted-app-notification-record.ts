import type { RestrictedAppNotificationRecordStatus } from "../../../src/shared/restricted-app-notification-record";

/** How a notification call ended, in the words Settings → Apps uses. */
export function notificationRecordStatusLabel(status: RestrictedAppNotificationRecordStatus): string {
  switch (status) {
    case "shown": return "Shown";
    case "rate-limited": return "Not shown (too many at once)";
    case "unsupported": return "Not shown (notifications unavailable)";
  }
}

/** "Oct 11, 3:02 PM": short enough to scan a list of them. */
export function formatNotificationRecordTime(at: string, locale?: string): string {
  return new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
