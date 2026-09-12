export function groupChatsByRecency<T extends { updatedAt: string }>(chats: T[], now = new Date()): Array<[string, T[]]> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
  const groups = new Map<string, T[]>();
  for (const chat of chats) {
    const day = new Date(chat.updatedAt);
    day.setHours(0, 0, 0, 0);
    const label = day.getTime() === startOfToday.getTime() ? "Today"
      : day.getTime() === startOfYesterday.getTime() ? "Yesterday"
        : day >= startOfWeek ? "Earlier this week"
          : day >= startOfLastWeek ? "Last week" : "Older";
    groups.set(label, [...(groups.get(label) ?? []), chat]);
  }
  return Array.from(groups.entries());
}
