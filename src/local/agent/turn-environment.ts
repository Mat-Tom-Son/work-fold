/**
 * The host's clock, time zone, and platform at the start of a turn. Every
 * Worker and work-fold agent turn context carries one line of it, so the model
 * can resolve "tomorrow at 9" into the absolute times `chat snooze --until`
 * and `at` Automations need. It rides the per-turn context rather than the
 * system prompt, which keeps it current and leaves the cached prompt prefix
 * unchanged.
 */
export interface PiTurnEnvironment {
  now: Date;
  /** IANA time zone name, such as "Europe/Berlin". */
  timeZone: string;
  platform: NodeJS.Platform;
}

export function currentTurnEnvironment(): PiTurnEnvironment {
  return {
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    platform: process.platform,
  };
}

const platformNames: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** One line: weekday, ISO 8601 local time with its UTC offset, IANA zone, and platform. */
export function describeTurnEnvironment(environment: PiTurnEnvironment): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: environment.timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(environment.now).map((part) => [part.type, part.value]));
  // "GMT-07:00" → "-07:00"; a zero offset reads as plain "GMT".
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName).replace(/^GMT/, "");
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  const platform = platformNames[environment.platform];
  return `Host environment at the start of this turn (host-owned): local time ${parts.weekday} ${local}, time zone ${environment.timeZone}, platform ${platform ? `${platform} (${environment.platform})` : environment.platform}. Resolve relative dates and times from this.`;
}
