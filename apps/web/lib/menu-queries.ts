import "server-only";
import { createClient } from "./supabase/server";

export interface MenuCategory {
  id: string;
  name: string;
  sort: number;
}

export interface PrepStation {
  id: string;
  name: string;
  kind: string;
  sort: number;
  active: boolean;
  department_id: string | null;
  warehouse_id: string | null;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  prep_station_id: string | null;
  price: number;
  vat_rate: number;
  allergens: string[];
  course: number;
  yield_portions: number;
  target_food_cost_pct: number;
  sort: number;
  active: boolean;
  available: boolean;
}

export interface FoodCostRow {
  menu_item_id: string;
  price: number;
  vat_rate: number;
  net_price: number;
  portion_cost: number;
  portion_cost_last: number;
  food_cost_pct: number | null;
  margin: number;
  margin_pct: number | null;
  target_food_cost_pct: number;
  recommended_price: number | null;
  over_target: boolean;
  ingredients: number;
  missing_costs: number;
}

export interface SupplierImpactRow {
  menu_item_id: string;
  product_id: string;
  product_name: string;
  base_unit: string;
  qty_per_portion: number;
  old_unit_cost: number;
  new_unit_cost: number;
  increase_pct: number;
  impact_per_portion: number;
  source: string;
  observed_at: string;
}

const n = (v: unknown) => (v == null ? null : Number(v));

export async function getCategories(facilityId: string): Promise<MenuCategory[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("menu_categories").select("id, name, sort").eq("facility_id", facilityId).order("sort").order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getPrepStations(facilityId: string): Promise<PrepStation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prep_stations")
    .select("id, name, kind, sort, active, department_id, warehouse_id")
    .eq("facility_id", facilityId)
    .order("sort")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

const ITEM_COLS = "id, name, description, category_id, prep_station_id, price, vat_rate, allergens, course, yield_portions, target_food_cost_pct, sort, active, available";

function toItem(r: Record<string, unknown>): MenuItem {
  return {
    ...(r as unknown as MenuItem),
    price: Number(r.price),
    vat_rate: Number(r.vat_rate),
    yield_portions: Number(r.yield_portions),
    target_food_cost_pct: Number(r.target_food_cost_pct),
    allergens: (r.allergens as string[]) ?? [],
  };
}

export async function getMenuItems(facilityId: string): Promise<MenuItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("menu_items").select(ITEM_COLS).eq("facility_id", facilityId).order("course").order("sort").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map(toItem);
}

export async function getMenuItem(id: string): Promise<MenuItem | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("menu_items").select(ITEM_COLS).eq("id", id).maybeSingle();
  return data ? toItem(data) : null;
}

/** Food cost di tutte le voci della struttura (richiede menu.manage o finance.view: altrimenti errore 42501). */
export async function getFoodCost(facilityId: string): Promise<Map<string, FoodCostRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("menu_food_cost", { p_facility: facilityId });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  return new Map(
    rows.map((r) => [
      r.menu_item_id as string,
      {
        menu_item_id: r.menu_item_id as string,
        price: Number(r.price),
        vat_rate: Number(r.vat_rate),
        net_price: Number(r.net_price),
        portion_cost: Number(r.portion_cost),
        portion_cost_last: Number(r.portion_cost_last),
        food_cost_pct: n(r.food_cost_pct),
        margin: Number(r.margin),
        margin_pct: n(r.margin_pct),
        target_food_cost_pct: Number(r.target_food_cost_pct),
        recommended_price: n(r.recommended_price),
        over_target: Boolean(r.over_target),
        ingredients: Number(r.ingredients),
        missing_costs: Number(r.missing_costs),
      },
    ]),
  );
}

export async function getSupplierImpact(facilityId: string, days = 90): Promise<SupplierImpactRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("menu_supplier_impact", { p_facility: facilityId, p_days: days });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    menu_item_id: r.menu_item_id as string,
    product_id: r.product_id as string,
    product_name: r.product_name as string,
    base_unit: r.base_unit as string,
    qty_per_portion: Number(r.qty_per_portion),
    old_unit_cost: Number(r.old_unit_cost),
    new_unit_cost: Number(r.new_unit_cost),
    increase_pct: Number(r.increase_pct),
    impact_per_portion: Number(r.impact_per_portion),
    source: r.source as string,
    observed_at: r.observed_at as string,
  }));
}

// ---------------------------------------------------------------------------
// HACCP
// ---------------------------------------------------------------------------
export interface Equipment {
  id: string;
  name: string;
  kind: string;
  min_temp: number;
  max_temp: number;
  sort: number;
  active: boolean;
  department_id: string | null;
}

export interface TempLog {
  id: string;
  equipment_id: string;
  value: number;
  min_temp: number;
  max_temp: number;
  out_of_range: boolean;
  corrective_action: string | null;
  corrective_at: string | null;
  note: string | null;
  recorded_by: string;
  recorded_at: string;
}

export interface HaccpLabel {
  id: string;
  kind: "preparazione" | "apertura";
  menu_item_id: string | null;
  product_id: string | null;
  name: string;
  quantity: string | null;
  lot_code: string;
  token: string;
  prepared_at: string;
  opened_at: string | null;
  shelf_life_days: number;
  expires_at: string;
  expiry_capped: boolean;
  storage: string | null;
  allergens: string[];
  source_lots: { product_id?: string; product_name?: string; lot: string; expires_on?: string | null }[];
  note: string | null;
  operator_name: string | null;
  status: "attiva" | "consumata" | "scartata";
  closed_at: string | null;
  created_at: string;
}

export async function getEquipment(facilityId: string): Promise<Equipment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("haccp_equipment")
    .select("id, name, kind, min_temp, max_temp, sort, active, department_id")
    .eq("facility_id", facilityId)
    .order("sort")
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((e) => ({ ...e, min_temp: Number(e.min_temp), max_temp: Number(e.max_temp) }));
}

export async function getTempLogs(facilityId: string, opts: { equipmentId?: string; since?: string; limit?: number } = {}): Promise<TempLog[]> {
  const supabase = await createClient();
  let q = supabase
    .from("haccp_temperature_logs")
    .select("id, equipment_id, value, min_temp, max_temp, out_of_range, corrective_action, corrective_at, note, recorded_by, recorded_at")
    .eq("facility_id", facilityId)
    .order("recorded_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.equipmentId) q = q.eq("equipment_id", opts.equipmentId);
  if (opts.since) q = q.gte("recorded_at", opts.since);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((l) => ({ ...l, value: Number(l.value), min_temp: Number(l.min_temp), max_temp: Number(l.max_temp) }));
}

const LABEL_COLS =
  "id, kind, menu_item_id, product_id, name, quantity, lot_code, token, prepared_at, opened_at, shelf_life_days, expires_at, expiry_capped, storage, allergens, source_lots, note, operator_name, status, closed_at, created_at";

function toLabel(r: Record<string, unknown>): HaccpLabel {
  return { ...(r as unknown as HaccpLabel), shelf_life_days: Number(r.shelf_life_days), source_lots: (r.source_lots as HaccpLabel["source_lots"]) ?? [] };
}

export async function getLabels(facilityId: string, opts: { status?: string; limit?: number; lot?: string } = {}): Promise<HaccpLabel[]> {
  const supabase = await createClient();
  let q = supabase.from("haccp_labels").select(LABEL_COLS).eq("facility_id", facilityId);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.lot) q = q.contains("source_lots", JSON.stringify([{ lot: opts.lot }]));
  q = opts.status === "attiva" ? q.order("expires_at") : q.order("created_at", { ascending: false });
  const { data, error } = await q.limit(opts.limit ?? 200);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toLabel);
}

export async function getLabel(id: string): Promise<HaccpLabel | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("haccp_labels").select(LABEL_COLS).eq("id", id).maybeSingle();
  return data ? toLabel(data) : null;
}

/** Nomi delle persone (per registro e firme). */
export async function getPeopleNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.full_name || p.email || "—"]));
}
