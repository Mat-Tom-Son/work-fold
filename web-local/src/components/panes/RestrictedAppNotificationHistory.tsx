import { useEffect, useState } from "react";

import type { RestrictedAppNotificationRecordEntry } from "../../../../src/shared/restricted-app-notification-record";
import { errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { formatNotificationRecordTime, notificationRecordStatusLabel } from "../../lib/restricted-app-notification-record";
import { listRestrictedAppNotificationRecord } from "../../lib/restricted-apps";
import type { RestrictedAppInstalled } from "../../types";

const collapsedCount = 5;

/**
 * The app's recent notifications, under its notification categories in
 * Settings → Apps: what each call did and when, read from the machine-local
 * notification record. Categories are on from install, so like the Short
 * Answers list this is how a person sees, after the fact, what an app said.
 */
export function RestrictedAppNotificationHistory({ app, disabled }: {
  app: RestrictedAppInstalled;
  disabled: boolean;
}) {
  const [entries, setEntries] = useState<RestrictedAppNotificationRecordEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (disabled) return;
    let alive = true;
    let loading = false;
    async function refresh(): Promise<void> {
      if (!alive || loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const next = await listRestrictedAppNotificationRecord(app, 50);
        if (alive) { setEntries(next); setError(null); }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const unsubscribe = subscribeControlEvents((hint) => { if (hint !== "activity") void refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [app, disabled]);

  if (error) return <p className="restricted-app-notification-history" role="alert">{error}</p>;
  if (!entries) return null;
  if (!entries.length) {
    return <p className="restricted-app-notification-history restricted-app-notification-history-empty">No notifications yet.</p>;
  }
  const visible = expanded ? entries : entries.slice(0, collapsedCount);
  return <div className="restricted-app-notification-history" aria-label="Recent notifications">
    <h4>Recent</h4>
    <ul>
      {visible.map((entry) => <li key={entry.id} className={entry.status === "shown" ? "" : "not-shown"}>
        {notificationRecordStatusLabel(entry.status)} <time dateTime={entry.at}>{formatNotificationRecordTime(entry.at)}</time> · {entry.title}
      </li>)}
    </ul>
    {entries.length > collapsedCount ? <button className="ui-control ui-control--quiet" type="button" onClick={() => setExpanded((value) => !value)}>
      {expanded ? "Show fewer" : `Show all ${entries.length}`}
    </button> : null}
  </div>;
}
