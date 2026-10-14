import "server-only";
import {
  pointStates,
  todayIn,
  type BeachPeriod,
  type BeachRate,
  type BeachBookingStatus,
  type DayBooking,
  type MapPoint,
  type PointDay,
} from "@ordivia/domain";
import { createClient } from "./supabase/server";
import type { AppContext } from "./context";

export const BEACH_POINT_KINDS = ["ombrellone", "lettino", "cabina", "gazebo"] as const;

export interface BeachPoint extends MapPoint {
  seats: number | null;
}

export interface BeachBooking {
  id: string;
  service_point_id: string;
  period: BeachPeriod;
  start_date: string;
  end_date: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  notes: string | null;
  lettini: number;
  list_price: number | null;
  price: number;
  price_override_reason: string | null;
  paid_amount: number;
  status: BeachBookingStatus;
  last_checkin_on: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

export const BOOKING_COLUMNS =
  "id, service_point_id, period, start_date, end_date, customer_name, customer_phone, customer_email, notes, lettini, list_price, price, price_override_reason, paid_amount, status, last_checkin_on, checked_in_at, checked_out_at, cancel_reason, created_at";

export const BOOKING_STATUS: Record<BeachBookingStatus, { label: string; tone: "neutral" | "teal" | "warn" | "danger" | "ok" | "night" }> = {
  prenotata: { label: "Prenotata", tone: "teal" },
  presente: { label: "Presente", tone: "ok" },
  uscito: { label: "Uscito", tone: "neutral" },
  annullata: { label: "Annullata", tone: "danger" },
  no_show: { label: "Non presentato", tone: "warn" },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Data scelta dalla query string (YYYY-MM-DD) o oggi nel fuso della struttura. */
export function beachDate(ctx: AppContext, raw?: string): string {
  return raw && ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : todayIn(ctx.facility.timezone);
}

export async function getBeachPoints(facilityId: string, includeInactive = false): Promise<BeachPoint[]> {
  const supabase = await createClient();
  let q = supabase
    .from("service_points")
    .select("id, kind, label, zone, row_label, pos_x, pos_y, seats, active")
    .eq("facility_id", facilityId)
    .in("kind", [...BEACH_POINT_KINDS]);
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q.order("zone").order("pos_y").order("pos_x");
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({ ...p, pos_x: p.pos_x == null ? null : Number(p.pos_x), pos_y: p.pos_y == null ? null : Number(p.pos_y) }));
}

export async function getOutOfService(facilityId: string): Promise<Map<string, string | null>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("beach_point_flags").select("service_point_id, note").eq("facility_id", facilityId).eq("out_of_service", true);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((f) => [f.service_point_id as string, f.note as string | null]));
}

export async function getRates(facilityId: string): Promise<(BeachRate & { name: string | null })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("beach_rates")
    .select("id, name, kind, zone, row_label, period, valid_from, valid_to, price, included_lettini, extra_lettino_price, active, created_at")
    .eq("facility_id", facilityId)
    .order("kind")
    .order("period")
    .order("valid_from");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, price: Number(r.price), extra_lettino_price: Number(r.extra_lettino_price) })) as (BeachRate & { name: string | null })[];
}

/** Prenotazioni (attive e non) che comprendono la data. */
export async function getBookingsOn(facilityId: string, date: string): Promise<BeachBooking[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("beach_bookings")
    .select(BOOKING_COLUMNS)
    .eq("facility_id", facilityId)
    .lte("start_date", date)
    .gte("end_date", date)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map(normBooking);
}

export function normBooking(b: Record<string, unknown>): BeachBooking {
  return {
    ...(b as unknown as BeachBooking),
    price: Number(b.price),
    paid_amount: Number(b.paid_amount),
    list_price: b.list_price == null ? null : Number(b.list_price),
  };
}

export interface BeachDay {
  date: string;
  points: BeachPoint[];
  bookings: BeachBooking[];
  states: Map<string, PointDay>;
  outOfService: Map<string, string | null>;
}

export async function getBeachDay(ctx: AppContext, date: string): Promise<BeachDay> {
  const [points, bookings, outOfService] = await Promise.all([
    getBeachPoints(ctx.facility.id),
    getBookingsOn(ctx.facility.id, date),
    getOutOfService(ctx.facility.id),
  ]);
  const today = todayIn(ctx.facility.timezone);
  // Il fuori servizio è uno stato di oggi: per altre date la mappa mostra solo le prenotazioni.
  const oos = date === today ? new Set(outOfService.keys()) : new Set<string>();
  const dayBookings: DayBooking[] = bookings.map((b) => ({
    ...b,
    presentOnDay: b.status === "presente" && b.last_checkin_on === date,
  }));
  return { date, points, bookings, states: pointStates(points, dayBookings, oos, date), outOfService };
}

export function pointName(p: { kind: string; label: string }) {
  const k = p.kind.charAt(0).toUpperCase() + p.kind.slice(1);
  return `${k} ${p.label}`;
}
