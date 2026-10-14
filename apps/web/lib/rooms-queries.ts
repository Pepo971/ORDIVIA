import "server-only";
import { todayIn, type HkStatus, type RoomStatus, type StayStatus } from "@ordivia/domain";
import { createClient } from "./supabase/server";
import type { AppContext } from "./context";

export const ROOM_KINDS = ["camera", "piazzola"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function roomsDate(ctx: AppContext, raw?: string): string {
  return raw && ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : todayIn(ctx.facility.timezone);
}

export interface RoomUnit {
  id: string; // service_point_id
  kind: "camera" | "piazzola";
  label: string;
  active: boolean;
  floor: string | null;
  room_type: string | null;
  capacity: number | null;
  notes: string | null;
  status: RoomStatus;
  status_note: string | null;
  hk_status: HkStatus;
  hk_assignee: string | null;
  hk_assigned_on: string | null;
  hk_task_id: string | null;
  last_cleaned_at: string | null;
}

export interface RoomStay {
  id: string;
  service_point_id: string;
  customer_id: string | null;
  guest_name: string;
  adults: number;
  children: number;
  arrival_date: string;
  departure_date: string;
  eta: string | null;
  status: StayStatus;
  notes: string | null;
  external_ref: string | null;
  source: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  cancel_reason: string | null;
}

export const STAY_COLUMNS =
  "id, service_point_id, customer_id, guest_name, adults, children, arrival_date, departure_date, eta, status, notes, external_ref, source, checked_in_at, checked_out_at, cancel_reason";

export function roomName(r: { kind: string; label: string }) {
  return `${r.kind === "piazzola" ? "Piazzola" : "Camera"} ${r.label}`;
}

/** Camere e piazzole della struttura con il loro stato (default se l'unità è stata creata da un altro modulo). */
export async function getRooms(facilityId: string, includeInactive = false): Promise<RoomUnit[]> {
  const supabase = await createClient();
  let q = supabase.from("service_points").select("id, kind, label, zone, seats, active").eq("facility_id", facilityId).in("kind", [...ROOM_KINDS]);
  if (!includeInactive) q = q.eq("active", true);
  const [{ data: points, error }, { data: units, error: e2 }] = await Promise.all([
    q,
    supabase
      .from("room_units")
      .select("service_point_id, floor, room_type, capacity, notes, status, status_note, hk_status, hk_assignee, hk_assigned_on, hk_task_id, last_cleaned_at")
      .eq("facility_id", facilityId),
  ]);
  if (error) throw new Error(error.message);
  if (e2) throw new Error(e2.message);
  const byId = new Map((units ?? []).map((u) => [u.service_point_id as string, u]));
  return (points ?? []).map((p) => {
    const u = byId.get(p.id as string);
    return {
      id: p.id as string,
      kind: p.kind as "camera" | "piazzola",
      label: p.label as string,
      active: p.active as boolean,
      floor: (u?.floor as string | null) ?? (p.zone as string | null) ?? null,
      room_type: (u?.room_type as string | null) ?? null,
      capacity: (u?.capacity as number | null) ?? (p.seats as number | null) ?? null,
      notes: (u?.notes as string | null) ?? null,
      status: ((u?.status as RoomStatus) ?? "libera_pulita") as RoomStatus,
      status_note: (u?.status_note as string | null) ?? null,
      hk_status: ((u?.hk_status as HkStatus) ?? "ispezionata") as HkStatus,
      hk_assignee: (u?.hk_assignee as string | null) ?? null,
      hk_assigned_on: (u?.hk_assigned_on as string | null) ?? null,
      hk_task_id: (u?.hk_task_id as string | null) ?? null,
      last_cleaned_at: (u?.last_cleaned_at as string | null) ?? null,
    };
  });
}

/** Soggiorni che toccano la data: in casa, previsti (anche in ritardo) e partiti quel giorno. */
export async function getStaysAround(facilityId: string, date: string): Promise<RoomStay[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("room_stays")
    .select(STAY_COLUMNS)
    .eq("facility_id", facilityId)
    .in("status", ["prevista", "in_casa", "partita"])
    .lte("arrival_date", date)
    .gte("departure_date", date)
    .order("arrival_date");
  if (error) throw new Error(error.message);
  return (data ?? []) as RoomStay[];
}

export async function getRoomSettings(facilityId: string): Promise<{ checkin_time: string; checkout_time: string }> {
  const supabase = await createClient();
  const { data } = await supabase.from("room_settings").select("checkin_time, checkout_time").eq("facility_id", facilityId).maybeSingle();
  return {
    checkin_time: ((data?.checkin_time as string | undefined) ?? "14:00").slice(0, 5),
    checkout_time: ((data?.checkout_time as string | undefined) ?? "10:00").slice(0, 5),
  };
}

export interface Person {
  id: string;
  name: string;
}

/**
 * Colleghi della struttura che hanno uno dei permessi indicati (per assegnare camere o interventi).
 * Solo per mostrare le scelte: il database ricontrolla la persona scelta.
 */
export async function getPeopleWith(ctx: AppContext, perms: string[]): Promise<Person[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("user_id, all_facilities, facility_ids, roles(key, permissions)")
    .eq("org_id", ctx.org.id)
    .eq("active", true);
  const ids = (data ?? [])
    .filter((m) => {
      const role = m.roles as unknown as { key: string; permissions: string[] } | null;
      if (!role) return false;
      const owner = role.key === "owner";
      const facOk = owner || m.all_facilities || (m.facility_ids as string[]).includes(ctx.facility.id);
      return facOk && (owner || perms.some((p) => role.permissions.includes(p)));
    })
    .map((m) => m.user_id as string);
  return (await getNames(ids)).sort((a, b) => a.name.localeCompare(b.name, "it"));
}

export async function getNames(ids: (string | null | undefined)[]): Promise<Person[]> {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  if (unique.length === 0) return [];
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", unique);
  const found = new Map((data ?? []).map((p) => [p.id as string, (p.full_name as string | null) || (p.email as string | null) || "Collega"]));
  return unique.map((id) => ({ id, name: found.get(id) ?? "Collega" }));
}

export function nameMap(people: Person[]): Map<string, string> {
  return new Map(people.map((p) => [p.id, p.name]));
}
