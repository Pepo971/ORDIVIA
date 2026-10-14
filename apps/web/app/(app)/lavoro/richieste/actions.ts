"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addDays, zonedTimeToUtc } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const civil = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida");
const optText = (max: number) => z.string().trim().max(max, `Massimo ${max} caratteri`).optional().transform((v) => v || null);

function done() {
  revalidatePath("/lavoro/richieste");
  revalidatePath("/lavoro/turni");
  revalidatePath("/oggi");
}

function instant(date: string, time: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  return zonedTimeToUtc(y, m, d, hh, mm, tz);
}

// ---------------------------------------------------------------------------
// Ferie, permessi, malattia
// ---------------------------------------------------------------------------
export async function requestLeave(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      kind: z.enum(["ferie", "permesso", "malattia", "altro"], { message: "Scegli il tipo" }),
      from_date: civil,
      to_date: civil,
      all_day: z.literal("on").optional(),
      from_time: z.union([z.literal(""), z.string().regex(/^\d{2}:\d{2}$/)]).optional(),
      to_time: z.union([z.literal(""), z.string().regex(/^\d{2}:\d{2}$/)]).optional(),
      note: optText(1000),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const tz = ctx.facility.timezone;
  if (d.to_date < d.from_date) return { error: "La data di fine è prima dell'inizio" };
  const allDay = !!d.all_day || !d.from_time || !d.to_time;
  const starts = allDay ? instant(d.from_date, "00:00", tz) : instant(d.from_date, d.from_time!, tz);
  const ends = allDay ? instant(addDays(d.to_date, 1), "00:00", tz) : instant(d.to_date, d.to_time!, tz);
  if (ends <= starts) return { error: "La fine deve essere dopo l'inizio" };

  const supabase = await createClient();
  const { error } = await supabase.rpc("request_leave", {
    p_facility: ctx.facility.id,
    p_kind: d.kind,
    p_starts: starts.toISOString(),
    p_ends: ends.toISOString(),
    p_all_day: allDay,
    p_note: d.note,
  });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: d.kind === "malattia" ? "Comunicazione inviata al responsabile." : "Richiesta inviata: ti avvisiamo qui quando viene decisa." };
}

export async function decideLeave(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const approve = data.get("decision") === "approva";
  const note = ((data.get("note") as string) || "").trim().slice(0, 1000) || null;
  if (!id.success) return { error: "Richiesta non valida" };
  if (!approve && !note) return { error: "Scrivi il motivo del rifiuto" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_leave", { p_request: id.data, p_approve: approve, p_note: note });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: approve ? "Approvata." : "Rifiutata." };
}

export async function cancelLeave(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Richiesta non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_leave", { p_request: id.data });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Richiesta annullata." };
}

// ---------------------------------------------------------------------------
// Cambi turno
// ---------------------------------------------------------------------------
export async function offerSwap(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      shift_id: z.string().uuid("Scegli il turno"),
      to_user: z.union([uuid, z.literal("")]).transform((v) => v || null),
      note: optText(500),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("offer_shift_swap", { p_shift: parsed.data.shift_id, p_to_user: parsed.data.to_user, p_note: parsed.data.note });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: parsed.data.to_user ? "Proposta inviata al collega." : "Turno offerto ai colleghi del reparto." };
}

export async function acceptSwap(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Proposta non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_shift_swap", { p_swap: id.data });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Accettato: ora serve l'approvazione del responsabile." };
}

export async function decideSwap(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Proposta non valida" };
  const approve = data.get("decision") === "approva";
  const note = ((data.get("note") as string) || "").trim().slice(0, 500) || null;
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_shift_swap", { p_swap: id.data, p_approve: approve, p_note: note });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: approve ? "Cambio approvato: turno riassegnato." : "Cambio rifiutato." };
}

export async function cancelSwap(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Proposta non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_shift_swap", { p_swap: id.data });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: "Proposta ritirata." };
}
