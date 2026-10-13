import { addDays, isoWeekdayOf, todayIn, zonedTimeToUtc, type CivilDate } from "./time";

export interface SupplierSchedule {
  /** Giorni di consegna ISO: 1 = lunedì … 7 = domenica */
  deliveryWeekdays: number[];
  /** Ora limite "HH:MM" (o "HH:MM:SS") nel fuso della struttura, del giorno d'ordine */
  cutoffTime: string;
  /** Giorni tra il giorno d'ordine e la consegna (1 = ordina oggi entro il cut-off, consegna domani) */
  leadDays: number;
}

export interface OrderWindow {
  deliveryDate: CivilDate;
  orderBy: Date; // istante UTC entro cui inviare l'ordine
}

/**
 * Prossime finestre d'ordine utili: per ogni giorno di consegna, l'ordine va inviato
 * entro il cut-off di (consegna − leadDays). Restituisce le finestre non ancora scadute, in ordine.
 */
export function upcomingOrderWindows(s: SupplierSchedule, tz: string, now: Date = new Date(), count = 3): OrderWindow[] {
  if (s.deliveryWeekdays.length === 0) return [];
  const [hh, mm] = s.cutoffTime.split(":").map(Number) as [number, number];
  const out: OrderWindow[] = [];
  const today = todayIn(tz, now);
  for (let i = 0; i <= 60 && out.length < count; i++) {
    const delivery = addDays(today, i);
    if (!s.deliveryWeekdays.includes(isoWeekdayOf(delivery))) continue;
    const orderDay = addDays(delivery, -Math.max(0, s.leadDays));
    const [y, m, d] = orderDay.split("-").map(Number) as [number, number, number];
    const orderBy = zonedTimeToUtc(y, m, d, hh, mm, tz);
    if (orderBy.getTime() > now.getTime()) out.push({ deliveryDate: delivery, orderBy });
  }
  return out;
}

export function nextOrderWindow(s: SupplierSchedule, tz: string, now: Date = new Date()): OrderWindow | null {
  return upcomingOrderWindows(s, tz, now, 1)[0] ?? null;
}

export type Urgency = "scaduto" | "critico" | "oggi" | "prossimo";

/** Urgenza di una scadenza rispetto ad adesso: < 2 ore = critico, stesso giorno = oggi. */
export function deadlineUrgency(deadline: Date, tz: string, now: Date = new Date()): Urgency {
  const diff = deadline.getTime() - now.getTime();
  if (diff <= 0) return "scaduto";
  if (diff <= 2 * 3600_000) return "critico";
  if (todayIn(tz, deadline) === todayIn(tz, now)) return "oggi";
  return "prossimo";
}

export interface ReorderInput {
  onHand: number;
  minQty: number;
  parQty: number;
  /** Quantità già in arrivo (ordini inviati non ancora ricevuti), in unità base */
  incoming?: number;
  /** Unità base per confezione del fornitore */
  packQty?: number;
}

export interface ReorderSuggestion {
  needed: boolean;
  qtyBase: number;
  packs: number;
}

/** Sotto scorta (giacenza + in arrivo ≤ minimo) → riporta al livello di riordino, arrotondando alle confezioni. */
export function reorderSuggestion({ onHand, minQty, parQty, incoming = 0, packQty = 1 }: ReorderInput): ReorderSuggestion {
  const available = onHand + incoming;
  if (minQty <= 0 || available > minQty) return { needed: false, qtyBase: 0, packs: 0 };
  const target = Math.max(parQty, minQty);
  const qtyBase = Math.max(0, target - available);
  const pack = packQty > 0 ? packQty : 1;
  const packs = Math.ceil(qtyBase / pack - 1e-9);
  return { needed: qtyBase > 0, qtyBase: packs * pack, packs };
}

export interface PriceChange {
  previous: number;
  current: number;
  pct: number;
  direction: "aumento" | "calo" | "invariato";
  anomalous: boolean;
}

/** Variazione di prezzo; anomala oltre la soglia (default 5%). */
export function priceChange(previous: number, current: number, thresholdPct = 5): PriceChange {
  if (previous <= 0) return { previous, current, pct: 0, direction: "invariato", anomalous: false };
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return {
    previous,
    current,
    pct: rounded,
    direction: rounded > 0 ? "aumento" : rounded < 0 ? "calo" : "invariato",
    anomalous: Math.abs(pct) >= thresholdPct,
  };
}

/** Costo per unità base a partire dal prezzo a confezione. */
export function unitCost(packPrice: number, packQty: number): number {
  return packQty > 0 ? packPrice / packQty : packPrice;
}

/** Costo medio ponderato dopo un carico. */
export function weightedAverageCost(prevAvg: number, prevQty: number, inCost: number, inQty: number): number {
  const base = Math.max(prevQty, 0);
  const total = base + inQty;
  if (total <= 0) return inCost;
  return (prevAvg * base + inCost * inQty) / total;
}
