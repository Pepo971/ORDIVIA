import "server-only";
import { nextOrderWindow, reorderSuggestion, todayIn, type OrderWindow } from "@ordivia/domain";
import { createClient } from "./supabase/server";
import { can, type AppContext } from "./context";

export interface Product {
  id: string;
  name: string;
  base_unit: string;
  category_id: string | null;
  active: boolean;
}

export interface Warehouse {
  id: string;
  name: string;
  department_id: string | null;
}

export interface StockLine {
  warehouse: Warehouse;
  product: Product;
  qty: number;
  minQty: number;
  parQty: number;
  incoming: number;
  belowMin: boolean;
  suggestedBase: number;
}

export interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  order_channel: string;
  delivery_weekdays: number[];
  cutoff_time: string;
  lead_days: number;
  min_order_amount: number;
  notes: string | null;
  active: boolean;
}

export async function getWarehouses(facilityId: string): Promise<Warehouse[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("warehouses").select("id, name, department_id").eq("facility_id", facilityId).order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getProducts(orgId: string): Promise<Product[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("products").select("id, name, base_unit, category_id, active").eq("org_id", orgId).eq("active", true).order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Giacenze della struttura: tutte le combinazioni con movimenti o con una scorta minima impostata. */
export async function getStock(ctx: AppContext): Promise<StockLine[]> {
  const supabase = await createClient();
  const [warehouses, products, onHand, settings, incoming] = await Promise.all([
    getWarehouses(ctx.facility.id),
    getProducts(ctx.org.id),
    supabase.from("stock_on_hand").select("warehouse_id, product_id, qty").eq("facility_id", ctx.facility.id),
    supabase.from("stock_settings").select("warehouse_id, product_id, min_qty, par_qty").eq("org_id", ctx.org.id),
    can(ctx, "purchasing.approve", "purchasing.send", "receiving.perform")
      ? supabase
          .from("purchase_order_lines")
          .select("product_id, qty_packs, pack_qty, qty_received_base, purchase_orders!inner(facility_id, status, delivery_warehouse_id)")
          .eq("purchase_orders.facility_id", ctx.facility.id)
          .in("purchase_orders.status", ["inviato", "parziale"])
      : Promise.resolve({ data: [] as never[], error: null }),
  ]);
  if (onHand.error) throw new Error(onHand.error.message);
  const whMap = new Map(warehouses.map((w) => [w.id, w]));
  const pMap = new Map(products.map((p) => [p.id, p]));
  const key = (w: string, p: string) => `${w}:${p}`;

  const incomingByProduct = new Map<string, number>();
  for (const l of (incoming.data ?? []) as { product_id: string; qty_packs: number; pack_qty: number; qty_received_base: number }[]) {
    const open = Number(l.qty_packs) * Number(l.pack_qty) - Number(l.qty_received_base);
    if (open > 0) incomingByProduct.set(l.product_id, (incomingByProduct.get(l.product_id) ?? 0) + open);
  }

  const lines = new Map<string, StockLine>();
  const ensure = (w: string, p: string) => {
    const wh = whMap.get(w);
    const pr = pMap.get(p);
    if (!wh || !pr) return null;
    let l = lines.get(key(w, p));
    if (!l) {
      l = { warehouse: wh, product: pr, qty: 0, minQty: 0, parQty: 0, incoming: 0, belowMin: false, suggestedBase: 0 };
      lines.set(key(w, p), l);
    }
    return l;
  };
  for (const r of onHand.data ?? []) {
    const l = ensure(r.warehouse_id, r.product_id);
    if (l) l.qty = Number(r.qty);
  }
  for (const s of settings.data ?? []) {
    const l = ensure(s.warehouse_id, s.product_id);
    if (l) {
      l.minQty = Number(s.min_qty);
      l.parQty = Number(s.par_qty);
    }
  }
  for (const l of lines.values()) {
    // L'arrivo è attribuito per prodotto: con più magazzini per lo stesso prodotto è un'approssimazione prudente.
    l.incoming = incomingByProduct.get(l.product.id) ?? 0;
    const s = reorderSuggestion({ onHand: l.qty, minQty: l.minQty, parQty: l.parQty, incoming: l.incoming });
    l.belowMin = s.needed;
    l.suggestedBase = s.qtyBase;
  }
  return [...lines.values()].sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || a.product.name.localeCompare(b.product.name, "it"));
}

export async function getSuppliers(orgId: string): Promise<Supplier[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, email, phone, contact_name, order_channel, delivery_weekdays, cutoff_time, lead_days, min_order_amount, notes, active")
    .eq("org_id", orgId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Supplier[];
}

export function supplierWindow(s: Supplier, tz: string, now = new Date()): OrderWindow | null {
  return nextOrderWindow({ deliveryWeekdays: s.delivery_weekdays, cutoffTime: s.cutoff_time, leadDays: s.lead_days }, tz, now);
}

export interface SupplierOffer {
  id: string;
  supplier_id: string;
  product_id: string;
  pack_label: string;
  pack_qty: number;
  price: number;
  preferred: boolean;
}

export async function getOffers(orgId: string): Promise<SupplierOffer[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("supplier_products").select("id, supplier_id, product_id, pack_label, pack_qty, price, preferred").eq("org_id", orgId);
  return (data ?? []).map((o) => ({ ...o, pack_qty: Number(o.pack_qty), price: Number(o.price) }));
}

/** Per ogni prodotto: l'offerta che il sistema userebbe (preferita, altrimenti più economica per unità base). */
export function bestOfferByProduct(offers: SupplierOffer[], activeSupplierIds: Set<string>) {
  const best = new Map<string, SupplierOffer>();
  for (const o of offers) {
    if (!activeSupplierIds.has(o.supplier_id)) continue;
    const cur = best.get(o.product_id);
    const better =
      !cur || (o.preferred && !cur.preferred) || (o.preferred === cur.preferred && o.price / o.pack_qty < cur.price / cur.pack_qty);
    if (better) best.set(o.product_id, o);
  }
  return best;
}

export const today = (ctx: AppContext) => todayIn(ctx.facility.timezone);
