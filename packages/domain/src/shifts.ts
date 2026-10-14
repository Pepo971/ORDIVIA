// Logica di dominio del modulo Turni (pura e testabile): settimane nel fuso della struttura,
// ore lavorate al netto delle pause, sovrapposizioni, riposo minimo, ore settimanali, copertura.

import { addDays, civilDate, isoWeekdayOf, zonedParts, zonedTimeToUtc, type CivilDate } from "./time";

export interface ShiftLike {
  id: string;
  userId: string;
  departmentId?: string | null;
  startsAt: Date;
  endsAt: Date;
  breakMinutes?: number;
}

export interface AbsenceLike {
  userId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface UnavailabilityLike {
  userId: string;
  /** 1 = lunedì … 7 = domenica (ricorrente) */
  weekday?: number | null;
  /** data precisa YYYY-MM-DD */
  onDate?: CivilDate | null;
  /** "HH:MM"; null = tutto il giorno */
  fromTime?: string | null;
  toTime?: string | null;
}

export interface ShiftRules {
  maxWeekHours: number;
  minRestHours: number;
}

export const DEFAULT_SHIFT_RULES: ShiftRules = { maxWeekHours: 48, minRestHours: 11 };

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Settimane
// ---------------------------------------------------------------------------

/** Lunedì della settimana che contiene la data civile. */
export function weekStartOf(date: CivilDate): CivilDate {
  return addDays(date, 1 - isoWeekdayOf(date));
}

/** Lunedì della settimana corrente nel fuso indicato. */
export function currentWeekStart(tz: string, now: Date = new Date()): CivilDate {
  const p = zonedParts(now, tz);
  return weekStartOf(civilDate(p.year, p.month, p.day));
}

/** I 7 giorni (lun → dom) della settimana. */
export function weekDays(weekStart: CivilDate): CivilDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Inizio di una data civile nel fuso (mezzanotte locale) come istante UTC. */
export function startOfCivilDay(date: CivilDate, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc(y, m, d, 0, 0, tz);
}

/** Intervallo [inizio, fine) della settimana in istanti UTC; gestisce le settimane di 167/169 ore del cambio d'ora. */
export function weekRange(weekStart: CivilDate, tz: string): { from: Date; to: Date } {
  return { from: startOfCivilDay(weekStart, tz), to: startOfCivilDay(addDays(weekStart, 7), tz) };
}

/** Data civile locale di un istante. */
export function localDateOf(instant: Date, tz: string): CivilDate {
  const p = zonedParts(instant, tz);
  return civilDate(p.year, p.month, p.day);
}

/** "HH:MM" locale di un istante. */
export function localTimeOf(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function parseHm(t: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) throw new Error(`Orario non valido: ${t}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Orario non valido: ${t}`);
  return [h, min];
}

/**
 * Inizio e fine di un turno da data e orari locali. Se la fine è ≤ inizio, il turno finisce il giorno dopo
 * (es. 18:00 → 02:00).
 */
export function shiftInstants(date: CivilDate, start: string, end: string, tz: string): { startsAt: Date; endsAt: Date } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [sh, sm] = parseHm(start);
  const [eh, em] = parseHm(end);
  const startsAt = zonedTimeToUtc(y, m, d, sh, sm, tz);
  const overnight = eh * 60 + em <= sh * 60 + sm;
  const endDate = overnight ? addDays(date, 1) : date;
  const [y2, m2, d2] = endDate.split("-").map(Number) as [number, number, number];
  return { startsAt, endsAt: zonedTimeToUtc(y2, m2, d2, eh, em, tz) };
}

// ---------------------------------------------------------------------------
// Ore
// ---------------------------------------------------------------------------

/** Ore lavorate di un turno: durata reale (ora legale inclusa) meno la pausa; mai negative. */
export function shiftHours(s: Pick<ShiftLike, "startsAt" | "endsAt" | "breakMinutes">): number {
  const ms = s.endsAt.getTime() - s.startsAt.getTime() - (s.breakMinutes ?? 0) * 60_000;
  return Math.max(0, ms / HOUR);
}

export function roundHours(h: number): number {
  return Math.round(h * 100) / 100;
}

/** Ore per persona (somma dei turni). */
export function hoursByUser(shifts: ShiftLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of shifts) out.set(s.userId, (out.get(s.userId) ?? 0) + shiftHours(s));
  return out;
}

/** Formatta ore decimali come «7 h 30». */
export function formatHours(h: number): string {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return mm === 0 ? `${hh} h` : `${hh} h ${String(mm).padStart(2, "0")}`;
}

/** Stima del costo settimanale: ore × costo orario; persone senza costo escluse e segnalate. */
export function weeklyCost(shifts: ShiftLike[], hourlyCost: Map<string, number>): { total: number; missing: string[] } {
  let total = 0;
  const missing = new Set<string>();
  for (const [user, h] of hoursByUser(shifts)) {
    const c = hourlyCost.get(user);
    if (c == null) missing.add(user);
    else total += h * c;
  }
  return { total: Math.round(total * 100) / 100, missing: [...missing] };
}

// ---------------------------------------------------------------------------
// Copertura per reparto e giorno
// ---------------------------------------------------------------------------

/**
 * Ore pianificate per reparto e giorno locale. Un turno a cavallo della mezzanotte viene ripartito sui due giorni
 * in proporzione; la pausa è distribuita in proporzione alla durata.
 */
export function coverageByDepartmentDay(shifts: ShiftLike[], tz: string): Map<string, Map<CivilDate, number>> {
  const out = new Map<string, Map<CivilDate, number>>();
  for (const s of shifts) {
    const dep = s.departmentId ?? "";
    const total = s.endsAt.getTime() - s.startsAt.getTime();
    if (total <= 0) continue;
    const net = shiftHours(s);
    let cursor = s.startsAt;
    let day = localDateOf(s.startsAt, tz);
    while (cursor < s.endsAt) {
      const nextMidnight = startOfCivilDay(addDays(day, 1), tz);
      const segEnd = nextMidnight < s.endsAt ? nextMidnight : s.endsAt;
      const share = (segEnd.getTime() - cursor.getTime()) / total;
      const byDay = out.get(dep) ?? new Map<CivilDate, number>();
      byDay.set(day, (byDay.get(day) ?? 0) + net * share);
      out.set(dep, byDay);
      cursor = segEnd;
      day = addDays(day, 1);
    }
  }
  return out;
}

/** Numero di persone in turno in un reparto a un certo istante. */
export function headcountAt(shifts: ShiftLike[], instant: Date, departmentId?: string | null): number {
  const people = new Set<string>();
  for (const s of shifts) {
    if (departmentId !== undefined && (s.departmentId ?? null) !== (departmentId ?? null)) continue;
    if (s.startsAt <= instant && s.endsAt > instant) people.add(s.userId);
  }
  return people.size;
}

// ---------------------------------------------------------------------------
// Avvisi (non bloccano: il responsabile decide)
// ---------------------------------------------------------------------------

export type ShiftWarningKind = "sovrapposizione" | "assenza" | "riposo" | "ore_settimana" | "indisponibile";

export interface ShiftWarning {
  kind: ShiftWarningKind;
  userId: string;
  /** turni coinvolti (vuoto per l'avviso sulle ore settimanali) */
  shiftIds: string[];
  message: string;
}

const overlaps = (a0: Date, a1: Date, b0: Date, b1: Date) => a0 < b1 && b0 < a1;

/** Coppie di turni della stessa persona che si sovrappongono. */
export function findOverlaps(shifts: ShiftLike[]): [ShiftLike, ShiftLike][] {
  const out: [ShiftLike, ShiftLike][] = [];
  const byUser = groupByUser(shifts);
  for (const list of byUser.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (b.startsAt >= a.endsAt) break; // ordinati per inizio
        if (overlaps(a.startsAt, a.endsAt, b.startsAt, b.endsAt)) out.push([a, b]);
      }
    }
  }
  return out;
}

/** Riposi tra turni consecutivi della stessa persona più brevi del minimo (ore). Turni sovrapposti esclusi. */
export function findShortRests(shifts: ShiftLike[], minRestHours: number): { before: ShiftLike; after: ShiftLike; restHours: number }[] {
  const out: { before: ShiftLike; after: ShiftLike; restHours: number }[] = [];
  for (const list of groupByUser(shifts).values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      const rest = (cur.startsAt.getTime() - prev.endsAt.getTime()) / HOUR;
      if (rest >= 0 && rest < minRestHours) out.push({ before: prev, after: cur, restHours: rest });
    }
  }
  return out;
}

function groupByUser(shifts: ShiftLike[]): Map<string, ShiftLike[]> {
  const m = new Map<string, ShiftLike[]>();
  for (const s of shifts) {
    const l = m.get(s.userId) ?? [];
    l.push(s);
    m.set(s.userId, l);
  }
  for (const l of m.values()) l.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return m;
}

function minutesOf(t: string): number {
  const [h, m] = parseHm(t);
  return h * 60 + m;
}

/** Il turno cade in un'indisponibilità dichiarata? (confronto sugli orari locali del giorno d'inizio e, se serve, del giorno dopo) */
export function hitsUnavailability(s: ShiftLike, u: UnavailabilityLike, tz: string): boolean {
  if (u.userId !== s.userId) return false;
  let day = localDateOf(s.startsAt, tz);
  const lastDay = localDateOf(new Date(s.endsAt.getTime() - 1), tz);
  for (let guard = 0; guard < 3; guard++) {
    const matches = u.onDate ? u.onDate === day : u.weekday != null && isoWeekdayOf(day) === u.weekday;
    if (matches) {
      const dayStart = startOfCivilDay(day, tz);
      const [uFrom, uTo] =
        u.fromTime && u.toTime
          ? [new Date(dayStart.getTime() + minutesOf(u.fromTime) * 60_000), new Date(dayStart.getTime() + minutesOf(u.toTime) * 60_000)]
          : [dayStart, startOfCivilDay(addDays(day, 1), tz)];
      if (overlaps(s.startsAt, s.endsAt, uFrom, uTo)) return true;
    }
    if (day === lastDay) break;
    day = addDays(day, 1);
  }
  return false;
}

/**
 * Tutti gli avvisi di pianificazione per un insieme di turni (di solito una settimana, più i turni a ridosso
 * per calcolare il riposo). `weekShiftIds` limita il conteggio delle ore settimanali ai turni della settimana.
 */
export function shiftWarnings(
  shifts: ShiftLike[],
  opts: {
    tz: string;
    rules?: Partial<ShiftRules>;
    absences?: AbsenceLike[];
    unavailability?: UnavailabilityLike[];
    weekShiftIds?: Set<string>;
  },
): ShiftWarning[] {
  const rules = { ...DEFAULT_SHIFT_RULES, ...opts.rules };
  const out: ShiftWarning[] = [];
  const { tz } = opts;

  for (const [a, b] of findOverlaps(shifts)) {
    out.push({ kind: "sovrapposizione", userId: a.userId, shiftIds: [a.id, b.id], message: "Turni sovrapposti per la stessa persona" });
  }
  for (const r of findShortRests(shifts, rules.minRestHours)) {
    out.push({
      kind: "riposo",
      userId: r.after.userId,
      shiftIds: [r.before.id, r.after.id],
      message: `Solo ${formatHours(r.restHours)} di riposo (minimo ${formatHours(rules.minRestHours)})`,
    });
  }
  for (const s of shifts) {
    for (const a of opts.absences ?? []) {
      if (a.userId === s.userId && overlaps(s.startsAt, s.endsAt, a.startsAt, a.endsAt)) {
        out.push({ kind: "assenza", userId: s.userId, shiftIds: [s.id], message: "Turno durante un'assenza approvata" });
        break;
      }
    }
    for (const u of opts.unavailability ?? []) {
      if (hitsUnavailability(s, u, tz)) {
        out.push({ kind: "indisponibile", userId: s.userId, shiftIds: [s.id], message: "La persona ha segnalato di non essere disponibile" });
        break;
      }
    }
  }
  const weekShifts = opts.weekShiftIds ? shifts.filter((s) => opts.weekShiftIds!.has(s.id)) : shifts;
  for (const [user, h] of hoursByUser(weekShifts)) {
    if (h > rules.maxWeekHours + 1e-9) {
      out.push({ kind: "ore_settimana", userId: user, shiftIds: [], message: `${formatHours(h)} in settimana (oltre ${formatHours(rules.maxWeekHours)})` });
    }
  }
  return out;
}

/** Indice veloce: turno → avvisi. */
export function warningsByShift(warnings: ShiftWarning[]): Map<string, ShiftWarning[]> {
  const m = new Map<string, ShiftWarning[]>();
  for (const w of warnings) for (const id of w.shiftIds) m.set(id, [...(m.get(id) ?? []), w]);
  return m;
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

/** La checklist va generata in quella data? */
export function checklistRunsOn(weekdays: number[], date: CivilDate): boolean {
  return weekdays.includes(isoWeekdayOf(date));
}

/** Descrizione dell'attività generata: un punto elenco per voce. Coerente con generate_daily_checklists(). */
export function checklistDescription(items: string[]): string {
  return items
    .map((i) => i.trim())
    .filter(Boolean)
    .map((i) => `• ${i}`)
    .join("\n");
}

/** Voci di una checklist da testo libero (una per riga, elenco puntato tollerato). */
export function parseChecklistItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, 200));
}
