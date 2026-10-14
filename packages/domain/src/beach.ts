// Logica di dominio del modulo Spiaggia (pura e testabile):
// generazione della mappa, scelta della tariffa e calcolo del prezzo, sovrapposizioni, occupazione.
// Le regole di prezzo e di sovrapposizione sono replicate nel database (migrazione 0800), che resta l'autorità.

import { addDays, type CivilDate } from "./time";

export type BeachKind = "ombrellone" | "lettino" | "cabina" | "gazebo";
export const BEACH_KINDS: BeachKind[] = ["ombrellone", "lettino", "cabina", "gazebo"];
export const BEACH_KIND_LABEL: Record<BeachKind, string> = {
  ombrellone: "Ombrellone",
  lettino: "Lettino",
  cabina: "Cabina",
  gazebo: "Gazebo",
};

export type BeachPeriod = "giornata" | "mattina" | "pomeriggio" | "settimana" | "mese" | "stagione";
export type BeachSlot = "intera" | "mattina" | "pomeriggio";

export const BEACH_PERIODS: Record<BeachPeriod, { label: string; slot: BeachSlot; flat: boolean }> = {
  giornata: { label: "Giornata", slot: "intera", flat: false },
  mattina: { label: "Mezza giornata (mattina)", slot: "mattina", flat: false },
  pomeriggio: { label: "Mezza giornata (pomeriggio)", slot: "pomeriggio", flat: false },
  settimana: { label: "Settimana", slot: "intera", flat: true },
  mese: { label: "Mese", slot: "intera", flat: true },
  stagione: { label: "Stagione", slot: "intera", flat: true },
};
export const BEACH_PERIOD_KEYS = Object.keys(BEACH_PERIODS) as BeachPeriod[];

/** Abbonamenti: periodi lunghi mostrati come «abbonato» sulla mappa. */
export const isSubscription = (p: BeachPeriod) => p === "mese" || p === "stagione";

export type BeachBookingStatus = "prenotata" | "presente" | "uscito" | "annullata" | "no_show";
/** Stati che occupano la postazione (gli stessi del vincolo di esclusione nel database). */
export const ACTIVE_BOOKING_STATUSES: BeachBookingStatus[] = ["prenotata", "presente"];

// ---------------------------------------------------------------------------
// Sovrapposizioni
// ---------------------------------------------------------------------------
export function slotsOverlap(a: BeachSlot, b: BeachSlot): boolean {
  return a === "intera" || b === "intera" || a === b;
}

/** Intervalli di date civili inclusivi [start, end]. */
export function dateRangesOverlap(aStart: CivilDate, aEnd: CivilDate, bStart: CivilDate, bEnd: CivilDate): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export interface BookingSpan {
  service_point_id: string;
  period: BeachPeriod;
  start_date: CivilDate;
  end_date: CivilDate;
  status: BeachBookingStatus;
}

/** Due prenotazioni sono in conflitto se occupano la stessa postazione in date e fasce che si sovrappongono. */
export function bookingsConflict(a: BookingSpan, b: BookingSpan): boolean {
  return (
    a.service_point_id === b.service_point_id &&
    ACTIVE_BOOKING_STATUSES.includes(a.status) &&
    ACTIVE_BOOKING_STATUSES.includes(b.status) &&
    dateRangesOverlap(a.start_date, a.end_date, b.start_date, b.end_date) &&
    slotsOverlap(BEACH_PERIODS[a.period].slot, BEACH_PERIODS[b.period].slot)
  );
}

/** Ultimo giorno di un mese di calendario a partire da start (es. 15/07 → 14/08). */
function addMonthMinusDay(start: CivilDate): CivilDate {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m, 1)); // primo del mese successivo
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
  const iso = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
  return addDays(iso, -1);
}

/** Data di fine proposta per un periodo (la stagione finisce dove finisce la tariffa, se nota). */
export function defaultEndDate(period: BeachPeriod, start: CivilDate, seasonEnd?: CivilDate | null): CivilDate {
  switch (period) {
    case "settimana":
      return addDays(start, 6);
    case "mese":
      return addMonthMinusDay(start);
    case "stagione":
      return seasonEnd && seasonEnd >= start ? seasonEnd : start;
    default:
      return start;
  }
}

/** Controlla che date e periodo siano coerenti; restituisce un messaggio in italiano o null. */
export function validatePeriodRange(period: BeachPeriod, start: CivilDate, end: CivilDate): string | null {
  if (end < start) return "La data di fine è precedente all'inizio";
  if (period === "settimana" && end !== addDays(start, 6)) return "Una settimana dura 7 giorni";
  if (period === "mese" && end !== addMonthMinusDay(start)) return "Un mese va dal giorno scelto al giorno prima del mese successivo";
  if (daysBetween(start, end) > 200) return "Il periodo è troppo lungo";
  return null;
}

export function daysBetween(start: CivilDate, end: CivilDate): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function eachDay(start: CivilDate, end: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Mappa: generazione di settori e file
// ---------------------------------------------------------------------------
export interface GridSpec {
  kind: BeachKind;
  zone: string; // settore (es. «A»)
  rowFrom: number;
  rowTo: number;
  perRow: number;
  seats: number; // lettini per elemento
  /** progressivo: 1, 2, 3… attraverso le file; per_fila: «1-01», «1-02»… */
  numbering: "progressivo" | "per_fila";
  prefix?: string; // es. «A» → A1, A2…
  startNumber?: number;
}

export interface PointDraft {
  kind: BeachKind;
  label: string;
  zone: string;
  row_label: string;
  pos_x: number;
  pos_y: number;
  seats: number;
}

export const GRID_LIMIT = 600;

export function validateGrid(spec: GridSpec): string | null {
  if (!spec.zone.trim()) return "Indica il nome del settore";
  if (!Number.isInteger(spec.rowFrom) || !Number.isInteger(spec.rowTo) || spec.rowFrom < 1 || spec.rowTo < spec.rowFrom) return "File non valide";
  if (!Number.isInteger(spec.perRow) || spec.perRow < 1 || spec.perRow > 100) return "Gli elementi per fila devono essere tra 1 e 100";
  if (!Number.isInteger(spec.seats) || spec.seats < 0 || spec.seats > 20) return "Lettini per elemento non validi";
  if ((spec.rowTo - spec.rowFrom + 1) * spec.perRow > GRID_LIMIT) return `Puoi creare al massimo ${GRID_LIMIT} elementi alla volta`;
  return null;
}

/**
 * Genera gli elementi di un settore: pos_x = posizione nella fila (1…perRow), pos_y = numero di fila
 * (fila 1 = prima fila, la più vicina al mare). Le etichette già esistenti vengono segnalate, non duplicate.
 */
export function generateGrid(spec: GridSpec, existingLabels: Iterable<string> = []): { points: PointDraft[]; duplicates: string[] } {
  const taken = new Set(existingLabels);
  const prefix = spec.prefix?.trim() ?? "";
  const width = String(spec.perRow).length;
  const points: PointDraft[] = [];
  const duplicates: string[] = [];
  let n = spec.startNumber && spec.startNumber > 0 ? spec.startNumber : 1;
  for (let row = spec.rowFrom; row <= spec.rowTo; row++) {
    for (let i = 1; i <= spec.perRow; i++) {
      const label = spec.numbering === "per_fila" ? `${prefix}${row}-${String(i).padStart(width, "0")}` : `${prefix}${n}`;
      n++;
      if (taken.has(label)) {
        duplicates.push(label);
        continue;
      }
      taken.add(label);
      points.push({ kind: spec.kind, label, zone: spec.zone.trim(), row_label: String(row), pos_x: i, pos_y: row, seats: spec.seats });
    }
  }
  return { points, duplicates };
}

/** Prossimo numero libero per la numerazione progressiva (etichette «prefisso + numero»). */
export function nextProgressive(existingLabels: Iterable<string>, prefix = ""): number {
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`);
  for (const l of existingLabels) {
    const m = re.exec(l);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Listino: scelta della tariffa e prezzo
// ---------------------------------------------------------------------------
export interface BeachRate {
  id: string;
  kind: BeachKind;
  zone: string | null;
  row_label: string | null;
  period: BeachPeriod;
  valid_from: CivilDate;
  valid_to: CivilDate;
  price: number;
  extra_lettino_price: number;
  included_lettini: number;
  active: boolean;
  created_at?: string;
}

export interface RatedPoint {
  kind: string;
  zone: string | null;
  row_label: string | null;
}

/** Quanto è specifica una tariffa: fila (con settore) > settore > tutta la spiaggia. */
export function rateSpecificity(r: Pick<BeachRate, "zone" | "row_label">): number {
  return (r.row_label != null ? 2 : 0) + (r.zone != null ? 1 : 0);
}

export function rateApplies(r: BeachRate, point: RatedPoint, period: BeachPeriod, date: CivilDate): boolean {
  return (
    r.active &&
    r.kind === point.kind &&
    r.period === period &&
    r.valid_from <= date &&
    date <= r.valid_to &&
    (r.zone == null || r.zone === point.zone) &&
    (r.row_label == null || r.row_label === point.row_label)
  );
}

/** Tariffa da applicare: la più specifica; a parità, quella con inizio validità più recente, poi la più recente. */
export function pickRate(rates: BeachRate[], point: RatedPoint, period: BeachPeriod, date: CivilDate): BeachRate | null {
  let best: BeachRate | null = null;
  for (const r of rates) {
    if (!rateApplies(r, point, period, date)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const s = rateSpecificity(r) - rateSpecificity(best);
    if (s > 0 || (s === 0 && (r.valid_from > best.valid_from || (r.valid_from === best.valid_from && (r.created_at ?? "") > (best.created_at ?? ""))))) {
      best = r;
    }
  }
  return best;
}

export interface QuoteLine {
  date: CivilDate;
  rateId: string;
  base: number;
  extraLettini: number;
  amount: number;
}
export type Quote = { ok: true; total: number; lines: QuoteLine[] } | { ok: false; error: string; missingDate: CivilDate };

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Prezzo da listino. Giornata e mezze giornate: somma giorno per giorno (la tariffa può cambiare tra alta e bassa stagione).
 * Settimana, mese, stagione: prezzo fisso della tariffa valida il primo giorno.
 * Lettini oltre quelli inclusi: prezzo extra per giorno (o per periodo, se a prezzo fisso).
 */
export function quotePrice(rates: BeachRate[], point: RatedPoint, period: BeachPeriod, start: CivilDate, end: CivilDate, lettini: number): Quote {
  const days = BEACH_PERIODS[period].flat ? [start] : eachDay(start, end);
  const lines: QuoteLine[] = [];
  for (const d of days) {
    const r = pickRate(rates, point, period, d);
    if (!r) return { ok: false, error: `Nessuna tariffa «${BEACH_PERIODS[period].label}» per ${point.kind} il ${d}`, missingDate: d };
    const extra = Math.max(lettini - r.included_lettini, 0);
    lines.push({ date: d, rateId: r.id, base: Number(r.price), extraLettini: extra, amount: round2(Number(r.price) + extra * Number(r.extra_lettino_price)) });
  }
  return { ok: true, total: round2(lines.reduce((s, l) => s + l.amount, 0)), lines };
}

export function balanceDue(total: number, paid: number): number {
  return round2(Math.max(total - paid, 0));
}

// ---------------------------------------------------------------------------
// Giornata: stato delle postazioni e occupazione
// ---------------------------------------------------------------------------
export type PointState = "libero" | "prenotato" | "presente" | "abbonato" | "fuori_servizio";
export const POINT_STATE_LABEL: Record<PointState, string> = {
  libero: "Libero",
  prenotato: "Prenotato",
  presente: "Presente",
  abbonato: "Abbonato",
  fuori_servizio: "Fuori servizio",
};

export interface MapPoint {
  id: string;
  kind: string;
  label: string;
  zone: string | null;
  row_label: string | null;
  pos_x: number | null;
  pos_y: number | null;
  active: boolean;
}

export interface DayBooking extends BookingSpan {
  id: string;
  /** Ha fatto check-in nel giorno considerato e non è ancora uscito */
  presentOnDay: boolean;
}

export interface PointDay {
  state: PointState;
  bookings: DayBooking[];
  /** Fasce libere residue quando la postazione è occupata solo per mezza giornata */
  freeSlot: BeachSlot | null;
}

export function pointStates(points: MapPoint[], bookings: DayBooking[], outOfService: Set<string>, date: CivilDate): Map<string, PointDay> {
  const byPoint = new Map<string, DayBooking[]>();
  for (const b of bookings) {
    if (!ACTIVE_BOOKING_STATUSES.includes(b.status)) continue;
    if (!(b.start_date <= date && date <= b.end_date)) continue;
    const arr = byPoint.get(b.service_point_id) ?? [];
    arr.push(b);
    byPoint.set(b.service_point_id, arr);
  }
  const out = new Map<string, PointDay>();
  for (const p of points) {
    const bs = byPoint.get(p.id) ?? [];
    let state: PointState;
    if (bs.some((b) => b.presentOnDay)) state = "presente";
    else if (outOfService.has(p.id)) state = "fuori_servizio";
    else if (bs.some((b) => isSubscription(b.period))) state = "abbonato";
    else if (bs.length > 0) state = "prenotato";
    else state = "libero";
    const slots = bs.map((b) => BEACH_PERIODS[b.period].slot);
    let freeSlot: BeachSlot | null = null;
    if (slots.length === 0) freeSlot = "intera";
    else if (!slots.includes("intera")) {
      if (!slots.includes("mattina")) freeSlot = "mattina";
      else if (!slots.includes("pomeriggio")) freeSlot = "pomeriggio";
    }
    out.set(p.id, { state, bookings: bs, freeSlot });
  }
  return out;
}

export interface Occupancy {
  total: number;
  occupied: number;
  present: number;
  outOfService: number;
  pct: number;
}

/** Occupazione: postazioni in servizio occupate (prenotate, presenti o in abbonamento) sul totale in servizio. */
export function occupancy(points: MapPoint[], states: Map<string, PointDay>): { all: Occupancy; bySector: (Occupancy & { zone: string })[] } {
  const acc = new Map<string, Occupancy>();
  const all: Occupancy = { total: 0, occupied: 0, present: 0, outOfService: 0, pct: 0 };
  for (const p of points) {
    if (!p.active) continue;
    const s = states.get(p.id);
    if (!s) continue;
    const zone = p.zone ?? "Senza settore";
    const z = acc.get(zone) ?? { total: 0, occupied: 0, present: 0, outOfService: 0, pct: 0 };
    for (const o of [z, all]) {
      if (s.state === "fuori_servizio") {
        o.outOfService++;
        continue;
      }
      o.total++;
      if (s.state !== "libero") o.occupied++;
      if (s.state === "presente") o.present++;
    }
    acc.set(zone, z);
  }
  const pct = (o: Occupancy) => ({ ...o, pct: o.total === 0 ? 0 : Math.round((o.occupied / o.total) * 100) });
  return {
    all: pct(all),
    bySector: [...acc.entries()].sort(([a], [b]) => a.localeCompare(b, "it", { numeric: true })).map(([zone, o]) => ({ zone, ...pct(o) })),
  };
}

/** Raggruppa le postazioni per settore e fila, ordinate per posizione, per disegnare la mappa a griglia. */
export function mapLayout<T extends MapPoint>(points: T[]): { zone: string; rows: { row: string; points: T[] }[] }[] {
  const zones = new Map<string, Map<string, T[]>>();
  for (const p of points) {
    const z = p.zone ?? "Altro";
    const r = p.row_label ?? "";
    if (!zones.has(z)) zones.set(z, new Map());
    const rows = zones.get(z)!;
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(p);
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, "it", { numeric: true });
  return [...zones.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([zone, rows]) => ({
      zone,
      rows: [...rows.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([row, pts]) => ({ row, points: pts.sort((a, b) => (a.pos_x ?? 0) - (b.pos_x ?? 0) || cmp(a.label, b.label)) })),
    }));
}
