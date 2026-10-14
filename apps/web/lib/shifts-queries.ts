import "server-only";
import { addDays, startOfCivilDay, type ShiftLike } from "@ordivia/domain";
import type { AppContext } from "./context";
import { createClient } from "./supabase/server";

export interface Person {
  userId: string;
  name: string;
  departmentIds: string[];
}

export interface ShiftRow {
  id: string;
  user_id: string;
  department_id: string | null;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  role_label: string | null;
  note: string | null;
  status: "bozza" | "pubblicato" | "annullato";
  published_at: string | null;
  changed_at: string | null;
}

export const SHIFT_COLUMNS = "id, user_id, department_id, starts_at, ends_at, break_minutes, role_label, note, status, published_at, changed_at";

export interface AbsenceRow {
  user_id: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  /** null per i colleghi: il motivo lo vede solo chi gestisce i turni */
  kind: string | null;
}

export interface UnavailabilityRow {
  id: string;
  user_id: string;
  weekday: number | null;
  on_date: string | null;
  from_time: string | null;
  to_time: string | null;
  note: string | null;
}

export const LEAVE_KIND: Record<string, string> = {
  ferie: "Ferie",
  permesso: "Permesso",
  malattia: "Malattia",
  altro: "Altro",
};

export const LEAVE_STATUS: Record<string, { label: string; tone: "neutral" | "teal" | "warn" | "danger" | "ok" | "night" }> = {
  in_attesa: { label: "In attesa", tone: "warn" },
  approvata: { label: "Approvata", tone: "ok" },
  rifiutata: { label: "Rifiutata", tone: "danger" },
  annullata: { label: "Annullata", tone: "neutral" },
};

export const SWAP_STATUS: Record<string, { label: string; tone: "neutral" | "teal" | "warn" | "danger" | "ok" | "night" }> = {
  offerto: { label: "Offerto", tone: "teal" },
  accettato: { label: "Da approvare", tone: "warn" },
  approvato: { label: "Approvato", tone: "ok" },
  rifiutato: { label: "Rifiutato", tone: "danger" },
  annullato: { label: "Annullato", tone: "neutral" },
};

/** Persone attive con accesso alla struttura corrente (titolare incluso), con nome. */
export async function getFacilityPeople(ctx: AppContext): Promise<Person[]> {
  const supabase = await createClient();
  const { data: members } = await supabase
    .from("memberships")
    .select("user_id, all_facilities, facility_ids, department_ids, roles(key)")
    .eq("org_id", ctx.org.id)
    .eq("active", true);
  const eligible = (members ?? []).filter((m) => {
    const role = m.roles as unknown as { key: string } | null;
    return m.all_facilities || role?.key === "owner" || ((m.facility_ids as string[]) ?? []).includes(ctx.facility.id);
  });
  const ids = eligible.map((m) => m.user_id as string);
  const { data: profiles } = ids.length ? await supabase.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
  const names = new Map((profiles ?? []).map((p) => [p.id as string, (p.full_name as string | null) || (p.email as string | null) || "Collega"]));
  return eligible
    .map((m) => ({ userId: m.user_id as string, name: names.get(m.user_id as string) ?? "Collega", departmentIds: (m.department_ids as string[]) ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name, "it"));
}

export async function getShiftSettings(facilityId: string): Promise<{ maxWeekHours: number; minRestHours: number }> {
  const supabase = await createClient();
  const { data } = await supabase.from("shift_settings").select("max_week_hours, min_rest_hours").eq("facility_id", facilityId).maybeSingle();
  return { maxWeekHours: Number(data?.max_week_hours ?? 48), minRestHours: Number(data?.min_rest_hours ?? 11) };
}

/** Turni della struttura che iniziano tra le due date civili (estremi inclusi), nel fuso della struttura. */
export async function getShifts(ctx: AppContext, fromDate: string, toDateInclusive: string, opts: { userId?: string; includeCancelled?: boolean } = {}): Promise<ShiftRow[]> {
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  let q = supabase
    .from("shifts")
    .select(SHIFT_COLUMNS)
    .eq("facility_id", ctx.facility.id)
    .gte("starts_at", startOfCivilDay(fromDate, tz).toISOString())
    .lt("starts_at", startOfCivilDay(addDays(toDateInclusive, 1), tz).toISOString())
    .order("starts_at");
  if (opts.userId) q = q.eq("user_id", opts.userId);
  if (!opts.includeCancelled) q = q.neq("status", "annullato");
  const { data } = await q;
  return (data ?? []) as ShiftRow[];
}

export async function getAbsences(ctx: AppContext, fromDate: string, toDateInclusive: string): Promise<AbsenceRow[]> {
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("team_absences", {
    p_facility: ctx.facility.id,
    p_from: startOfCivilDay(fromDate, tz).toISOString(),
    p_to: startOfCivilDay(addDays(toDateInclusive, 1), tz).toISOString(),
  });
  if (error) return [];
  return (data ?? []) as AbsenceRow[];
}

export function toShiftLike(s: ShiftRow): ShiftLike {
  return {
    id: s.id,
    userId: s.user_id,
    departmentId: s.department_id,
    startsAt: new Date(s.starts_at),
    endsAt: new Date(s.ends_at),
    breakMinutes: s.break_minutes,
  };
}

/** "HH:MM:SS" → "HH:MM" */
export const hm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");

export function isCivilDate(v: string | undefined | null): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
}
