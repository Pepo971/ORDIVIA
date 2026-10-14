"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { addDays, shiftInstants, weekStartOf } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const civil = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida");
const time = z.string().regex(/^\d{2}:\d{2}$/, "Orario non valido");
const optUuid = z.union([uuid, z.literal("")]).optional().transform((v) => v || null);
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

function done(path = "/lavoro/turni") {
  revalidatePath(path);
  revalidatePath("/oggi");
}

// ---------------------------------------------------------------------------
// Turni (shifts.manage — verificato da RLS e trigger)
// ---------------------------------------------------------------------------
const shiftSchema = z.object({
  id: optUuid,
  user_id: z.string().uuid("Scegli la persona"),
  date: civil,
  start: time,
  end: time,
  break_minutes: z.coerce.number().int("Pausa non valida").min(0, "Pausa non valida").max(240, "Pausa massima 4 ore"),
  department_id: optUuid,
  role_label: optText(80),
  note: optText(500),
});

export async function saveShift(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = shiftSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (d.start === d.end) return { error: "Inizio e fine coincidono" };
  const { startsAt, endsAt } = shiftInstants(d.date, d.start, d.end, ctx.facility.timezone);
  if ((endsAt.getTime() - startsAt.getTime()) / 60000 <= d.break_minutes) return { error: "La pausa è più lunga del turno" };

  const row = {
    user_id: d.user_id,
    department_id: d.department_id,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    break_minutes: d.break_minutes,
    role_label: d.role_label,
    note: d.note,
  };
  const supabase = await createClient();
  const { error } = d.id
    ? await supabase.from("shifts").update(row).eq("id", d.id).eq("facility_id", ctx.facility.id)
    : await supabase.from("shifts").insert({ ...row, org_id: ctx.org.id, facility_id: ctx.facility.id });
  if (error) return { error: humanError(error) };
  done();
  redirect(`/lavoro/turni?settimana=${weekStartOf(d.date)}&salvato=1`);
}

export async function removeShift(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const week = civil.safeParse(data.get("week"));
  if (!id.success) return { error: "Turno non valido" };
  const supabase = await createClient();
  const { data: res, error } = await supabase.rpc("remove_shift", { p_shift: id.data });
  if (error) return { error: humanError(error) };
  done();
  redirect(`/lavoro/turni?settimana=${week.success ? week.data : ""}&rimosso=${res === "annullato" ? "annullato" : "eliminato"}`);
}

export async function publishWeek(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const week = civil.safeParse(data.get("week"));
  if (!week.success) return { error: "Settimana non valida" };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("publish_shift_week", { p_facility: ctx.facility.id, p_week_start: week.data });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: n ? `Pubblicati ${n} turni: ora il team li vede.` : "Nessuna bozza da pubblicare." };
}

export async function copyPreviousWeek(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const week = civil.safeParse(data.get("week"));
  if (!week.success) return { error: "Settimana non valida" };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("copy_shift_week", { p_facility: ctx.facility.id, p_from: addDays(week.data, -7), p_to: week.data });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: n ? `Copiati ${n} turni come bozza.` : "Niente da copiare: la settimana precedente è vuota o già copiata." };
}

export async function saveShiftSettings(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      max_week_hours: z.coerce.number({ message: "Ore non valide" }).min(1, "Ore non valide").max(120, "Massimo 120 ore"),
      min_rest_hours: z.coerce.number({ message: "Ore non valide" }).min(0, "Ore non valide").max(24, "Massimo 24 ore"),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase
    .from("shift_settings")
    .upsert({ facility_id: ctx.facility.id, org_id: ctx.org.id, ...parsed.data, updated_at: new Date().toISOString() });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Soglie aggiornate." };
}

export async function setHourlyCost(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      user_id: z.string().uuid("Scegli la persona"),
      hourly_cost: z.union([z.literal(""), z.coerce.number({ message: "Importo non valido" }).min(0, "Importo non valido").max(999, "Importo non valido")]),
    })
    .safeParse({ user_id: data.get("user_id"), hourly_cost: String(data.get("hourly_cost") ?? "").replace(",", ".") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } =
    parsed.data.hourly_cost === ""
      ? await supabase.from("member_hourly_costs").delete().eq("org_id", ctx.org.id).eq("user_id", parsed.data.user_id)
      : await supabase.from("member_hourly_costs").upsert({
          org_id: ctx.org.id,
          user_id: parsed.data.user_id,
          hourly_cost: parsed.data.hourly_cost,
          updated_at: new Date().toISOString(),
        });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Costo orario salvato." };
}

// ---------------------------------------------------------------------------
// Disponibilità (della persona stessa)
// ---------------------------------------------------------------------------
export async function addUnavailability(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      mode: z.enum(["ricorrente", "data"]),
      weekday: z.union([z.literal(""), z.coerce.number().int().min(1).max(7)]).optional(),
      on_date: z.union([z.literal(""), civil]).optional(),
      from_time: z.union([z.literal(""), time]).optional(),
      to_time: z.union([z.literal(""), time]).optional(),
      note: optText(200),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const weekday = d.mode === "ricorrente" ? d.weekday || null : null;
  const onDate = d.mode === "data" ? d.on_date || null : null;
  if (d.mode === "ricorrente" && !weekday) return { error: "Scegli il giorno della settimana" };
  if (d.mode === "data" && !onDate) return { error: "Scegli la data" };
  const from = d.from_time || null;
  const to = d.to_time || null;
  if ((from && !to) || (!from && to)) return { error: "Indica sia l'inizio sia la fine, oppure lascia vuoto per tutto il giorno" };
  if (from && to && to <= from) return { error: "La fine deve essere dopo l'inizio" };
  const supabase = await createClient();
  const { error } = await supabase.from("shift_unavailability").insert({
    org_id: ctx.org.id,
    user_id: ctx.userId,
    weekday,
    on_date: onDate,
    from_time: from,
    to_time: to,
    note: d.note,
  });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Indisponibilità salvata: chi pianifica la vedrà." };
}

export async function deleteUnavailability(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Elemento non valido" };
  const supabase = await createClient();
  const { error } = await supabase.from("shift_unavailability").delete().eq("id", id.data).eq("user_id", ctx.userId);
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Rimossa." };
}
