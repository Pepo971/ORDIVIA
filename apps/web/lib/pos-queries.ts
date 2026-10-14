import "server-only";
import { createClient } from "./supabase/server";

// Letture del modulo Sala/Cassa/KDS. Tutte passano da RLS: chi non ha i permessi riceve elenchi vuoti.

export interface ServicePoint {
  id: string;
  kind: string;
  label: string;
  zone: string | null;
  seats: number | null;
  active: boolean;
}

export interface PosOrder {
  id: string;
  service_point_id: string | null;
  destination_kind: string;
  destination_label: string;
  number: number;
  covers: number;
  status: string;
  note: string | null;
  subtotal: number;
  discount_kind: string | null;
  discount_value: number | null;
  discount_amount: number;
  discount_reason: string | null;
  total: number;
  paid: number;
  opened_at: string;
  closed_at: string | null;
  source: string;
  customer_id: string | null;
}

export interface PosLine {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  prep_station_id: string | null;
  name: string;
  unit_price: number;
  vat_rate: number;
  qty: number;
  course: number;
  notes: string | null;
  without: string[];
  allergy: boolean;
  allergy_note: string | null;
  status: string;
  sent_at: string;
  started_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  void_reason: string | null;
  paid_payment_id: string | null;
  source: string;
  portal_submission_id: string | null;
}

export interface MenuItemLite {
  id: string;
  category_id: string | null;
  prep_station_id: string | null;
  name: string;
  price: number;
  vat_rate: number;
  allergens: string[];
  course: number;
  available: boolean;
  portions_left: number | null;
  sort: number;
}

export interface PrepStation {
  id: string;
  name: string;
  kind: string;
}

export const ORDER_COLS =
  "id, service_point_id, destination_kind, destination_label, number, covers, status, note, subtotal, discount_kind, discount_value, discount_amount, discount_reason, total, paid, opened_at, closed_at, source, customer_id";
export const LINE_COLS =
  "id, order_id, menu_item_id, prep_station_id, name, unit_price, vat_rate, qty, course, notes, without, allergy, allergy_note, status, sent_at, started_at, ready_at, served_at, void_reason, paid_payment_id, source, portal_submission_id";

const n = (v: unknown) => Number(v ?? 0);

function normOrder(o: Record<string, unknown>): PosOrder {
  return {
    ...(o as unknown as PosOrder),
    subtotal: n(o.subtotal),
    discount_amount: n(o.discount_amount),
    discount_value: o.discount_value == null ? null : n(o.discount_value),
    total: n(o.total),
    paid: n(o.paid),
  };
}
function normLine(l: Record<string, unknown>): PosLine {
  return { ...(l as unknown as PosLine), unit_price: n(l.unit_price), vat_rate: n(l.vat_rate), without: (l.without as string[] | null) ?? [] };
}

export async function getServicePoints(facilityId: string, includeInactive = false): Promise<ServicePoint[]> {
  const supabase = await createClient();
  let q = supabase.from("service_points").select("id, kind, label, zone, seats, active").eq("facility_id", facilityId);
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ServicePoint[];
}

export async function getOpenOrders(facilityId: string): Promise<PosOrder[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("pos_orders").select(ORDER_COLS).eq("facility_id", facilityId).eq("status", "aperta").order("opened_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map(normOrder);
}

export async function getOrder(id: string): Promise<PosOrder | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("pos_orders").select(ORDER_COLS).eq("id", id).maybeSingle();
  return data ? normOrder(data) : null;
}

export async function getOrdersByIds(ids: string[]): Promise<PosOrder[]> {
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.from("pos_orders").select(ORDER_COLS).in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []).map(normOrder);
}

export async function getOrderLines(orderIds: string[]): Promise<PosLine[]> {
  if (orderIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.from("pos_order_lines").select(LINE_COLS).in("order_id", orderIds).order("sent_at").order("course");
  if (error) throw new Error(error.message);
  return (data ?? []).map(normLine);
}

/** Righe ancora in lavorazione o pronte della struttura (KDS e pass). */
export async function getActiveLines(facilityId: string): Promise<PosLine[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pos_order_lines")
    .select(LINE_COLS)
    .eq("facility_id", facilityId)
    .in("status", ["inviata", "in_preparazione", "pronta"])
    .order("sent_at")
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map(normLine);
}

export async function getMenu(facilityId: string) {
  const supabase = await createClient();
  const [cats, items] = await Promise.all([
    supabase.from("menu_categories").select("id, name, sort").eq("facility_id", facilityId).order("sort").order("name"),
    supabase
      .from("menu_items")
      .select("id, category_id, prep_station_id, name, price, vat_rate, allergens, course, available, portions_left, sort")
      .eq("facility_id", facilityId)
      .eq("active", true)
      .order("sort")
      .order("name"),
  ]);
  if (items.error) throw new Error(items.error.message);
  return {
    categories: (cats.data ?? []) as { id: string; name: string; sort: number }[],
    items: (items.data ?? []).map((i) => ({ ...i, price: n(i.price), vat_rate: n(i.vat_rate), allergens: i.allergens ?? [] })) as MenuItemLite[],
  };
}

export async function getPrepStations(facilityId: string): Promise<PrepStation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("prep_stations").select("id, name, kind").eq("facility_id", facilityId).eq("active", true).order("sort").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as PrepStation[];
}

export async function getOpenCashSession(facilityId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pos_cash_sessions")
    .select("id, opening_float, opened_at, opened_by")
    .eq("facility_id", facilityId)
    .eq("status", "aperta")
    .maybeSingle();
  return data ? { ...data, opening_float: n(data.opening_float) } : null;
}

export const LINE_STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "teal" | "warn" | "danger" | "ok" | "night" }> = {
  da_confermare: { label: "Online · da confermare", tone: "night" },
  inviata: { label: "Inviata", tone: "warn" },
  in_preparazione: { label: "In preparazione", tone: "teal" },
  pronta: { label: "Pronta", tone: "ok" },
  servita: { label: "Servita", tone: "neutral" },
  annullata: { label: "Annullata", tone: "danger" },
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = { contanti: "Contanti", carta: "Carta", altro: "Altro" };

/** Righe confermate: quelle che contano nel conto, in produzione e nei pagamenti. */
export const isConfirmed = (l: Pick<PosLine, "status">) => l.status !== "annullata" && l.status !== "da_confermare";

/** Righe online in attesa di conferma, per comanda (sala e cassa). */
export async function getPendingCounts(facilityId: string): Promise<Map<string, number>> {
  const supabase = await createClient();
  const { data } = await supabase.from("pos_order_lines").select("order_id, qty").eq("facility_id", facilityId).eq("status", "da_confermare").limit(1000);
  const m = new Map<string, number>();
  for (const l of data ?? []) m.set(l.order_id, (m.get(l.order_id) ?? 0) + 1);
  return m;
}

export interface PortalSubmission {
  id: string;
  order_id: string;
  guest_name: string | null;
  notes: string | null;
  allergies: string | null;
  lang: string;
  total: number;
  status: string;
  reject_reason: string | null;
  created_at: string;
}

export async function getSubmissions(orderId: string): Promise<PortalSubmission[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("portal_submissions")
    .select("id, order_id, guest_name, notes, allergies, lang, total, status, reject_reason, created_at")
    .eq("order_id", orderId)
    .order("created_at");
  return (data ?? []).map((x) => ({ ...x, total: n(x.total) })) as PortalSubmission[];
}
