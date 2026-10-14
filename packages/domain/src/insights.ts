// Numeri: periodi di confronto, assistente operativo a regole (spiegabile) e pianificatore delle preparazioni.
// Logica pura e testabile: i dati arrivano dalle RPC analytics_* (vedi supabase/migrations/20261014001400_analytics.sql).

import { nextOrderWindow } from "./purchasing";
import { addDays, type CivilDate } from "./time";

// ---------------------------------------------------------------------------
// Periodi
// ---------------------------------------------------------------------------

export type PeriodKey = "oggi" | "ieri" | "7g" | "30g" | "stagione" | "personalizzato";

export interface Period {
  key: PeriodKey;
  label: string;
  from: CivilDate;
  to: CivilDate;
  days: number;
  /** Periodo precedente equivalente (stessa durata subito prima; per la stagione: stesse date dell'anno prima) */
  prev: { from: CivilDate; to: CivilDate; label: string };
}

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: "oggi", label: "Oggi" },
  { key: "ieri", label: "Ieri" },
  { key: "7g", label: "7 giorni" },
  { key: "30g", label: "30 giorni" },
  { key: "stagione", label: "Stagione" },
  { key: "personalizzato", label: "Personalizzato" },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function civilDaysBetween(from: CivilDate, to: CivilDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function isValidDate(d: string | undefined | null): d is CivilDate {
  if (!d || !ISO_DATE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

function shiftYear(d: CivilDate, years: number): CivilDate {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Periodo massimo interrogabile (deve restare allineato al limite delle RPC). */
export const MAX_PERIOD_DAYS = 366;

/**
 * Risolve il periodo scelto. La stagione va dal 1° maggio al 30 settembre (fino a oggi se in corso;
 * prima di maggio si guarda la stagione dell'anno scorso) ed è confrontata con le stesse date dell'anno prima.
 */
export function resolvePeriod(key: string | undefined, today: CivilDate, custom?: { from?: string; to?: string }): Period {
  const k: PeriodKey = (PERIOD_OPTIONS.find((o) => o.key === key)?.key ?? "7g") as PeriodKey;
  let from: CivilDate;
  let to: CivilDate;
  let label: string;
  switch (k) {
    case "oggi":
      from = to = today;
      label = "Oggi";
      break;
    case "ieri":
      from = to = addDays(today, -1);
      label = "Ieri";
      break;
    case "30g":
      from = addDays(today, -29);
      to = today;
      label = "Ultimi 30 giorni";
      break;
    case "stagione": {
      const year = Number(today.slice(0, 4));
      const y = today < `${year}-05-01` ? year - 1 : year;
      from = `${y}-05-01`;
      const end = `${y}-09-30`;
      to = end < today ? end : today;
      label = `Stagione ${y}`;
      break;
    }
    case "personalizzato": {
      const f = isValidDate(custom?.from) ? custom!.from! : addDays(today, -6);
      const t = isValidDate(custom?.to) ? custom!.to! : today;
      from = f <= t ? f : t;
      to = f <= t ? t : f;
      if (civilDaysBetween(from, to) >= MAX_PERIOD_DAYS) from = addDays(to, -(MAX_PERIOD_DAYS - 1));
      label = "Personalizzato";
      break;
    }
    default:
      from = addDays(today, -6);
      to = today;
      label = "Ultimi 7 giorni";
  }
  const days = civilDaysBetween(from, to) + 1;
  const prev =
    k === "stagione"
      ? { from: shiftYear(from, -1), to: shiftYear(to, -1), label: "stessa stagione dell'anno scorso" }
      : k === "oggi"
        ? { from: addDays(from, -7), to: addDays(to, -7), label: "stesso giorno della settimana scorsa" }
        : k === "ieri"
          ? { from: addDays(from, -7), to: addDays(to, -7), label: "stesso giorno della settimana prima" }
          : { from: addDays(from, -days), to: addDays(from, -1), label: `${days} giorni precedenti` };
  return { key: k, label, from, to, days, prev };
}

/** Variazione percentuale; null se manca la base di confronto (mai un numero inventato). */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Segnali (forma del JSON restituito da analytics_insight_signals)
// ---------------------------------------------------------------------------

export interface StockSignal {
  product_id: string;
  name: string;
  unit: string;
  on_hand: number;
  daily_use: number;
  incoming: number;
  supplier: { id: string; name: string; delivery_weekdays: number[]; cutoff_time: string; lead_days: number } | null;
}
export interface PriceIncreaseSignal {
  product_id: string;
  product: string;
  unit: string;
  supplier_id: string;
  supplier: string;
  pack_label: string;
  old_price: number;
  new_price: number;
  observed_at: string;
  increase_pct: number;
  monthly_impact: number;
}
export interface FoodCostSignal {
  menu_item_id: string;
  name: string;
  target: number;
  portion_cost: number;
  missing: number;
  qty_28d: number;
  net_28d: number;
  food_cost_pct: number | null;
}
export interface WasteSignal {
  product_id: string;
  name: string;
  unit: string;
  cur: number;
  prev: number;
  cur_movements: number;
  cur_value: number | null;
  prev_value: number | null;
}
export interface StaffDaySignal {
  date: CivilDate;
  planned_hours: number;
  forecast_covers: number | null;
  booked_covers: number | null;
}
export interface KitchenSignal {
  station_id: string;
  name: string;
  lines: number;
  avg_ready_min: number;
  p90_ready_min: number;
}
export interface HaccpSignal {
  equipment_id: string;
  name: string;
  out_count: number;
  without_action: number;
  last_at: string;
}
export interface MaintenanceSignal {
  label: string;
  kind: string | null;
  count: number;
  open: number;
}
export interface InsightFeedback {
  key: string;
  action: "ignorato" | "rimandato";
  until: string;
}

export interface InsightSignals {
  generated_at?: string;
  today: CivilDate;
  timezone: string;
  finance: boolean;
  ticket_target_minutes: number;
  stock: StockSignal[];
  price_increases: PriceIncreaseSignal[] | null;
  food_cost: FoodCostSignal[] | null;
  margin: { cur: { net: number; cost: number }; prev: { net: number; cost: number } } | null;
  waste: WasteSignal[];
  staffing: { hist_covers: number; hist_hours: number; days: StaffDaySignal[] } | null;
  kitchen: KitchenSignal[];
  haccp: HaccpSignal[];
  maintenance: MaintenanceSignal[];
  labels: { expired: number; expiring_24h: number } | null;
  customers: { count: number; min_days: number; max_days: number } | null;
  feedback: InsightFeedback[];
}

/** Normalizza il JSON delle RPC (numeric → number, array mancanti → []). */
export function normalizeSignals(raw: unknown): InsightSignals {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (v == null ? 0 : Number(v));
  const nn = (v: unknown) => (v == null ? null : Number(v));
  const arr = <T>(v: unknown, f: (x: Record<string, unknown>) => T): T[] => (Array.isArray(v) ? v.map((x) => f(x as Record<string, unknown>)) : []);
  const margin = r.margin as { cur?: Record<string, unknown>; prev?: Record<string, unknown> } | null | undefined;
  const staffing = r.staffing as Record<string, unknown> | null | undefined;
  const labels = r.labels as Record<string, unknown> | null | undefined;
  const customers = r.customers as Record<string, unknown> | null | undefined;
  return {
    generated_at: r.generated_at as string | undefined,
    today: String(r.today ?? ""),
    timezone: String(r.timezone ?? "Europe/Rome"),
    finance: Boolean(r.finance),
    ticket_target_minutes: n(r.ticket_target_minutes) || 15,
    stock: arr(r.stock, (x) => ({
      product_id: String(x.product_id),
      name: String(x.name),
      unit: String(x.unit),
      on_hand: n(x.on_hand),
      daily_use: n(x.daily_use),
      incoming: n(x.incoming),
      supplier: x.supplier
        ? (() => {
            const s = x.supplier as Record<string, unknown>;
            return {
              id: String(s.id),
              name: String(s.name),
              delivery_weekdays: (s.delivery_weekdays as number[] | null) ?? [],
              cutoff_time: String(s.cutoff_time ?? "12:00"),
              lead_days: n(s.lead_days),
            };
          })()
        : null,
    })),
    price_increases:
      r.price_increases == null
        ? null
        : arr(r.price_increases, (x) => ({
            product_id: String(x.product_id),
            product: String(x.product),
            unit: String(x.unit),
            supplier_id: String(x.supplier_id),
            supplier: String(x.supplier),
            pack_label: String(x.pack_label),
            old_price: n(x.old_price),
            new_price: n(x.new_price),
            observed_at: String(x.observed_at),
            increase_pct: n(x.increase_pct),
            monthly_impact: n(x.monthly_impact),
          })),
    food_cost:
      r.food_cost == null
        ? null
        : arr(r.food_cost, (x) => ({
            menu_item_id: String(x.menu_item_id),
            name: String(x.name),
            target: n(x.target),
            portion_cost: n(x.portion_cost),
            missing: n(x.missing),
            qty_28d: n(x.qty_28d),
            net_28d: n(x.net_28d),
            food_cost_pct: nn(x.food_cost_pct),
          })),
    margin: margin
      ? { cur: { net: n(margin.cur?.net), cost: n(margin.cur?.cost) }, prev: { net: n(margin.prev?.net), cost: n(margin.prev?.cost) } }
      : null,
    waste: arr(r.waste, (x) => ({
      product_id: String(x.product_id),
      name: String(x.name),
      unit: String(x.unit),
      cur: n(x.cur),
      prev: n(x.prev),
      cur_movements: n(x.cur_movements),
      cur_value: nn(x.cur_value),
      prev_value: nn(x.prev_value),
    })),
    staffing: staffing
      ? {
          hist_covers: n(staffing.hist_covers),
          hist_hours: n(staffing.hist_hours),
          days: arr(staffing.days, (x) => ({
            date: String(x.date),
            planned_hours: n(x.planned_hours),
            forecast_covers: nn(x.forecast_covers),
            booked_covers: nn(x.booked_covers),
          })),
        }
      : null,
    kitchen: arr(r.kitchen, (x) => ({
      station_id: String(x.station_id),
      name: String(x.name),
      lines: n(x.lines),
      avg_ready_min: n(x.avg_ready_min),
      p90_ready_min: n(x.p90_ready_min),
    })),
    haccp: arr(r.haccp, (x) => ({
      equipment_id: String(x.equipment_id),
      name: String(x.name),
      out_count: n(x.out_count),
      without_action: n(x.without_action),
      last_at: String(x.last_at),
    })),
    maintenance: arr(r.maintenance, (x) => ({ label: String(x.label), kind: (x.kind as string | null) ?? null, count: n(x.count), open: n(x.open) })),
    labels: labels ? { expired: n(labels.expired), expiring_24h: n(labels.expiring_24h) } : null,
    customers: customers && customers.count != null ? { count: n(customers.count), min_days: n(customers.min_days), max_days: n(customers.max_days) } : null,
    feedback: arr(r.feedback, (x) => ({ key: String(x.key), action: x.action as InsightFeedback["action"], until: String(x.until) })),
  };
}

// ---------------------------------------------------------------------------
// Assistente operativo: regole
// ---------------------------------------------------------------------------

export type InsightSeverity = "alta" | "media" | "bassa";
export type InsightRule =
  | "esaurimento"
  | "aumento_prezzo"
  | "food_cost"
  | "spreco"
  | "margine"
  | "personale"
  | "tempi_cucina"
  | "haccp"
  | "manutenzione"
  | "etichette"
  | "clienti";

export interface Insight {
  /** Chiave stabile: usata per ignorare o rimandare (insight_feedback.insight_key) */
  key: string;
  rule: InsightRule;
  severity: InsightSeverity;
  title: string;
  /** Cosa è stato rilevato */
  detected: string;
  /** Dati usati, con numeri e periodo */
  data: { label: string; value: string }[];
  period: string;
  /** Perché è importante */
  why: string;
  /** Azione proposta */
  action: { label: string; href: string };
  /** Impatto stimato (testo) */
  impact: string;
  /** Impatto in euro, se stimabile (solo con dati economici): ordina a parità di gravità */
  impactEur?: number;
  /** Il suggerimento usa dati economici (mostrarlo solo a chi ha finance.view) */
  economic?: boolean;
}

export const INSIGHT_RULE_LABEL: Record<InsightRule, string> = {
  esaurimento: "Scorte",
  aumento_prezzo: "Prezzi fornitori",
  food_cost: "Food cost",
  spreco: "Sprechi",
  margine: "Margini",
  personale: "Personale",
  tempi_cucina: "Tempi di servizio",
  haccp: "HACCP",
  manutenzione: "Manutenzione",
  etichette: "Etichette",
  clienti: "Clienti",
};

/** Soglie delle regole: esplicite e modificabili nei test. */
export const INSIGHT_THRESHOLDS = {
  priceIncreasePct: 5,
  priceIncreaseHighPct: 15,
  foodCostMinPortions: 5,
  foodCostHighOverPts: 10,
  wasteGrowthPct: 25,
  wasteMinMovements: 2,
  marginDropPts: 3,
  staffCoverageRatio: 0.8,
  kitchenMinLines: 10,
  haccpRecurring: 2,
  maintenanceRecurring: 2,
} as const;

const SEV_WEIGHT: Record<InsightSeverity, number> = { alta: 300, media: 200, bassa: 100 };

const fmtNum = (v: number, max = 1) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: max }).format(v);
const fmtEur = (v: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(v);
const fmtQty = (v: number, unit: string) => `${fmtNum(v, unit === "pz" ? 0 : 2)} ${unit}`;
const fmtDay = (d: CivilDate) =>
  new Intl.DateTimeFormat("it-IT", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00Z`));

function stockoutInsights(s: InsightSignals, now: Date): Insight[] {
  const out: Insight[] = [];
  for (const p of s.stock) {
    if (!(p.daily_use > 0)) continue;
    const available = Math.max(p.on_hand, 0) + Math.max(p.incoming, 0);
    const coverDays = available / p.daily_use;
    const w = p.supplier
      ? nextOrderWindow({ deliveryWeekdays: p.supplier.delivery_weekdays, cutoffTime: p.supplier.cutoff_time, leadDays: p.supplier.lead_days }, s.timezone, now)
      : null;
    // Giorni da coprire: fino alla prossima consegna ordinabile (inclusa). Senza fornitore: 2 giorni di prudenza.
    const daysToDelivery = w ? Math.max(civilDaysBetween(s.today, w.deliveryDate), 0) + 1 : 2;
    if (coverDays >= daysToDelivery) continue;
    const shortage = p.daily_use * daysToDelivery - available;
    const severity: InsightSeverity = coverDays < 1 ? "alta" : coverDays < daysToDelivery / 2 ? "alta" : "media";
    out.push({
      key: `esaurimento:${p.product_id}`,
      rule: "esaurimento",
      severity,
      title: `${p.name}: finisce prima della prossima consegna`,
      detected: w
        ? `Con il consumo attuale ${p.name} basta per circa ${fmtNum(coverDays)} giorni, ma la prossima consegna utile di ${p.supplier!.name} arriva ${fmtDay(w.deliveryDate)}.`
        : `Con il consumo attuale ${p.name} basta per circa ${fmtNum(coverDays)} giorni e non c'è un fornitore a listino.`,
      data: [
        { label: "Giacenza", value: fmtQty(p.on_hand, p.unit) },
        ...(p.incoming > 0 ? [{ label: "In arrivo da ordini aperti", value: fmtQty(p.incoming, p.unit) }] : []),
        { label: "Consumo medio giornaliero", value: fmtQty(p.daily_use, p.unit) },
        ...(w ? [{ label: "Ordina entro", value: new Intl.DateTimeFormat("it-IT", { timeZone: s.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(w.orderBy) }] : []),
      ],
      period: "consumi (scarichi, sprechi, scaduti) degli ultimi 14 giorni",
      why: "Restare senza un prodotto significa togliere piatti dal menu o comprare in emergenza a prezzi più alti.",
      action: p.supplier ? { label: `Ordina da ${p.supplier.name}`, href: `/acquisti/riordino?fornitore=${p.supplier.id}` } : { label: "Aggiungi un fornitore", href: "/acquisti/fornitori" },
      impact: `Mancano circa ${fmtQty(Math.ceil(shortage * 100) / 100, p.unit)} per arrivare alla consegna.`,
    });
  }
  return out;
}

function priceInsights(s: InsightSignals): Insight[] {
  if (!s.finance || !s.price_increases) return [];
  return s.price_increases
    .filter((p) => p.increase_pct > INSIGHT_THRESHOLDS.priceIncreasePct)
    .map((p) => ({
      key: `aumento_prezzo:${p.product_id}:${p.supplier_id}:${p.new_price}`,
      rule: "aumento_prezzo" as const,
      severity: (p.increase_pct >= INSIGHT_THRESHOLDS.priceIncreaseHighPct ? "alta" : "media") as InsightSeverity,
      title: `${p.supplier} ha aumentato ${p.product} del ${fmtNum(p.increase_pct)}%`,
      detected: `Il prezzo di ${p.product} (${p.pack_label}) è passato da ${fmtEur(p.old_price)} a ${fmtEur(p.new_price)}.`,
      data: [
        { label: "Prezzo precedente", value: fmtEur(p.old_price) },
        { label: "Prezzo nuovo", value: fmtEur(p.new_price) },
        { label: "Aumento", value: `+${fmtNum(p.increase_pct)}%` },
        { label: "Rilevato il", value: new Intl.DateTimeFormat("it-IT", { timeZone: s.timezone, day: "numeric", month: "short" }).format(new Date(p.observed_at)) },
      ],
      period: "variazioni di listino e prezzi di ricezione degli ultimi 30 giorni",
      why: `Oltre il ${INSIGHT_THRESHOLDS.priceIncreasePct}% l'aumento erode il margine dei piatti che usano ${p.product}: conviene negoziare o confrontare altri fornitori.`,
      action: { label: "Apri il fornitore", href: `/acquisti/fornitori/${p.supplier_id}` },
      impact: p.monthly_impact > 0 ? `Circa ${fmtEur(p.monthly_impact)} in più al mese ai consumi attuali.` : "Impatto non stimabile: nessun consumo registrato negli ultimi 30 giorni.",
      impactEur: p.monthly_impact > 0 ? p.monthly_impact : undefined,
      economic: true,
    }));
}

function foodCostInsights(s: InsightSignals): Insight[] {
  if (!s.finance || !s.food_cost) return [];
  return s.food_cost
    .filter((f) => f.food_cost_pct != null && f.target > 0 && f.food_cost_pct > f.target && f.qty_28d >= INSIGHT_THRESHOLDS.foodCostMinPortions)
    .map((f) => {
      const over = f.food_cost_pct! - f.target;
      const excess = (over / 100) * f.net_28d;
      return {
        key: `food_cost:${f.menu_item_id}`,
        rule: "food_cost" as const,
        severity: (over >= INSIGHT_THRESHOLDS.foodCostHighOverPts ? "alta" : "media") as InsightSeverity,
        title: `${f.name}: food cost ${fmtNum(f.food_cost_pct!)}% (obiettivo ${fmtNum(f.target)}%)`,
        detected: `Il costo teorico della ricetta è ${fmtEur(f.portion_cost)} a porzione, sopra l'obiettivo di ${fmtNum(over)} punti.`,
        data: [
          { label: "Porzioni vendute", value: fmtNum(f.qty_28d, 0) },
          { label: "Ricavi netti", value: fmtEur(f.net_28d) },
          { label: "Costo porzione", value: fmtEur(f.portion_cost) },
          ...(f.missing > 0 ? [{ label: "Ingredienti senza costo", value: String(f.missing) }] : []),
        ],
        period: "vendite degli ultimi 28 giorni, costi medi attuali",
        why: "Ogni punto di food cost sopra l'obiettivo è margine perso su ogni porzione venduta.",
        action: { label: "Rivedi ricetta o prezzo", href: `/servizio/menu/${f.menu_item_id}` },
        impact: `Circa ${fmtEur(excess)} di costo in più rispetto all'obiettivo in 28 giorni.`,
        impactEur: excess,
        economic: true,
      };
    });
}

function wasteInsights(s: InsightSignals): Insight[] {
  const t = INSIGHT_THRESHOLDS;
  return s.waste
    .filter((w) => w.cur_movements >= t.wasteMinMovements && w.cur > 0 && (w.prev === 0 ? w.cur_movements >= 3 : w.cur > w.prev * (1 + t.wasteGrowthPct / 100)))
    .map((w) => {
      const growth = pctChange(w.cur, w.prev);
      const extraValue = s.finance && w.cur_value != null ? w.cur_value - (w.prev_value ?? 0) : null;
      return {
        key: `spreco:${w.product_id}`,
        rule: "spreco" as const,
        severity: (growth == null || growth >= 100 ? "alta" : "media") as InsightSeverity,
        title: `Sprechi di ${w.name} in aumento`,
        detected:
          growth == null
            ? `${fmtQty(w.cur, w.unit)} di ${w.name} buttati in ${w.cur_movements} registrazioni, nessuno spreco nelle 2 settimane precedenti.`
            : `Sprechi e scaduti di ${w.name} sono cresciuti del ${fmtNum(growth)}% rispetto alle 2 settimane precedenti.`,
        data: [
          { label: "Ultimi 14 giorni", value: fmtQty(w.cur, w.unit) },
          { label: "14 giorni precedenti", value: fmtQty(w.prev, w.unit) },
          ...(s.finance && w.cur_value != null ? [{ label: "Valore ultimi 14 giorni", value: fmtEur(w.cur_value) }] : []),
        ],
        period: "movimenti di spreco e scaduto, ultimi 28 giorni",
        why: "Uno spreco che cresce indica porzioni o ordini troppo grandi, conservazione da rivedere o prodotti che non girano.",
        action: { label: "Vedi i movimenti", href: "/scorte/movimenti" },
        impact: extraValue != null && extraValue > 0 ? `${fmtEur(extraValue)} in più buttati rispetto al periodo precedente.` : "Ridurre le quantità ordinate o preparate.",
        impactEur: extraValue != null && extraValue > 0 ? extraValue : undefined,
      };
    });
}

function marginInsights(s: InsightSignals): Insight[] {
  if (!s.finance || !s.margin) return [];
  const { cur, prev } = s.margin;
  if (cur.net <= 0 || prev.net <= 0) return [];
  const mCur = ((cur.net - cur.cost) / cur.net) * 100;
  const mPrev = ((prev.net - prev.cost) / prev.net) * 100;
  const drop = mPrev - mCur;
  if (drop < INSIGHT_THRESHOLDS.marginDropPts) return [];
  const lost = (drop / 100) * cur.net;
  return [
    {
      key: "margine:totale",
      rule: "margine",
      severity: drop >= 2 * INSIGHT_THRESHOLDS.marginDropPts ? "alta" : "media",
      title: `Margine sul venduto in calo di ${fmtNum(drop)} punti`,
      detected: `Il margine lordo teorico sulle voci con ricetta è sceso dal ${fmtNum(mPrev)}% al ${fmtNum(mCur)}%.`,
      data: [
        { label: "Ricavi netti (ultimi 14 gg)", value: fmtEur(cur.net) },
        { label: "Costo teorico (ultimi 14 gg)", value: fmtEur(cur.cost) },
        { label: "Margine 14 gg precedenti", value: `${fmtNum(mPrev)}%` },
      ],
      period: "vendite degli ultimi 28 giorni divise in due quindicine, costi medi attuali",
      why: "Con costi fermi, un margine in calo significa più vendite di piatti poco redditizi o più sconti.",
      action: { label: "Apri il food cost", href: "/servizio/menu/food-cost" },
      impact: `Circa ${fmtEur(lost)} di margine in meno in 14 giorni.`,
      impactEur: lost,
      economic: true,
    },
  ];
}

function staffInsights(s: InsightSignals): Insight[] {
  const st = s.staffing;
  if (!st || st.hist_covers <= 0 || st.hist_hours <= 0) return [];
  const coversPerHour = st.hist_covers / st.hist_hours;
  const out: Insight[] = [];
  for (const d of st.days) {
    const expected = Math.max(d.forecast_covers ?? 0, d.booked_covers ?? 0);
    if (expected <= 0) continue;
    const needed = expected / coversPerHour;
    if (d.planned_hours >= needed * INSIGHT_THRESHOLDS.staffCoverageRatio) continue;
    const missing = needed - d.planned_hours;
    out.push({
      key: `personale:${d.date}`,
      rule: "personale",
      severity: d.planned_hours < needed * 0.5 ? "alta" : "media",
      title: `${fmtDay(d.date)}: personale sotto il fabbisogno`,
      detected: `Sono previsti circa ${fmtNum(expected, 0)} coperti ma i turni coprono ${fmtNum(d.planned_hours)} ore contro le ${fmtNum(needed)} che servono di solito.`,
      data: [
        ...(d.forecast_covers != null ? [{ label: "Coperti attesi (media stesso giorno, 4 settimane)", value: fmtNum(d.forecast_covers, 0) }] : []),
        ...(d.booked_covers != null ? [{ label: "Coperti già prenotati", value: fmtNum(d.booked_covers, 0) }] : []),
        { label: "Ore pianificate", value: fmtNum(d.planned_hours) },
        { label: "Coperti per ora lavorata (storico)", value: fmtNum(coversPerHour) },
      ],
      period: "turni pubblicati e coperti delle ultime 4 settimane",
      why: "Con poco personale si allungano i tempi di servizio e cala lo scontrino medio.",
      action: { label: "Pianifica i turni", href: "/lavoro/turni" },
      impact: `Mancano circa ${fmtNum(missing)} ore di turno.`,
    });
  }
  return out;
}

function kitchenInsights(s: InsightSignals): Insight[] {
  const target = s.ticket_target_minutes;
  return s.kitchen
    .filter((k) => k.lines >= INSIGHT_THRESHOLDS.kitchenMinLines && (k.avg_ready_min > target || k.p90_ready_min > target * 1.5))
    .map((k) => ({
      key: `tempi_cucina:${k.station_id}`,
      rule: "tempi_cucina" as const,
      severity: (k.avg_ready_min > target * 1.5 ? "alta" : "media") as InsightSeverity,
      title: `${k.name}: piatti pronti in ${fmtNum(k.avg_ready_min)} min (obiettivo ${target})`,
      detected: `In media un piatto è pronto dopo ${fmtNum(k.avg_ready_min)} minuti; 1 piatto su 10 supera i ${fmtNum(k.p90_ready_min)} minuti.`,
      data: [
        { label: "Righe considerate", value: fmtNum(k.lines, 0) },
        { label: "Tempo medio inviata → pronta", value: `${fmtNum(k.avg_ready_min)} min` },
        { label: "90° percentile", value: `${fmtNum(k.p90_ready_min)} min` },
        { label: "Obiettivo", value: `${target} min` },
      ],
      period: "comande degli ultimi 7 giorni",
      why: "Attese lunghe fanno girare meno tavoli e peggiorano le recensioni.",
      action: { label: "Apri la cucina", href: "/servizio/cucina" },
      impact: `${fmtNum(Math.max(k.avg_ready_min - target, 0))} minuti in più a piatto rispetto all'obiettivo.`,
    }));
}

function haccpInsights(s: InsightSignals): Insight[] {
  return s.haccp
    .filter((h) => h.out_count >= INSIGHT_THRESHOLDS.haccpRecurring || h.without_action > 0)
    .map((h) => ({
      key: `haccp:${h.equipment_id}`,
      rule: "haccp" as const,
      severity: (h.without_action > 0 ? "alta" : "media") as InsightSeverity,
      title: `${h.name}: temperature fuori limite ${h.out_count === 1 ? "1 volta" : `${h.out_count} volte`}`,
      detected:
        h.without_action > 0
          ? `${h.without_action} rilevazioni fuori limite non hanno ancora un'azione correttiva registrata.`
          : `L'attrezzatura è uscita dai limiti più volte: può essere un guasto o un uso scorretto.`,
      data: [
        { label: "Fuori limite", value: String(h.out_count) },
        { label: "Senza azione correttiva", value: String(h.without_action) },
        { label: "Ultima", value: new Intl.DateTimeFormat("it-IT", { timeZone: s.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(h.last_at)) },
      ],
      period: "registro temperature degli ultimi 14 giorni",
      why: "Il piano HACCP richiede un'azione correttiva documentata; un problema ricorrente mette a rischio la merce.",
      action: { label: "Apri il registro temperature", href: "/servizio/menu/haccp/temperature" },
      impact: "Rischio sanitario e di merce da buttare.",
    }));
}

function maintenanceInsights(s: InsightSignals): Insight[] {
  return s.maintenance
    .filter((m) => m.count >= INSIGHT_THRESHOLDS.maintenanceRecurring)
    .map((m) => ({
      key: `manutenzione:${m.kind ?? "x"}:${m.label}`,
      rule: "manutenzione" as const,
      severity: (m.open > 0 ? "media" : "bassa") as InsightSeverity,
      title: `${m.label}: ${m.count} segnalazioni di manutenzione in 30 giorni`,
      detected: `Lo stesso punto ha avuto ${m.count} richieste di manutenzione${m.open > 0 ? `, ${m.open} ancora aperte` : ""}.`,
      data: [
        { label: "Segnalazioni", value: String(m.count) },
        { label: "Aperte", value: String(m.open) },
      ],
      period: "richieste degli ultimi 30 giorni",
      why: "Un guasto che si ripete conviene risolverlo alla radice invece di intervenire ogni volta.",
      action: { label: "Vedi le richieste", href: "/lavoro/richieste" },
      impact: "Meno interventi ripetuti e meno disservizi per gli ospiti.",
    }));
}

function labelInsights(s: InsightSignals): Insight[] {
  const l = s.labels;
  if (!l || (l.expired === 0 && l.expiring_24h === 0)) return [];
  return [
    {
      key: `etichette:${s.today}`,
      rule: "etichette",
      severity: l.expired > 0 ? "alta" : "media",
      title: l.expired > 0 ? `${l.expired} preparazioni scadute ancora attive` : `${l.expiring_24h} preparazioni scadono entro 24 ore`,
      detected: `Etichette attive: ${l.expired} scadute, ${l.expiring_24h} in scadenza nelle prossime 24 ore.`,
      data: [
        { label: "Scadute", value: String(l.expired) },
        { label: "In scadenza (24 h)", value: String(l.expiring_24h) },
      ],
      period: "etichette attive in questo momento",
      why: "Una preparazione scaduta non va servita: va consumata prima o scartata e registrata.",
      action: { label: "Apri le etichette", href: "/servizio/menu/haccp/etichette" },
      impact: "Usare per prime le preparazioni in scadenza riduce lo spreco.",
    },
  ];
}

function customerInsights(s: InsightSignals): Insight[] {
  const c = s.customers;
  if (!c || c.count <= 0) return [];
  return [
    {
      key: "clienti:da_ricontattare",
      rule: "clienti",
      severity: "bassa",
      title: `${c.count} clienti da ricontattare`,
      detected: `${c.count} clienti con consenso marketing non tornano da ${c.min_days}–${c.max_days} giorni.`,
      data: [{ label: "Clienti nel segmento", value: String(c.count) }],
      period: `ultima prenotazione tra ${c.min_days} e ${c.max_days} giorni fa`,
      why: "Riattivare un cliente che ti conosce costa meno che trovarne uno nuovo.",
      action: { label: "Apri gli ospiti", href: "/ospiti" },
      impact: "Conteggio anonimo: i nomi si vedono solo nella sezione Ospiti, con i permessi CRM.",
    },
  ];
}

export function insightScore(i: Insight): number {
  return SEV_WEIGHT[i.severity] + Math.min(Math.max(i.impactEur ?? 0, 0) / 10, 90);
}

/** Applica le regole ai segnali e ordina per gravità e impatto. Nessun suggerimento economico senza finance. */
export function buildInsights(signals: InsightSignals, now: Date = new Date()): Insight[] {
  const all = [
    ...stockoutInsights(signals, now),
    ...priceInsights(signals),
    ...foodCostInsights(signals),
    ...wasteInsights(signals),
    ...marginInsights(signals),
    ...staffInsights(signals),
    ...kitchenInsights(signals),
    ...haccpInsights(signals),
    ...maintenanceInsights(signals),
    ...labelInsights(signals),
    ...customerInsights(signals),
  ].filter((i) => signals.finance || !i.economic);
  return all.sort((a, b) => insightScore(b) - insightScore(a) || a.title.localeCompare(b.title, "it"));
}

/** Separa i suggerimenti attivi da quelli ignorati o rimandati (fino alla scadenza del riscontro). */
export function applyInsightFeedback(insights: Insight[], feedback: InsightFeedback[], now: Date = new Date()) {
  const hidden = new Map<string, InsightFeedback>();
  for (const f of feedback) if (new Date(f.until).getTime() > now.getTime()) hidden.set(f.key, f);
  return {
    active: insights.filter((i) => !hidden.has(i.key)),
    hidden: insights.filter((i) => hidden.has(i.key)).map((i) => ({ insight: i, feedback: hidden.get(i.key)! })),
  };
}

/**
 * I suggerimenti più importanti ancora attivi per la persona (per «Oggi»).
 * Uso: topInsights(normalizeSignals(await supabase.rpc("analytics_insight_signals", { p_facility })), 3)
 */
export function topInsights(signals: InsightSignals, limit = 3, now: Date = new Date()): Insight[] {
  return applyInsightFeedback(buildInsights(signals, now), signals.feedback, now).active.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pianificatore delle preparazioni
// ---------------------------------------------------------------------------

export type WeatherKey = "soleggiato" | "variabile" | "pioggia";
export const WEATHER_OPTIONS: { key: WeatherKey; label: string }[] = [
  { key: "soleggiato", label: "Soleggiato" },
  { key: "variabile", label: "Variabile" },
  { key: "pioggia", label: "Pioggia" },
];

export interface PrepHistoryDay {
  date: CivilDate;
  orders: number;
  covers: number;
  items: Record<string, number>;
}
export interface PrepMenuItem {
  id: string;
  name: string;
  recipe: { product_id: string; qty_per_portion: number }[];
}
export interface PrepProduct {
  id: string;
  name: string;
  unit: string;
  on_hand: number;
}
export interface PrepInput {
  history: PrepHistoryDay[];
  menu: PrepMenuItem[];
  products: PrepProduct[];
  /** Coperti già prenotati per la data (null = modulo prenotazioni assente) */
  bookedCovers: number | null;
  weatherFactor: number;
}

export type PrepConfidence = "alta" | "media" | "bassa" | "nessuna";

export interface PrepItemPlan {
  id: string;
  name: string;
  /** Media delle vendite negli stessi giorni della settimana con attività */
  baseline: number;
  min: number;
  max: number;
  portions: number;
}
export interface PrepIngredientNeed {
  product_id: string;
  name: string;
  unit: string;
  need: number;
  on_hand: number;
  /** Quantità da ordinare o preparare (0 se la giacenza basta) */
  missing: number;
}
export interface PrepPlan {
  weeksRequested: number;
  weeksWithData: number;
  confidence: PrepConfidence;
  avgCovers: number;
  coversFactor: number;
  weatherFactor: number;
  factor: number;
  items: PrepItemPlan[];
  ingredients: PrepIngredientNeed[];
}

export function prepConfidence(weeksWithData: number): PrepConfidence {
  if (weeksWithData >= 4) return "alta";
  if (weeksWithData >= 2) return "media";
  if (weeksWithData >= 1) return "bassa";
  return "nessuna";
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Porzioni suggerite = ⌈ media vendite stesso giorno della settimana × fattore coperti × fattore meteo ⌉
 *   • settimane senza comande (chiusura) escluse dalla media;
 *   • fattore coperti = prenotati / coperti medi storici, solo se i prenotati superano la media
 *     (le prenotazioni sono un minimo garantito, non il totale: non riducono mai la stima), max 3;
 *   • fabbisogno ingredienti = porzioni × quantità a porzione (scarto incluso), confrontato con la giacenza.
 */
export function prepPlan(input: PrepInput): PrepPlan {
  const weeks = input.history.filter((h) => h.orders > 0);
  const n = weeks.length;
  const avgCovers = n ? weeks.reduce((s, h) => s + h.covers, 0) / n : 0;
  const booked = input.bookedCovers ?? 0;
  const coversFactor = avgCovers > 0 && booked > avgCovers ? Math.min(booked / avgCovers, 3) : 1;
  const weatherFactor = Number.isFinite(input.weatherFactor) && input.weatherFactor > 0 ? input.weatherFactor : 1;
  const factor = coversFactor * weatherFactor;

  const items: PrepItemPlan[] = input.menu
    .map((m) => {
      const qs = weeks.map((h) => h.items[m.id] ?? 0);
      const baseline = n ? qs.reduce((s, q) => s + q, 0) / n : 0;
      return {
        id: m.id,
        name: m.name,
        baseline: round2(baseline),
        min: n ? Math.min(...qs) : 0,
        max: n ? Math.max(...qs) : 0,
        portions: baseline > 0 ? Math.ceil(round2(baseline * factor)) : 0,
      };
    })
    .filter((i) => i.portions > 0)
    .sort((a, b) => b.portions - a.portions || a.name.localeCompare(b.name, "it"));

  const menuById = new Map(input.menu.map((m) => [m.id, m]));
  const needs = new Map<string, number>();
  for (const i of items) {
    for (const r of menuById.get(i.id)?.recipe ?? []) {
      needs.set(r.product_id, (needs.get(r.product_id) ?? 0) + i.portions * r.qty_per_portion);
    }
  }
  const prodById = new Map(input.products.map((p) => [p.id, p]));
  const ingredients: PrepIngredientNeed[] = [...needs.entries()]
    .map(([pid, need]) => {
      const p = prodById.get(pid);
      const onHand = Math.max(p?.on_hand ?? 0, 0);
      return {
        product_id: pid,
        name: p?.name ?? "Prodotto",
        unit: p?.unit ?? "",
        need: Math.round(need * 1000) / 1000,
        on_hand: onHand,
        missing: Math.max(Math.round((need - onHand) * 1000) / 1000, 0),
      };
    })
    .sort((a, b) => Number(b.missing > 0) - Number(a.missing > 0) || a.name.localeCompare(b.name, "it"));

  return {
    weeksRequested: input.history.length,
    weeksWithData: n,
    confidence: prepConfidence(n),
    avgCovers: round2(avgCovers),
    coversFactor: round2(coversFactor),
    weatherFactor,
    factor: round2(factor),
    items,
    ingredients,
  };
}
