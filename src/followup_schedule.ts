/** Wall-clock windows, with timezone/DST resolution and no catch-up execution. */
export interface ScheduleConfig {
  timezone: string;
  windows: readonly string[];
  duration_ms: number;
  max_attempts: number;
}
export interface ScheduleWindow {
  key: string;
  starts_at: number;
  ends_at: number;
}
const DAY = 86400000;
function format(config: ScheduleConfig) {
  if (
    !Number.isSafeInteger(config.duration_ms) || config.duration_ms < 60000 ||
    config.duration_ms > 6 * 3600000 ||
    !Number.isSafeInteger(config.max_attempts) || config.max_attempts < 1 ||
    config.max_attempts > 2 ||
    !config.windows.length || config.windows.length > 4 ||
    new Set(config.windows).size !== config.windows.length ||
    config.windows.some((w) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(w))
  ) throw new Error("SCHEDULE_INVALID");
  const minutes = config.windows.map((w) => Number(w.slice(0, 2)) * 60 + Number(w.slice(3))).sort((
    a,
    b,
  ) => a - b);
  if (
    minutes.some((m, i) =>
      ((minutes[(i + 1) % minutes.length] + (i === minutes.length - 1 ? 1440 : 0)) - m) * 60000 <
        config.duration_ms
    )
  ) throw new Error("SCHEDULE_OVERLAP");
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function stamp(t: number, fmt: Intl.DateTimeFormat) {
  const p = Object.fromEntries(fmt.formatToParts(t).map((v) => [v.type, v.value]));
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}
function candidates(
  now: number,
  startsAt: number,
  expiresAt: number,
  config: ScheduleConfig,
  days: number,
) {
  if (
    ![now, startsAt, expiresAt].every(Number.isSafeInteger) || startsAt >= expiresAt ||
    expiresAt - startsAt > 7 * DAY
  ) throw new Error("SCHEDULE_RANGE");
  const fmt = format(config), local = stamp(now, fmt), day = Math.floor(local / DAY) * DAY;
  const result: ScheduleWindow[] = [];
  for (let delta = -1; delta <= days; delta++) {
    for (const time of config.windows) {
      const wall = day + delta * DAY +
        (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60000;
      // Offsets on adjacent days cover both sides of a DST transition. Missing
      // local times yield no candidate; duplicated local times use the first one.
      const offsets = new Set([-DAY, 0, DAY].map((d) => stamp(wall + d, fmt) - (wall + d)));
      const possible = [...offsets].map((offset) => wall - offset).filter((t) =>
        stamp(t, fmt) === wall
      ).sort((a, b) => a - b);
      if (!possible.length) continue;
      const begin = possible[0], end = Math.min(begin + config.duration_ms, expiresAt);
      if (end <= startsAt || begin >= expiresAt) continue;
      result.push({
        key: config.timezone + "/" + begin,
        starts_at: Math.max(begin, startsAt),
        ends_at: end,
      });
    }
  }
  return result.sort((a, b) => a.starts_at - b.starts_at);
}
export function scheduleWindow(
  now: number,
  startsAt: number,
  expiresAt: number,
  config: ScheduleConfig,
): ScheduleWindow | null {
  return candidates(now, startsAt, expiresAt, config, 0).find((w) =>
    now >= w.starts_at && now < w.ends_at
  ) ?? null;
}
export function nextScheduleWindow(
  now: number,
  startsAt: number,
  expiresAt: number,
  config: ScheduleConfig,
): number | null {
  return candidates(now, startsAt, expiresAt, config, 8).find((w) => w.ends_at > now)?.starts_at ??
    null;
}
