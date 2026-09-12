function calendarStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function calendarDaysBefore(date, count) {
  const result = new Date(date);
  result.setDate(result.getDate() - count);
  return result;
}

/** Group chat records using local calendar dates, never elapsed 24-hour windows. */
export function groupConversationsByDate(conversations, now = new Date()) {
  const today = calendarStart(now);
  const yesterday = calendarDaysBefore(today, 1);
  const weekStart = calendarDaysBefore(today, (today.getDay() + 6) % 7);
  const lastWeekStart = calendarDaysBefore(weekStart, 7);
  const groups = [
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "Earlier this week", conversations: [] },
    { label: "Last week", conversations: [] },
    { label: "Older", conversations: [] },
  ];
  for (const conversation of conversations) {
    const updated = new Date(conversation.updatedAt);
    const day = Number.isFinite(updated.getTime()) ? calendarStart(updated) : null;
    const bucket = !day ? 4
      : day >= today ? 0
        : day >= yesterday ? 1
          : day >= weekStart ? 2
            : day >= lastWeekStart ? 3 : 4;
    groups[bucket].conversations.push(conversation);
  }
  return groups.filter((group) => group.conversations.length);
}
