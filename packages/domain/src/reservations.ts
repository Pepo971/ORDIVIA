// Logica di dominio del modulo Prenotazioni e Clienti (pura e testabile).
// Le regole di capacità replicano quelle del database (app.res_day_slots / app.res_peak_load):
// il database decide, qui servono anteprime nell'interfaccia e i testi.

import { isoWeekdayOf, type CivilDate } from "./time";

// ---------------------------------------------------------------------------
// Etichette
// ---------------------------------------------------------------------------
export const RESERVATION_STATUSES = ["in_attesa_conferma", "confermata", "arrivata", "completata", "no_show", "annullata"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = ["in_attesa_conferma", "confermata", "arrivata"];

export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  in_attesa_conferma: "Da confermare",
  confermata: "Confermata",
  arrivata: "Arrivata",
  completata: "Completata",
  no_show: "Non presentato",
  annullata: "Annullata",
};

/** Passaggi di stato consentiti (stessa tabella di public.res_set_status). */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  in_attesa_conferma: ["confermata", "arrivata", "annullata", "no_show"],
  confermata: ["arrivata", "annullata", "no_show"],
  arrivata: ["completata", "confermata"],
  completata: ["arrivata"],
  no_show: ["confermata"],
  annullata: ["confermata"],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

export const RESERVATION_SOURCES = ["telefono", "walk-in", "sito", "whatsapp", "email", "portale"] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];
export const RESERVATION_SOURCE_LABEL: Record<ReservationSource, string> = {
  telefono: "Telefono",
  "walk-in": "Walk-in",
  sito: "Sito",
  whatsapp: "WhatsApp",
  email: "Email",
  portale: "Portale",
};

export const SERVICE_KINDS = ["ristorante", "aperitivo", "pizzeria", "evento", "degustazione", "pacchetto", "servizio"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  ristorante: "Ristorante",
  aperitivo: "Aperitivo",
  pizzeria: "Pizzeria",
  evento: "Evento",
  degustazione: "Degustazione",
  pacchetto: "Pacchetto",
  servizio: "Servizio (spa, piscina, navetta…)",
};

export const CONSENT_SOURCES = ["reception", "telefono", "email", "whatsapp", "portale", "sito", "modulo_firmato", "importazione"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
export const CONSENT_SOURCE_LABEL: Record<ConsentSource, string> = {
  reception: "Reception / di persona",
  telefono: "Telefono",
  email: "Email",
  whatsapp: "WhatsApp",
  portale: "Portale QR",
  sito: "Sito web",
  modulo_firmato: "Modulo firmato",
  importazione: "Importazione",
};

// ---------------------------------------------------------------------------
// Orari
// ---------------------------------------------------------------------------
/** "19:30" → 1170. Restituisce null se non valido. */
export function parseHm(v: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Fasce e capacità
// ---------------------------------------------------------------------------
export interface WeeklySlotRule {
  weekday: number; // 1 = lunedì … 7 = domenica
  start_time: string; // HH:MM
  end_time: string; // HH:MM (ultimo arrivo)
  interval_min: number;
  capacity: number;
  max_party?: number | null;
}

export interface ServiceConfig {
  duration_min: number;
  max_party_size: number;
  event_date?: CivilDate | null;
  event_time?: string | null;
  event_capacity?: number | null;
}

export interface DateException {
  service_id: string | null; // null = tutta la struttura
  on_date: CivilDate;
  closed: boolean;
  capacity: number | null;
}

export interface DaySlot {
  time: string; // HH:MM
  minutes: number;
  capacity: number;
  maxParty: number;
}

/** Fasce di un giorno: regole settimanali (o evento a data unica), chiusure e capacità eccezionali. */
export function generateDaySlots(
  service: ServiceConfig & { id?: string },
  rules: readonly WeeklySlotRule[],
  date: CivilDate,
  exceptions: readonly DateException[] = [],
): DaySlot[] {
  const today = exceptions.filter((e) => e.on_date === date && (e.service_id == null || e.service_id === service.id));
  if (today.some((e) => e.closed)) return [];
  const override = today.find((e) => !e.closed && e.service_id != null && e.capacity != null)?.capacity ?? null;

  if (service.event_date) {
    if (service.event_date !== date || !service.event_time || service.event_capacity == null) return [];
    const minutes = parseHm(service.event_time.slice(0, 5));
    if (minutes == null) return [];
    const cap = override ?? service.event_capacity;
    return [{ time: formatHm(minutes), minutes, capacity: cap, maxParty: Math.min(service.max_party_size, cap) }];
  }

  const wd = isoWeekdayOf(date);
  const byTime = new Map<number, DaySlot>();
  for (const r of rules) {
    if (r.weekday !== wd) continue;
    const from = parseHm(r.start_time.slice(0, 5));
    const to = parseHm(r.end_time.slice(0, 5));
    if (from == null || to == null || to < from || r.interval_min <= 0) continue;
    for (let t = from; t <= to; t += r.interval_min) {
      const cap = override ?? r.capacity;
      const maxParty = Math.min(r.max_party ?? service.max_party_size, service.max_party_size, cap);
      const prev = byTime.get(t);
      byTime.set(t, {
        time: formatHm(t),
        minutes: t,
        capacity: Math.max(prev?.capacity ?? 0, cap),
        maxParty: Math.max(prev?.maxParty ?? 0, maxParty),
      });
    }
  }
  return [...byTime.values()].sort((a, b) => a.minutes - b.minutes);
}

export interface SeatOccupancy {
  start: number; // minuti dalla mezzanotte (o qualunque scala coerente)
  end: number;
  party: number;
}

/** Due intervalli semiaperti [a, b) si sovrappongono? */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Picco di presenze contemporanee nell'intervallo [from, to). */
export function peakLoad(bookings: readonly SeatOccupancy[], from: number, to: number): number {
  const active = bookings.filter((b) => intervalsOverlap(b.start, b.end, from, to));
  const points = [from, ...active.map((b) => b.start).filter((s) => s > from)];
  let peak = 0;
  for (const p of points) {
    const load = active.reduce((sum, b) => (b.start <= p && b.end > p ? sum + b.party : sum), 0);
    if (load > peak) peak = load;
  }
  return peak;
}

export interface SlotAvailability extends DaySlot {
  booked: number;
  available: number;
}

export function slotAvailability(slots: readonly DaySlot[], bookings: readonly SeatOccupancy[], durationMin: number): SlotAvailability[] {
  return slots.map((s) => {
    const booked = peakLoad(bookings, s.minutes, s.minutes + durationMin);
    return { ...s, booked, available: Math.max(s.capacity - booked, 0) };
  });
}

/** Esito di una richiesta (stessi messaggi del database, per anteprima). */
export function checkRequest(
  slots: readonly DaySlot[],
  bookings: readonly SeatOccupancy[],
  durationMin: number,
  minutes: number,
  party: number,
): { ok: true } | { ok: false; reason: "chiuso" | "gruppo" | "pieno"; available?: number } {
  const slot = [...slots].reverse().find((s) => s.minutes <= minutes && minutes - s.minutes < durationMin);
  if (!slot) return { ok: false, reason: "chiuso" };
  if (party > slot.maxParty) return { ok: false, reason: "gruppo" };
  const booked = peakLoad(bookings, minutes, minutes + durationMin);
  if (booked + party > slot.capacity) return { ok: false, reason: "pieno", available: Math.max(slot.capacity - booked, 0) };
  return { ok: true };
}

/** Livello di riempimento per colorare la timeline. */
export function loadLevel(booked: number, capacity: number): "vuoto" | "basso" | "medio" | "alto" | "pieno" {
  if (capacity <= 0 || booked >= capacity) return "pieno";
  const r = booked / capacity;
  if (r === 0) return "vuoto";
  if (r < 0.5) return "basso";
  if (r < 0.85) return "medio";
  return "alto";
}

// ---------------------------------------------------------------------------
// Recapiti e doppioni
// ---------------------------------------------------------------------------
/**
 * Normalizza un numero di telefono in formato internazionale (E.164), con l'Italia come predefinita.
 * Stessa regola di app.norm_phone(): "333 123 4567" → "+393331234567", "0039 06 1234567" → "+39061234567",
 * "+44 20 7946 0958" → "+442079460958". Restituisce null se non è un numero plausibile.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("+")) {
    s = "+" + s.replace(/\D/g, "");
  } else {
    s = s.replace(/\D/g, "");
    if (s.startsWith("00")) s = "+" + s.slice(2);
    else if (s.startsWith("39") && s.length >= 11) s = "+" + s;
    else if (/^[03]/.test(s)) s = "+39" + s;
    else if (s.length >= 11) s = "+" + s;
    else s = "+39" + s;
  }
  return /^\+\d{6,15}$/.test(s) ? s : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 160 ? s : null;
}

/** Numero per i link wa.me (solo cifre, con prefisso internazionale). */
export function waDigits(raw: string | null | undefined): string | null {
  const p = normalizePhone(raw);
  return p ? p.slice(1) : null;
}

/** Nome confrontabile: minuscolo, senza accenti, spazi e punteggiatura; ordine delle parole irrilevante. */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export interface CustomerLike {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
}

export type DuplicateReason = "telefono" | "email" | "nome";

/** Coppie di schede probabilmente duplicate (stesso telefono normalizzato, stessa email o stesso nome). */
export function findDuplicates<T extends CustomerLike>(list: readonly T[]): { a: T; b: T; reason: DuplicateReason }[] {
  const out: { a: T; b: T; reason: DuplicateReason }[] = [];
  const seen = new Set<string>();
  const keys = list.map((c) => ({ c, phone: normalizePhone(c.phone), email: normalizeEmail(c.email), name: nameKey(c.full_name) }));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const x = keys[i]!;
      const y = keys[j]!;
      let reason: DuplicateReason | null = null;
      if (x.phone && x.phone === y.phone) reason = "telefono";
      else if (x.email && x.email === y.email) reason = "email";
      else if (x.name.replace(/ /g, "").length >= 6 && x.name === y.name) reason = "nome";
      if (!reason) continue;
      const k = [x.c.id, y.c.id].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ a: x.c, b: y.c, reason });
    }
  }
  return out;
}

/** Cerca una scheda esistente con lo stesso telefono o email (prima il telefono, come nel database). */
export function matchCustomer<T extends CustomerLike>(list: readonly T[], phone?: string | null, email?: string | null): T | null {
  const p = normalizePhone(phone);
  const e = normalizeEmail(email);
  if (p) {
    const hit = list.find((c) => normalizePhone(c.phone) === p);
    if (hit) return hit;
  }
  if (e) {
    const hit = list.find((c) => normalizeEmail(c.email) === e);
    if (hit) return hit;
  }
  return null;
}

/** Elenco breve pulito (allergie, tag): minuscolo, senza vuoti e doppioni, max 20 voci. */
export function cleanList(items: readonly string[] | string | null | undefined): string[] {
  const arr = typeof items === "string" ? items.split(/[,;\n]/) : (items ?? []);
  const out: string[] = [];
  for (const raw of arr) {
    const v = raw.trim().slice(0, 60).toLowerCase();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Segmenti
// ---------------------------------------------------------------------------
export interface SegmentFilters {
  q?: string;
  tags?: string[];
  minVisits?: number;
  lastVisitAfter?: CivilDate;
  lastVisitBefore?: CivilDate;
  marketing?: boolean;
  minSpend?: number;
}

/** Filtri da query string (e da segmento salvato), validati. */
export function parseSegmentFilters(src: Record<string, unknown>): SegmentFilters {
  const str = (k: string) => (typeof src[k] === "string" ? (src[k] as string).trim() : undefined);
  const date = (k: string) => {
    const v = str(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
  };
  const int = (k: string) => {
    const v = src[k];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.floor(n) : undefined;
  };
  const tagsRaw = src.tags;
  const tags = cleanList(Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === "string") : typeof tagsRaw === "string" ? tagsRaw : []);
  const m = src.marketing;
  const marketing = m === true || m === "1" || m === "si" ? true : m === false || m === "0" || m === "no" ? false : undefined;
  const f: SegmentFilters = {};
  const q = str("q");
  if (q) f.q = q.slice(0, 80);
  if (tags.length) f.tags = tags;
  const mv = int("minVisits");
  if (mv) f.minVisits = mv;
  const la = date("lastVisitAfter");
  if (la) f.lastVisitAfter = la;
  const lb = date("lastVisitBefore");
  if (lb) f.lastVisitBefore = lb;
  if (marketing != null) f.marketing = marketing;
  const ms = int("minSpend");
  if (ms) f.minSpend = ms;
  return f;
}

/** Filtri → query string (per i link dei segmenti salvati). */
export function segmentQuery(f: SegmentFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.tags?.length) p.set("tags", f.tags.join(","));
  if (f.minVisits) p.set("minVisits", String(f.minVisits));
  if (f.lastVisitAfter) p.set("lastVisitAfter", f.lastVisitAfter);
  if (f.lastVisitBefore) p.set("lastVisitBefore", f.lastVisitBefore);
  if (f.marketing != null) p.set("marketing", f.marketing ? "1" : "0");
  if (f.minSpend) p.set("minSpend", String(f.minSpend));
  return p.toString();
}

/** Frequenza di visita in parole. */
export function frequencyLabel(visits: number): string {
  if (visits <= 0) return "Mai venuto";
  if (visits === 1) return "Prima visita";
  if (visits < 5) return "Occasionale";
  return "Abituale";
}

// ---------------------------------------------------------------------------
// Promemoria
// ---------------------------------------------------------------------------
export interface ReminderInput {
  guestName: string;
  facilityName: string;
  serviceName: string;
  date: CivilDate;
  time: string; // HH:MM
  partySize: number;
  depositDue?: number | null;
  cancellationPolicy?: string | null;
  confirmNeeded?: boolean;
}

function italianDate(date: CivilDate): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("it-IT", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Testo del promemoria (WhatsApp/email), in italiano, senza dati superflui. */
export function reminderText(r: ReminderInput): string {
  const first = r.guestName.trim().split(/\s+/)[0] || r.guestName.trim();
  const people = r.partySize === 1 ? "1 persona" : `${r.partySize} persone`;
  const lines = [
    `Buongiorno ${first},`,
    `le ricordiamo la prenotazione da ${r.facilityName}: ${r.serviceName}, ${italianDate(r.date)} alle ${r.time}, per ${people}.`,
  ];
  if (r.depositDue && r.depositDue > 0) {
    lines.push(`È previsto un acconto di ${new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(r.depositDue)}.`);
  }
  if (r.cancellationPolicy) lines.push(r.cancellationPolicy.trim());
  lines.push(r.confirmNeeded ? "Può confermarci la presenza rispondendo a questo messaggio?" : "Se non potesse venire, ce lo faccia sapere rispondendo a questo messaggio.");
  lines.push("A presto!");
  return lines.join("\n");
}

export function reminderWhatsappLink(phone: string | null | undefined, text: string): string | null {
  const n = waDigits(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

export function reminderMailtoLink(email: string | null | undefined, subject: string, text: string): string | null {
  const e = normalizeEmail(email);
  return e ? `mailto:${e}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` : null;
}
