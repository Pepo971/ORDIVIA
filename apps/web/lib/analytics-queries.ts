import "server-only";
import { normalizeSignals, topInsights, type Insight, type InsightSignals } from "@ordivia/domain";
import { humanError } from "./action-state";
import { can, type AppContext } from "./context";
import { createClient } from "./supabase/server";

// ---------------------------------------------------------------------------
// Tipi dei JSON restituiti dalle RPC analytics_* (numeric → number via num())
// ---------------------------------------------------------------------------

export interface ServiceRow {
  station_id: string;
  name: string;
  lines: number;
  lines_served: number;
  avg_ready_min: number | null;
  avg_served_min: number | null;
  p90_served_min: number | null;
}
export interface ItemQtyRow {
  menu_item_id: string | null;
  name: string;
  qty: number;
}
export interface QtyByProduct {
  product_id: string;
  name: string;
  unit: string;
  qty: number;
  movements: number;
}

export interface Operational {
  from: string;
  to: string;
  covers: number;
  orders: number;
  orders_closed: number;
  items_sold: number;
  daily: { d: string; covers: number; orders: number }[];
  ticket_target_minutes: number;
  service: ServiceRow[];
  items: ItemQtyRow[];
  beach: { points: number; point_days: number; occupied_point_days: number; occupancy_pct: number | null; no_show: number; bookings: number } | null;
  reservations: { reservations: number; no_show: number; cancelled: number; covers: number; no_show_pct: number | null } | null;
  tasks: { due: number; on_time: number; late: number; open_overdue: number; on_time_pct: number | null };
  haccp: { readings: number; out_of_range: number; without_action: number };
  waste: QtyByProduct[];
  adjustments: QtyByProduct[];
}

export interface EconomicItem {
  menu_item_id: string | null;
  name: string;
  qty: number;
  gross: number;
  net: number;
  has_recipe: boolean;
  missing_costs: number;
  target_food_cost_pct: number | null;
  cost: number | null;
  margin: number | null;
  margin_pct: number | null;
  food_cost_pct: number | null;
}

export interface Economic {
  from: string;
  to: string;
  revenue: number;
  revenue_pos: number;
  revenue_beach: number;
  orders_closed: number;
  avg_ticket: number | null;
  avg_per_cover: number | null;
  discounts: number;
  daily: { d: string; pos: number; beach: number }[];
  by_station: { station_id: string | null; name: string; department: string | null; gross: number; net: number }[];
  food_cost: { net_sales: number; net_sales_with_recipe: number; theoretical_cost: number; food_cost_pct: number | null; coverage_pct: number | null; items_missing_costs: number };
  items: EconomicItem[];
  suppliers: { supplier_id: string; name: string; receipts: number; spend: number; lines_without_price: number }[];
  price_increases: {
    product_id: string;
    product: string;
    unit: string;
    supplier_id: string;
    supplier: string;
    pack_label: string;
    old_price: number;
    new_price: number;
    increase_pct: number;
    consumed_qty: number;
    impact: number;
  }[];
  labour: { hours: number; hours_with_cost: number; cost: number | null; people: number; people_without_cost: number };
  waste: { value: number; movements_without_cost: number; by_product: { product_id: string; name: string; qty: number; unit: string; value: number }[] };
  adjustments_value: number;
}

export interface PrepHistory {
  date: string;
  weeks: number;
  booked_covers: number | null;
  reservations_available: boolean;
  history: { date: string; orders: number; covers: number; items: Record<string, number> }[];
  menu: { id: string; name: string; prep_station_id: string | null; course: number; recipe: { product_id: string; qty_per_portion: number }[] }[];
  products: { id: string; name: string; unit: string; on_hand: number }[];
}

export interface AnalyticsSettings {
  ticket_target_minutes: number;
  weather_sunny: number;
  weather_variable: number;
  weather_rain: number;
  prep_weeks: number;
}

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  ticket_target_minutes: 15,
  weather_sunny: 1.1,
  weather_variable: 1,
  weather_rain: 0.8,
  prep_weeks: 6,
};

/** Converte ricorsivamente le stringhe numeriche di PostgREST (numeric) in numeri, lasciando date e testi. */
function num<T>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => num(x)) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = num(x);
    return o as T;
  }
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && !/^\d{4}-/.test(v)) return Number(v) as T;
  return v as T;
}

export type Result<T> = { data: T; error: null } | { data: null; error: string };

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<Result<T>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { data: null, error: humanError(error, "Impossibile caricare i numeri. Riprova.") };
  return { data: num<T>(data), error: null };
}

export function getOperational(facilityId: string, from: string, to: string) {
  return rpc<Operational>("analytics_operational", { p_facility: facilityId, p_from: from, p_to: to });
}

/** Dati economici: la RPC rifiuta (42501) chi non ha finance.view; qui si evita la chiamata inutile. */
export async function getEconomic(ctx: AppContext, from: string, to: string): Promise<Result<Economic> | null> {
  if (!can(ctx, "finance.view")) return null;
  return rpc<Economic>("analytics_economic", { p_facility: ctx.facility.id, p_from: from, p_to: to });
}

export async function getInsightSignals(facilityId: string): Promise<Result<InsightSignals>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("analytics_insight_signals", { p_facility: facilityId });
  if (error) return { data: null, error: humanError(error, "Impossibile caricare i suggerimenti. Riprova.") };
  return { data: normalizeSignals(data), error: null };
}

export function getPrepHistory(facilityId: string, date: string, weeks: number) {
  return rpc<PrepHistory>("analytics_prep_history", { p_facility: facilityId, p_date: date, p_weeks: weeks });
}

export async function getAnalyticsSettings(facilityId: string): Promise<AnalyticsSettings> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("analytics_settings")
    .select("ticket_target_minutes, weather_sunny, weather_variable, weather_rain, prep_weeks")
    .eq("facility_id", facilityId)
    .maybeSingle();
  if (!data) return DEFAULT_ANALYTICS_SETTINGS;
  return {
    ticket_target_minutes: Number(data.ticket_target_minutes),
    weather_sunny: Number(data.weather_sunny),
    weather_variable: Number(data.weather_variable),
    weather_rain: Number(data.weather_rain),
    prep_weeks: Number(data.prep_weeks),
  };
}

/**
 * I suggerimenti più importanti dell'assistente per la persona corrente (al massimo `limit`),
 * già filtrati da quelli ignorati o rimandati. Pensata per «Oggi»: restituisce [] senza permessi o in caso di errore.
 */
export async function getTopInsights(ctx: AppContext, limit = 3): Promise<Insight[]> {
  if (!can(ctx, "analytics.view", "finance.view")) return [];
  const res = await getInsightSignals(ctx.facility.id);
  if (res.error !== null) return [];
  return topInsights(res.data, limit);
}
