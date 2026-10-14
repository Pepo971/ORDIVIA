import "server-only";
import { todayIn, type ReservationSource, type ReservationStatus, type ServiceKind } from "@ordivia/domain";
import { createClient } from "./supabase/server";
import type { AppContext } from "./context";

export type Tone = "neutral" | "teal" | "warn" | "danger" | "ok" | "night";

export const RES_STATUS_TONE: Record<ReservationStatus, Tone> = {
  in_attesa_conferma: "warn",
  confermata: "teal",
  arrivata: "ok",
  completata: "neutral",
  no_show: "danger",
  annullata: "danger",
};

export interface ResService {
  id: string;
  name: string;
  kind: ServiceKind;
  description: string | null;
  capacity_unit: "coperti" | "posti";
  duration_min: number;
  max_party_size: number;
  deposit_amount: number | null;
  price_per_person: number | null;
  cancellation_policy: string | null;
  booking_notice_min: number;
  public_bookable: boolean;
  event_date: string | null;
  event_time: string | null;
  event_capacity: number | null;
  active: boolean;
  sort_order: number;
}

export const SERVICE_COLUMNS =
  "id, name, kind, description, capacity_unit, duration_min, max_party_size, deposit_amount, price_per_person, cancellation_policy, booking_notice_min, public_bookable, event_date, event_time, event_capacity, active, sort_order";

export interface ResCustomer {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  allergies: string[];
  tags: string[];
  anonymized_at: string | null;
}

export interface Reservation {
  id: string;
  service_id: string;
  res_date: string;
  res_time: string; // HH:MM
  starts_at: string;
  ends_at: string;
  party_size: number;
  customer_id: string | null;
  guest_name: string | null;
  service_point_id: string | null;
  source: ReservationSource;
  status: ReservationStatus;
  notes: string | null;
  special_requests: string | null;
  allergies: string[];
  deposit_required: number;
  deposit_paid_at: string | null;
  confirmed_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  no_show_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  reminded_at: string | null;
  created_at: string;
  customer: ResCustomer | null;
}

export const RES_COLUMNS =
  "id, service_id, res_date, res_time, starts_at, ends_at, party_size, customer_id, guest_name, service_point_id, source, status, notes, special_requests, allergies, deposit_required, deposit_paid_at, confirmed_at, arrived_at, completed_at, no_show_at, cancelled_at, cancel_reason, reminded_at, created_at, customer:customers(id, full_name, phone, email, allergies, tags, anonymized_at)";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normReservation(r: any): Reservation {
  const c = Array.isArray(r.customer) ? r.customer[0] : r.customer;
  return {
    ...r,
    res_time: String(r.res_time).slice(0, 5),
    party_size: Number(r.party_size),
    deposit_required: Number(r.deposit_required ?? 0),
    allergies: r.allergies ?? [],
    customer: c ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normService(s: any): ResService {
  return {
    ...s,
    deposit_amount: s.deposit_amount == null ? null : Number(s.deposit_amount),
    price_per_person: s.price_per_person == null ? null : Number(s.price_per_person),
    event_time: s.event_time ? String(s.event_time).slice(0, 5) : null,
  };
}

export function guestLabel(r: Pick<Reservation, "customer" | "guest_name">): string {
  return r.customer?.full_name ?? r.guest_name ?? "Ospite";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function resDate(ctx: AppContext, raw?: string): string {
  return raw && ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : todayIn(ctx.facility.timezone);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getServices(facilityId: string, includeInactive = false): Promise<ResService[]> {
  const supabase = await createClient();
  let q = supabase.from("reservation_services").select(SERVICE_COLUMNS).eq("facility_id", facilityId);
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q.order("sort_order").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map(normService);
}

export interface SlotRow {
  slot_time: string;
  starts_at: string;
  capacity: number;
  booked: number;
  available: number;
  max_party: number;
}

export async function getSlots(serviceId: string, date: string): Promise<SlotRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("res_slots", { p_service: serviceId, p_date: date });
  if (error) throw new Error(error.message);
  return (data ?? []) as SlotRow[];
}

export interface TableRow {
  id: string;
  label: string;
  zone: string | null;
  seats: number | null;
}

export async function getTables(facilityId: string): Promise<TableRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("service_points")
    .select("id, label, zone, seats")
    .eq("facility_id", facilityId)
    .eq("kind", "tavolo")
    .eq("active", true)
    .order("zone")
    .order("label");
  if (error) throw new Error(error.message);
  return (data ?? []) as TableRow[];
}

export async function getReservations(facilityId: string, from: string, to: string): Promise<Reservation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reservations")
    .select(RES_COLUMNS)
    .eq("facility_id", facilityId)
    .gte("res_date", from)
    .lte("res_date", to)
    .order("res_date")
    .order("res_time")
    .limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []).map(normReservation);
}

export interface WaitlistEntry {
  id: string;
  service_id: string;
  wait_date: string;
  preferred_time: string | null;
  party_size: number;
  notes: string | null;
  notify: boolean;
  status: "in_attesa" | "avvisato" | "promossa" | "annullata";
  notified_at: string | null;
  created_at: string;
  customer: ResCustomer | null;
}

export async function getWaitlist(facilityId: string, date: string): Promise<WaitlistEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reservation_waitlist")
    .select("id, service_id, wait_date, preferred_time, party_size, notes, notify, status, notified_at, created_at, customer:customers(id, full_name, phone, email, allergies, tags, anonymized_at)")
    .eq("facility_id", facilityId)
    .eq("wait_date", date)
    .in("status", ["in_attesa", "avvisato"])
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((w) => {
    const c = Array.isArray(w.customer) ? w.customer[0] : w.customer;
    return { ...w, preferred_time: w.preferred_time ? String(w.preferred_time).slice(0, 5) : null, customer: (c ?? null) as ResCustomer | null } as WaitlistEntry;
  });
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------
export interface CustomerListRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  allergies: string[];
  marketing_consent: boolean;
  visits: number;
  last_visit: string | null;
  no_shows: number;
  spend: number | null;
  anonymized: boolean;
  created_at: string;
}

export interface Customer {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  language: string;
  birthday: string | null;
  allergies: string[];
  preferences: string | null;
  notes: string | null;
  tags: string[];
  privacy_consent_at: string | null;
  marketing_consent: boolean;
  marketing_consent_at: string | null;
  consent_source: string | null;
  anonymized_at: string | null;
  created_at: string;
}

export const CUSTOMER_COLUMNS =
  "id, full_name, email, phone, language, birthday, allergies, preferences, notes, tags, privacy_consent_at, marketing_consent, marketing_consent_at, consent_source, anonymized_at, created_at";

export interface CustomerCard {
  beach: { id: string; start_date: string; end_date: string; period: string; status: string; point: string; facility: string; price: number | null; paid: number | null }[];
  orders: { id: string; date: string; total: number; destination: string; facility: string }[] | null;
  spend: { orders: number; beach: number } | null;
  consents: { kind: "privacy" | "marketing"; granted: boolean; source: string | null; at: string }[];
}

export const LANGUAGES: Record<string, string> = { it: "Italiano", en: "Inglese", de: "Tedesco", fr: "Francese", es: "Spagnolo", nl: "Olandese" };
