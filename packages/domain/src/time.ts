// Utility per date "da parete" in un fuso orario (la struttura), senza dipendenze esterne.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  isoWeekday: number; // 1 = lunedì … 7 = domenica
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    isoWeekday: WEEKDAYS[parts.weekday as string] ?? 1,
  };
}

/** Converte un orario "da parete" nel fuso indicato nell'istante UTC corrispondente (gestisce l'ora legale). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** Data civile (senza ora) come stringa ISO YYYY-MM-DD. */
export type CivilDate = string;

export function civilDate(year: number, month: number, day: number): CivilDate {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return civilDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function isoWeekdayOf(date: CivilDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function todayIn(tz: string, now: Date = new Date()): CivilDate {
  const p = zonedParts(now, tz);
  return civilDate(p.year, p.month, p.day);
}
